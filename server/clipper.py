# EmetAI sermon clipper — turns a YouTube sermon into short, caption-burned,
# social-ready clips. Zero-cost stack: yt-dlp (download), faster-whisper
# (transcription), ffmpeg via imageio-ffmpeg (cutting + captions).
#
# Pipeline per job:
#   download -> transcribe -> score windows -> pick top non-overlapping
#   -> cut with ffmpeg, burn styled captions (.ass), optional 9:16 vertical.

import json
import os
import queue
import re
import shutil
import subprocess
import threading

import db

CLIPS_DIR = os.path.join(db.DATA_DIR, "clips")

# ---- Viral-moment scoring (Kinyarwanda / English / French) ----

# Words that mark powerful teaching moments. Weight 2: core spiritual anchors.
KEYWORDS_2 = """
imana yesu umwuka ukuri urukundo kwizera umugisha imbaraga agakiza ubugingo
gusenga ubuhamya igitangaza ihishurirwa
god jesus spirit truth love faith grace blessing power salvation miracle
testimony anointing breakthrough
dieu jesus esprit verite amour foi grace benediction puissance salut miracle
temoignage onction
""".split()

# Weight 1: engagement / emphasis / narrative hooks.
KEYWORDS_1 = """
umva wumve tega dore reba icyo bivuze kubera impamvu ntabwo ariko rero
niba uyu munsi ubu ngubu byanditswe
listen look because why never always today right now remember imagine
promise change destiny purpose victory enemy warfare heaven
ecoute regarde pourquoi jamais toujours aujourd'hui maintenant promesse
destin victoire ciel
""".split()

REF_RE = re.compile(r"\b\d{1,3}\s*[:]\s*\d{1,3}\b")  # spoken/written verse refs


def _score_text(text: str) -> float:
    words = re.findall(r"[a-zà-ÿ']+", text.lower())
    if not words:
        return 0.0
    score = 0.0
    for w in words:
        if w in KEYWORDS_2:
            score += 2.0
        elif w in KEYWORDS_1:
            score += 1.0
    if REF_RE.search(text):
        score += 3.0  # quoting scripture is a strong clip anchor
    # Normalize lightly by length so long windows don't win by volume alone.
    return score / max(len(words) ** 0.5, 1.0) + min(len(words) / 40.0, 2.0)


# ---- Interpreter-aware caption filtering ----
# Rwandan sermons often run bilingual: preacher + interpreter alternating.
# When the user picks a caption language, only that voice gets captions.

LANG_STOPWORDS = {
    "en": {"the", "and", "of", "that", "you", "is", "to", "in", "he", "we", "they",
           "this", "for", "with", "not", "will", "your", "have", "was", "are", "it"},
    "fr": {"le", "la", "les", "de", "que", "est", "vous", "nous", "dans", "pour",
           "pas", "qui", "une", "des", "il", "et", "ce", "sur", "je", "tu", "mais"},
    "rw": {"kuko", "ariko", "kandi", "imana", "yesu", "muri", "ngo", "cyane", "nta",
           "ubwo", "uko", "abantu", "kugira", "ni", "na", "mu", "ku", "ndetse",
           "rero", "none", "ubu", "iyo", "buri", "byose", "wese"},
}


def _lang_of(text: str) -> str | None:
    """Cheap stopword-based language guess; None when unsure."""
    words = re.findall(r"[a-zà-ÿ']+", text.lower())
    if len(words) < 4:
        return None
    scores = {
        lang: sum(1 for w in words if w in sw) / len(words)
        for lang, sw in LANG_STOPWORDS.items()
    }
    best = max(scores, key=lambda k: scores[k])
    runner_up = max(v for k, v in scores.items() if k != best)
    # Confident only when clearly ahead.
    return best if scores[best] >= 0.15 and scores[best] >= runner_up * 2 else None


def _caption_segments(segs, language: str):
    """Segments whose captions should be shown for the chosen language."""
    if language not in ("en", "fr", "rw"):
        return segs  # auto: caption everything
    out = []
    for s in segs:
        guessed = _lang_of(s["text"])
        if guessed is not None and guessed != language:
            continue  # the other voice (preacher vs interpreter)
        # Forced-language decoding of the wrong voice comes out low-confidence.
        logprob = s.get("logprob")
        if logprob is not None and logprob < -1.0:
            continue
        out.append(s)
    return out


FACE_MODEL = os.path.join(os.path.dirname(__file__), "models", "face_yunet.onnx")


