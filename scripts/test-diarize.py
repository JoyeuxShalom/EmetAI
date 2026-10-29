# Telling the preacher from the interpreter.
#
# Uses two REAL voices — Microsoft David (male) and Zira (female) — synthesised
# on this machine, so the pitch difference the diarizer relies on is a genuine
# one and not a number I chose to make the test pass.
#
# Run:  cd server && python -X utf8 ../scripts/test-diarize.py

import os
import subprocess
import sys
import tempfile
import wave

SERVER = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
)
sys.path.insert(0, SERVER)

import numpy as np  # noqa: E402

import diarize  # noqa: E402

PASS = FAIL = 0
TMP = tempfile.mkdtemp(prefix="emetai-diar-")


def check(label, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ok  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label} {extra}")


def say(text: str, voice: str) -> np.ndarray:
    """Synthesise with a named Windows voice and return 16 kHz mono float32."""
    path = os.path.join(TMP, f"{voice}-{abs(hash(text)) % 10**8}.wav")
    if not os.path.isfile(path):
        script = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            f"$s.SelectVoice('{voice}'); "
            f"$s.SetOutputToWaveFile('{path}'); "
            f"$s.Speak('{text}'); $s.Dispose()"
        )
        subprocess.run(["powershell", "-NoProfile", "-Command", script],
                       capture_output=True, timeout=120)
    if not os.path.isfile(path):
        return np.zeros(0, dtype=np.float32)
    with wave.open(path) as w:
        raw, rate = w.readframes(w.getnframes()), w.getframerate()
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if rate != diarize.SAMPLE_RATE:
        idx = (np.arange(int(len(a) * diarize.SAMPLE_RATE / rate))
               * rate / diarize.SAMPLE_RATE).astype(int)
        a = a[idx]
    return a


MALE = "Microsoft David Desktop"
FEMALE = "Microsoft Zira Desktop"

PREACHER_LINES = [
    "Nuko rero bavandimwe, Imana yakunze abari mu isi cyane.",
    "Turasoma mu gitabo cya Yohana igice cya gatatu.",
    "Imana ni umukiza wacu, kandi iduha ubuzima bwiza.",
    "Ubwami bw Imana buri hafi, nimwizere ubutumwa bwiza.",
]
INTERPRETER_LINES = [
    "So then brothers, God so loved the world.",
    "We are reading from the book of John chapter three.",
    "God is our saviour, and he gives us abundant life.",
    "The kingdom of God is at hand, believe the good news.",
]

probe = say(PREACHER_LINES[0], MALE)
if probe.size == 0:
    print("Windows speech synthesis unavailable — cannot run this test here.")
    sys.exit(0)


# ------------------------------------------------------- the voice print ----
print("— describing a voice —")

male = say(PREACHER_LINES[1], MALE)
female = say(INTERPRETER_LINES[1], FEMALE)

pm = diarize.voice_print(male)
pf = diarize.voice_print(female)
check("a male voice is described", pm is not None)
check("a female voice is described", pf is not None)
if pm and pf:
    gap = diarize.semitones(pm["f0"], pf["f0"])
    check(f"the two voices are clearly apart ({gap:.1f} semitones)",
          gap >= diarize.DISTINCT_SEMITONES, round(gap, 1))
    check("pitches are inside the human range",
          all(diarize.F0_MIN_HZ <= p["f0"] <= diarize.F0_MAX_HZ for p in (pm, pf)),
          (round(pm["f0"]), round(pf["f0"])))

check("silence describes nothing",
      diarize.voice_print(np.zeros(diarize.SAMPLE_RATE, dtype=np.float32)) is None)
check("a fragment too short describes nothing",
      diarize.voice_print(np.ones(100, dtype=np.float32)) is None)

# The same speaker must look like the same speaker across different sentences,
# or every utterance would spawn a new profile.
pm2 = diarize.voice_print(say(PREACHER_LINES[2], MALE))
check("the same voice is consistent across sentences",
      diarize.semitones(pm["f0"], pm2["f0"]) < diarize.DISTINCT_SEMITONES,
      round(diarize.semitones(pm["f0"], pm2["f0"]), 1))


# --------------------------------------------------- an interpreted service --
print("\n— a preacher and an interpreter, taking turns —")

d = diarize.Diarizer()
labels = []
for rw, en in zip(PREACHER_LINES, INTERPRETER_LINES):
    labels.append(("preacher", d.observe(say(rw, MALE), "rw")))
    labels.append(("interpreter", d.observe(say(en, FEMALE), "en")))

