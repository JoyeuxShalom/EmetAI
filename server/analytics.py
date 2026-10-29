# EmetAI engagement reporting — how churches actually use the product, and a
# complete audit trail of what staff did. Every query here is portable between
# SQLite and PostgreSQL (days are stored as ISO text, which sorts correctly).

import time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

import db
import security
from accounts import admin_user, current_user, require

router = APIRouter()
con = db.handle

# Events the Studio is allowed to report. Anything else is ignored, so a
# tampered client cannot fill the table with junk.
ALLOWED_EVENTS = {
    "verse_shown", "card_shown", "ear_start", "ear_stop", "wake_command",
    "brain_ask", "quote_matched", "queue_used", "display_opened", "service_started",
}

EVENT_LABELS = {
    "login": "Sign-ins",
    "verse_shown": "Verses projected",
    "card_shown": "Definitions projected",
    "ear_start": "Listening sessions",
    "wake_command": "Voice commands",
    "brain_ask": "AI questions",
    "quote_matched": "Quotes recognised",
    "queue_used": "Queue used",
    "display_opened": "Projector opened",
    "service_started": "Services started",
    "clip_created": "Sermon clips",
}


def _day_offset(days: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(db.now() - days * 86400))


def _count(sql: str, params: tuple = ()) -> int:
    row = con.execute(sql, params).fetchone()
    return int(row["c"]) if row and row["c"] is not None else 0


# ---------------------------------------------------- reporting from the app

class EventBatch(BaseModel):
    events: list[str] = Field(default_factory=list, max_length=50)
    detail: str = Field(default="", max_length=200)


@router.post("/api/usage")
def report_usage(body: EventBatch, user=Depends(current_user)):
    """The Studio posts what happened in the service, in small batches."""
    accepted = 0
    for name in body.events[:50]:
        if name in ALLOWED_EVENTS:
            db.record_usage(user["id"], name, body.detail)
            accepted += 1
    return {"ok": True, "accepted": accepted}


# ------------------------------------------------------------ the overview --

