# EmetAI ear — streaming speech-to-text over WebSocket (faster-whisper).
# EN/FR ride the multilingual base model; Kinyarwanda uses the mbazaNLP
# Whisper-Small-Kinyarwanda fine-tune converted to CTranslate2.

import asyncio
import concurrent.futures
import json
import os
import threading

import numpy as np
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from accounts import admin_user
from security import verify_token

SAMPLE_RATE = 16000
# A breath is not the end of a sentence. These used to be tuned purely for
# speed — 0.35s of quiet closed the utterance — which shredded speech into
# sub-second fragments. Whisper needs a second or two of audio to do good
# work, and the browser now reassembles whole sentences anyway (see
# src/lib/utterance.ts), so the ear can afford to hand over real phrases.
SILENCE_SECS = 0.65        # a genuine pause, not a breath
CHUNK_SECS = 0.8           # interim transcription cadence
MAX_UTTERANCE_SECS = 12.0  # a long sentence is still one sentence
# The remote ear hears whole thoughts rather than phrases — see the loop.
# 0.6, not the 0.9 this started at: latency was measured to be flat in audio
# length (a 2s clip and an 11s clip both cost ~2.5s), so waiting longer for a
# fuller sentence buys context but costs the operator real time on every single
# utterance. 0.6 is still well clear of the pause between words.
REMOTE_SILENCE_SECS = 0.6
REMOTE_MAX_UTTERANCE_SECS = 20.0
# Interims for the remote ear are decoded locally, so they only look at the
# newest speech — a shorter tail decodes faster and the live line keeps up.
REMOTE_INTERIM_TAIL_SECS = 3.0
# …and rarely. A Whisper pass uses every core it can get, so a live decode
# every 0.8s starved the event loop and pushed the final — the one that puts
# scripture on the wall — from 2.7s out to 8.5s. Measured. The live line is a
# courtesy; the final is the product.
REMOTE_CHUNK_SECS = 2.5

# The remote ear's finals are network calls, not CPU work, so they get their
# own threads and never wait behind a local decode. See run_transcribe().
FINAL_POOL_WORKERS = 4
FINAL_POOL = concurrent.futures.ThreadPoolExecutor(
    max_workers=FINAL_POOL_WORKERS, thread_name_prefix="ear-final"
)
# The offline safety net gets its own threads as well. Sharing FINAL_POOL would
# let a run of local decodes fill it and leave the network call queued behind
# them — which is the exact starvation the separate pool exists to prevent.
SAFETY_POOL = concurrent.futures.ThreadPoolExecutor(
    max_workers=2, thread_name_prefix="ear-safety"
)
# How long the ear will wait for Gemini before falling back to the offline
# model. Typical is ~2.5s; a rate-limited key retrying on the slower model was
# measured at 13.3s, which is far past the point where a verse is still useful.
GEMINI_DEADLINE_SECS = 5.0
# …but when the offline safety net is not allowed to answer — a Kinyarwanda
# room, where the English model would fabricate rather than fall back — there
# is nothing to switch TO, so the deadline stops being a trade and becomes a
# pure loss. A line that arrives late is still a line; a line that is dropped
# is gone from the transcript and from the service record. Measured in a live
# run: a fourth utterance was lost this way while Gemini was merely slow.
GEMINI_NO_FALLBACK_DEADLINE_SECS = 12.0
# How often a live ear re-checks its session, in audio chunks (~0.256s each).
# 700 ≈ every three minutes: often enough to keep a three-hour service's
# session from going idle, rare enough to be invisible.
SESSION_CHECK_CHUNKS = 700
MIN_TRANSCRIBE_SECS = 0.4  # short is better than silently discarded
INTERIM_TAIL_SECS = 6.0    # interims decode only the newest speech
PREROLL_SECS = 0.4         # keep what came just before the gate opened

