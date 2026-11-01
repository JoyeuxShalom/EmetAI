# End-to-end test of the new EmetAI auth stack against a throwaway database.
import inspect
import json
import os
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="emetai-test-")
SERVER = r"C:\Church\EmetAI\emetai\server"
sys.path.insert(0, SERVER)

# Point the data directory at a scratch copy so the real database is untouched.
import db  # noqa: E402
db.DATA_DIR = TMP
db.DB_PATH = os.path.join(TMP, "test.db")
import security  # noqa: E402
security.DATA_DIR = TMP
security.SECRET_PATH = os.path.join(TMP, "secret.key")

import accounts, mailer  # noqa: E402
import brain as brain_mod  # noqa: E402

PASS = FAIL = 0
CODES = {}


def check(label, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ok  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label} {extra}")


# Capture the codes instead of emailing them.
def fake_send(to, subject, html, text):
    import re
    m = re.search(r"\b(\d{6})\b", text)
    if m:
        CODES[to] = m.group(1)
    return True, "sent"


mailer.send = fake_send
mailer.is_configured = lambda: True

db.init(db.handle)


class Req:
    """Minimal stand-in for a FastAPI Request."""
    def __init__(self, ip="41.75.1.1", agent="TestBrowser/1.0"):
        self.headers = {"user-agent": agent}
        self.client = type("C", (), {"host": ip})()


from fastapi import HTTPException  # noqa: E402

print("\n--- passwords ---")
check("weak password refused", accounts.security.password_ok("abc") is not None)
check("common password refused", accounts.security.password_ok("Password123") is not None)
check("no-uppercase refused", accounts.security.password_ok("longpassword1") is not None)
check("email-in-password refused",
      accounts.security.password_ok("Pastorxyz123", "pastorxyz@test.rw") is not None)
check("strong password accepted", accounts.security.password_ok("Ubwiza2026Rw", "a@b.rw") is None)

h = security.hash_password("Ubwiza2026Rw")
check("argon2id used", h.startswith("$argon2id$"), h[:20])
check("password verifies", security.verify_password("Ubwiza2026Rw", h))
check("wrong password rejected", not security.verify_password("Ubwiza2026Rx", h))
legacy = "pbkdf2$210000$" + "aa" * 16 + "$" + __import__("hashlib").pbkdf2_hmac(
    "sha256", b"OldPass123", bytes.fromhex("aa" * 16), 210000).hex()
check("legacy pbkdf2 still verifies", security.verify_password("OldPass123", legacy))
check("legacy hash flagged for upgrade", security.needs_rehash(legacy))

print("\n--- registration + email verification ---")
r = accounts.register(
    accounts.RegisterBody(name="Pastor Jean", church="Zion Temple",
                          email="Jean@Test.RW", password="Ubwiza2026Rw"), Req())
check("register asks for verification", r["needsVerification"] is True)
check("register issues no token", "token" not in r)
check("verification email captured", "jean@test.rw" in CODES)
challenge = r["challenge"]

try:
    accounts.verify_email(accounts.VerifyBody(challenge=challenge, code="000000"), Req())
    check("wrong verify code refused", False)
except HTTPException as e:
    check("wrong verify code refused", e.status_code == 401)

out = accounts.verify_email(
    accounts.VerifyBody(challenge=challenge, code=CODES["jean@test.rw"]), Req())
# Confirming the email no longer signs you in: two-factor is required of every
# account, so a brand-new church goes straight into enrolment. See test-2fa.py.
check("verification sends the new church to enrolment", out.get("needsEnrollment") is True)
check("verification issues no session", "token" not in out)

# Enrol with an authenticator app so the rest of this file can sign in.
enroll = accounts.enroll_start(
    accounts.EnrollStartBody(challenge=out["challenge"], method="totp"))
out = accounts.enroll_complete(
    accounts.EnrollCompleteBody(challenge=out["challenge"], method="totp",
                                code=security.totp_code(enroll["secret"])), Req())
TOTP_SECRET = enroll["secret"]
RECOVERY = out["recoveryCodes"]
check("enrolment returns a session", bool(out.get("token")))
check("trial granted on verification", out["user"]["subscription"]["plan"] == "trial")
check("email marked verified", out["user"]["emailVerified"] is True)
first_token = out["token"]

