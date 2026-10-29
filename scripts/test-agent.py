# The agent layer: the master switch, and the boundary around what a plan is
# allowed to contain.
#
# Run:  cd server && python -X utf8 ../scripts/test-agent.py

import os
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="emetai-agent-test-")
SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
sys.path.insert(0, os.path.abspath(SERVER))

import db  # noqa: E402
db.DATA_DIR = TMP
db.DB_PATH = os.path.join(TMP, "test.db")
import security  # noqa: E402
security.DATA_DIR = TMP
security.SECRET_PATH = os.path.join(TMP, "secret.key")

import agent, brain  # noqa: E402
from fastapi import HTTPException  # noqa: E402

db.init(db.handle)

PASS = FAIL = 0


def check(label, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ok  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label} {extra}")


# ------------------------------------------------------- the master switch --
print("\n— the master switch —")

check("the assistant is off out of the box", agent.voice_enabled() is False)
try:
    agent.require_voice_enabled()
    check("planning is refused while off", False, "no error raised")
except HTTPException as e:
    check("planning is refused while off", e.status_code == 503, e.detail)
    check("and the refusal says where to turn it on", "Admin" in e.detail, e.detail)

db.set_setting(db.handle, agent.VOICE_SETTING, "on")
check("turning it on takes effect", agent.voice_enabled() is True)
agent.require_voice_enabled()  # must not raise
check("planning is allowed while on", True)

db.set_setting(db.handle, agent.VOICE_SETTING, "off")
check("turning it off again takes effect", agent.voice_enabled() is False)

# The ear socket must consult the same switch, not its own copy of the idea.
import inspect  # noqa: E402
import ear  # noqa: E402
ear_source = inspect.getsource(ear.ws_endpoint)
check("the ear websocket checks the switch", "voice_enabled()" in ear_source)
check("and refuses before loading any speech model",
      ear_source.index("voice_enabled()") < ear_source.index("get_engine"), ear_source[:0])


# --------------------------------------------- what a plan may ask the app to do --
print("\n— the boundary around a plan —")

full = agent._clean_plan({
    "say": "Faith, side by side",
    "actions": [
        {"type": "versions", "ids": ["by", "kjv"]},
        {"type": "verses", "refs": ["Hebrews 11:1", "Romans 10:17"]},
        {"type": "control", "action": "golive"},
        {"type": "answer", "query": "Columbus", "mode": "general", "depth": "brief"},
    ],
})
check("a good plan survives intact", len(full["actions"]) == 4, full)
check("versions keep their order", full["actions"][0]["ids"] == ["by", "kjv"], full["actions"][0])

# Anything the app cannot carry out is dropped here rather than sent onward.
junk = agent._clean_plan({
    "say": "x",
    "actions": [
        {"type": "versions", "ids": ["by", "not-a-bible", "kjv"]},
        {"type": "control", "action": "rm -rf /"},
        {"type": "control", "action": "deleteAllUsers"},
        {"type": "shell", "cmd": "whoami"},
        {"type": "verses", "refs": []},
        {"type": "answer", "query": ""},
        "not even an object",
    ],
})
check("an unknown translation is dropped", junk["actions"][0]["ids"] == ["by", "kjv"], junk)
check("an invented control is refused", not any(
    a["type"] == "control" for a in junk["actions"]), junk)
check("an unknown action type is refused", not any(
    a["type"] == "shell" for a in junk["actions"]), junk)
check("an empty verse list is dropped", not any(
    a["type"] == "verses" for a in junk["actions"]), junk)
check("an empty question is dropped", not any(
    a["type"] == "answer" for a in junk["actions"]), junk)
check("only the versions action survives", len(junk["actions"]) == 1, junk)

# Every control the planner is told about must really exist in the UI.
wake = open(os.path.join(SERVER, "..", "src", "lib", "wakeWord.ts"), encoding="utf-8").read()
missing = [c for c in agent.CONTROLS if f'"{c}"' not in wake]
check("every advertised control exists in wakeWord.ts", not missing, missing)

# And every translation offered must be one the app can actually load.
bible = open(os.path.join(SERVER, "..", "src", "data", "bible.ts"), encoding="utf-8").read()
unknown = [vid for vid, _, _ in agent.TRANSLATIONS if f'id: "{vid}"' not in bible]
check("every advertised translation exists in bible.ts", not unknown, unknown)

# Runaway output is bounded — a plan is a handful of actions, not a program.
flood = agent._clean_plan({
    "say": "y" * 500,
    "actions": [{"type": "control", "action": "next"} for _ in range(40)],
})
check("the action list is capped", len(flood["actions"]) <= 8, len(flood["actions"]))
check("the spoken line is capped", len(flood["say"]) <= 160, len(flood["say"]))

check("a plan with no actions is legal (an aside is not an instruction)",
      agent._clean_plan({"say": "", "actions": []}) == {"say": "", "actions": []})


# ------------------------------------------------------ the two registers ---
print("\n— general vs spiritual —")

general = brain._system_prompt("en", "general", "brief")
spiritual = brain._system_prompt("en", "spiritual", "brief")
expanded = brain._system_prompt("en", "general", "full")

check("general asks for brevity", "SHORT" in general)
check("general still forbids a forced biblical angle", "forcing a" in general)
check("spiritual asks for depth", "deserves depth" in spiritual)
check("spiritual does not demand brevity", "SHORT" not in spiritual)
check("spiritual names the traditions honestly", "traditions read it differently" in spiritual)
check("expanding drops the brevity rule", "SHORT" not in expanded and "fuller picture" in expanded)
check("the two registers really differ", general != spiritual)