# ---- Knowing speech from silence, in whatever room this is ----
#
# This was a fixed RMS threshold, and that is why the ear could look completely
# dead: a quieter microphone — a different laptop, a lapel mic, gain set low —
# never crossed it, so nothing was ever buffered and not one word was ever
# transcribed. Nothing about that failure was visible; the ear simply said
# nothing, in every language.
#
# So learn the room instead. Track the quietest recent level as the noise
# floor and call it speech when a chunk stands clearly above it, with a floor
# and a ceiling so neither a silent room nor a roaring one can break the gate.
# Asymmetric on purpose: the floor drops quickly so a quiet room is learned in
# about a second, and rises slowly so a long sentence cannot drag the gate up
# behind itself and deafen the ear halfway through a verse.
FLOOR_FALL_ALPHA = 0.25    # quiet chunk: learn it fast
FLOOR_RISE_ALPHA = 0.02    # louder chunk: creep up
SPEECH_OVER_FLOOR = 2.5    # speech is this many times the noise floor
ABS_MIN_ENERGY = 0.0015    # below this it is electrical noise, not a voice
ABS_MAX_ENERGY = 0.020     # never demand more than this, however loud the room

# Whether this machine runs the offline speech models at all.
#
# On a church laptop: yes. They are the offline ears, and the safety net when
# the connection is slow.
#
# On a small cloud server: often no. The remote ear does the listening, and
# the models cost ~1 GB of RAM plus a 239 MB download that a free-tier
# instance may not have room for. Set EMETAI_LOCAL_EARS=0 and EmetAI runs
# lean - Gemini ear only, and it says so plainly rather than offering an ear
# it cannot provide.
LOCAL_EARS = os.environ.get("EMETAI_LOCAL_EARS", "1").strip() not in ("0", "false", "no")

FW_MODEL_SIZE = "base"  # EN/FR model: "base" fast, "small" more accurate
RW_MODEL_DIR = os.path.join(os.path.dirname(__file__), "models", "rw-ct2")

# lang -> (model source, whisper language token)
CONFIG = {
    "en": (FW_MODEL_SIZE, "en"),
    "fr": (FW_MODEL_SIZE, "fr"),
    # The Kinyarwanda fine-tune rides on the Swahili token (per its model card).
    "rw": (RW_MODEL_DIR, "sw"),
    # The Gemini ear. Not a local model at all — the utterance is sent to
    # Gemini, which transcribes it far more accurately than either the browser
    # recogniser or a small Whisper fine-tune, and does not care which language
    # it is hearing. See transcribe_with_gemini().
    "auto": ("gemini", ""),
}

# Languages the Gemini ear expects to hear. A church with an interpreter has
# two people speaking two languages into the same room, and the ear has to
# follow both — the preacher in Kinyarwanda and the interpreter in English,
# turn about, without anyone switching a setting.
GEMINI_LANGUAGES = "Kinyarwanda, English or French"

# Below this there is not enough speech to be worth a round trip, and above it
# a single utterance is long enough that it should already have been cut.
GEMINI_MIN_SECS = 0.6
GEMINI_MAX_SECS = 25.0

router = APIRouter()
_engines = {}
# Loading is not thread-safe, and it is now reached from three directions at
# once — the startup preload, a connection warming its model, and the safety
# net. Without this the same model could be built twice concurrently.
_engine_lock = threading.Lock()


def get_engine(lang: str):
    source, _token = CONFIG[lang]
    if source in _engines:
        return _engines[source]
    with _engine_lock:
        return _load_engine(lang)


def _load_engine(lang: str):
    source, _token = CONFIG[lang]
    if source not in _engines:
        from faster_whisper import WhisperModel

        if lang == "rw" and not os.path.isdir(source):
            raise RuntimeError(
                "The Kinyarwanda model is not installed on this computer. "
                "Run the one-time setup in the README (creates server/models/rw-ct2)."
            )
        print(f"Loading faster-whisper model '{source}' (int8)…")
        _engines[source] = WhisperModel(
            source,
            device="cpu",
            compute_type="int8",
            cpu_threads=max(4, os.cpu_count() or 4),  # use the whole CPU
        )
        print(f"Model '{source}' ready.")
    return _engines[source]


def preload_engines():
    """Warm the models at server startup so the first Listen is instant.

    In parallel, and timed. Loaded one after another the Kinyarwanda model —
    the slow one, around half a minute on a laptop — held English behind it,
    and anyone who pressed Listen in that window sat looking at a dead button
    with no idea why."""
    import time

    def _load(lang: str):
        started = time.time()
        try:
            get_engine(lang)
            print(f"[preload] {lang} ready in {time.time() - started:.1f}s")
        except Exception as e:
            print(f"[preload] {lang} unavailable: {e}")

    if LOCAL_EARS:
        for lang in ("en", "rw"):
            threading.Thread(target=_load, args=(lang,), daemon=True).start()
    else:
        print("[preload] offline ears disabled (EMETAI_LOCAL_EARS=0)")

    # The remote ear has a cold start too, and it is the expensive one — see
    # warm_gemini(). Paid here so the first verse of the first service is as
    # fast as the fiftieth.
    threading.Thread(target=warm_gemini, daemon=True).start()