def _face_center_x(source: str, start: float, end: float) -> float | None:
    """Median horizontal face position (0..1) across sampled frames — used to
    keep the preacher centered in 9:16 crops, the way CapCut auto-reframes.
    Largest detected face wins (the preacher stands closest to the camera)."""
    if not os.path.exists(FACE_MODEL):
        return None
    try:
        import cv2
    except ImportError:
        return None
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        return None
    detector = None
    centers = []
    samples = 8
    for k in range(samples):
        t = start + (end - start) * (k + 0.5) / samples
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        h, w = frame.shape[:2]
        if detector is None:
            detector = cv2.FaceDetectorYN_create(FACE_MODEL, "", (w, h), 0.6)
        detector.setInputSize((w, h))
        _ok, faces = detector.detect(frame)
        if faces is None or len(faces) == 0:
            continue
        fx, _fy, fw, _fh = max(faces, key=lambda f: f[2] * f[3])[:4]
        centers.append((fx + fw / 2) / w)
    cap.release()
    if not centers:
        return None
    centers.sort()
    return centers[len(centers) // 2]


def _ffmpeg() -> str:
    """Path to a binary literally named ffmpeg.exe — yt-dlp requires the name.
    imageio-ffmpeg ships it under a versioned name, so hardlink it once."""
    import imageio_ffmpeg

    src = imageio_ffmpeg.get_ffmpeg_exe()
    bin_dir = os.path.join(os.path.dirname(__file__), "bin")
    dest = os.path.join(bin_dir, "ffmpeg.exe")
    if not os.path.exists(dest):
        os.makedirs(bin_dir, exist_ok=True)
        try:
            os.link(src, dest)  # hardlink: no extra disk space
        except OSError:
            shutil.copyfile(src, dest)
    return dest


def _ass_time(t: float) -> str:
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


GOLD = r"{\c&H51C4F5&}"   # EmetAI gold (ASS colours are BGR)
WHITE = r"{\c&HFFFFFF&}"


def _caption_pages(words, max_words=3, max_secs=1.5):
    """Group word timestamps into short CapCut-style pages that follow the
    speaker's pace: at most a few words, broken at punctuation and pauses."""
    pages = []
    page = []
    for w in words:
        if page:
            gap = w["start"] - page[-1]["end"]
            span = w["end"] - page[0]["start"]
            prev_txt = page[-1]["word"].strip()
            if (
                len(page) >= max_words
                or span > max_secs
                or gap > 0.6
                or prev_txt.endswith((".", "?", "!", ",", "…", ";", ":"))
            ):
                pages.append(page)
                page = []
        page.append(w)
    if page:
        pages.append(page)
    return pages


def _ass_captions(words, segments, clip_start: float, vertical: bool) -> str:
    """CapCut-style captions: short word groups that appear in sync with the
    voice, current word highlighted in gold. Falls back to sentence captions
    when word timestamps are unavailable."""
    play_x = 1080 if vertical else 1280
    play_y = 1920 if vertical else 720
    margin_v = 640 if vertical else 84   # lower-middle: where Reels captions live
    font_size = 92 if vertical else 52
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {play_x}
PlayResY: {play_y}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Emet,Arial,{font_size},&H00FFFFFF,&H00FFFFFF,&H000A0A12,&H000A0A12,-1,0,0,0,100,100,1,0,1,6,0,2,70,70,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []

    if words:
        for page in _caption_pages(words):
            # ALL CAPS: bold, legible, and IMANA / YESU / MWUKA WERA are
            # never left lowercase.
            page_words = [w["word"].strip().upper() for w in page]
            for k, w in enumerate(page):
                start = max(w["start"] - clip_start, 0.0)
                # Hold until the next word starts so the page never flickers.
                end = page[k + 1]["start"] - clip_start if k + 1 < len(page) else page[-1]["end"] - clip_start
                end = max(end, start + 0.06)
                parts = []
                for j, txt in enumerate(page_words):
                    parts.append(f"{GOLD}{txt}{WHITE}" if j == k else txt)
                lines.append(
                    f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Emet,,0,0,0,,{' '.join(parts)}"
                )
    else:
        # Fallback: whole-sentence captions.
        for seg in segments:
            start = max(seg["start"] - clip_start, 0.0)
            end = max(seg["end"] - clip_start, 0.0)
            if end <= 0:
                continue
            text = seg["text"].strip().replace("\n", " ").upper()
            if len(text) > 42:
                mid = len(text) // 2
                space = text.rfind(" ", 0, mid + 10)
                if space > 0:
                    text = text[:space] + r"\N" + text[space + 1 :]
            lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Emet,,0,0,0,,{text}")

    return header + "\n".join(lines) + "\n"


class ClipWorker:
    """Single background worker so a cheap laptop never runs two jobs at once."""

    def __init__(self):
        self.q: queue.Queue[str] = queue.Queue()
        self.thread: threading.Thread | None = None
        self.lock = threading.Lock()

    def submit(self, job_id: str):
        self.q.put(job_id)
        with self.lock:
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()

    def _run(self):
        while True:
            try:
                job_id = self.q.get(timeout=5)
            except queue.Empty:
                return
            con = db.handle  # dialect-aware proxy; one connection per worker thread
            try:
                self._process(con, job_id)
            except Exception as e:
                con.execute(
                    "UPDATE clip_jobs SET status='error', error=? WHERE id=?",
                    (f"{type(e).__name__}: {e}", job_id),
                )
                con.commit()

    # ---- pipeline steps ----

    def _set(self, con, job_id, status=None, progress=None):
        if status:
            con.execute("UPDATE clip_jobs SET status=? WHERE id=?", (status, job_id))
        if progress is not None:
            con.execute("UPDATE clip_jobs SET progress=? WHERE id=?", (progress, job_id))
        con.commit()

    def _process(self, con, job_id: str):
        row = con.execute("SELECT * FROM clip_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return
        params = json.loads(row["params"])
        clip_seconds = int(params.get("clip_seconds", 120))
        count = max(1, min(int(params.get("count", 3)), 10))
        vertical = params.get("format") == "vertical"
        language = params.get("language", "auto")
        mode = params.get("mode", "clips")  # 'clips' | 'full' | 'both'

        job_dir = os.path.join(CLIPS_DIR, job_id)
        os.makedirs(job_dir, exist_ok=True)
        source = os.path.join(job_dir, "source.mp4")

        # 1) Download
        self._set(con, job_id, status="downloading", progress="Fetching video…")
        self._download(row["url"], source, con, job_id)

        # 2) Transcribe
        self._set(con, job_id, status="transcribing", progress="Listening to the sermon…")
        segments = self._transcribe(source, language)
        if not segments:
            raise RuntimeError("No speech found in this video.")
        # Keep the transcript — editing and re-rendering need it later.
        with open(os.path.join(job_dir, "transcript.json"), "w", encoding="utf-8") as f:
            json.dump(segments, f)

        clips = []

        # 3) Full video with captions (original aspect, whole sermon)
        if mode in ("full", "both"):
            self._set(con, job_id, status="cutting",
                      progress="Rendering the full video with captions — long videos take a while…")
            full_out = os.path.join(job_dir, "full.mp4")
            self._render_full(source, full_out, segments, language, job_dir)
            clips.append(
                {
                    "index": 0,
                    "start": 0.0,
                    "end": round(segments[-1]["end"], 1),
                    "duration": round(segments[-1]["end"], 1),
                    "title": "Full sermon — captioned",
                    "score": 0,
                    "file": "full.mp4",
                }
            )

        # 4) Score + cut the viral windows
        if mode in ("clips", "both"):
            self._set(con, job_id, status="scoring", progress="Finding the most powerful moments…")
            windows = self._pick_windows(segments, clip_seconds, count)
            if not windows and mode == "clips":
                raise RuntimeError("Could not find clip-worthy sections — video may be too short.")
            for i, w in enumerate(windows, start=1):
                self._set(con, job_id, status="cutting", progress=f"Cutting clip {i} of {len(windows)}…")
                out = os.path.join(job_dir, f"clip_{i}.mp4")
                self._cut(source, out, w, vertical, job_dir, i, language)
                clips.append(
                    {
                        "index": i,
                        "start": round(w["start"], 1),
                        "end": round(w["end"], 1),
                        "duration": round(w["end"] - w["start"], 1),
                        "title": w["title"],
                        "score": round(w["score"], 2),
                        "file": f"clip_{i}.mp4",
                    }
                )

        # 5) Done. The source stays on disk so cuts remain editable —
        #    deleting the job removes everything.
        con.execute(
            "UPDATE clip_jobs SET status='done', progress='', result=? WHERE id=?",
            (json.dumps(clips), job_id),
        )
        con.commit()

    def _download(self, url: str, dest: str, con, job_id: str):
        import yt_dlp

        def hook(d):
            if d.get("status") == "downloading":
                pct = d.get("_percent_str", "").strip()
                self._set(con, job_id, progress=f"Downloading… {pct}")

        opts = {
            "format": "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
            "outtmpl": dest,
            "merge_output_format": "mp4",
            "ffmpeg_location": _ffmpeg(),
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "progress_hooks": [hook],
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
        if not os.path.exists(dest):
            raise RuntimeError("Download failed — check the YouTube link.")

    def _transcribe(self, path: str, language: str):
        import ear  # reuse the ear's loaded models

        if language == "rw" and os.path.isdir(ear.RW_MODEL_DIR):
            engine = ear.get_engine("rw")
            token = "sw"
        else:
            engine = ear.get_engine("en")  # multilingual base model
            token = None if language in ("auto", "rw") else language
        segs, _info = engine.transcribe(
            path, language=token, beam_size=1, vad_filter=True,
            condition_on_previous_text=False,
            word_timestamps=True,  # drives the CapCut-style caption pacing
        )
        return [
            {
                "start": s.start,
                "end": s.end,
                "text": s.text.strip(),
                "logprob": s.avg_logprob,
                "words": [
                    {"start": w.start, "end": w.end, "word": w.word}
                    for w in (s.words or [])
                ],
            }
            for s in segs
        ]

    # A clip that opens with a hook grabs the scroll-thumb in the first seconds.
    HOOK_RE = re.compile(
        r"\b(why|how|what|when|listen|imagine|stop|never|secret|today|question|"
        r"kuki|mbese|none\s+se|dore|tega|umva|wumve|reka|uzi|urabizi|witonde|"
        r"pourquoi|comment|imagine[zr]?|ecoute[zr]?|écoute[zr]?|regarde[zr]?|savez)\b",
        re.I,
    )
    SENTENCE_END = (".", "?", "!", "…")

    def _is_sentence_start(self, segments, i: int) -> bool:
        if i == 0:
            return True
        prev = segments[i - 1]
        gap = segments[i]["start"] - prev["end"]
        return gap > 0.6 or prev["text"].strip().endswith(self.SENTENCE_END)

    def _pick_windows(self, segments, clip_seconds: int, count: int):
        """Sentence-aware windows: start where a thought starts, end where a
        thought ends, score for teaching/viral content. Greedy top-N, no overlap."""
        candidates = []
        for i in range(len(segments)):
            if not self._is_sentence_start(segments, i):
                continue  # never open a clip mid-sentence
            start = segments[i]["start"]
            j = i
            last_sentence_end = -1  # index of last segment that closes a sentence
            best_seg = ("", 0.0)
            while j < len(segments) and segments[j]["end"] - start <= clip_seconds:
                if segments[j]["text"].strip().endswith(self.SENTENCE_END):
                    last_sentence_end = j
                s = _score_text(segments[j]["text"])
                if s > best_seg[1]:
                    best_seg = (segments[j]["text"], s)
                j += 1
            if j == i:
                continue

            # Prefer closing on a completed sentence when it keeps most of the
            # requested length; a clip that ends mid-thought never goes viral.
            end_idx = j - 1
            complete = False
            if last_sentence_end >= i and (
                segments[last_sentence_end]["end"] - start >= clip_seconds * 0.55
            ):
                end_idx = last_sentence_end
                complete = True
            end = segments[end_idx]["end"]
            if end - start < min(30, clip_seconds * 0.5):
                continue  # too short to stand alone

            window = segments[i : end_idx + 1]
            score = _score_text(" ".join(seg["text"] for seg in window))
            if complete:
                score += 1.5  # a whole thought, start to finish
            # Hook in the first ~2 segments: questions and imperatives pull viewers in.
            opening = " ".join(seg["text"] for seg in window[:2])
            if self.HOOK_RE.search(opening):
                score += 2.5

            title = best_seg[0].strip()[:70] or window[0]["text"][:70]
            candidates.append(
                {"start": max(start - 0.3, 0), "end": end + 0.3, "score": score,
                 "title": title, "segs": window}
            )

        candidates.sort(key=lambda c: c["score"], reverse=True)
        picked = []
        for c in candidates:
            if len(picked) >= count:
                break
            if all(c["end"] <= p["start"] or c["start"] >= p["end"] for p in picked):
                picked.append(c)
        picked.sort(key=lambda c: c["start"])
        return picked

    def _cut(self, source: str, out: str, w, vertical: bool, job_dir: str, idx: int,
             language: str = "auto"):
        # Caption only the chosen voice when a sermon runs with an interpreter.
        caption_segs = _caption_segments(w["segs"], language)
        # All word timestamps inside the window drive the CapCut-style captions.
        words = [
            word
            for seg in caption_segs
            for word in seg.get("words", [])
            if w["start"] <= word["start"] <= w["end"]
        ]
        ass_path = os.path.join(job_dir, f"clip_{idx}.ass")
        with open(ass_path, "w", encoding="utf-8") as f:
            f.write(_ass_captions(words, caption_segs, w["start"], vertical))

        # ffmpeg's subtitle filter needs forward slashes and escaped colon on Windows.
        ass_filter = ass_path.replace("\\", "/").replace(":", r"\:")
        filters = []
        if vertical:
            # Keep the preacher centered, CapCut-style: crop follows the median
            # face position instead of blindly taking the middle of the frame.
            cx = _face_center_x(source, w["start"], w["end"])
            if cx is None:
                cx = 0.5
            crop_x = f"max(0\\,min(iw-ih*9/16\\,iw*{cx:.4f}-ih*9/32))"
            filters.append(f"crop=ih*9/16:ih:{crop_x}:0")
            filters.append("scale=1080:1920")
        filters.append(f"ass='{ass_filter}'")

        cmd = [
            _ffmpeg(), "-y",
            "-ss", f"{w['start']:.2f}", "-to", f"{w['end']:.2f}",
            "-i", source,
            "-vf", ",".join(filters),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            out,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not os.path.exists(out):
            raise RuntimeError(f"ffmpeg failed: {proc.stderr[-400:]}")
        os.remove(ass_path)

    def _render_full(self, source: str, out: str, segments, language: str, job_dir: str):
        """The whole sermon, original aspect, with burned CapCut captions."""
        caption_segs = _caption_segments(segments, language)
        words = [w for seg in caption_segs for w in seg.get("words", [])]
        ass_path = os.path.join(job_dir, "full.ass")
        with open(ass_path, "w", encoding="utf-8") as f:
            f.write(_ass_captions(words, caption_segs, 0.0, vertical=False))
        ass_filter = ass_path.replace("\\", "/").replace(":", r"\:")
        cmd = [
            _ffmpeg(), "-y", "-i", source,
            "-vf", f"ass='{ass_filter}'",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            out,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not os.path.exists(out):
            raise RuntimeError(f"ffmpeg failed on full render: {proc.stderr[-400:]}")
        os.remove(ass_path)


worker = ClipWorker()


def _spread_words(text: str, start: float, end: float):
    """Even word timings for caption text the user rewrote — the original
    per-word timestamps no longer apply to new words."""
    tokens = text.split()
    if not tokens:
        return []
    duration = max(end - start, 0.2)
    step = duration / len(tokens)
    return [
        {"start": start + i * step, "end": start + (i + 1) * step, "word": " " + t}
        for i, t in enumerate(tokens)
    ]


def reclip(job_id: str, index: int, start: float, end: float, captions: list):
    """Re-render one clip with edited bounds and captions (own thread).
    Captions whose text is unchanged keep their precise word timings."""
    con = db.handle
    try:
        row = con.execute("SELECT * FROM clip_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return
        params = json.loads(row["params"])
        vertical = params.get("format") == "vertical"
        job_dir = os.path.join(CLIPS_DIR, job_id)
        source = os.path.join(job_dir, "source.mp4")
        with open(os.path.join(job_dir, "transcript.json"), encoding="utf-8") as f:
            transcript = json.load(f)

        original = {round(s["start"], 2): s for s in transcript}
        segs = []
        for c in captions:
            text = str(c["text"]).strip()
            if not text:
                continue  # deleting the text removes that caption
            c_start, c_end = float(c["start"]), float(c["end"])
            orig = original.get(round(c_start, 2))
            if orig and orig["text"].strip() == text and orig.get("words"):
                segs.append(orig)
            else:
                segs.append({"start": c_start, "end": c_end, "text": text,
                             "words": _spread_words(text, c_start, c_end)})

        w = {"start": start, "end": end, "segs": segs,
             "title": segs[0]["text"][:70] if segs else ""}
        con.execute("UPDATE clip_jobs SET status='cutting', progress=?, error='' WHERE id=?",
                    (f"Re-rendering clip {index}…", job_id))
        con.commit()

        out = os.path.join(job_dir, f"clip_{index}.mp4")
        # The user approved these captions — never filter them by language.
        worker._cut(source, out, w, vertical, job_dir, index, "auto")

        clips = json.loads(row["result"])
        for c in clips:
            if c["index"] == index:
                c.update({
                    "start": round(start, 1), "end": round(end, 1),
                    "duration": round(end - start, 1),
                    "title": w["title"] or c["title"],
                })
        con.execute("UPDATE clip_jobs SET status='done', progress='', result=? WHERE id=?",
                    (json.dumps(clips), job_id))
        con.commit()
    except Exception as e:
        con.execute("UPDATE clip_jobs SET status='done', progress='', error=? WHERE id=?",
                    (f"Edit failed: {type(e).__name__}: {e}", job_id))
        con.commit()


def delete_job_files(job_id: str):
    shutil.rmtree(os.path.join(CLIPS_DIR, job_id), ignore_errors=True)
