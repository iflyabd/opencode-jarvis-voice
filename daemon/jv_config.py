"""
Jarvis Voice - central configuration and platform detection.

Works unchanged on Parrot OS (Android chroot), Termux, plain Linux, macOS and Windows.
Everything is discovered at runtime; nothing is hard-coded to one machine.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import sys
import time
from pathlib import Path

DAEMON_VERSION = "1.5.0"

# ----------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------

APP_DIR = Path(__file__).resolve().parent.parent          # .../jarvis-voice
DAEMON_DIR = APP_DIR / "daemon"


def _xdg(env: str, default: str) -> Path:
    return Path(os.environ.get(env) or Path.home() / default)


CONFIG_DIR = Path(os.environ.get("JARVIS_VOICE_CONFIG") or (_xdg("XDG_CONFIG_HOME", ".config") / "jarvis-voice"))
CACHE_DIR = Path(os.environ.get("JARVIS_VOICE_CACHE") or (_xdg("XDG_CACHE_HOME", ".cache") / "jarvis-voice"))
LOG_DIR = Path(os.environ.get("JARVIS_VOICE_LOG") or (CACHE_DIR / "logs"))

for _d in (CONFIG_DIR, CACHE_DIR, LOG_DIR):
    try:
        _d.mkdir(parents=True, exist_ok=True)
    except Exception:  # pragma: no cover - read-only homes
        pass

CONF_FILE = CONFIG_DIR / "config.json"
RUNTIME_FILE = CACHE_DIR / "daemon.json"
BACKEND_FILE = CACHE_DIR / "backend.json"


# ----------------------------------------------------------------------------
# Platform detection
# ----------------------------------------------------------------------------

def _exists(p: str) -> bool:
    try:
        return Path(p).exists()
    except Exception:
        return False


SYSTEM = platform.system().lower()
MACHINE = platform.machine().lower()

# Termux = Android userland. Detect via its prefix, not by guessing.
TERMUX_PREFIX = Path(os.environ.get("PREFIX", "")) if os.environ.get("PREFIX") else Path("/data/data/com.termux/files/usr")
IS_TERMUX = (
    os.environ.get("TERMUX_VERSION") is not None
    or "com.termux" in str(TERMUX_PREFIX)
    or _exists("/data/data/com.termux/files/usr/bin/login")
)
IS_ANDROID = IS_TERMUX or _exists("/system/build.prop") or "android" in os.environ.get("OSTYPE", "").lower()
IS_LINUX = SYSTEM == "linux"
IS_WINDOWS = SYSTEM == "windows"
IS_MACOS = SYSTEM == "darwin"

PLATFORM_TAG = "termux" if IS_TERMUX else ("android" if IS_ANDROID else SYSTEM or "unknown")


# ----------------------------------------------------------------------------
# Server
# ----------------------------------------------------------------------------

HOST = os.environ.get("JARVIS_VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("JARVIS_VOICE_PORT", "8765"))

# Bearer token so a random local process cannot drive the mic. Generated once.
def _load_or_make_token() -> str:
    env = os.environ.get("JARVIS_VOICE_TOKEN")
    if env:
        return env
    try:
        if CONF_FILE.exists():
            data = json.loads(CONF_FILE.read_text())
            if isinstance(data, dict) and data.get("token"):
                return str(data["token"])
    except Exception:
        pass
    import secrets

    token = secrets.token_urlsafe(24)
    try:
        data = {}
        if CONF_FILE.exists():
            data = json.loads(CONF_FILE.read_text()) or {}
        data["token"] = token
        CONF_FILE.write_text(json.dumps(data, indent=2))
    except Exception:
        pass
    return token


TOKEN = _load_or_make_token()

AUTH_REQUIRED = os.environ.get("JARVIS_VOICE_AUTH", "1") not in ("0", "false", "no")

# Maximum seconds the daemon will hold a single HTTP request open.
REQUEST_TIMEOUT = float(os.environ.get("JARVIS_VOICE_REQUEST_TIMEOUT", "180"))


# ----------------------------------------------------------------------------
# Audio tuning
# ----------------------------------------------------------------------------

SAMPLE_RATE = int(os.environ.get("JARVIS_VOICE_SR", "16000"))

# Android/Termux exposes the real phone microphone through PulseAudio's
# module-sles-source. The daemon preloads this source for push-to-talk and
# releases it when the on-demand daemon exits, so it is not held forever.
PULSE_SLES_SOURCE = os.environ.get("JARVIS_VOICE_SLES_SOURCE", "jarvis_mic")
PULSE_SLES_DISABLE = os.environ.get("JARVIS_VOICE_SLES", "").strip().lower() in ("0", "false", "no", "off")

# Voice-activity detection
VAD_THRESHOLD = float(os.environ.get("JARVIS_VOICE_VAD_THRESHOLD", "0.012"))
VAD_SILENCE_MS = int(os.environ.get("JARVIS_VOICE_VAD_SILENCE_MS", "900"))
VAD_MIN_SPEECH_MS = int(os.environ.get("JARVIS_VOICE_VAD_MIN_SPEECH_MS", "250"))
VAD_MAX_MS = int(os.environ.get("JARVIS_VOICE_VAD_MAX_MS", "30000"))
VAD_START_TIMEOUT_MS = int(os.environ.get("JARVIS_VOICE_VAD_START_TIMEOUT_MS", "12000"))
BLOCK_MS = int(os.environ.get("JARVIS_VOICE_BLOCK_MS", "30"))

# Explicit device override: an integer index, a name substring, or a pulse/alsa device id.
INPUT_DEVICE = os.environ.get("JARVIS_VOICE_INPUT_DEVICE") or os.environ.get("JARVIS_INPUT_DEVICE") or ""
OUTPUT_DEVICE = os.environ.get("JARVIS_VOICE_OUTPUT_DEVICE") or ""
# Force a capture backend: pulse | sounddevice | arecord | sox | termux | ffmpeg
FORCE_CAPTURE_BACKEND = os.environ.get("JARVIS_VOICE_CAPTURE_BACKEND", "").strip().lower()
FORCE_PLAYBACK_BACKEND = os.environ.get("JARVIS_VOICE_PLAYBACK_BACKEND", "").strip().lower()

# Hard timeout for each backend probe, so a dead device can never hang the app.
PROBE_TIMEOUT = float(os.environ.get("JARVIS_VOICE_PROBE_TIMEOUT", "6"))

PULSE_SERVER = os.environ.get("PULSE_SERVER", "")


# ----------------------------------------------------------------------------
# Speech-to-text
# ----------------------------------------------------------------------------

STT_BACKEND = os.environ.get("JARVIS_VOICE_STT", "auto").strip().lower()   # auto|faster-whisper|whisper|whispercpp|vosk|fish|none
# tiny.en is noticeably faster and more accurate than multilingual tiny for
# English. Set JARVIS_VOICE_WHISPER_MODEL=tiny (or auto) for other languages.
WHISPER_MODEL = os.environ.get("JARVIS_VOICE_WHISPER_MODEL", "tiny.en")     # tiny.en|tiny|base|small|medium|large-v3
WHISPER_MODEL_EXPLICIT = "JARVIS_VOICE_WHISPER_MODEL" in os.environ
WHISPER_DEVICE = os.environ.get("JARVIS_VOICE_WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.environ.get("JARVIS_VOICE_WHISPER_COMPUTE", "int8")
# Cap Whisper's CPU threads (0 = library default). Four keeps phones responsive
# while the model loads during speech; use 2 for a cooler device.
WHISPER_THREADS = int(os.environ.get("JARVIS_VOICE_WHISPER_THREADS", "4" if IS_ANDROID else "0") or 0)
WHISPER_LANGUAGE = os.environ.get("JARVIS_VOICE_LANGUAGE", "")             # "" = auto-detect
WHISPER_BEAM = int(os.environ.get("JARVIS_VOICE_WHISPER_BEAM", "1"))
# Reject near-digital-silence before touching the model. This is only a guard
# against dead/muted sources and Whisper's "thank you" hallucinations on
# silence; normal quiet speech is far above this (-66 dBFS).
STT_MIN_RMS = float(os.environ.get("JARVIS_VOICE_STT_MIN_RMS", "0.0005"))
# Above this level the audio is loud enough to be speech. Only then is the
# slower multilingual retry worth running when the English model heard nothing.
STT_RESCUE_RMS = float(os.environ.get("JARVIS_VOICE_STT_RESCUE_RMS", "0.02"))
# Explicit local model directory (offline use, e.g. a downloaded faster-whisper model).
WHISPER_MODEL_DIR = os.environ.get("JARVIS_VOICE_WHISPER_DIR", "")
# Models already on this machine, best first - avoids a download when offline.
WHISPER_LOCAL_HINTS = (
    Path.home() / ".cache" / "huggingface" / "hub",
    Path.home() / ".cache" / "whisper",
)


# ----------------------------------------------------------------------------
# On-demand / battery ("keep the phone cold")
# ----------------------------------------------------------------------------

# Exit after this many seconds without real activity (a request that does
# something, an active push-to-talk session, or playing speech). Status polls
# from the UI do not count. The plugin starts the daemon again on the next
# voice action, so exiting costs nothing and gives idle CPU ~0 plus the RAM
# back. 0 = stay resident.
IDLE_EXIT_S = int(os.environ.get("JARVIS_VOICE_IDLE_EXIT_S", "300") or 0)
# off | lazy | boot.
#   lazy (default): load the STT model in the background when push-to-talk
#     starts - a transcription is coming anyway, so the CPU works while the
#     user speaks and never while the daemon sits idle.
#   boot: warm everything at daemon start (old behaviour, hot first answer,
#     costs a few seconds of CPU whenever the daemon starts).
#   off: never preload; the model loads on the first transcription.
WARMUP_MODE = (os.environ.get("JARVIS_VOICE_WARMUP", "lazy") or "off").strip().lower()


# ----------------------------------------------------------------------------
# Text-to-speech (Piper, fully local)
# ----------------------------------------------------------------------------

TTS_BACKEND = os.environ.get("JARVIS_VOICE_TTS", "auto").strip().lower()   # auto|piper|piper-bin|espeak|none
# Explicit voice: path to .onnx, or a voice name found by the resolver.
PIPER_VOICE = os.environ.get("JARVIS_VOICE_PIPER_VOICE") or os.environ.get("JARVIS_PIPER_VOICE") or ""
# Preferred voice names, best first. Used to pick a Jarvis-sounding voice automatically.
VOICE_PREFERENCES = [
    v.strip()
    for v in os.environ.get(
        "JARVIS_VOICE_PREFERENCES",
        "jarvis-medium,jarvis,jarvis-tts,en_GB-alan,en_GB-northern_english_male,alan,northern_english_male,en_US-ryan,ryan,en_GB-alba",
    ).split(",")
    if v.strip()
]
TTS_LENGTH_SCALE = float(os.environ.get("JARVIS_VOICE_LENGTH_SCALE", "1.0"))
TTS_NOISE_SCALE = float(os.environ.get("JARVIS_VOICE_NOISE_SCALE", "0.667"))
TTS_NOISE_W = float(os.environ.get("JARVIS_VOICE_NOISE_W", "0.8"))
TTS_SPEAKER = os.environ.get("JARVIS_VOICE_SPEAKER", "")

# Optional cloud voice. The TUI passes these per /speak request so the API key
# never has to live in the daemon environment. They are also accepted from the
# environment for CLI use. Setting a Fish backend sends the spoken text to
# api.fish.audio; local Piper remains the default and works offline.
FISH_API_KEY = os.environ.get("JARVIS_VOICE_FISH_KEY") or os.environ.get("FISH_API_KEY", "")
FISH_VOICE_ID = os.environ.get("JARVIS_VOICE_FISH_VOICE") or os.environ.get("FISH_VOICE_ID", "")
FISH_MODEL = os.environ.get("JARVIS_VOICE_FISH_MODEL", "s2.1-pro-free")
FISH_LATENCY = os.environ.get("JARVIS_VOICE_FISH_LATENCY", "balanced")
# A cloud reply is rendered in chunks so the first sound arrives early. The
# chunk size is in characters; a smaller chunk means a faster start.
FISH_CHUNK_CHARS = int(os.environ.get("JARVIS_VOICE_FISH_CHUNK_CHARS", "220"))
FISH_TIMEOUT = float(os.environ.get("JARVIS_VOICE_FISH_TIMEOUT", "60"))
FISH_API_URL = os.environ.get("JARVIS_VOICE_FISH_URL", "https://api.fish.audio/v1/tts")
# Optional cloud ears. The TUI passes the key per request; the env vars are
# for CLI/agent use. Fish ASR is billed separately from the free TTS model.
FISH_ASR_URL = os.environ.get("JARVIS_VOICE_FISH_ASR_URL", "https://api.fish.audio/v1/asr")
FISH_ASR_MODEL = os.environ.get("JARVIS_VOICE_FISH_ASR_MODEL", "transcribe-1-pro")
FISH_ASR_TIMEOUT = float(os.environ.get("JARVIS_VOICE_FISH_ASR_TIMEOUT", "60"))

# Where we look for Piper voices, in priority order.
VOICE_SEARCH_DIRS = [
    CONFIG_DIR / "voices",
    APP_DIR / "voices",
    Path.home() / ".local" / "share" / "piper" / "voices",
    Path.home() / ".local" / "share" / "piper",
    Path("/usr/share/piper/voices"),
    Path("/usr/share/piper"),
    Path("/usr/local/share/piper"),
    Path.home() / "piper",
    Path.home() / "voices",
    Path.home() / "piper-voices",
    # Termux locations
    TERMUX_PREFIX / "share" / "piper",
    TERMUX_PREFIX / "share" / "piper" / "voices",
    Path.home() / "storage" / "shared" / "piper",
    Path("/sdcard/piper"),
    Path("/sdcard/Download/piper"),
    Path("/storage/emulated/0/piper"),
    # Common desktop spots
    Path.home() / "Downloads",
    Path.home() / "Documents",
    Path("/opt/piper"),
    # Last resort: the home directory itself, so a voice downloaded from GitHub
    # into an arbitrary folder is still found without being registered by hand.
    Path.home(),
]
# Additional dirs from env (colon separated).
_extra = os.environ.get("JARVIS_VOICE_VOICE_DIRS", "")
if _extra:
    VOICE_SEARCH_DIRS = [Path(p).expanduser() for p in _extra.split(os.pathsep) if p.strip()] + VOICE_SEARCH_DIRS

# Registry written by `voice use <file>` so an exotic location is remembered.
VOICE_REGISTRY = CONFIG_DIR / "voices.json"

# Downloadable defaults (only used by the explicit `voice fetch` command).
VOICE_CATALOG_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def which(name: str) -> str | None:
    return shutil.which(name)


def host_port() -> tuple[str, str]:
    return HOST, str(PORT)


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((HOST, port))
            return True
        except OSError:
            return False


def write_runtime(pid: int, port: int, extra: dict | None = None) -> None:
    payload = {
        "pid": pid,
        "port": port,
        "host": HOST,
        "version": DAEMON_VERSION,
        "platform": PLATFORM_TAG,
        "started_at": time.time(),
        "url": f"http://{HOST}:{port}",
        "token": TOKEN,
    }
    if extra:
        payload.update(extra)
    try:
        RUNTIME_FILE.write_text(json.dumps(payload, indent=2))
        os.chmod(RUNTIME_FILE, 0o600)
    except Exception:
        pass


def read_runtime() -> dict:
    try:
        return json.loads(RUNTIME_FILE.read_text())
    except Exception:
        return {}


def clear_runtime() -> None:
    try:
        RUNTIME_FILE.unlink()
    except Exception:
        pass


def describe() -> dict:
    return {
        "version": DAEMON_VERSION,
        "platform": PLATFORM_TAG,
        "system": SYSTEM,
        "machine": MACHINE,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "is_termux": IS_TERMUX,
        "is_android": IS_ANDROID,
        "pulse_server": PULSE_SERVER,
        "config_dir": str(CONFIG_DIR),
        "cache_dir": str(CACHE_DIR),
        "sample_rate": SAMPLE_RATE,
        "auth_required": AUTH_REQUIRED,
        "on_demand": {
            "idle_exit_s": IDLE_EXIT_S,
            "warmup": WARMUP_MODE,
            "whisper_threads": WHISPER_THREADS,
        },
    }
