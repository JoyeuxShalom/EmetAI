# EmetAI brain — answers "Emet, define…" / "Emet, who was…" questions
# with a card the projector can display.
#
# Three tiers, fastest first:
#   1. Strong's Hebrew/Greek lexicon (bundled, offline, authoritative)
#   2. Claude (Anthropic SDK, streaming) or Gemini (streaming) — admin's key
#   3. Wikipedia summary + free dictionary API (no key needed)
#
# The answer is STREAMED. A sermon cannot pause while a model finishes
# thinking, so the title appears the moment it exists and the rest of the card
# fills in underneath. See stream_answer() and CardStream.

import io
import http.client
import json
import re
import ssl
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import conversation
import db
import security

try:  # the SDK is in requirements.txt; a half-installed box should still boot
    import anthropic
except Exception:  # pragma: no cover - only hit on an incomplete install
    anthropic = None

router = APIRouter()
con = db.handle

LEXICON_PATH = __file__.rsplit("brain.py", 1)[0] + "data/lexicon/lexicon.json"
ANTHROPIC_KEY_SETTING = "anthropic_api_key"
GEMINI_KEY_SETTING = "gemini_api_key"
MODEL_SETTING = "brain_model"

# Opus 5 is the default because the preacher is asking real questions in front
# of a congregation and a wrong answer is worse than a slow one. Streaming
# plus low effort keeps it quick; an admin who wants cheaper or faster can set
# `brain_model` (claude-haiku-4-5 is the budget choice).
DEFAULT_CLAUDE_MODEL = "claude-opus-5"
GEMINI_FALLBACK_MODEL = "gemini-flash-latest"  # used only if model discovery fails

# Effort and the thinking switch arrived with Claude 4.6. Older models reject
# them outright, so they are only sent to a model that understands them.
_TUNABLE_MODEL = re.compile(r"(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)")

LANG_NAMES = {"en": "English", "fr": "French", "rw": "Kinyarwanda"}

# Several of these APIs sit behind Cloudflare, which rejects urllib's default
# "Python-urllib/3.x" signature outright. Always say who we are.
USER_AGENT = "EmetAI/1.0 (+https://emetai.rw)"

_ssl_ctx = ssl.create_default_context()


# ---- Auth (same trust level as the ear websocket) ----

def _require_user(authorization: str):
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not signed in.")
    payload = security.verify_token(authorization[7:])
    if not payload:
        raise HTTPException(401, "Session expired — sign in again.")
    return payload


def _require_admin(authorization: str):
    payload = _require_user(authorization)
    row = con.execute("SELECT role FROM users WHERE id=?", (payload["uid"],)).fetchone()
    if not row or row["role"] != "admin":
        raise HTTPException(403, "Admin access required.")


# ---- Tier 1: Strong's lexicon ----

_lexicon = None
_lexicon_lock = threading.Lock()


def get_lexicon():
    global _lexicon
    if _lexicon is None:
        with _lexicon_lock:
            if _lexicon is None:
                with open(LEXICON_PATH, encoding="utf-8") as f:
                    _lexicon = json.load(f)
    return _lexicon


def _fold_query(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z]", "", s.lower())


