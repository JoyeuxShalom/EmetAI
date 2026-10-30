# Learn a church's vocabulary from a recording of its own service.
#
# Teaching EmetAI one word at a time through the Learning page works, and it is
# far too slow: a service contains hundreds of names, places and church terms,
# and the operator will never type them all in. This reads a real recording and
# finds them.
#
# Three things come out of it:
#
#   1. **Vocabulary.** Words that recur through the service and are not already
#      known. These go into the ear's hint, which is the single biggest lever
#      on Kinyarwanda accuracy — a name the model has never met is not in its
#      search until we put it there.
#
#   2. **Mishearings.** When one word comes back three different ways in the
#      same service — cyanditswe, cyandiswe, cyandikwa — the rare spellings are
#      almost certainly the common one, misheard. Those become repairs.
#
#   3. **A regression corpus.** Real sentences from a real service, saved so
#      every future change can be tested against the way this church actually
#      speaks rather than against sentences I invented.
#
#   python scripts/mine-service.py service.wav --minutes 20
#   python scripts/mine-service.py service.wav --minutes 20 --teach
#
# --teach writes the findings into the lexicon for a church. Without it,
# nothing is written and you just get the report.

import argparse
import collections
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

import ear  # noqa: E402
import learning  # noqa: E402

CHUNK_SECS = 20          # what the ear sends in one call
PAUSE_BETWEEN = 1.2      # be kind to a free-tier key
# A word has to recur before it is worth teaching. Once is a slip of the ear;
# four times through a sermon is this church's vocabulary.
MIN_OCCURRENCES = 4
MIN_LENGTH = 4

# Words that are common in every language and teach the ear nothing.
STOPWORDS = set("""
the and for that with this from have was were will you your they them their
are our not but all can has had who what when where which while would there
she her him his its into out about over under then than more most some such
very just like been being does did doing any each other
mu ku na ni nk ngo ati uko cyane rero kandi ariko none noneho uyu uwo iyo izo
ibyo icyo aba abo ubu bwo kuri muri yuko niba cyangwa nawe nanjye
les des une dans pour avec sur par est sont ont été que qui quoi
""".split())


def load_audio(path: str) -> np.ndarray:
    """16 kHz mono float32, whatever came in."""
    if not path.lower().endswith(".wav"):
        path = to_wav(path)
    with wave.open(path) as w:
        channels, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise SystemExit("Need 16-bit audio. Convert it first (see --help).")
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != ear.SAMPLE_RATE:
        idx = (np.arange(int(len(audio) * ear.SAMPLE_RATE / rate))
               * rate / ear.SAMPLE_RATE).astype(int)
        audio = audio[idx]
    return audio


def to_wav(path: str) -> str:
    """Anything ffmpeg understands — mp3, m4a, mp4, mkv — becomes a wav."""
    import subprocess

    import imageio_ffmpeg

    out = os.path.splitext(path)[0] + ".16k.wav"
    if os.path.isfile(out):
        return out
    print(f"  converting {os.path.basename(path)} to 16 kHz mono…")
    subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-i", path,
         "-ac", "1", "-ar", str(ear.SAMPLE_RATE), "-vn", out],
        capture_output=True, check=True,
    )
    return out


def words_of(text: str) -> list[str]:
    text = text.lower().replace("'", "'")
    return [w for w in re.split(r"[^\w']+", text) if w]


def edits_within(a: str, b: str, limit: int) -> bool:
    """Cheap bounded edit distance — only used to cluster near-identical words."""
    if abs(len(a) - len(b)) > limit:
        return False
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > limit:
            return False
        prev = cur
    return prev[-1] <= limit