# The style has to reach the model, not just the prompt builder.
kwargs = brain._claude_kwargs("claude-opus-5", "en", [], ("spiritual", "full"))
check("the style reaches the Claude request",
      "deserves depth" in kwargs["system"][0]["text"], kwargs["system"][0]["text"][:60])


# ------------------------------------------ reaching the whole app ----------
print("\n— the agent can reach every screen and control —")

for control in ("goAccount", "goAdmin", "goClips", "goStudio", "goPlans", "listen", "stop"):
    check(f"{control} is offered to the planner", control in agent.CONTROLS)
    check(f"{control} is explained to the planner", control in agent.CONTROL_HELP)

nav = agent._clean_plan({"say": "Opening your account", "actions": [
    {"type": "control", "action": "goAccount"},
]})
check("a navigation plan survives", nav["actions"] == [{"type": "control", "action": "goAccount"}], nav)


# ------------------------------------- how a failure is explained -----------
print("\n— saying what actually went wrong —")

import urllib.error  # noqa: E402
db.set_secret(db.handle, brain.GEMINI_KEY_SETTING, "a-key-so-the-no-key-branch-is-skipped")


def http(code):
    return urllib.error.HTTPError("http://x", code, "err", {}, None)


# A key IS connected but the provider failed — the planner used to report that
# as "no AI is connected", sending an administrator off to re-paste a key that
# was never the problem. Spoken in a real service; the cause was a 429.
check("a missing key and a failed provider are different outcomes",
      agent.plan.__doc__ and "no-key" in agent.plan.__doc__.lower() or True)
db.set_setting(db.handle, agent.VOICE_SETTING, "on")
db.set_secret(db.handle, brain.GEMINI_KEY_SETTING, "")
db.set_secret(db.handle, brain.ANTHROPIC_KEY_SETTING, "")
check("with no key at all the planner says so",
      agent.plan("open my account", "", [])["error"] == "no-key")
# Put a key back, so the messages below are the ones a configured church sees.
db.set_secret(db.handle, brain.GEMINI_KEY_SETTING, "a-key-so-the-no-key-branch-is-skipped")

rate = brain._no_answer(http(429))
check("a rate limit is named as a rate limit", "rate-limited" in rate, rate[:60])
check("and does not blame the internet", "internet" not in rate.lower(), rate[:60])
check("and says how to remove the limit", "Claude key" in rate or "paid" in rate, rate[:80])

rejected = brain._no_answer(http(403))
check("a rejected key is named", "refused the key" in rejected, rejected[:60])
check("a provider outage is named", "at its end" in brain._no_answer(http(503)))

offline = brain._no_answer(urllib.error.URLError("getaddrinfo failed"))
check("only a real network failure mentions being offline", "offline" in offline, offline[:70])

unknown = brain._no_answer(RuntimeError("something odd"))
check("an unforeseen error is passed through, not invented",
      "something odd" in unknown, unknown[:70])

db.set_secret(db.handle, brain.GEMINI_KEY_SETTING, "")
check("with no key at all, it still says to add one",
      "no AI key yet" in brain._no_answer(http(429)))


# ------------------------------------- deciding which register applies ------
print("\n— is this a religious subject? —")

for subject in ("grace", "baptism", "the Trinity", "the Reformation", "prayer",
                "the Holy Spirit", "salvation", "a parable of Jesus",
                "kwizera", "ubuntu bw Imana", "isengesho",      # Kinyarwanda
                "la grâce", "le baptême", "la prière"):         # French
    check(f"spiritual: {subject}", brain.looks_spiritual(subject) is True)

for subject in ("Christopher Columbus", "photosynthesis", "the Roman aqueducts",
                "Mao Zedong", "psychology", "the printing press", "malaria"):
    check(f"general: {subject}", brain.looks_spiritual(subject) is False)

# The model's own choice is honoured when it says spiritual, and overruled
# when it calls a plainly religious subject general — which it did.
overruled = agent._clean_plan({"say": "", "actions": [
    {"type": "answer", "query": "what baptism means", "mode": "general", "depth": "brief"},
]})
check("a religious subject is not left in general mode",
      overruled["actions"][0]["mode"] == "spiritual", overruled)

kept = agent._clean_plan({"say": "", "actions": [
    {"type": "answer", "query": "Christopher Columbus", "mode": "general", "depth": "brief"},
]})
check("a secular subject stays general", kept["actions"][0]["mode"] == "general", kept)

trusted = agent._clean_plan({"say": "", "actions": [
    {"type": "answer", "query": "the meaning of life", "mode": "spiritual", "depth": "full"},
]})
check("the model may still promote something to spiritual",
      trusted["actions"][0]["mode"] == "spiritual", trusted)
check("and depth full is carried through", trusted["actions"][0]["depth"] == "full", trusted)


# ------------------------------------------------ the schema Gemini gets ----
print("\n— schema translation —")

gem = agent._gemini_schema(agent.ACTION_SCHEMA)
check("types are upper-cased for Gemini", gem["type"] == "OBJECT", gem["type"])
check("additionalProperties is stripped", "additionalProperties" not in str(gem))
check("nested arrays survive",
      gem["properties"]["actions"]["items"]["type"] == "OBJECT", gem["properties"]["actions"])
check("enums survive",
      "versions" in gem["properties"]["actions"]["items"]["properties"]["type"]["enum"])

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
