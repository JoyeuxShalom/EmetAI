# EmetAI email delivery.
#
# Two providers, because they fail in opposite ways:
#   Resend  needs a verified DOMAIN before it will write to anyone except the
#           account owner — excellent once you have one, useless before.
#   Brevo   validates a single SENDER ADDRESS by clicking a link in an email,
#           then delivers to anybody. No DNS, no domain, 300 a day free.
#
# The key and sender are set by the admin in Admin → Settings and stored
# encrypted. With nothing configured, codes print to the server console, so a
# church can still run the app on one laptop with no internet.

import json
import re
import ssl
import urllib.error
import urllib.request

import db

PROVIDER_SETTING = "email_provider"
FROM_SETTING = "resend_from"          # shared; the historical name is kept
RESEND_KEY_SETTING = "resend_api_key"
BREVO_KEY_SETTING = "brevo_api_key"
DEFAULT_FROM = "EmetAI <onboarding@resend.dev>"

# These APIs sit behind Cloudflare, which blocks urllib's default
# "Python-urllib/3.x" signature outright with `error code: 1010` before the
# request ever arrives. That looked exactly like a rejected API key.
USER_AGENT = "EmetAI/1.0 (+https://emetai.rw)"

PROVIDERS = {
    "resend": {
        "label": "Resend",
        "url": "https://api.resend.com/emails",
        "key_setting": RESEND_KEY_SETTING,
        "key_prefix": "re_",
        "key_hint": "re_…",
        "where": "resend.com → API Keys",
        "note": "Needs a verified domain before it can email anyone but the "
                "account owner. Best deliverability once you have one.",
        "ok_status": (200, 201),
    },
    "brevo": {
        "label": "Brevo",
        "url": "https://api.brevo.com/v3/smtp/email",
        "key_setting": BREVO_KEY_SETTING,
        "key_prefix": "xkeysib-",
        "key_hint": "xkeysib-…",
        "where": "brevo.com → SMTP & API → API Keys",
        "note": "Validate one sender address by clicking a link in your inbox — "
                "no domain needed. 300 emails a day free.",
        "ok_status": (200, 201),
    },
}

INK = "#070B14"
INK_SOFT = "#0C1220"
GOLD = "#F5C451"
PARCHMENT = "#EDE6D6"
DIM = "#8C93A6"

_ssl_ctx = ssl.create_default_context()


def provider() -> str:
    name = db.get_setting(db.handle, PROVIDER_SETTING, "resend")
    return name if name in PROVIDERS else "resend"


def api_key(name: str | None = None) -> str:
    return db.get_secret(db.handle, PROVIDERS[name or provider()]["key_setting"])


def is_configured() -> bool:
    return bool(api_key())


def sender_problem(provider_name: str, value: str) -> str | None:
    """Why this sender address cannot work with this provider, if it cannot.

    onboarding@resend.dev is Resend's own shared sender. Through Resend it
    works, because Resend is authorised to send as its own domain. Through
    anyone else it is guaranteed to fail, and to fail in the worst way: the
    provider accepts the message, reports it as sent, and every receiving
    server on earth then refuses it, because resend.dev publishes

        v=DMARC1; p=reject; pct=100          reject anything unauthenticated
        v=spf1 include:_spf.google.com -all  hard fail for non-Google senders

    A real install lost an evening to this -- five test messages, each shown
    as "Sent" in the provider's dashboard and each rejected on delivery, with
    nothing in any inbox and no explanation anywhere. Catch it where the
    address is set instead.
    """
    address = split_sender(value)[1].lower()
    if not address or "@" not in address:
        return "That does not look like an email address."
    domain = address.rsplit("@", 1)[1]
    if domain == "resend.dev" and provider_name != "resend":
        return (
            f"{PROVIDERS[provider_name]['label']} cannot send as "
            f"{address}. That is Resend's own address, and resend.dev tells "
            "every mail server to reject anything Resend did not send — so "
            "the message is accepted, reported as sent, and then refused on "
            "delivery. Use the address you validated with "
            f"{PROVIDERS[provider_name]['label']} instead."
        )
    return None


def sender() -> str:
    return db.get_setting(db.handle, FROM_SETTING, "") or DEFAULT_FROM


def split_sender(value: str) -> tuple[str, str]:
    """"EmetAI <a@b.rw>" -> ("EmetAI", "a@b.rw"). Brevo wants them apart."""
    match = re.match(r"^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$", value or "")
    if match:
        return match.group(1).strip('" ') or "EmetAI", match.group(2)
    return "EmetAI", (value or "").strip()


def _request(name: str, key: str, payload: dict) -> urllib.request.Request:
    spec = PROVIDERS[name]
    headers = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }
    if name == "brevo":
        headers["api-key"] = key
    else:
        headers["Authorization"] = f"Bearer {key}"
    return urllib.request.Request(
        spec["url"], data=json.dumps(payload).encode("utf-8"),
        headers=headers, method="POST",
    )