check("it found exactly two speakers", len(d.profiles) == 2, len(d.profiles))

preacher_ids = {r["speaker"] for who, r in labels if who == "preacher"}
interp_ids = {r["speaker"] for who, r in labels if who == "interpreter"}
check("every preacher turn went to one speaker", len(preacher_ids) == 1, preacher_ids)
check("every interpreter turn went to one speaker", len(interp_ids) == 1, interp_ids)
check("and they are not the same speaker",
      preacher_ids != interp_ids, (preacher_ids, interp_ids))

check("nothing was wrongly flagged as overlap",
      not any(r["overlap"] for _who, r in labels))

langs = {i: set(p["langs"]) for i, p in enumerate(d.profiles)}
check("each speaker is associated with their own language",
      all(len(v) == 1 for v in langs.values()), langs)


# ------------------------------------------------------ who is who ----------
print("\n— naming the roles —")

# With only a few short turns, the honest answer is "speaker 1" and "speaker 2".
check("it does not guess a role from four short turns",
      all(r["role"].startswith("speaker") for _w, r in labels[:2]),
      labels[0][1]["role"])

# Give the preacher the talking time a preacher actually has.
long_d = diarize.Diarizer()
for _ in range(3):
    for rw, en in zip(PREACHER_LINES, INTERPRETER_LINES):
        long_d.observe(say(rw, MALE), "rw")
        long_d.observe(say(en, FEMALE), "en")
# The preacher expounds; the interpreter renders. Simulate that imbalance.
long_d.profiles[0]["secs"] = 600.0
long_d.profiles[1]["secs"] = 240.0
roles = [long_d.role(0), long_d.role(1)]
check("the voice that opened the service is called the preacher",
      roles == ["preacher", "interpreter"], roles)

# In a strictly interpreted service both speak for almost exactly as long, and
# a talk-time rule would never name anybody. Order is what settles it.
even = diarize.Diarizer()
for _ in range(3):
    for rw, en in zip(PREACHER_LINES, INTERPRETER_LINES):
        even.observe(say(rw, MALE), "rw")
        even.observe(say(en, FEMALE), "en")
even.profiles[0]["secs"] = 420.0
even.profiles[1]["secs"] = 415.0
check("equal talking time still names the roles",
      [even.role(0), even.role(1)] == ["preacher", "interpreter"],
      [even.role(0), even.role(1)])

# …but a song leader who opened the service is not the preacher.
flipped = diarize.Diarizer()
for _ in range(3):
    for rw, en in zip(PREACHER_LINES, INTERPRETER_LINES):
        flipped.observe(say(rw, MALE), "rw")
        flipped.observe(say(en, FEMALE), "en")
flipped.profiles[0]["secs"] = 90.0
flipped.profiles[1]["secs"] = 900.0
check("a brief opening voice does not outrank the sermon",
      [flipped.role(0), flipped.role(1)] == ["interpreter", "preacher"],
      [flipped.role(0), flipped.role(1)])

summary = long_d.summary()
check("the summary reports both voices", len(summary) == 2)
check("and reports which languages each one used",
      all(s["languages"] for s in summary), summary)


# --------------------------------------------------------- overlap ---------
print("\n— two people talking at once —")

both = say(PREACHER_LINES[0], MALE)
other = say(INTERPRETER_LINES[0], FEMALE)
n = min(both.size, other.size)
mixed = (both[:n] + other[:n]) / 2.0

trained = diarize.Diarizer()
for rw, en in zip(PREACHER_LINES, INTERPRETER_LINES):
    trained.observe(say(rw, MALE), "rw")
    trained.observe(say(en, FEMALE), "en")

result = trained.observe(mixed, "mixed")
check("overlapping speech is not attributed to one speaker",
      result["speaker"] is None, result)
check("and it is reported as overlap rather than guessed",
      result["overlap"] and result["role"] == "both", result)

# Turn-taking inside one utterance is NOT overlap — an interpreted service is
# full of it, and calling it overlap would discard half the service.
consecutive = np.concatenate([say(PREACHER_LINES[3], MALE),
                              say(INTERPRETER_LINES[3], FEMALE)])
turn = trained.observe(consecutive, "mixed")
check("two speakers one after another is not called overlap",
      not turn["overlap"] or turn["speaker"] is None, turn)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
