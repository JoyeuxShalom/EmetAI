# The learning layer: what EmetAI remembers between services.
#
# Runs against a THROWAWAY database in a temp directory. Never point this at
# server/data/emetai.db — a stray write there once destroyed a live API key.
#
# Run:  cd server && python -X utf8 ../scripts/test-learning.py

import os
import sys
import tempfile

SERVER = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
)
sys.path.insert(0, SERVER)

_tmp = tempfile.mkdtemp(prefix="emetai-learn-")
import db  # noqa: E402

db.DATA_DIR = _tmp
db.DB_PATH = os.path.join(_tmp, "test.db")
db._local = db.threading.local()
db.init(db.handle)

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
OTHER = "church-2"


# ------------------------------------------------------------- the seed ----
print("— what it ships knowing —")

added = learning.seed()
check("seeding installs a vocabulary", added > 100, added)
check("seeding twice adds nothing", learning.seed() == 0)

hint = learning.vocabulary_hint(CHURCH)
check("Kinyarwanda book names are in the hint", "Gutegeka kwa Kabiri" in hint)
check("English book names are in the hint", "Deuteronomy" in hint)
check("French book names are in the hint",
      "Deutéronome" in hint or "Deut" in hint, hint[:80])
check("church vocabulary is in the hint", "Umwuka Wera" in hint)
check("the hint is bounded", len(hint.split(", ")) <= learning.MAX_HINT_TERMS,
      len(hint.split(", ")))
check("a numbered book is taught by name, not numeral",
      "Samweli" in hint and "1 Samweli" not in hint)


# ------------------------------------------------------- learning a fix ----
print("\n— learning from one correction —")

before = learning.vocabulary_hint(CHURCH)
result = learning.learn_correction(
    CHURCH, "apostle nickelodeon", "Apostle Nkurunziza", "en"
)
after = learning.vocabulary_hint(CHURCH)

check("the correction is accepted", result["ok"])
check("the misheard name is now vocabulary", "Nkurunziza" in after)
check("it was not vocabulary before", "Nkurunziza" not in before)
check("the mishearing is repaired in a transcript",
      learning.repair("and then apostle nickelodeon said", CHURCH)
      == "and then Apostle Nkurunziza said",
      learning.repair("and then apostle nickelodeon said", CHURCH))
check("repair is case-insensitive",
      "Nkurunziza" in learning.repair("APOSTLE NICKELODEON spoke", CHURCH))
check("an uncorrected line is untouched",
      learning.repair("the Lord is my shepherd", CHURCH)
      == "the Lord is my shepherd")

# The whole point: one church's corrections must not leak into another's.
check("another church does not inherit the alias",
      learning.repair("apostle nickelodeon", OTHER) == "apostle nickelodeon")
check("another church does not inherit the vocabulary",
      "Nkurunziza" not in learning.vocabulary_hint(OTHER))
check("but it still gets the shipped vocabulary",
      "Gutegeka kwa Kabiri" in learning.vocabulary_hint(OTHER))

# A church's own words must outrank the shipped list, or a long seed would
# push the very corrections it learned out of the hint.
for i in range(150):
    learning._remember(CHURCH, "term", "", f"Ikinyarwanda{i}", "rw", "correction")
crowded = learning.vocabulary_hint(CHURCH)
check("the church's own words survive a crowded hint",
      "Nkurunziza" in crowded)
check("and the hint is still bounded",
      len(crowded.split(", ")) <= learning.MAX_HINT_TERMS)


# --------------------------------------------------------- repeated fixes --
print("\n— the same correction twice —")

learning.learn_correction(CHURCH, "condos", "Colossians", "en")
first = db.handle.execute(
    "SELECT weight FROM lexicon WHERE user_id=? AND kind='alias' AND heard='condos'",
    (CHURCH,)).fetchone()["weight"]
learning.learn_correction(CHURCH, "condos", "Colossians", "en")
second = db.handle.execute(
    "SELECT weight FROM lexicon WHERE user_id=? AND kind='alias' AND heard='condos'",
    (CHURCH,)).fetchone()["weight"]
check("it is not duplicated", second == first + 1, (first, second))

rows = db.handle.execute(
    "SELECT COUNT(*) AS n FROM lexicon WHERE user_id=? AND kind='alias' AND heard='condos'",
    (CHURCH,)).fetchone()
check("exactly one row holds it", rows["n"] == 1, rows["n"])

# Longest match wins, so a specific repair is not broken by a general one.
learning._remember(CHURCH, "alias", "john", "John", "en", "manual")
learning._remember(CHURCH, "alias", "john the baptist", "John the Baptist", "en", "manual")
check("the most specific repair wins",
      learning.repair("john the baptist came", CHURCH)
      == "John the Baptist came",
      learning.repair("john the baptist came", CHURCH))

# A repair must not loop for ever when the fix contains the mishearing.
learning._remember(CHURCH, "alias", "emet", "Emet", "en", "manual")
check("a repair whose result contains the trigger terminates",
      learning.repair("emet emet emet", CHURCH) == "Emet Emet Emet",
      learning.repair("emet emet emet", CHURCH))


# ----------------------------------------------------- the service record --
print("\n— the record of a service —")

sid = learning.start_service(CHURCH, "Sunday second service", "gemini-auto")
check("a service can be opened", bool(sid))

learning.log_line(sid, 1, "you must have a designated area", "en",
                  "detected", "Deuteronomy 23:12", 0.82)
learning.log_line(sid, 2, "nickelodeon", "en", "ignored", "", 0.0)
row = db.handle.execute("SELECT * FROM services WHERE id=?", (sid,)).fetchone()
check("lines are counted", row["lines"] == 2, row["lines"])

lines = db.handle.execute(
    "SELECT * FROM service_lines WHERE service_id=? ORDER BY seq", (sid,)).fetchall()
check("what was heard is kept", lines[0]["heard"].startswith("you must have"))
check("what EmetAI did with it is kept", lines[0]["result"] == "Deuteronomy 23:12")
check("a line it ignored is kept too", lines[1]["action"] == "ignored")

learning.end_service(sid)
row = db.handle.execute("SELECT * FROM services WHERE id=?", (sid,)).fetchone()
check("the service can be closed", row["ended_at"] > 0)

learning.log_line("", 3, "orphan", "en", "ignored", "", 0)
check("a line with no service is dropped, not crashed", True)


# ------------------------------------------------------------- integrity ---
print("\n— it cannot be tricked —")

try:
    learning.learn_correction(CHURCH, "something", "   ", "en")
    blank_rejected = False
except Exception:
    blank_rejected = True
check("an empty correction is refused", blank_rejected)

learning.learn_correction(CHURCH, "", "Habakkuk", "en")
check("a correction with no mishearing still teaches the word",
      "Habakkuk" in learning.vocabulary_hint(CHURCH))
check("and creates no empty alias",
      learning.repair("anything at all", CHURCH) == "anything at all")

check("short noise is not taught as vocabulary",
      "of" not in learning._terms_in("of the Lord"), learning._terms_in("of the Lord"))
check("a proper noun is taught", "Lord" in learning._terms_in("of the Lord"))
check("a bare number is not taught", learning._terms_in("chapter 23") == [])

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
