# Two-factor is now REQUIRED of every account. These tests exist mostly to
# prove the one thing that could go badly wrong: that requiring it cannot
# strand somebody outside their own software.
#
# Run:  cd server && python -X utf8 ../scripts/test-2fa.py

import os
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="emetai-2fa-test-")
SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
sys.path.insert(0, os.path.abspath(SERVER))

import db  # noqa: E402
db.DATA_DIR = TMP
db.DB_PATH = os.path.join(TMP, "test.db")
import security  # noqa: E402
security.DATA_DIR = TMP
security.SECRET_PATH = os.path.join(TMP, "secret.key")

import accounts, mailer  # noqa: E402
from fastapi import HTTPException  # noqa: E402

db.init(db.handle)

PASS = FAIL = 0
SENT: dict[str, str] = {}
DELIVERY_WORKS = True


def check(label, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ok  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label} {extra}")


def fake_send(to, subject, html, text):
    """Stand-in for the mail service, switchable to 'broken' at will."""
    import re
    if not DELIVERY_WORKS:
        return False, "403 sender not allowed"
    m = re.search(r"\b(\d{6})\b", text)
    if m:
        SENT[to] = m.group(1)
    return True, "sent"


mailer.send = fake_send
mailer.is_configured = lambda: True


class Req:
    """The bits of a Request that the auth code actually reads."""
    def __init__(self, ip="127.0.0.1", agent="pytest"):
        self.client = type("C", (), {"host": ip})()
        self.headers = {"user-agent": agent}


def make_user(email, role="church", password="Correct-Horse-9!"):
    uid = db.new_id()
    db.handle.execute(
        "INSERT INTO users (id, email, name, church, role, password_hash, created_at, "
        "must_change_password, email_verified, two_factor, permissions, status, "
        "last_seen_at, locked_until, password_changed_at, created_by, totp_secret, "
        "totp_enabled) VALUES (?,?,?,?,?,?,?,0,1,'email','[]','active',0,0,?,'','',0)",
        (uid, email, email.split("@")[0], "Test Church", role,
         security.hash_password(password), db.now(), db.now()),
    )
    db.handle.commit()
    return db.handle.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def login(email, password="Correct-Horse-9!", device=""):
    return accounts.login(
        accounts.LoginBody(email=email, password=password, deviceToken=device), Req()
    )


# ------------------------------------------- nobody gets in without a factor --
print("\n— the password alone is never enough —")

user = make_user("pastor@test.local")
res = login("pastor@test.local")
check("a password-only account is sent to enrolment", res.get("needsEnrollment") is True, res)
check("no session is issued at that point", "token" not in res, list(res))
check("enrolment carries a challenge", bool(res.get("challenge")))

# The old escape hatches must all be gone.
DELIVERY_WORKS = False
res_broken = login("pastor@test.local")
check("broken email does NOT wave the sign-in through",
      "token" not in res_broken, list(res_broken))
DELIVERY_WORKS = True

try:
    accounts.set_two_factor_method(accounts.MethodBody(method="off"), Req(), user)
    check("two-factor cannot be switched off", False, "no error raised")
except HTTPException as e:
    check("two-factor cannot be switched off", e.status_code == 400, e.detail)


# ---------------------------------------------- enrolling with an auth app ---
print("\n— enrolling with an authenticator app —")

challenge = login("pastor@test.local")["challenge"]
start = accounts.enroll_start(accounts.EnrollStartBody(challenge=challenge, method="totp"))
check("a secret is issued", bool(start.get("secret")))
check("and an otpauth URI for the QR code", start.get("otpauth", "").startswith("otpauth://"))

try:
    accounts.enroll_complete(
        accounts.EnrollCompleteBody(challenge=challenge, method="totp", code="000000"), Req()
    )
    check("a wrong code is refused", False, "no error raised")
except HTTPException as e:
    check("a wrong code is refused", e.status_code == 401, e.detail)

