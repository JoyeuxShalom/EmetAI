# How EmetAI stops making the same mistake twice.
#
# ── What "learning" honestly means here ─────────────────────────────────────
# It does not mean the model retrains itself. No speech model on this machine
# or behind Gemini's API is being fine-tuned by us. What actually moves the
# accuracy needle for a *particular* church is far more mundane, and far more
# effective:
#
#   1. Tell the ear which proper nouns it is about to hear. Speech recognition
#      is a search over what is likely; a name it has never met — Kinyarwanda
#      book titles, an apostle's name, a Rwandan place — is not in that search
#      until you put it there. This is the single biggest win available, and
#      it is why "Gutegeka kwa Kabiri" came back as nonsense.
#   2. Repair the mishearings we have already seen, before they can reach
#      scripture matching and put the wrong verse on a wall.
#   3. Keep a record of every service, so "it got that wrong" stops being an
#      impression and becomes a row somebody can act on.
#
# Every one of those grows from what the operator corrects. That is the loop:
# a mistake is corrected once, and the correction is in the ear's ear from the
# next utterance onward.

import json
import os
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import db
from accounts import current_user

router = APIRouter()
con = db.handle

# How many learned terms are handed to the ear. A hint is a prompt, not a
# dictionary: past a point it stops steering and starts drowning the audio.
# 250 comfortably holds the book names of all three Bibles plus church
# vocabulary, and costs a few hundred tokens on a call we are already making.
MAX_HINT_TERMS = 250
# …of which this many are held for the church's OWN corrections. Without a
# reserved share the shipped list — 198 book names, alphabetically — fills the
# whole hint and the very words a church corrected us on never reach the ear.
CHURCH_SHARE = 80
# A correction only becomes a vocabulary hint once it looks like a real word
# rather than a slip of the tongue.
MIN_TERM_LEN = 3


# ------------------------------------------------------------- the seed ----
# What EmetAI ships knowing. A church that has never corrected anything still
# gets the Kinyarwanda and French book names, which is most of the problem.

def _book_names() -> list[tuple[str, str]]:
    """(name, language) for every book of every Bible we ship."""
    root = os.path.join(os.path.dirname(__file__), "..", "public", "bibles")
    wanted = {"by.json": "rw", "kjv.json": "en", "ls1910.json": "fr"}
    out: list[tuple[str, str]] = []
    for filename, lang in wanted.items():
        path = os.path.join(root, filename)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            continue
        for book in data.get("books", []):
            name = str(book.get("name", "")).strip()
            # "1 Samweli" — the ear needs the name, not the numeral.
            bare = name.lstrip("0123456789 ").strip()
            if len(bare) >= MIN_TERM_LEN:
                out.append((bare, lang))
    return out


# Words a Rwandan Pentecostal service is full of and a general-purpose speech
# model has never been trained to expect. These are what turn into "Pedic" and
# "Nickelodeon" when the ear is guessing blind.
SEED_TERMS: list[tuple[str, str]] = [
    ("Imana", "rw"), ("Yesu", "rw"), ("Kristo", "rw"), ("Mwami", "rw"),
    ("Umwuka Wera", "rw"), ("ubwami", "rw"), ("umugisha", "rw"),
    ("ubutumwa bwiza", "rw"), ("umuhanuzi", "rw"), ("intumwa", "rw"),
    ("itorero", "rw"), ("gusenga", "rw"), ("kwizera", "rw"), ("agakiza", "rw"),
    ("umukiza", "rw"), ("icyaha", "rw"), ("kubabarira", "rw"), ("ijambo", "rw"),
    ("umurava", "rw"), ("guhanura", "rw"), ("umubatizo", "rw"),
    ("Amen", "rw"), ("Alleluia", "rw"), ("Nyagasani", "rw"),
    ("apostle", "en"), ("prophet", "en"), ("anointing", "en"),
    ("impartation", "en"), ("deliverance", "en"), ("intercession", "en"),
    ("covenant", "en"), ("testimony", "en"), ("congregation", "en"),
    ("Holy Spirit", "en"), ("scripture", "en"), ("righteousness", "en"),
    ("Jehovah", "en"), ("Elohim", "en"), ("Yahweh", "en"), ("Messiah", "en"),
    ("Kigali", "en"), ("Rwanda", "en"), ("Kinyarwanda", "en"),
    ("Saint-Esprit", "fr"), ("Seigneur", "fr"), ("alliance", "fr"),
    ("onction", "fr"), ("Écriture", "fr"),
]


def seed(user_id: str = "") -> int:
    """Install the shipped vocabulary. Idempotent — safe on every startup."""
    rows = [(name, lang) for name, lang in _book_names()] + SEED_TERMS
    added = 0
    for correct, lang in rows:
        if _remember(user_id, "term", "", correct, lang, source="seed"):
            added += 1
    return added


# ------------------------------------------------------- reading it back ----

