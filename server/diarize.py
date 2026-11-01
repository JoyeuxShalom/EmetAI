# Telling the preacher from the interpreter.
#
# ── Why this is not pyannote ────────────────────────────────────────────────
# The textbook answer is a neural diarizer (pyannote.audio) and, for
# overlapping speech, a source-separation model (Sepformer, ConvTasNet). Both
# want a GPU and several gigabytes of weights. This machine has 1.5 GB of free
# disk and a CPU-only torch build, so neither can be installed, let alone run
# in real time for three hours. Saying so is more useful than pretending.
#
# But this particular problem is much easier than general diarization, for two
# reasons that are specific to an interpreted church service:
#
#   1. There are exactly TWO speakers, and they alternate by design.
#   2. They speak DIFFERENT LANGUAGES — and the ear already reports which
#      language each utterance was in. That is a far stronger cue than any
#      voice embedding, and it costs nothing: it is already in the transcript.
#
# So this module fuses the language the ear heard with cheap acoustic features
# computed in numpy — pitch, timbre, voicing — and keeps two running speaker
# profiles. No new dependency, no download, a millisecond per utterance.
#
# ── What it does NOT do ─────────────────────────────────────────────────────
# It does not SEPARATE overlapping voices into two audio streams. Nothing that
# fits on this machine can. What it does instead is DETECT that an utterance
# contains both speakers and refuse to attribute it to either — because a
# confidently wrong speaker label is worse than an honest "both".

import numpy as np

SAMPLE_RATE = 16000

# Pitch search range. Human speech sits inside this; anything outside is noise
# or an octave error, and an octave error is the classic way a pitch tracker
# turns one speaker into two.
F0_MIN_HZ = 70.0
F0_MAX_HZ = 350.0

FRAME_SECS = 0.040
HOP_SECS = 0.020
# A frame quieter than this share of the utterance's own peak is not voiced
# speech and must not contribute a pitch estimate.
VOICED_ENERGY_RATIO = 0.15
# Autocorrelation peak below this is not periodic enough to be a pitch.
VOICED_CLARITY = 0.30

# Below this there is not enough voiced audio to characterise a voice at all.
MIN_VOICED_FRAMES = 8

# How far a profile moves toward each new utterance it is given. Slow enough
# that one odd utterance cannot drag a speaker's profile onto the other's.
PROFILE_ALPHA = 0.20

# Two voices are "clearly different" when their pitch differs by this much in
# semitones. Roughly a fifth — comfortably more than one person's own range,
# comfortably less than the gap between a typical male and female speaker.
DISTINCT_SEMITONES = 4.0

# How much the language cue is worth relative to the acoustic distance. The
# language is the more reliable signal in an interpreted service, so it
# dominates — but it cannot override acoustics outright, because a preacher
# who quotes a verse in English must not be relabelled as the interpreter.
LANGUAGE_WEIGHT = 3.0

# How much of a service must have been heard before naming the roles. Naming
# them from the first exchange would be a guess; a minute of speech across
# several turns each is evidence. See Diarizer.role().
ROLE_MIN_SECONDS = 60.0
ROLE_MIN_TURNS = 3
# The second voice is only treated as the preacher if it has done this much
# more of the talking — i.e. the first voice was clearly not the sermon.
ROLE_TALK_OVERRIDE = 1.5

# Measured, not guessed. Pitch spread relative to the utterance's own pitch:
#
#   one voice, short sentence    0.37
#   one voice, LONG sentence     0.25   <- long speech is NARROWER, not wider
#   two voices summed            1.09
#   two voices one after another 1.17
#
# One voice and two voices separate cleanly, so 0.7 sits in open ground. What
# does NOT separate is summed speech from sequential speech - both simply
# contain two people. This measure cannot tell them apart and nothing else
# available here can either, so the label says what is actually known: this
# line has both of them in it.
TWO_VOICES_SPREAD_RATIO = 0.7


