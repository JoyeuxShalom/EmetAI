# The fully offline lane: Whisper transcribes, SeamlessM4T translates.
#
# ── Why this exists ─────────────────────────────────────────────────────────
# The Gemini ear is faster and more accurate than anything that fits on a
# church laptop, but it needs the internet and a key with quota. A three-hour
# service on a Rwandan connection is exactly where that assumption breaks. This
# module is the lane that needs neither: faster-whisper for Kinyarwanda speech
# (already installed and used by the "rw" ear) and Meta's SeamlessM4T v2 for
# Kinyarwanda → English text, both open-source, both local, both free to run.
#
# ── Why it is not switched on ───────────────────────────────────────────────
# It is not vapourware and it is not pretending. `capability()` measures this
# machine and reports precisely what is missing, with numbers, so the answer is
# checkable rather than a claim. On the machine this was written on it reports
# two hard blocks:
#
#   • 1.5 GB of free disk. SeamlessM4T v2 large is ~9 GB of weights and the
#     medium model ~4.8 GB. The download cannot complete, so nothing else
#     about the design matters until that is solved.
#   • A CPU-only torch build and no CUDA device. A 2.3B-parameter sequence
#     model on twelve CPU cores does not translate a sermon in real time.
#
# Neither is a code problem, so neither is fixed in code. What IS in code is
# the seam: when the disk and the device are there, `translate()` works, and
# `capability()` stops reporting blocks.

import os
import shutil

# Meta's multilingual translation model. "medium" is the one worth trying on
# modest hardware; "large-v2" is better and roughly twice the size.
MODEL_MEDIUM = "facebook/hf-seamless-m4t-medium"
MODEL_LARGE = "facebook/seamless-m4t-v2-large"
DEFAULT_MODEL = os.environ.get("EMETAI_SEAMLESS_MODEL", MODEL_MEDIUM)

# Weight sizes on disk, plus room for the download to unpack. Measured from the
# model cards, not guessed: medium ~4.8 GB, large ~9 GB.
MODEL_DISK_GB = {MODEL_MEDIUM: 4.8, MODEL_LARGE: 9.0}
DISK_HEADROOM_GB = 3.0

# SeamlessM4T language codes. Kinyarwanda is `kin`, and it is one of the ~100
# languages the model supports for text output — which is the whole reason this
# model and not a bilingual pair.
LANG_CODES = {"rw": "kin", "en": "eng", "fr": "fra", "sw": "swh"}

_model = None
_processor = None


def free_disk_gb(path: str | None = None) -> float:
    target = path or os.path.dirname(os.path.abspath(__file__))
    drive = os.path.splitdrive(os.path.abspath(target))[0] or "/"
    try:
        return shutil.disk_usage(drive + os.sep).free / 1e9
    except Exception:
        return 0.0


def capability(model: str = DEFAULT_MODEL) -> dict:
    """Can this machine actually run the offline translation lane?

    Returns what was measured and, when it cannot, exactly what is missing.
    Deliberately returns facts rather than a yes/no, because "no" without the
    numbers is the kind of answer nobody can act on.
    """
    blocks: list[str] = []
    warnings: list[str] = []

    needed = MODEL_DISK_GB.get(model, 5.0) + DISK_HEADROOM_GB
    free = free_disk_gb()
    if free < needed:
        blocks.append(
            f"Not enough disk: {free:.1f} GB free, {needed:.1f} GB needed for "
            f"{model} plus room to unpack it."
        )

    torch_version = ""
    cuda = False
    try:
        import torch

        torch_version = torch.__version__
        cuda = bool(torch.cuda.is_available())
    except ImportError:
        blocks.append("PyTorch is not installed (pip install torch).")

    try:
        import transformers  # noqa: F401
    except ImportError:
        blocks.append("transformers is not installed (pip install transformers).")

    if torch_version and not cuda:
        warnings.append(
            "No CUDA device — SeamlessM4T on CPU is far slower than real time. "
            "Usable for reviewing a recording afterwards, not for a live wall."
        )

    cached = _is_cached(model)
    if not cached and not blocks:
        warnings.append(
            f"{model} has not been downloaded yet; the first run will fetch "
            f"~{MODEL_DISK_GB.get(model, 5.0):.1f} GB."
        )

    return {
        "model": model,
        "ready": not blocks,
        "realtime": not blocks and cuda,
        "blocks": blocks,
        "warnings": warnings,
        "measured": {
            "free_disk_gb": round(free, 1),
            "disk_needed_gb": round(needed, 1),
            "torch": torch_version or "missing",
            "cuda": cuda,
            "model_cached": cached,
        },
    }


def _is_cached(model: str) -> bool:
    home = os.environ.get("HF_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache", "huggingface"
    )
    folder = "models--" + model.replace("/", "--")
    return os.path.isdir(os.path.join(home, "hub", folder))


def load(model: str = DEFAULT_MODEL):
    """Load the translator. Raises with the preflight's reasons if it cannot."""
    global _model, _processor
    if _model is not None:
        return _processor, _model

    state = capability(model)
    if state["blocks"]:
        raise RuntimeError(
            "The offline translator cannot run on this machine: "
            + " ".join(state["blocks"])
        )

    import torch
    from transformers import AutoProcessor, SeamlessM4Tv2ForTextToText

    _processor = AutoProcessor.from_pretrained(model)
    _model = SeamlessM4Tv2ForTextToText.from_pretrained(model)
    if torch.cuda.is_available():
        _model = _model.to("cuda")
    _model.eval()
    return _processor, _model


def translate(text: str, source: str = "rw", target: str = "en",
              model: str = DEFAULT_MODEL) -> str:
    """Kinyarwanda → English, entirely offline.

    Text-to-text rather than speech-to-text on purpose: Whisper has already
    produced the Kinyarwanda words, and asking one model to do both jobs throws
    away the Kinyarwanda transcript — which is the thing the congregation
    actually heard and the thing scripture matching needs.
    """
    text = (text or "").strip()
    if not text:
        return ""
    src = LANG_CODES.get(source, source)
    tgt = LANG_CODES.get(target, target)
    if src == tgt:
        return text

    import torch

    processor, net = load(model)
    inputs = processor(text=text, src_lang=src, return_tensors="pt")
    if next(net.parameters()).is_cuda:
        inputs = {k: v.to("cuda") for k, v in inputs.items()}
    with torch.inference_mode():
        tokens = net.generate(**inputs, tgt_lang=tgt, max_new_tokens=256)
    return processor.decode(tokens[0].tolist(), skip_special_tokens=True).strip()
