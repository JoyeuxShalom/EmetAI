# Which ear hears YOUR church best?
#
# Published accuracy figures for Kinyarwanda are measured on Common Voice —
# one person, reading a prepared sentence, into a phone, in a quiet room. A
# church is a PA system, a congregation, a preacher at full voice and an
# interpreter answering. The published ranking can invert completely in that
# room, and no amount of reading papers will tell you whether it has.
#
# So measure it. Give this a recording of a real service and a transcript of
# what was actually said, and it scores every engine we can reach on the same
# audio, by word error rate — the standard measure: how many words have to be
# inserted, deleted or changed to turn what the machine heard into what was
# really said. 0% is perfect; 30% means roughly one word in three is wrong.
#
#   python scripts/bakeoff.py service.wav truth.txt
#
# truth.txt is simply what was said, in plain text. Five minutes is plenty —
# more careful minutes beat more sloppy ones, because an error in the truth
# counts against every engine equally and tells you nothing.
#
# Add engines by writing one function. Nothing here is special-cased.

import os
import re
import sys
import time
import wave

SERVER = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
)
sys.path.insert(0, SERVER)

import numpy as np  # noqa: E402


# ------------------------------------------------------------- scoring ----
def words(text: str) -> list[str]:
    """Compare meaning, not punctuation. Case, commas and apostrophes differ
    between engines for reasons that have nothing to do with hearing."""
    text = text.lower().replace("'", "'")
    text = re.sub(r"[^\w\s']", " ", text)
    return text.split()


def word_error_rate(truth: str, heard: str) -> tuple[float, int, int, int]:
    """Levenshtein over words. Returns (wer, substitutions, deletions, insertions)."""
    a, b = words(truth), words(heard)
    if not a:
        return (0.0 if not b else 1.0), 0, 0, len(b)

    # Full matrix: we want the operation counts, not just the distance, so the
    # usual two-row optimisation will not do.
    rows, cols = len(a) + 1, len(b) + 1
    dist = np.zeros((rows, cols), dtype=np.int32)
    dist[:, 0] = np.arange(rows)
    dist[0, :] = np.arange(cols)
    for i in range(1, rows):
        for j in range(1, cols):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            dist[i][j] = min(dist[i - 1][j] + 1,        # deletion
                             dist[i][j - 1] + 1,        # insertion
                             dist[i - 1][j - 1] + cost)  # substitution

    i, j = len(a), len(b)
    sub = dele = ins = 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dist[i][j] == dist[i - 1][j - 1] + (a[i - 1] != b[j - 1]):
            if a[i - 1] != b[j - 1]:
                sub += 1
            i, j = i - 1, j - 1
        elif i > 0 and dist[i][j] == dist[i - 1][j] + 1:
            dele += 1
            i -= 1
        else:
            ins += 1
            j -= 1
    return dist[len(a)][len(b)] / len(a), sub, dele, ins


# ------------------------------------------------------------- engines ----
def load_audio(path: str) -> np.ndarray:
    with wave.open(path) as w:
        if w.getnchannels() != 1:
            raise SystemExit("Please supply mono audio (one channel).")
        raw, rate = w.readframes(w.getnframes()), w.getframerate()
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if rate != 16000:
        idx = (np.arange(int(len(audio) * 16000 / rate)) * rate / 16000).astype(int)
        audio = audio[idx]
    return audio


def gemini(model: str):
    """One Gemini model, through the ear's own code path — so what is measured
    here is exactly what a service would get, hint and all."""

    def run(audio):
        import ear
        import learning

        previous = ear.EAR_MODEL_OVERRIDE
        ear.EAR_MODEL_OVERRIDE = model
        try:
            hint = learning.vocabulary_hint("")
            # Long recordings must be cut: the ear sends one utterance at a
            # time, and a model handed twenty minutes behaves differently from
            # one handed twenty seconds.
            out = []
            step = int(ear.SAMPLE_RATE * 20)
            for start in range(0, audio.size, step):
                chunk = audio[start:start + step]
                if chunk.size < ear.SAMPLE_RATE:
                    continue
                text, _lang = ear.transcribe_with_gemini(chunk, hint)
                out.append(text)
            return " ".join(out)
        finally:
            ear.EAR_MODEL_OVERRIDE = previous

    return run