def _remember(user_id: str, kind: str, heard: str, correct: str, lang: str,
              source: str) -> bool:
    """Insert, or bump the weight if this is already known. True if new."""
    correct = correct.strip()
    heard = heard.strip().lower()
    if not correct:
        return False
    existing = con.execute(
        "SELECT id FROM lexicon WHERE user_id=? AND kind=? AND heard=? AND correct=?",
        (user_id, kind, heard, correct),
    ).fetchone()
    if existing:
        con.execute("UPDATE lexicon SET weight = weight + 1 WHERE id=?", (existing["id"],))
        con.commit()
        return False
    con.execute(
        "INSERT INTO lexicon (id, user_id, kind, heard, correct, lang, weight, source,"
        " created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (uuid.uuid4().hex, user_id, kind, heard, correct, lang, 1, source, int(time.time())),
    )
    con.commit()
    return True


def vocabulary_hint(user_id: str = "", limit: int = MAX_HINT_TERMS) -> str:
    """The words to tell the ear it may be about to hear.

    A church's own corrections come first — they were earned on that room, that
    preacher and that interpreter, so they outrank anything we shipped.
    """
    rows = con.execute(
        "SELECT correct, user_id, weight, created_at FROM lexicon WHERE kind='term'"
        " AND (user_id=? OR user_id='')",
        (user_id,),
    ).fetchall()
    if not rows:
        return ""

    # Most confirmed first, then most recent: a word corrected last Sunday is
    # more use than one corrected in March, and alphabetical order is no use
    # to anybody.
    def rank(row):
        return (-int(row["weight"] or 1), -int(row["created_at"] or 0))

    own = sorted((r for r in rows if r["user_id"]), key=rank)
    shipped = sorted((r for r in rows if not r["user_id"]), key=rank)

    seen: set[str] = set()
    terms: list[str] = []

    def take(source, cap):
        for row in source:
            if len(terms) >= cap:
                return
            key = row["correct"].lower()
            if key in seen:
                continue
            seen.add(key)
            terms.append(row["correct"])

    take(own, min(limit, CHURCH_SHARE))
    take(shipped, limit)
    take(own, limit)   # any room the shipped list did not need goes back
    return ", ".join(terms)


def aliases(user_id: str = "") -> list[tuple[str, str]]:
    """Known mishearings, longest first so the most specific repair wins."""
    rows = con.execute(
        "SELECT heard, correct FROM lexicon WHERE kind='alias'"
        " AND (user_id=? OR user_id='') AND heard <> ''",
        (user_id,),
    ).fetchall()
    return sorted(((r["heard"], r["correct"]) for r in rows),
                  key=lambda p: -len(p[0]))


def repair(text: str, user_id: str = "") -> str:
    """Fix mishearings we have already been corrected on.

    Case-insensitive, whole-phrase, and applied before anything tries to match
    scripture — a wrong word that never reaches the matcher cannot put a wrong
    verse on the wall.
    """
    if not text:
        return text
    fixed = text
    for heard, correct in aliases(user_id):
        if not heard:
            continue
        lowered = fixed.lower()
        start = lowered.find(heard)
        while start != -1:
            fixed = fixed[:start] + correct + fixed[start + len(heard):]
            lowered = fixed.lower()
            start = lowered.find(heard, start + len(correct))
    return fixed


# --------------------------------------------------------- the correction ---

def learn_correction(user_id: str, heard: str, correct: str, lang: str = "") -> dict:
    """The operator says "it should have been X". Remember it two ways.

    As an alias, so this exact mishearing is repaired next time; and as
    vocabulary, so the ear is more likely to get the words right in the first
    place — which is the better of the two fixes, because it happens before
    the audio is thrown away.
    """
    heard, correct = heard.strip(), correct.strip()
    if not correct:
        raise HTTPException(400, "Say what it should have been.")
    learned = []
    if heard and heard.lower() != correct.lower():
        if _remember(user_id, "alias", heard, correct, lang, "correction"):
            learned.append("alias")
    for word in _terms_in(correct):
        if _remember(user_id, "term", "", word, lang, "correction"):
            learned.append(word)
    return {"ok": True, "learned": learned}


def _terms_in(text: str) -> list[str]:
    """The words worth teaching the ear out of a correction.

    Proper nouns and anything unusual — not "the", not "and". Capitalisation is
    the cheapest available signal for a name, and a name is exactly what a
    speech model mishears.
    """
    out: list[str] = []
    for raw in text.replace(",", " ").replace(".", " ").split():
        word = raw.strip("\"'()[]:;!?")
        if len(word) < MIN_TERM_LEN or word.isdigit():
            continue
        if word[0].isupper() or not word.isascii():
            out.append(word)
    return out


# ------------------------------------------------------ the service record --

def start_service(user_id: str, title: str, ear: str) -> str:
    sid = uuid.uuid4().hex
    con.execute(
        "INSERT INTO services (id, user_id, title, ear, started_at) VALUES (?,?,?,?,?)",
        (sid, user_id, title.strip()[:120], ear[:40], int(time.time())),
    )
    con.commit()
    return sid


