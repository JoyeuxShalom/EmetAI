# Three hours of continuous service, without interruption.
#
# A real three-hour test takes three hours and about a thousand API calls, so
# this replays three hours of audio chunks through the SAME arithmetic the
# websocket loop uses — the technique that caught the original dead-gate bug —
# and asserts that nothing grows without bound and nothing drifts.
#
# What actually threatens a long service, in order of how quietly it fails:
#   1. A buffer that grows all service and eventually eats the machine.
#   2. A speaker profile store that gains a new speaker every few minutes.
#   3. A session that goes idle mid-sermon and is only discovered on a
#      reconnect, as a silent 4401.
#   4. Anything that accumulates per utterance and is never trimmed.
#
# Run:  cd server && python -X utf8 ../scripts/test-soak.py

import os
import sys
import tracemalloc

SERVER = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
)
sys.path.insert(0, SERVER)

import numpy as np  # noqa: E402

import diarize  # noqa: E402
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


SERVICE_SECS = 3 * 3600
CHUNK = 4096                       # samples per websocket frame, as the browser sends
CHUNK_SECS = CHUNK / ear.SAMPLE_RATE
TOTAL_CHUNKS = int(SERVICE_SECS / CHUNK_SECS)


def run_service(remote: bool):
    """Replay a whole service through the loop's buffer and gate arithmetic.

    Speech and silence alternate the way an interpreted service does: a phrase,
    a pause, the interpreter's phrase, a pause — with occasional long stretches
    of both quiet and unbroken speech, which is where the bounds get tested.
    """
    silence_needed = ear.REMOTE_SILENCE_SECS if remote else ear.SILENCE_SECS
    max_utterance = ear.REMOTE_MAX_UTTERANCE_SECS if remote else ear.MAX_UTTERANCE_SECS

    buffer = np.zeros(0, dtype=np.float32)
    preroll = np.zeros(0, dtype=np.float32)
    heard_speech = False
    silence_run = 0.0
    noise_floor = 0.004
    chunks_seen = 0

    peak_buffer = 0
    peak_preroll = 0
    utterances = 0
    session_checks = 0
    rng = np.random.default_rng(7)

    for i in range(TOTAL_CHUNKS):
        chunks_seen += 1
        # A phrase lasts a few seconds, a pause about a second, and now and
        # then somebody preaches for a minute without drawing breath.
        phase = i % 40
        long_run = (i // 4000) % 7 == 3      # a sustained stretch of preaching
        speaking = long_run or phase < 24
        rms = float(rng.uniform(0.02, 0.06)) if speaking else float(rng.uniform(0.0004, 0.0012))

        if rms < noise_floor:
            noise_floor += (rms - noise_floor) * ear.FLOOR_FALL_ALPHA
        elif not heard_speech:
            noise_floor += (rms - noise_floor) * ear.FLOOR_RISE_ALPHA
        threshold = min(ear.ABS_MAX_ENERGY,
                        max(ear.ABS_MIN_ENERGY, noise_floor * ear.SPEECH_OVER_FLOOR))

        chunk = np.full(CHUNK, rms, dtype=np.float32)
        if rms >= threshold:
            if not heard_speech:
                buffer = np.concatenate([buffer, preroll])
            heard_speech = True
            silence_run = 0.0
        else:
            silence_run += CHUNK_SECS

        if heard_speech:
            buffer = np.concatenate([buffer, chunk])
        else:
            preroll = np.concatenate([preroll, chunk])[
                -int(ear.SAMPLE_RATE * ear.PREROLL_SECS):
            ]

        if chunks_seen % ear.SESSION_CHECK_CHUNKS == 0:
            session_checks += 1

        peak_buffer = max(peak_buffer, buffer.size)
        peak_preroll = max(peak_preroll, preroll.size)

        utter_secs = buffer.size / ear.SAMPLE_RATE
        if heard_speech and (
            (silence_run >= silence_needed and utter_secs > 0.5)
            or utter_secs >= max_utterance
        ):
            utterances += 1
            buffer = np.zeros(0, dtype=np.float32)
            preroll = np.zeros(0, dtype=np.float32)
            heard_speech = False
            silence_run = 0.0

    return {
        "peak_buffer_secs": peak_buffer / ear.SAMPLE_RATE,
        "peak_preroll_secs": peak_preroll / ear.SAMPLE_RATE,
        "utterances": utterances,
        "session_checks": session_checks,
        "end_buffer": buffer.size,
    }


# ------------------------------------------------ three hours of audio ------
print(f"— {SERVICE_SECS // 3600} hours of continuous service "
      f"({TOTAL_CHUNKS:,} audio chunks) —")

tracemalloc.start()
before = tracemalloc.get_traced_memory()[0]
remote = run_service(remote=True)
after = tracemalloc.get_traced_memory()[0]
tracemalloc.stop()

print(f"    utterances handled       : {remote['utterances']:,}")
print(f"    longest buffer held      : {remote['peak_buffer_secs']:.1f}s")
print(f"    session re-checks        : {remote['session_checks']}")
print(f"    memory retained          : {(after - before) / 1024:.0f} KB")

check("the audio buffer never exceeds one utterance",
      remote["peak_buffer_secs"] <= ear.REMOTE_MAX_UTTERANCE_SECS + 1.0,
      round(remote["peak_buffer_secs"], 1))
check("the pre-roll buffer stays bounded",
      remote["peak_preroll_secs"] <= ear.PREROLL_SECS + 0.3,
      round(remote["peak_preroll_secs"], 2))
check("nothing is left accumulating at the end",
      remote["end_buffer"] <= ear.REMOTE_MAX_UTTERANCE_SECS * ear.SAMPLE_RATE,
      remote["end_buffer"])
check("memory does not grow across three hours",
      (after - before) < 8 * 1024 * 1024, f"{(after - before) / 1024:.0f} KB")
check("the service actually produced utterances all the way through",
      remote["utterances"] > 500, remote["utterances"])

# The session must be re-checked often enough that it never goes idle, and
# rarely enough that it is not a database write every few seconds.
gap_secs = ear.SESSION_CHECK_CHUNKS * CHUNK_SECS
import security  # noqa: E402

check(f"the session is refreshed every {gap_secs / 60:.0f} minutes",
      gap_secs < security.SESSION_IDLE_SECONDS / 4, gap_secs)
check("which is comfortably inside the idle timeout",
      SERVICE_SECS < security.SESSION_TTL_SECONDS, security.SESSION_TTL_SECONDS)
check("and not so often it hammers the database",
      remote["session_checks"] < 120, remote["session_checks"])

# The offline ear has to survive the same three hours.
local = run_service(remote=False)
check("the offline ear is bounded over three hours too",
      local["peak_buffer_secs"] <= ear.MAX_UTTERANCE_SECS + 1.0,
      round(local["peak_buffer_secs"], 1))


# ------------------------------------------- three hours of two speakers ----
print("\n— the same three hours, through the diarizer —")

d = diarize.Diarizer()
male = (0.25 * np.sin(2 * np.pi * 120 * np.arange(3 * 16000) / 16000)).astype(np.float32)
female = (0.25 * np.sin(2 * np.pi * 210 * np.arange(3 * 16000) / 16000)).astype(np.float32)
# Pure tones are not voices; give them enough harmonic content to be voiced.
male += (0.10 * np.sin(2 * np.pi * 240 * np.arange(male.size) / 16000)).astype(np.float32)
female += (0.10 * np.sin(2 * np.pi * 420 * np.arange(female.size) / 16000)).astype(np.float32)

turns = remote["utterances"]
for i in range(min(turns, 1200)):
    d.observe(male if i % 2 == 0 else female, "rw" if i % 2 == 0 else "en")

check("it still knows exactly two speakers after a whole service",
      len(d.profiles) == 2, len(d.profiles))
check("and each profile stays small",
      all(len(p["langs"]) <= 4 for p in d.profiles),
      [len(p["langs"]) for p in d.profiles])
check("the speaking times are recorded",
      all(p["secs"] > 0 for p in d.profiles))

roles = {d.role(0), d.role(1)}
check("both roles are named after a full service",
      roles == {"preacher", "interpreter"}, roles)


# ------------------------------------------ what the browser holds onto -----
print("\n— what the Studio keeps in memory —")

operator = open(os.path.join(SERVER, "..", "src", "components", "OperatorView.tsx"),
                encoding="utf-8").read()
check("the transcript is trimmed, not grown for ever",
      "lines.slice(-40)" in operator)
check("detections are capped", ".slice(0, 8)" in operator)
check("a refused reconnect stops instead of looping",
      "REFUSED" in open(os.path.join(SERVER, "..", "src", "lib", "localEar.ts"),
                        encoding="utf-8").read())

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