def _frames(audio: np.ndarray) -> np.ndarray:
    frame = int(SAMPLE_RATE * FRAME_SECS)
    hop = int(SAMPLE_RATE * HOP_SECS)
    if audio.size < frame:
        return np.zeros((0, frame), dtype=np.float32)
    count = 1 + (audio.size - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(count)[:, None]
    return audio[idx]


def _f0_of_frame(frame: np.ndarray) -> tuple[float, float]:
    """Pitch of one frame by autocorrelation. Returns (hz, clarity).

    FFT-based rather than np.correlate: a 40ms frame is 640 samples, and doing
    this the O(n²) way 500 times per utterance would cost more than the
    transcription it is meant to annotate.
    """
    frame = frame - frame.mean()
    n = 1 << (2 * frame.size - 1).bit_length()
    spectrum = np.fft.rfft(frame, n)
    auto = np.fft.irfft(spectrum * np.conjugate(spectrum), n)[: frame.size]
    if auto[0] <= 0:
        return 0.0, 0.0
    auto = auto / auto[0]

    lo = int(SAMPLE_RATE / F0_MAX_HZ)
    hi = min(int(SAMPLE_RATE / F0_MIN_HZ), frame.size - 1)
    if hi <= lo:
        return 0.0, 0.0
    window = auto[lo:hi]
    peak = int(np.argmax(window))
    clarity = float(window[peak])
    lag = lo + peak
    if lag <= 0:
        return 0.0, 0.0
    return SAMPLE_RATE / lag, clarity


def voice_print(audio: np.ndarray) -> dict | None:
    """Cheap, stable description of a voice. None if there is too little of it."""
    if audio is None or audio.size < int(SAMPLE_RATE * 0.3):
        return None
    frames = _frames(audio.astype(np.float32))
    if frames.shape[0] == 0:
        return None

    energy = np.sqrt((frames ** 2).mean(axis=1))
    peak = float(energy.max()) if energy.size else 0.0
    if peak <= 0:
        return None
    loud = energy >= peak * VOICED_ENERGY_RATIO

    pitches, clarities = [], []
    for frame in frames[loud]:
        hz, clarity = _f0_of_frame(frame)
        if hz and clarity >= VOICED_CLARITY:
            pitches.append(hz)
            clarities.append(clarity)
    if len(pitches) < MIN_VOICED_FRAMES:
        return None

    pitch = np.array(pitches)
    # Spectral centroid — where the energy sits. Separates a bright voice from
    # a dark one even when two speakers share a pitch range.
    spec = np.abs(np.fft.rfft(frames[loud], axis=1))
    freqs = np.fft.rfftfreq(frames.shape[1], 1.0 / SAMPLE_RATE)
    total = spec.sum(axis=1)
    total[total == 0] = 1.0
    centroid = float(np.median((spec * freqs).sum(axis=1) / total))

    return {
        "f0": float(np.median(pitch)),
        # Spread of pitch WITHIN the utterance. Two people talking over each
        # other produce a much wider spread than one person ever does — this
        # is what overlap detection rests on.
        "f0_spread": float(np.percentile(pitch, 85) - np.percentile(pitch, 15)),
        "centroid": centroid,
        "voiced": float(loud.mean()),
        "clarity": float(np.median(clarities)),
    }


def semitones(a: float, b: float) -> float:
    """Distance between two pitches, in semitones — the scale ears use."""
    if a <= 0 or b <= 0:
        return 0.0
    return abs(12.0 * np.log2(a / b))


class Diarizer:
    """Two running speaker profiles, updated utterance by utterance.

    Deliberately online and stateless between services: a church's microphone,
    room and speakers change week to week, and a profile carried over from last
    Sunday would be worse than no profile at all.
    """

    def __init__(self) -> None:
        # Each profile: {"f0", "centroid", "langs": {lang: count}, "secs", "turns"}
        self.profiles: list[dict] = []
        self.last_speaker: int | None = None

    # ---------------------------------------------------------- overlap ----
    def _looks_overlapped(self, print_: dict, lang: str) -> bool:
        """Both speakers at once, as far as we can tell without separating them.

        ⚠ "mixed" is NOT a signal, and believing it was is what broke this.
        An 86-minute service came back with 130 of 265 lines labelled "both" —
        half the service supposedly spoken over. It was not. Those lines
        averaged 183 characters against 65 for the preacher: they were simply
        LONG utterances, which in an interpreted service naturally contain the
        preacher and then the interpreter. That is turn-taking, exactly what
        the docstring used to claim was excluded, and the mixed-language rule
        defeated the very thing it was written to avoid.

        What is left is acoustic and narrow: a voice sitting squarely between
        two established profiles, with a pitch spread wider than one person
        produces. Two voices summed do that; one person talking for twenty
        seconds does not.
        """
        if len(self.profiles) < 2:
            return False

        if semitones(self.profiles[0]["f0"], self.profiles[1]["f0"]) < DISTINCT_SEMITONES:
            return False      # the two voices are too alike to judge this at all

        # "Sitting between the two profiles" was the obvious test and it does
        # not work. Measured on genuinely summed voices of 90 Hz and 185 Hz,
        # the tracker reported 99 Hz: pitch detection locks onto the louder,
        # lower voice rather than averaging, so a mixture never looks like the
        # middle. The spread is what gives it away, and it alone is enough.
        spread = print_["f0_spread"] / max(print_["f0"], 1.0)
        return spread >= TWO_VOICES_SPREAD_RATIO

    # ------------------------------------------------------- assignment ----
    def _score(self, profile: dict, print_: dict, lang: str) -> float:
        """Lower is a better match."""
        score = semitones(print_["f0"], profile["f0"])
        # Timbre, scaled into something comparable with semitones.
        score += abs(print_["centroid"] - profile["centroid"]) / 250.0
        if lang and profile["langs"]:
            spoken = profile["langs"].get(lang, 0)
            share = spoken / max(1, sum(profile["langs"].values()))
            # Speaking this profile's usual language pulls the score down; a
            # language it never speaks pushes it up.
            score -= LANGUAGE_WEIGHT * (share - 0.5) * 2.0
        return score

    def _update(self, index: int, print_: dict, lang: str, secs: float) -> None:
        profile = self.profiles[index]
        profile["f0"] += (print_["f0"] - profile["f0"]) * PROFILE_ALPHA
        profile["centroid"] += (print_["centroid"] - profile["centroid"]) * PROFILE_ALPHA
        if lang:
            profile["langs"][lang] = profile["langs"].get(lang, 0) + 1
        profile["secs"] += secs
        profile["turns"] += 1

    def observe(self, audio: np.ndarray, lang: str = "") -> dict:
        """Attribute one utterance. Returns {speaker, role, confidence, overlap}.

        `speaker` is 0 or 1, or None when it cannot be attributed honestly.
        """
        secs = float(audio.size) / SAMPLE_RATE if audio is not None else 0.0
        print_ = voice_print(audio)
        if print_ is None:
            return {"speaker": None, "role": "", "confidence": 0.0, "overlap": False}

        if self._looks_overlapped(print_, lang):
            return {"speaker": None, "role": "both", "confidence": 0.0, "overlap": True}

        if not self.profiles:
            self.profiles.append({"f0": print_["f0"], "centroid": print_["centroid"],
                                  "langs": {}, "secs": 0.0, "turns": 0})
            self._update(0, print_, lang, secs)
            self.last_speaker = 0
            return {"speaker": 0, "role": self.role(0), "confidence": 0.5,
                    "overlap": False}

        scores = [self._score(p, print_, lang) for p in self.profiles]
        best = int(np.argmin(scores))

        if len(self.profiles) == 1:
            # Is this a second voice, or the same one again? Only split on
            # clear evidence: a second profile created from noise would poison
            # every assignment after it.
            apart = semitones(print_["f0"], self.profiles[0]["f0"])
            other_language = (
                lang
                and self.profiles[0]["langs"]
                and self.profiles[0]["langs"].get(lang, 0) == 0
            )
            if apart >= DISTINCT_SEMITONES or (other_language and apart >= 2.0):
                self.profiles.append({"f0": print_["f0"], "centroid": print_["centroid"],
                                      "langs": {}, "secs": 0.0, "turns": 0})
                best = 1
            else:
                best = 0

        self._update(best, print_, lang, secs)
        self.last_speaker = best

        if len(self.profiles) == 2:
            margin = abs(scores[0] - scores[1]) if len(scores) == 2 else 0.0
            confidence = float(min(1.0, margin / (DISTINCT_SEMITONES * 2)))
        else:
            confidence = 0.5
        return {"speaker": best, "role": self.role(best),
                "confidence": round(confidence, 2), "overlap": False}

    # ------------------------------------------------------------ roles ----
    def role(self, index: int) -> str:
        """Which of the two is the preacher.

        The obvious rule — "the preacher talks more" — is wrong here, and a
        three-hour soak test caught it. In a strictly interpreted service the
        interpreter renders every sentence, so the two speak for almost exactly
        the same length of time and no talk-time threshold ever fires.

        The reliable signal is order. An interpreter follows; that is what an
        interpreter is. The voice heard first is therefore the preacher —
        profiles are created in the order they are first heard, so profile 0
        opened the service. The one exception is when the other voice has done
        far more of the talking, which is what it looks like when the opening
        voice was a reader, a song leader or an announcement before the sermon.

        Until there is enough evidence, both are simply "speaker 1" and
        "speaker 2" rather than a guess dressed up as a fact — and the operator
        can always see which is which in the transcript.
        """
        if len(self.profiles) < 2:
            return "speaker 1"
        talk = [p["secs"] for p in self.profiles]
        turns = [p["turns"] for p in self.profiles]
        if sum(talk) < ROLE_MIN_SECONDS or min(turns) < ROLE_MIN_TURNS:
            return f"speaker {index + 1}"
        leader = 1 if talk[1] > talk[0] * ROLE_TALK_OVERRIDE else 0
        return "preacher" if index == leader else "interpreter"

    def summary(self) -> list[dict]:
        return [
            {"speaker": i, "role": self.role(i), "f0": round(p["f0"], 1),
             "seconds": round(p["secs"], 1), "turns": p["turns"],
             "languages": dict(p["langs"])}
            for i, p in enumerate(self.profiles)
        ]