def _wav_bytes(audio: np.ndarray) -> bytes:
    """16-bit mono WAV at 16 kHz — what the API wants, from what we capture."""
    import io
    import wave

    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buffer.getvalue()


GEMINI_HOST = "generativelanguage.googleapis.com"
# One HTTPS connection per worker thread, kept open across utterances. A fresh
# connection pays a TCP and TLS handshake every single time — measured at about
# 0.2s here, and a church on a slow link pays considerably more than that. The
# connection is per-thread because http.client is not safe to share.
_conn_local = threading.local()


def _gemini_post(path: str, body: bytes, headers: dict, timeout: float) -> dict:
    """POST to Gemini over a kept-alive connection.

    An idle connection can be closed by the far end at any time, so a socket
    error retries once on a fresh one. An HTTP error status is NOT a socket
    error and is raised as-is — the caller distinguishes 429 from a dropped
    connection and must keep being able to.
    """
    import http.client
    import io
    import json as _json
    import urllib.error

    for attempt in (1, 2):
        conn = getattr(_conn_local, "conn", None)
        if conn is None:
            conn = http.client.HTTPSConnection(GEMINI_HOST, timeout=timeout)
            _conn_local.conn = conn
        try:
            conn.request("POST", path, body=body, headers=headers)
            res = conn.getresponse()
            payload = res.read()
            status, reason, head = res.status, res.reason, res.headers
        except (http.client.HTTPException, OSError):
            try:
                conn.close()
            except Exception:
                pass
            _conn_local.conn = None
            if attempt == 2:
                raise
        else:
            if status >= 400:
                raise urllib.error.HTTPError(
                    f"https://{GEMINI_HOST}{path}", status, reason, head,
                    io.BytesIO(payload),
                )
            return _json.loads(payload.decode("utf-8"))
    raise RuntimeError("unreachable")


def warm_gemini() -> None:
    """Pay the cold-start costs before anyone speaks, not during the sermon.

    Measured on a fresh process: the first call took 7.95s and the next three
    1.81s, 2.34s and 1.78s. Two things are cold. The model id is resolved by an
    extra request to the models list, and every worker thread has to complete
    its own TLS handshake. With a four-thread pool that meant the first four
    utterances of a service each blew the deadline — and in a Kinyarwanda room,
    where the offline safety net is not allowed to answer, blowing the deadline
    means the operator sees nothing at all. That is what "the ear is not
    listening" looked like.

    A barrier is used so all the workers are occupied at once, which is what
    forces the pool to actually create every thread; otherwise one fast thread
    would serve every warm-up task and the rest would stay cold.
    """
    import http.client

    import brain
    import db

    key = db.get_secret(db.handle, brain.GEMINI_KEY_SETTING)
    if not key:
        return

    workers = FINAL_POOL_WORKERS
    barrier = threading.Barrier(workers)

    def _warm():
        try:
            brain.pick_gemini_lite_model(key)   # cached process-wide after this
            try:
                barrier.wait(timeout=15)
            except Exception:
                pass
            conn = getattr(_conn_local, "conn", None)
            if conn is None:
                conn = http.client.HTTPSConnection(GEMINI_HOST, timeout=45)
                _conn_local.conn = conn
            if conn.sock is None:
                conn.connect()                  # the TLS handshake, now
        except Exception as e:
            print(f"[ear] warm-up skipped: {e}")

    for _ in range(workers):
        FINAL_POOL.submit(_warm)


