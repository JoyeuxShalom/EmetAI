# The agent layer: the master switch, and the planner behind it.
#
# ── Why there are two paths, not one ────────────────────────────────────────
# Almost everything a preacher says mid-sermon is one of a few dozen commands —
# "next verse", "John 3:16", "clear the screen". `src/lib/wakeWord.ts` matches
# those in about twenty milliseconds, offline, and it must keep doing so: a
# congregation notices a two-second pause between the words and the wall.
#
# This module is for the rest. "Show me verses about faith in Kinyarwanda and
# English side by side" is three actions and a topical lookup, and no regex is
# going to cover the shape of every sentence a preacher might invent. So the
# deterministic parser runs first and the model is asked only when it comes up
# empty — the fast path stays fast, and the flexible path is there when it is
# needed.
#
# The planner does NOT touch the UI itself. It returns an ordered list of
# actions and the browser executes them (src/lib/agent.ts). That keeps every
# state change in one place, keeps the model unable to invent an operation the
# app does not have, and makes the whole thing testable without a browser.

import json
import re

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

import accounts
import brain
import db
import security

router = APIRouter()
con = db.handle

VOICE_SETTING = "voice_agent_enabled"


# ---------------------------------------------------------- master switch ----
# The voice pipeline and everything downstream of it stay dormant until an
# administrator turns them on. This is checked on the ear websocket and on the
# planner endpoint — never only in the UI, because a hidden button is not a
# control, it is a suggestion.

def voice_enabled() -> bool:
    return db.get_setting(con, VOICE_SETTING, "off") == "on"


def require_voice_enabled() -> None:
    if not voice_enabled():
        raise HTTPException(
            503,
            "The voice assistant is switched off. An administrator can turn it on "
            "in Admin → Settings → Voice assistant.",
        )


@router.get("/api/voice/status")
def voice_status(user=Depends(accounts.current_user)):
    """Readable by anyone signed in — the Studio needs it to decide whether the
    Listen button does anything."""
    has_key = bool(brain.claude_key() or db.get_secret(con, brain.GEMINI_KEY_SETTING))
    entitled = user["role"] in ("admin", "assistant") or db.tier_of(con, user) == "max"
    return {
        "enabled": voice_enabled(),
        "canToggle": "settings.manage" in db.permissions_of(user),
        # The Studio only reaches for the planner when both are true.
        "agent": has_key and entitled,
        "agentEntitled": entitled,
    }


class ToggleBody(BaseModel):
    enabled: bool


@router.post("/api/voice/toggle")
def voice_toggle(body: ToggleBody, request: Request,
                 user=Depends(accounts.require("settings.manage"))):
    db.set_setting(con, VOICE_SETTING, "on" if body.enabled else "off")
    db.audit(user, "voice.toggled", user["email"],
             "on" if body.enabled else "off", security.client_ip(request))
    return {"ok": True, "enabled": voice_enabled()}


# ----------------------------------------------------------- the planner ----

# The most recent provider failure, so a refusal can be explained honestly
# rather than blamed on a missing key.
_last_planner_error: Exception | None = None

# Everything the agent is allowed to do. The browser refuses anything not on
# this list, so a confused — or manipulated — model cannot reach further into
# the application than these four verbs.
ACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "say": {
            "type": "string",
            "description": "One short line for the operator's screen, in the language spoken.",
        },
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["versions", "verses", "control", "answer"],
                    },
                    "ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "versions: translation ids, in the order to display them.",
                    },
                    "refs": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "verses: references in English book names, e.g. 'Hebrews 11:1'.",
                    },
                    "action": {
                        "type": "string",
                        "description": "control: one of the named screen controls.",
                    },
                    "query": {"type": "string", "description": "answer: the subject to explain."},
                    "mode": {"type": "string", "enum": ["general", "spiritual"]},
                    "depth": {"type": "string", "enum": ["brief", "full"]},
                },
                "required": ["type"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["say", "actions"],
    "additionalProperties": False,
}

