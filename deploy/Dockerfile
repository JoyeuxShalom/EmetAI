# EmetAI server image.
#
# Built for both architectures: Oracle's free tier is ARM (Ampere A1), while
# most laptops are x86. python:3.12-slim has images for both, and 3.12 rather
# than 3.14 because several wheels this project needs (PyYAML among them) have
# no 3.14 build yet and would be compiled from source on a 1 OCPU machine.

FROM python:3.12-slim

# ffmpeg comes from imageio-ffmpeg as a bundled binary, so it is not installed
# here. curl is for the healthcheck; the build tools are only needed if a wheel
# has to be compiled for aarch64, and are removed again in the same layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not reinstall the world.
COPY server/requirements.txt ./server/requirements.txt
# opencv-python pulls in a full GUI stack that a server has no use for and
# cannot even load (no libGL). The headless build is the same library without
# it, and saves a few hundred megabytes.
RUN sed 's/^opencv-python/opencv-python-headless/' server/requirements.txt > /tmp/req.txt \
    && pip install --no-cache-dir -r /tmp/req.txt

COPY server/ ./server/
COPY public/ ./public/
# The built Studio. `npm run build` must have been run before this image is
# built - app.py serves ../dist when it exists, which is what makes this one
# container rather than two.
COPY dist/ ./dist/

# Lean by default: on a small cloud instance the Gemini ear does the listening
# and the offline Whisper models would cost ~1 GB of RAM for nothing. Set to 1
# on a machine with room for them. See server/ear.py.
ENV EMETAI_LOCAL_EARS=0 \
    PYTHONUNBUFFERED=1

EXPOSE 8765

# The readiness endpoint the launcher already uses, reused here so Docker
# restarts a container that is running but no longer answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8765/api/ready || exit 1

WORKDIR /app/server
CMD ["python", "app.py"]
