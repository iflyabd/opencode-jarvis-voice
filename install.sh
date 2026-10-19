#!/usr/bin/env bash
# Jarvis Voice installer.
#
#   git clone https://github.com/iflyabd/opencode-jarvis-voice
#   cd opencode-jarvis-voice
#   ./install.sh
#
# What it does, in order:
#   1. Python environment            (.venv + requirements.txt)
#   2. A local JARVIS-style voice    (Piper, ~64 MB, optional prompt)
#   3. OpenCode plugin registration  (adds this folder to cli.json)
#   4. A quick verification          (voice doctor)
#
# Flags:
#   --with-voice NAME   download this Piper voice without asking
#                       (default suggestion: jarvis-medium)
#   --no-voice          never download a voice
#   --no-register       only set up Python + voice, do not touch OpenCode config
#   --no-daemon         do not start the daemon at the end
#
# Everything stays on this machine. Uninstall notes are printed at the end.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOICE="$HERE/bin/voice"
FETCH_VOICE=""
ALLOW_VOICE_PROMPT=1
REGISTER=1
START_DAEMON=1

for arg in "$@"; do
  case "$arg" in
    --with-voice=*)  FETCH_VOICE="${arg#--with-voice=}" ;;
    --with-voice)    FETCH_VOICE="${2:-}"; shift ;;
    --no-voice)      FETCH_VOICE="none"; ALLOW_VOICE_PROMPT=0 ;;
    --no-register)   REGISTER=0 ;;
    --no-daemon)     START_DAEMON=0 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -24
      exit 0 ;;
    *) echo "unknown flag: $arg (see --help)"; exit 2 ;;
  esac
done

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
die()  { bad "$*"; exit 1; }

say "Jarvis Voice installer"
echo

# --- 0. sanity ---------------------------------------------------------------

[ -f "$VOICE" ] || die "bin/voice not found next to this script; run it from the repository root"
command -v python3 >/dev/null 2>&1 || die "python3 is required (install python3 and python3-venv)"

# --- 1. Python environment ---------------------------------------------------

say "[1/4] Python environment"
if bash "$VOICE" install; then
  ok "Python environment ready"
else
  die "Python setup failed — fix the error above and re-run ./install.sh"
fi

# --- 2. A voice --------------------------------------------------------------

say "[2/4] Piper voice"
have_voice() {
  local json
  json="$(bash "$VOICE" voice json 2>/dev/null)" || return 1
  python3 - "$json" <<'PY'
import json, sys
try:
    data = json.loads(sys.argv[1].strip() or "{}")
except Exception:
    sys.exit(1)
sys.exit(0 if data else 1)
PY
}

if [ "$FETCH_VOICE" = "none" ]; then
  warn "skipping voice download (--no-voice)"
elif [ -n "$FETCH_VOICE" ]; then
  bash "$VOICE" voice fetch "$FETCH_VOICE" && ok "voice '$FETCH_VOICE' ready" || warn "voice download failed; try: voice voice fetch $FETCH_VOICE"
elif have_voice; then
  ok "a voice is already installed"
elif [ "$ALLOW_VOICE_PROMPT" = 1 ] && [ -t 0 ]; then
  printf '  No Piper voice installed yet. Download the JARVIS voice jarvis-medium (~64 MB)? [Y/n] '
  read -r reply
  case "$reply" in
    n|N|no|NO) warn "skipped; run 'bin/voice voice fetch jarvis-medium' later" ;;
    *) bash "$VOICE" voice fetch jarvis-medium && ok "voice ready" || warn "voice download failed; retry: voice voice fetch jarvis-medium" ;;
  esac
else
  warn "no voice installed — run: bin/voice voice fetch jarvis-medium"
fi

# --- 3. OpenCode plugin registration ----------------------------------------

say "[3/4] OpenCode plugin"
if [ "$REGISTER" = 0 ]; then
  warn "skipping config edit (--no-register)"
else
  python3 - "$HERE" <<'PY'
import json, os, sys

here = sys.argv[1]
config_dir = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.join(os.path.expanduser("~"), ".config")), "opencode")
cli = os.path.join(config_dir, "cli.json")

try:
    with open(cli, "r", encoding="utf-8") as f:
        raw = f.read().strip()
    data = json.loads(raw) if raw else {}
    if not isinstance(data, dict):
        raise ValueError("config is not an object")
except FileNotFoundError:
    data = {}
except Exception as error:
    print(f"  ! could not edit {cli}: {error}")
    print(f"    add \"{here}\" to \"plugins\" in that file by hand")
    sys.exit(3)

plugins = data.get("plugins")
if not isinstance(plugins, list):
    plugins = []
if here in plugins:
    print(f"  ✓ already registered in {cli}")
    sys.exit(0)

plugins.append(here)
data["plugins"] = plugins
os.makedirs(config_dir, exist_ok=True)
with open(cli, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"  ✓ registered {here}")
print(f"    in {cli}")
PY
  case $? in
    0|3) ;;
    *) warn "registration needs a hand — see above" ;;
  esac
  if ! command -v opencode >/dev/null 2>&1; then
    warn "the 'opencode' command was not found on PATH — install OpenCode, then restart it"
  fi
fi

# --- 4. Verify ---------------------------------------------------------------

say "[4/4] Verify"
if [ "$START_DAEMON" = 1 ]; then
  bash "$VOICE" up || warn "daemon did not start — run 'bin/voice doctor' for details"
fi
bash "$VOICE" doctor || true

cat <<EOF

Done. Next steps:
  1. Restart OpenCode (the plugin loads on start).
  2. In the TUI you now have:
       🎙 mic    bottom-right of the prompt box   click to talk, click again to send
       🔊 read   top-right, above the text box   click to hear the last answer
                                                click ⏸ to pause, ▶ to resume
     Keys:  ctrl+alt+v  push to talk      ctrl+alt+p  read / pause / resume
  3. Speak into the mic; the transcript lands in the prompt and the reply is
     spoken back when auto-speak is on.

Troubleshooting:  bin/voice doctor      Logs:  bin/voice logs
Uninstall:        remove this folder, delete its entry from
                  ~/.config/opencode/cli.json, and delete ~/.cache/jarvis-voice
EOF