def _edit1(a: str, b: str) -> bool:
    """True if a and b are within one edit of each other."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la > lb:
        a, b, la, lb = b, a, lb, la
    i = j = diff = 0
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
        else:
            diff += 1
            if diff > 1:
                return False
            if la == lb:
                i += 1
            j += 1
    return True


def lexicon_lookup(word: str, scope: str):
    """scope: 'hebrew' | 'greek' | '' (both). Returns list of entries."""
    lex = get_lexicon()
    q = _fold_query(word)
    if len(q) < 2:
        return []
    ids = lex["index"].get(q, [])
    if not ids:
        # fuzzy: one edit away, same first letter (keeps the scan tiny)
        candidates = [k for k in lex["index"] if k and k[0] == q[0] and _edit1(k, q)]
        for k in sorted(candidates, key=lambda k: abs(len(k) - len(q))):
            ids = lex["index"][k]
            if ids:
                break
    if scope == "hebrew":
        ids = [i for i in ids if i.startswith("H")]
    elif scope == "greek":
        ids = [i for i in ids if i.startswith("G")]
    return [lex["entries"][i] for i in ids[:3]]


def lexicon_card(word: str, entries: list) -> dict:
    e = entries[0]
    lang = "Hebrew" if e["id"].startswith("H") else "Greek"
    points = []
    if e["kjv"]:
        points.append(f"Translated in the KJV as: {e['kjv'].rstrip('.')}.")
    if e["derivation"]:
        points.append(f"Origin: {e['derivation'].rstrip(';,. ')}.")
    for extra in entries[1:]:
        points.append(
            f"Also {extra['id']} {extra['lemma']} ({extra['translit']}): {extra['def'][:110]}"
        )
    return {
        "title": f"{e['lemma']}  ·  {e['translit'].capitalize()}",
        "subtitle": f"{lang} · Strong’s {e['id']}" + (f" · “{e['pron']}”" if e["pron"] else ""),
        "body": [e["def"].rstrip(".") + "." if e["def"] else ""],
        "points": points[:4],
        "source": f"Strong’s {lang} Dictionary ({e['id']})",
    }


# ---- Tier 2: AI (Claude and/or Gemini — whichever key the admin connected) ----

# One HTTPS connection per worker thread, kept open between calls.
#
# urllib opens a fresh TCP and TLS connection every time. The ear was measured
# paying ~0.2s for that on every utterance, and more on a slow link; the
# planner pays it too, on every request a preacher makes. Measured on the
# planner: 3.19s on a cold connection against 1.36s warm.
#
# An idle connection is eventually dropped by the far end, so a socket error
# retries once on a fresh one. An HTTP error status is NOT a socket error and
# is raised as-is — callers distinguish 429 from a dropped connection and must
# keep being able to.
_conn_local = threading.local()


def _http_json(req: urllib.request.Request, timeout: float):
    parsed = urllib.parse.urlsplit(req.full_url)
    if parsed.scheme != "https" or req.data is None:
        # Anything unusual takes the plain path. Not worth a special case.
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx) as r:
            return json.loads(r.read().decode("utf-8"))

    path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    pool = getattr(_conn_local, "pool", None)
    if pool is None:
        pool = _conn_local.pool = {}

    for attempt in (1, 2):
        conn = pool.get(parsed.netloc)
        if conn is None:
            conn = http.client.HTTPSConnection(
                parsed.netloc, timeout=timeout, context=_ssl_ctx
            )
            pool[parsed.netloc] = conn
        try:
            conn.request("POST", path, body=req.data, headers=dict(req.headers))
            res = conn.getresponse()
            payload = res.read()
            status, reason, head = res.status, res.reason, res.headers
        except (http.client.HTTPException, OSError):
            try:
                conn.close()
            except Exception:
                pass
            pool.pop(parsed.netloc, None)
            if attempt == 2:
                raise
        else:
            if status >= 400:
                raise urllib.error.HTTPError(
                    req.full_url, status, reason, head, io.BytesIO(payload)
                )
            return json.loads(payload.decode("utf-8"))
    raise RuntimeError("unreachable")


# Whether a subject is religious is not a judgement call the model should be
# making on every request. It got "what does baptism mean" wrong as often as
# right, and the cost of being wrong is a two-line answer where a preacher
# wanted substance. The vocabulary is recognisable, so recognise it here:
# deterministic, instant, free, and testable without a model.
_SPIRITUAL_RE = re.compile(
    r"\b("
    # God, Christ, Spirit
    r"god|godhead|lord|yahweh|jehovah|elohim|jesus|christ|messiah|holy spirit|"
    r"trinity|imana|yezu|kristo|mwuka|dieu|j[eé]sus|christ|esprit|saint[- ]esprit|"
    # scripture and its parts
    r"bible|biblical|scripture|gospel|epistle|psalm|proverb|parable|testament|"
    r"bibiliya|ivanjiri|zaburi|umugani|ecriture|[ée]vangile|psaume|parabole|"
    # doctrine and practice
    r"doctrine|theolog\w*|creed|salvation|saved|grace|faith|sin|repent\w*|"
    r"redemption|atonement|justification|sanctification|resurrection|incarnation|"
    r"covenant|prophec\w*|prophet|apostle|disciple|baptis\w*|communion|eucharist|"
    r"prayer|pray|worship|holiness|righteous\w*|mercy|blessing|heaven|hell|"
    r"angel|demon|satan|devil|soul|spirit\w*|eternal life|kingdom of god|"
    # Pentecostal and church-life vocabulary. "Impartation" was answered as a
    # general English word — two dry lines — when the preacher was asking a
    # theological question of his congregation.
    r"impartation|impart|anoint\w*|deliverance|intercession|consecrat\w*|"
    r"testimony|discipleship|evangelis\w*|fasting|tithe|altar|sabbath|"
    r"tabernacle|priesthood|sacrifice|rapture|tribulation|laying on of hands|"
    r"kwiyeza|gusiga amavuta|ubuhamya|kwiyiriza|kubatiza|"
    r"ubuntu bw imana|agakiza|ubuntu|kwizera|icyaha|kwihana|umusaraba|isengesho|"
    r"gusenga|gusengera|umutagatifu|ubwami bw imana|umubatizo|"
    r"salut|gr[aâ]ce|foi|p[ée]ch[ée]|pri[eè]re|bapt[eê]me|saintet[ée]|"
    # the church and its story
    r"church|churches|congregation|pentecost|reformation|protestant|catholic|"
    r"orthodox|denomination|missionar\w*|revival|itorero|kiliziya|[ée]glise|"
    r"pentec[oô]te|r[ée]forme"
    r")\b",
    re.IGNORECASE,
)


def looks_spiritual(text: str) -> bool:
    return bool(_SPIRITUAL_RE.search(text or ""))


def _mode_section(mode: str, depth: str) -> str:
    """The two registers Emet answers in.

    A question about Christopher Columbus and a question about the Trinity are
    not the same kind of question, and answering both in one voice serves
    neither. Secular subjects want the short true answer; theology wants room."""
    if mode == "spiritual":
        return (
            "This is a question about scripture, doctrine, church history, prayer "
            "or God, and it deserves depth. Give the substance: what the text or "
            "teaching actually says, the historical and cultural setting it came "
            "out of, how the church has understood it, and where sincere "
            "traditions read it differently — named plainly and without taking "
            "sides. Where a Hebrew or Greek word carries the meaning, give the "
            "original, its transliteration and its sense.\n"
            "Write with reverence and without sentimentality. Do not preach — the "
            "preacher is preaching; you are handing them something solid. Do not "
            "flatten a contested question into a slogan, and do not pretend to a "
            "certainty the sources do not have.\n"
        )

    brief = depth != "full"
    return (
        "This is a general question — history, science, language, a person, a "
        "place. Answer it truthfully and on its own terms.\n"
        + (
            "Keep it SHORT: the essential facts only, the things someone would "
            "actually need to know, and nothing else. No throat-clearing, no "
            "padding, no list of everything you know. If the preacher wants more "
            "they will ask.\n"
            if brief else
            "The preacher has asked to go deeper, so give the fuller picture: "
            "background, sequence, significance, and what is still disputed.\n"
        )
        + "Say what the subject actually is: its plain meaning, where it comes "
        "from, what history and scholarship have established, who the notable "
        "figures are, a concrete example.\n"
        "ONLY THEN, and only where a genuine connection exists, add one short "
        "closing point on how it touches scripture or faith — prefixed so it "
        "reads as a separate thought. If a subject has no real biblical "
        "connection, say nothing about the Bible at all. A preacher asking about "
        "psychology, an empire or a scientist wants the true answer, not a "
        "sermon; forcing a religious angle onto it would be wrong and unhelpful.\n"
    )


# How an answer should be pitched: (mode, depth). Carried as one value so the
# provider functions do not each grow two more parameters.
Style = tuple[str, str]
DEFAULT_STYLE: Style = ("auto", "brief")


def _system_prompt(lang: str, mode: str = "auto", depth: str = "brief") -> str:
    lang_name = LANG_NAMES.get(lang, "English")
    return (
        "You are Emet, the study assistant of a church projection system. Your answer "
        "is displayed on the sanctuary screen DURING a live sermon, so be concise, "
        "accurate and dignified.\n\n"
        + _mode_section(mode, depth)
        + "\n"
        "The preacher may be continuing an earlier thread — \"say more about that\", "
        "\"and in Greek?\", \"how does that compare?\". Read the exchange above and "
        "answer the follow-up in its context rather than starting again.\n\n"
        "FORMAT — one field per line, each line beginning with its tag, nothing "
        "else. No markdown, no fences, no XML or internal tags:\n"
        "TITLE: the word, name or subject\n"
        "SUBTITLE: one short qualifying line (part of speech, dates, field, role…)\n"
        "BODY: a short paragraph of real-world explanation, under 220 characters\n"
        "BODY: a second such paragraph (two or three BODY lines in total)\n"
        "POINT: a concrete fact, discovery or example, under 120 characters\n"
        "POINT: up to four in total; the LAST one may begin \"In scripture:\" when "
        "the connection is genuine\n"
        "Write the whole line before moving on — each line is put on the screen as "
        "soon as it is finished.\n"
        f"Write every field in {lang_name}."
    )


def _user_prompt(query: str, kind: str) -> str:
    if kind == "definition":
        return f"Define and explain: {query}"
    if kind == "knowledge":
        return f"Explain: {query}"
    return query


# ---- Turning a stream of text into a card, line by line ----

_LINE_RE = re.compile(r"^\s*(TITLE|SUBTITLE|BODY|POINT)\s*[:：]\s*(.*)$", re.IGNORECASE)
_SLOT_OF = {"TITLE": "title", "SUBTITLE": "subtitle", "BODY": "body", "POINT": "point"}
# Belt and braces: a model told not to emit internal tags occasionally still
# does, and `<thinking>` must never reach the sanctuary screen.
_TAG_RE = re.compile(r"</?[a-zA-Z][^>]{0,40}>")


def _clean(text: str) -> str:
    return _TAG_RE.sub("", text).replace("```", "").strip()


class CardStream:
    """Feeds on model output and emits an event per changed field.

    Each event carries the field's text *so far in full* rather than a delta,
    so a client that drops or reorders one still renders correctly."""

    def __init__(self):
        self.buffer = ""
        self.line_no = 0
        self.open_line = -1
        self.open_slot = ""
        self.open_index = 0
        self.card: dict = {"title": "", "subtitle": "", "body": [], "points": []}
        self.stray: list[str] = []

    def feed(self, chunk: str) -> list[dict]:
        self.buffer += chunk
        events: list[dict] = []
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            event = self._write(line, done=True)
            if event:
                events.append(event)
            self.line_no += 1
        event = self._write(self.buffer, done=False)
        if event:
            events.append(event)
        return events

    def finish(self) -> list[dict]:
        events = self.feed("\n") if self.buffer.strip() else []
        self.buffer = ""
        return events

    def _write(self, raw: str, done: bool) -> dict | None:
        text = raw.strip()
        if not text:
            return None
        match = _LINE_RE.match(text)
        if not match:
            # Stray prose (a preamble, a stray fence). Keep it only as the
            # raw-text rescue for a model that ignored the format entirely.
            if done:
                self.stray.append(text)
            return None

        slot = _SLOT_OF[match.group(1).upper()]
        value = _clean(match.group(2))

        if self.open_line != self.line_no:
            # A new line has begun — give it its place in the card.
            self.open_line = self.line_no
            self.open_slot = slot
            if slot == "body":
                self.open_index = len(self.card["body"])
                self.card["body"].append("")
            elif slot == "point":
                self.open_index = len(self.card["points"])
                self.card["points"].append("")
            else:
                self.open_index = 0
        elif self.open_slot != slot:
            return None  # the tag changed mid-line; wait for the real one

        if slot == "body":
            if self.card["body"][self.open_index] == value and not done:
                return None
            self.card["body"][self.open_index] = value
        elif slot == "point":
            if self.card["points"][self.open_index] == value and not done:
                return None
            self.card["points"][self.open_index] = value
        else:
            if self.card[slot] == value and not done:
                return None
            self.card[slot] = value

        return {
            "type": "slot",
            "slot": slot,
            "index": self.open_index,
            "text": value,
            "done": done,
        }

    def result(self, query: str, source: str) -> dict:
        body = [p for p in self.card["body"] if p]
        points = [p for p in self.card["points"] if p]
        title = self.card["title"]
        if not title and not body:
            # The model answered in prose. Better a plain card than none.
            prose = " ".join(self.stray).strip()
            if not prose:
                return {}
            title, body = query.title(), [prose[:600]]
        return {
            "title": title or query.title(),
            "subtitle": self.card["subtitle"],
            "body": body[:3],
            "points": points[:4],
            "source": source,
        }


# ---- Claude, over the official SDK, streaming ----

_claude_lock = threading.Lock()
_claude: tuple[str, object] | None = None   # (key, client)
# Server-side refusal fallback is a beta; if this deployment's SDK or account
# does not have it, we stop asking rather than failing every answer.
_fallbacks_ok = True


def claude_model() -> str:
    return db.get_setting(con, MODEL_SETTING).strip() or DEFAULT_CLAUDE_MODEL


def claude_key() -> str:
    return db.get_secret(con, ANTHROPIC_KEY_SETTING)


def claude_client(key: str):
    global _claude
    if anthropic is None:
        return None
    with _claude_lock:
        if _claude is None or _claude[0] != key:
            _claude = (
                key,
                anthropic.Anthropic(api_key=key, timeout=60.0, max_retries=1),
            )
        return _claude[1]


def _claude_kwargs(model: str, lang: str, messages: list[dict],
                   style: Style = DEFAULT_STYLE) -> dict:
    kwargs: dict = {
        "model": model,
        "max_tokens": 900,
        "system": [
            {
                "type": "text",
                "text": _system_prompt(lang, *style),
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "messages": messages,
    }
    if _TUNABLE_MODEL.search(model):
        # Thinking is off and effort is low on purpose: this is a short factual
        # card wanted mid-sentence, and every thinking token is silence on the
        # screen. There are no tools in play, so the one real hazard of
        # thinking-off — a tool call written as prose — cannot arise here.
        kwargs["thinking"] = {"type": "disabled"}
        kwargs["output_config"] = {"effort": "low"}
    return kwargs


def claude_text_stream(query: str, kind: str, lang: str, history: list[dict],
                       style: Style = DEFAULT_STYLE):
    """Yield Claude's answer as it is written. Raises on failure."""
    key = claude_key()
    client = claude_client(key)
    if client is None:
        raise RuntimeError("no-claude")

    messages = list(history) + [{"role": "user", "content": _user_prompt(query, kind)}]
    kwargs = _claude_kwargs(claude_model(), lang, messages, style)

    global _fallbacks_ok
    use_fallbacks = _fallbacks_ok
    while True:
        try:
            if use_fallbacks:
                stream = client.beta.messages.stream(
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",
                    **kwargs,
                )
            else:
                stream = client.messages.stream(**kwargs)
            with stream as s:
                for text in s.text_stream:
                    yield text
                final = s.get_final_message()
            if getattr(final, "stop_reason", "") == "refusal":
                raise RuntimeError("claude-refusal")
            return
        except TypeError:
            # This SDK build does not know the parameter — never ask again.
            if not use_fallbacks:
                raise
            _fallbacks_ok = use_fallbacks = False
        except Exception as e:
            if use_fallbacks and _looks_like_unknown_param(e):
                _fallbacks_ok = use_fallbacks = False
                continue
            raise


