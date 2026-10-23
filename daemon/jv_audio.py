"""
Cross-platform audio capture and playback.

Capture backends, tried in priority order until one actually produces samples:

  pulse        parec/pactl      - Parrot chroot + Termux + desktop PulseAudio/PipeWire (honours PULSE_SERVER)
  pulse-sles   parec + SLES     - Android phone mic, loaded only while recording
  sounddevice  PortAudio        - Windows, macOS, Linux, Termux (if portaudio is installed)
  arecord      ALSA             - plain Linux
  sox          sox/rec          - anywhere sox exists
  ffmpeg       ffmpeg           - last resort, knows pulse/alsa/dshow/avfoundation
  termux       termux-api       - Android without a PulseAudio bridge

Two design rules make this reliable on a phone:

1. Every capture stream is a *separate process*. A wedged ALSA node, a native
   malloc fault or an AudioFlinger lock can never take the daemon down - the
   child dies, the parent moves on.
2. Every read has a hard timeout, so a dead device raises instead of hanging the
   request that is waiting for it.
"""

from __future__ import annotations

import os
import queue
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

import jv_config as cfg

SELF = Path(__file__).resolve()

# Resolve libc in the parent, never inside a forked child: importing ctypes
# from a preexec_fn can deadlock if another thread holds the import lock.
try:
    import ctypes as _ctypes

    _LIBC = _ctypes.CDLL("libc.so.6", use_errno=True)
except Exception:  # pragma: no cover - non-glibc platforms
    _LIBC = None


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------

class AudioError(RuntimeError):
    pass


def _which(name: str) -> str | None:
    return shutil.which(name)


def _run(cmd: list[str], timeout: float = 8, input_bytes: bytes | None = None) -> tuple[int, bytes, bytes]:
    try:
        p = subprocess.run(cmd, capture_output=True, input=input_bytes, timeout=timeout)
        return p.returncode, p.stdout or b"", p.stderr or b""
    except subprocess.TimeoutExpired:
        return 124, b"", b"timeout"
    except FileNotFoundError:
        return 127, b"", f"not found: {cmd[0]}".encode()
    except Exception as e:  # pragma: no cover
        return 1, b"", str(e).encode()


def _child_pdeathsig() -> None:
    """Ask Linux to terminate a player when the daemon dies.

    Without this, a daemon crash (or a SIGKILL from the OS) can leave ffplay
    holding the speaker as an orphan - the "it keeps talking after I closed
    OpenCode" symptom. It is a best-effort call: other platforms simply skip it.
    """
    if os.name != "posix" or _LIBC is None:
        return
    try:
        # PR_SET_PDEATHSIG = 1. The signal is delivered when the parent dies.
        _LIBC.prctl(1, signal.SIGTERM, 0, 0, 0)
    except Exception:
        pass


class VoiceGate:
    """Energy voice-activity detector tuned for a live conversation.

    Three things make it feel instant instead of "press, wait, wait":

    * an **adaptive noise floor** - the threshold follows a fan, a fridge or
      the phone's own speaker bleed, so a quiet room does not need a hand
      tuned constant and a noisy one does not trigger on everything;
    * **pre-roll** - the blocks just before the detected onset are kept, so
      the first phoneme (a "s", a "t") is not clipped off the utterance;
    * **fast endpointing** - the caller chooses the hangover, and live mode
      uses a short one so the answer starts while the pause still feels
      natural.

    The gate is a pure state machine over block levels: no audio, no clock.
    Feed it one block RMS at a time and act on the return value.
    """

    WAITING = "waiting"
    SPEECH = "speech"
    DONE = "done"

    def __init__(self, threshold: float = 0.012, block_ms: int = 30,
                 silence_ms: int = 900, min_speech_ms: int = 250,
                 noise_mult: float = 2.4, preroll_ms: int = 300) -> None:
        self.base = max(0.0, float(threshold))
        self.block_ms = max(1, int(block_ms))
        self.silence_blocks = max(1, int(round(silence_ms / self.block_ms)))
        self.min_speech_blocks = max(1, int(round(min_speech_ms / self.block_ms)))
        self.noise_mult = max(1.0, float(noise_mult))
        self.preroll_blocks = max(0, int(round(preroll_ms / self.block_ms)))
        self.state = self.WAITING
        self.noise_floor = 0.0
        self.threshold = self.base
        self.speech_blocks = 0
        self.silent_blocks = 0

    def push(self, level: float) -> str:
        """Feed one block level; returns 'waiting'|'start'|'speech'|'end'."""
        level = max(0.0, float(level or 0.0))
        triggered = level >= self.threshold

        if self.state == self.WAITING:
            if triggered:
                self.state = self.SPEECH
                self.speech_blocks = 1
                self.silent_blocks = 0
                return "start"
            # Track the room, not the speaker: only quiet blocks lower the
            # floor, so a long sentence cannot teach the gate to ignore it.
            self.noise_floor = (0.85 * self.noise_floor + 0.15 * level
                                if self.noise_floor else level)
            self.threshold = max(self.base, self.noise_floor * self.noise_mult)
            return "waiting"

        if triggered:
            self.speech_blocks += 1
            self.silent_blocks = 0
            return "speech"

        self.silent_blocks += 1
        if (self.silent_blocks >= self.silence_blocks
                and self.speech_blocks >= self.min_speech_blocks):
            self.state = self.DONE
            return "end"
        return "speech"

    @property
    def speech_ms(self) -> int:
        return self.speech_blocks * self.block_ms


def trim_silence(pcm: bytes, threshold: float = 0.006,
                 block_ms: int = 30, sr: int = 16000,
                 keep_ms: int = 120) -> bytes:
    """Drop quiet blocks from both ends of an utterance.

    The endpoint hangover and the pre-roll are useful while recording, but
    sending them to Whisper only makes the model work longer. One quiet block
    is kept on each side so a soft first or last consonant survives.
    """
    if not pcm:
        return b""
    block = max(2, int(sr * block_ms / 1000) * 2)
    blocks = [pcm[i:i + block] for i in range(0, len(pcm) - block + 1, block)]
    if not blocks:
        return pcm
    keep = max(1, int(round(keep_ms / block_ms)))
    voiced = [i for i, b in enumerate(blocks) if rms(b) >= threshold]
    if not voiced:
        return b""
    start = max(0, voiced[0] - keep)
    end = min(len(blocks), voiced[-1] + 1 + keep)
    return b"".join(blocks[start:end])


def rms(block: bytes) -> float:
    """RMS of a signed 16-bit little-endian mono block, normalised to 0..1."""
    if not block:
        return 0.0
    try:
        import numpy as np

        a = np.frombuffer(block, dtype="<i2").astype("float32") / 32768.0
        return float((a * a).mean() ** 0.5) if a.size else 0.0
    except Exception:
        n = len(block) // 2
        if n == 0:
            return 0.0
        acc = 0
        for i in range(0, n * 2, 2):
            v = int.from_bytes(block[i:i + 2], "little", signed=True) / 32768.0
            acc += v * v
        return (acc / n) ** 0.5


# ----------------------------------------------------------------------------
# PulseAudio discovery
# ----------------------------------------------------------------------------

def pulse_reachable(timeout: float = 1.5) -> tuple[bool, str]:
    """Is a PulseAudio/PipeWire server reachable (TCP via PULSE_SERVER, or a local socket)?"""
    pactl = _which("pactl")
    if pactl:
        rc, out, err = _run([pactl, "info"], timeout=timeout + 2)
        if rc == 0:
            text = out.decode("utf-8", "replace")
            srv = ""
            for line in text.splitlines():
                if line.lower().startswith("server name"):
                    srv = line.split(":", 1)[1].strip()
            return True, srv or "pulse"
        detail = (err or b"").decode("utf-8", "replace").strip().splitlines()
        return False, (detail[-1] if detail else "pactl failed")

    server = cfg.PULSE_SERVER
    if server.startswith("tcp:"):
        hostport = server[4:]
        host, _, port = hostport.partition(":")
        import socket

        try:
            with socket.create_connection((host or "127.0.0.1", int(port or 4713)), timeout=timeout):
                return True, "pulse-tcp"
        except Exception as e:
            return False, f"{host}:{port} unreachable ({e.__class__.__name__})"
    sock = Path(os.environ.get("XDG_RUNTIME_DIR", "/run/user/%s" % os.getuid())) / "pulse" / "native"
    if sock.exists():
        return True, "pulse-unix"
    return False, "no pulse server found"