done = accounts.enroll_complete(
    accounts.EnrollCompleteBody(
        challenge=challenge, method="totp",
        code=security.totp_code(start["secret"]),
    ),
    Req(),
)
check("the right code finishes the sign-in", bool(done.get("token")))
check("recovery codes are handed over exactly once",
      len(done.get("recoveryCodes", [])) == security.RECOVERY_CODE_COUNT,
      len(done.get("recoveryCodes", [])))
codes = done["recoveryCodes"]
check("the account now uses the app", done["user"]["twoFactor"] == "totp")
check("and reports its recovery codes", done["user"]["recoveryCodesLeft"] == 10)

# From here on, the password alone must stop at the second factor.
res = login("pastor@test.local")
check("an enrolled account is challenged, not enrolled again",
      res.get("requires2fa") is True and res.get("method") == "totp", res)
check("still no session before the second factor", "token" not in res)


# ------------------------------------------------- recovery codes are real ---
print("\n— the way back in when the factor is gone —")

user = db.handle.execute(
    "SELECT * FROM users WHERE email='pastor@test.local'"
).fetchone()
challenge = login("pastor@test.local")["challenge"]
out = accounts.verify_two_factor(
    accounts.TwoFactorBody(challenge=challenge, code=codes[0]), Req()
)
check("a recovery code signs you in", bool(out.get("token")))
check("and says how many are left", "9" in (out.get("warning") or ""), out.get("warning"))
check("the count really dropped", security.recovery_codes_left(user["id"]) == 9)

challenge = login("pastor@test.local")["challenge"]
try:
    accounts.verify_two_factor(
        accounts.TwoFactorBody(challenge=challenge, code=codes[0]), Req()
    )
    check("a spent recovery code cannot be reused", False, "no error raised")
except HTTPException as e:
    check("a spent recovery code cannot be reused", e.status_code == 401, e.detail)

challenge = login("pastor@test.local")["challenge"]
try:
    accounts.verify_two_factor(
        accounts.TwoFactorBody(challenge=challenge, code="aaaaa-bbbbb"), Req()
    )
    check("an invented recovery code is refused", False, "no error raised")
except HTTPException as e:
    check("an invented recovery code is refused", e.status_code == 401, e.detail)

# Another account's codes must be worthless here.
other = make_user("other@test.local")
other_codes = security.new_recovery_codes(other["id"])
challenge = login("pastor@test.local")["challenge"]
try:
    accounts.verify_two_factor(
        accounts.TwoFactorBody(challenge=challenge, code=other_codes[0]), Req()
    )
    check("another account's recovery code does not work", False, "no error raised")
except HTTPException as e:
    check("another account's recovery code does not work", e.status_code == 401, e.detail)


# ----------------------------------- the lock-out scenario this must survive --
print("\n— email delivery fails completely (the real situation today) —")

DELIVERY_WORKS = False
emailer = make_user("church@test.local")
challenge = login("church@test.local")["challenge"]
start = accounts.enroll_start(accounts.EnrollStartBody(challenge=challenge, method="email"))
check("enrolment reports the delivery failure honestly", start.get("emailSent") is False)
check("and points at the authenticator app instead",
      "authenticator" in (start.get("notice") or "").lower(), start.get("notice"))

# They take that advice, and the app works with no email at all.
start = accounts.enroll_start(accounts.EnrollStartBody(challenge=challenge, method="totp"))
done = accounts.enroll_complete(
    accounts.EnrollCompleteBody(challenge=challenge, method="totp",
                                code=security.totp_code(start["secret"])),
    Req(),
)
check("the app enrols with the mail server still broken", bool(done.get("token")))
email_codes = done["recoveryCodes"]

# And an account already on emailed codes is not stranded when mail dies.
DELIVERY_WORKS = True
mailed = make_user("mailed@test.local")
challenge = login("mailed@test.local")["challenge"]
accounts.enroll_start(accounts.EnrollStartBody(challenge=challenge, method="email"))
done = accounts.enroll_complete(
    accounts.EnrollCompleteBody(challenge=challenge, method="email",
                                code=SENT["mailed@test.local"]),
    Req(),
)
mailed_codes = done["recoveryCodes"]
check("emailed-code enrolment works while mail is up", bool(done.get("token")))