@router.get("/api/admin/reports/overview")
def overview(_staff=Depends(require("reports.view"))):
    today, week, month = _day_offset(0), _day_offset(7), _day_offset(30)
    now = db.now()

    churches = _count("SELECT COUNT(*) c FROM users WHERE role='church'")
    verified = _count("SELECT COUNT(*) c FROM users WHERE role='church' AND email_verified=1")
    active_subs = _count(
        "SELECT COUNT(DISTINCT user_id) c FROM subscriptions "
        "WHERE status='active' AND expires_at > ?", (now,)
    )
    trials = _count(
        "SELECT COUNT(DISTINCT user_id) c FROM subscriptions "
        "WHERE status='active' AND plan='trial' AND expires_at > ?", (now,)
    )
    expiring = _count(
        "SELECT COUNT(DISTINCT user_id) c FROM subscriptions WHERE status='active' "
        "AND expires_at > ? AND expires_at < ?", (now, now + 7 * 86400)
    )

    # Engagement counts CHURCHES only — staff sign-ins must not inflate it.
    active_sql = (
        "SELECT COUNT(DISTINCT e.user_id) c FROM usage_events e "
        "JOIN users u ON u.id = e.user_id WHERE u.role='church' AND e.day >= ?"
    )
    daily = _count(active_sql, (today,))
    weekly = _count(active_sql, (week,))
    monthly = _count(active_sql, (month,))

    # 30-day trend: one row per day, churches active and events recorded.
    series_rows = con.execute(
        "SELECT e.day day, COUNT(DISTINCT e.user_id) users, COUNT(*) events "
        "FROM usage_events e JOIN users u ON u.id = e.user_id "
        "WHERE u.role='church' AND e.day >= ? GROUP BY e.day ORDER BY e.day", (month,)
    ).fetchall()
    by_day = {r["day"]: {"users": int(r["users"]), "events": int(r["events"])} for r in series_rows}
    series = []
    for back in range(29, -1, -1):
        day = _day_offset(back)
        point = by_day.get(day, {"users": 0, "events": 0})
        series.append({"day": day, **point})

    feature_rows = con.execute(
        "SELECT e.event event, COUNT(*) c, COUNT(DISTINCT e.user_id) u FROM usage_events e "
        "JOIN users u2 ON u2.id = e.user_id WHERE u2.role='church' AND e.day >= ? "
        "GROUP BY e.event ORDER BY c DESC LIMIT 12", (month,)
    ).fetchall()
    features = [
        {
            "event": r["event"],
            "label": EVENT_LABELS.get(r["event"], r["event"].replace("_", " ").capitalize()),
            "count": int(r["c"]),
            "churches": int(r["u"]),
        }
        for r in feature_rows
    ]

    new_month = _count(
        "SELECT COUNT(*) c FROM users WHERE role='church' AND created_at > ?", (now - 30 * 86400,)
    )
    # Retention: of the churches that joined 8–30 days ago, how many used the
    # product in the last week?
    cohort = _count(
        "SELECT COUNT(*) c FROM users WHERE role='church' AND created_at BETWEEN ? AND ?",
        (now - 30 * 86400, now - 7 * 86400),
    )
    retained = _count(
        "SELECT COUNT(DISTINCT u.id) c FROM users u JOIN usage_events e ON e.user_id = u.id "
        "WHERE u.role='church' AND u.created_at BETWEEN ? AND ? AND e.day >= ?",
        (now - 30 * 86400, now - 7 * 86400, week),
    )

    return {
        "churches": churches,
        "verifiedChurches": verified,
        "activeSubscriptions": active_subs,
        "trials": trials,
        "expiringThisWeek": expiring,
        "pendingRequests": _count(
            "SELECT COUNT(*) c FROM payment_requests WHERE status='pending'"
        ),
        "clipJobs": _count("SELECT COUNT(*) c FROM clip_jobs"),
        "activeToday": daily,
        "activeThisWeek": weekly,
        "activeThisMonth": monthly,
        "newChurchesThisMonth": new_month,
        "retentionRate": round(100 * retained / cohort) if cohort else None,
        "retentionCohort": cohort,
        "series": series,
        "features": features,
        "engine": db.engine_name(),
    }


@router.get("/api/admin/reports/churches")
def church_activity(q: str = "", sort: str = "activity",
                    _staff=Depends(require("reports.view"))):
    """Per-church engagement over the last 30 days."""
    month = _day_offset(30)
    like = f"%{q.strip().lower()}%"
    rows = con.execute(
        "SELECT id, email, name, church, created_at, last_seen_at, email_verified, status "
        "FROM users WHERE role='church' AND (lower(email) LIKE ? OR lower(name) LIKE ? "
        "OR lower(church) LIKE ?) ORDER BY created_at DESC LIMIT 500",
        (like, like, like),
    ).fetchall()

    counts = con.execute(
        "SELECT user_id, event, COUNT(*) c FROM usage_events WHERE day >= ? GROUP BY user_id, event",
        (month,),
    ).fetchall()
    per_user: dict[str, dict[str, int]] = {}
    for r in counts:
        per_user.setdefault(r["user_id"], {})[r["event"]] = int(r["c"])

    active_days = con.execute(
        "SELECT user_id, COUNT(DISTINCT day) d FROM usage_events WHERE day >= ? GROUP BY user_id",
        (month,),
    ).fetchall()
    days_map = {r["user_id"]: int(r["d"]) for r in active_days}

    out = []
    for r in rows:
        events = per_user.get(r["id"], {})
        sub = db.active_subscription(con, r["id"])
        out.append({
            "id": r["id"],
            "email": r["email"],
            "name": r["name"],
            "church": r["church"],
            "createdAt": r["created_at"],
            "lastSeenAt": r["last_seen_at"],
            "emailVerified": bool(r["email_verified"]),
            "status": r["status"],
            "activeDays": days_map.get(r["id"], 0),
            "totalEvents": sum(events.values()),
            "versesShown": events.get("verse_shown", 0),
            "voiceCommands": events.get("wake_command", 0),
            "aiQuestions": events.get("brain_ask", 0),
            "listeningSessions": events.get("ear_start", 0),
            "subscription": (
                {"plan": sub["plan"], "expiresAt": sub["expires_at"]} if sub else None
            ),
        })

    if sort == "recent":
        out.sort(key=lambda x: x["lastSeenAt"], reverse=True)
    elif sort == "new":
        out.sort(key=lambda x: x["createdAt"], reverse=True)
    else:
        out.sort(key=lambda x: (x["totalEvents"], x["activeDays"]), reverse=True)
    return out[:200]