def pulse_default_source() -> str:
    pactl = _which("pactl")
    if not pactl:
        return ""
    rc, out, _ = _run([pactl, "get-default-source"], timeout=4)
    return out.decode().strip() if rc == 0 else ""


def pulse_sources() -> list[str]:
    pactl = _which("pactl")
    if not pactl:
        return []
    rc, out, _ = _run([pactl, "list", "short", "sources"], timeout=6)
    if rc != 0:
        return []
    names = []
    for line in out.decode("utf-8", "replace").splitlines():
        parts = line.split("\t")
        if len(parts) > 1 and parts[1]:
            names.append(parts[1])
    return names


def pulse_default_is_virtual() -> bool:
    """True when the default source is a pipe/monitor, not real hardware.

    The Termux parrot-audio bridge exposes `parrot_mic` as a module-pipe-source.
    If its feeder is down, parec opens the pipe but never receives a byte, so
    trying it first costs a full probe timeout. Prefer the direct SLES source
    in that case.
    """
    default = pulse_default_source()
    if not default:
        return False
    pactl = _which("pactl")
    if not pactl:
        return False
    rc, out, _ = _run([pactl, "list", "short", "sources"], timeout=5)
    if rc != 0:
        return False
    for line in out.decode("utf-8", "replace").splitlines():
        parts = line.split("\t")
        if len(parts) > 2 and parts[1] == default:
            driver = parts[2].lower()
            return "module-pipe-source" in driver or "monitor" in parts[1].lower()
    return False


def _sles_supported() -> bool:
    """True when this machine can expose the Android phone mic via SLES."""
    if cfg.PULSE_SLES_DISABLE:
        return False
    if cfg.IS_ANDROID or cfg.IS_TERMUX:
        return True
    return os.environ.get("JARVIS_VOICE_SLES_ALLOW", "").strip().lower() in ("1", "true", "yes", "on")


def _sles_module_id(source_name: str) -> str | None:
    """Module id of a module-sles-source for *source_name*, if one is loaded."""
    pactl = _which("pactl")
    if not pactl:
        return None
    rc, out, _ = _run([pactl, "list", "short", "modules"], timeout=5)
    if rc != 0:
        return None
    for line in out.decode("utf-8", "replace").splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[1] == "module-sles-source" and f"source_name={source_name}" in parts[2]:
            return parts[0]
    return None


def _load_sles_module(source_name: str = "") -> str:
    """Load a private module-sles-source and return its module id."""
    pactl = _which("pactl")
    if not pactl:
        raise AudioError("pactl not installed")
    name = source_name or cfg.PULSE_SLES_SOURCE
    old = _sles_module_id(name)
    if old:
        _run([pactl, "unload-module", old], timeout=4)
    rc, out, err = _run(
        [pactl, "load-module", "module-sles-source", f"source_name={name}",
         "format=s16le", "rate=48000", "channels=1"],
        timeout=8,
    )
    mid = (out.decode("utf-8", "replace").strip().splitlines() or [""])[-1].strip()
    if rc != 0 or not mid.isdigit():
        detail = (err or out).decode("utf-8", "replace").strip().splitlines()
        raise AudioError(f"module-sles-source failed: {detail[-1] if detail else f'rc={rc}'}")
    return mid


_sles_lock = threading.Lock()


def prepare_sles() -> str | None:
    """Load the phone mic ahead of recording, so pressing PTT is immediate.

    The module stays loaded while the on-demand daemon is alive and is released
    on daemon shutdown. This removes the ~1 s module-load gap from the start of
    every utterance.
    """
    if not _sles_supported() or not _which("parec") or not _which("pactl"):
        return None
    ok, _ = pulse_reachable()
    if not ok:
        return None
    with _sles_lock:
        mid = _sles_module_id(cfg.PULSE_SLES_SOURCE)
        if mid:
            return mid
        try:
            return _load_sles_module(cfg.PULSE_SLES_SOURCE)
        except AudioError:
            return None


def release_sles() -> None:
    """Unload the phone-mic module loaded by prepare_sles()."""
    if not _sles_supported():
        return
    pactl = _which("pactl")
    if not pactl:
        return
    with _sles_lock:
        mid = _sles_module_id(cfg.PULSE_SLES_SOURCE)
        if mid:
            _run([pactl, "unload-module", mid], timeout=4)


# ----------------------------------------------------------------------------
# Capture
# ----------------------------------------------------------------------------

class Capture:
    """Reads fixed-size raw S16LE mono blocks produced by a child process."""

    def __init__(self, name: str, proc: subprocess.Popen):
        self.name = name
        self.proc = proc
        self._q: "queue.Queue[bytes]" = queue.Queue(maxsize=96)
        # Leftover bytes from a pipe chunk. A child writes large chunks, but
        # callers ask for small VAD blocks; without this buffer most of the
        # audio was silently discarded after every read.
        self._buf = bytearray()
        self._err: list[str] = []
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self) -> None:
        stdout = self.proc.stdout
        if stdout is None:
            return
        try:
            while True:
                chunk = stdout.read(8192)
                if not chunk:
                    break
                try:
                    self._q.put(chunk, timeout=2)
                except queue.Full:
                    pass  # consumer behind: drop audio instead of blocking the reader
        except Exception as e:
            self._err.append(str(e))

    def read(self, nbytes: int, timeout: float) -> bytes:
        # Start with whatever was left from the previous (larger) pipe chunk.
        buf = self._buf
        self._buf = bytearray()
        deadline = time.time() + timeout
        while len(buf) < nbytes:
            remain = deadline - time.time()
            if remain <= 0:
                # Keep a partial block so a short hiccup does not lose samples.
                self._buf = buf
                raise AudioError(f"{self.name}: no audio within {timeout:.1f}s ({len(buf)}/{nbytes} bytes)")
            try:
                buf.extend(self._q.get(timeout=min(remain, 0.4)))
            except queue.Empty:
                if self.proc.poll() is not None:
                    self._buf = buf
                    raise AudioError(f"{self.name}: {self._failure_detail()}")
                continue
        out = bytes(buf[:nbytes])
        self._buf = bytearray(buf[nbytes:])
        return out

    def _failure_detail(self) -> str:
        detail = ""
        try:
            if self.proc.stderr:
                detail = self.proc.stderr.read().decode("utf-8", "replace").strip()
        except Exception:
            pass
        if not detail and self._err:
            detail = self._err[-1]
        if not detail:
            detail = "no output"
        return f"exited rc={self.proc.returncode}: {detail[:240]}"

    def drain(self) -> int:
        """Throw away audio buffered while nobody was listening.

        A live conversation keeps the stream open between turns; whatever was
        captured during the spoken answer is the speaker's voice, not the
        user's, and must not become the next transcript.
        """
        dropped = 0
        while True:
            try:
                self._q.get_nowait()
                dropped += 1
            except queue.Empty:
                break
        self._buf.clear()
        return dropped

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=3)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        for s in (self.proc.stdout, self.proc.stderr):
            try:
                s and s.close()
            except Exception:
                pass


# ----------------------------------------------------------------------------
# Backend command builders
# ----------------------------------------------------------------------------