def log_line(service_id: str, seq: int, heard: str, lang: str, action: str,
             result: str, score: float, speaker: str = "") -> None:
    if not service_id:
        return
    con.execute(
        "INSERT INTO service_lines (id, service_id, seq, heard, lang, action, result,"
        " score, speaker, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (uuid.uuid4().hex, service_id, seq, heard[:1000], lang[:8], action[:20],
         result[:200], float(score or 0), speaker[:20], int(time.time())),
    )
    con.execute("UPDATE services SET lines = lines + 1 WHERE id=?", (service_id,))
    con.commit()


def end_service(service_id: str) -> None:
    con.execute("UPDATE services SET ended_at=? WHERE id=? AND ended_at=0",
                (int(time.time()), service_id))
    con.commit()


def _owned(service_id: str, user) -> dict:
    row = con.execute("SELECT * FROM services WHERE id=?", (service_id,)).fetchone()
    if not row or (row["user_id"] != user["id"] and user["role"] != "admin"):
        raise HTTPException(404, "No such service.")
    return row


# ------------------------------------------------------------------ API ----

class ServiceStart(BaseModel):
    title: str = Field(default="", max_length=120)
    ear: str = Field(default="", max_length=40)


class LineIn(BaseModel):
    seq: int = 0
    heard: str = Field(default="", max_length=1000)
    lang: str = Field(default="", max_length=8)
    action: str = Field(default="", max_length=20)
    result: str = Field(default="", max_length=200)
    score: float = 0.0
    speaker: str = Field(default="", max_length=20)


class CorrectionIn(BaseModel):
    heard: str = Field(default="", max_length=300)
    correct: str = Field(min_length=1, max_length=300)
    lang: str = Field(default="", max_length=8)
    service_id: str = Field(default="", max_length=64)


class TermIn(BaseModel):
    correct: str = Field(min_length=1, max_length=120)
    lang: str = Field(default="", max_length=8)


@router.post("/api/learning/service")
def api_start_service(body: ServiceStart, user=Depends(current_user)):
    return {"id": start_service(user["id"], body.title, body.ear)}


@router.post("/api/learning/service/{service_id}/line")
def api_log_line(service_id: str, body: LineIn, user=Depends(current_user)):
    _owned(service_id, user)
    log_line(service_id, body.seq, body.heard, body.lang, body.action,
             body.result, body.score, body.speaker)
    return {"ok": True}


@router.post("/api/learning/service/{service_id}/end")
def api_end_service(service_id: str, user=Depends(current_user)):
    _owned(service_id, user)
    end_service(service_id)
    return {"ok": True}


@router.get("/api/learning/services")
def api_services(user=Depends(current_user)):
    rows = con.execute(
        "SELECT * FROM services WHERE user_id=? ORDER BY started_at DESC LIMIT 40",
        (user["id"],),
    ).fetchall()
    return {"services": [dict(r) for r in rows]}


@router.get("/api/learning/service/{service_id}")
def api_service(service_id: str, user=Depends(current_user)):
    row = _owned(service_id, user)
    lines = con.execute(
        "SELECT * FROM service_lines WHERE service_id=? ORDER BY seq LIMIT 2000",
        (service_id,),
    ).fetchall()
    return {"service": dict(row), "lines": [dict(r) for r in lines]}


@router.delete("/api/learning/service/{service_id}")
def api_delete_service(service_id: str, user=Depends(current_user)):
    _owned(service_id, user)
    con.execute("DELETE FROM service_lines WHERE service_id=?", (service_id,))
    con.execute("DELETE FROM services WHERE id=?", (service_id,))
    con.commit()
    return {"ok": True}


@router.post("/api/learning/correction")
def api_correction(body: CorrectionIn, user=Depends(current_user)):
    result = learn_correction(user["id"], body.heard, body.correct, body.lang)
    if body.service_id:
        con.execute("UPDATE services SET corrections = corrections + 1 WHERE id=? AND user_id=?",
                    (body.service_id, user["id"]))
        con.commit()
    return result


@router.get("/api/learning/lexicon")
def api_lexicon(user=Depends(current_user)):
    rows = con.execute(
        "SELECT * FROM lexicon WHERE user_id=? ORDER BY weight DESC, created_at DESC LIMIT 500",
        (user["id"],),
    ).fetchall()
    shipped = con.execute(
        "SELECT COUNT(*) AS n FROM lexicon WHERE user_id=''"
    ).fetchone()
    return {"terms": [dict(r) for r in rows], "shipped": int(shipped["n"]),
            "hint": vocabulary_hint(user["id"])}


@router.post("/api/learning/term")
def api_add_term(body: TermIn, user=Depends(current_user)):
    added = _remember(user["id"], "term", "", body.correct, body.lang, "manual")
    return {"ok": True, "added": added}


@router.delete("/api/learning/term/{term_id}")
def api_delete_term(term_id: str, user=Depends(current_user)):
    con.execute("DELETE FROM lexicon WHERE id=? AND user_id=?", (term_id, user["id"]))
    con.commit()
    return {"ok": True}
