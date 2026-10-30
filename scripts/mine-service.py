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
haven't hasn't don't doesn't didn't won't can't couldn't shouldn't wouldn't
isn't aren't wasn't weren't that's there's here's what's it's i'm you're we're
even come told later things people person time thing someone because think
always every away issue challenge facing harvest going getting before using
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
    """Case is KEPT. A capital letter in the middle of a sentence is the
    cheapest signal there is for a proper noun, and proper nouns are exactly
    what the ear mishears — Baal, Midiani, Gideoni, Adulamu. The first version
    lowercased everything and then wondered why it only ever found "family"
    and "person"."""
    text = text.replace("’", "'").replace("ʼ", "'")
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
    ap.add_argument("audio",
                    help="audio file, or a saved corpus with --from-corpus")
    ap.add_argument("--from-corpus", action="store_true",
                    help="re-analyse an already-saved transcript, no API calls")
    ap.add_argument("--minutes", type=float, default=20,
                    help="how much of the recording to use (default 20)")
    ap.add_argument("--skip", type=float, default=0,
                    help="minutes to skip at the start — worship, announcements")
    ap.add_argument("--teach", action="store_true",
                    help="write the VOCABULARY into the lexicon (safe)")
    ap.add_argument("--teach-repairs", action="store_true",
                    help="ALSO write the suggested repairs. Read them first — "
                         "a repair rewrites that word in every future transcript")
    ap.add_argument("--church", default="",
                    help="user id to teach; blank teaches the shipped vocabulary")
    args = ap.parse_args()

    if args.from_corpus:
        # Re-reading a saved transcript costs nothing. Worth having: the
        # analysis was wrong twice before it was right, and re-transcribing
        # twenty minutes to test a change to the word counting is absurd.
        lines = []
        for raw in open(args.audio, encoding="utf-8"):
            if raw.startswith("#") or "	" not in raw:
                continue
            lang, text = raw.rstrip("\n").split("\t", 1)
            lines.append((lang, text))
        if not lines:
            raise SystemExit("No transcript lines in that file.")
        print(f"\nRe-analysing {len(lines)} saved lines (no API calls)")
        analyse(lines, args)
        return

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
            # A free-tier key WILL rate-limit over a long service. Backing off
            # properly keeps the run going; a flat retry just burns the quota
            # faster and loses more of the sermon.
            wait = 30 if "429" in str(e) else 5
            print(f"  [{i + 1}/{chunks}] failed ({str(e)[:40]}) - waiting {wait}s")
            time.sleep(wait)
            continue
        if text:
            lines.append((lang.replace("|request", ""), text))
            print(f"  [{i + 1}/{chunks}] {lang[:5]:<6} {text[:78]}")
        time.sleep(PAUSE_BETWEEN)

    if not lines:
        raise SystemExit("Nothing was transcribed. Is the Gemini key set?")

    took = time.time() - began
    print(f"\nTranscribed in {took / 60:.1f} min  ({failures} calls failed)")
    analyse(lines, args)


