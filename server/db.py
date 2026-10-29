# EmetAI database layer — one API, two engines.
#
#   PostgreSQL  when DATABASE_URL is set   → the hosted service (5000+ churches)
#   SQLite      otherwise                  → a church laptop running standalone
#
# Call sites use "?" placeholders everywhere; they are rewritten to "%s" for
# PostgreSQL. Connections are per-thread (FastAPI runs handlers in a threadpool
# and neither driver's connections are safe to share across threads).

import json
import os
import re
import sqlite3
import threading
import time
import uuid

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DATA_DIR, "emetai.db")
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))

# ---------------------------------------------------------------- schema ----
# Written in SQLite dialect; _for_engine() translates types for PostgreSQL.

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    church TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'church',      -- 'church' | 'assistant' | 'admin'
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    plan TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_active ON subscriptions(status, expires_at);

CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    plan TEXT NOT NULL,
    payer_ref TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payreq_status ON payment_requests(status, created_at);

CREATE TABLE IF NOT EXISTS clip_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    url TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    progress TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON clip_jobs(user_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

-- Revocable server-side sessions. A bearer token is only accepted while its
-- session row is alive, so "sign out everywhere" and admin revocation are real.
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);

-- One-time email codes: login 2FA, address verification, password reset.
CREATE TABLE IF NOT EXISTS email_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_codes_user ON email_codes(user_id, purpose, used);

-- Every security- and money-relevant action, for the admin's review.
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL DEFAULT '',
    actor_email TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at);

-- How churches actually use the product (engagement reporting).
CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    day TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_events(day);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_event ON usage_events(event, day);

-- Devices the user chose to trust, so the second factor is not demanded in
-- the middle of a Sunday service on the same laptop.
CREATE TABLE IF NOT EXISTS trusted_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON trusted_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_hash ON trusted_devices(token_hash);

-- Login attempts, kept in the database so throttling survives a restart.
CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    ok INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_email ON login_attempts(email, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_ip ON login_attempts(ip, created_at);

-- One-time codes that get someone back in when the second factor itself is
-- gone: a lost phone, a flat battery, an email that will not arrive. These
-- are what make two-factor safe to REQUIRE — without them, enforcing it
-- would eventually lock a church out of its own Sunday service.
CREATE TABLE IF NOT EXISTS recovery_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL,
    used_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id, used_at);

-- What Emet and the preacher have already said to each other. This is what
-- lets a follow-up ("say more about that", "and in Hebrew?") mean anything,
-- and what lets the preacher jump back to a subject from earlier in the
-- sermon without asking for it again.
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT 'en',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);

-- One row per turn. `topic` is the subject the turn settled on and `card` is
-- the rendered answer, so "go back to psychology" can be served from here
-- instantly instead of asking the model the same question twice.
CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    card TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_convmsg_conv ON conversation_messages(conversation_id, seq);

-- ------------------------------------------------------------- learning ----
-- EmetAI cannot get better at hearing a particular church without a record of
-- what it heard there and what it got wrong. These three tables are that
-- record, and the ear reads back from them on the next service.

-- One row per service. Everything heard is filed under one of these so a
-- Sunday can be reviewed, exported, or thrown away as a unit.
CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    ear TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL DEFAULT 0,
    lines INTEGER NOT NULL DEFAULT 0,
    corrections INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_services_user ON services(user_id, started_at);