def transcribe_with_gemini(audio: np.ndarray, hint: str = "") -> tuple[str, str]:
    """Transcribe one utterance with Gemini. Returns (text, language).

    This exists because the browser recogniser mangles accented English into
    nonsense — a real service produced "Pedic", "Nickelodeon" and "condos" out
    of a reading from Deuteronomy 23 — and nonsense fed into verse matching
    puts the wrong scripture on the wall. Gemini transcribes the same audio
    correctly and does not need telling which language it is hearing, which is
    exactly what a church with an interpreter needs.
    """
    import base64
    import json as _json
    import urllib.error
    import urllib.request

    import brain
    import db

    key = db.get_secret(db.handle, brain.GEMINI_KEY_SETTING)
    if not key:
        raise RuntimeError(
            "The Gemini ear needs a Gemini key. Add one in Admin → Emet brain, "
            "or choose one of the offline ears."
        )

    secs = audio.size / SAMPLE_RATE
    if secs < GEMINI_MIN_SECS:
        return "", ""
    if secs > GEMINI_MAX_SECS:
        audio = audio[-int(SAMPLE_RATE * GEMINI_MAX_SECS):]

    # The vocabulary hint is what makes this ear get better at ONE church.
    # Recognition is a search over what is plausible, and a name it has never
    # met is not in that search until we put it there — which is exactly why a
    # Kinyarwanda book title or an apostle's name comes back as nonsense.
    # Measured, not assumed: a bare list of words in three languages makes the
    # model treat it as a normalisation target — it heard "Yesaya" and wrote
    # "Isaiah", which is the one thing this ear must never do. The list is a
    # spelling aid for names, and it has to say so.
    vocabulary = (
        "\nThese names may come up. They are SPELLINGS, not translations: if a "
        "name is spoken in Kinyarwanda write the Kinyarwanda form, if in "
        "English the English form. Never swap one for the other, and never "
        "replace a word you heard clearly with one from this list.\n"
        f"{hint}\n" if hint else ""
    )
    instruction = (
        "Transcribe this recording of a church service word for word.\n"
        f"The speaker may be using {GEMINI_LANGUAGES}.\n"
        "Two languages are normal in one recording and you must handle both:\n"
        "• A preacher and an interpreter take turns — a Kinyarwanda sentence "
        "followed by its English interpretation. Transcribe BOTH, in the order "
        "spoken, each in its own language.\n"
        "• One sentence may mix languages — a Kinyarwanda sentence containing "
        "English words, or an English verse quoted inside Kinyarwanda speech. "
        "Write each word in the language it was actually spoken in. Never "
        "force a mixed sentence into one language.\n"
        f"{vocabulary}"
        "Transcribe the WHOLE recording, from the first word to the last. Never "
        "leave out a sentence because it is unclear or in the harder language — "
        "a dropped sentence is the interpreter's whole turn missing. If a "
        "passage is hard, write your best attempt at it.\n"
        "Write exactly what is said. Do not translate, summarise, correct or "
        "add anything. If nothing is clearly said, return an empty string.\n"
        'Reply as JSON: {"text": "...", "lang": "rw" | "en" | "fr" | "mixed"}\n'
        'Use "mixed" when more than one language is spoken in the recording.'
    )
    payload = {
        "contents": [{"role": "user", "parts": [
            {"text": instruction},
            {"inline_data": {"mime_type": "audio/wav",
                             "data": base64.b64encode(_wav_bytes(audio)).decode()}},
        ]}],
        "generationConfig": {
            "maxOutputTokens": 1024,
            "responseMimeType": "application/json",
            # Transcription is perception, not reasoning; thinking about it
            # only adds delay.
            "thinkingConfig": {"thinkingLevel": "low"},
        },
    }
    body = _json.dumps(payload).encode("utf-8")

    for attempt in (1, 2):
        # The light model transcribes as well as the large one here — measured
        # on the same clip: identical words, 2.5s against 2.4s — and has a far
        # roomier free allowance, which matters when every utterance is a call.
        model = (brain.pick_gemini_lite_model(key) if attempt == 1
                 else brain.pick_gemini_model(key))
        try:
            data = _gemini_post(
                f"/v1beta/models/{model}:generateContent",
                body,
                {"content-type": "application/json", "x-goog-api-key": key,
                 "user-agent": brain.USER_AGENT},
                timeout=45,
            )
            parts = data["candidates"][0]["content"]["parts"]
            heard = _json.loads("".join(p.get("text", "") for p in parts))
            return str(heard.get("text", "")).strip(), str(heard.get("lang", "")).strip()
        except urllib.error.HTTPError as e:
            print(f"[ear] Gemini transcription HTTP {e.code} (attempt {attempt})")
            if e.code in (429, 500, 502, 503) and attempt == 1:
                continue
            raise
        except Exception as e:
            print(f"[ear] Gemini transcription failed: {e}")
            raise
    return "", ""