def local_whisper(lang: str):
    """The offline model already on this machine."""

    def run(audio):
        import ear

        return ear._transcribe_local(lang, audio)

    return run


def huggingface(model_id: str):
    """Any ASR model on Hugging Face's free inference API.

    This is how to try the Kinyarwanda-specific models — mbazaNLP's NeMo
    Conformer, Digital Umuganda's Whisper fine-tune — without a GPU or a
    download. Needs HF_TOKEN in the environment; a free account is enough.
    """

    def run(audio):
        import json
        import urllib.request

        token = os.environ.get("HF_TOKEN", "").strip()
        if not token:
            raise RuntimeError("set HF_TOKEN (free at huggingface.co/settings/tokens)")
        import ear

        out = []
        step = int(ear.SAMPLE_RATE * 20)
        for start in range(0, audio.size, step):
            chunk = audio[start:start + step]
            if chunk.size < ear.SAMPLE_RATE:
                continue
            req = urllib.request.Request(
                f"https://api-inference.huggingface.co/models/{model_id}",
                data=ear._wav_bytes(chunk), method="POST",
                headers={"authorization": f"Bearer {token}",
                         "content-type": "audio/wav"})
            with urllib.request.urlopen(req, timeout=120) as res:
                body = json.loads(res.read().decode("utf-8"))
            out.append(body.get("text", "") if isinstance(body, dict) else "")
        return " ".join(out)

    return run


# Everything worth trying. Comment out what you cannot reach today; the ones
# needing HF_TOKEN are skipped automatically with a note rather than failing.
ENGINES = {
    "gemini flash-lite (today)": gemini("gemini-3.5-flash-lite"),
    "gemini flash (heavier)": gemini("gemini-3.5-flash"),
    "gemini 3.7 flash": gemini("gemini-3.7-flash"),
    "offline whisper (rw)": local_whisper("rw"),
    "offline whisper (en)": local_whisper("en"),
    "mbazaNLP kinyarwanda": huggingface("mbazaNLP/Whisper-Small-Kinyarwanda"),
    "DigitalUmuganda kinyarwanda": huggingface("DigitalUmuganda/whisper_small_kinyarwanda"),
    "meta MMS (1000+ langs)": huggingface("facebook/mms-1b-all"),
}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit("usage: python scripts/bakeoff.py service.wav truth.txt")

    audio = load_audio(sys.argv[1])
    truth = open(sys.argv[2], encoding="utf-8").read().strip()
    print(f"audio {audio.size / 16000:.1f}s   reference {len(words(truth))} words\n")

    results = []
    for name, engine in ENGINES.items():
        started = time.time()
        try:
            heard = engine(audio)
        except Exception as e:
            print(f"  {name:<30} skipped: {str(e)[:60]}")
            continue
        took = time.time() - started
        wer, sub, dele, ins = word_error_rate(truth, heard)
        results.append((wer, name, took, heard, sub, dele, ins))
        print(f"  {name:<30} WER {wer * 100:5.1f}%   {took:6.1f}s")

    if not results:
        raise SystemExit("\nNo engine could be reached.")

    results.sort()
    print(f"\nBest: {results[0][1]} at {results[0][0] * 100:.1f}% word error rate")
    print("\n--- what each one heard (first 200 characters) ---")
    for wer, name, _t, heard, sub, dele, ins in results:
        print(f"\n{name}  ({wer * 100:.1f}%  {sub} wrong, {dele} missed, {ins} invented)")
        print(f"  {heard[:200]}")


main()