# Switch back to emailed codes so the rest of this file exercises that path.
jean = db.handle.execute("SELECT * FROM users WHERE email='jean@test.rw'").fetchone()
accounts.set_two_factor_method(accounts.MethodBody(method="email"), Req(), jean)
check("can switch to emailed codes",
      db.handle.execute("SELECT two_factor AS m FROM users WHERE id=?",
                        (jean["id"],)).fetchone()["m"] == "email")

print("\n--- sign-in with 2FA ---")
try:
    accounts.login(accounts.LoginBody(email="jean@test.rw", password="wrongpass"), Req())
    check("wrong password refused", False)
except HTTPException as e:
    check("wrong password refused", e.status_code == 401)
    check("error does not reveal the account", "Wrong email or password" in e.detail)

r = accounts.login(accounts.LoginBody(email="jean@test.rw", password="Ubwiza2026Rw"), Req())
check("password step asks for 2nd factor", r.get("requires2fa") is True)
check("2fa method is email", r["method"] == "email")
check("no token before 2nd factor", "token" not in r)
login_code = CODES["jean@test.rw"]

try:
    accounts.verify_two_factor(
        accounts.TwoFactorBody(challenge=r["challenge"], code="123456"), Req())
    check("wrong 2fa code refused", False)
except HTTPException as e:
    check("wrong 2fa code refused", e.status_code == 401)

out = accounts.verify_two_factor(
    accounts.TwoFactorBody(challenge=r["challenge"], code=login_code, rememberDevice=True), Req())
check("2fa success returns session", bool(out.get("token")))
check("device token issued when remembered", bool(out.get("deviceToken")))
device_token = out["deviceToken"]
session_token = out["token"]

check("code is single-use",
      not security.check_code(out["user"]["id"], "login", login_code))

r = accounts.login(accounts.LoginBody(email="jean@test.rw", password="Ubwiza2026Rw",
                                      deviceToken=device_token), Req())
check("trusted device skips 2fa", bool(r.get("token")))
r = accounts.login(accounts.LoginBody(email="jean@test.rw", password="Ubwiza2026Rw",
                                      deviceToken="not-a-real-device"), Req())
check("forged device token does NOT skip 2fa", r.get("requires2fa") is True)

print("\n--- sessions ---")
payload = security.verify_token(session_token)
check("session token resolves", payload and payload["role"] == "church")
check("garbage token rejected", security.verify_token("nonsense") is None)
check("truncated token rejected", security.verify_token(session_token[:-5]) is None)
security.revoke_session(session_token)
check("revoked session stops working", security.verify_token(session_token) is None)
check("other session still alive", security.verify_token(first_token) is not None)

print("\n--- throttling ---")
for _ in range(6):
    try:
        accounts.login(accounts.LoginBody(email="jean@test.rw", password="nope"), Req())
    except HTTPException:
        pass
locked = security.lockout_remaining("jean@test.rw", "41.75.1.1")
check("account locks after repeated failures", locked > 0, f"remaining={locked}")
try:
    accounts.login(accounts.LoginBody(email="jean@test.rw", password="Ubwiza2026Rw"), Req())
    check("locked account refuses even the right password", False)
except HTTPException as e:
    check("locked account refuses even the right password", e.status_code == 429)
security.clear_failures("jean@test.rw")

print("\n--- password reset ---")
r = accounts.forgot_password(accounts.ForgotBody(email="jean@test.rw"), Req())
check("forgot-password answer is neutral", "If that address" in r["message"])
r2 = accounts.forgot_password(accounts.ForgotBody(email="nobody@nowhere.rw"), Req())
check("unknown address gets the same answer", r2["message"] == r["message"])
reset_code = CODES["jean@test.rw"]
try:
    accounts.reset_password(accounts.ResetBody(email="jean@test.rw", code=reset_code,
                                               password="weak"), Req())
    check("reset enforces password strength", False)
except HTTPException as e:
    check("reset enforces password strength", e.status_code == 400)
reset_code = security.issue_code(payload["uid"], "reset")
accounts.reset_password(accounts.ResetBody(email="jean@test.rw", code=reset_code,
                                           password="Amahoro2026Rw"), Req())
