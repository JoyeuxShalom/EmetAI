# Tests for the streamed answer: the line parser that turns model output into
# a card as it arrives, and the conversation memory behind follow-ups and
# "go back to what you said about…".
#
# Run:  cd server && python -X utf8 ../scripts/test-brain.py

import os
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="emetai-brain-test-")
SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
sys.path.insert(0, os.path.abspath(SERVER))

import db  # noqa: E402
db.DATA_DIR = TMP
db.DB_PATH = os.path.join(TMP, "test.db")
import security  # noqa: E402
security.DATA_DIR = TMP
security.SECRET_PATH = os.path.join(TMP, "secret.key")

import brain  # noqa: E402
import conversation  # noqa: E402

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


def run(chunks):
    """Feed the parser the way a network delivers text — in arbitrary pieces."""
    parser = brain.CardStream()
    events = []
    for chunk in chunks:
        events += parser.feed(chunk)
    events += parser.finish()
    return parser, events


# ------------------------------------------------------- the line parser ----
print("\n— streaming card parser —")

ANSWER = (
    "TITLE: Psychology\n"
    "SUBTITLE: noun · the science of mind and behaviour\n"
    "BODY: Psychology is the scientific study of the mind and behaviour.\n"
    "BODY: It became an experimental science in 1879.\n"
    "POINT: Wilhelm Wundt opened the first laboratory in Leipzig.\n"
    "POINT: In scripture: Romans 12:2 speaks of the renewing of the mind.\n"
)

parser, events = run([ANSWER])
card = parser.result("psychology", "Emet AI")
check("title parsed", card["title"] == "Psychology", card["title"])
check("subtitle parsed", card["subtitle"].startswith("noun"), card["subtitle"])
check("both body paragraphs", len(card["body"]) == 2, card["body"])
check("both points", len(card["points"]) == 2, card["points"])

# The same answer split at every awkward place must give the same card.
for size in (1, 3, 7, 13, 40):
    pieces = [ANSWER[i:i + size] for i in range(0, len(ANSWER), size)]
    same, _ = run(pieces)
    check(
        f"chunked every {size} chars gives the same card",
        same.result("psychology", "Emet AI") == card,
    )

# Text has to reach the screen before the answer is finished.
parser, events = run(["TITLE: Grace\nBODY: Unearned favour"])
check("a partial line still emits", any(e["slot"] == "body" for e in events))
check(
    "title is emitted before the body is complete",
    [e["slot"] for e in events].index("title") < [e["slot"] for e in events].index("body"),
)

# Every event carries the field in full, so a dropped one cannot corrupt it.
_, events = run(["TITLE: Gra", "ce of God"])
titles = [e["text"] for e in events if e["slot"] == "title"]
check("later events supersede earlier ones", titles[-1] == "Grace of God", titles)
check("no event is a bare delta", all(t.startswith("Gra") for t in titles), titles)

# Junk the model should never put on a sanctuary screen.
parser, _ = run(["```\nTITLE: Faith\n<thinking>hmm</thinking>\nBODY: Trust in God.\n```\n"])
card = parser.result("faith", "Emet AI")
check("markdown fences dropped", "```" not in str(card), card)
check("internal tags stripped", "thinking" not in str(card), card)
check("body survived the noise", card["body"] == ["Trust in God."], card["body"])

# A model that ignores the format entirely still produces something readable.
parser, _ = run(["Grace is the unearned favour of God towards people who cannot earn it."])
card = parser.result("grace", "Emet AI")
check("prose answer is rescued", card["title"] == "Grace" and card["body"], card)

parser, _ = run([""])
check("empty answer yields no card", parser.result("grace", "Emet AI") == {})

# Tags are only tags at the start of a line.
parser, _ = run(["TITLE: Body\nBODY: The word BODY: appears mid-sentence here.\n"])
card = parser.result("body", "Emet AI")
check("mid-line tag is not a new field", len(card["body"]) == 1, card["body"])


# ------------------------------------------------------ replay as events ----
print("\n— replaying a finished card —")

finished = {
    "title": "Elohim", "subtitle": "Hebrew · Strong’s H430",
    "body": ["God, in the plural of majesty."], "points": ["Used 2600 times."],
    "source": "Strong’s",
}
replayed = list(brain._card_events(finished))
check("every field is replayed", len(replayed) == 4, replayed)
check("all replayed events are final", all(e["done"] for e in replayed))
rebuilt = brain.CardStream()
for e in replayed:  # a client rebuilding from events must get the card back
    if e["slot"] == "body":
        rebuilt.card["body"].append(e["text"])
    elif e["slot"] == "point":
        rebuilt.card["points"].append(e["text"])
    else:
        rebuilt.card[e["slot"]] = e["text"]
