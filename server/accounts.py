# EmetAI accounts — registration, sign-in, two-factor, password recovery,
# sessions, and the dependencies every other route uses to authorise callers.
#
# Sign-in is two steps by design:
#   1. email + password        → a short-lived challenge (grants no access)
#   2. 6-digit code by email   → a real, revocable session
# A device the user chose to trust skips step 2 for 30 days, so nobody is left
# waiting for an email in the middle of a service.

import json
import re
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

import db
import mailer
import security

router = APIRouter()
con = db.handle

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")

# Deliberately identical for "no such account" and "wrong password", so the
# endpoint cannot be used to discover which emails are registered.
BAD_CREDENTIALS = "Wrong email or password."


def _clean_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 200:
        raise HTTPException(400, "Enter a valid email address.")
    return email


def _user_by_email(email: str):
    return con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()


def _user_by_id(user_id: str):
    return con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def user_payload(user) -> dict:
    sub = db.active_subscription(con, user["id"])
    quota = db.quota_state(con, user)
    return {
        "tier": quota["tier"],
        "tierLabel": quota["label"],
        "ai": quota["ai"],
        "quota": {"brainAsks": quota["brainAsks"], "clips": quota["clips"]},
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "church": user["church"],
        "role": user["role"],
        "permissions": sorted(db.permissions_of(user)),
        "mustChangePassword": bool(user["must_change_password"]),
        "emailVerified": bool(user["email_verified"]),
        "twoFactor": user["two_factor"],
        # Every account has a second factor now; the question is only which.
        "twoFactorEnabled": True,
        "totpEnabled": bool(user["totp_enabled"]),
        "recoveryCodesLeft": security.recovery_codes_left(user["id"]),
        "subscription": (
            {
                "plan": sub["plan"],
                "label": db.PLANS.get(sub["plan"], {}).get("label", sub["plan"]),
                "period": db.PLANS.get(sub["plan"], {}).get("period", ""),
                "expiresAt": sub["expires_at"],
                "daysLeft": max(0, (sub["expires_at"] - db.now()) // 86400),
            }
            if sub
            else None
        ),
    }


# ------------------------------------------------------- authorisation ------

def current_user(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not signed in.")
    payload = security.verify_token(authorization[7:])
    if not payload:
        raise HTTPException(401, "Session expired — sign in again.")
    user = _user_by_id(payload["uid"])
    if not user:
        raise HTTPException(401, "Account no longer exists.")
    if user["status"] != "active":
        raise HTTPException(403, "This account has been suspended. Contact the administrator.")
    return user


def current_session_id(authorization: str = Header(default="")) -> str:
    payload = security.verify_token(authorization[7:]) if authorization.startswith("Bearer ") else None
    return payload["sid"] if payload else ""


def admin_user(user=Depends(current_user)):
    """Full administrator only — never an assistant."""
    if user["role"] != "admin":
        raise HTTPException(403, "Administrator access required.")
    return user


def staff_user(user=Depends(current_user)):
    if user["role"] not in ("admin", "assistant"):
        raise HTTPException(403, "Administrator access required.")
    return user


def require(permission: str):
    """Dependency factory: allows the admin, and assistants holding `permission`."""

    def dependency(user=Depends(current_user)):
        if user["role"] == "admin":
            return user
        if db.has_permission(user, permission) and permission not in db.ADMIN_ONLY:
            return user
        raise HTTPException(403, "You do not have permission to do that.")

    return dependency


# ------------------------------------------------------------ registration --

class RegisterBody(BaseModel):
    name: str = Field(max_length=120)
    church: str = Field(default="", max_length=160)
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)


@router.post("/api/auth/register")
def register(body: RegisterBody, request: Request):
    email = _clean_email(body.email)
    name = body.name.strip()
    ip = security.client_ip(request)
    if not name:
        raise HTTPException(400, "Enter your name.")
    err = security.password_ok(body.password, email)
    if err:
        raise HTTPException(400, err)
    if security.lockout_remaining("", ip):
        raise HTTPException(429, "Too many attempts from this connection — try again later.")

    existing = _user_by_email(email)
    if existing:
        # Never confirm that an address is taken to an anonymous caller; an
        # unverified sign-up may simply be resumed.
        if existing["email_verified"]:
            raise HTTPException(409, "An account with this email already exists — sign in instead.")
        con.execute(
            "UPDATE users SET name=?, church=?, password_hash=?, password_changed_at=? WHERE id=?",
            (name, body.church.strip(), security.hash_password(body.password), db.now(), existing["id"]),
        )
        con.commit()
        uid = existing["id"]
    else:
        uid = db.new_id()
        con.execute(
            "INSERT INTO users (id, email, name, church, role, password_hash, created_at, "
            "must_change_password, email_verified, two_factor, permissions, status, "
            "last_seen_at, locked_until, password_changed_at, created_by, totp_secret, totp_enabled) "
            "VALUES (?,?,?,?, 'church', ?, ?, 0, 0, 'email', '[]', 'active', 0, 0, ?, '', '', 0)",
            (uid, email, name, body.church.strip(),
             security.hash_password(body.password), db.now(), db.now()),
        )
        con.commit()

    code = security.issue_code(uid, "verify")
    sent, detail = mailer.send_verify_code(email, name, code)
    db.audit(uid, "account.register", email, f"sent={sent}", ip)
    return {
        "needsVerification": True,
        "email": email,
        "challenge": security.issue_challenge(uid, "verify"),
        "emailSent": sent,
        "notice": None if sent else _code_not_sent(detail),
    }


def _code_not_sent(detail: str) -> str:
    """The notice for a code that never left the building, with its lead-in.
    _delivery_notice carries only the reason, because the sign-in path has a
    lead-in of its own and two of them read like a stammer."""
    return "We could not email your code. " + _delivery_notice(detail)


def _delivery_notice(detail: str) -> str:
    """Explain a failed delivery without ever leaving the person stranded.

    Whoever reads this may be a church that found EmetAI ten seconds ago, not
    the person who runs the server. These lines used to answer the operator —
    "the code was printed in the server window", "add a Resend key in Admin →
    Email" — which tells a visiting church nothing it can act on and hands a
    stranger our internal arrangements. The operator already has the detail:
    the code and the provider's own error go to the server log, and Admin →
    Email shows the status. So these say what it means for the person reading
    and what happens next.
    """
    if detail == "email-not-configured":
        return ("This EmetAI server has not finished connecting its email yet — ask "
                "whoever set it up to connect email, then try again.")
    if "only send testing emails" in detail:
        return ("This server's email is still in testing and can only write to its "
                "owner's own address — ask whoever set it up to verify a sender "
                "address it may send from.")
    reason = detail.split(":", 1)[1].strip() if ":" in detail else ""
    if reason:
        return f"The mail provider refused it — {reason[:160]}"
    return "Ask for another code in a moment."


class VerifyBody(BaseModel):
    challenge: str = Field(default="", max_length=400)
    email: str = Field(default="", max_length=200)
    code: str = Field(max_length=12)
    rememberDevice: bool = False


@router.post("/api/auth/verify-email")
def verify_email(body: VerifyBody, request: Request):
    uid = security.read_challenge(body.challenge, "verify")
    if not uid:
        raise HTTPException(400, "This confirmation expired — start again.")
    user = _user_by_id(uid)
    if not user:
        raise HTTPException(400, "This confirmation expired — start again.")
    if not security.check_code(uid, "verify", body.code):
        raise HTTPException(401, "That code is wrong or has expired.")

    first_time = not user["email_verified"]
    con.execute("UPDATE users SET email_verified=1 WHERE id=?", (uid,))
    con.commit()
    if first_time and user["role"] == "church" and not db.active_subscription(con, uid):
        db.grant_subscription(con, uid, "trial")  # 14 free days start once confirmed
    db.audit(uid, "account.email_verified", user["email"], "", security.client_ip(request))

    user = _user_by_id(uid)
    # A newly confirmed church has a password and nothing else. Send it
    # straight into enrolment rather than issuing a session — otherwise
    # registration would be the one doorway that skips two-factor.
    if not has_second_factor(user):
        return {
            "needsEnrollment": True,
            "email": user["email"],
            "name": user["name"],
            "challenge": security.issue_challenge(uid, "enroll"),
            "emailDeliverable": mailer.is_configured(),
        }
    return _issue_session(user, request, body.rememberDevice)


# ------------------------------------------------------------------ login ---

def has_second_factor(user) -> bool:
    """Is this account actually protected by something beyond its password?

    Recovery codes are part of the answer, not a footnote. An account whose
    only factor is an emailed code is one bounced message away from being
    unreachable, and this software runs in churches whose mail we do not
    control. "Enrolled" therefore means: a chosen method AND a way back in."""
    chose_method = bool(user["totp_enabled"]) or user["two_factor"] == "email"
    return chose_method and security.recovery_codes_left(user["id"]) > 0


class LoginBody(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)
    deviceToken: str = Field(default="", max_length=200)


@router.post("/api/auth/login")
def login(body: LoginBody, request: Request):
    email = (body.email or "").strip().lower()
    ip = security.client_ip(request)
    wait = security.lockout_remaining(email, ip)
    if wait:
        raise HTTPException(
            429, f"Too many failed attempts. Try again in {max(1, wait // 60)} minute(s)."
        )

    user = _user_by_email(email)
    if not user or not security.verify_password(body.password, user["password_hash"]):
        security.record_attempt(email, ip, False)
        raise HTTPException(401, BAD_CREDENTIALS)
    if user["status"] != "active":
        security.record_attempt(email, ip, False)
        raise HTTPException(403, "This account has been suspended. Contact the administrator.")

    # The password was right: upgrade an old hash quietly while we have it.
    if security.needs_rehash(user["password_hash"]):
        con.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (security.hash_password(body.password), user["id"]),
        )
        con.commit()

    security.record_attempt(email, ip, True)
    security.clear_failures(email)

    if not user["email_verified"]:
        code = security.issue_code(user["id"], "verify")
        sent, detail = mailer.send_verify_code(email, user["name"], code)
        return {
            "needsVerification": True,
            "email": email,
            "challenge": security.issue_challenge(user["id"], "verify"),
            "emailSent": sent,
            "notice": None if sent else _code_not_sent(detail),
        }

    # No second factor yet? Then the password is not enough to get in, but it
    # IS enough to set one up. Enrolment happens here, before any session
    # exists — that is what lets two-factor be required of everyone without
    # locking out the accounts that predate the requirement.
    if not has_second_factor(user):
        return {
            "needsEnrollment": True,
            "email": email,
            "name": user["name"],
            "challenge": security.issue_challenge(user["id"], "enroll"),
            "emailDeliverable": mailer.is_configured(),
        }

    if security.device_is_trusted(user["id"], body.deviceToken):
        return _issue_session(user, request, remember=False)

    if user["two_factor"] == "totp" and user["totp_enabled"]:
        return {
            "requires2fa": True,
            "method": "totp",
            "challenge": security.issue_challenge(user["id"], "2fa"),
            "recoveryLeft": security.recovery_codes_left(user["id"]),
        }

    # Email code. If it cannot be delivered the sign-in is NOT waved through —
    # every enrolled account has recovery codes, so there is always a way in
    # that does not depend on someone else's mail server.
    code = security.issue_code(user["id"], "login")
    sent, detail = mailer.send_login_code(email, user["name"], code, ip)
    if not sent:
        db.audit(user, "auth.2fa_undelivered", email, f"delivery failed: {detail[:120]}", ip)
    return {
        "requires2fa": True,
        "method": "email",
        "challenge": security.issue_challenge(user["id"], "2fa"),
        "emailSent": sent,
        "recoveryLeft": security.recovery_codes_left(user["id"]),
        "notice": None if sent else (
            "The code could not be emailed to you. " + _delivery_notice(detail)
            + " Use one of your recovery codes to sign in."
        ),
    }