# Which offline engine stands in when the Gemini ear cannot answer. English,
# because the Kinyarwanda model is a fine-tune that is weaker on everything else
# and an interpreted service always has English in it somewhere.
GEMINI_FALLBACK_LANG = "en"


def transcribe(
    lang: str, audio: np.ndarray, interim: bool = False,
    notes: list[str] | None = None, hint: str = "", allow_local: bool = True,
) -> str:
    if CONFIG[lang][0] == "gemini":
        # —— No interims, and this was learned the hard way ——
        # A "fast lane" that decoded interims with the offline English model
        # looked clever on paper: live text while Gemini was still in flight.
        # In a real Kinyarwanda service it produced confident nonsense —
        # "Muraho" came back as "Muradho", and whole invented English sentences
        # ("This is your second home", "I'm Zaburi, your channel") appeared in
        # the transcript between the correct lines. An English model handed
        # Kinyarwanda audio does not fail quietly; it guesses fluently, and
        # fluent nonsense is exactly what puts a wrong verse on a wall.
        #
        # A round trip per second of speech is also more than a free tier will
        # carry. So the remote ear speaks only in finished phrases, and every
        # line the operator sees came from a model that can actually hear the
        # language being spoken.
        if interim:
            return ""
        # —— A bounded wait ——
        # Gemini is usually ~2.5s, but a rate-limited key retries on the slower
        # model and a measured run reached 13.3s. A congregation cannot wait
        # thirteen seconds for a verse. Past the deadline we stop waiting and
        # use the offline model instead: a good-enough line now beats a better
        # line long after the preacher has moved on.
        # The offline safety net is ENGLISH. That makes it a good stand-in for
        # an English service and a liability in a Kinyarwanda one, where it
        # invents fluent English rather than admitting it cannot hear the
        # language. So it only runs when the room has actually been speaking a
        # language it knows — otherwise a missed line is the honest outcome,
        # and far better than a confident wrong one.
        try:
            remote_call = FINAL_POOL.submit(transcribe_with_gemini, audio, hint)
            # Decoded alongside the request rather than after the deadline:
            # paying the offline second only once the deadline has expired
            # would make the worst case worse than the deadline itself.
            local_call = (
                SAFETY_POOL.submit(_transcribe_local, GEMINI_FALLBACK_LANG, audio)
                if allow_local else None
            )
            deadline = (GEMINI_DEADLINE_SECS if allow_local
                        else GEMINI_NO_FALLBACK_DEADLINE_SECS)
            try:
                text, spoken = remote_call.result(timeout=deadline)
                if local_call:
                    local_call.cancel()
            except concurrent.futures.TimeoutError:
                # Let the remote call finish in the background rather than
                # cancelling — it is already paid for, and nothing waits on it.
                if not local_call:
                    if notes is not None:
                        notes.append("the connection is slow — that phrase was missed")
                    return ""
                if notes is not None:
                    notes.append("slow connection — used the offline ear")
                return local_call.result(timeout=GEMINI_DEADLINE_SECS)
            if notes is not None and spoken:
                # Carried out through `notes` so the websocket loop can pass the
                # language to the browser without changing what transcribe()
                # returns for the four other callers.
                notes.append(f"lang:{spoken}")
            return text
        except Exception as e:
            # A free-tier key will hit 429 somewhere in a long service. Losing
            # the sentence is worse than transcribing it less well, so drop to
            # the offline ear and say so rather than going quiet.
            print(f"[ear] falling back to the offline ear: {e}")
            if not allow_local:
                if notes is not None:
                    notes.append("the Gemini ear is unavailable — that phrase was missed")
                return ""
            if notes is not None:
                notes.append("Gemini ear unavailable — using the offline ear")
            lang = GEMINI_FALLBACK_LANG

    return _transcribe_local(lang, audio, interim)


def _transcribe_local(lang: str, audio: np.ndarray, interim: bool = False) -> str:
    """One pass of the offline model. The fast lane, and the safety net."""
    engine = get_engine(lang)
    _source, token = CONFIG[lang]
    segments, _info = engine.transcribe(
        audio,
        language=token,
        beam_size=1,
        # The energy gate already guarantees speech — skip VAD on interims.
        vad_filter=not interim,
        condition_on_previous_text=False,
        without_timestamps=True,  # fewer tokens to decode = faster answers
    )
    return " ".join(s.text for s in segments).strip()


