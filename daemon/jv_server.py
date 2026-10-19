#!/usr/bin/env python3
"""
Jarvis Voice daemon - local mic -> text and text -> local voice, over HTTP.

Runs on Parrot, Termux, plain Linux, macOS and Windows. The OpenCode plugin
talks to it on 127.0.0.1, so the plugin never needs a native audio stack.

Endpoints (JSON unless noted):
  GET  /health            capability report: audio, stt, tts, voice, pulse
  GET  /devices           input devices / pulse sources
  POST /ptt/start         begin push-to-talk capture        {max_ms?}
  POST /ptt/stop          end capture, transcribe, return   {}   -> {text,...}
  POST /ptt/cancel        discard the current capture
  GET  /ptt/state         current push-to-talk state
  POST /listen            blocking capture + transcribe     {max_ms?, silence_ms?, ...}
  POST /transcribe        raw 16-bit mono PCM or WAV body   -> {text}
  POST /speak             synthesize + play locally         {text, async?}
  POST /synth             synthesize only, returns audio/wav
  GET  /speech            what the speakers are doing now (playing/paused)
  POST /pause             suspend the current playback (SIGSTOP)
  POST /resume            continue a paused playback (SIGCONT)
  POST /interrupt         stop capture and playback
  POST /probe             re-run the audio backend probe
  POST /shutdown          stop the daemon

Auth: `Authorization: Bearer <token>` (token in ~/.cache/jarvis-voice/daemon.json).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import signal
import socket
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import jv_audio as audio  # noqa: E402
import jv_config as cfg  # noqa: E402
import jv_stt as stt  # noqa: E402
import jv_tts as tts  # noqa: E402
import jv_voices as voices  # noqa: E402

# ----------------------------------------------------------------------------
# Utterance capture with voice-activity detection
# ----------------------------------------------------------------------------

_rec_lock = threading.Lock()


class Utterance:
    def __init__(self, pcm: bytes, sr: int, stats: dict):
        self.pcm = pcm
        self.sr = sr
        self.stats = stats


def record_utterance(
    max_ms: int | None = None,
    silence_ms: int | None = None,
    start_timeout_ms: int | None = None,
    threshold: float | None = None,
    min_speech_ms: int | None = None,
    stop_event: threading.Event | None = None,
) -> Utterance:
    """
    Record until the speaker stops, a hard limit is hit, or stop_event is set.

    Never hangs: every read has a timeout and the loop has an absolute deadline.
    """
    max_ms = int(max_ms or cfg.VAD_MAX_MS)
    silence_ms = int(silence_ms if silence_ms is not None else cfg.VAD_SILENCE_MS)
    start_timeout_ms = int(start_timeout_ms if start_timeout_ms is not None else cfg.VAD_START_TIMEOUT_MS)
    threshold = float(threshold if threshold is not None else cfg.VAD_THRESHOLD)
    min_speech_ms = int(min_speech_ms if min_speech_ms is not None else cfg.VAD_MIN_SPEECH_MS)

    sr = cfg.SAMPLE_RATE
    block_samples = max(1, int(sr * cfg.BLOCK_MS / 1000))
    block_bytes = block_samples * 2

    silence_blocks_needed = max(1, int(silence_ms / cfg.BLOCK_MS))
    min_speech_blocks = max(1, int(min_speech_ms / cfg.BLOCK_MS))

    t0 = time.time()
    frames: list[bytes] = []
    speech_blocks = 0
    silent_run = 0
    peak = 0.0
    started = False
    peak_floor = 0.0
    reason = "max"

    with _rec_lock:
        cap = audio.open_capture(sr)
        try:
            # -- wait for speech to begin ------------------------------------
            wait_deadline = t0 + start_timeout_ms / 1000.0
            while time.time() < wait_deadline:
                if stop_event is not None and stop_event.is_set():
                    reason = "cancelled"
                    break
                block = cap.read(block_bytes, timeout=cfg.PROBE_TIMEOUT)
                lvl = audio.rms(block)
                peak = max(peak, lvl)
                peak_floor = max(peak_floor, lvl)
                if lvl >= threshold:
                    started = True
                    frames.append(block)
                    speech_blocks += 1
                    break
            if not started and reason == "max":
                reason = "silence"
            # -- capture the utterance ---------------------------------------
            deadline = t0 + max_ms / 1000.0
            while started and reason == "max":
                if stop_event is not None and stop_event.is_set():
                    reason = "stopped"
                    break
                if time.time() > deadline:
                    reason = "max"
                    break
                block = cap.read(block_bytes, timeout=cfg.PROBE_TIMEOUT)
                lvl = audio.rms(block)
                peak = max(peak, lvl)
                frames.append(block)
                if lvl >= threshold:
                    speech_blocks += 1
                    silent_run = 0
                else:
                    silent_run += 1
                    if silent_run >= silence_blocks_needed and speech_blocks >= min_speech_blocks:
                        reason = "silence_end"
                        break
        finally:
            try:
                cap.close()
            except Exception:
                pass

    pcm = b"".join(frames)
    stats = {
        "reason": reason,
        "ms": int((time.time() - t0) * 1000),
        "audio_ms": int(len(pcm) / 2 / sr * 1000),
        "rms": round(audio.rms(pcm), 5),
        "peak": round(peak, 5),
        "noise_floor": round(peak_floor, 5),
        "threshold": threshold,
        "sr": sr,
        "bytes": len(pcm),
    }
    return Utterance(pcm, sr, stats)


# ----------------------------------------------------------------------------
# Push-to-talk session
# ----------------------------------------------------------------------------

class PttSession:
    """One push-to-talk recording, owned by a background thread."""

    def __init__(self, max_ms: int | None = None):
        self.id = f"ptt-{int(time.time() * 1000)}"
        self.started_at = time.time()
        self.stop_event = threading.Event()
        self.state = "listening"      # listening -> transcribing -> done | error | cancelled
        self.result: dict | None = None
        self.error: str | None = None
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(max_ms,), daemon=True)
        self._thread.start()

    def _run(self, max_ms: int | None) -> None:
        try:
            utt = record_utterance(max_ms=max_ms, stop_event=self.stop_event)
            if utt.stats.get("reason") == "cancelled":
                self.state = "cancelled"
                self._done.set()
                return
            if utt.stats["audio_ms"] < 120:
                self.state = "done"
                self.result = {"text": "", "stats": utt.stats, "empty": True,
                               "reason": utt.stats.get("reason")}
                self._done.set()
                return
            self.state = "transcribing"
            res = stt.transcribe(utt.pcm, utt.sr)
            res["stats"] = utt.stats
            res["empty"] = not res.get("text")
            self.result = res
            self.state = "done"
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
            self.state = "error"
        finally:
            self._done.set()

    def stop_and_wait(self, timeout: float = 120.0) -> dict:
        self.stop_event.set()
        if not self._done.wait(timeout=timeout):
            raise audio.AudioError("push-to-talk did not finish in time")
        if self.state == "error":
            raise audio.AudioError(self.error or "push-to-talk failed")
        return {"id": self.id, "state": self.state, "result": self.result}

    def cancel(self) -> None:
        self.stop_event.set()
        self._done.wait(timeout=10)

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "elapsed_ms": int((time.time() - self.started_at) * 1000),
            "result": self.result,
            "error": self.error,
        }


_state = {
    "ptt": None,          # type: PttSession | None
    "last_text": "",
    "last_error": None,
    "requests": 0,
    "boot": time.time(),
    # What the speakers last said, so /speech can describe it while it plays.
    "speech": {"text": "", "backend": None, "started_at": 0.0},
}


def speech_status() -> dict:
    """Playback status for the TUI play/pause button."""
    st = audio.playback_status()
    last = _state["speech"]
    return {
        "ok": True,
        "active": st["playing"],
        "paused": st["paused"],
        "text": last.get("text") or "",
        "backend": last.get("backend"),
        "started_at": last.get("started_at") or None,
        "elapsed_ms": st["elapsed_ms"],
    }


# ----------------------------------------------------------------------------
# Capability report
# ----------------------------------------------------------------------------

def health(deep: bool = False) -> dict:
    cap = None
    if deep:
        cap = audio.probe_capture()
    else:
        try:
            cap = json.loads(cfg.BACKEND_FILE.read_text())
        except Exception:
            cap = None
    pulse_ok, pulse_why = audio.pulse_reachable()
    v = voices.resolve(verbose=False)
    return {
        "ok": True,
        "daemon": cfg.describe(),
        "audio": {
            "capture": cap,
            "pulse": {"reachable": pulse_ok, "detail": pulse_why, "server": cfg.PULSE_SERVER},
            "playback_available": bool(audio._playback_candidates()),
            "input_device": cfg.INPUT_DEVICE,
            "sample_rate": cfg.SAMPLE_RATE,
            "vad": {
                "threshold": cfg.VAD_THRESHOLD,
                "silence_ms": cfg.VAD_SILENCE_MS,
                "max_ms": cfg.VAD_MAX_MS,
            },
        },
        "stt": {"picked": stt.pick_backend(), "backends": stt.available_backends()},
        "tts": {"picked": tts.pick_backend(), "backends": tts.available_backends(), "voice": v.to_dict() if v else None},
        "ptt": _state["ptt"].snapshot() if _state["ptt"] else None,
        "speech": speech_status(),
        "last_text": _state["last_text"],
        "last_error": _state["last_error"],
        "uptime_s": int(time.time() - _state["boot"]),
    }


# ----------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = f"JarvisVoice/{cfg.DAEMON_VERSION}"
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------
    def log_message(self, fmt: str, *args) -> None:  # keep stdout clean
        if os.environ.get("JARVIS_VOICE_VERBOSE"):
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def handle_one_request(self) -> None:
        # Clients that disappear mid-request (a TUI closing, a killed curl) are
        # normal here; do not print a traceback for them.
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    def _authorized(self, query: dict) -> bool:
        if not cfg.AUTH_REQUIRED:
            return True
        hdr = self.headers.get("Authorization", "")
        if hdr.startswith("Bearer ") and hdr[7:].strip() == cfg.TOKEN:
            return True
        if query.get("token", [""])[0] == cfg.TOKEN:
            return True
        return False

    def _send(self, code: int, payload: dict | bytes, ctype: str = "application/json") -> None:
        if isinstance(payload, dict):
            body = json.dumps(payload, default=str).encode()
        else:
            body = payload
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json_body(self) -> dict:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            d = json.loads(raw.decode("utf-8", "replace"))
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}

    # -- routes ------------------------------------------------------------
    def do_GET(self) -> None:
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not self._authorized(q):
            return self._send(401, {"error": "unauthorized"})
        path = u.path.rstrip("/") or "/"
        try:
            if path in ("/health", "/"):
                return self._send(200, health(deep=(q.get("deep", ["0"])[0] in ("1", "true", "yes"))))
            if path == "/devices":
                return self._send(200, {"ok": True, "devices": audio.list_input_devices()})
            if path == "/ptt/state":
                return self._send(200, {"ok": True, "ptt": _state["ptt"].snapshot() if _state["ptt"] else None})
            if path == "/speech":
                return self._send(200, speech_status())
            if path == "/voices":
                return self._send(200, {"ok": True, "voices": [v.to_dict() for v in voices.discover()],
                                        "selected": (voices.resolve().to_dict() if voices.resolve() else None)})
            if path == "/ping":
                return self._send(200, {"ok": True, "t": time.time()})
            return self._send(404, {"error": f"no route {path}"})
        except Exception as e:
            _state["last_error"] = f"{type(e).__name__}: {e}"
            return self._send(500, {"error": _state["last_error"]})

    def do_POST(self) -> None:
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not self._authorized(q):
            return self._send(401, {"error": "unauthorized"})
        path = u.path.rstrip("/") or "/"
        _state["requests"] += 1
        try:
            if path == "/ptt/start":
                body = self._json_body()
                if _state["ptt"] and _state["ptt"].state in ("listening", "transcribing"):
                    _state["ptt"].cancel()
                _state["ptt"] = PttSession(max_ms=body.get("max_ms") or body.get("maxMs"))
                return self._send(200, {"ok": True, "ptt": _state["ptt"].snapshot()})

            if path == "/ptt/stop":
                sess = _state["ptt"]
                if not sess:
                    return self._send(409, {"error": "no push-to-talk session running"})
                out = sess.stop_and_wait()
                if out.get("result") and out["result"].get("text"):
                    _state["last_text"] = out["result"]["text"]
                return self._send(200, {"ok": True, **out})

            if path == "/ptt/cancel":
                sess = _state["ptt"]
                if sess:
                    sess.cancel()
                return self._send(200, {"ok": True, "cancelled": bool(sess)})

            if path == "/listen":
                body = self._json_body()
                utt = record_utterance(
                    max_ms=body.get("max_ms"),
                    silence_ms=body.get("silence_ms"),
                    start_timeout_ms=body.get("start_timeout_ms"),
                    threshold=body.get("threshold"),
                    min_speech_ms=body.get("min_speech_ms"),
                )
                if utt.stats["audio_ms"] < 120 or not utt.pcm:
                    return self._send(200, {"ok": True, "text": "", "empty": True, "stats": utt.stats})
                res = stt.transcribe(utt.pcm, utt.sr)
                res["stats"] = utt.stats
                res["empty"] = not res.get("text")
                if res["text"]:
                    _state["last_text"] = res["text"]
                return self._send(200, {"ok": True, **res})

            if path == "/transcribe":
                raw = self._read_body()
                sr = int(q.get("sr", [cfg.SAMPLE_RATE])[0])
                pcm = raw
                if raw[:4] == b"RIFF":
                    pcm, sr, _ = audio.read_wav(io.BytesIO(raw))
                if not pcm:
                    return self._send(400, {"error": "empty audio"})
                res = stt.transcribe(pcm, sr)
                return self._send(200, {"ok": True, **res})

            if path == "/speak":
                body = self._json_body()
                text = (body.get("text") or "").strip()
                if not text:
                    return self._send(400, {"error": "text required"})
                out = tts.speak(text, backend=body.get("backend"), wait=not bool(body.get("async")))
                _state["speech"] = {"text": text, "backend": out.get("backend"), "started_at": time.time()}
                return self._send(200, {"ok": True, **out})

            if path == "/pause":
                paused = audio.pause_playback()
                return self._send(200, {"ok": True, "paused": paused, "speech": speech_status()})

            if path == "/resume":
                resumed = audio.resume_playback()
                return self._send(200, {"ok": True, "resumed": resumed, "speech": speech_status()})

            if path == "/synth":
                body = self._json_body()
                text = (body.get("text") or "").strip()
                if not text:
                    return self._send(400, {"error": "text required"})
                info = tts.synthesize(text, backend=body.get("backend"))
                data = Path(info["path"]).read_bytes()
                return self._send(200, data, ctype="audio/wav")

            if path == "/interrupt":
                sess = _state["ptt"]
                if sess:
                    sess.cancel()
                audio.stop_playback()
                _state["speech"] = {"text": "", "backend": None, "started_at": 0.0}
                return self._send(200, {"ok": True})

            if path == "/probe":
                cap = audio.probe_capture()
                return self._send(200, {"ok": True, "capture": cap})

            if path == "/shutdown":
                self._send(200, {"ok": True, "stopping": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return

            return self._send(404, {"error": f"no route {path}"})
        except audio.AudioError as e:
            _state["last_error"] = str(e)
            hints = audio.capture_hints(*audio.pulse_reachable())
            return self._send(503, {"error": str(e), "hints": hints})
        except stt.SttError as e:
            _state["last_error"] = str(e)
            return self._send(503, {"error": str(e)})
        except tts.TtsError as e:
            _state["last_error"] = str(e)
            return self._send(503, {"error": str(e)})
        except Exception as e:
            _state["last_error"] = f"{type(e).__name__}: {e}"
            return self._send(500, {"error": _state["last_error"]})


# ----------------------------------------------------------------------------
# Bootstrap
# ----------------------------------------------------------------------------

def _pick_port(preferred: int) -> int:
    for port in [preferred, preferred + 1, preferred + 2, 0]:
        if port == 0 or cfg.port_is_free(port):
            return port
    return 0


def serve(host: str, port: int, probe: bool = True) -> int:
    port = _pick_port(port)
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    # Port 0 means "let the OS choose"; always report the port we actually got,
    # otherwise the runtime file would advertise an unusable address.
    bound_port = int(httpd.server_port)
    cfg.write_runtime(os.getpid(), bound_port)

    print(f"[jarvis-voice] daemon {cfg.DAEMON_VERSION} on http://{host}:{bound_port}  ({cfg.PLATFORM_TAG})", flush=True)
    print(f"[jarvis-voice] token: {cfg.TOKEN}", flush=True)
    print(f"[jarvis-voice] runtime file: {cfg.RUNTIME_FILE}", flush=True)

    if probe:
        def _warm():
            try:
                cap = audio.probe_capture()
                print(f"[jarvis-voice] capture: {cap.get('backend') or 'NONE'} "
                      f"{'' if cap.get('backend') else '- ' + str(cap.get('reason'))}", flush=True)
                if not cap.get("backend"):
                    for h in cap.get("hints", []):
                        print(f"[jarvis-voice] hint: {h}", flush=True)
            except Exception as e:
                print(f"[jarvis-voice] capture probe failed: {e}", flush=True)
            try:
                st = stt.warmup()
                print(f"[jarvis-voice] stt: {st}", flush=True)
            except Exception as e:
                print(f"[jarvis-voice] stt warmup failed: {e}", flush=True)
            try:
                tv = tts.pick_backend()
                print(f"[jarvis-voice] tts: {tv} "
                      f"{'(voice: ' + voices.resolve().name + ')' if voices.resolve() else '(no piper voice - run: voice fetch en_GB-alan-medium)'}",
                      flush=True)
            except Exception as e:
                print(f"[jarvis-voice] tts check failed: {e}", flush=True)

        threading.Thread(target=_warm, daemon=True).start()

    def _bye(*_a):
        cfg.clear_runtime()
        try:
            httpd.shutdown()
        except Exception:
            pass

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _bye)
        except Exception:
            pass

    try:
        httpd.serve_forever(poll_interval=0.3)
    finally:
        cfg.clear_runtime()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Jarvis Voice daemon (local mic <-> text <-> local voice)")
    ap.add_argument("--host", default=cfg.HOST)
    ap.add_argument("--port", type=int, default=cfg.PORT)
    ap.add_argument("--no-probe", action="store_true", help="skip the startup audio probe")
    ap.add_argument("--health", action="store_true", help="print the capability report and exit")
    ap.add_argument("--deep", action="store_true", help="with --health: also probe the mic")
    ap.add_argument("--say", metavar="TEXT", help="speak TEXT through the local voice and exit")
    args = ap.parse_args(argv)

    if args.say:
        print(json.dumps(tts.speak(args.say), indent=2, default=str))
        return 0
    if args.health:
        print(json.dumps(health(deep=args.deep), indent=2, default=str))
        return 0
    return serve(args.host, args.port, probe=not args.no_probe)


if __name__ == "__main__":
    raise SystemExit(main())
