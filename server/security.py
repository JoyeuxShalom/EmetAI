# EmetAI security primitives.
#
#   Passwords   Argon2id (OWASP first choice), scrypt fallback, legacy PBKDF2
#               verified and transparently upgraded on next sign-in.
#   Sessions    opaque 256-bit tokens; only their SHA-256 hash is stored, so a
#               database leak cannot be replayed. Revocable at any moment.
#   Codes       6-digit email codes, hashed, single-use, expiring, rate-limited.
#   Secrets     API keys encrypted at rest with AES-256-GCM.
#   Throttling  per-email and per-IP, persisted, with progressive lockout.

import base64
import hashlib
import hmac
import os
import secrets
import struct
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import db

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
SECRET_PATH = os.path.join(DATA_DIR, "secret.key")

SESSION_TTL_SECONDS = 12 * 3600          # a full service day
SESSION_IDLE_SECONDS = 4 * 3600          # …but an untouched session dies sooner
CODE_TTL_SECONDS = 10 * 60
CODE_MAX_ATTEMPTS = 5

# Throttling: how many failures before a lockout, and for how long.
MAX_FAILURES_EMAIL = 5
MAX_FAILURES_IP = 20
FAILURE_WINDOW = 15 * 60
LOCKOUT_STEPS = [60, 300, 900, 3600]     # progressive: 1m, 5m, 15m, 1h

try:
    from argon2 import PasswordHasher
    from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

    # OWASP baseline: 19 MiB memory, 2 passes, 1 lane.
    _argon2 = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1,
                             hash_len=32, salt_len=16)
except Exception:  # pragma: no cover - argon2 not installed
    _argon2 = None


# ------------------------------------------------------------ master key ----