# Everything the operator's hands can do, and every screen they can open. The
# agent is meant to reach all of it — that is what "like Alexa" means here.
CONTROLS = [
    # the wall
    "next", "prev", "blank", "golive", "again",
    # the service list
    "queue", "queueClear", "queueNext",
    # translations on screen
    "showPrimary", "hidePrimary",
    # how detections behave
    "auto", "suggest",
    # windows and the ear
    "display", "stop", "listen",
    # moving about the app
    "goStudio", "goAccount", "goAdmin", "goClips", "goPlans",
]

# What each one does, so the planner picks the right verb instead of guessing
# from the name.
CONTROL_HELP = {
    "next": "show the next verse", "prev": "show the previous verse",
    "blank": "clear the wall", "golive": "project what is staged",
    "again": "put the last verse back up",
    "queue": "add what is showing to the service list",
    "queueClear": "empty the service list",
    "queueNext": "present the next item from the list",
    "showPrimary": "reveal the first translation",
    "hidePrimary": "hide the first translation",
    "auto": "project detections without asking",
    "suggest": "stage detections for the operator instead",
    "display": "open the projector window",
    "stop": "stop listening", "listen": "start listening",
    "goStudio": "go to the Studio", "goAccount": "open the account page",
    "goAdmin": "open the admin page", "goClips": "open sermon clips",
    "goPlans": "open the plans and pricing",
}

# Kept in step with src/data/bible.ts. The planner is told the ids because
# "Kinyarwanda and English side by side" has to become ["by", "kjv"].
TRANSLATIONS = [
    ("by", "Bibiliya Yera", "Kinyarwanda"),
    ("kjv", "King James Version", "English"),
    ("web", "World English Bible", "English"),
    ("asv", "American Standard Version", "English"),
    ("basicenglish", "Bible in Basic English", "English (simple)"),
    ("ls1910", "Louis Segond 1910", "French"),
    ("martin", "Martin 1744", "French"),
    ("yv-niv", "New International Version", "English (online)"),
    ("yv-bds", "La Bible du Semeur", "French (online)"),
]


def _planner_prompt(showing: str, versions: list[str]) -> str:
    catalogue = "\n".join(f"  {vid} — {name} ({lang})" for vid, name, lang in TRANSLATIONS)
    return (
        "You turn what a preacher just said into actions for a church projection "
        "system. You are not talking to the preacher; you are operating the "
        "software for them, mid-sermon, in front of a congregation.\n\n"
        f"On the wall right now: {showing or 'nothing'}\n"
        f"Translations currently displayed, in order: {', '.join(versions) or 'none'}\n\n"
        "Translations you may choose from:\n" + catalogue + "\n\n"
        "Controls available — every button the operator has, and every screen "
        "they can open:\n"
        + "\n".join(f"  {name} — {what}" for name, what in CONTROL_HELP.items())
        + "\n\n"
        "Return an ordered list of actions:\n"
        '  {"type":"versions","ids":[…]}  set which translations show, in order. '
        "Use this for any request to show languages side by side.\n"
        '  {"type":"verses","refs":["Hebrews 11:1",…]}  put these on the wall. The '
        "first is projected, the rest are queued. Give references with ENGLISH book "
        "names and normal numbering; the app translates them into whichever "
        "translations are displayed, so never repeat a reference per language.\n"
        '  {"type":"control","action":"…"}  one of the controls listed above.\n'
        '  {"type":"answer","query":"…","mode":"general|spiritual","depth":"brief|full"}  '
        "explain something.\n"
        "      mode is NOT a guess about tone — it decides how much room the "
        "answer gets, so choose it deliberately:\n"
        "        spiritual — anything to do with God, scripture, a doctrine, a "
        "creed, prayer, worship, salvation, the church or its history. The "
        "Trinity, grace, baptism, the incarnation, Pentecost, the Reformation, "
        "a parable, a Hebrew or Greek word: all spiritual.\n"
        "        general  — everything else: history, science, geography, "
        "language, an explorer, an empire, a medical term.\n"
        "      A subject that is religious ALWAYS takes 'spiritual', even when "
        "the preacher asks casually.\n"
        "      depth is 'brief' unless the preacher asked to go deeper, expand, "
        "or hear more.\n\n"
        "RULES\n"
        "- Asked for verses ABOUT a subject? Choose the passages yourself — the "
        "best known and most apt, at most five — and list them as refs.\n"
        "- Asked for a language, set the translations first, then the verses.\n"
        "- Do only what was asked. An aside in a sermon is not an instruction; if "
        "nothing was actually being asked of the software, return no actions at all.\n"
        "- 'say' is one short line for the operator, in the language the preacher "
        "spoke, naming what you did."
    )


