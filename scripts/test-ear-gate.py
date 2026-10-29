# The gate that decides speech from silence.
#
# This is the piece that made the ear look completely dead: a fixed RMS
# threshold that a quieter microphone never crossed, so nothing was buffered
# and not one word was transcribed — silently, in every language.
#
# Run:  cd server && python -X utf8 ../scripts/test-ear-gate.py

import os
import sys

SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
sys.path.insert(0, os.path.abspath(SERVER))

import numpy as np  # noqa: E402
import ear  # noqa: E402

PASS = FAIL = 0


def check(label, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ok  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label} {extra}")


def run_gate(levels, chunk_secs=0.256):
    """Replay a sequence of chunk RMS values through the same arithmetic the
    websocket loop uses, and report which chunks counted as speech."""
    noise_floor = 0.004
    heard = False
    spoke = []
    thresholds = []
    for rms in levels:
        if rms < noise_floor:
            noise_floor += (rms - noise_floor) * ear.FLOOR_FALL_ALPHA
        elif not heard:
            noise_floor += (rms - noise_floor) * ear.FLOOR_RISE_ALPHA
        threshold = min(
            ear.ABS_MAX_ENERGY, max(ear.ABS_MIN_ENERGY, noise_floor * ear.SPEECH_OVER_FLOOR)
        )
        thresholds.append(threshold)
        if rms >= threshold:
            heard = True
            spoke.append(True)
        else:
            spoke.append(False)
    return spoke, thresholds, noise_floor


# --------------------------------------------------- the failure it fixes ---
print("\n— a quiet microphone —")

# A lapel mic at low gain: a real voice, but well under the old fixed 0.008.
quiet_room = [0.0006] * 20
quiet_voice = [0.0045, 0.0060, 0.0052, 0.0048, 0.0055]
spoke, thresholds, floor = run_gate(quiet_room + quiet_voice)

check("the old fixed threshold would have heard nothing",
      all(v < 0.008 for v in quiet_voice), quiet_voice)
check("the adaptive gate hears this voice", any(spoke[len(quiet_room):]), spoke)
check("and stays shut through the silence before it",
      not any(spoke[:len(quiet_room)]), spoke[:len(quiet_room)])
check("the learned floor settles near the real room level",
      floor < 0.004, round(floor, 5))

print("\n— a loud room —")

# Air conditioning, a fan, a full hall: the floor must rise so the ear does
# not treat the noise itself as speech.
noisy_room = [0.0090, 0.0095, 0.0088, 0.0092] * 12
spoke, thresholds, floor = run_gate(noisy_room)
check("steady noise alone is not taken for speech", not any(spoke[8:]), spoke[8:12])
check("the threshold rose above the noise", thresholds[-1] > 0.0090, thresholds[-1])

loud_voice = [0.05, 0.06, 0.045]
spoke, _, _ = run_gate(noisy_room + loud_voice)
check("a real voice still cuts through that noise",
      all(spoke[len(noisy_room):]), spoke[len(noisy_room):])

print("\n— the bounds —")

# However silent the room, never demand less than electrical noise…
silent = [0.0] * 60
_, thresholds, _ = run_gate(silent)
check("the threshold never falls below the absolute minimum",
      thresholds[-1] >= ear.ABS_MIN_ENERGY, thresholds[-1])

# …and however loud, never demand more than a shout.
roaring = [0.5] * 60
_, thresholds, _ = run_gate(roaring)
check("the threshold never rises above the absolute maximum",
      thresholds[-1] <= ear.ABS_MAX_ENERGY, thresholds[-1])

print("\n— the floor cannot deafen the ear mid-sentence —")

# A long loud sentence must not drag the floor up behind itself.
_, thresholds, _ = run_gate([0.0008] * 20 + [0.06] * 60)
check("a long sentence does not raise the threshold past a voice",
      thresholds[-1] < 0.06, thresholds[-1])


# ------------------------------------------------- how speech is carved up --
print("\n— handing over phrases, not fragments —")

check("a breath no longer ends the sentence", ear.SILENCE_SECS >= 0.6, ear.SILENCE_SECS)
check("a long sentence is allowed to finish", ear.MAX_UTTERANCE_SECS >= 10, ear.MAX_UTTERANCE_SECS)
check("short audio is transcribed rather than discarded",
      ear.MIN_TRANSCRIBE_SECS <= 0.5, ear.MIN_TRANSCRIBE_SECS)
check("there is a pre-roll so the first syllable survives",
      ear.PREROLL_SECS >= 0.25, ear.PREROLL_SECS)

# The pre-roll must actually be bounded, or it grows without limit.
preroll = np.zeros(0, dtype=np.float32)
for _ in range(50):
    preroll = np.concatenate([preroll, np.zeros(4096, dtype=np.float32)])
    preroll = preroll[-int(ear.SAMPLE_RATE * ear.PREROLL_SECS):]
check("the pre-roll buffer stays bounded",
      preroll.size == int(ear.SAMPLE_RATE * ear.PREROLL_SECS), preroll.size)


# --------------------------------------------------- the Kinyarwanda model --
print("\n— the Kinyarwanda engine —")

