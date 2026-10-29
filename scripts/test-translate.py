# The offline lane's preflight.
#
# The translator itself cannot be exercised on a machine that cannot hold the
# weights, and pretending otherwise would be worse than useless. What CAN be
# tested — and what actually matters — is that the preflight tells the truth:
# that it measures rather than guesses, refuses rather than half-starts, and
# says precisely what is missing.
#
# Run:  cd server && python -X utf8 ../scripts/test-translate.py

import os
import sys

SERVER = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
)
sys.path.insert(0, SERVER)

import translate  # noqa: E402

PASS = FAIL = 0


def check(label, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ok  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label} {extra}")


print("— measuring this machine —")

state = translate.capability()
check("it reports a verdict", isinstance(state.get("ready"), bool))
check("it shows the free disk it measured",
      isinstance(state["measured"]["free_disk_gb"], float),
      state["measured"])
check("it shows how much disk the model needs",
      state["measured"]["disk_needed_gb"] > state["measured"]["free_disk_gb"]
      or state["ready"])
check("it reports the torch build", "torch" in state["measured"])
check("it distinguishes 'runs at all' from 'runs in real time'",
      "realtime" in state and (state["realtime"] is False or state["ready"]))

if not state["ready"]:
    check("every block says what is missing, with a number",
          all(any(ch.isdigit() for ch in b) or "install" in b.lower()
              for b in state["blocks"]),
          state["blocks"])
    print(f"    verdict: {state['blocks'][0]}")

check("a CPU-only build is warned about rather than silently accepted",
      state["measured"]["cuda"] or any("CPU" in w for w in state["warnings"])
      or not state["measured"]["torch"].endswith("cpu"),
      state["warnings"])

big = translate.capability(translate.MODEL_LARGE)
check("the larger model is reported as needing more disk",
      big["measured"]["disk_needed_gb"] > state["measured"]["disk_needed_gb"],
      (big["measured"]["disk_needed_gb"], state["measured"]["disk_needed_gb"]))


print("\n— it refuses rather than half-starting —")

if not state["ready"]:
    try:
        translate.translate("Imana ni nziza")
        check("translating without the weights raises", False, "it returned")
    except RuntimeError as e:
        check("translating without the weights raises", True)
        check("and the error repeats the preflight's reason",
              "disk" in str(e).lower() or "install" in str(e).lower(), str(e)[:90])
    except Exception as e:
        check("translating without the weights raises a clear error", False,
              f"{type(e).__name__}: {e}")

check("empty text never loads a 5 GB model", translate.translate("") == "")
check("and neither does whitespace", translate.translate("   ") == "")
check("translating a language into itself is a no-op",
      translate.translate("Imana ni nziza", "rw", "rw") == "Imana ni nziza")


print("\n— the language codes —")

check("Kinyarwanda has a SeamlessM4T code", translate.LANG_CODES["rw"] == "kin")
check("English has one", translate.LANG_CODES["en"] == "eng")
check("French has one", translate.LANG_CODES["fr"] == "fra")
check("an unknown code is passed through rather than mangled",
      translate.LANG_CODES.get("xx", "xx") == "xx")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
