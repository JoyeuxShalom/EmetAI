# EmetAI backend — one process, everything included:
#   accounts + two-factor, subscriptions, admin & reports, sermon clipper, AI ear.
# Run:  cd server && python app.py     (listens on http://127.0.0.1:8765)
# The Vite dev server proxies /api (and the ear websocket) here.

import json
import os
import re
import secrets
import sys
import threading
import time
from contextlib import asynccontextmanager

# The Windows console speaks cp1252, which cannot encode the arrows and curly
# quotes used in our messages — an ordinary log line would then raise inside a
# request handler and return 500. Force UTF-8 and never fail on a console write.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import urllib.error
import urllib.request

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import uvicorn

import accounts
import agent
import analytics
import brain
import clipper
import db
import ear
import learning
import mailer
import security
from accounts import admin_user, current_user, require, user_payload

con = db.handle


def seed_admin():
    row = con.execute("SELECT id FROM users WHERE role='admin' LIMIT 1").fetchone()
    if row:
        return
    password = "Emet-" + secrets.token_urlsafe(9)
    con.execute(
        "INSERT INTO users (id, email, name, church, role, password_hash, created_at, "
        "must_change_password, email_verified, two_factor, permissions, status, last_seen_at, "
        "locked_until, password_changed_at, created_by, totp_secret, totp_enabled) "
        "VALUES (?,?,?,?, 'admin', ?, ?, 1, 1, 'email', '[]', 'active', 0, 0, ?, '', '', 0)",
        (db.new_id(), "admin@emetai.rw", "EmetAI Admin", "EmetAI",
         security.hash_password(password), db.now(), db.now()),
    )
    con.commit()
    creds_path = os.path.join(db.DATA_DIR, "ADMIN_CREDENTIALS.txt")
    with open(creds_path, "w") as f:
        f.write(f"EmetAI admin account\n  email:    admin@emetai.rw\n  password: {password}\n"
                "Log in, change this password, then DELETE this file.\n")
    print("=" * 60)
    print("  First run: admin account created")
    print("  email:    admin@emetai.rw")
    print(f"  password: {password}")
    print(f"  (also saved to {creds_path} — delete after first login)")
    print("=" * 60)


BACKUPS_KEPT = 14


def _backup_database():
    """Keep a fortnight of daily copies of the database.

    A church laptop has no RAID, no snapshots and nobody to notice a failing
    disk. What is in here cannot be recreated: the vocabulary this church
    taught EmetAI, every service it has recorded, the accounts themselves.
    SQLite's own backup API is used rather than copying the file, because
    copying a database that is being written to produces a corrupt copy —
    which is worse than no backup at all, since it looks like one.
    """
    if db.IS_PG:
        return  # a managed PostgreSQL has its own backups; this is for laptops
    folder = os.path.join(db.DATA_DIR, "backups")
    os.makedirs(folder, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d")
    target = os.path.join(folder, f"emetai-{stamp}.db")
    if os.path.exists(target):
        return  # already done today

    import sqlite3

    source = sqlite3.connect(db.DB_PATH)
    try:
        copy = sqlite3.connect(target)
        try:
            source.backup(copy)   # consistent even while the server is writing
        finally:
            copy.close()
    finally:
        source.close()

    old = sorted(f for f in os.listdir(folder) if f.startswith("emetai-"))
    for stale in old[:-BACKUPS_KEPT]:
        try:
            os.remove(os.path.join(folder, stale))
        except OSError:
            pass
    print(f"[backup] {target}")


def _housekeeping():
    """Hourly: drop expired sessions and codes, and keep the backups current."""
    while True:
        try:
            security.purge_expired()
        except Exception as e:
            print(f"[housekeeping] {e}")
        try:
            _backup_database()
        except Exception as e:
            print(f"[backup] failed: {e}")
        time.sleep(3600)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init(con)
    seed_admin()
    # The vocabulary the ear starts life knowing — Bible book names in all
    # three languages plus church vocabulary. Without it the ear is guessing
    # at every proper noun a Rwandan service contains. Idempotent.
    threading.Thread(target=learning.seed, daemon=True).start()
    ear.preload_engines()  # warm the speech models so the first Listen is instant
    threading.Thread(target=brain.get_lexicon, daemon=True).start()  # warm Strong's
    threading.Thread(target=_housekeeping, daemon=True).start()
    print(f"Database: {db.engine_name()}"
          + (" (set DATABASE_URL to use PostgreSQL)" if not db.IS_PG else ""))
    yield


app = FastAPI(title="EmetAI", lifespan=lifespan, docs_url=None, redoc_url=None,
              openapi_url=None)  # no public API surface to enumerate

app.include_router(accounts.router)
app.include_router(analytics.router)
app.include_router(ear.router)
app.include_router(brain.router)
app.include_router(learning.router)
app.include_router(agent.router)


# ---- Hardening ----

CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob:; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
)