def _looks_like_unknown_param(e: Exception) -> bool:
    text = str(e).lower()
    return "fallback" in text or "beta" in text


# Google renames/retires models often ("gemini-2.5-flash is no longer
# available to new users") — so ask THEIR key which models it may use and
# pick the best flash model, instead of hardcoding a name.
_gemini_model: str | None = None


def pick_gemini_model(api_key: str, force: bool = False) -> str:
    global _gemini_model
    if _gemini_model and not force:
        return _gemini_model
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
        headers={"x-goog-api-key": api_key, "user-agent": USER_AGENT},
    )
    data = _http_json(req, timeout=10)  # raises on bad key — callers handle
    best, best_score = None, None
    for m in data.get("models", []):
        name = m.get("name", "").split("/")[-1]
        if "generateContent" not in m.get("supportedGenerationMethods", []):
            continue
        vm = re.match(r"gemini-(\d+(?:\.\d+)?)-", name)
        if not vm:
            continue
        version = float(vm.group(1))
        clean = not any(
            k in name for k in ("preview", "exp", "lite", "8b", "thinking",
                                "tts", "image", "audio", "live", "embed")
        )
        is_flash = "flash" in name
        score = (clean, is_flash, version, -len(name))
        if best_score is None or score > best_score:
            best, best_score = name, score
    if best:
        _gemini_model = best
        print(f"[brain] Gemini model selected: {best}")
        return best
    return GEMINI_FALLBACK_MODEL