def backend_available(name: str) -> tuple[bool, str]:
    if name == "pulse":
        if not _which("parec"):
            return False, "parec not installed"
        ok, why = pulse_reachable()
        return (True, why) if ok else (False, f"pulse unreachable: {why}")
    if name == "pulse-sles":
        if not _sles_supported():
            return False, "SLES phone-mic backend not enabled on this platform"
        if not _which("parec"):
            return False, "parec not installed"
        if not _which("pactl"):
            return False, "pactl not installed"
        ok, why = pulse_reachable()
        return (True, f"{why} (sles)") if ok else (False, f"pulse unreachable: {why}")
    if name == "sounddevice":
        try:
            import sounddevice  # noqa: F401

            return True, "portaudio"
        except Exception as e:
            return False, f"sounddevice unavailable: {e}"
    if name == "arecord":
        return (True, "alsa") if _which("arecord") else (False, "arecord not installed")
    if name == "sox":
        if not _which("rec") and not _which("sox"):
            return False, "sox not installed"
        return True, "sox"
    if name == "ffmpeg":
        return (True, "ffmpeg") if _which("ffmpeg") else (False, "ffmpeg not installed")
    if name == "termux":
        return (True, "termux-api") if _which("termux-microphone-record") else (False, "termux-api not installed")
    return False, f"unknown backend {name}"


def _device_arg() -> str:
    return cfg.INPUT_DEVICE or ""


def device_for_backend(device: str, backend: str) -> str:
    """Hand a chosen device only to the backend family that understands it.

    The TUI sends a prefixed id so one choice cannot be handed to a backend
    that cannot use it: `pulse:jarvis_mic`, `alsa:hw:1,0`, `index:3`,
    `name:USB Audio`, `termux:default`. An id without a prefix keeps the old
    behaviour and is passed to every backend.
    """
    dev = (device or "").strip()
    if not dev:
        return ""
    kind, sep, value = dev.partition(":")
    if not sep:
        return dev
    value = value.strip()
    if kind == "pulse":
        return value if backend in ("pulse", "pulse-sles") else ""
    if kind == "termux":
        return value if backend == "termux" else ""
    if kind in ("alsa", "index", "name"):
        # sox has no portable way to take an explicit input device: `-d` is
        # the *default* device and a name after it is an output file. A chosen
        # device must never end up on a different microphone, so sox stays out
        # of this family.
        return value if backend in ("sounddevice", "arecord", "ffmpeg") else ""
    return dev


def _backend_uses_device(backend: str, device: str) -> bool:
    """True when this backend can open the chosen device itself.

    `device_for_backend` returns "" for a device the backend cannot use, which
    would make that backend quietly open its own default microphone. An
    explicit choice must never mean "some other microphone".
    """
    dev = (device or "").strip()
    if not dev:
        return True
    if backend == "sox":
        # sox can name an input driver only for ALSA/PulseAudio ids. Anything
        # else (a PortAudio index or a device name) would fall back to its
        # default source, so sox is not allowed near those choices.
        kind = dev.partition(":")[0].lower()
        return kind in ("alsa", "hw", "plughw", "default", "sysdefault", "pulse", "pulseaudio")
    return bool(device_for_backend(dev, backend))


def device_backend_order(device: str) -> list[str]:
    """The capture backends that can use a chosen device.

    An explicit choice never falls back to a different microphone: either the
    picked input opens, or the turn fails with a clear reason.
    """
    dev = (device or "").strip()
    kind = dev.partition(":")[0] if ":" in dev else ""
    if kind == "termux":
        return ["termux"]
    if kind == "pulse":
        return ["pulse-sles", "pulse"]
    if kind in ("alsa", "index", "name"):
        return ["sounddevice", "arecord", "ffmpeg"]
    return capture_order()


def _sounddevice_cmd(sr: int, device: str = "") -> list[str]:
    return [sys.executable, str(SELF), "stream", "--backend", "sounddevice", "--sr", str(sr),
            "--device", device or _device_arg()]


def _termux_cmd(sr: int, device: str = "") -> list[str]:
    return [sys.executable, str(SELF), "stream", "--backend", "termux", "--sr", str(sr),
            "--device", device or _device_arg()]


def backend_command(name: str, sr: int, device: str | None = None) -> list[str]:
    """The command whose stdout is raw S16LE mono at `sr`."""
    dev = device_for_backend(device or "", name) or _device_arg()
    if name == "sounddevice":
        return _sounddevice_cmd(sr, dev)
    if name == "termux":
        return _termux_cmd(sr, dev)
    if name == "pulse":
        cmd = [_which("parec") or "parec", "--format=s16le", f"--rate={sr}", "--channels=1", "--latency-msec=20"]
        if dev:
            cmd.append(f"--device={dev}")
        return cmd
    if name == "pulse-sles":
        return [sys.executable, str(SELF), "stream", "--backend", "pulse-sles",
                "--sr", str(sr), "--device", dev]
    if name == "arecord":
        cmd = [_which("arecord") or "arecord", "-q", "-f", "S16_LE", "-r", str(sr), "-c", "1", "-t", "raw"]
        if dev:
            cmd += ["-D", dev]
        return cmd + ["-"]
    if name == "sox":
        # The explicit device (when there is one) keeps its prefix here, so the
        # input audio driver can be named: `-t alsa hw:1,0` / `-t pulseaudio
        # name`. A bare `-d name` would read the default device and write to a
        # file called `name` - the wrong microphone and a stray file.
        rec = _which("rec") or "rec"
        raw = (device or "").strip() or _device_arg()
        kind, _, rest = raw.partition(":")
        rest = rest.strip()
        if kind == "alsa":
            value, fmt = rest, "alsa"
        elif kind in ("hw", "plughw", "default", "sysdefault"):
            # A bare ALSA id: the colon belongs to the id, not a namespace.
            value, fmt = raw, "alsa"
        elif kind in ("pulse", "pulseaudio"):
            value, fmt = rest, "pulseaudio"
        else:
            value, fmt = "", ""
        base = [rec, "-q"]
        if value and fmt:
            base += ["-t", fmt, value]
        base += ["-t", "raw", "-r", str(sr), "-c", "1", "-e", "signed", "-b", "16"]
        return base + ["-"]
    if name == "ffmpeg":
        ffmpeg = _which("ffmpeg") or "ffmpeg"
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
        if cfg.IS_WINDOWS:
            cmd += ["-f", "dshow", "-i", f"audio={dev}" if dev else "audio=default"]
        elif cfg.IS_MACOS:
            cmd += ["-f", "avfoundation", "-i", f":{dev or '0'}"]
        elif pulse_reachable()[0]:
            cmd += ["-f", "pulse", "-i", dev or "@DEFAULT_SOURCE@"]
        else:
            cmd += ["-f", "alsa", "-i", dev or "default"]
        return cmd + ["-ac", "1", "-ar", str(sr), "-f", "s16le", "-"]
    raise AudioError(f"unknown backend {name}")


def capture_order() -> list[str]:
    all_backends = ("pulse", "pulse-sles", "termux", "sounddevice", "arecord", "sox", "ffmpeg")
    if cfg.FORCE_CAPTURE_BACKEND:
        return [cfg.FORCE_CAPTURE_BACKEND] + [b for b in all_backends if b != cfg.FORCE_CAPTURE_BACKEND]
    # Respect a real default (Bluetooth/USB) first. If the default is the
    # parrot-audio virtual pipe, open the phone mic directly first instead of
    # waiting for a feeder that may not exist.
    if cfg.IS_ANDROID or cfg.IS_TERMUX:
        first = ["pulse-sles", "pulse"] if pulse_default_is_virtual() else ["pulse", "pulse-sles"]
        return first + [b for b in all_backends if b not in first]
    return ["pulse"] + [b for b in all_backends if b != "pulse"]


def spawn_capture(name: str, sr: int, device: str | None = None) -> Capture:
    """Start one backend. Raises AudioError if it cannot even be launched."""
    ok, why = backend_available(name)
    if not ok:
        raise AudioError(f"{name} unavailable: {why}")
    cmd = backend_command(name, sr, device)
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                stdin=subprocess.DEVNULL, bufsize=0)
    except Exception as e:
        raise AudioError(f"{name}: cannot start ({e})") from e
    return Capture(name, proc)