check("password actually changed",
      accounts.login(accounts.LoginBody(email="jean@test.rw",
                                        password="Amahoro2026Rw"), Req()).get("requires2fa"))
check("reset killed every session", security.verify_token(first_token) is None)
check("reset forgot trusted devices",
      accounts.login(accounts.LoginBody(email="jean@test.rw", password="Amahoro2026Rw",
                                        deviceToken=device_token), Req()).get("requires2fa"))

print("\n--- roles and permissions ---")
db.handle.execute(
    "INSERT INTO users (id, email, name, church, role, password_hash, created_at, "
    "must_change_password, email_verified, two_factor, permissions, status, last_seen_at, "
    "locked_until, password_changed_at, created_by, totp_secret, totp_enabled) "
    "VALUES (?,?,?,?, 'admin', ?, ?, 0, 1, 'email', '[]', 'active', 0, 0, ?, '', '', 0)",
    (db.new_id(), "admin@emetai.rw", "Admin", "EmetAI",
     security.hash_password("AdminStrong2026"), db.now(), db.now()))
db.handle.commit()
admin = db.handle.execute("SELECT * FROM users WHERE email='admin@emetai.rw'").fetchone()

res = accounts.create_assistant(
    accounts.AssistantBody(email="helper@emetai.rw", name="Helper",
                           permissions=["users.view", "reports.view", "settings.manage"]),
    Req(), admin)
check("assistant created", res["ok"])
helper = db.handle.execute("SELECT * FROM users WHERE email='helper@emetai.rw'").fetchone()
perms = db.permissions_of(helper)
check("granted permissions kept", {"users.view", "reports.view"} <= perms)
check("admin-only permission NOT grantable", "settings.manage" not in perms)
check("assistant must change password", bool(helper["must_change_password"]))
check("admin has every permission", db.permissions_of(admin) == set(db.PERMISSIONS))
church = db.handle.execute("SELECT * FROM users WHERE email='jean@test.rw'").fetchone()
check("church user has no admin permissions", db.permissions_of(church) == set())

dep = accounts.require("users.view")
check("assistant passes a granted permission", dep(helper) is helper)
dep2 = accounts.require("payments.review")
try:
    dep2(helper)
    check("assistant blocked from ungranted permission", False)
except HTTPException as e:
    check("assistant blocked from ungranted permission", e.status_code == 403)
try:
    accounts.admin_user(helper)
    check("assistant blocked from admin-only routes", False)
except HTTPException as e:
    check("assistant blocked from admin-only routes", e.status_code == 403)

accounts.update_assistant(helper["id"], accounts.AssistantUpdateBody(status="suspended"),
                          Req(), admin)
helper = db.handle.execute("SELECT * FROM users WHERE email='helper@emetai.rw'").fetchone()
check("suspended assistant recorded", helper["status"] == "suspended")

print("\n--- secrets at rest ---")
db.set_secret(db.handle, "test_key", "re_super_secret_value")
raw = db.get_setting(db.handle, "test_key")
check("secret is encrypted in the table", "re_super_secret_value" not in raw and raw.startswith("v1:"))
check("secret decrypts correctly", db.get_secret(db.handle, "test_key") == "re_super_secret_value")

print("\n--- audit + usage ---")
db.audit(admin, "test.action", "target", "detail", "1.2.3.4")
rows = db.handle.execute("SELECT * FROM audit_log WHERE action='test.action'").fetchall()
check("audit entry written", len(rows) == 1 and rows[0]["actor_email"] == "admin@emetai.rw")
logins = db.handle.execute("SELECT COUNT(*) c FROM audit_log WHERE action='auth.login'").fetchone()
check("logins are audited", int(logins["c"]) >= 2)
db.record_usage(church["id"], "verse_shown", "john 3:16")
u = db.handle.execute("SELECT * FROM usage_events WHERE event='verse_shown'").fetchone()
check("usage event recorded with day bucket", u and u["day"] == db.today())