model_dir = ear.RW_MODEL_DIR
check("the model is installed", os.path.isdir(model_dir), model_dir)
if os.path.isdir(model_dir):
    check("its weights are present", os.path.isfile(os.path.join(model_dir, "model.bin")))
    _source, token = ear.CONFIG["rw"]
    check("it decodes through a language token the model kept", token == "sw", token)

# ----------------------------------------------------------- the Gemini ear --
# The browser recogniser turned a reading of Deuteronomy 23 into "Pedic",
# "Nickelodeon" and "condos" during a real service. These guard the ear that
# replaced it.
print("\n— the Gemini ear —")

import io  # noqa: E402
import wave  # noqa: E402

check("it is registered as a language the ear accepts", "auto" in ear.CONFIG)
check("it is not a local model", ear.CONFIG["auto"][0] == "gemini")

tone = (0.2 * np.sin(np.arange(ear.SAMPLE_RATE) * 0.05)).astype(np.float32)
with wave.open(io.BytesIO(ear._wav_bytes(tone))) as w:
    shape = (w.getnchannels(), w.getsampwidth(), w.getframerate())
    check("it encodes 16-bit mono at the capture rate",
          shape == (1, 2, ear.SAMPLE_RATE), shape)
    check("it keeps every sample", w.getnframes() == tone.size, w.getnframes())

loud = ear._wav_bytes(np.array([2.0, -2.0], dtype=np.float32))[44:48]
check("clipping cannot wrap round to the opposite sign",
      int.from_bytes(loud[0:2], "little", signed=True) == 32767
      and int.from_bytes(loud[2:4], "little", signed=True) < 0, loud)

check("an interim never costs an API call",
      ear.transcribe("auto", tone, interim=True) == "")

# A "fast lane" once decoded interims with the offline ENGLISH model to show
# live text sooner. In a real Kinyarwanda service it invented fluent English —
# "Muraho" became "Muradho", and whole sentences that were never spoken
# ("This is your second home") landed in the transcript. The remote ear must
# stay silent between finals rather than guess in the wrong language.
check("and never guesses with the wrong language's model",
      ear.transcribe("auto", tone, interim=True) == "")

# The same reasoning applies to the safety net: in a Kinyarwanda service the
# English model is not a fallback, it is a fabricator. Missing a line is the
# honest outcome.
real_gemini = ear.transcribe_with_gemini
ear.transcribe_with_gemini = lambda a, h="": (_ for _ in ()).throw(RuntimeError("down"))
speech = np.zeros(ear.SAMPLE_RATE, dtype=np.float32)
try:
    quiet_notes: list = []
    kinyarwanda = ear.transcribe("auto", speech, notes=quiet_notes, allow_local=False)
    check("a Kinyarwanda room gets nothing rather than invented English",
          kinyarwanda == "", kinyarwanda)
    check("and the operator is told the phrase was missed",
          any("missed" in n for n in quiet_notes), quiet_notes)
finally:
    ear.transcribe_with_gemini = real_gemini

check("too short an utterance is never sent",
      0 < ear.GEMINI_MIN_SECS < ear.GEMINI_MAX_SECS)

# The cold start is what "the AI ear is not listening" actually looked like:
# the first call in each pool thread took 7.95s (model lookup + TLS handshake)
# against 1.8s warm, so the opening utterances of a service all blew the
# deadline. The warm-up must run at startup, must cover every worker thread,
# and must never raise — a warm-up that throws would take the ear with it.
check("the ear warms its connections before the service",
      callable(getattr(ear, "warm_gemini", None)))
check("it warms every worker thread", ear.FINAL_POOL_WORKERS >= 2,
      ear.FINAL_POOL_WORKERS)
check("the deadline leaves headroom over a warm call",
      ear.GEMINI_DEADLINE_SECS >= 4.0, ear.GEMINI_DEADLINE_SECS)

real_secret = db_get = None
try:
    import db as _db

    real_secret, _db.get_secret = _db.get_secret, lambda *a, **k: ""
    ear.warm_gemini()          # no key configured
    check("warming without a key is harmless", True)
except Exception as e:
    check("warming without a key is harmless", False, str(e)[:60])
finally:
    if real_secret:
        _db.get_secret = real_secret

# A rate-limited key must degrade the ear, not silence it. A free-tier key will
# hit 429 somewhere in a long service; losing the sentence is worse than
# transcribing it less well.
def _rate_limited(_audio, _hint=""):
    raise RuntimeError("HTTP 429")

real, ear.transcribe_with_gemini = ear.transcribe_with_gemini, _rate_limited
notes = []
try:
    ear.transcribe("auto", np.zeros(ear.SAMPLE_RATE, dtype=np.float32), notes=notes)
    fell_back = True
except Exception as e:
    # Acceptable only if the offline model is not installed on this machine.
    fell_back = "429" not in str(e)
finally:
    ear.transcribe_with_gemini = real
check("a Gemini failure falls through to the offline ear", fell_back)
check("and the operator is told the ear degraded",
      any("offline" in n for n in notes), notes)


print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