def _gemini_history(history: list[dict]) -> list[dict]:
    # Gemini calls the assistant "model"; everything else is the same shape.
    return [
        {"role": "model" if m["role"] == "assistant" else "user",
         "parts": [{"text": m["content"]}]}
        for m in history
    ]


# Gemini 3 thinks before it writes anything, and that silence is the whole of
# the delay the preacher feels — six seconds of a blank screen, measured.
# Asking for the shallowest thinking cuts it by about a third. Older models
# reject the field, so a rejection turns it off for good rather than failing.
_gemini_thinking_ok = True


# Google's free tier meters each model separately, and the newest flash has
# the tightest allowance of all — a handful of requests a minute, which a live
# service exhausts immediately. The "lite" models are far roomier. Rather than
# fail, drop to one of those when the good model says 429: a slightly simpler
# answer now beats a correct one the congregation never sees.
_gemini_lite_model: str | None = None


def pick_gemini_lite_model(api_key: str) -> str:
    global _gemini_lite_model
    if _gemini_lite_model:
        return _gemini_lite_model
    try:
        req = urllib.request.Request(
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
            headers={"x-goog-api-key": api_key, "user-agent": USER_AGENT},
        )
        data = _http_json(req, timeout=10)
        best, best_score = None, None
        for m in data.get("models", []):
            name = m.get("name", "").split("/")[-1]
            if "generateContent" not in m.get("supportedGenerationMethods", []):
                continue
            if "lite" not in name or any(
                k in name for k in ("image", "tts", "audio", "embed", "preview")
            ):
                continue
            version = re.match(r"gemini-(\d+(?:\.\d+)?)-", name)
            score = (float(version.group(1)) if version else 0.0, -len(name))
            if best_score is None or score > best_score:
                best, best_score = name, score
        if best:
            _gemini_lite_model = best
            print(f"[brain] Gemini light model: {best}")
            return best
    except Exception as e:
        print(f"[brain] could not pick a relief model: {e}")
    return "gemini-flash-lite-latest"