# ------------------------------------------------ enrolling a second factor --
# Reached with the password already accepted but no session issued. Everything
# here is gated on the "enroll" challenge, so it can only be driven by someone
# who just proved they know the password for that account.

class EnrollStartBody(BaseModel):
    challenge: str = Field(max_length=400)
    method: str = Field(max_length=10)


def _enrolling_user(challenge: str):
    uid = security.read_challenge(challenge, "enroll")
    user = _user_by_id(uid) if uid else None
    if not user:
        raise HTTPException(400, "This sign-in expired — start again.")
    return user


@router.post("/api/auth/2fa/enroll/start")
def enroll_start(body: EnrollStartBody):
    """Begin enrolment with the chosen method and hand back what the person
    needs to prove they hold it."""
    user = _enrolling_user(body.challenge)
    if body.method == "totp":
        secret = security.new_totp_secret()
        con.execute(
            "UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?", (secret, user["id"])
        )
        con.commit()
        return {
            "method": "totp",
            "secret": secret,
            "otpauth": security.otpauth_uri(secret, user["email"]),
        }
    if body.method == "email":
        code = security.issue_code(user["id"], "login")
        sent, detail = mailer.send_login_code(user["email"], user["name"], code)
        # Told plainly, because an emailed code that never arrives is not a
        # second factor — better to find out now than at the next sign-in.
        return {
            "method": "email",
            "emailSent": sent,
            "notice": None if sent else (
                "That code could not be delivered. " + _delivery_notice(detail)
                + " Choose the authenticator app instead — it needs no email."
            ),
        }
    raise HTTPException(400, "Choose the authenticator app or an emailed code.")