def _payload(name: str, from_value: str, to: str, subject: str, html: str, text: str) -> dict:
    if name == "brevo":
        display, address = split_sender(from_value)
        return {
            "sender": {"name": display, "email": address},
            "to": [{"email": to}],
            "subject": subject,
            "htmlContent": html,
            "textContent": text,
        }
    return {"from": from_value, "to": [to], "subject": subject, "html": html, "text": text}


def _error_text(raw: str) -> str:
    """Both providers report failures as JSON with a `message` field."""
    try:
        data = json.loads(raw)
        return data.get("message") or data.get("error") or raw
    except Exception:
        return raw


def _log(line: str = "") -> None:
    """Console output that can never crash a request on a cp1252 terminal."""
    try:
        print(line, flush=True)
    except Exception:
        print(line.encode("ascii", "replace").decode(), flush=True)


def _fallback(to: str, subject: str, text: str, reason: str) -> None:
    """Print a message that could not be delivered.

    Sign-in codes travel by email, so a delivery failure would otherwise lock
    the account owner out of their own software with no way back in. Whatever
    goes wrong, the code always reaches the person at the server.
    """
    _log("\n" + "=" * 68)
    _log(f"  EMAIL NOT DELIVERED - message for {to}")
    _log(f"  Reason : {reason}")
    _log(f"  Subject: {subject}")
    _log("  " + "-" * 64)
    for line in text.strip().splitlines():
        _log(f"  {line}")
    _log("=" * 68 + "\n")


def send(to: str, subject: str, html: str, text: str) -> tuple[bool, str]:
    """Deliver one message through the chosen provider. Never raises."""
    name = provider()
    key = api_key(name)
    if not key:
        _fallback(to, subject, text, "Email is not connected yet.")
        return False, "email-not-configured"

    label = PROVIDERS[name]["label"]
    req = _request(name, key, _payload(name, sender(), to, subject, html, text))
    try:
        with urllib.request.urlopen(req, timeout=20, context=_ssl_ctx) as r:
            r.read()
        return True, "sent"
    except urllib.error.HTTPError as e:
        raw = ""
        try:
            raw = e.read().decode("utf-8")
        except Exception:
            pass
        detail = _error_text(raw)
        _fallback(to, subject, text, f"{label} refused it (HTTP {e.code}): {detail}")
        return False, f"{name}-{e.code}: {detail}"[:300]
    except Exception as e:
        _fallback(to, subject, text, f"{label} could not be reached: {e}")
        return False, "email-unreachable"


def probe_key(key: str, from_address: str, to: str,
              name: str | None = None) -> tuple[bool, int, str]:
    """Verify a key by doing the real thing — sending one small message.

    Every indirect check proved unreliable, so the test is the operation
    itself. Nothing is guessed, and the provider's own words are handed back
    to the administrator.

    Returns (delivered, http_status, message). Status 0 means the provider
    could not be reached at all.
    """
    name = name or provider()
    label = PROVIDERS[name]["label"]
    payload = _payload(
        name,
        from_address or DEFAULT_FROM,
        to,
        "EmetAI email is working",
        _shell(
            "Email is working",
            f"This is the check EmetAI ran when your {label} key was saved. Sign-in "
            "codes, email confirmations and password resets will arrive like this.",
            "",
        ),
        "EmetAI test message — email delivery is working.",
    )
    try:
        with urllib.request.urlopen(
            _request(name, key, payload), timeout=20, context=_ssl_ctx
        ) as r:
            body = r.read().decode("utf-8")
        _log(f"[mail] key check accepted by {label}: {body[:160]}")
        return True, 200, "sent"
    except urllib.error.HTTPError as e:
        raw = ""
        try:
            raw = e.read().decode("utf-8")
        except Exception:
            pass
        _log(f"[mail] key check refused by {label}: HTTP {e.code} {raw[:300]}")
        return False, e.code, _error_text(raw) or f"{label} returned HTTP {e.code}"
    except Exception as e:
        _log(f"[mail] key check could not reach {label}: {e}")
        return False, 0, f"Could not reach {label} — check the internet connection."


def key_is_definitely_invalid(status: int, message: str) -> bool:
    """True only when the provider says the credential itself is wrong.

    Anything else — an unverified sender, a restricted test recipient, a
    network failure — is not the key's fault and must not block saving it.
    Resend answers 401 "API key is invalid"; Brevo answers 401 with
    "Key not found" or "unauthorized".
    """
    if status != 401:
        return False
    lowered = (message or "").lower()
    return any(s in lowered for s in ("api key", "key not found", "unauthorized", "api-key"))


# ------------------------------------------------------------- templates ----