import analytics  # noqa: E402
ov = analytics.overview(admin)
check("overview reports churches", ov["churches"] >= 1)
check("overview has a 30-day series", len(ov["series"]) == 30)
check("overview lists features", any(f["event"] == "verse_shown" for f in ov["features"]))
rows = analytics.church_activity("", "activity", admin)
check("per-church report includes the church", any(r["email"] == "jean@test.rw" for r in rows))
check("per-church counts verses", rows[0]["versesShown"] >= 1)
audit_rows = analytics.audit_log("", 50, admin)
check("audit log readable", len(audit_rows) > 0)

print("\n--- tiers, entitlements and quotas ---")
church = db.handle.execute("SELECT * FROM users WHERE email='jean@test.rw'").fetchone()
check("church with an active trial gets max", db.tier_of(db.handle, church) == "max")
db.revoke_subscriptions(db.handle, church["id"])
church = db.handle.execute("SELECT * FROM users WHERE email='jean@test.rw'").fetchone()
check("expired subscription falls back to FREE, not locked out",
      db.tier_of(db.handle, church) == "free")
check("free tier INCLUDES the AI ear", db.entitlements("free")["ai"] is True)
check("pro tier has the AI ear", db.entitlements("pro")["ai"] is True)
check("every tier hears the preacher",
      all(db.entitlements(t)["ai"] for t in ("free", "pro", "max")))
check("max tier is unlimited",
      db.entitlements("max")["brain_asks"] is None and db.entitlements("max")["clips"] is None)

ok_ask, why = db.within_quota(db.handle, church, "brain_ask")
check("free tier refused AI answers", not ok_ask and "Pro plan" in why)
ok_clip, why_clip = db.within_quota(db.handle, church, "clip_created")
check("free tier refused clips", not ok_clip)

db.grant_subscription(db.handle, church["id"], "pro_monthly")
church = db.handle.execute("SELECT * FROM users WHERE email='jean@test.rw'").fetchone()
check("pro_monthly grants the pro tier", db.tier_of(db.handle, church) == "pro")
check("pro tier allowed AI answers", db.within_quota(db.handle, church, "brain_ask")[0])
for _ in range(db.TIERS["pro"]["clips"]):
    db.record_usage(church["id"], "clip_created")
ok_clip, why_clip = db.within_quota(db.handle, church, "clip_created")
check("pro clip quota enforced after the allowance", not ok_clip and "Max" in why_clip)
check("pro AI answers still fine (separate quota)",
      db.within_quota(db.handle, church, "brain_ask")[0])

db.grant_subscription(db.handle, church["id"], "max_yearly")
church = db.handle.execute("SELECT * FROM users WHERE email='jean@test.rw'").fetchone()
check("max_yearly grants the max tier", db.tier_of(db.handle, church) == "max")
check("max has no clip limit", db.within_quota(db.handle, church, "clip_created")[0])

state = db.quota_state(db.handle, church)
check("quota state reports usage", state["clips"]["used"] >= db.TIERS["pro"]["clips"])
check("quota state reports unlimited as None", state["clips"]["limit"] is None)
check("admin always counts as max", db.tier_of(db.handle, admin) == "max")

check("yearly plans exist for both paid tiers",
      "pro_yearly" in db.PURCHASABLE and "max_yearly" in db.PURCHASABLE)
check("pro yearly is $210", db.PLANS["pro_yearly"]["price_usd"] == 210)
check("max yearly is $420", db.PLANS["max_yearly"]["price_usd"] == 420)
check("pro yearly saves exactly $30",
      db.PLANS["pro_monthly"]["price_usd"] * 12 - db.PLANS["pro_yearly"]["price_usd"] == 30)
for tier in ("pro", "max"):
    monthly = db.PLANS[f"{tier}_monthly"]["price_usd"] * 12
    yearly = db.PLANS[f"{tier}_yearly"]["price_usd"]
    pct = round((monthly - yearly) / monthly * 100, 1)
    check(f"{tier} yearly discount is 12.5%", pct == 12.5, f"got {pct}%")
check("a yearly plan really lasts a year", db.PLANS["max_yearly"]["days"] == 365)
check("retired plan names still resolve to a tier",
      db.PLANS["monthly"]["tier"] == "pro" and db.PLANS["yearly"]["tier"] == "max")