-- Every final transcript line, and what EmetAI did with it. This is the raw
-- material for review after the service: without it "it got that wrong" is an
-- impression, with it it is a row we can act on.
CREATE TABLE IF NOT EXISTS service_lines (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    heard TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',   -- detected | projected | command | answer | ignored
    result TEXT NOT NULL DEFAULT '',   -- the reference or card title, if any
    score REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_lines ON service_lines(service_id, seq);

-- What the ear should have heard. Two kinds of row, both learned from the
-- operator rather than guessed:
--   term   — a word EmetAI keeps getting wrong (a name, a place, a book title).
--            These are handed to the ear as a vocabulary hint before it listens.
--   alias  — a specific mishearing mapped to the right words, repaired in the
--            transcript before scripture matching ever sees it.
CREATE TABLE IF NOT EXISTS lexicon (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT '',   -- '' = shipped with EmetAI, shared by all
    kind TEXT NOT NULL DEFAULT 'term',
    heard TEXT NOT NULL DEFAULT '',     -- what came out of the ear (alias only)
    correct TEXT NOT NULL,              -- the right words
    lang TEXT NOT NULL DEFAULT '',
    weight INTEGER NOT NULL DEFAULT 1,  -- how often this has been confirmed
    source TEXT NOT NULL DEFAULT 'seed',-- seed | correction | manual
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lexicon_user ON lexicon(user_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lexicon_unique ON lexicon(user_id, kind, heard, correct);
"""

# Added after v1 shipped; applied to existing databases on startup.
MIGRATIONS = [
    "ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN two_factor TEXT NOT NULL DEFAULT 'email'",
    "ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE users ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN created_by TEXT NOT NULL DEFAULT ''",
    # Who spoke each line — see server/diarize.py.
    "ALTER TABLE service_lines ADD COLUMN speaker TEXT NOT NULL DEFAULT ''",
]


def _for_engine(sql: str) -> str:
    """Translate the SQLite-dialect schema for the active engine."""
    if not IS_PG:
        return sql
    return re.sub(r"\bINTEGER\b", "BIGINT", sql)


_PLACEHOLDER_RE = re.compile(r"'[^']*'|\?")


def _translate(sql: str) -> str:
    """`?` placeholders → `%s` for psycopg (ignoring any inside quoted text),
    and literal `%` escaped, since psycopg treats it as a format character."""
    if not IS_PG:
        return sql
    sql = sql.replace("%", "%%")
    return _PLACEHOLDER_RE.sub(lambda m: m.group(0) if m.group(0).startswith("'") else "%s", sql)


# ----------------------------------------------------------- connections ----

_local = threading.local()


def connect():
    con = getattr(_local, "con", None)
    if con is not None:
        try:  # a pooled/idle connection may have been closed by the server
            if not getattr(con, "closed", False):
                return con
        except Exception:
            pass
    if IS_PG:
        import psycopg
        from psycopg.rows import dict_row

        con = psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=False,
                              connect_timeout=10, sslmode=os.environ.get("PGSSLMODE", "require"))
    else:
        os.makedirs(DATA_DIR, exist_ok=True)
        con = sqlite3.connect(DB_PATH, timeout=30)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        con.execute("PRAGMA foreign_keys=ON")
        con.execute("PRAGMA busy_timeout=30000")
    _local.con = con
    return con


class _Handle:
    """Proxy that always talks to the current thread's connection and speaks
    one SQL dialect to callers regardless of the engine underneath."""

    def execute(self, sql, params=()):
        con = connect()
        try:
            return con.execute(_translate(sql), params)
        except Exception:
            # A failed statement poisons a PostgreSQL transaction — roll back
            # so the next query on this thread is not rejected too.
            try:
                con.rollback()
            except Exception:
                pass
            raise

    def executescript(self, sql):
        con = connect()
        if not IS_PG:
            return con.executescript(sql)
        for statement in _split_statements(sql):
            con.execute(statement)
        con.commit()

    def commit(self):
        return connect().commit()

    def rollback(self):
        return connect().rollback()


def _split_statements(script: str):
    for raw in script.split(";"):
        statement = "\n".join(
            line for line in raw.splitlines() if not line.strip().startswith("--")
        ).strip()
        if statement:
            yield statement


handle = _Handle()


def init(con=None) -> None:
    con = con or handle
    con.executescript(_for_engine(SCHEMA))
    for migration in MIGRATIONS:
        try:
            con.execute(_for_engine(migration))
            con.commit()
        except Exception:
            con.rollback()  # column already exists
    con.commit()
    _grandfather_existing_accounts(con)
    _require_two_factor(con)


def _grandfather_existing_accounts(con) -> None:
    """Accounts that existed before email confirmation was introduced count as
    confirmed. Otherwise the administrator would be asked to confirm an email
    address before being able to connect the service that sends the code."""
    try:
        if get_setting(con, "migration_email_verification") == "done":
            return
        con.execute("UPDATE users SET email_verified=1 WHERE email_verified=0")
        con.commit()
        set_setting(con, "migration_email_verification", "done")
        print("[migration] existing accounts marked as email-confirmed")
    except Exception as e:
        print(f"[migration] could not grandfather accounts: {e}")


def _require_two_factor(con) -> None:
    """Two-factor is no longer optional, so nobody may sit on 'off'.

    Accounts are moved to the emailed code rather than being locked out. They
    still have no recovery codes, so the next sign-in walks them through
    enrolment and they choose for themselves — see accounts.has_second_factor."""
    try:
        if get_setting(con, "migration_require_2fa") == "done":
            return
        con.execute("UPDATE users SET two_factor='email' WHERE two_factor='off'")
        con.commit()
        set_setting(con, "migration_require_2fa", "done")
        print("[migration] two-factor is now required for every account")
    except Exception as e:
        print(f"[migration] could not enforce two-factor: {e}")


def now() -> int:
    return int(time.time())


def new_id() -> str:
    return uuid.uuid4().hex


def today(at: int | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(at if at is not None else now()))


def engine_name() -> str:
    return "postgresql" if IS_PG else "sqlite"


# -------------------------------------------------------------- settings ----
# Values are stored encrypted when they hold a secret (API keys).

def get_setting(con, key: str, default: str = "") -> str:
    row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(con, key: str, value: str) -> None:
    con.execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    con.commit()


def get_secret(con, key: str, default: str = "") -> str:
    import security

    raw = get_setting(con, key, "")
    if not raw:
        return default
    return security.decrypt_secret(raw) or default


def set_secret(con, key: str, value: str) -> None:
    import security

    set_setting(con, key, security.encrypt_secret(value) if value else "")


# ----------------------------------------------------------- audit trail ----

def audit(actor, action: str, target: str = "", detail: str = "", ip: str = "") -> None:
    """Record a security- or money-relevant action. Never raises: an audit
    failure must not break the operation the user asked for."""
    try:
        actor_id = actor_email = ""
        if isinstance(actor, str):
            actor_id = actor
        elif actor is not None:
            actor_id = actor["id"]
            actor_email = actor["email"]
        handle.execute(
            "INSERT INTO audit_log (id, actor_id, actor_email, action, target, detail, ip, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (new_id(), actor_id, actor_email, action, target, detail[:500], ip[:64], now()),
        )
        handle.commit()
    except Exception as e:  # pragma: no cover
        print(f"[audit] could not record {action}: {e}")


def record_usage(user_id: str, event: str, detail: str = "") -> None:
    try:
        handle.execute(
            "INSERT INTO usage_events (id, user_id, event, detail, day, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (new_id(), user_id, event[:60], detail[:200], today(), now()),
        )
        handle.commit()
    except Exception as e:  # pragma: no cover
        print(f"[usage] {event}: {e}")


# --------------------------------------------------------- subscriptions ----

# What each tier may do. `None` means unlimited.
#
#   free  the Word, always — manual search and projection, for ever, at no cost
#   pro   adds the AI ear, "Emet" voice commands and AI answers, plus some clips
#   max   everything, without limits
TIERS = {
    "free": {
        "label": "Free",
        "tagline": "The AI listens — free for ever",
        # EmetAI *is* an AI product: every church hears the ear, whatever it pays.
        "ai": True,
        "brain_asks": 0,
        "clips": 0,
        "features": [
            "AI ear — verses appear as they are spoken",
            "“Emet, John 3:16” hands-free voice commands",
            "Unlimited manual scripture search",
            "Project up to 3 versions side by side",
            "Kinyarwanda, English and French",
        ],
        "missing": ["AI answers (definitions, history)", "Sermon clips"],
    },
    "pro": {
        "label": "Pro",
        "tagline": "The AI answers as well as listens",
        "ai": True,
        "brain_asks": 300,
        "clips": 10,
        "features": [
            "Everything in Free",
            "300 AI answers a month — Hebrew/Greek definitions, history, people",
            "“Emet, define Elohim” straight onto the screen",
            "10 sermon clips a month",
        ],
        "missing": ["Unlimited AI answers", "Unlimited clips"],
    },
    "max": {
        "label": "Max",
        "tagline": "Everything, without limits",
        "ai": True,
        "brain_asks": None,
        "clips": None,
        "features": [
            "Everything in Pro",
            "Unlimited AI answers",
            "Unlimited sermon clips",
            "Priority support",
        ],
        "missing": [],
    },
}

# A plan is a tier plus a billing period. Prices are per period, in USD.
PLANS = {
    "trial":       {"tier": "max", "days": 14,  "price_usd": 0,   "period": "trial",
                    "label": "Free trial"},
    "free":        {"tier": "free", "days": 36500, "price_usd": 0, "period": "forever",
                    "label": "Free"},
    "pro_monthly": {"tier": "pro", "days": 30,  "price_usd": 20,  "period": "monthly",
                    "label": "Pro · monthly"},
    # Yearly is 12.5% off the twelve-month total ($30 off Pro, $60 off Max).
    "pro_yearly":  {"tier": "pro", "days": 365, "price_usd": 210, "period": "yearly",
                    "label": "Pro · yearly"},
    "max_monthly": {"tier": "max", "days": 30,  "price_usd": 40,  "period": "monthly",
                    "label": "Max · monthly"},
    "max_yearly":  {"tier": "max", "days": 365, "price_usd": 420, "period": "yearly",
                    "label": "Max · yearly"},
    # Retired names, kept so existing subscriptions keep working.
    "monthly":     {"tier": "pro", "days": 30,  "price_usd": 20,  "period": "monthly",
                    "label": "Pro · monthly"},
    "yearly":      {"tier": "max", "days": 365, "price_usd": 420, "period": "yearly",
                    "label": "Max · yearly"},
}

PURCHASABLE = ["pro_monthly", "pro_yearly", "max_monthly", "max_yearly"]


def tier_of(con, user) -> str:
    """Which tier this account may use right now. An expired subscription
    falls back to `free` — a church never loses the Word itself."""
    if user["role"] in ("admin", "assistant"):
        return "max"
    sub = active_subscription(con, user["id"])
    if not sub:
        return "free"
    return PLANS.get(sub["plan"], {}).get("tier", "free")


def entitlements(tier: str) -> dict:
    return TIERS.get(tier, TIERS["free"])


def month_bounds(at: int | None = None) -> tuple[str, str]:
    """First and last ISO day of the current calendar month."""
    stamp = time.gmtime(at if at is not None else now())
    first = f"{stamp.tm_year:04d}-{stamp.tm_mon:02d}-01"
    last = f"{stamp.tm_year:04d}-{stamp.tm_mon:02d}-31"
    return first, last


def used_this_month(con, user_id: str, event: str) -> int:
    """How many times the account did something billable this calendar month."""
    first, last = month_bounds()
    row = con.execute(
        "SELECT COUNT(*) c FROM usage_events WHERE user_id=? AND event=? AND day >= ? AND day <= ?",
        (user_id, event, first, last),
    ).fetchone()
    return int(row["c"]) if row else 0


def quota_state(con, user) -> dict:
    """Everything the app needs to show and enforce limits for this account."""
    tier = tier_of(con, user)
    limits = entitlements(tier)
    asks_used = used_this_month(con, user["id"], "brain_ask")
    clips_used = used_this_month(con, user["id"], "clip_created")
    return {
        "tier": tier,
        "label": limits["label"],
        "ai": limits["ai"],
        "brainAsks": {"used": asks_used, "limit": limits["brain_asks"]},
        "clips": {"used": clips_used, "limit": limits["clips"]},
    }


def within_quota(con, user, event: str) -> tuple[bool, str]:
    """Check a billable action before performing it."""
    tier = tier_of(con, user)
    limits = entitlements(tier)
    if event == "brain_ask":
        allowance, what = limits["brain_asks"], "AI answers"
    elif event == "clip_created":
        allowance, what = limits["clips"], "Sermon clips"
    else:
        return True, ""
    if allowance is None:
        return True, ""
    if allowance == 0:
        return False, (
            f"{what} are part of the Pro plan. Upgrade in Account to switch it on."
        )
    used = used_this_month(con, user["id"], event)
    if used >= allowance:
        return False, (
            f"You have used all {allowance} {what.lower()} included this month on the "
            f"{limits['label']} plan. Upgrade to Max for unlimited use, or wait for next month."
        )
    return True, ""


def active_subscription(con, user_id: str):
    """The user's current subscription, or None. Expiry is enforced here:
    the moment expires_at passes, this returns None and the app locks."""
    return con.execute(
        "SELECT * FROM subscriptions WHERE user_id=? AND status='active' "
        "AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
        (user_id, now()),
    ).fetchone()


def grant_subscription(con, user_id: str, plan: str):
    """Grant/extend a plan. Extends from the current expiry if still active,
    otherwise from now."""
    days = PLANS[plan]["days"]
    current = active_subscription(con, user_id)
    starts = current["expires_at"] if current else now()
    sub_id = new_id()
    con.execute(
        "INSERT INTO subscriptions (id, user_id, plan, starts_at, expires_at, status, created_at) "
        "VALUES (?,?,?,?,?, 'active', ?)",
        (sub_id, user_id, plan, starts, starts + days * 86400, now()),
    )
    con.commit()
    return sub_id


def revoke_subscriptions(con, user_id: str) -> None:
    con.execute(
        "UPDATE subscriptions SET status='revoked' WHERE user_id=? AND status='active'",
        (user_id,),
    )
    con.commit()


# --------------------------------------------------------- authorization ----
# Assistants get exactly the powers the admin grants them.

PERMISSIONS = {
    "users.view":        "View churches and their subscription status",
    "users.manage":      "Grant, extend or revoke subscriptions",
    "payments.review":   "Approve or reject Mobile Money payments",
    "reports.view":      "See engagement reports and activity",
    "audit.view":        "Read the audit log",
    "settings.manage":   "Change AI and email keys (sensitive)",
    "assistants.manage": "Create and remove other assistants (sensitive)",
}

ADMIN_ONLY = {"settings.manage", "assistants.manage"}


def permissions_of(user) -> set[str]:
    if user is None:
        return set()
    if user["role"] == "admin":
        return set(PERMISSIONS)
    if user["role"] != "assistant":
        return set()
    try:
        granted = json.loads(user["permissions"] or "[]")
    except Exception:
        granted = []
    return {p for p in granted if p in PERMISSIONS}


def has_permission(user, permission: str) -> bool:
    return permission in permissions_of(user)