class EnrollCompleteBody(BaseModel):
    challenge: str = Field(max_length=400)
    method: str = Field(max_length=10)
    code: str = Field(max_length=12)
    rememberDevice: bool = False


@router.post("/api/auth/2fa/enroll/complete")
def enroll_complete(body: EnrollCompleteBody, request: Request):
    """Prove the second factor works, then switch it on, mint the recovery
    codes and finish the sign-in."""
    user = _enrolling_user(body.challenge)
    ip = security.client_ip(request)
    if security.lockout_remaining(user["email"], ip):
        raise HTTPException(429, "Too many attempts — wait a few minutes and try again.")

    if body.method == "totp":
        if not user["totp_secret"]:
            raise HTTPException(400, "Start the setup again — no key was issued.")
        ok = security.verify_totp(user["totp_secret"], body.code)
    elif body.method == "email":
        ok = security.check_code(user["id"], "login", body.code)
    else:
        raise HTTPException(400, "Choose the authenticator app or an emailed code.")

    if not ok:
        security.record_attempt(user["email"], ip, False)
        raise HTTPException(401, "That code is wrong or has expired.")
    security.clear_failures(user["email"])

    if body.method == "totp":
        con.execute(
            "UPDATE users SET totp_enabled=1, two_factor='totp' WHERE id=?", (user["id"],)
        )
    else:
        con.execute("UPDATE users SET two_factor='email' WHERE id=?", (user["id"],))
    con.commit()

    codes = security.new_recovery_codes(user["id"])
    db.audit(user, "auth.2fa_enrolled", user["email"], body.method, ip)

    user = _user_by_id(user["id"])  # re-read: the method just changed
    out = _issue_session(user, request, body.rememberDevice)
    out["recoveryCodes"] = codes
    return out


