# Legacy entrypoint — the ear now lives inside the unified backend.
# Run:  python server/app.py
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from app import app  # noqa: E402
import uvicorn  # noqa: E402

if __name__ == "__main__":
    print("ear_server.py is deprecated — starting the full EmetAI backend instead.")
    uvicorn.run(app, host="127.0.0.1", port=8765)