def _secret() -> bytes:
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(SECRET_PATH):
        # Written 0600 so other accounts on the machine cannot read it.
        fd = os.open(SECRET_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(secrets.token_bytes(64))
    with open(SECRET_PATH, "rb") as f:
        return f.read()


def _derive(purpose: str, length: int = 32) -> bytes:
    """HKDF-style expansion, so each purpose gets an independent key."""
    return hmac.new(_secret(), f"emetai:{purpose}".encode(), hashlib.sha256).digest()[:length]


# ------------------------------------------------------------- passwords ----

def hash_password(password: str) -> str:
    if _argon2 is not None:
        return _argon2.hash(password)
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**15, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time where it matters, and tolerant of every historical format."""
    if not stored:
        return False
    try:
        if stored.startswith("$argon2"):
            if _argon2 is None:
                return False
            try:
                _argon2.verify(stored, password)
                return True
            except (VerifyMismatchError, VerificationError, InvalidHashError):
                return False
        if stored.startswith("scrypt$"):
            _algo, salt, digest = stored.split("$")
            candidate = hashlib.scrypt(
                password.encode(), salt=bytes.fromhex(salt), n=2**15, r=8, p=1, dklen=32
            )
            return hmac.compare_digest(candidate.hex(), digest)
        if stored.startswith("pbkdf2$"):  # accounts created before the upgrade
            _algo, iters, salt, digest = stored.split("$")
            candidate = hashlib.pbkdf2_hmac(
                "sha256", password.encode(), bytes.fromhex(salt), int(iters)
            ).hex()
            return hmac.compare_digest(candidate, digest)
    except Exception:
        return False
    return False


def needs_rehash(stored: str) -> bool:
    """True when the stored hash uses an older/weaker scheme than we now use."""
    if _argon2 is not None:
        if not stored.startswith("$argon2"):
            return True
        try:
            return _argon2.check_needs_rehash(stored)
        except Exception:
            return True
    return stored.startswith("pbkdf2$")


# The handful of passwords attackers try first. A church laptop in a public
# hall is a realistic threat model, so these are refused outright.
_COMMON = {
    "password", "password1", "password123", "passw0rd", "12345678", "123456789",
    "1234567890", "qwerty123", "iloveyou", "welcome1", "admin123", "letmein1",
    "jesus123", "church123", "amen1234", "godisgood", "hallelujah", "emetai123",
    "abcd1234", "changeme", "trustno1", "sunshine1", "football1", "monkey123",
}


def password_ok(password: str, email: str = "") -> str | None:
    """Return an error message, or None if the password is acceptable."""
    if len(password) < 10:
        return "Password must be at least 10 characters."
    if len(password) > 200:
        return "Password is too long."
    if not any(c.isupper() for c in password):
        return "Include at least one uppercase letter."
    if not any(c.islower() for c in password):
        return "Include at least one lowercase letter."
    if not any(c.isdigit() for c in password):
        return "Include at least one number."
    lowered = password.lower()
    if lowered in _COMMON or lowered.rstrip("!@#$%^&*.") in _COMMON:
        return "That password is too common — please choose another."
    if len(set(password)) < 5:
        return "That password repeats too few characters."
    local = email.split("@")[0].lower() if email else ""
    if local and len(local) >= 4 and local in lowered:
        return "Password must not contain your email address."
    return None


# -------------------------------------------------------------- sessions ----

def _hash_token(token: str) -> str:
    return hmac.new(_derive("session"), token.encode(), hashlib.sha256).hexdigest()


def create_session(user_id: str, ip: str = "", user_agent: str = "") -> str:
    token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    at = db.now()
    db.handle.execute(
        "INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, "
        "expires_at, ip, user_agent, revoked) VALUES (?,?,?,?,?,?,?,?,0)",
        (db.new_id(), user_id, _hash_token(token), at, at,
         at + SESSION_TTL_SECONDS, ip[:64], user_agent[:200]),
    )
    # Signing in counts as being seen; otherwise a fresh session would look
    # idle in the admin's reports until its first heartbeat an hour later.
    db.handle.execute("UPDATE users SET last_seen_at=? WHERE id=?", (at, user_id))
    db.handle.commit()
    return token


def verify_token(token: str) -> dict | None:
    """Resolve a bearer token to its live session. Returns None when the token
    is unknown, expired, idle too long, revoked, or the account is suspended."""
    if not token or len(token) < 20:
        return None
    try:
        row = db.handle.execute(
            "SELECT s.id sid, s.user_id, s.expires_at, s.last_seen_at, s.revoked, "
            "u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash=?",
            (_hash_token(token),),
        ).fetchone()
    except Exception:
        return None
    if not row or row["revoked"]:
        return None
    at = db.now()
    if row["expires_at"] < at or (at - row["last_seen_at"]) > SESSION_IDLE_SECONDS:
        return None
    if row["status"] != "active":
        return None
    if at - row["last_seen_at"] > 60:  # keep the write rate sane
        try:
            db.handle.execute(
                "UPDATE sessions SET last_seen_at=? WHERE id=?", (at, row["sid"])
            )
            db.handle.execute("UPDATE users SET last_seen_at=? WHERE id=?", (at, row["user_id"]))
            db.handle.commit()
        except Exception:
            pass
    return {"uid": row["user_id"], "role": row["role"], "sid": row["sid"]}


TRUSTED_DEVICE_DAYS = 30


def trust_device(user_id: str, label: str = "") -> str:
    token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    at = db.now()
    db.handle.execute(
        "INSERT INTO trusted_devices (id, user_id, token_hash, label, created_at, "
        "last_used_at, expires_at) VALUES (?,?,?,?,?,?,?)",
        (db.new_id(), user_id, _hash_token(token), label[:120], at, at,
         at + TRUSTED_DEVICE_DAYS * 86400),
    )
    db.handle.commit()
    return token


def device_is_trusted(user_id: str, token: str) -> bool:
    """True when this browser previously passed the second factor and the user
    asked to be remembered. Does not weaken the password check."""
    if not token:
        return False
    row = db.handle.execute(
        "SELECT id, expires_at FROM trusted_devices WHERE user_id=? AND token_hash=?",
        (user_id, _hash_token(token)),
    ).fetchone()
    if not row or row["expires_at"] < db.now():
        return False
    db.handle.execute("UPDATE trusted_devices SET last_used_at=? WHERE id=?", (db.now(), row["id"]))
    db.handle.commit()
    return True


def forget_devices(user_id: str) -> None:
    db.handle.execute("DELETE FROM trusted_devices WHERE user_id=?", (user_id,))
    db.handle.commit()


def revoke_session(token: str) -> None:
    db.handle.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (_hash_token(token),))
    db.handle.commit()


def revoke_all_sessions(user_id: str, keep_session_id: str = "") -> int:
    cur = db.handle.execute(
        "UPDATE sessions SET revoked=1 WHERE user_id=? AND revoked=0 AND id <> ?",
        (user_id, keep_session_id),
    )
    db.handle.commit()
    return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


def purge_expired() -> None:
    """Housekeeping: drop dead sessions, used codes and stale attempt records."""
    at = db.now()
    try:
        db.handle.execute("DELETE FROM sessions WHERE expires_at < ?", (at - 86400,))
        db.handle.execute("DELETE FROM email_codes WHERE expires_at < ?", (at - 86400,))
        db.handle.execute("DELETE FROM login_attempts WHERE created_at < ?", (at - 7 * 86400,))
        db.handle.execute("DELETE FROM trusted_devices WHERE expires_at < ?", (at,))
        db.handle.commit()
    except Exception as e:  # pragma: no cover
        print(f"[security] purge skipped: {e}")


# ----------------------------------------------------------- email codes ----

def _hash_code(user_id: str, purpose: str, code: str) -> str:
    return hmac.new(
        _derive("emailcode"), f"{user_id}:{purpose}:{code}".encode(), hashlib.sha256
    ).hexdigest()


def issue_code(user_id: str, purpose: str) -> str:
    """Create a single-use 6-digit code. Any earlier code for this purpose is
    invalidated, so only the newest email works."""
    db.handle.execute(
        "UPDATE email_codes SET used=1 WHERE user_id=? AND purpose=? AND used=0",
        (user_id, purpose),
    )
    code = f"{secrets.randbelow(1_000_000):06d}"
    at = db.now()
    db.handle.execute(
        "INSERT INTO email_codes (id, user_id, purpose, code_hash, created_at, expires_at, "
        "attempts, used) VALUES (?,?,?,?,?,?,0,0)",
        (db.new_id(), user_id, purpose, _hash_code(user_id, purpose, code), at,
         at + CODE_TTL_SECONDS),
    )
    db.handle.commit()
    return code


def check_code(user_id: str, purpose: str, code: str) -> bool:
    code = (code or "").strip().replace(" ", "").replace("-", "")
    if len(code) != 6 or not code.isdigit():
        return False
    row = db.handle.execute(
        "SELECT * FROM email_codes WHERE user_id=? AND purpose=? AND used=0 "
        "ORDER BY created_at DESC LIMIT 1",
        (user_id, purpose),
    ).fetchone()
    if not row:
        return False
    if row["expires_at"] < db.now() or row["attempts"] >= CODE_MAX_ATTEMPTS:
        db.handle.execute("UPDATE email_codes SET used=1 WHERE id=?", (row["id"],))
        db.handle.commit()
        return False
    ok = hmac.compare_digest(row["code_hash"], _hash_code(user_id, purpose, code))
    db.handle.execute(
        "UPDATE email_codes SET attempts=attempts+1, used=? WHERE id=?",
        (1 if ok else 0, row["id"]),
    )
    db.handle.commit()
    return ok


def code_cooldown(user_id: str, purpose: str, seconds: int = 45) -> int:
    """Seconds the caller must wait before another code may be sent (0 = now)."""
    row = db.handle.execute(
        "SELECT created_at FROM email_codes WHERE user_id=? AND purpose=? "
        "ORDER BY created_at DESC LIMIT 1",
        (user_id, purpose),
    ).fetchone()
    if not row:
        return 0
    return max(0, seconds - (db.now() - row["created_at"]))


# --------------------------------------------------------- recovery codes ----
# The way back in when the second factor itself is unavailable — a lost phone,
# a code that will not arrive. Ten one-time codes, shown once at enrolment and
# never again, stored only as HMACs. These are what make it safe to *require*
# two-factor: without them, enforcing it eventually locks someone out of their
# own software with no remedy.

RECOVERY_CODE_COUNT = 10


def _hash_recovery(user_id: str, code: str) -> str:
    return hmac.new(
        _derive("recovery"), f"{user_id}:{code}".encode(), hashlib.sha256
    ).hexdigest()


def _clean_recovery(code: str) -> str:
    return "".join(c for c in (code or "").lower() if c.isalnum())


def new_recovery_codes(user_id: str, count: int = RECOVERY_CODE_COUNT) -> list[str]:
    """Replace every unused code with a fresh set. Returned in the clear once;
    after this call the plaintext exists nowhere on the server."""
    db.handle.execute("DELETE FROM recovery_codes WHERE user_id=?", (user_id,))
    # Crockford-style alphabet: no O/0, I/1 or L to mistype off a printout.
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    codes = []
    at = db.now()
    for _ in range(count):
        raw = "".join(secrets.choice(alphabet) for _ in range(10))
        codes.append(f"{raw[:5]}-{raw[5:]}")
        db.handle.execute(
            "INSERT INTO recovery_codes (id, user_id, code_hash, used_at, created_at) "
            "VALUES (?,?,?,0,?)",
            (db.new_id(), user_id, _hash_recovery(user_id, raw), at),
        )
    db.handle.commit()
    return codes


def use_recovery_code(user_id: str, code: str) -> bool:
    """Spend a recovery code. Each one works exactly once."""
    cleaned = _clean_recovery(code)
    if len(cleaned) != 10:
        return False
    wanted = _hash_recovery(user_id, cleaned)
    rows = db.handle.execute(
        "SELECT id, code_hash FROM recovery_codes WHERE user_id=? AND used_at=0", (user_id,)
    ).fetchall()
    for row in rows:
        if hmac.compare_digest(row["code_hash"], wanted):
            db.handle.execute(
                "UPDATE recovery_codes SET used_at=? WHERE id=?", (db.now(), row["id"])
            )
            db.handle.commit()
            return True
    return False


def recovery_codes_left(user_id: str) -> int:
    row = db.handle.execute(
        "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id=? AND used_at=0", (user_id,)
    ).fetchone()
    return int(row["n"]) if row else 0


# ------------------------------------------------------------ challenges ----
# Between "password accepted" and "second factor accepted" the client holds a
# short-lived signed challenge. It is not a session and grants no access — it
# only proves the password step was passed for that account.

CHALLENGE_TTL = 10 * 60


def issue_challenge(user_id: str, purpose: str) -> str:
    expires = db.now() + CHALLENGE_TTL
    body = f"{user_id}:{purpose}:{expires}"
    sig = hmac.new(_derive("challenge"), body.encode(), hashlib.sha256).hexdigest()[:32]
    return base64.urlsafe_b64encode(f"{body}:{sig}".encode()).decode().rstrip("=")


def read_challenge(token: str, purpose: str) -> str | None:
    """Return the user id this challenge belongs to, or None."""
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
        user_id, got_purpose, expires, sig = raw.rsplit(":", 3)
    except Exception:
        return None
    if got_purpose != purpose or int(expires) < db.now():
        return None
    body = f"{user_id}:{got_purpose}:{expires}"
    expected = hmac.new(_derive("challenge"), body.encode(), hashlib.sha256).hexdigest()[:32]
    return user_id if hmac.compare_digest(sig, expected) else None


# ------------------------------------------------------------- throttling ---

def record_attempt(email: str, ip: str, ok: bool) -> None:
    try:
        db.handle.execute(
            "INSERT INTO login_attempts (id, email, ip, ok, created_at) VALUES (?,?,?,?,?)",
            (db.new_id(), (email or "")[:200], (ip or "")[:64], 1 if ok else 0, db.now()),
        )
        db.handle.commit()
    except Exception:
        pass


def _recent_failures(column: str, value: str) -> int:
    if not value:
        return 0
    row = db.handle.execute(
        f"SELECT COUNT(*) c FROM login_attempts WHERE {column}=? AND ok=0 AND created_at > ?",
        (value, db.now() - FAILURE_WINDOW),
    ).fetchone()
    return int(row["c"]) if row else 0


def lockout_remaining(email: str, ip: str = "") -> int:
    """Seconds the caller must wait, or 0 when a sign-in may be attempted.
    Failures are counted per account AND per source address, so neither a
    single account nor a single machine can be brute-forced."""
    try:
        by_email = _recent_failures("email", (email or "").lower())
        if by_email >= MAX_FAILURES_EMAIL:
            step = LOCKOUT_STEPS[min(by_email - MAX_FAILURES_EMAIL, len(LOCKOUT_STEPS) - 1)]
            row = db.handle.execute(
                "SELECT MAX(created_at) last FROM login_attempts WHERE email=? AND ok=0",
                ((email or "").lower(),),
            ).fetchone()
            last = int(row["last"] or 0) if row else 0
            return max(0, last + step - db.now())
        if _recent_failures("ip", ip or "") >= MAX_FAILURES_IP:
            return 300
    except Exception:
        return 0
    return 0


def clear_failures(email: str) -> None:
    try:
        db.handle.execute("DELETE FROM login_attempts WHERE email=? AND ok=0",
                          ((email or "").lower(),))
        db.handle.commit()
    except Exception:
        pass


# ----------------------------------------------- secrets at rest (AES-GCM) ---

def encrypt_secret(plaintext: str) -> str:
    if not plaintext:
        return ""
    nonce = secrets.token_bytes(12)
    blob = AESGCM(_derive("settings")).encrypt(nonce, plaintext.encode(), b"emetai-setting")
    return "v1:" + base64.b64encode(nonce + blob).decode()


def decrypt_secret(stored: str) -> str:
    if not stored:
        return ""
    if not stored.startswith("v1:"):
        return stored  # written before encryption existed — still usable
    try:
        raw = base64.b64decode(stored[3:])
        return AESGCM(_derive("settings")).decrypt(raw[:12], raw[12:], b"emetai-setting").decode()
    except Exception:
        return ""


# --------------------------------------- two-factor by authenticator app ----

def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode()


def totp_code(secret: str, at: float | None = None) -> str:
    key = base64.b32decode(secret)
    counter = int((at if at is not None else time.time()) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[19] & 0x0F
    number = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return f"{number % 1_000_000:06d}"


def verify_totp(secret: str, code: str) -> bool:
    code = (code or "").strip().replace(" ", "")
    if not secret or len(code) != 6 or not code.isdigit():
        return False
    now = time.time()
    return any(hmac.compare_digest(totp_code(secret, now + d), code) for d in (-30, 0, 30))


def otpauth_uri(secret: str, email: str) -> str:
    return f"otpauth://totp/EmetAI:{email}?secret={secret}&issuer=EmetAI"


# ------------------------------------------------------------------ misc ----

def client_ip(request) -> str:
    """Best-effort source address, honouring one proxy hop when deployed."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "")[:64]


def safe_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a or "", b or "")