# ----------------------------------------------------------------------------
# Probing (crash-isolated: one child process per backend)
# ----------------------------------------------------------------------------

def probe_backend_in_child(name: str, sr: int, timeout: float | None = None,
                           device: str | None = None) -> dict:
    """Probe a single backend inside its own process, so a native fault is contained."""
    timeout = timeout or cfg.PROBE_TIMEOUT
    cmd = [sys.executable, str(SELF), "probe-one", "--backend", name, "--sr", str(sr)]
    dev = device_for_backend(device or "", name)
    if dev:
        cmd += ["--device", dev]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout + 2)
    except subprocess.TimeoutExpired:
        return {"backend": name, "ok": False, "reason": f"probe timed out after {timeout + 2:.0f}s"}
    except Exception as e:
        return {"backend": name, "ok": False, "reason": f"{type(e).__name__}: {e}"}
    out = (p.stdout or b"").decode("utf-8", "replace").strip().splitlines()
    for line in reversed(out):
        line = line.strip()
        if line.startswith("{"):
            try:
                import json

                d = json.loads(line)
                if d.get("backend") == name:
                    return d
            except Exception:
                continue
    detail = (p.stderr or b"").decode("utf-8", "replace").strip().splitlines()
    return {"backend": name, "ok": False,
            "reason": f"rc={p.returncode} {(detail[-1] if detail else 'no result')[:200]}"}


def probe_one(name: str, sr: int, device: str | None = None) -> dict:
    """In-process probe for a single backend. Only safe inside the child process."""
    block_bytes = max(1, int(sr * cfg.BLOCK_MS / 1000)) * 2
    # A healthy microphone delivers its first block quickly. A dead virtual
    # pipe returns nothing; cap its wait so probing falls through to SLES.
    limit = 3.0 if name == "pulse" else cfg.PROBE_TIMEOUT
    cap = spawn_capture(name, sr, device)
    try:
        buf = bytearray()
        deadline = time.time() + limit
        need = block_bytes * 4
        while len(buf) < need and time.time() < deadline:
            buf.extend(cap.read(block_bytes, timeout=limit))
        level = rms(bytes(buf[:need]))
        return {"backend": name, "ok": True, "rms": round(level, 5), "sr": sr,
                "device": device or cfg.INPUT_DEVICE}
    finally:
        cap.close()


def probe_capture(sr: int | None = None, save: bool = True, device: str | None = None) -> dict:
    """Pick the first backend that really delivers samples. Safe to call from the daemon."""
    sr = sr or cfg.SAMPLE_RATE
    tried: list[dict] = []
    fallback: tuple[str, str, dict] | None = None
    for name in device_backend_order(device or ""):
        ok, why = backend_available(name)
        if not ok:
            tried.append({"backend": name, "ok": False, "reason": why})
            continue
        res = probe_backend_in_child(name, sr, device=device)
        tried.append(res)
        if not res.get("ok"):
            continue
        # A backend can "work" while returning digital silence (e.g. a virtual
        # pipe with no feeder). Prefer one with actual samples; keep the first
        # successful backend as a last resort for a genuinely silent room.
        if fallback is None:
            fallback = (name, why, res)
        if float(res.get("rms") or 0.0) > 1e-6:
            result = {"backend": name, "reason": why, "sr": sr, "rms": res.get("rms"),
                      "device": cfg.INPUT_DEVICE, "tried": tried}
            if save:
                _save_backend(result)
            return result

    if fallback is not None:
        name, why, res = fallback
        result = {"backend": name, "reason": why, "sr": sr, "rms": res.get("rms"),
                  "silent": True, "device": cfg.INPUT_DEVICE, "tried": tried}
        if save:
            _save_backend(result)
        return result

    pulse_ok, pulse_why = pulse_reachable()
    result = {
        "backend": None,
        "reason": "no working capture backend",
        "pulse": {"reachable": pulse_ok, "detail": pulse_why, "server": cfg.PULSE_SERVER},
        "tried": tried,
        "hints": capture_hints(pulse_ok, pulse_why),
    }
    if save:
        _save_backend(result)
    return result


def cached_probe() -> dict | None:
    try:
        import json

        if cfg.BACKEND_FILE.exists():
            d = json.loads(cfg.BACKEND_FILE.read_text())
            return d if isinstance(d, dict) else None
    except Exception:
        pass
    return None


def capture_hints(pulse_ok: bool, pulse_why: str) -> list[str]:
    hints: list[str] = []
    if cfg.IS_ANDROID and not pulse_ok:
        hints.append("Start the Termux audio bridge:  bash bin/termux-pulse")
        hints.append("Or install the Termux audio deps:  pkg install termux-api portaudio && pip install sounddevice")
    if _which("parec") and not pulse_ok:
        hints.append(f"PulseAudio is not answering ({pulse_why}). Start it, or run this daemon directly in Termux.")
    if not hints:
        hints.append("Run `voice doctor` for a per-backend report.")
    return hints


def _save_backend(result: dict) -> None:
    try:
        import json

        cfg.BACKEND_FILE.write_text(json.dumps(result, indent=2))
    except Exception:
        pass


def open_capture(sr: int | None = None, prefer: str | None = None,
                 device: str | None = None) -> Capture:
    """Open a capture stream, trying backends in order until one yields audio."""
    sr = sr or cfg.SAMPLE_RATE
    order = device_backend_order(device or "")
    explicit = bool((device or "").strip())
    if prefer:
        order = [prefer] + [b for b in order if b != prefer]
    elif not explicit:
        cached = cached_probe()
        # Old cache files can point at a virtual source that only produced
        # silence. Do not trust those; re-probe on the next real recording.
        if cached and cached.get("backend") and not cached.get("silent") \
                and float(cached.get("rms") or 0.0) > 1e-6:
            best = cached["backend"]
            order = [best] + [b for b in order if b != best]
    if explicit:
        # A chosen device is a promise, not a hint. Never let a backend that
        # cannot use it (and would fall back to its own default source) open
        # the wrong microphone just because it was the fastest last time.
        order = [name for name in order if _backend_uses_device(name, device)]

    errors: list[str] = []
    block = max(1, int(sr * cfg.BLOCK_MS / 1000)) * 2
    for name in order:
        try:
            cap = spawn_capture(name, sr, device)
        except AudioError as e:
            errors.append(str(e))
            continue
        try:
            # Read a few blocks rather than one: a dead virtual source returns
            # perfectly zero PCM immediately, while a real mic always has some
            # noise floor. The ~120 ms head is kept for the caller, not dropped.
            head = bytearray()
            head_timeout = min(float(cfg.PROBE_TIMEOUT), 3.0)
            for _ in range(4):
                head.extend(cap.read(block, timeout=head_timeout))
            if not any(head):
                errors.append(f"{name}: silent (no samples)")
                cap.close()
                continue
            # Keep the probe's audio for the actual recording: the caller
            # normally starts speaking the instant it opens the mic.
            cap._buf = head + cap._buf
            return cap
        except Exception as e:
            errors.append(f"{name}: {e}"[:200])
            try:
                cap.close()
            except Exception:
                pass
    raise AudioError(
        (f"microphone '{device}' could not be opened. " if device else "no capture backend works. ")
        + " | ".join(errors)
    )


# A PTT turn opens the mic when the button is pressed, not when the recording
# thread gets scheduled. Opening a real phone-mic stream can take ~0.7 s; keeping
# the already-open stream (and the audio it buffered) avoids losing the first
# word after the "Listening" cue.
_warm_lock = threading.Lock()
_warm_cap: Capture | None = None
_warm_at = 0.0
_warm_device: str = ""


