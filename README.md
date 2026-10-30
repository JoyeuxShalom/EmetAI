# EmetAI — The scripture in an instant

**Emet (אמת) means Truth in Hebrew.** EmetAI is an AI platform for Rwandan churches:
it listens to the preacher — in **Kinyarwanda, English or French** — and projects the
exact scripture on the screen the moment it is spoken, with verse numbering mapped
correctly across Bible versions. It also cuts YouTube sermons into caption-burned,
social-ready clips.

---

## What's inside

| Piece | What it does |
| --- | --- |
| **Studio** (`#/app`) | The operator cockpit: AI ear, live transcript, search, preview → go live, queue, detections |
| **Display** (`#display`) | The projector window — beautiful trilingual verse projection |
| **Clips** (`#/clips`) | Paste a YouTube sermon → AI finds the most powerful moments → captioned clips (9:16 or original) |
| **Account** (`#/account`) | Subscription status, Mobile Money renewal, change password |
| **Admin** (`#/admin`) | Stats, payment approvals, church management (grant / extend / revoke) |
| **Backend** (`server/`) | FastAPI + SQLite: auth (PBKDF2 + signed tokens), subscriptions with expiry enforcement, clipper jobs, the AI ear websocket |

## Requirements

- **Node.js 18+** and **Python 3.11+**
- Python packages:
  ```
  pip install fastapi uvicorn numpy faster-whisper yt-dlp imageio-ffmpeg
  ```
- (Once) the Kinyarwanda speech model — see below.

## Install on a church computer (the "download" way)

1. Copy this folder to the computer (USB stick or zip).
2. Install Python 3.11+ and the packages above, then build the app once:
   `npm install && npm run build`
3. From then on: **double-click `EmetAI.bat`** — it starts the backend and opens
   EmetAI in its own window at `http://localhost:8765`. One process, no terminals.

## Run it for development (two terminals)

```bash
# 1. Backend — API + AI ear + clipper on port 8765
cd server
python app.py

# 2. Frontend — Vite dev server on port 5173
npm install
npm run dev
```

Open **http://localhost:5173**. On the backend's **first run** an admin account is
created and its password is printed to the console (and saved to
`server/data/ADMIN_CREDENTIALS.txt` — sign in, change the password, delete the file).

## The Kinyarwanda ear (one-time setup)

EN/FR use faster-whisper's multilingual `base` model (downloads automatically).
Kinyarwanda uses the open
[DigitalUmuganda whisper_small_kinyarwanda](https://huggingface.co/DigitalUmuganda/whisper_small_kinyarwanda)
fine-tune (trained on Common Voice Kinyarwanda), converted once to CTranslate2:

```bash
pip install transformers ctranslate2 torch --extra-index-url https://download.pytorch.org/whl/cpu
python -m ctranslate2.converters.transformers --model DigitalUmuganda/whisper_small_kinyarwanda \
  --output_dir server/models/rw-ct2 --quantization int8
```

(The stronger [mbazaNLP/Whisper-Small-Kinyarwanda](https://huggingface.co/mbazaNLP/Whisper-Small-Kinyarwanda)
is gated — if you request access with your own Hugging Face account you can convert
it the same way and drop it in the same folder.)

**Speak references in any tradition.** "Joel 2:28" (English numbering) and
"Yoweli 3:1" (Kinyarwanda/French numbering) are the same verse — EmetAI resolves
whichever one the preacher says, spoken or typed.

## Accounts & subscriptions

- Every new church gets a **14-day free trial** automatically.
- Plans: **Monthly $20** · **Yearly $240** (edit `PLANS` in `server/db.py`).
- Renewal flow: church pays by MTN MoMo → submits the transaction ID on the Account
  page → admin approves in the dashboard → access extends instantly.
  Set your MoMo pay code in `src/pages/Account.tsx` (`MOMO_CODE`).
- The moment a subscription expires the Studio locks and asks for renewal.

## Security notes

- Passwords: PBKDF2-HMAC-SHA256, 210k iterations, per-user salt.
- **Two-factor authentication (TOTP)**: any user can enable it on the Account page —
  works with Google/Microsoft Authenticator and Authy, fully offline, no SMS costs.
- Sessions: HMAC-SHA256 signed tokens (12h), secret generated on disk (`server/data/secret.key`).
- Login rate limiting (5 tries / 10 min), role-checked admin routes,
  subscription checks server-side, clip downloads token-checked.
- All data lives in one SQLite database at `server/data/emetai.db` (WAL mode) —
  back it up by copying that file. Everything runs locally / on your own server —
  no paid services.

## Sermon clips studio

Paste a YouTube link, choose clip length (1:30–3:00), count, format
(9:16 vertical for Reels/TikTok/Shorts or original), and language.
The pipeline: `yt-dlp` download → `faster-whisper` transcription →
viral-moment scoring (trilingual keyword + scripture-reference heuristics) →
`ffmpeg` cut with styled burned-in captions.

## Bibles

Local (offline, in `public/bibles/`): Bibiliya Yera (Kinyarwanda), KJV, WEB, ASV,
BBE, Louis Segond 1910, Martin 1744. Online via YouVersion (needs
`VITE_YVP_APP_KEY` in `.env.local`): NIV, La Bible du Semeur.
Versification differences are handled by `mappings.json` + `overrides.json`
(regenerate with `scripts/build-mappings.mjs`).

## Keyboard (Studio)

`Enter` stage · `Ctrl+Enter` go live · `Esc` clear · `←`/`→` walk the chapter ·
**Suggest** mode stages detections for you; **Auto** mode projects them instantly.