def analyse(lines, args):
    full = " ".join(t for _l, t in lines)
    tokens = words_of(full)
    print(f"\n{len(tokens):,} words transcribed")

    langs = collections.Counter(l for l, _t in lines if l)
    print("languages heard:", ", ".join(f"{k} {v}" for k, v in langs.most_common()))

    # ----------------------------------------------------- vocabulary ----
    # Frequency alone is the wrong measure, and a run against a real service
    # proved it: the top finds were "family", "person" and "haven't" — words
    # every speech model already knows, teaching the ear nothing. What it
    # mishears are NAMES, and a name said twice is worth more than a common
    # noun said seven times.
    known = {w.lower() for w in learning.vocabulary_hint(args.church).split(", ") if w}
    counts = collections.Counter(
        w for w in tokens
        if len(w) >= MIN_LENGTH and w.lower() not in STOPWORDS and not w.isdigit()
    )

    # A word is a proper noun if it is usually capitalised somewhere other
    # than the start of a sentence. Sentence starts are excluded, or every
    # first word in the service would look like a name.
    mid_sentence_caps: collections.Counter = collections.Counter()
    for text in (t for _l, t in lines):
        for sentence in re.split(r"[.!?]\s+", text):
            for w in words_of(sentence)[1:]:
                if w[:1].isupper():
                    mid_sentence_caps[w] += 1

    def score(word: str, n: int) -> tuple[int, int]:
        """Higher sorts first: proper nouns, then anything non-English."""
        is_name = mid_sentence_caps.get(word, 0) >= 1
        # A word a general model is unlikely to hold: not plain ASCII English
        # shape, or simply not an English word at all. Crude on purpose —
        # being wrong here costs one unnecessary hint, not a wrong verse.
        unusual = bool(re.search(r"[^a-zA-Z']", word)) or word.lower() not in STOPWORDS
        return (2 if is_name else (1 if unusual else 0), n)

    candidates = sorted(
        ((w, n) for w, n in counts.items()
         if w.lower() not in known
         and (n >= MIN_OCCURRENCES or mid_sentence_caps.get(w, 0) >= 2)),
        key=lambda wn: score(*wn), reverse=True,
    )
    names = [(w, n) for w, n in candidates if mid_sentence_caps.get(w, 0) >= 1]

    print(f"\n--- names and places ({len(names)}) — the ones that matter most ---")
    for w, n in names[:30]:
        print(f"  {n:>4}x  {w}")

    rest = [(w, n) for w, n in candidates if (w, n) not in set(names)][:25]
    print(f"\n--- other recurring words ({len(rest)} shown) ---")
    for w, n in rest:
        print(f"  {n:>4}x  {w}")

    # ---------------------------------------------------- mishearings ----
    # ⚠ PROPER NOUNS ONLY, and this restriction is not fussiness.
    #
    # The first version compared every rare word to every frequent one by edit
    # distance. Run against a real service it proposed rewriting mfite ("I
    # have"), ufite ("you have"), dufite ("we have") and gifite ("it has") all
    # to bafite ("they have") — and umunsi ("day") to umuntu ("person").
    #
    # Those are not mishearings. Kinyarwanda carries the subject on the verb,
    # so a one-letter difference is usually GRAMMAR, not noise. Applying them
    # would have silently turned "I have" into "they have" in every transcript
    # from then on. Edit distance is the wrong instrument for an agglutinative
    # language and must not be pointed at ordinary words.
    #
    # Names have no such prefix system — Adulamu heard as Aduramu really is one
    # word misheard — so that is the only place this is allowed to look.
    frequent_names = [w for w, n in counts.items()
                      if mid_sentence_caps.get(w, 0) >= 2 and n >= 3]
    repairs: list[tuple[str, str, int]] = []
    for rare, n in counts.items():
        if n > 2 or len(rare) < 5 or not rare[:1].isupper():
            continue
        for common in frequent_names:
            if rare != common and edits_within(rare.lower(), common.lower(), 2):
                repairs.append((rare, common, n))
                break

    print(f"\n--- likely mishearings ({len(repairs)}) ---")
    for heard, correct, n in repairs[:25]:
        print(f"  {n}x  {heard:<22} -> {correct}")

    # ------------------------------------------------ regression corpus --
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                       "server", "data", "service-corpus.txt")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    # Appending means re-running the same recording would count every word
    # twice and double every frequency. Only new lines are kept.
    seen = set()
    if os.path.isfile(out):
        seen = {l.split("	", 1)[-1].strip() for l in open(out, encoding="utf-8")}
    lines = [(l, t) for l, t in lines if t.strip() not in seen]
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
    # Repairs are NOT written by --teach. A repair rewrites that word in every
    # future transcript, and a wrong one is worse than the mishearing it
    # replaces. This has been wrong twice: first proposing mfite ("I have") →
    # bafite ("they have"), then Abana ("children") → Imana ("God"). A person
    # who speaks the language reads them before they go in.
    fixed = 0
    if args.teach_repairs:
        for heard, correct, _n in repairs:
            if learning._remember(args.church, "alias", heard, correct, "", "service"):
                fixed += 1
    elif repairs:
        print(f"\n{len(repairs)} repairs NOT written — read them above first.")
        print("A repair rewrites that word in every future transcript, and a")
        print("wrong one is worse than the mishearing it replaces. When you")
        print("are satisfied they are right, re-run with --teach-repairs.")
    print(f"\nTaught {taught} words and {fixed} repairs.")
    print("They are in the ear's hint from the next utterance onward.")


main()