def warm_capture(sr: int | None = None, device: str | None = None) -> Capture:
    """Open (or reuse) a capture stream and let it buffer until PTT consumes it."""
    global _warm_cap, _warm_at, _warm_device
    sr = sr or cfg.SAMPLE_RATE
    want = (device or "").strip()
    with _warm_lock:
        if (_warm_cap is not None and _warm_cap.proc.poll() is None
                and time.time() - _warm_at < 30 and _warm_device == want):
            return _warm_cap
        if _warm_cap is not None:
            try:
                _warm_cap.close()
            except Exception:
                pass
            _warm_cap = None
        _warm_cap = open_capture(sr, device=want)
        _warm_at = time.time()
        _warm_device = want
        return _warm_cap


def take_capture(sr: int | None = None, device: str | None = None) -> Capture:
    """Consume the warm PTT stream, or open a fresh one for non-PTT capture."""
    global _warm_cap, _warm_device
    sr = sr or cfg.SAMPLE_RATE
    want = (device or "").strip()
    with _warm_lock:
        cap = _warm_cap
        _warm_cap = None
        if cap is not None and cap.proc.poll() is None and _warm_device == want:
            _warm_device = ""
            return cap
        if cap is not None:
            _warm_device = ""
            try:
                cap.close()
            except Exception:
                pass
    return open_capture(sr, device=want)


def drop_warm_capture() -> None:
    """Close an unused warm stream (daemon shutdown / cancelled PTT)."""
    global _warm_cap
    with _warm_lock:
        cap = _warm_cap
        _warm_cap = None
    if cap is not None:
        try:
            cap.close()
        except Exception:
            pass


# ----------------------------------------------------------------------------
# Child-process streamers
# ----------------------------------------------------------------------------

def _stream_sounddevice(sr: int, device: str) -> int:
    """PortAudio reader. Lives in its own process on purpose."""
    import sounddevice as sd

    dev_arg = None
    if device:
        try:
            dev_arg = int(device)
        except ValueError:
            dev_arg = device
    out = sys.stdout.buffer
    with sd.RawInputStream(samplerate=sr, channels=1, dtype="int16", blocksize=0, device=dev_arg) as stream:
        while True:
            data, _overflow = stream.read(2048)
            if not data:
                continue
            try:
                out.write(bytes(data))
                out.flush()
            except (BrokenPipeError, OSError):
                return 0
    return 0


def _stream_termux(sr: int, device: str) -> int:
    """Termux:API records to a file; we tail it and emit PCM."""
    exe = _which("termux-microphone-record") or "termux-microphone-record"
    path = Path(cfg.CACHE_DIR) / f"termux_{os.getpid()}.wav"
    try:
        path.unlink()
    except Exception:
        pass
    _run([exe, "-f", str(path), "-r", str(sr), "-c", "1", "-l", "0"], timeout=8)
    out = sys.stdout.buffer
    offset = 0
    header_skipped = False
    try:
        while True:
            if not path.exists():
                time.sleep(0.05)
                continue
            with open(path, "rb") as f:
                if not header_skipped:
                    head = f.read(12)
                    if len(head) < 12:
                        time.sleep(0.05)
                        continue
                    if head[:4] == b"RIFF":
                        f.seek(0)
                        # find the data chunk so the header size can grow while recording
                        buf = f.read(4096)
                        idx = buf.find(b"data")
                        offset = (idx + 8) if idx >= 0 else 44
                    else:
                        offset = 0
                    header_skipped = True
                f.seek(offset)
                data = f.read()
                offset += len(data)
            if data:
                try:
                    out.write(data)
                    out.flush()
                except (BrokenPipeError, OSError):
                    return 0
            else:
                time.sleep(0.05)
    finally:
        _run([exe, "-q"], timeout=5)
        try:
            path.unlink()
        except Exception:
            pass
    return 0


def _stream_pulse_sles(sr: int, device: str) -> int:
    """Stream the Android phone mic via PulseAudio's module-sles-source.

    This bypasses fragile virtual pipe sources (and their external feeder
    daemons) entirely: module-sles-source reads the real phone microphone. The
    parent daemon may preload the module for a PTT turn and keep it until it
    exits; otherwise this helper loads the source and unloads it on close.
    """
    pactl = _which("pactl")
    parec = _which("parec")
    if not pactl or not parec:
        raise AudioError("pactl and parec are required for the SLES backend")

    name = (device or "").strip()
    manage = False
    if not name or name in ("auto", "default", "pulse"):
        name = cfg.PULSE_SLES_SOURCE
        manage = True
    elif name == cfg.PULSE_SLES_SOURCE:
        manage = True

    module_id = ""
    if manage:
        # prepare_sles() may already have loaded the source for this PTT turn.
        # In that case the parent owns it; do not unload it when this child exits.
        if _sles_module_id(name):
            manage = False
        else:
            try:
                module_id = _load_sles_module(name)
            except AudioError:
                # The external parrot-audio helper may already hold the hardware
                # source. Reuse it instead of failing the recording.
                if "parrot_mic_hw" in pulse_sources():
                    name = "parrot_mic_hw"
                    manage = False
                else:
                    raise

    cmd = [parec, f"--device={name}", "--format=s16le", f"--rate={sr}",
           "--channels=1", "--latency-msec=20"]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        bufsize=0,
    )

    def _stop(_signum, _frame):
        # Raise through the read loop so the finally block can unload the
        # source even when the parent terminates this helper.
        raise SystemExit(0)

    old_term = signal.signal(signal.SIGTERM, _stop)
    old_int = signal.signal(signal.SIGINT, _stop)
    out = sys.stdout.buffer
    try:
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(8192)
            if not chunk:
                break
            try:
                out.write(chunk)
                out.flush()
            except (BrokenPipeError, OSError):
                break
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        if manage and module_id:
            _run([pactl, "unload-module", module_id], timeout=4)
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGINT, old_int)
    return 0


def _stream(name: str, sr: int, device: str) -> int:
    if name == "sounddevice":
        return _stream_sounddevice(sr, device)
    if name == "termux":
        return _stream_termux(sr, device)
    if name == "pulse-sles":
        return _stream_pulse_sles(sr, device)
    raise AudioError(f"backend {name} has no child streamer")


# ----------------------------------------------------------------------------
# Playback
# ----------------------------------------------------------------------------

_pulse_play_seen = 0.0
_pulse_play_ok = False


def _pulse_can_play() -> bool:
    """Is there a Pulse server for paplay right now? Cached: it changes rarely."""
    global _pulse_play_seen, _pulse_play_ok
    now = time.time()
    if now - _pulse_play_seen < 30.0:
        return _pulse_play_ok
    ok = False
    server = cfg.PULSE_SERVER
    if server.startswith("tcp:"):
        # A raw connect is as good as `pactl info` here and cannot hang for
        # seconds on a dead server, which would delay the first words.
        import socket

        host, _, port = server[4:].partition(":")
        try:
            with socket.create_connection((host or "127.0.0.1", int(port or 4713)), timeout=0.2):
                ok = True
        except Exception:
            ok = False
    else:
        try:
            ok, _why = pulse_reachable(timeout=0.4)
        except Exception:
            ok = False
    _pulse_play_seen = now
    _pulse_play_ok = ok
    return ok


def _playback_candidates() -> list[str]:
    if cfg.FORCE_PLAYBACK_BACKEND:
        return [cfg.FORCE_PLAYBACK_BACKEND]
    c = []
    # paplay without a Pulse server fails on every clip. The daemon may have
    # PULSE_SERVER set for the SLES microphone while no server is running, so
    # ask before adding it instead of burning a failed start each time.
    if _which("paplay") and _pulse_can_play():
        c.append("paplay")
    # SDL/ffplay handles the Android ALSA device more gracefully than a raw
    # aplay stream, which can die mid-clip with pcm_write I/O errors there.
    if _which("ffplay"):
        c.append("ffplay")
    if _which("aplay"):
        c.append("aplay")
    if _which("play"):
        c.append("play")
    c.append("sounddevice")
    if _which("termux-media-player"):
        c.append("termux-media-player")
    if cfg.IS_WINDOWS:
        c.append("powershell")
    # Start with the player that worked last time. On a phone the first
    # candidate can fail after a second of audio, and falling through to the
    # next one used to replay the same clip from the beginning.
    last = _playback_state.get("last_ok")
    if last in c:
        c.remove(last)
        c.insert(0, last)
    return c


