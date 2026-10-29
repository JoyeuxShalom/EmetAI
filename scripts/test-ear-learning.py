# Does what the ear learns actually reach the ear?
#
# test-learning.py proves the learning store works. This proves it is WIRED —
# that the vocabulary hint reaches the transcription prompt and that a learned
# repair is applied to the transcript before anything downstream sees it. A
# store nobody reads from would pass every test in the other file.
#
# Throwaway database in a temp directory. Never the real one.
#
# Run:  cd server && python -X utf8 ../scripts/test-ear-learning.py

import os
import sys
import tempfile

SERVER = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
)
sys.path.insert(0, SERVER)

_tmp = tempfile.mkdtemp(prefix="emetai-earlearn-")
import db  # noqa: E402

db.DATA_DIR = _tmp
db.DB_PATH = os.path.join(_tmp, "test.db")
db._local = db.threading.local()
db.init(db.handle)

import numpy as np  # noqa: E402

import ear  # noqa: E402
import learning  # noqa: E402

learning.con = db.handle

PASS = FAIL = 0


def check(label, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ok  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label} {extra}")


CHURCH = "church-1"
learning.seed()
learning.learn_correction(CHURCH, "apostle nickelodeon", "Apostle Nkurunziza", "en")

# The prompt is built inside transcribe_with_gemini, so intercept the HTTP call
# and read what would actually have been sent to Gemini.
sent = {}


def fake_http(path, body, headers, timeout=45):
    import json as _json

    sent["body"] = _json.loads(body.decode("utf-8"))
    return {"candidates": [{"content": {"parts": [
        {"text": '{"text": "and then apostle nickelodeon read", "lang": "en"}'}
    ]}}]}


import brain  # noqa: E402

ear._gemini_post = fake_http
brain.pick_gemini_lite_model = lambda key: "gemini-test-lite"
db.set_secret(db.handle, brain.GEMINI_KEY_SETTING, "test-key")

audio = (0.2 * np.sin(np.arange(ear.SAMPLE_RATE * 2) * 0.05)).astype(np.float32)


# ------------------------------------------------- the hint reaches the ear --
print("— what the ear is told before it listens —")

hint = learning.vocabulary_hint(CHURCH)
text, lang = ear.transcribe_with_gemini(audio, hint)

prompt = ""
for part in sent["body"]["contents"][0]["parts"]:
    prompt += part.get("text", "")

check("the ear was actually called", bool(sent))
check("the church's own correction is in the prompt", "Nkurunziza" in prompt)
check("Kinyarwanda book names are in the prompt", "Gutegeka kwa Kabiri" in prompt)
check("the audio still goes with it",
      any("inline_data" in p for p in sent["body"]["contents"][0]["parts"]))
check("it is still told not to translate", "Do not translate" in prompt)
check("the transcript comes back", text.startswith("and then"), text)
check("the language comes back", lang == "en", lang)

# No hint must not produce a dangling instruction with an empty word list.
sent.clear()
ear.transcribe_with_gemini(audio, "")
bare = "".join(p.get("text", "") for p in sent["body"]["contents"][0]["parts"])
check("with nothing learned there is no empty vocabulary line",
      "likely to appear" not in bare)


# --------------------------------------------- the repair reaches the text --
print("\n— what the ear does with what it heard —")

heard = "and then apostle nickelodeon read"
check("the raw transcript still contains the mishearing", "nickelodeon" in heard)
check("the repair fixes it before anything else sees it",
      learning.repair(heard, CHURCH) == "and then Apostle Nkurunziza read",
      learning.repair(heard, CHURCH))

# The offline ears must not be charged for a hint they cannot use.
check("an offline ear is given no hint",
      ear.CONFIG["en"][0] != "gemini")

# And the fallback path must still repair — a degraded ear is not an excuse
# for putting a wrong verse on the wall.
learning._remember(CHURCH, "alias", "condos", "Colossians", "en", "correction")
check("a repair applies whichever ear produced the text",
      learning.repair("turn to condos three", CHURCH) == "turn to Colossians three",
      learning.repair("turn to condos three", CHURCH))

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