class PlanBody(BaseModel):
    transcript: str = Field(max_length=600)
    showing: str = Field(default="", max_length=200)
    versions: list[str] = Field(default_factory=list, max_length=6)
    lang: str = Field(default="en", max_length=5)


def _clean_plan(raw: dict) -> dict:
    """Keep only what the app can actually carry out.

    The model is a planner, not a privileged caller: anything unrecognised is
    dropped here rather than handed to the browser to puzzle over."""
    known_versions = {vid for vid, _, _ in TRANSLATIONS}
    actions = []
    for item in (raw.get("actions") or [])[:8]:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "versions":
            ids = [i for i in (item.get("ids") or []) if i in known_versions][:3]
            if ids:
                actions.append({"type": "versions", "ids": ids})
        elif kind == "verses":
            refs = [str(r)[:60] for r in (item.get("refs") or []) if str(r).strip()][:5]
            if refs:
                actions.append({"type": "verses", "refs": refs})
        elif kind == "control":
            if item.get("action") in CONTROLS:
                actions.append({"type": "control", "action": item["action"]})
        elif kind == "answer":
            query = str(item.get("query") or "").strip()[:200]
            if query:
                # The model's choice is accepted when it says "spiritual", and
                # overruled when it says "general" about a plainly religious
                # subject. Erring towards depth is the right way to be wrong
                # here: a fuller answer about grace is never a failure, a
                # two-line one is.
                spiritual = item.get("mode") == "spiritual" or brain.looks_spiritual(query)
                actions.append({
                    "type": "answer",
                    "query": query,
                    "mode": "spiritual" if spiritual else "general",
                    "depth": "full" if item.get("depth") == "full" else "brief",
                })
    return {"say": str(raw.get("say") or "")[:160], "actions": actions}