@router.get("/api/admin/reports/church/{user_id}")
def church_detail(user_id: str, _staff=Depends(require("reports.view"))):
    user = con.execute(
        "SELECT id, email, name, church, created_at, last_seen_at FROM users WHERE id=?",
        (user_id,),
    ).fetchone()
    if not user:
        return {"error": "not found"}
    rows = con.execute(
        "SELECT day, COUNT(*) c FROM usage_events WHERE user_id=? AND day >= ? "
        "GROUP BY day ORDER BY day", (user_id, _day_offset(60)),
    ).fetchall()
    events = con.execute(
        "SELECT event, COUNT(*) c FROM usage_events WHERE user_id=? AND day >= ? "
        "GROUP BY event ORDER BY c DESC", (user_id, _day_offset(60)),
    ).fetchall()
    return {
        "user": {
            "id": user["id"], "email": user["email"], "name": user["name"],
            "church": user["church"], "createdAt": user["created_at"],
            "lastSeenAt": user["last_seen_at"],
        },
        "days": [{"day": r["day"], "events": int(r["c"])} for r in rows],
        "events": [
            {
                "event": r["event"],
                "label": EVENT_LABELS.get(r["event"], r["event"].replace("_", " ").capitalize()),
                "count": int(r["c"]),
            }
            for r in events
        ],
    }


# ------------------------------------------------------------- audit trail --

@router.get("/api/admin/audit")
def audit_log(q: str = "", limit: int = 100, _staff=Depends(require("audit.view"))):
    limit = max(1, min(limit, 500))
    like = f"%{q.strip().lower()}%"
    rows = con.execute(
        "SELECT * FROM audit_log WHERE lower(action) LIKE ? OR lower(actor_email) LIKE ? "
        "OR lower(target) LIKE ? ORDER BY created_at DESC LIMIT ?",
        (like, like, like, limit),
    ).fetchall()
    return [
        {
            "id": r["id"], "actor": r["actor_email"] or r["actor_id"] or "system",
            "action": r["action"], "target": r["target"], "detail": r["detail"],
            "ip": r["ip"], "createdAt": r["created_at"],
        }
        for r in rows
    ]


@router.get("/api/admin/sessions")
def all_sessions(_admin=Depends(admin_user)):
    """Everyone currently signed in — the admin's view of live access."""
    rows = con.execute(
        "SELECT s.id, s.ip, s.user_agent, s.created_at, s.last_seen_at, "
        "u.email, u.name, u.church, u.role FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.revoked=0 AND s.expires_at > ? ORDER BY s.last_seen_at DESC LIMIT 200",
        (db.now(),),
    ).fetchall()
    return [
        {
            "id": r["id"], "email": r["email"], "name": r["name"], "church": r["church"],
            "role": r["role"], "ip": r["ip"], "device": r["user_agent"][:140],
            "createdAt": r["created_at"], "lastSeenAt": r["last_seen_at"],
        }
        for r in rows
    ]


class RevokeSessionBody(BaseModel):
    sessionId: str = Field(default="", max_length=64)
    userId: str = Field(default="", max_length=64)


@router.post("/api/admin/sessions/revoke")
def revoke_session(body: RevokeSessionBody, request: Request, admin=Depends(admin_user)):
    if body.sessionId:
        con.execute("UPDATE sessions SET revoked=1 WHERE id=?", (body.sessionId,))
        con.commit()
        db.audit(admin, "session.revoked", body.sessionId, "", security.client_ip(request))
    elif body.userId:
        security.revoke_all_sessions(body.userId)
        security.forget_devices(body.userId)
        db.audit(admin, "session.revoked_all", body.userId, "", security.client_ip(request))
    return {"ok": True}