@router.get("/api/ear/offline-capability")
def offline_capability(_user=Depends(admin_user)):
    """Can this machine run the fully offline lane — Whisper + SeamlessM4T?

    Reports what was measured rather than a yes/no, because a bare "no" is not
    something an administrator can act on. See translate.py.
    """
    import translate

    state = translate.capability()
    state["offline_speech"] = {
        "kinyarwanda_model_installed": os.path.isdir(RW_MODEL_DIR),
        "engine": "faster-whisper (CTranslate2, int8)",
    }
    return state


@router.websocket("/api/ear/ws")
async def ws_endpoint(ws: WebSocket):
    lang = ws.query_params.get("lang", "en")
    token = ws.query_params.get("token", "")
    payload = verify_token(token) if lang in CONFIG else None
    if not payload:
        await ws.close(code=4401)
        return

    import agent
    import db

    # The master switch. Until an administrator turns the voice assistant on,
    # no audio is accepted and no model is loaded — the pipeline is dormant,
    # not merely hidden. Checked here rather than only in the browser, because
    # a socket anyone can open is not gated by a greyed-out button.
    if not agent.voice_enabled():
        await ws.accept()
        await ws.send_text(json.dumps({
            "type": "error",
            "message": "The voice assistant is switched off. An administrator can turn "
                       "it on in Admin → Settings → Voice assistant.",
        }))
        await ws.close(code=4403)
        return

    # The AI ear belongs to the paid tiers.
    user = db.handle.execute("SELECT * FROM users WHERE id=?", (payload["uid"],)).fetchone()
    if not user or not db.entitlements(db.tier_of(db.handle, user))["ai"]:
        await ws.accept()
        await ws.send_text(json.dumps({
            "type": "error",
            "message": "AI listening is part of the Pro plan. Open Account to upgrade — "
                       "manual scripture search stays free for ever.",
        }))
        await ws.close()
        return
    await ws.accept()

    loop = asyncio.get_event_loop()
    try:
        # The Gemini ear has no local model to warm — it is ready the moment
        # the socket opens, which is also why it never keeps anyone waiting on
        # a cold start.
        if CONFIG[lang][0] == "gemini":
            # The remote ear uses the offline model for live text and as its
            # safety net, but it must NEVER wait for it to load: Gemini works
            # the moment the socket opens, and blocking here made the first
            # Listen after a restart sit for as long as the model took to come
            # off disk. Warm it in the background; until it is ready the live
            # line is simply quiet.
            if LOCAL_EARS:
                threading.Thread(
                    target=lambda: get_engine(GEMINI_FALLBACK_LANG), daemon=True
                ).start()
        else:
            await loop.run_in_executor(None, get_engine, lang)
    except Exception as e:
        # Send a real error the UI can show, not just a status line.
        await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        await ws.close()
        return
    await ws.send_text(json.dumps({"type": "status", "message": f"local ear ready ({lang})"}))

    buffer = np.zeros(0, dtype=np.float32)
    preroll = np.zeros(0, dtype=np.float32)   # audio from just before speech began
    # Read the church's own vocabulary once, at the top of the service, rather
    # than per utterance — it changes when the operator corrects something, and
    # the next service picks that up. See learning.py for why this matters more
    # than any model choice.
    import learning
    # A server running lean has no offline model to offer. Say so rather than
    # accepting audio it can do nothing with.
    if not LOCAL_EARS and CONFIG[lang][0] != "gemini":
        await ws.send_text(json.dumps({
            "type": "error",
            "message": "This server runs the Auto ear only. "
                       "Choose the Auto ear to listen.",
        }))
        await ws.close(code=4400)
        return
    uid = payload["uid"]
    hint = learning.vocabulary_hint(uid) if CONFIG[lang][0] == "gemini" else ""
    if CONFIG[lang][0] == "gemini":
        # Again on connect: a connection idle since the last service will have
        # been dropped by the far end, and re-opening it costs the first verse.
        threading.Thread(target=warm_gemini, daemon=True).start()
    # A remote ear pays an API call per utterance, so it waits a little longer
    # for a real full stop and carries a longer sentence: fewer, more complete
    # requests transcribe better AND go easier on the key's allowance. An
    # offline ear costs nothing per pass, so it stays snappy.
    remote = CONFIG[lang][0] == "gemini"
    silence_needed = REMOTE_SILENCE_SECS if remote else SILENCE_SECS
    max_utterance = REMOTE_MAX_UTTERANCE_SECS if remote else MAX_UTTERANCE_SECS
    interim_every = REMOTE_CHUNK_SECS if remote else CHUNK_SECS
    # Which language this room has been speaking, as the ear reports it.
    heard_language = ""
    # Who is speaking. One per connection, never carried between services:
    # the microphone, the room and the people all change week to week.
    import diarize
    diarizer = diarize.Diarizer()
    silence_run = 0.0
    heard_speech = False
    since_partial = 0.0
    busy = False
    noise_floor = 0.004        # a starting guess; the room corrects it in seconds
    chunks_seen = 0

    async def run_transcribe(audio: np.ndarray, final: bool):
        nonlocal busy, heard_language
        if audio.size < SAMPLE_RATE * MIN_TRANSCRIBE_SECS and not final:
            return  # not enough new speech to justify an engine pass
        # Interims only decode the newest few seconds — decoding time scales
        # with output length, and only the fresh words matter live.
        tail = REMOTE_INTERIM_TAIL_SECS if remote else INTERIM_TAIL_SECS
        if not final and audio.size > SAMPLE_RATE * tail:
            audio = audio[-int(SAMPLE_RATE * tail):]
        busy = True
        try:
            notes: list[str] = []
            # The final must never queue behind the local interim decodes.
            # Measured: sharing one executor with them pushed the final from
            # 2.7s to 8.5s, because a CPU-bound Whisper pass holds a worker
            # thread and the network call simply waited its turn. The final —
            # the one the congregation is waiting on — gets its own pool.
            pool = FINAL_POOL if (remote and final) else None
            text = await loop.run_in_executor(
                pool, transcribe, lang, audio, not final, notes, hint,
                LOCAL_EARS and heard_language in ("", "en", "fr"),
            )
            # Repair mishearings this church has already corrected us on. A
            # wrong word that never reaches scripture matching cannot put a
            # wrong verse on the wall.
            if text:
                text = learning.repair(text, uid)
            spoken = ""
            for note in notes:
                if note.startswith("lang:"):
                    spoken = note[5:]
                    # Remember what this room speaks. It decides whether the
                    # English offline model is a useful safety net here or a
                    # source of fluent nonsense — see transcribe().
                    heard_language = spoken
                else:
                    await ws.send_text(json.dumps({"type": "status", "message": note}))
            if text:
                message = {
                    "type": "final" if final else "interim",
                    "text": text,
                    # Which language this utterance was in. In an interpreted
                    # service this is what lets the Studio tell the preacher's
                    # sentence from the interpreter's repeat of it.
                    "lang": spoken or (CONFIG[lang][1] or lang),
                }
                # Who said it. Costs 23–72ms per utterance against a ~1.8s
                # transcription, and runs on the safety pool so it is never in
                # the way of the words themselves. See diarize.py for why this
                # is not a neural diarizer.
                if final:
                    try:
                        who = await loop.run_in_executor(
                            SAFETY_POOL, diarizer.observe, audio,
                            spoken or (CONFIG[lang][1] or lang),
                        )
                        message["speaker"] = who["speaker"]
                        message["role"] = who["role"]
                        message["overlap"] = who["overlap"]
                    except Exception as e:
                        print(f"[diarize] {e}")
                await ws.send_text(json.dumps(message))
        except Exception as e:
            # Never let one bad segment kill the connection.
            print(f"[transcribe error] {e}")
            try:
                await ws.send_text(
                    json.dumps({"type": "status", "message": "segment failed (retrying)"})
                )
            except Exception:
                pass
        finally:
            busy = False

    def cut_utterance():
        nonlocal buffer, preroll, heard_speech, silence_run, since_partial
        audio = buffer.copy()
        buffer = np.zeros(0, dtype=np.float32)
        preroll = np.zeros(0, dtype=np.float32)
        heard_speech = False
        silence_run = 0.0
        since_partial = 0.0

        async def finalize(a=audio):
            while busy:
                await asyncio.sleep(0.05)
            if remote:
                # One offline pass over the whole utterance, sent as an interim,
                # before the round trip to Google even begins. A short command —
                # "Emet, John 3:16" — ends before the live-text cadence ever
                # fires, so without this it waited the full ~2.8s for the final.
                # Commands act on interims, so this is what makes them land in
                # about a second. The accurate final still follows, and that is
                # what scripture matching acts on.
                asyncio.create_task(run_transcribe(a, final=False))
            await run_transcribe(a, final=True)

        asyncio.create_task(finalize())

    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break

            # Control messages: the operator screen sends {"type":"flush"} the
            # moment it hears the wake word — commit the utterance NOW instead
            # of waiting out the silence gap. This is what makes "Emet …"
            # commands feel instant.
            if msg.get("text") is not None:
                try:
                    ctl = json.loads(msg["text"])
                except Exception:
                    continue
                if ctl.get("type") == "flush" and heard_speech and buffer.size > SAMPLE_RATE * 0.5:
                    cut_utterance()
                continue

            data = msg.get("bytes")
            if data is None:
                continue
            chunk = np.frombuffer(data, dtype=np.float32)
            rms = float(np.sqrt(np.mean(chunk**2))) if chunk.size else 0.0
            chunk_secs = chunk.size / SAMPLE_RATE
            chunks_seen += 1

            # Learn the room. The floor follows quiet chunks quickly and loud
            # ones barely at all, so a long sentence cannot drag the threshold
            # up behind itself and deafen the ear mid-phrase.
            if rms < noise_floor:
                noise_floor += (rms - noise_floor) * FLOOR_FALL_ALPHA
            elif not heard_speech:
                noise_floor += (rms - noise_floor) * FLOOR_RISE_ALPHA
            threshold = min(
                ABS_MAX_ENERGY, max(ABS_MIN_ENERGY, noise_floor * SPEECH_OVER_FLOOR)
            )

            if rms >= threshold:
                if not heard_speech:
                    # Speech starts mid-chunk; without the pre-roll the first
                    # syllable is clipped, and a clipped first syllable is how
                    # "Emet" becomes unrecognisable.
                    buffer = np.concatenate([buffer, preroll])
                heard_speech = True
                silence_run = 0.0
            else:
                silence_run += chunk_secs

            if heard_speech:
                buffer = np.concatenate([buffer, chunk])
                since_partial += chunk_secs
            else:
                preroll = np.concatenate([preroll, chunk])[-int(SAMPLE_RATE * PREROLL_SECS):]

            # Once every few seconds, tell the operator's screen what the room
            # actually sounds like. Without this a gate that never opens is
            # completely invisible — which is exactly how this failed before.
            if chunks_seen % 40 == 0:
                await ws.send_text(json.dumps({
                    "type": "level",
                    "rms": round(rms, 5),
                    "floor": round(noise_floor, 5),
                    "threshold": round(threshold, 5),
                    "speaking": heard_speech,
                }))

            # —— Surviving a three-hour service ——
            # The session was checked once, when this socket opened. A sermon
            # outlasts that check: an untouched session goes idle after
            # SESSION_IDLE_SECONDS, and the ear would only discover it on a
            # reconnect — as a silent 4401 in the middle of the sermon. So
            # re-verify periodically. The same call refreshes last_seen_at, so
            # a service that runs for hours keeps its own session alive, and it
            # also means revoking a session now actually stops a live ear
            # instead of leaving it listening until the socket happens to drop.
            if chunks_seen % SESSION_CHECK_CHUNKS == 0:
                still_valid = await loop.run_in_executor(None, verify_token, token)
                if not still_valid:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "message": "Your session ended — sign in again to keep listening.",
                    }))
                    await ws.close(code=4401)
                    return

            utter_secs = buffer.size / SAMPLE_RATE

            if heard_speech and (
                (silence_run >= silence_needed and utter_secs > 0.5)
                or utter_secs >= max_utterance
            ):
                cut_utterance()

            # Once the room has gone quiet the utterance is about to be cut, so
            # starting another local decode only burns CPU the final needs.
            elif heard_speech and remote:
                # The remote ear produces no interims, so nothing here would
                # ever reset the counter and the branch would spin.
                since_partial = 0.0

            elif heard_speech and since_partial >= interim_every and not busy:
                since_partial = 0.0
                asyncio.create_task(run_transcribe(buffer.copy(), final=False))
    except WebSocketDisconnect:
        pass