# Set when a 429 forces the relief model; cleared at the start of each new
# answer so a single bad minute does not pin the church to it for ever.
_gemini_forced_model = [None]


def gemini_text_stream(query: str, kind: str, lang: str, history: list[dict],
                       style: Style = DEFAULT_STYLE):
    """Yield Gemini's answer as it is written. Raises on failure."""
    global _gemini_thinking_ok
    _gemini_forced_model[0] = None
    api_key = db.get_secret(con, GEMINI_KEY_SETTING)
    if not api_key:
        raise RuntimeError("no-gemini")

    def build() -> bytes:
        # Newer Gemini models "think" inside the output budget — give plenty
        # of room or the answer arrives cut off mid-sentence.
        config: dict = {"maxOutputTokens": 4096}
        if _gemini_thinking_ok:
            config["thinkingConfig"] = {"thinkingLevel": "low"}
        return json.dumps({
            "system_instruction": {"parts": [{"text": _system_prompt(lang, *style)}]},
            "contents": _gemini_history(history)
            + [{"role": "user", "parts": [{"text": _user_prompt(query, kind)}]}],
            "generationConfig": config,
        }).encode("utf-8")

    body = build()

    for attempt in (1, 2, 3):
        try:
            model = _gemini_forced_model[0] or pick_gemini_model(api_key)
        except Exception as e:
            print(f"[brain] Gemini model list failed: {e}")
            model = GEMINI_FALLBACK_MODEL
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:streamGenerateContent?alt=sse",
            data=body,
            headers={"content-type": "application/json", "x-goog-api-key": api_key,
                     "user-agent": USER_AGENT},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60, context=_ssl_ctx) as r:
                for raw in r:               # server-sent events, one per line
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if not chunk or chunk == "[DONE]":
                        continue
                    try:
                        data = json.loads(chunk)
                        parts = data["candidates"][0]["content"]["parts"]
                    except Exception:
                        continue
                    text = "".join(p.get("text", "") for p in parts)
                    if text:
                        yield text
            return
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read().decode("utf-8")).get("error", {}).get("message", "")
            except Exception:
                pass
            print(f"[brain] Gemini HTTP {e.code}: {detail}")
            if e.code == 404 and attempt < 3:
                # The cached model went away — rediscover and retry.
                pick_gemini_model(api_key, force=True)
                continue
            if e.code == 400 and _gemini_thinking_ok and attempt < 3:
                # This model does not take a thinking level. Stop asking.
                print("[brain] Gemini: thinkingLevel not supported, disabling")
                _gemini_thinking_ok = False
                body = build()
                continue
            if e.code in (429, 500, 503) and attempt < 3:
                # Google's free tier spikes. A 429 means this model's allowance
                # is spent, so retrying it is pointless — move to the roomier
                # lite model. Anything else is transient; just wait a moment.
                if e.code == 429:
                    _gemini_forced_model[0] = pick_gemini_lite_model(api_key)
                time.sleep(0.6 * attempt)
                continue
            raise
    raise RuntimeError("gemini-failed")


# ---- Choosing a provider and streaming the card ----

def ai_text_stream(query: str, kind: str, lang: str, history: list[dict],
                   style: Style = DEFAULT_STYLE):
    """Stream from whichever AI the admin connected. Claude leads; Gemini
    takes over if there is no Anthropic key or the call fails before a single
    character has been produced. Once text is on the screen we do not switch
    providers mid-answer — half of one answer joined to half of another reads
    like nonsense."""
    providers = []
    if claude_key() and anthropic is not None:
        providers.append(("claude", claude_text_stream))
    if db.get_secret(con, GEMINI_KEY_SETTING):
        providers.append(("gemini", gemini_text_stream))
    if not providers:
        raise RuntimeError("no-ai")

    last_error: Exception | None = None
    for name, fn in providers:
        started = False
        try:
            for text in fn(query, kind, lang, history, style):
                started = True
                yield text
            if started:
                return
        except Exception as e:
            print(f"[brain] {name} stream failed: {e}")
            last_error = e
            if started:
                return  # partial answer already shown — do not restart it
    if last_error:
        raise last_error
    raise RuntimeError("ai-empty")


def ai_card_or_error(query: str, kind: str, lang: str,
                     style: Style = DEFAULT_STYLE) -> tuple[dict | None, Exception | None]:
    """The whole answer, plus why it failed if it did — so the caller can
    tell the operator something true instead of guessing."""
    parser = CardStream()
    try:
        for chunk in ai_text_stream(query, kind, lang, [], style):
            parser.feed(chunk)
        parser.finish()
    except Exception as e:
        return None, e
    return (parser.result(query, "Emet AI") or None), None