class TwoFactorBody(BaseModel):
    challenge: str = Field(max_length=400)
    code: str = Field(max_length=12)
    rememberDevice: bool = False


@router.post("/api/auth/2fa/verify")
def verify_two_factor(body: TwoFactorBody, request: Request):
    uid = security.read_challenge(body.challenge, "2fa")
    if not uid:
        raise HTTPException(400, "This sign-in expired — start again.")
    user = _user_by_id(uid)
    if not user:
        raise HTTPException(400, "This sign-in expired — start again.")
    ip = security.client_ip(request)
    if security.lockout_remaining(user["email"], ip):
        raise HTTPException(429, "Too many attempts — wait a few minutes and try again.")

    ok = (
        security.verify_totp(user["totp_secret"], body.code)
        if user["two_factor"] == "totp" and user["totp_enabled"]
        else security.check_code(uid, "login", body.code)
    )
    # A recovery code is always accepted in place of the usual factor. This is
    # the path back in when the phone is lost or the email never arrives, and
    # it is why requiring two-factor cannot strand anyone.
    used_recovery = False
    if not ok and security.use_recovery_code(uid, body.code):
        ok = used_recovery = True

    if not ok:
        security.record_attempt(user["email"], ip, False)
        db.audit(uid, "auth.2fa_failed", user["email"], "", ip)
        raise HTTPException(401, "That code is wrong or has expired.")
    security.clear_failures(user["email"])

    out = _issue_session(user, request, body.rememberDevice)
    if used_recovery:
        left = security.recovery_codes_left(uid)
        db.audit(uid, "auth.recovery_used", user["email"], f"{left} left", ip)
        mailer.send_new_device_alert(user["email"], user["name"], ip,
                                     request.headers.get("user-agent", ""))
        out["warning"] = (
            f"You signed in with a recovery code — {left} of them remain. "
            "Open Account to generate a fresh set, and check your usual second "
            "factor still works."
        )
    return out