@app.exception_handler(RequestValidationError)
async def readable_validation_error(request: Request, exc: RequestValidationError):
    """FastAPI answers a bad field with a list of objects, which the browser can
    only render as "Request failed (422)". Say which field and why instead."""
    friendly = {
        "string_too_long": "is too long",
        "string_too_short": "is too short",
        "string_type": "must be text",
        "missing": "is missing",
        "int_parsing": "must be a number",
    }
    parts = []
    for err in exc.errors():
        field = ".".join(str(p) for p in err.get("loc", ()) if p not in ("body", "query"))
        reason = friendly.get(err.get("type", ""), err.get("msg", "is invalid"))
        parts.append(f"{field or 'The request'} {reason}.")
    detail = " ".join(parts[:3]) or "The request could not be understood."
    print(f"[validation] {request.url.path}: {detail}")
    return JSONResponse(status_code=422, content={"detail": detail})


@app.middleware("http")
async def secure_headers(request: Request, call_next):
    response = await call_next(request)
    headers = response.headers
    headers["Content-Security-Policy"] = CSP
    headers["X-Content-Type-Options"] = "nosniff"
    headers["X-Frame-Options"] = "DENY"
    headers["Referrer-Policy"] = "no-referrer"
    headers["Permissions-Policy"] = "geolocation=(), camera=(), payment=(), microphone=(self)"
    headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if request.url.scheme == "https":
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.url.path.startswith("/api/"):
        # Never let a proxy or browser keep a copy of an authenticated answer.
        headers["Cache-Control"] = "no-store"
    elif "text/html" in headers.get("content-type", ""):
        # The app shell must be revalidated, or browsers pin an old build.
        headers["Cache-Control"] = "no-cache"
    return response


# ---- Subscriptions ----

@app.get("/api/ready")
def readiness():
    """Is EmetAI actually ready to listen yet?

    The speech models take about half a minute to load, and until they have,
    pressing Listen looks broken. The launcher waits on this, and the Studio
    can say so plainly instead of leaving the operator guessing.

    Deliberately unauthenticated and deliberately boring: it reports whether
    things are warm and nothing else — no key hints, no counts, no names. It
    is the one endpoint a church laptop exposes before anyone signs in.
    """
    english = ear.CONFIG["en"][0] in ear._engines
    kinyarwanda = ear.CONFIG["rw"][0] in ear._engines
    remote_warm = bool(getattr(brain, "_gemini_lite_model", ""))

    # A server running lean has no offline models and never will. Waiting for
    # them would leave it reporting "starting up" for ever — which is what the
    # first deployment did, and the launcher would have waited out its whole
    # three-minute window on a server that was ready the entire time.
    if not ear.LOCAL_EARS:
        return {
            "ok": True,
            "ready": True,
            "listening_ready": True,
            "models": {"english": False, "kinyarwanda": False},
            "offline_ears": False,
            "remote_ear_warm": remote_warm,
            "detail": "EmetAI is ready.",
        }

    if english and kinyarwanda:
        detail = "EmetAI is ready."
    elif english or kinyarwanda:
        detail = "Nearly ready - still warming the speech models..."
    else:
        detail = "Starting up - loading the speech models..."

    return {
        "ok": True,
        "ready": english and kinyarwanda,
        "listening_ready": english or kinyarwanda,
        "offline_ears": True,
        "models": {"english": english, "kinyarwanda": kinyarwanda},
        "remote_ear_warm": remote_warm,
        "detail": detail,
    }