def ai_card(query: str, kind: str, lang: str, history: list[dict] | None = None,
            style: Style = DEFAULT_STYLE) -> dict | None:
    """The whole answer at once, for callers that cannot stream."""
    parser = CardStream()
    try:
        for chunk in ai_text_stream(query, kind, lang, history or [], style):
            parser.feed(chunk)
        parser.finish()
    except Exception:
        return None
    card = parser.result(query, "Emet AI")
    return card or None


# ---- Tier 3: Wikipedia + free dictionary ----

def wikipedia_card(query: str, lang: str) -> dict | None:
    order = {"rw": ["rw", "en"], "fr": ["fr", "en"], "en": ["en"]}.get(lang, ["en"])
    for wiki in order:
        url = (
            f"https://{wiki}.wikipedia.org/api/rest_v1/page/summary/"
            + urllib.parse.quote(query.strip().replace(" ", "_"))
            + "?redirect=true"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "EmetAI/1.0"})
        try:
            data = _http_json(req, timeout=6)
        except Exception:
            continue
        extract = data.get("extract", "")
        if not extract or data.get("type") == "disambiguation":
            continue
        paragraphs = [p.strip() for p in extract.split("\n") if p.strip()][:3]
        return {
            "title": data.get("title", query.title()),
            "subtitle": data.get("description", ""),
            "body": paragraphs,
            "points": [],
            "source": f"Wikipedia ({wiki})",
        }
    return None


def dictionary_card(word: str) -> dict | None:
    url = "https://api.dictionaryapi.dev/api/v2/entries/en/" + urllib.parse.quote(word.strip())
    req = urllib.request.Request(url, headers={"User-Agent": "EmetAI/1.0"})
    try:
        data = _http_json(req, timeout=6)
    except Exception:
        return None
    if not isinstance(data, list) or not data:
        return None
    entry = data[0]
    phonetic = entry.get("phonetic", "")
    body, points = [], []
    for meaning in entry.get("meanings", [])[:2]:
        pos = meaning.get("partOfSpeech", "")
        defs = meaning.get("definitions", [])
        if defs:
            body.append(f"({pos}) {defs[0].get('definition', '')}")
            ex = defs[0].get("example")
            if ex:
                points.append(f"Example: “{ex}”")
        syns = meaning.get("synonyms", [])[:4]
        if syns:
            points.append("Synonyms: " + ", ".join(syns))
    if not body:
        return None
    return {
        "title": entry.get("word", word).capitalize(),
        "subtitle": phonetic,
        "body": body[:3],
        "points": points[:4],
        "source": "English dictionary",
    }


# ---- The ask pipeline ----

_cache: dict[str, dict] = {}


class AskBody(BaseModel):
    q: str
    kind: str = "auto"       # 'definition' | 'knowledge' | 'auto'
    scope: str = ""          # 'hebrew' | 'greek' | '' — for definitions
    # How to pitch the answer. 'general' keeps it short and factual;
    # 'spiritual' gives theology the room it needs. See _mode_section().
    mode: str = "auto"       # 'general' | 'spiritual' | 'auto'
    depth: str = "brief"     # 'brief' | 'full' — 'full' when asked to expand
    lang: str = "en"         # answer language
    conversationId: str = ""  # thread this answer belongs to
    recall: bool = False      # "go back to what you said about…"


def _open_question(body: AskBody, authorization: str):
    """Everything that must succeed before a single word is produced: the
    session, the plan, and the shape of the question."""
    payload = _require_user(authorization)
    user = con.execute("SELECT * FROM users WHERE id=?", (payload["uid"],)).fetchone()
    if not user:
        raise HTTPException(401, "Account no longer exists.")
    allowed, why = db.within_quota(con, user, "brain_ask")
    if not allowed:
        raise HTTPException(402, why)
    q = body.q.strip()
    if not q:
        raise HTTPException(400, "Empty question.")
    kind = body.kind if body.kind in ("definition", "knowledge") else "auto"
    lang = body.lang if body.lang in LANG_NAMES else "en"
    mode = body.mode if body.mode in ("general", "spiritual") else "auto"
    # A typed "?grace" deserves the same depth as a spoken one, so an
    # unspecified mode is decided from the subject rather than left vague.
    if mode == "auto":
        mode = "spiritual" if looks_spiritual(q) else "general"
    depth = "full" if body.depth == "full" else "brief"
    return user, q, kind, lang, (mode, depth)


def _lexicon_entries(q: str, kind: str, scope: str):
    if kind in ("definition", "auto") and len(q.split()) <= 3:
        return lexicon_lookup(q, scope)
    return []


def _free_card(q: str, kind: str, scope: str, lang: str, entries: list) -> dict | None:
    """What Emet can still answer with no AI, or when the AI is unreachable."""
    if entries:
        # Strong's only ever speaks about scripture, so it is the fallback
        # rather than the lead — otherwise "psychology" comes back as a
        # Bible study — unless the Hebrew or Greek was what was asked for.
        return lexicon_card(q, entries)
    if kind in ("definition", "auto") and len(q.split()) == 1:
        card = dictionary_card(q)
        if card:
            return card
    return wikipedia_card(q, lang)