def _plan_with_claude(prompt: str, transcript: str) -> dict | None:
    key = brain.claude_key()
    client = brain.claude_client(key) if key else None
    if client is None:
        return None
    try:
        message = client.messages.create(
            model=brain.claude_model(),
            max_tokens=700,
            system=[{"type": "text", "text": prompt, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": transcript}],
            # A plan is a control signal, not prose: a schema means the browser
            # never has to guess what came back.
            output_config={"format": {"type": "json_schema", "schema": ACTION_SCHEMA}},
            **({"thinking": {"type": "disabled"}}
               if brain._TUNABLE_MODEL.search(brain.claude_model()) else {}),
        )
        text = "".join(b.text for b in message.content if getattr(b, "type", "") == "text")
        return json.loads(text)
    except Exception as e:
        print(f"[agent] Claude planning failed: {e}")
        global _last_planner_error
        _last_planner_error = e
        return None


def _plan_with_gemini(prompt: str, transcript: str) -> dict | None:
    global _last_planner_error
    api_key = db.get_secret(con, brain.GEMINI_KEY_SETTING)
    if not api_key:
        return None
    import urllib.error
    import urllib.request

    payload = {
        "system_instruction": {"parts": [{"text": prompt}]},
        "contents": [{"role": "user", "parts": [{"text": transcript}]}],
        "generationConfig": {
            "maxOutputTokens": 2048,
            "responseMimeType": "application/json",
            "responseSchema": _gemini_schema(ACTION_SCHEMA),
            "thinkingConfig": {"thinkingLevel": "low"},
        },
    }
    # Google's free tier throws 429s and 503s under load. A command that
    # silently does nothing mid-service is the worst possible outcome, so a
    # transient refusal is retried rather than dropped.
    import time

    for attempt in (1, 2, 3):
        try:
            # Planning is a small, tightly-constrained job: pick from a fixed
            # list of verbs and fill a schema. Measured on this key, the lite
            # model returns IDENTICAL plans in 1-2s where the heavyweight took
            # 1.4-10.4s — and it has a far roomier free-tier allowance, so it
            # also stops the 429s. Answers still use the better model; only the
            # planning does not need it.
            model = (
                brain.pick_gemini_model(api_key)
                if attempt > 1
                else brain.pick_gemini_lite_model(api_key)
            )
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                data=json.dumps(payload).encode("utf-8"),
                headers={"content-type": "application/json", "x-goog-api-key": api_key,
                         "user-agent": brain.USER_AGENT},
                method="POST",
            )
            data = brain._http_json(req, timeout=25)
            parts = data["candidates"][0]["content"]["parts"]
            return json.loads("".join(p.get("text", "") for p in parts))
        except urllib.error.HTTPError as e:
            print(f"[agent] Gemini planning HTTP {e.code} (attempt {attempt})")
            # Remember it even while retrying: if every attempt fails, this is
            # what lets the operator be told "rate-limited" rather than the
            # useless "returned nothing".
            _last_planner_error = e
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(0.7 * attempt)
                continue
            return None
        except Exception as e:
            print(f"[agent] Gemini planning failed: {e}")
            return None
    return None


def _gemini_schema(schema: dict) -> dict:
    """Gemini's schema dialect is a subset: it rejects additionalProperties and
    wants uppercase type names."""
    out = {}
    for key, value in schema.items():
        if key == "additionalProperties":
            continue
        if key == "type":
            out["type"] = value.upper()
        elif key == "properties":
            out["properties"] = {k: _gemini_schema(v) for k, v in value.items()}
        elif key == "items":
            out["items"] = _gemini_schema(value)
        else:
            out[key] = value
    return out


def plan(transcript: str, showing: str, versions: list[str]) -> dict:
    """Work out what to do. On failure, say WHY.

    This used to report every failure as "no AI is connected", which sent an
    administrator off to re-paste a key that was never the problem — the usual
    cause is Google's free tier refusing a burst. A configuration message for a
    rate limit is worse than no message at all."""
    prompt = _planner_prompt(showing, versions)
    has_key = bool(brain.claude_key() or db.get_secret(con, brain.GEMINI_KEY_SETTING))
    if not has_key:
        return {"say": "", "actions": [], "error": "no-key"}

    global _last_planner_error
    _last_planner_error = None
    raw = _plan_with_claude(prompt, transcript) or _plan_with_gemini(prompt, transcript)
    if raw is None:
        return {"say": "", "actions": [], "error": "failed"}
    return _clean_plan(raw)


@router.post("/api/voice/plan")
def voice_plan(body: PlanBody, authorization: str = Header(default="")):
    require_voice_enabled()
    payload = brain._require_user(authorization)
    user = con.execute("SELECT * FROM users WHERE id=?", (payload["uid"],)).fetchone()
    if not user:
        raise HTTPException(401, "Account no longer exists.")

    # The autonomous agent belongs to staff and to Max. Everyone keeps the
    # instant spoken commands — those cost nothing and run in the browser —
    # but having a model decide what the software should do next is the
    # feature Max pays for.
    if user["role"] not in ("admin", "assistant") and db.tier_of(con, user) != "max":
        raise HTTPException(
            402,
            "Hands-free control of the whole app is part of the Max plan. Spoken "
            "commands like “next verse”, “John 3:16” and “clear the screen” keep "
            "working on your plan — open Account to see Max.",
        )

    # Planning costs a model call, so it is metered exactly like an AI answer.
    allowed, why = db.within_quota(con, user, "brain_ask")
    if not allowed:
        raise HTTPException(402, why)

    transcript = re.sub(r"\s+", " ", body.transcript).strip()
    if len(transcript) < 3:
        return {"say": "", "actions": []}

    db.record_usage(user["id"], "brain_ask", "agent_plan")
    result = plan(transcript, body.showing, body.versions)
    if result.get("error") == "no-key":
        raise HTTPException(
            503,
            "No AI is connected, so Emet cannot work out compound requests. Add a "
            "Gemini or Claude key in Admin → Emet brain.",
        )
    if result.get("error") == "failed":
        # A key IS connected — this is the provider refusing or falling over,
        # and saying otherwise sends the administrator to re-paste a key that
        # was never at fault. brain._no_answer() already knows how to name a
        # rate limit, a rejected key and an outage apart.
        raise HTTPException(503, brain._no_answer(_last_planner_error))
    return result