@app.get("/api/plans")
def plans():
    """The three tiers, each with its monthly and yearly price."""
    out = []
    for tier_id, tier in db.TIERS.items():
        prices = {
            meta["period"]: {"planId": pid, "priceUsd": meta["price_usd"], "days": meta["days"]}
            for pid, meta in db.PLANS.items()
            if meta["tier"] == tier_id and pid in db.PURCHASABLE
        }
        monthly = prices.get("monthly", {}).get("priceUsd")
        yearly = prices.get("yearly", {}).get("priceUsd")
        out.append({
            "tier": tier_id,
            "label": tier["label"],
            "tagline": tier["tagline"],
            "features": tier["features"],
            "missing": tier["missing"],
            "ai": tier["ai"],
            "brainAsks": tier["brain_asks"],
            "clips": tier["clips"],
            "prices": prices,
            # What a church saves by paying for the whole year at once.
            "yearlySavingUsd": (monthly * 12 - yearly) if monthly and yearly else 0,
            "yearlySavingPercent": (
                round((monthly * 12 - yearly) / (monthly * 12) * 100, 1)
                if monthly and yearly
                else 0
            ),
        })
    return out


@app.get("/api/my-plan")
def my_plan(user=Depends(current_user)):
    """The caller's tier and how much of this month's allowance is left."""
    return db.quota_state(con, user)


class SubscribeBody(BaseModel):
    plan: str = Field(max_length=20)
    payerRef: str = Field(default="", max_length=120)


@app.post("/api/subscriptions/request")
def request_subscription(body: SubscribeBody, request: Request, user=Depends(current_user)):
    if body.plan not in db.PURCHASABLE:
        raise HTTPException(400, "Unknown plan.")
    pending = con.execute(
        "SELECT 1 FROM payment_requests WHERE user_id=? AND status='pending'", (user["id"],)
    ).fetchone()
    if pending:
        raise HTTPException(409, "You already have a pending request — the team is reviewing it.")
    con.execute(
        "INSERT INTO payment_requests (id, user_id, plan, payer_ref, status, created_at) "
        "VALUES (?,?,?,?, 'pending', ?)",
        (db.new_id(), user["id"], body.plan, body.payerRef.strip()[:120], db.now()),
    )
    con.commit()
    db.audit(user, "payment.requested", body.plan, body.payerRef.strip()[:120],
             security.client_ip(request))
    return {"ok": True, "message": "Payment submitted for review — you'll be activated shortly."}


@app.get("/api/subscriptions/my-request")
def my_request(user=Depends(current_user)):
    row = con.execute(
        "SELECT plan, status, created_at FROM payment_requests WHERE user_id=? "
        "ORDER BY created_at DESC LIMIT 1",
        (user["id"],),
    ).fetchone()
    return dict(row) if row else None


# ---- Admin ----

@app.get("/api/admin/stats")
def admin_stats(_staff=Depends(require("users.view"))):
    users = con.execute("SELECT COUNT(*) c FROM users WHERE role='church'").fetchone()["c"]
    active = con.execute(
        "SELECT COUNT(DISTINCT user_id) c FROM subscriptions WHERE status='active' AND expires_at > ?",
        (db.now(),),
    ).fetchone()["c"]
    pending = con.execute(
        "SELECT COUNT(*) c FROM payment_requests WHERE status='pending'"
    ).fetchone()["c"]
    jobs = con.execute("SELECT COUNT(*) c FROM clip_jobs").fetchone()["c"]
    return {"users": users, "activeSubscriptions": active,
            "pendingRequests": pending, "clipJobs": jobs}


@app.get("/api/admin/users")
def admin_users(q: str = "", _staff=Depends(require("users.view"))):
    like = f"%{q.strip().lower()}%"
    rows = con.execute(
        "SELECT * FROM users WHERE role='church' AND (lower(email) LIKE ? OR lower(name) LIKE ? "
        "OR lower(church) LIKE ?) ORDER BY created_at DESC LIMIT 200",
        (like, like, like),
    ).fetchall()
    out = []
    for r in rows:
        sub = db.active_subscription(con, r["id"])
        out.append({
            "id": r["id"], "email": r["email"], "name": r["name"],
            "church": r["church"], "createdAt": r["created_at"],
            "emailVerified": bool(r["email_verified"]), "status": r["status"],
            "lastSeenAt": r["last_seen_at"],
            "subscription": ({"plan": sub["plan"], "expiresAt": sub["expires_at"]} if sub else None),
        })
    return out


class GrantBody(BaseModel):
    userId: str = Field(max_length=64)
    plan: str = Field(max_length=20)