def _no_answer(error: Exception | None = None) -> str:
    """Say what actually went wrong.

    This used to tell everyone to "check the internet connection", which was a
    guess — and usually a wrong one. The real cause is almost always Google's
    free tier refusing a burst of requests, and telling a preacher their
    internet is broken while they are plainly online destroys their trust in
    everything else the software says."""
    if not (claude_key() or db.get_secret(con, GEMINI_KEY_SETTING)):
        return (
            "Emet has no AI key yet, and the free sources (dictionary + Wikipedia) had "
            "no answer for this. To unlock full AI answers: sign in as the ADMIN account "
            "→ Admin → Emet brain → paste a free Google Gemini key (from "
            "aistudio.google.com)."
        )

    status = getattr(error, "code", None) or getattr(error, "status_code", None)
    text = str(error or "").lower()

    if status == 429 or "rate" in text and "limit" in text or "quota" in text:
        return (
            "The AI is rate-limited right now — Google's free tier only allows a few "
            "questions a minute. Wait about a minute and ask again. To remove the "
            "limit, add a Claude key or a paid Gemini key in Admin → Emet brain."
        )
    if status in (401, 403):
        return (
            "The AI refused the key. Check it in Admin → Emet brain — it may have been "
            "revoked, or it may not be allowed to use this model."
        )
    if status and 500 <= int(status) < 600:
        return (
            "The AI service is having trouble at its end (it returned an error, not a "
            "refusal). This usually clears in a few minutes — try again shortly."
        )
    if isinstance(error, (urllib.error.URLError, TimeoutError, OSError)) or "timed out" in text:
        return (
            "Emet could not reach the AI service. The request never got a reply, so "
            "either this computer is offline or something between here and the "
            "provider is blocking it."
        )
    if error is not None:
        # Something unforeseen. Say so honestly and pass the detail on, rather
        # than inventing a cause.
        return f"The AI could not answer: {str(error)[:160]}"
    return (
        "Emet could not find an answer — the AI returned nothing and the free sources "
        "(dictionary + Wikipedia) had nothing either."
    )


@router.post("/api/brain/ask")
def ask(body: AskBody, authorization: str = Header(default="")):
    user, q, kind, lang, style = _open_question(body, authorization)

    # The style is part of the key: the same subject asked for briefly and
    # asked for in full are two different answers.
    cache_key = f"{kind}|{body.scope}|{lang}|{style}|{q.lower()}"
    if cache_key in _cache:
        # A repeat of the same question costs the church nothing.
        return {"card": _cache[cache_key], "cached": True}
    # Counted server-side, so the quota cannot be avoided by a modified client.
    db.record_usage(user["id"], "brain_ask", kind)

    entries = _lexicon_entries(q, kind, body.scope)
    card = lexicon_card(q, entries) if body.scope in ("hebrew", "greek") and entries else None
    failure: Exception | None = None
    if card is None:
        card, failure = ai_card_or_error(q, kind, lang, style)
    if card is None:
        card = _free_card(q, kind, body.scope, lang, entries)
    if card is None:
        raise HTTPException(404, _no_answer(failure))

    _cache[cache_key] = card
    if len(_cache) > 400:
        _cache.pop(next(iter(_cache)))
    return {"card": card}


# ---- The same answer, streamed as it is written ----
#
# Server-sent events. Every event is one JSON object on a `data:` line:
#
#   {"type":"open",  "conversationId": "...", "recalled": false}
#   {"type":"slot",  "slot":"title"|"subtitle"|"body"|"point",
#                    "index": 0, "text": "...", "done": false}
#   {"type":"done",  "card": {...}, "conversationId": "...", "topic": "..."}
#   {"type":"error", "message": "..."}
#
# A `slot` event carries the field's full text so far, not a delta, so a
# client that misses one still ends up with the right card.

def _sse(event: dict) -> str:
    return "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"


def _card_events(card: dict):
    """Replay a finished card down the same channel as a streamed one, so the
    client has exactly one way to render an answer."""
    if card.get("title"):
        yield {"type": "slot", "slot": "title", "index": 0,
               "text": card["title"], "done": True}
    if card.get("subtitle"):
        yield {"type": "slot", "slot": "subtitle", "index": 0,
               "text": card["subtitle"], "done": True}
    for i, para in enumerate(card.get("body") or []):
        yield {"type": "slot", "slot": "body", "index": i, "text": para, "done": True}
    for i, point in enumerate(card.get("points") or []):
        yield {"type": "slot", "slot": "point", "index": i, "text": point, "done": True}


@router.post("/api/brain/stream")
def ask_stream(body: AskBody, authorization: str = Header(default="")):
    # Authentication, plan and validation are settled here, while a real HTTP
    # status code can still be returned. Once the stream opens the response is
    # a 200 no matter what happens, and failures arrive as an error event.
    user, q, kind, lang, style = _open_question(body, authorization)
    conv_id = conversation.ensure(user["id"], body.conversationId, lang)

    def events():
        yield _sse({"type": "open", "conversationId": conv_id})

        # Already answered in this conversation? Show it again immediately —
        # no model call, no quota, no waiting. This is what "go back to what
        # you said about grace" is for, and it also catches the same question
        # simply being asked twice.
        remembered = conversation.recall(conv_id, q)
        if remembered and (body.recall or remembered["topic"].lower() == q.lower()):
            for event in _card_events(remembered["card"]):
                yield _sse(event)
            yield _sse({"type": "done", "card": remembered["card"],
                        "conversationId": conv_id, "topic": remembered["topic"],
                        "recalled": True})
            return

        if body.recall:
            # Asked to go back to something never covered. Say so plainly
            # rather than silently answering it as a fresh question.
            yield _sse({
                "type": "error",
                "message": f"Emet has not spoken about “{q}” yet in this session.",
            })
            return

        db.record_usage(user["id"], "brain_ask", kind)
        history = conversation.history(conv_id)
        conversation.append(conv_id, "user", _user_prompt(q, kind))

        entries = _lexicon_entries(q, kind, body.scope)
        card = None

        if body.scope in ("hebrew", "greek") and entries:
            card = lexicon_card(q, entries)
        else:
            parser = CardStream()
            produced = False
            failure: Exception | None = None
            try:
                for chunk in ai_text_stream(q, kind, lang, history, style):
                    for event in parser.feed(chunk):
                        produced = True
                        yield _sse(event)
                for event in parser.finish():
                    yield _sse(event)
            except Exception as e:
                print(f"[brain] stream failed: {e}")
                failure = e
            if produced:
                card = parser.result(q, "Emet AI")

        if not card:
            card = _free_card(q, kind, body.scope, lang, entries)
            if card:
                for event in _card_events(card):
                    yield _sse(event)

        if not card:
            yield _sse({"type": "error", "message": _no_answer(failure)})
            return

        conversation.append(
            conv_id, "assistant", _flatten(card), topic=card.get("title", ""), card=card
        )
        yield _sse({"type": "done", "card": card, "conversationId": conv_id,
                    "topic": card.get("title", "")})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # nginx must not sit on the tokens
        },
    )