class ResendBody(BaseModel):
    challenge: str = Field(max_length=400)
    purpose: str = Field(default="2fa", max_length=12)


@router.post("/api/auth/resend-code")
def resend_code(body: ResendBody):
    purpose = "verify" if body.purpose == "verify" else "2fa"
    uid = security.read_challenge(body.challenge, purpose)
    if not uid:
        raise HTTPException(400, "This request expired — start again.")
    user = _user_by_id(uid)
    if not user:
        raise HTTPException(400, "This request expired — start again.")
    kind = "verify" if purpose == "verify" else "login"
    wait = security.code_cooldown(uid, kind)
    if wait:
        raise HTTPException(429, f"Please wait {wait} more second(s) before asking again.")
    code = security.issue_code(uid, kind)
    if kind == "verify":
        sent, detail = mailer.send_verify_code(user["email"], user["name"], code)
    else:
        sent, detail = mailer.send_login_code(user["email"], user["name"], code)
    return {"ok": True, "emailSent": sent, "notice": None if sent else _code_not_sent(detail)}


def _issue_session(user, request: Request, remember: bool, warn: str | None = None) -> dict:
    ip = security.client_ip(request)
    agent = request.headers.get("user-agent", "")
    seen_before = con.execute(
        "SELECT 1 FROM sessions WHERE user_id=? AND user_agent=? LIMIT 1", (user["id"], agent[:200])
    ).fetchone()

    token = security.create_session(user["id"], ip, agent)
    db.audit(user, "auth.login", user["email"], f"ip={ip}", ip)
    db.record_usage(user["id"], "login")

    if not seen_before and user["email_verified"]:
        mailer.send_new_device_alert(user["email"], user["name"], ip, agent)

    out = {"token": token, "user": user_payload(user)}
    if remember:
        out["deviceToken"] = security.trust_device(user["id"], agent[:120])
    if warn:
        out["warning"] = warn
    return out


# -------------------------------------------------------- password rescue ---

class ForgotBody(BaseModel):
    email: str = Field(max_length=200)


@router.post("/api/auth/forgot-password")
def forgot_password(body: ForgotBody, request: Request):
    email = (body.email or "").strip().lower()
    user = _user_by_email(email)
    # Always the same answer, whether or not the account exists.
    if user and user["status"] == "active" and not security.code_cooldown(user["id"], "reset"):
        code = security.issue_code(user["id"], "reset")
        mailer.send_reset_code(email, user["name"], code)
        db.audit(user, "auth.reset_requested", email, "", security.client_ip(request))
    return {"ok": True, "message": "If that address has an account, a reset code is on its way."}


class ResetBody(BaseModel):
    email: str = Field(max_length=200)
    code: str = Field(max_length=12)
    password: str = Field(max_length=200)