check(
    "a client can rebuild the card from the events",
    rebuilt.result("elohim", "Strong’s") == finished,
    rebuilt.result("elohim", "Strong’s"),
)


# --------------------------------------------------- conversation memory ----
print("\n— conversation memory —")

USER = "user-under-test"
conv = conversation.ensure(USER, "", "en")
check("a conversation is created", bool(conv))
check("the same id is resumed", conversation.ensure(USER, conv, "en") == conv)
check("another user's id is not resumed", conversation.ensure("someone-else", conv) != conv)
check("a made-up id is not resumed", conversation.ensure(USER, "no-such-id") != conv)

conversation.append(conv, "user", "Define: grace")
conversation.append(
    conv, "assistant", "TITLE: Grace\nBODY: Unearned favour.",
    topic="Grace",
    card={"title": "Grace", "subtitle": "", "body": ["Unearned favour."],
          "points": [], "source": "Emet AI"},
)
conversation.append(conv, "user", "say more about that")
conversation.append(
    conv, "assistant", "TITLE: Grace in Paul\nBODY: Paul's letters develop it.",
    topic="Grace in Paul",
    card={"title": "Grace in Paul", "subtitle": "", "body": ["Paul's letters develop it."],
          "points": [], "source": "Emet AI"},
)

hist = conversation.history(conv)
check("history is replayed in order", [m["role"] for m in hist]
      == ["user", "assistant", "user", "assistant"], hist)
check("history starts on a user turn", hist[0]["role"] == "user")
check("the follow-up is in the history",
      any("say more" in m["content"] for m in hist))

topics = conversation.topics(conv)
check("both topics are remembered", len(topics) == 2, topics)
check("most recent topic first", topics[0]["topic"] == "Grace in Paul", topics)

# Jumping back to an earlier subject.
found = conversation.recall(conv, "grace")
check("recall finds the earlier answer", found is not None)
check("recall returns the stored card", found and found["card"]["title"] == "Grace", found)
check("recall of an uncovered topic returns nothing",
      conversation.recall(conv, "quantum mechanics") is None)
check("recall ignores filler words",
      conversation.recall(conv, "what did you say about grace") is not None)
check("a bare stop word matches nothing",
      conversation.recall(conv, "the about that") is None)

other = conversation.ensure("another-user", "", "en")
check("recall does not cross conversations", conversation.recall(other, "grace") is None)

# A long thread must not be replayed in full — the request would crawl.
long_conv = conversation.ensure(USER, "", "en")
for i in range(40):
    conversation.append(long_conv, "user", f"question number {i}")
    conversation.append(long_conv, "assistant", f"answer number {i}", topic=f"Topic {i}")
long_hist = conversation.history(long_conv)
check("history is capped", len(long_hist) <= conversation.HISTORY_TURNS, len(long_hist))
check("the cap keeps the NEWEST turns",
      "question number 39" in long_hist[-2]["content"], long_hist[-2])
check("a capped history still starts on a user turn", long_hist[0]["role"] == "user")

check("clearing needs the owner", conversation.clear(conv, "someone-else") is False)
check("owner can clear", conversation.clear(conv, USER) is True)
check("cleared conversation forgets", conversation.recall(conv, "grace") is None)


# ------------------------------------------------------- model selection ----
print("\n— model configuration —")

check("default model is Opus 5", brain.claude_model() == "claude-opus-5", brain.claude_model())
db.set_setting(db.handle, brain.MODEL_SETTING, "claude-haiku-4-5")
check("admin choice is honoured", brain.claude_model() == "claude-haiku-4-5")
check(
    "effort is not sent to a model that would reject it",
    "output_config" not in brain._claude_kwargs("claude-haiku-4-5", "en", []),
)
tuned = brain._claude_kwargs("claude-opus-5", "en", [])
check("effort is sent to Opus 5", tuned.get("output_config", {}).get("effort") == "low", tuned)
check("thinking is off for speed", tuned.get("thinking") == {"type": "disabled"}, tuned)
db.set_setting(db.handle, brain.MODEL_SETTING, "")

# Keys are secrets: they must not sit in the database in the clear.
db.set_secret(db.handle, brain.ANTHROPIC_KEY_SETTING, "sk-ant-secret-value")
stored = db.get_setting(db.handle, brain.ANTHROPIC_KEY_SETTING)
check("the stored key is encrypted", "secret-value" not in stored, stored[:20])
check("and reads back correctly", brain.claude_key() == "sk-ant-secret-value")
db.set_secret(db.handle, brain.ANTHROPIC_KEY_SETTING, "")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