DELIVERY_WORKS = False
res = login("mailed@test.local")
check("mail dies: the sign-in is still challenged, not waved through",
      res.get("requires2fa") is True and "token" not in res, res)
check("the screen explains the code did not arrive",
      "recovery" in (res.get("notice") or "").lower(), res.get("notice"))
out = accounts.verify_two_factor(
    accounts.TwoFactorBody(challenge=res["challenge"], code=mailed_codes[0]), Req()
)
check("a recovery code gets them in anyway", bool(out.get("token")))
DELIVERY_WORKS = True


# ------------------------------------------------------- trusted devices -----
print("\n— remember this device (30 days) —")

challenge = login("pastor@test.local")["challenge"]
out = accounts.verify_two_factor(
    accounts.TwoFactorBody(challenge=challenge, code=codes[1], rememberDevice=True), Req()
)
device = out.get("deviceToken")
check("remembering a device returns a token", bool(device))
res = login("pastor@test.local", device=device)
check("that device is not challenged again", bool(res.get("token")), res)
res = login("pastor@test.local", device="not-a-real-device-token")
check("an unknown device still is", res.get("requires2fa") is True, res)


# ------------------------------------------- registration cannot skip 2FA ----
print("\n— a brand-new church —")

fresh = make_user("new@test.local")
db.handle.execute("UPDATE users SET email_verified=0 WHERE id=?", (fresh["id"],))
db.handle.commit()
code = security.issue_code(fresh["id"], "verify")
res = accounts.verify_email(
    accounts.VerifyBody(challenge=security.issue_challenge(fresh["id"], "verify"), code=code),
    Req(),
)
check("confirming the email does not hand out a session",
      res.get("needsEnrollment") is True and "token" not in res, list(res))


# --------------------------------------------------- regenerating the set ----
print("\n— fresh recovery codes —")

user = db.handle.execute("SELECT * FROM users WHERE email='pastor@test.local'").fetchone()
try:
    accounts.regenerate_recovery(accounts.RecoveryBody(password="wrong-password"), Req(), user)
    check("the password is required to regenerate", False, "no error raised")
except HTTPException as e:
    check("the password is required to regenerate", e.status_code == 401, e.detail)

out = accounts.regenerate_recovery(
    accounts.RecoveryBody(password="Correct-Horse-9!"), Req(), user
)
check("a full fresh set is issued", len(out["codes"]) == security.RECOVERY_CODE_COUNT)
challenge = login("pastor@test.local")["challenge"]
try:
    accounts.verify_two_factor(
        accounts.TwoFactorBody(challenge=challenge, code=codes[2]), Req()
    )
    check("the old codes stop working", False, "no error raised")
except HTTPException as e:
    check("the old codes stop working", e.status_code == 401, e.detail)


# ------------------------------------------------- switching method safely ---
print("\n— changing your mind about the method —")

user = db.handle.execute("SELECT * FROM users WHERE email='pastor@test.local'").fetchone()
try:
    accounts.set_two_factor_method(accounts.MethodBody(method="totp"), Req(), user)
    check("switching to the app is allowed once it is set up", True)
except HTTPException as e:
    check("switching to the app is allowed once it is set up", False, e.detail)

no_app = db.handle.execute("SELECT * FROM users WHERE email='other@test.local'").fetchone()
try:
    accounts.set_two_factor_method(accounts.MethodBody(method="totp"), Req(), no_app)
    check("cannot claim the app before setting it up", False, "no error raised")
except HTTPException as e:
    check("cannot claim the app before setting it up", e.status_code == 400, e.detail)

mailer.is_configured = lambda: False
user = db.handle.execute("SELECT * FROM users WHERE email='pastor@test.local'").fetchone()
try:
    accounts.totp_disable(
        accounts.TotpBody(code=security.totp_code(user["totp_secret"])), Req(), user
    )
    check("removing the app is blocked when no email could replace it",
          False, "no error raised")
except HTTPException as e:
    check("removing the app is blocked when no email could replace it",
          e.status_code == 409, e.detail)
mailer.is_configured = lambda: True

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