@router.post("/api/auth/reset-password")
def reset_password(body: ResetBody, request: Request):
    email = (body.email or "").strip().lower()
    ip = security.client_ip(request)
    if security.lockout_remaining(email, ip):
        raise HTTPException(429, "Too many attempts — wait a few minutes and try again.")
    user = _user_by_email(email)
    if not user or not security.check_code(user["id"], "reset", body.code):
        security.record_attempt(email, ip, False)
        raise HTTPException(401, "That code is wrong or has expired.")
    err = security.password_ok(body.password, email)
    if err:
        raise HTTPException(400, err)
    con.execute(
        "UPDATE users SET password_hash=?, must_change_password=0, password_changed_at=?, "
        "email_verified=1 WHERE id=?",
        (security.hash_password(body.password), db.now(), user["id"]),
    )
    con.commit()
    # A reset means the old password may be compromised: end every session and
    # forget every trusted device.
    security.revoke_all_sessions(user["id"])
    security.forget_devices(user["id"])
    security.clear_failures(email)
    db.audit(user, "auth.password_reset", email, "", ip)
    return {"ok": True, "message": "Password changed — sign in with your new password."}


# ------------------------------------------------------------- the session --

@router.get("/api/me")
def me(user=Depends(current_user)):
    return user_payload(user)


@router.post("/api/auth/logout")
def logout(authorization: str = Header(default=""), user=Depends(current_user)):
    security.revoke_session(authorization[7:])
    db.audit(user, "auth.logout", user["email"])
    return {"ok": True}


class ChangePasswordBody(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


@router.post("/api/auth/change-password")
def change_password(body: ChangePasswordBody, request: Request,
                    authorization: str = Header(default=""), user=Depends(current_user)):
    if not security.verify_password(body.current, user["password_hash"]):
        raise HTTPException(401, "Current password is wrong.")
    err = security.password_ok(body.new, user["email"])
    if err:
        raise HTTPException(400, err)
    if security.verify_password(body.new, user["password_hash"]):
        raise HTTPException(400, "Choose a password you have not used here before.")
    con.execute(
        "UPDATE users SET password_hash=?, must_change_password=0, password_changed_at=? WHERE id=?",
        (security.hash_password(body.new), db.now(), user["id"]),
    )
    con.commit()
    payload = security.verify_token(authorization[7:]) if authorization.startswith("Bearer ") else None
    security.revoke_all_sessions(user["id"], keep_session_id=payload["sid"] if payload else "")
    db.audit(user, "auth.password_changed", user["email"], "", security.client_ip(request))
    return {"ok": True, "message": "Password changed. Other devices have been signed out."}


@router.get("/api/auth/sessions")
def list_sessions(authorization: str = Header(default=""), user=Depends(current_user)):
    payload = security.verify_token(authorization[7:]) if authorization.startswith("Bearer ") else None
    current_sid = payload["sid"] if payload else ""
    rows = con.execute(
        "SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions "
        "WHERE user_id=? AND revoked=0 AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 50",
        (user["id"], db.now()),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "ip": r["ip"],
            "device": r["user_agent"][:160],
            "createdAt": r["created_at"],
            "lastSeenAt": r["last_seen_at"],
            "current": r["id"] == current_sid,
        }
        for r in rows
    ]


@router.post("/api/auth/sessions/revoke-others")
def revoke_others(request: Request, authorization: str = Header(default=""),
                  user=Depends(current_user)):
    payload = security.verify_token(authorization[7:]) if authorization.startswith("Bearer ") else None
    count = security.revoke_all_sessions(user["id"], keep_session_id=payload["sid"] if payload else "")
    security.forget_devices(user["id"])
    db.audit(user, "auth.sessions_revoked", user["email"], f"count={count}",
             security.client_ip(request))
    return {"ok": True, "revoked": count}


# ------------------------------------------------------------ two-factor ----

class MethodBody(BaseModel):
    method: str = Field(max_length=10)