@app.post("/api/admin/subscriptions/grant")
def admin_grant(body: GrantBody, request: Request, staff=Depends(require("users.manage"))):
    if body.plan not in db.PLANS:
        raise HTTPException(400, "Unknown plan.")
    target = con.execute("SELECT email FROM users WHERE id=?", (body.userId,)).fetchone()
    if not target:
        raise HTTPException(404, "User not found.")
    db.grant_subscription(con, body.userId, body.plan)
    db.audit(staff, "subscription.granted", target["email"], body.plan,
             security.client_ip(request))
    return {"ok": True}


class RevokeBody(BaseModel):
    userId: str = Field(max_length=64)


@app.post("/api/admin/subscriptions/revoke")
def admin_revoke(body: RevokeBody, request: Request, staff=Depends(require("users.manage"))):
    target = con.execute("SELECT email FROM users WHERE id=?", (body.userId,)).fetchone()
    db.revoke_subscriptions(con, body.userId)
    db.audit(staff, "subscription.revoked", target["email"] if target else body.userId, "",
             security.client_ip(request))
    return {"ok": True}


class UserStatusBody(BaseModel):
    userId: str = Field(max_length=64)
    status: str = Field(max_length=12)


@app.post("/api/admin/users/status")
def admin_user_status(body: UserStatusBody, request: Request, admin=Depends(admin_user)):
    """Suspend or restore a church account. Suspension ends every session now."""
    if body.status not in ("active", "suspended"):
        raise HTTPException(400, "Unknown status.")
    target = con.execute(
        "SELECT email, role FROM users WHERE id=?", (body.userId,)
    ).fetchone()
    if not target:
        raise HTTPException(404, "User not found.")
    if target["role"] == "admin":
        raise HTTPException(403, "Administrator accounts cannot be suspended here.")
    con.execute("UPDATE users SET status=? WHERE id=?", (body.status, body.userId))
    con.commit()
    if body.status == "suspended":
        security.revoke_all_sessions(body.userId)
        security.forget_devices(body.userId)
    db.audit(admin, f"user.{body.status}", target["email"], "", security.client_ip(request))
    return {"ok": True}


@app.get("/api/admin/requests")
def admin_requests(_staff=Depends(require("payments.review"))):
    rows = con.execute(
        "SELECT pr.*, u.email, u.name, u.church FROM payment_requests pr "
        "JOIN users u ON u.id = pr.user_id WHERE pr.status='pending' ORDER BY pr.created_at"
    ).fetchall()
    return [dict(r) for r in rows]


class ResolveBody(BaseModel):
    approve: bool