def _flatten(card: dict) -> str:
    """The card as the model would have written it — this is what goes back
    into the history, so a follow-up sees what was actually answered."""
    lines = [f"TITLE: {card.get('title', '')}"]
    if card.get("subtitle"):
        lines.append(f"SUBTITLE: {card['subtitle']}")
    lines += [f"BODY: {p}" for p in card.get("body") or []]
    lines += [f"POINT: {p}" for p in card.get("points") or []]
    return "\n".join(lines)


# ---- The thread itself ----

@router.get("/api/brain/conversation/{conversation_id}")
def get_conversation(conversation_id: str, authorization: str = Header(default="")):
    payload = _require_user(authorization)
    row = con.execute(
        "SELECT id FROM conversations WHERE id=? AND user_id=?",
        (conversation_id, payload["uid"]),
    ).fetchone()
    if not row:
        raise HTTPException(404, "No such conversation.")
    return {
        "id": conversation_id,
        "topics": conversation.topics(conversation_id),
        "turns": conversation.history(conversation_id, turns=40),
    }


@router.delete("/api/brain/conversation/{conversation_id}")
def end_conversation(conversation_id: str, authorization: str = Header(default="")):
    payload = _require_user(authorization)
    return {"ok": conversation.clear(conversation_id, payload["uid"])}


# ---- Admin: the AI keys ----

class KeyBody(BaseModel):
    key: str = ""
    provider: str = "claude"  # 'claude' | 'gemini'


class ModelBody(BaseModel):
    model: str = ""


@router.post("/api/brain/model")
def set_model(body: ModelBody, authorization: str = Header(default="")):
    """Which Claude model answers. Blank restores the default."""
    _require_admin(authorization)
    model = body.model.strip()
    if model and not re.fullmatch(r"[a-z0-9.\-]{3,60}", model):
        raise HTTPException(400, "That is not a model name.")
    db.set_setting(con, MODEL_SETTING, model)
    return {"ok": True, "model": claude_model()}


def _hint(key: str) -> str:
    return (key[:8] + "…" + key[-4:]) if len(key) > 14 else ("set" if key else "")


@router.get("/api/brain/status")
def brain_status(authorization: str = Header(default="")):
    _require_user(authorization)
    anthropic_key = claude_key()
    gemini_key = db.get_secret(con, GEMINI_KEY_SETTING)
    return {
        "lexicon": True,
        "claude": bool(anthropic_key) and anthropic is not None,
        "keyHint": _hint(anthropic_key),
        "model": claude_model() if anthropic_key else "",
        "sdk": anthropic is not None,
        "gemini": bool(gemini_key),
        "geminiHint": _hint(gemini_key),
        "geminiModel": (_gemini_model or GEMINI_FALLBACK_MODEL) if gemini_key else "",
        "streaming": True,
    }


@router.post("/api/brain/key")
def set_key(body: KeyBody, authorization: str = Header(default="")):
    _require_admin(authorization)
    key = body.key.strip()
    if body.provider == "gemini":
        # Google keys are ~39 chars starting with AIza. The list page only
        # shows the LAST 4 characters — catch that partial-copy mistake, but
        # accept any complete-looking key in case the prefix ever changes.
        if key and (len(key) < 25 or any(c.isspace() for c in key)):
            raise HTTPException(
                400,
                "That looks like only part of the key. In Google AI Studio, use the "
                "copy button (⧉) on the key's row — the full key is ~39 characters "
                "and usually starts with AIza…",
            )
        if key:
            # Verify the key with Google right now, and pick the best model
            # this key is allowed to use — instant, honest feedback.
            try:
                pick_gemini_model(key, force=True)
            except urllib.error.HTTPError as e:
                raise HTTPException(
                    400,
                    f"Google rejected this key (HTTP {e.code}). Copy the FULL key from "
                    "aistudio.google.com → API Keys (use the ⧉ copy button) and try again.",
                )
            except Exception:
                raise HTTPException(
                    502,
                    "Could not reach Google to verify the key — check the internet "
                    "connection and try again.",
                )
        db.set_secret(con, GEMINI_KEY_SETTING, key)
    else:
        if key and not key.startswith("sk-ant-"):
            raise HTTPException(400, "That does not look like an Anthropic API key (sk-ant-…).")
        if anthropic is None and key:
            raise HTTPException(
                503,
                "The Anthropic library is not installed on this server. Run "
                "`pip install -r server/requirements.txt` and restart EmetAI.",
            )
        db.set_secret(con, ANTHROPIC_KEY_SETTING, key)
        global _claude
        _claude = None  # the cached client belongs to the old key
    return {
        "ok": True,
        "claude": bool(claude_key()),
        "gemini": bool(db.get_secret(con, GEMINI_KEY_SETTING)),
    }