@router.post("/api/auth/2fa/method")
def set_two_factor_method(body: MethodBody, request: Request, user=Depends(current_user)):
    """Switch between the authenticator app and an emailed code.

    There is deliberately no way to switch two-factor off. Every account on
    EmetAI has a second factor; the only choice is which one."""
    method = body.method
    if method not in ("email", "totp"):
        raise HTTPException(
            400,
            "Choose the authenticator app or an emailed code — two-factor "
            "cannot be switched off.",
        )
    if method == "totp" and not user["totp_enabled"]:
        raise HTTPException(400, "Set up your authenticator app first.")
    con.execute("UPDATE users SET two_factor=? WHERE id=?", (method, user["id"]))
    con.commit()
    db.audit(user, "auth.2fa_method", user["email"], method, security.client_ip(request))
    return {"ok": True, "method": method}


class RecoveryBody(BaseModel):
    password: str = Field(max_length=200)


@router.post("/api/auth/2fa/recovery")
def regenerate_recovery(body: RecoveryBody, request: Request, user=Depends(current_user)):
    """Issue a fresh set of recovery codes. The password is asked for again so
    an unattended, already-signed-in laptop cannot mint someone a way in."""
    if not security.verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "That password is not right.")
    codes = security.new_recovery_codes(user["id"])
    db.audit(user, "auth.recovery_regenerated", user["email"], "", security.client_ip(request))
    return {"ok": True, "codes": codes}


class TotpBody(BaseModel):
    code: str = Field(max_length=12)


@router.post("/api/auth/2fa/setup")
def totp_setup(user=Depends(current_user)):
    secret = security.new_totp_secret()
    con.execute("UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?", (secret, user["id"]))
    con.commit()
    return {"secret": secret, "otpauth": security.otpauth_uri(secret, user["email"])}


@router.post("/api/auth/2fa/enable")
def totp_enable(body: TotpBody, request: Request, user=Depends(current_user)):
    if not user["totp_secret"]:
        raise HTTPException(400, "Run setup first.")
    if not security.verify_totp(user["totp_secret"], body.code):
        raise HTTPException(401, "That code is wrong — check your authenticator app.")
    con.execute("UPDATE users SET totp_enabled=1, two_factor='totp' WHERE id=?", (user["id"],))
    con.commit()
    db.audit(user, "auth.totp_enabled", user["email"], "", security.client_ip(request))
    return {"ok": True}


@router.post("/api/auth/2fa/disable")
def totp_disable(body: TotpBody, request: Request, user=Depends(current_user)):
    """Remove the authenticator app. The account does not lose its second
    factor — it falls back to an emailed code, which is only offered when a
    code can actually be delivered."""
    if not user["totp_enabled"]:
        raise HTTPException(400, "The authenticator app is not set up.")
    if not security.verify_totp(user["totp_secret"], body.code):
        raise HTTPException(401, "That code is wrong — check your authenticator app.")
    if not mailer.is_configured():
        raise HTTPException(
            409,
            "Removing the app would leave this account with no second factor: no "
            "email service is connected, so a code could not be sent to you. Ask "
            "the administrator to connect email first.",
        )
    con.execute(
        "UPDATE users SET totp_enabled=0, totp_secret='', two_factor='email' WHERE id=?",
        (user["id"],),
    )
    con.commit()
    db.audit(user, "auth.totp_disabled", user["email"], "", security.client_ip(request))
    return {"ok": True, "method": "email"}


# ------------------------------------------------- assistants (admin only) --

class AssistantBody(BaseModel):
    email: str = Field(max_length=200)
    name: str = Field(default="", max_length=120)
    permissions: list[str] = []


@router.get("/api/admin/assistants")
def list_assistants(_admin=Depends(admin_user)):
    rows = con.execute(
        "SELECT id, email, name, permissions, status, created_at, last_seen_at "
        "FROM users WHERE role='assistant' ORDER BY created_at DESC"
    ).fetchall()
    out = []
    for r in rows:
        try:
            granted = json.loads(r["permissions"] or "[]")
        except Exception:
            granted = []
        out.append({
            "id": r["id"], "email": r["email"], "name": r["name"],
            "permissions": granted, "status": r["status"],
            "createdAt": r["created_at"], "lastSeenAt": r["last_seen_at"],
        })
    return out