_PLAYBACK_HINT = cfg.CACHE_DIR / "playback-backend"


def _load_playback_hint() -> str | None:
    try:
        value = _PLAYBACK_HINT.read_text().strip()
        return value or None
    except Exception:
        return None


def _remember_playback(backend: str) -> None:
    if _playback_state.get("last_ok") == backend:
        return
    _playback_state["last_ok"] = backend
    try:
        _PLAYBACK_HINT.parent.mkdir(parents=True, exist_ok=True)
        _PLAYBACK_HINT.write_text(backend)
    except Exception:
        pass


_playback_state: dict = {
    "proc": None,
    "lock": threading.Lock(),
    "paused": False,
    "started_at": 0.0,
    "command": None,
    "last_ok": _load_playback_hint(),
}


# A player that dies sooner than this never produced sound worth hearing;
# trying the next backend is safe. After it, retrying would replay the clip
# from the start - the "cut then repeat" the reader used to produce.
_PLAYED_ANY_MS = 350


def play_wav(path: str | Path, timeout: float = 120) -> dict:
    path = Path(path)
    if not path.exists():
        raise AudioError(f"audio file missing: {path}")
    errors = []
    for backend in _playback_candidates():
        started = time.time()
        try:
            if backend in ("paplay", "aplay", "ffplay", "play"):
                cmd = {
                    "paplay": lambda: [_which("paplay") or "paplay", str(path)],
                    "aplay": lambda: [_which("aplay") or "aplay", "-q"] + (["-D", cfg.OUTPUT_DEVICE] if cfg.OUTPUT_DEVICE else []) + [str(path)],
                    "ffplay": lambda: [_which("ffplay") or "ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)],
                    "play": lambda: [_which("play") or "play", "-q", str(path)],
                }[backend]()
                _blocking_play(cmd, timeout)
            elif backend == "termux-media-player":
                _blocking_play([_which("termux-media-player") or "termux-media-player", "play", str(path)], timeout=8)
                _remember_playback(backend)
                return {"backend": backend, "ok": True, "note": "handed to the Android media player"}
            elif backend == "powershell":
                ps = _which("powershell") or "powershell"
                _blocking_play([ps, "-NoProfile", "-Command",
                                f"(New-Object Media.SoundPlayer '{path}').PlaySync();"], timeout)
            elif backend == "sounddevice":
                cmd = [sys.executable, str(SELF), "play-file", str(path)]
                _blocking_play(cmd, timeout)
            else:
                continue
            _remember_playback(backend)
            return {"backend": backend, "ok": True}
        except Exception as e:
            errors.append(f"{backend}: {type(e).__name__}: {e}"[:200])
            if (time.time() - started) * 1000 >= _PLAYED_ANY_MS:
                # Part of the clip reached the speaker. A second backend would
                # start it over, stutter, and repeat the first words: stop here
                # and let the caller decide (usually the next chunk, if any).
                raise AudioError("playback failed after audio started. " + " | ".join(errors)) from e
            continue
    raise AudioError("no playback backend worked. " + " | ".join(errors))


# ----------------------------------------------------------------------------
# Continuous playback: one player for a whole reply
# ----------------------------------------------------------------------------

# Every chunk of a reply is resampled to this rate before it is written to the
# stream. Fish already returns 44.1 kHz; the local fallback may be 22.05 kHz.
STREAM_RATE = 44100


def stream_backend() -> str | None:
    """The backend that can play a continuous PCM stream, if any.

    ffplay is used on purpose: it is the player that survives the Android ALSA
    device here, and it accepts a WAV stream on a pipe. A user-forced backend
    is respected; forcing something else keeps the per-clip path.
    """
    if cfg.FORCE_PLAYBACK_BACKEND:
        return "ffplay" if cfg.FORCE_PLAYBACK_BACKEND == "ffplay" else None
    return "ffplay" if _which("ffplay") else None


def _stream_wav_header(sample_rate: int, channels: int = 1, width: int = 2) -> bytes:
    """A WAV header whose sizes say "until EOF"; ffplay streams it from a pipe."""
    align = max(1, channels * width)
    byte_rate = max(1, sample_rate * align)
    return (
        b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate,
                                byte_rate, align, width * 8)
        + b"data" + struct.pack("<I", 0xFFFFFFFF)
    )


def decode_pcm(path: str | Path, sample_rate: int = STREAM_RATE) -> bytes:
    """Decode an audio file to mono S16LE at `sample_rate`.

    Fish normally returns WAV, which is decoded in-process. The MP3 fallback
    (and a WAV with a strange header) is handed to ffmpeg. A short, clear error
    lets the reader fall back to per-clip playback instead of going silent.
    """
    path = Path(path)
    if path.suffix.lower() == ".wav":
        try:
            pcm, sr, _ = read_wav(path)
            return resample_to(pcm, sr, sample_rate)
        except Exception:
            pass  # fall through to ffmpeg for a broken or unusual WAV
    ffmpeg = _which("ffmpeg")
    if not ffmpeg:
        raise AudioError(f"cannot decode {path.suffix or 'audio'} without ffmpeg")
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
             "-f", "s16le", "-ac", "1", "-ar", str(sample_rate), "-"],
            capture_output=True, timeout=60,
        )
    except Exception as e:
        raise AudioError(f"cannot decode {path.name}: {e}") from e
    if proc.returncode != 0 or not proc.stdout:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        raise AudioError(f"cannot decode {path.name}: "
                         f"{(detail[-1] if detail else 'no PCM')[:200]}")
    return proc.stdout