print("\n--- an undeliverable code no longer waves the sign-in through ---")
# This used to fall back to the password alone so a broken sender could not
# lock the owner out. Two-factor is required of everyone now, and the way back
# in is a recovery code — see test-2fa.py for that path end to end.
_real_send = mailer.send
mailer.send = lambda *a, **k: (False, "resend-403: You can only send testing emails to your own email address")
try:
    out = accounts.login(accounts.LoginBody(email="jean@test.rw", password="Amahoro2026Rw"), Req())
finally:
    mailer.send = _real_send
check("an undeliverable code does NOT sign anyone in", "token" not in out)
check("the sign-in still stops at the second factor", out.get("requires2fa") is True)
check("and says so plainly", "could not be emailed" in (out.get("notice") or ""))
# The reason still has to be named -- a bare "something went wrong" leaves the
# person guessing. It is named in words a church can act on now, rather than by
# sending them to resend.com/domains, which this assertion used to require: the
# person reading may be a visiting church, not whoever runs the server, and our
# provider's dashboard is no business of theirs.
_notice = (out.get("notice") or "").lower()
check("the real reason is named", "still in testing" in _notice
      and "sender address" in _notice)
check("and it is not internal plumbing", "resend" not in _notice
      and "admin →" not in _notice)
check("the recovery code is offered", "recovery code" in (out.get("notice") or "").lower())
check("the failed delivery is audited",
      int(db.handle.execute("SELECT COUNT(*) c FROM audit_log WHERE action='auth.2fa_undelivered'")
          .fetchone()["c"]) >= 1)
check("nothing is ever audited as a skipped second factor",
      int(db.handle.execute("SELECT COUNT(*) c FROM audit_log WHERE action='auth.2fa_skipped'")
          .fetchone()["c"]) == 0)

mailer.send = lambda *a, **k: (True, "sent")
try:
    out = accounts.login(accounts.LoginBody(email="jean@test.rw", password="Amahoro2026Rw"), Req())
finally:
    mailer.send = _real_send
check("a delivered code IS still required", out.get("requires2fa") is True and "token" not in out)


print("\n--- resend key validation ---")
# Every indirect probe proved unreliable in the field: a "Sending access" key is
# refused by /domains, and an empty create-email body does not authenticate
# cleanly either. The check is now the real operation — send one message and
# report exactly what Resend said. ONLY a credential error may block the save.
import io  # noqa: E402
import urllib.error  # noqa: E402

PROBE = {}


class _Resp:
    def read(self):
        return b'{"id":"abc-123"}'

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _probe_with(exc):
    """Run probe_key against a stubbed Resend response, recording the request."""
    original = mailer.urllib.request.urlopen

    def fake(req, *_a, **_k):
        PROBE["url"] = req.full_url
        PROBE["method"] = req.get_method()
        PROBE["payload"] = json.loads(req.data.decode())
        PROBE["auth"] = req.headers.get("Authorization", "")
        PROBE["headers"] = dict(req.headers)
        if exc is not None:
            raise exc
        return _Resp()

    mailer.urllib.request.urlopen = fake
    try:
        return mailer.probe_key("re_test_key_1234567890abcdef", "", "admin@example.rw")
    finally:
        mailer.urllib.request.urlopen = original


def _http(code, message="x"):
    body = io.BytesIO(json.dumps({"message": message}).encode())
    return urllib.error.HTTPError("https://api.resend.com/emails", code, message, {}, body)


delivered, status, detail = _probe_with(None)
check("a working key reports delivered", delivered and status == 200, detail)
check("the probe really sends — named recipient and subject",
      PROBE["payload"]["to"] == ["admin@example.rw"] and bool(PROBE["payload"]["subject"]))
check("probe posts to /emails", PROBE["url"] == "https://api.resend.com/emails")
check("key travels as a bearer token", PROBE["auth"].startswith("Bearer re_"))

delivered, status, detail = _probe_with(_http(401, "API key is invalid"))
check("bad credential detected", not delivered and status == 401)
check("bad credential BLOCKS the save", mailer.key_is_definitely_invalid(status, detail))