@router.get("/api/admin/permissions")
def list_permissions(_staff=Depends(staff_user)):
    return [
        {"id": pid, "label": label, "adminOnly": pid in db.ADMIN_ONLY}
        for pid, label in db.PERMISSIONS.items()
    ]


@router.post("/api/admin/assistants")
def create_assistant(body: AssistantBody, request: Request, admin=Depends(admin_user)):
    email = _clean_email(body.email)
    granted = [p for p in body.permissions if p in db.PERMISSIONS and p not in db.ADMIN_ONLY]
    existing = _user_by_email(email)
    if existing and existing["role"] != "assistant":
        raise HTTPException(409, "That email already belongs to a church or administrator account.")

    # A strong temporary password the assistant must replace on first sign-in.
    temp = "Emet-" + secrets.token_urlsafe(9)
    if existing:
        con.execute(
            "UPDATE users SET name=?, permissions=?, status='active', password_hash=?, "
            "must_change_password=1, password_changed_at=? WHERE id=?",
            (body.name.strip() or existing["name"], json.dumps(granted),
             security.hash_password(temp), db.now(), existing["id"]),
        )
        uid = existing["id"]
    else:
        uid = db.new_id()
        con.execute(
            "INSERT INTO users (id, email, name, church, role, password_hash, created_at, "
            "must_change_password, email_verified, two_factor, permissions, status, "
            "last_seen_at, locked_until, password_changed_at, created_by, totp_secret, totp_enabled) "
            "VALUES (?,?,?,'EmetAI','assistant',?,?,1,1,'email',?, 'active',0,0,?,?,'',0)",
            (uid, email, body.name.strip() or email.split("@")[0],
             security.hash_password(temp), db.now(), json.dumps(granted), db.now(), admin["id"]),
        )
    con.commit()
    labels = [db.PERMISSIONS[p] for p in granted]
    sent, detail = mailer.send_assistant_invite(email, body.name.strip(), temp, labels)
    db.audit(admin, "assistant.created", email, ",".join(granted), security.client_ip(request))
    return {
        "ok": True,
        "id": uid,
        "emailSent": sent,
        # Shown once in the UI so the admin can pass it on if email is not set up.
        "temporaryPassword": None if sent else temp,
        "notice": None if sent else _code_not_sent(detail),
    }


class AssistantUpdateBody(BaseModel):
    permissions: list[str] | None = None
    status: str | None = None


@router.post("/api/admin/assistants/{assistant_id}")
def update_assistant(assistant_id: str, body: AssistantUpdateBody, request: Request,
                     admin=Depends(admin_user)):
    row = con.execute(
        "SELECT * FROM users WHERE id=? AND role='assistant'", (assistant_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Assistant not found.")
    if body.permissions is not None:
        granted = [p for p in body.permissions if p in db.PERMISSIONS and p not in db.ADMIN_ONLY]
        con.execute("UPDATE users SET permissions=? WHERE id=?", (json.dumps(granted), assistant_id))
        db.audit(admin, "assistant.permissions", row["email"], ",".join(granted),
                 security.client_ip(request))
    if body.status in ("active", "suspended"):
        con.execute("UPDATE users SET status=? WHERE id=?", (body.status, assistant_id))
        if body.status == "suspended":
            security.revoke_all_sessions(assistant_id)  # access ends immediately
            security.forget_devices(assistant_id)
        db.audit(admin, f"assistant.{body.status}", row["email"], "", security.client_ip(request))
    con.commit()
    return {"ok": True}


@router.delete("/api/admin/assistants/{assistant_id}")
def delete_assistant(assistant_id: str, request: Request, admin=Depends(admin_user)):
    row = con.execute(
        "SELECT * FROM users WHERE id=? AND role='assistant'", (assistant_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Assistant not found.")
    security.revoke_all_sessions(assistant_id)
    security.forget_devices(assistant_id)
    con.execute("DELETE FROM users WHERE id=?", (assistant_id,))
    con.commit()
    db.audit(admin, "assistant.removed", row["email"], "", security.client_ip(request))
    return {"ok": True}