class PcmStream:
    """A single long-lived player fed PCM as the reply is rendered.

    The old reader started a new `ffplay` for every chunk. Each start/stop left
    a gap and, on the phone's audio HAL, sometimes a click or a stutter. One
    process per reply makes the chunks join seamlessly; stopping the reply is
    one terminate, and pausing is one SIGSTOP.
    """

    def __init__(self, sample_rate: int = STREAM_RATE, channels: int = 1, width: int = 2):
        self.sample_rate = int(sample_rate)
        self.channels = int(channels)
        self.width = int(width)
        self._proc: subprocess.Popen | None = None
        self._closed = False
        self._bytes = 0
        self._err: list[str] = []
        self._start()

    def _start(self) -> None:
        ffplay = _which("ffplay")
        if not ffplay:
            raise AudioError("continuous playback needs ffplay")
        cmd = [ffplay, "-nodisp", "-autoexit", "-loglevel", "quiet",
               "-f", "wav", "pipe:0"]
        try:
            p = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE, bufsize=0,
                preexec_fn=_child_pdeathsig if os.name == "posix" else None,
            )
        except Exception as e:
            raise AudioError(f"ffplay stream: cannot start ({e})") from e
        self._proc = p

        def _read_err() -> None:
            try:
                if p.stderr is None:
                    return
                for line in p.stderr:
                    text = line.decode("utf-8", "replace").strip()
                    if text:
                        self._err.append(text)
                        del self._err[:-4]
            except Exception:
                pass

        threading.Thread(target=_read_err, daemon=True, name="ffplay-err").start()
        with _playback_state["lock"]:
            _playback_state["proc"] = p
            _playback_state["paused"] = False
            _playback_state["started_at"] = time.time()
            _playback_state["command"] = "ffplay-stream"
        try:
            assert p.stdin is not None
            self._write_all(_stream_wav_header(self.sample_rate, self.channels, self.width))
            p.stdin.flush()
        except Exception as e:
            self.terminate()
            raise AudioError(f"ffplay stream: cannot start ({e})") from e

    def _write_all(self, data: bytes) -> None:
        """Write every byte to the player pipe.

        A pipe is allowed to accept fewer bytes than it was given. Ignoring the
        return value used to drop the rest of a PCM buffer once the player's
        buffer was nearly full, which is heard as a clipped syllable or a small
        gap in the middle of a reply. `memoryview` advances through the buffer
        without copying it.
        """
        p = self._proc
        if p is None or p.stdin is None:
            raise AudioError("ffplay stream is not running")
        view = memoryview(data)
        while view:
            written = p.stdin.write(view)
            if written is None:
                # A raw blocking pipe returns an int, but a wrapper may accept
                # the full buffer and return None. Treat that as complete.
                break
            if written <= 0:
                raise BrokenPipeError("ffplay stream accepted no data")
            view = view[written:]

    def _exit_error(self, cause: Exception | None = None) -> AudioError:
        p = self._proc
        bits = []
        if p is not None and p.poll() is not None:
            bits.append(f"rc={p.returncode}")
        if self._err:
            bits.append(self._err[-1][:160])
        if cause is not None and not bits:
            bits.append(str(cause)[:160])
        return AudioError("ffplay stream stopped" + (f": {' | '.join(bits)}" if bits else ""))

    def write(self, pcm: bytes) -> None:
        """Write PCM to the player. Blocks when its buffer is full (backpressure)."""
        if not pcm:
            return
        if self._closed:
            raise AudioError("ffplay stream is closed")
        p = self._proc
        if p is None or p.stdin is None:
            raise AudioError("ffplay stream is not running")
        if p.poll() is not None:
            raise self._exit_error()
        try:
            self._write_all(pcm)
            p.stdin.flush()
        except (BrokenPipeError, ValueError, OSError) as e:
            raise self._exit_error(e) from e
        self._bytes += len(pcm)

    def _clear_state(self, p: subprocess.Popen | None) -> None:
        with _playback_state["lock"]:
            if p is not None and _playback_state.get("proc") is p:
                _playback_state["proc"] = None
                _playback_state["paused"] = False

    def close(self, wait: bool = True) -> int:
        """Finish the stream. With `wait`, return after the audio has played."""
        self._closed = True
        p = self._proc
        if p is None:
            return 0
        try:
            if p.stdin is not None:
                p.stdin.close()
        except Exception:
            pass
        rc = p.poll()
        if wait and _playback_state.get("paused") and p.poll() is None:
            # The user paused near the end. Keep the player (and its buffered
            # tail) alive so /resume can finish it; terminating here would cut
            # the last sentence.
            return 0
        if wait:
            # Allow the buffered audio to finish, with a generous ceiling: the
            # point of this player is that the reply ends when the voice ends.
            seconds = self._bytes / max(1, self.channels * self.width * self.sample_rate)
            timeout = max(5.0, float(seconds) + 30.0)
            try:
                rc = p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.terminate()
                rc = p.poll()
        self._clear_state(p)
        self._proc = None
        return int(rc or 0)

    def terminate(self) -> None:
        """Stop now: used by /interrupt and when a newer reply takes over."""
        self._closed = True
        p = self._proc
        if p is not None:
            if p.poll() is None:
                try:
                    p.terminate()
                except Exception:
                    pass
            try:
                if p.stdin is not None:
                    p.stdin.close()
            except Exception:
                pass
            deadline = time.time() + 1.5
            while time.time() < deadline and p.poll() is None:
                time.sleep(0.02)
            if p.poll() is None:
                try:
                    p.kill()
                except Exception:
                    pass
                try:
                    p.wait(timeout=0.5)
                except Exception:
                    pass
            self._clear_state(p)
            self._proc = None

    def __enter__(self) -> "PcmStream":
        return self

    def __exit__(self, *_exc) -> None:
        self.terminate()


def open_pcm_stream(sample_rate: int = STREAM_RATE) -> PcmStream:
    """Open a continuous player. Raises AudioError when streaming is unavailable."""
    if stream_backend() != "ffplay":
        raise AudioError("continuous playback is not available on this system")
    return PcmStream(sample_rate)


def _play_file_sounddevice(path: str) -> int:
    import numpy as np
    import sounddevice as sd

    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        raw = wf.readframes(wf.getnframes())
    data = np.frombuffer(raw, dtype="<i2")
    if ch > 1:
        data = data.reshape(-1, ch)
    sd.play(data, sr)
    sd.wait()
    return 0


def _blocking_play(cmd: list[str], timeout: float) -> None:
    with _playback_state["lock"]:
        p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                             stdin=subprocess.DEVNULL,
                             preexec_fn=_child_pdeathsig if os.name == "posix" else None)
        _playback_state["proc"] = p
        _playback_state["paused"] = False
        _playback_state["started_at"] = time.time()
        _playback_state["command"] = cmd[0]
    # The budget only counts while the player is running: a user pause of any
    # length neither eats into it nor turns into a timeout kill.
    budget = timeout
    last = time.time()
    err: bytes | None = b""
    try:
        while True:
            try:
                _, err = p.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                now = time.time()
                if not _playback_state["paused"]:
                    budget -= now - last
                last = now
                if budget <= 0:
                    p.kill()
                    raise AudioError(f"{cmd[0]}: playback timed out")
    finally:
        with _playback_state["lock"]:
            # Only the instance that owns the slot clears it, so a stop +
            # restart racing this wait keeps its own process visible.
            if _playback_state["proc"] is p:
                _playback_state["proc"] = None
                _playback_state["paused"] = False
    # A negative return code means the player was signalled: an intended stop
    # or interrupt, not a playback failure worth raising about.
    if p.returncode is not None and p.returncode > 0:
        raise AudioError(f"{cmd[0]}: rc={p.returncode} {(err or b'').decode('utf-8', 'replace')[:200]}")


def stop_playback() -> None:
    p = _playback_state.get("proc")
    if p and p.poll() is None:
        try:
            if _playback_state.get("paused") and hasattr(signal, "SIGCONT"):
                # A stopped process only acts on SIGTERM once continued.
                p.send_signal(signal.SIGCONT)
            p.terminate()
        except Exception:
            pass
        # Wait for it to actually let go of the speaker. Without this, a new
        # utterance can start while the old one is still draining its buffer,
        # and the two voices overlap (heard as cut/repeated words).
        deadline = time.time() + 1.5
        while time.time() < deadline and p.poll() is None:
            time.sleep(0.02)
        if p.poll() is None:
            try:
                p.kill()
            except Exception:
                pass
            deadline = time.time() + 0.5
            while time.time() < deadline and p.poll() is None:
                time.sleep(0.02)
    with _playback_state["lock"]:
        if _playback_state.get("proc") is p:
            _playback_state["proc"] = None
            _playback_state["paused"] = False
    if _which("termux-media-player"):
        _run(["termux-media-player", "stop"], timeout=4)


def pause_playback() -> bool:
    """Suspend the current player process in place. False when nothing plays."""
    p = _playback_state.get("proc")
    if not p or p.poll() is not None or _playback_state.get("paused"):
        return False
    if not hasattr(signal, "SIGSTOP"):
        return False
    try:
        p.send_signal(signal.SIGSTOP)
    except Exception:
        return False
    _playback_state["paused"] = True
    return True


def resume_playback() -> bool:
    """Continue a paused player process. False when nothing is paused."""
    p = _playback_state.get("proc")
    if not p or p.poll() is not None or not _playback_state.get("paused"):
        return False
    if not hasattr(signal, "SIGCONT"):
        return False
    try:
        p.send_signal(signal.SIGCONT)
    except Exception:
        return False
    _playback_state["paused"] = False
    return True


def playback_status() -> dict:
    """What the local speakers are doing right now."""
    p = _playback_state.get("proc")
    active = bool(p and p.poll() is None)
    started = float(_playback_state.get("started_at") or 0.0)
    return {
        "playing": active,
        "paused": bool(active and _playback_state.get("paused")),
        "player": _playback_state.get("command") if active else None,
        "pid": p.pid if (active and p) else None,
        "elapsed_ms": int((time.time() - started) * 1000) if (active and started) else 0,
    }


# ----------------------------------------------------------------------------
# WAV helpers
# ----------------------------------------------------------------------------

