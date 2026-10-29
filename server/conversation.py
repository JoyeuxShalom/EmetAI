# The memory behind Emet's answers.
#
# A sermon is not a series of unrelated questions. The preacher says "Emet,
# what is grace?", then "say more", then twenty minutes later "go back to what
# you said about grace". Without a transcript of the exchange the second and
# third of those mean nothing, so every turn is written here and replayed to
# the model as context.
#
# Two things make it worth storing on the server rather than in the browser:
# the projector and the studio are separate windows, and a laptop that is
# reopened mid-service should still remember the morning.

import json
import re

import db

con = db.handle

# How much of the exchange to replay. Long enough for a real thread, short
# enough that a two-hour service never turns into a slow, expensive request.
HISTORY_TURNS = 12
HISTORY_CHARS = 6000

_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)
# Words too common to identify a topic — "what did you say about the church"
# should not match a card titled "The Church Fathers" on the strength of "the".
_STOP = {
    "the", "a", "an", "of", "and", "or", "to", "in", "on", "about", "that",
    "this", "it", "is", "was", "for", "with", "you", "your", "me", "my",
    "we", "our", "what", "who", "when", "how", "again", "back", "said",
    "say", "tell", "show", "go", "emet",
    "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "que",
    "qui", "quoi", "sur", "dans", "pour", "avec", "moi", "nous", "tu",
    "ni", "na", "no", "cyangwa", "ku", "mu", "wa", "ya", "cya", "rya",
    "bwa", "iki", "icyo", "ibyo", "uko", "ese",
}


def _tokens(text: str) -> set[str]:
    return {w for w in _WORD_RE.split((text or "").lower()) if len(w) > 2 and w not in _STOP}


# ------------------------------------------------------------- lifecycle ----

def ensure(user_id: str, conversation_id: str = "", lang: str = "en") -> str:
    """Return a live conversation id, resuming the given one when it belongs
    to this user. A stranger's id is never resumed — it is simply replaced."""
    if conversation_id:
        row = con.execute(
            "SELECT id FROM conversations WHERE id=? AND user_id=?",
            (conversation_id, user_id),
        ).fetchone()
        if row:
            con.execute(
                "UPDATE conversations SET updated_at=? WHERE id=?", (db.now(), conversation_id)
            )
            con.commit()
            return conversation_id

    new = db.new_id()
    at = db.now()
    con.execute(
        "INSERT INTO conversations (id, user_id, title, lang, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?)",
        (new, user_id, "", lang, at, at),
    )
    con.commit()
    return new


def append(
    conversation_id: str,
    role: str,
    content: str,
    topic: str = "",
    card: dict | None = None,
) -> str:
    row = con.execute(
        "SELECT COALESCE(MAX(seq), 0) AS n FROM conversation_messages WHERE conversation_id=?",
        (conversation_id,),
    ).fetchone()
    seq = int(row["n"]) + 1
    mid = db.new_id()
    con.execute(
        "INSERT INTO conversation_messages "
        "(id, conversation_id, seq, role, content, topic, card, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (
            mid,
            conversation_id,
            seq,
            role,
            content[:8000],
            topic[:200],
            json.dumps(card, ensure_ascii=False) if card else "",
            db.now(),
        ),
    )
    # The first thing asked names the conversation, for the admin's history view.
    if seq == 1 and role == "user":
        con.execute(
            "UPDATE conversations SET title=?, updated_at=? WHERE id=?",
            (content[:120], db.now(), conversation_id),
        )
    else:
        con.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?", (db.now(), conversation_id)
        )
    con.commit()
    return mid


# ------------------------------------------------------------ replay/read ----

def history(conversation_id: str, turns: int = HISTORY_TURNS) -> list[dict]:
    """The recent exchange, oldest first, in Messages API shape.

    Trimmed from the *front*, so the most recent turns always survive, and
    always starting on a user turn — the API rejects a history that opens
    with an assistant message."""
    rows = con.execute(
        "SELECT role, content FROM conversation_messages "
        "WHERE conversation_id=? ORDER BY seq DESC LIMIT ?",
        (conversation_id, turns),
    ).fetchall()

    picked: list[dict] = []
    budget = HISTORY_CHARS
    for row in rows:  # newest first
        text = (row["content"] or "").strip()
        if not text:
            continue
        budget -= len(text)
        if budget < 0 and picked:
            break
        picked.append({"role": row["role"], "content": text})
    picked.reverse()

    while picked and picked[0]["role"] != "user":
        picked.pop(0)
    return picked


def topics(conversation_id: str, limit: int = 40) -> list[dict]:
    """Every subject this conversation has covered, most recent first."""
    rows = con.execute(
        "SELECT topic, card, seq, created_at FROM conversation_messages "
        "WHERE conversation_id=? AND role='assistant' AND topic<>'' "
        "ORDER BY seq DESC LIMIT ?",
        (conversation_id, limit),
    ).fetchall()
    out, seen = [], set()
    for row in rows:
        key = row["topic"].lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"topic": row["topic"], "at": row["created_at"], "seq": row["seq"]})
    return out


def recall(conversation_id: str, phrase: str) -> dict | None:
    """Find an answer already given in this conversation.

    Used for "go back to what you said about grace" and for a question that
    is simply asked twice. Returning the stored card means the screen changes
    instantly and the church is not billed for the same answer again."""
    want = _tokens(phrase)
    if not want:
        return None
    rows = con.execute(
        "SELECT topic, card, seq FROM conversation_messages "
        "WHERE conversation_id=? AND role='assistant' AND card<>'' "
        "ORDER BY seq DESC LIMIT 60",
        (conversation_id,),
    ).fetchall()

    best, best_score = None, 0.0
    for row in rows:
        have = _tokens(row["topic"])
        if not have:
            continue
        shared = want & have
        if not shared:
            continue
        # Judge by how much of the *topic* was named, so "grace" matches the
        # card titled "Grace" outright rather than losing to a longer title
        # that happens to share a word.
        score = len(shared) / len(have)
        if score > best_score:
            best, best_score = row, score

    if best is None or best_score < 0.5:
        return None
    try:
        card = json.loads(best["card"])
    except Exception:
        return None
    return {"card": card, "topic": best["topic"], "seq": best["seq"]}


def clear(conversation_id: str, user_id: str) -> bool:
    row = con.execute(
        "SELECT id FROM conversations WHERE id=? AND user_id=?", (conversation_id, user_id)
    ).fetchone()
    if not row:
        return False
    con.execute("DELETE FROM conversation_messages WHERE conversation_id=?", (conversation_id,))
    con.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))
    con.commit()
    return True