@app.post("/api/admin/requests/{req_id}/resolve")
def admin_resolve(req_id: str, body: ResolveBody, request: Request,
                  staff=Depends(require("payments.review"))):
    row = con.execute(
        "SELECT * FROM payment_requests WHERE id=? AND status='pending'", (req_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Request not found or already resolved.")
    status = "approved" if body.approve else "rejected"
    con.execute(
        "UPDATE payment_requests SET status=?, resolved_at=? WHERE id=?",
        (status, db.now(), req_id),
    )
    con.commit()
    if body.approve:
        db.grant_subscription(con, row["user_id"], row["plan"])
    db.audit(staff, f"payment.{status}", row["user_id"], f"{row['plan']} ref={row['payer_ref']}",
             security.client_ip(request))
    return {"ok": True}


# ---- Email delivery settings (administrator only) ----

@app.get("/api/admin/email/status")
def email_status(_staff=Depends(accounts.staff_user)):
    active = mailer.provider()
    key = mailer.api_key(active)
    return {
        "provider": active,
        "configured": bool(key),
        "keyHint": (key[:8] + "…" + key[-4:]) if len(key) > 14 else ("set" if key else ""),
        "from": mailer.sender(),
        "providers": [
            {
                "id": pid,
                "label": spec["label"],
                "keyHint": spec["key_hint"],
                "where": spec["where"],
                "note": spec["note"],
                "configured": bool(mailer.api_key(pid)),
            }
            for pid, spec in mailer.PROVIDERS.items()
        ],
    }


class EmailKeyBody(BaseModel):
    # Generous ceilings: a Resend key is ~36 characters and a sender ~60, so
    # anything within these is a paste worth explaining rather than refusing.
    key: str = Field(default="", max_length=2000)
    fromAddress: str = Field(default="", max_length=300)
    provider: str = Field(default="", max_length=20)
    # Disconnecting is now said out loud rather than implied by an empty key
    # field. It used to be implied, and that made changing the sender address
    # alone impossible: the sender is saved by this same call, so submitting
    # it without re-typing the key silently deleted the key. Providers show an
    # API key exactly once, so "silently deleted" meant "go and make a new
    # one at the provider" — for a typo in an address.
    clear: bool = Field(default=False)


@app.post("/api/admin/email/key")
def set_email_key(body: EmailKeyBody, request: Request, admin=Depends(admin_user)):
    name = body.provider if body.provider in mailer.PROVIDERS else mailer.provider()
    spec = mailer.PROVIDERS[name]
    # Editors and dashboards love to add invisible whitespace around a copy.
    key = "".join(body.key.split())
    warning = None
    if key:
        if not key.startswith(spec["key_prefix"]):
            raise HTTPException(
                400,
                f"A {spec['label']} API key starts with “{spec['key_prefix']}”. Copy just "
                f"the key itself from {spec['where']} — not the surrounding code sample.",
            )
        if len(key) < 20:
            raise HTTPException(400, "That key looks incomplete — copy the whole value.")
        if len(key) > 200:
            raise HTTPException(
                400,
                f"That is {len(key)} characters long, far more than a {spec['label']} key. "
                "It looks like a code sample was pasted — copy only the key value itself.",
            )

    # The sender must be saved before the check, because the check sends a real
    # message and has to use the address the administrator just chose.
    sender = body.fromAddress.strip()
    if sender:
        # Refuse an address that cannot possibly work with this provider,
        # rather than letting it be saved and discovered through five test
        # messages that all report success and none of which arrive.
        bad = mailer.sender_problem(name, sender)
        if bad:
            raise HTTPException(400, bad)
        db.set_setting(con, mailer.FROM_SETTING, sender[:300])

    message = None
    if key:
        # Verify by doing the real thing: send one message to the administrator.
        delivered, status, detail = mailer.probe_key(key, sender, admin["email"], name)
        if not delivered and mailer.key_is_definitely_invalid(status, detail):
            raise HTTPException(
                400,
                f"{spec['label']} rejected the key itself — it replied “{detail}”. Create a "
                f"new key at {spec['where']}, copy it the moment it appears, and paste it here.",
            )
        if delivered:
            message = f"Connected — a test message is on its way to {admin['email']}."
        elif status == 403 and name == "resend":
            warning = (
                f"The key was saved, but Resend refused the send: “{detail}” Resend's shared "
                "sender may only write to the address that owns the Resend account. Verify a "
                "domain at resend.com/domains — or switch to Brevo, which needs only a "
                "validated sender address."
            )
        elif status in (400, 403) and name == "brevo":
            warning = (
                f"The key was saved, but Brevo refused the send: “{detail}” Brevo will only "
                "send from a sender address you have validated — add it under Senders, "
                "click the link Brevo emails you, then set it as the sender address here."
            )
        else:
            warning = (
                f"The key was saved, but {spec['label']} would not send the test message: "
                f"“{detail}” Check the sender address, then use Send test again."
            )

    # Only three things can happen to the stored key: it is replaced, it is
    # deliberately cleared, or it is left exactly as it was. Saving a sender
    # address on its own is the third, and must never be the second.
    if body.clear:
        db.set_secret(con, spec["key_setting"], "")
        what = "cleared"
    elif key:
        db.set_secret(con, spec["key_setting"], key)
        what = "set"
    else:
        what = "sender only"
    db.set_setting(con, mailer.PROVIDER_SETTING, name)
    db.audit(admin, "settings.email_key", name,
             what + (" (send failed)" if warning else ""),
             security.client_ip(request))
    # Whether a key is stored now, not whether one was typed in this request —
    # a sender-only save leaves the existing key in place and must still
    # report the account as configured.
    return {"ok": True, "configured": bool(mailer.api_key(name)), "provider": name,
            "warning": warning, "message": message}


class TestEmailBody(BaseModel):
    to: str = Field(max_length=200)


@app.post("/api/admin/email/test")
def send_test_email(body: TestEmailBody, admin=Depends(admin_user)):
    # An address already stored before this check existed still has to be
    # caught, or the test keeps reporting success and arriving nowhere.
    bad = mailer.sender_problem(mailer.provider(), mailer.sender())
    if bad:
        raise HTTPException(400, bad)
    sent, detail = mailer.send(
        body.to.strip(),
        "EmetAI email is working",
        mailer._shell("Email is working",
                      "This is a test message from your EmetAI server. Verification codes "
                      "and sign-in codes will arrive like this.", ""),
        "EmetAI test message — email delivery is working.",
    )
    if not sent:
        raise HTTPException(400, f"Could not send: {detail}")
    return {"ok": True}


# ---- Sermon clipper ----

YOUTUBE_RE = re.compile(r"^https?://(www\.|m\.)?(youtube\.com|youtu\.be)/", re.I)


class ClipJobBody(BaseModel):
    url: str = Field(max_length=500)
    clipSeconds: int = 120
    count: int = 3
    format: str = "original"   # 'original' | 'vertical'
    language: str = "auto"     # 'auto' | 'rw' | 'en' | 'fr'
    mode: str = "clips"        # 'clips' | 'full' | 'both'


@app.post("/api/clips/jobs")
def create_clip_job(body: ClipJobBody, user=Depends(current_user)):
    allowed, why = db.within_quota(con, user, "clip_created")
    if not allowed:
        raise HTTPException(402, why)
    url = body.url.strip()
    if not YOUTUBE_RE.match(url):
        raise HTTPException(400, "Paste a YouTube link (youtube.com or youtu.be).")
    if not (60 <= body.clipSeconds <= 300):
        raise HTTPException(400, "Clip length must be between 60 and 300 seconds.")
    running = con.execute(
        "SELECT COUNT(*) c FROM clip_jobs WHERE user_id=? AND status NOT IN ('done','error')",
        (user["id"],),
    ).fetchone()["c"]
    if running >= 2:
        raise HTTPException(429, "You already have jobs running — wait for them to finish.")

    job_id = db.new_id()
    params = {
        "clip_seconds": body.clipSeconds,
        "count": body.count,
        "format": body.format if body.format in ("original", "vertical") else "original",
        "language": body.language if body.language in ("auto", "rw", "en", "fr") else "auto",
        "mode": body.mode if body.mode in ("clips", "full", "both") else "clips",
    }
    con.execute(
        "INSERT INTO clip_jobs (id, user_id, url, params, created_at) VALUES (?,?,?,?,?)",
        (job_id, user["id"], url, json.dumps(params), db.now()),
    )
    con.commit()
    db.record_usage(user["id"], "clip_created")
    clipper.worker.submit(job_id)
    return {"id": job_id}


def _job_view(r) -> dict:
    return {
        "id": r["id"], "url": r["url"], "status": r["status"],
        "progress": r["progress"], "error": r["error"],
        "params": json.loads(r["params"]), "clips": json.loads(r["result"]),
        "createdAt": r["created_at"],
    }


@app.get("/api/clips/jobs")
def list_clip_jobs(user=Depends(current_user)):
    rows = con.execute(
        "SELECT * FROM clip_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 30",
        (user["id"],),
    ).fetchall()
    return [_job_view(r) for r in rows]


@app.get("/api/clips/jobs/{job_id}")
def get_clip_job(job_id: str, user=Depends(current_user)):
    r = con.execute(
        "SELECT * FROM clip_jobs WHERE id=? AND user_id=?", (job_id, user["id"])
    ).fetchone()
    if not r:
        raise HTTPException(404, "Job not found.")
    return _job_view(r)


@app.get("/api/clips/jobs/{job_id}/transcript")
def clip_transcript(job_id: str, user=Depends(current_user)):
    """Caption lines for the edit panel (word timings stay server-side)."""
    r = con.execute(
        "SELECT 1 FROM clip_jobs WHERE id=? AND user_id=?", (job_id, user["id"])
    ).fetchone()
    if not r:
        raise HTTPException(404, "Job not found.")
    path = os.path.join(clipper.CLIPS_DIR, job_id, "transcript.json")
    if not os.path.exists(path):
        raise HTTPException(404, "This job was made before editing existed — run it again to edit.")
    with open(path, encoding="utf-8") as f:
        segments = json.load(f)
    return [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in segments]


class CaptionLine(BaseModel):
    start: float
    end: float
    text: str = Field(max_length=400)


class EditClipBody(BaseModel):
    start: float
    end: float
    captions: list[CaptionLine] = Field(default_factory=list, max_length=2000)


@app.post("/api/clips/jobs/{job_id}/clips/{index}/edit")
def edit_clip(job_id: str, index: int, body: EditClipBody, user=Depends(current_user)):
    r = con.execute(
        "SELECT * FROM clip_jobs WHERE id=? AND user_id=?", (job_id, user["id"])
    ).fetchone()
    if not r:
        raise HTTPException(404, "Job not found.")
    if r["status"] != "done":
        raise HTTPException(409, "Wait for the job to finish first.")
    clips = json.loads(r["result"])
    if not any(c["index"] == index and index > 0 for c in clips):
        raise HTTPException(404, "Clip not found (the full video is not editable this way).")
    if not (5 <= body.end - body.start <= 600):
        raise HTTPException(400, "A clip must be between 5 seconds and 10 minutes long.")
    source = os.path.join(clipper.CLIPS_DIR, job_id, "source.mp4")
    if not os.path.exists(source):
        raise HTTPException(409, "The source video is gone — run the job again to edit.")
    threading.Thread(
        target=clipper.reclip,
        args=(job_id, index, body.start, body.end, [c.model_dump() for c in body.captions]),
        daemon=True,
    ).start()
    return {"ok": True}


@app.delete("/api/clips/jobs/{job_id}")
def delete_clip_job(job_id: str, user=Depends(current_user)):
    r = con.execute(
        "SELECT * FROM clip_jobs WHERE id=? AND user_id=?", (job_id, user["id"])
    ).fetchone()
    if not r:
        raise HTTPException(404, "Job not found.")
    if r["status"] not in ("done", "error"):
        raise HTTPException(409, "Job is still running.")
    con.execute("DELETE FROM clip_jobs WHERE id=?", (job_id,))
    con.commit()
    clipper.delete_job_files(job_id)
    return {"ok": True}


@app.get("/api/clips/jobs/{job_id}/file/{name}")
def download_clip(job_id: str, name: str, token: str = ""):
    # Token comes as a query param so <video>/<a download> tags can use it.
    payload = security.verify_token(token)
    if not payload:
        raise HTTPException(401, "Sign in again.")
    r = con.execute(
        "SELECT * FROM clip_jobs WHERE id=? AND user_id=?", (job_id, payload["uid"])
    ).fetchone()
    if not r:
        raise HTTPException(404, "Job not found.")
    if not re.match(r"^(clip_\d+|full)\.mp4$", name):
        raise HTTPException(400, "Bad file name.")
    path = os.path.join(clipper.CLIPS_DIR, job_id, name)
    if not os.path.exists(path):
        raise HTTPException(404, "Clip not found.")
    return FileResponse(path, media_type="video/mp4", filename=f"emetai_{name}")


# ---- Standalone app mode ----
# When the frontend has been built (npm run build -> ../dist), this backend
# serves it directly: one process = the whole product. Double-click EmetAI.bat.

@app.get("/yv/{path:path}")
def yv_proxy(path: str, request: Request):
    """YouVersion passthrough (replaces the Vite dev proxy in standalone mode)."""
    url = f"https://api.youversion.com/{path}"
    if request.url.query:
        url += "?" + request.url.query
    req = urllib.request.Request(
        url, headers={"X-YVP-App-Key": request.headers.get("x-yvp-app-key", "")}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return Response(content=r.read(), media_type=r.headers.get("Content-Type"))
    except urllib.error.HTTPError as e:
        return Response(status_code=e.code)
    except Exception:
        return Response(status_code=502)


DIST_DIR = os.path.join(os.path.dirname(__file__), "..", "dist")
if os.path.isdir(DIST_DIR):
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")


if __name__ == "__main__":
    served = " + app" if os.path.isdir(DIST_DIR) else ""
    # A church laptop binds to localhost — nothing outside the machine should
    # be able to reach it. In a container it must bind to every interface or
    # the reverse proxy in front of it cannot connect at all, which is the
    # commonest way a deployed server looks "up" and answers nothing.
    host = os.environ.get("EMETAI_HOST", "127.0.0.1").strip() or "127.0.0.1"
    # Trust forwarded headers only from the proxy. Trusting them from anywhere
    # would let a caller claim any IP they liked, and the rate limiter and the
    # audit log both believe that field.
    trusted = os.environ.get("EMETAI_TRUSTED_PROXY", "127.0.0.1").strip()
    print(f"EmetAI backend on http://{host}:8765  (API + AI ear + clipper{served})")
    uvicorn.run(app, host=host, port=8765,
                proxy_headers=True, forwarded_allow_ips=trusted)