def write_wav(path: str | Path, pcm: bytes, sr: int, channels: int = 1, width: int = 2) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(width)
        wf.setframerate(sr)
        wf.writeframes(pcm)
    return path


def read_wav(path) -> tuple[bytes, int, int]:
    """Read 16-bit WAV into mono PCM. Accepts a filesystem path or a file-like object."""
    src = str(path) if isinstance(path, (str, Path)) else path
    with wave.open(src, "rb") as wf:  # type: ignore[arg-type]
        sr = wf.getframerate()
        ch = wf.getnchannels()
        width = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if width != 2:
        raise AudioError(f"only 16-bit WAV supported, got {width * 8}-bit")
    if ch > 1:
        try:
            import numpy as np

            a = np.frombuffer(raw, dtype="<i2").reshape(-1, ch)
            raw = a.mean(axis=1).astype("<i2").tobytes()
        except Exception:
            pass
    return raw, sr, 1


def resample_to(pcm: bytes, sr_from: int, sr_to: int) -> bytes:
    if sr_from == sr_to:
        return pcm
    try:
        import audioop

        out, _ = audioop.ratecv(pcm, 2, 1, sr_from, sr_to, None)
        return out
    except Exception:
        pass
    try:
        import numpy as np

        a = np.frombuffer(pcm, dtype="<i2").astype("float32")
        idx = np.linspace(0, len(a) - 1, int(len(a) * sr_to / sr_from)).astype("int64")
        return a[idx].astype("<i2").tobytes()
    except Exception:
        return pcm


def pulse_source_details() -> list[dict]:
    """The PulseAudio input sources with a readable description."""
    pactl = _which("pactl")
    if not pactl:
        return []
    rc, out, _ = _run([pactl, "list", "short", "sources"], timeout=6)
    if rc != 0:
        return []
    rows = []
    for line in out.decode("utf-8", "replace").splitlines():
        parts = line.split("\t")
        if len(parts) < 2 or not parts[1]:
            continue
        name = parts[1]
        driver = parts[2] if len(parts) > 2 else ""
        low = driver.lower()
        if "module-sles-source" in low:
            kind, detail = "pulse", "Android phone microphone (SLES)"
        elif "module-pipe-source" in low:
            kind, detail = "pulse", "piped microphone (Termux:API bridge)"
        elif "monitor" in name.lower() or "monitor" in low:
            kind, detail = "pulse", "monitor (not a microphone)"
        else:
            kind, detail = "pulse", "PulseAudio source"
        rows.append({"name": name, "driver": driver, "kind": kind, "detail": detail,
                     "state": parts[4] if len(parts) > 4 else ""})
    return rows


def list_input_devices() -> dict:
    out: dict = {
        "capture": {
            "order": capture_order(),
            "cached": cached_probe(),
            "input_device": cfg.INPUT_DEVICE,
            "sles_source": cfg.PULSE_SLES_SOURCE,
            "sles_available": backend_available("pulse-sles")[0],
        },
        "pulse": {"sources": pulse_sources(), "default": pulse_default_source(),
                  "server": cfg.PULSE_SERVER},
    }
    # Load the phone mic module so it shows up in the list of choices.
    try:
        prepare_sles()
    except Exception:
        pass

    choices: list[dict] = [{
        "id": "",
        "label": "Automatic (recommended)",
        "kind": "auto",
        "detail": "The daemon picks the best working microphone",
    }]

    for src in pulse_source_details():
        choices.append({
            "id": f"pulse:{src['name']}",
            "label": src["name"],
            "kind": "pulse",
            "detail": src["detail"],
            "state": src.get("state", ""),
        })

    termux_ok, termux_why = backend_available("termux")
    choices.append({
        "id": "termux:default",
        "label": "Termux:API microphone",
        "kind": "termux",
        "detail": "termux-microphone-record" + ("" if termux_ok else f" (not installed: {termux_why})"),
        "available": termux_ok,
    })

    try:
        import sounddevice as sd

        devs = []
        for i, d in enumerate(sd.query_devices()):
            if d.get("max_input_channels", 0) > 0:
                devs.append({"index": i, "name": d.get("name"), "channels": d["max_input_channels"],
                             "sr": d.get("default_samplerate")})
        out["sounddevice"] = devs
        for d in devs:
            choices.append({
                "id": f"index:{d['index']}",
                "label": d.get("name") or f"Input {d['index']}",
                "kind": "index",
                "detail": f"PortAudio input {d['index']} · {d['channels']} ch · {int(d.get('sr') or 0)} Hz",
            })
    except Exception as e:
        out["sounddevice_error"] = str(e)
    if _which("arecord"):
        rc, so, _ = _run(["arecord", "-l"], timeout=6)
        lines = so.decode("utf-8", "replace").strip().splitlines() if rc == 0 else []
        out["alsa"] = lines
        for line in lines:
            # "card 1: USB [Device USB Audio], device 0: USB Audio [USB Audio]"
            m = re.search(r"card (\d+):.*device (\d+):", line)
            alsa_id = f"hw:{m.group(1)},{m.group(2)}" if m else ""
            if not alsa_id:
                continue
            choices.append({
                "id": f"alsa:{alsa_id}",
                "label": line.strip(),
                "kind": "alsa",
                "detail": f"ALSA capture device {alsa_id}",
            })
    out["choices"] = choices
    return out


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def _main(argv: list[str]) -> int:
    import json as _json

    cmd = argv[1] if len(argv) > 1 else "probe"

    def opt(flag: str, default: str = "") -> str:
        return argv[argv.index(flag) + 1] if flag in argv else default

    if cmd == "probe-one":
        name = opt("--backend")
        sr = int(opt("--sr", str(cfg.SAMPLE_RATE)))
        device = opt("--device")
        try:
            print(_json.dumps(probe_one(name, sr, device)))
        except Exception as e:
            print(_json.dumps({"backend": name, "ok": False, "reason": f"{type(e).__name__}: {e}"}))
        return 0
    if cmd == "stream":
        name = opt("--backend")
        sr = int(opt("--sr", str(cfg.SAMPLE_RATE)))
        device = opt("--device")
        try:
            return _stream(name, sr, device)
        except BrokenPipeError:
            return 0
        except Exception as e:
            sys.stderr.write(f"{type(e).__name__}: {e}\n")
            return 3
    if cmd == "play-file":
        return _play_file_sounddevice(argv[2])
    if cmd == "probe":
        print(_json.dumps(probe_capture(save=False), indent=2))
        return 0
    if cmd == "devices":
        print(_json.dumps(list_input_devices(), indent=2))
        return 0
    if cmd == "backends":
        for n in capture_order():
            ok, why = backend_available(n)
            print(f"  {'ok ' if ok else '-- '} {n:<12} {why}")
        print("playback:", _playback_candidates())
        return 0
    if cmd == "pulse":
        ok, why = pulse_reachable()
        print(f"reachable={ok} detail={why} PULSE_SERVER={cfg.PULSE_SERVER!r}")
        print("sources:", pulse_sources())
        return 0 if ok else 1
    if cmd == "record":
        secs = float(argv[2]) if len(argv) > 2 else 3.0
        out = Path(argv[3]) if len(argv) > 3 else (cfg.CACHE_DIR / "test.wav")
        sr = cfg.SAMPLE_RATE
        cap = open_capture(sr)
        block = max(1, int(sr * cfg.BLOCK_MS / 1000)) * 2
        frames = bytearray()
        t0 = time.time()
        while time.time() - t0 < secs:
            frames.extend(cap.read(block, timeout=3))
        cap.close()
        write_wav(out, bytes(frames), sr)
        print(f"wrote {out} ({secs}s via {cap.name}, rms={rms(bytes(frames)):.5f})")
        return 0
    if cmd == "play":
        print(play_wav(argv[2]))
        return 0
    print("usage: jv_audio.py [probe|probe-one --backend N|stream --backend N|backends|devices|pulse|"
          "record <secs> [out.wav]|play <wav>|play-file <wav>]", flush=True)
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