def main():
    ap = argparse.ArgumentParser(
        description="Learn a church's vocabulary from a recording of its service.",
        epilog="Any format ffmpeg reads works: wav, mp3, m4a, mp4, mkv.",
    )
    ap.add_argument("audio")
    ap.add_argument("--minutes", type=float, default=20,
                    help="how much of the recording to use (default 20)")
    ap.add_argument("--skip", type=float, default=0,
                    help="minutes to skip at the start — worship, announcements")
    ap.add_argument("--teach", action="store_true",
                    help="write the findings into the lexicon")
    ap.add_argument("--church", default="",
                    help="user id to teach; blank teaches the shipped vocabulary")
    args = ap.parse_args()

    audio = load_audio(args.audio)
    start = int(args.skip * 60 * ear.SAMPLE_RATE)
    end = start + int(args.minutes * 60 * ear.SAMPLE_RATE)
    audio = audio[start:end]
    step = CHUNK_SECS * ear.SAMPLE_RATE
    chunks = max(1, audio.size // step)

    print(f"\n{audio.size / ear.SAMPLE_RATE / 60:.1f} minutes, {chunks} calls to the ear")
    print("(a free-tier key is paced, so this takes a while)\n")

    hint = learning.vocabulary_hint(args.church)
    lines: list[tuple[str, str]] = []
    failures = 0
    began = time.time()

    for i in range(chunks):
        piece = audio[i * step:(i + 1) * step]
        try:
            text, lang = ear.transcribe_with_gemini(piece, hint)
        except Exception as e:
            failures += 1
            print(f"  [{i + 1}/{chunks}] failed: {str(e)[:50]}")
            time.sleep(5)
            continue
        if text:
            lines.append((lang.replace("|request", ""), text))
            print(f"  [{i + 1}/{chunks}] {lang[:5]:<6} {text[:78]}")
        time.sleep(PAUSE_BETWEEN)

    if not lines:
        raise SystemExit("Nothing was transcribed. Is the Gemini key set?")

    took = time.time() - began
    full = " ".join(t for _l, t in lines)
    tokens = words_of(full)
    print(f"\nTranscribed {len(tokens):,} words in {took / 60:.1f} min"
          f"  ({failures} calls failed)")

    langs = collections.Counter(l for l, _t in lines if l)
    print("languages heard:", ", ".join(f"{k} {v}" for k, v in langs.most_common()))

    # ----------------------------------------------------- vocabulary ----
    known = {w.lower() for w in learning.vocabulary_hint(args.church).split(", ") if w}
    counts = collections.Counter(
        w for w in tokens
        if len(w) >= MIN_LENGTH and w not in STOPWORDS and not w.isdigit()
    )
    candidates = [(w, n) for w, n in counts.most_common()
                  if n >= MIN_OCCURRENCES and w not in known]

    print(f"\n--- vocabulary worth teaching ({len(candidates)}) ---")
    for w, n in candidates[:40]:
        print(f"  {n:>4}x  {w}")

    # ---------------------------------------------------- mishearings ----
    # A rare word one or two edits from a common one is usually the common one,
    # misheard. Only suggested, never applied without --teach.
    frequent = [w for w, n in counts.items() if n >= MIN_OCCURRENCES * 2]
    repairs: list[tuple[str, str, int]] = []
    for rare, n in counts.items():
        if n > 2 or len(rare) < 5:
            continue
        for common in frequent:
            if rare != common and edits_within(rare, common, 2):
                repairs.append((rare, common, n))
                break

    print(f"\n--- likely mishearings ({len(repairs)}) ---")
    for heard, correct, n in repairs[:25]:
        print(f"  {n}x  {heard:<22} -> {correct}")

    # ------------------------------------------------ regression corpus --
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                       "server", "data", "service-corpus.txt")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "a", encoding="utf-8") as f:
        f.write(f"\n# {os.path.basename(args.audio)} "
                f"{time.strftime('%Y-%m-%d')}\n")
        for lang, text in lines:
            f.write(f"{lang or '??'}\t{text}\n")
    print(f"\nTranscript appended to {os.path.relpath(out)}")

    # ------------------------------------------------------- teaching ----
    if not args.teach:
        print("\nNothing was written to the lexicon. Re-run with --teach to keep it.")
        return

    taught = 0
    for w, _n in candidates:
        if learning._remember(args.church, "term", "", w, "", "service"):
            taught += 1
    fixed = 0
    for heard, correct, _n in repairs:
        if learning._remember(args.church, "alias", heard, correct, "", "service"):
            fixed += 1
    print(f"\nTaught {taught} words and {fixed} repairs.")
    print("They are in the ear's hint from the next utterance onward.")


main()