def _shell(heading: str, intro: str, body_html: str, footer: str = "") -> str:
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:{INK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:{INK};padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:{INK_SOFT};border:1px solid rgba(237,230,214,0.10);
                    border-radius:16px;padding:36px 32px;">
        <tr><td>
          <p style="margin:0 0 26px;font:600 13px/1 -apple-system,Segoe UI,Roboto,sans-serif;
                    letter-spacing:.32em;text-transform:uppercase;color:{GOLD};">EmetAI</p>
          <h1 style="margin:0 0 12px;font:500 25px/1.3 Georgia,serif;color:{PARCHMENT};">{heading}</h1>
          <p style="margin:0 0 26px;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;
                    color:{DIM};">{intro}</p>
          {body_html}
          <p style="margin:28px 0 0;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;
                    color:{DIM};">{footer}</p>
          <hr style="border:none;border-top:1px solid rgba(237,230,214,0.08);margin:28px 0 16px;">
          <p style="margin:0;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#5C6478;">
            EmetAI — Ijambo ry'Imana, ku mwanya. · The Word of God, on time.<br>
            This message was sent automatically; please do not reply.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def _code_block(code: str) -> str:
    return (
        f'<div style="background:{INK};border:1px solid {GOLD}55;border-radius:12px;'
        f'padding:20px;text-align:center;">'
        f'<span style="font:600 34px/1 -apple-system,Segoe UI,Roboto,sans-serif;'
        f'letter-spacing:.34em;color:{GOLD};">{code}</span></div>'
    )


def send_login_code(to: str, name: str, code: str, ip: str = "") -> tuple[bool, str]:
    where = f" from {ip}" if ip else ""
    html = _shell(
        "Your sign-in code",
        f"Hello {name or 'there'} — someone is signing in to your EmetAI account{where}. "
        "Enter this code to finish:",
        _code_block(code),
        "The code expires in 10 minutes. If this wasn't you, change your password now — "
        "somebody else knows it.",
    )
    text = (f"Your EmetAI sign-in code is {code}. It expires in 10 minutes.\n"
            "If this wasn't you, change your password immediately.")
    return send(to, f"{code} is your EmetAI sign-in code", html, text)


def send_verify_code(to: str, name: str, code: str) -> tuple[bool, str]:
    html = _shell(
        "Confirm your email",
        f"Welcome, {name or 'friend'}. Enter this code in EmetAI to confirm this address "
        "and activate your 14-day free trial:",
        _code_block(code),
        "The code expires in 10 minutes. If you didn't create an EmetAI account, ignore this email.",
    )
    text = f"Your EmetAI confirmation code is {code}. It expires in 10 minutes."
    return send(to, f"{code} — confirm your EmetAI email", html, text)


def send_reset_code(to: str, name: str, code: str) -> tuple[bool, str]:
    html = _shell(
        "Reset your password",
        f"Hello {name or 'there'} — use this code to set a new EmetAI password:",
        _code_block(code),
        "The code expires in 10 minutes. If you didn't ask for this, no action is needed — "
        "your password has not changed.",
    )
    text = f"Your EmetAI password reset code is {code}. It expires in 10 minutes."
    return send(to, f"{code} — reset your EmetAI password", html, text)


def send_new_device_alert(to: str, name: str, ip: str, agent: str) -> tuple[bool, str]:
    rows = (
        f'<div style="background:{INK};border:1px solid rgba(237,230,214,0.10);border-radius:12px;'
        f'padding:18px;font:400 14px/1.8 -apple-system,Segoe UI,Roboto,sans-serif;color:{PARCHMENT};">'
        f'<b style="color:{GOLD};">Address:</b> {ip or "unknown"}<br>'
        f'<b style="color:{GOLD};">Device:</b> {(agent or "unknown")[:120]}</div>'
    )
    html = _shell(
        "New sign-in to your account",
        f"Hello {name or 'there'} — your EmetAI account was just opened on a device we "
        "hadn't seen before.",
        rows,
        "If this was you, nothing to do. If it wasn't, change your password and sign out "
        "everywhere from Account → Security.",
    )
    text = f"New EmetAI sign-in from {ip or 'unknown'} ({(agent or 'unknown')[:120]})."
    return send(to, "New sign-in to your EmetAI account", html, text)


def send_assistant_invite(to: str, name: str, password: str, powers: list[str]) -> tuple[bool, str]:
    listed = "".join(f"<li>{p}</li>" for p in powers) or "<li>No permissions yet</li>"
    body = (
        f'<div style="background:{INK};border:1px solid {GOLD}55;border-radius:12px;padding:20px;">'
        f'<p style="margin:0 0 8px;font:400 14px -apple-system,Segoe UI,Roboto,sans-serif;color:{DIM};">'
        f'Temporary password</p>'
        f'<span style="font:600 22px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.12em;'
        f'color:{GOLD};">{password}</span></div>'
        f'<p style="margin:22px 0 6px;font:400 15px -apple-system,Segoe UI,Roboto,sans-serif;'
        f'color:{PARCHMENT};">You can:</p>'
        f'<ul style="margin:0;padding-left:20px;font:400 14px/1.7 -apple-system,Segoe UI,Roboto,'
        f'sans-serif;color:{DIM};">{listed}</ul>'
    )
    html = _shell(
        "You're now an EmetAI assistant",
        f"Hello {name or 'there'} — the EmetAI administrator has given you an assistant account. "
        "Sign in with this email and the temporary password below; you'll be asked to choose "
        "your own password right away.",
        body,
        "Never share this password. It only works until you set your own.",
    )
    text = (f"You are now an EmetAI assistant. Temporary password: {password}\n"
            "Sign in and change it immediately.")
    return send(to, "Your EmetAI assistant account", html, text)