for code, msg, label in [
    (403, "You can only send testing emails to your own email address", "restricted recipient"),
    (403, "The domain is not verified", "unverified sender domain"),
    (422, "Invalid `from` field", "bad sender address"),
    (429, "Too many requests", "rate limited"),
    (500, "Server error", "Resend outage"),
    (0, "Could not reach Resend", "no internet"),
]:
    check(f"{label} does NOT block the save",
          not mailer.key_is_definitely_invalid(code, msg), f"HTTP {code}")

delivered, status, detail = _probe_with(urllib.error.URLError("network down"))
check("network failure reported but not fatal",
      not delivered and status == 0 and not mailer.key_is_definitely_invalid(status, detail))
check("Resend's own words are passed back to the admin",
      _probe_with(_http(403, "The domain is not verified"))[2] == "The domain is not verified")
check("the old indirect verify_key is gone — one code path only",
      not hasattr(mailer, "verify_key"))

# Resend is behind Cloudflare, which answers urllib's default
# "Python-urllib/3.x" signature with `error code: 1010` before the request ever
# reaches Resend — indistinguishable from a rejected key. This cost hours.
_probe_with(None)
check("Resend request identifies itself (Cloudflare blocks Python-urllib)",
      PROBE["headers"].get("User-agent", "").startswith("EmetAI/"),
      str(PROBE.get("headers")))
for module, name in ((mailer, "mailer"), (brain_mod, "brain")):
    src = inspect.getsource(module)
    check(f"{name} defines a User-Agent for outbound calls", "USER_AGENT" in src)

print("\n--- email providers ---")
# Two providers because they fail in opposite ways: Resend needs a verified
# domain, Brevo needs only a validated sender address.
check("both providers offered", set(mailer.PROVIDERS) == {"resend", "brevo"})
check("each keeps its own key setting",
      mailer.PROVIDERS["resend"]["key_setting"] != mailer.PROVIDERS["brevo"]["key_setting"])

name, addr = mailer.split_sender("EmetAI <noreply@getech.rw>")
check("sender name and address split for Brevo", name == "EmetAI" and addr == "noreply@getech.rw")
check("a bare address still works", mailer.split_sender("a@b.rw")[1] == "a@b.rw")

resend_body = mailer._payload("resend", "EmetAI <a@b.rw>", "to@c.rw", "S", "<b>H</b>", "T")
check("Resend payload shape", resend_body["from"] == "EmetAI <a@b.rw>"
      and resend_body["to"] == ["to@c.rw"] and resend_body["html"] == "<b>H</b>")
brevo_body = mailer._payload("brevo", "EmetAI <a@b.rw>", "to@c.rw", "S", "<b>H</b>", "T")
check("Brevo payload shape",
      brevo_body["sender"] == {"name": "EmetAI", "email": "a@b.rw"}
      and brevo_body["to"] == [{"email": "to@c.rw"}]
      and brevo_body["htmlContent"] == "<b>H</b>" and brevo_body["textContent"] == "T")

r_req = mailer._request("resend", "re_k", {})
b_req = mailer._request("brevo", "xkeysib-k", {})
check("Resend authenticates with a bearer token",
      r_req.headers.get("Authorization") == "Bearer re_k")
check("Brevo authenticates with the api-key header",
      b_req.headers.get("Api-key") == "xkeysib-k" and "Authorization" not in b_req.headers)
check("Brevo posts to its own endpoint", b_req.full_url == "https://api.brevo.com/v3/smtp/email")
check("both identify themselves to Cloudflare",
      r_req.headers.get("User-agent", "").startswith("EmetAI/")
      and b_req.headers.get("User-agent", "").startswith("EmetAI/"))

check("Brevo credential error blocks the save",
      mailer.key_is_definitely_invalid(401, "Key not found"))
check("Brevo sender-not-validated does NOT block the save",
      not mailer.key_is_definitely_invalid(400, "Sender not valid"))


print("\n--- sql injection ---")
evil = "'; DROP TABLE users; --"
try:
    accounts.login(accounts.LoginBody(email=evil, password=evil), Req())
except HTTPException:
    pass
analytics.church_activity(evil, "activity", admin)
analytics.audit_log(evil, 10, admin)
still = db.handle.execute("SELECT COUNT(*) c FROM users").fetchone()
check("users table intact after injection attempts", int(still["c"]) >= 3)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
