#!/usr/bin/env python3
"""
Jarvis Voice daemon - local mic -> text and text -> local voice, over HTTP.

Runs on Parrot, Termux, plain Linux, macOS and Windows. The OpenCode plugin
talks to it on 127.0.0.1, so the plugin never needs a native audio stack.

Endpoints (JSON unless noted):
  GET  /health            capability report: audio, stt, tts, voice, pulse
  GET  /devices           input devices / pulse sources
  POST /ptt/start         begin capture                     {max_ms?, silence_ms?, partial?, keep_warm?, stt?, mic?}
  POST /ptt/stop          end capture, transcribe, return   {}   -> {text,...}
  POST /ptt/cancel        discard the current capture
  GET  /ptt/state         current capture state (partial caption, level)
  POST /listen            blocking capture + transcribe     {max_ms?, silence_ms?, stt?, ...}
  POST /transcribe        raw 16-bit mono PCM or WAV body   -> {text}
  POST /speak             synthesize + play locally         {text, async?, backend?, fish?, append?}
  POST /synth             synthesize only, returns audio/wav or audio/mpeg
  POST /warmup            load the local STT model now      {stt?}
  GET  /speech            what the speakers are doing now (playing/paused)
  POST /pause             suspend the current playback (SIGSTOP)
  POST /resume            continue a paused playback (SIGCONT)
  POST /interrupt         stop capture and playback
  POST /probe             re-run the audio backend probe
  POST /shutdown          stop the daemon

Auth: `Authorization: Bearer <token>` (token in ~/.cache/jarvis-voice/daemon.json).

On-demand by design (battery): nothing heavy happens at startup. In the default
`lazy` warmup mode the STT model loads in the background when push-to-talk
starts (while the user is speaking anyway), and the daemon exits after
JARVIS_VOICE_IDLE_EXIT_S seconds without real activity - status polls from the
UI do not count, playing speech does. The plugin starts it again on demand.
"""

from __future__ import annotations

import argparse
import collections
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
from typing import Callable
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
    device: str | None = None,
    preroll_ms: int | None = None,
    on_level: "Callable[[float, bool], None] | None" = None,
    on_audio: "Callable[[bytes], None] | None" = None,
    gate: "audio.VoiceGate | None" = None,
) -> Utterance:
    """
    Record until the speaker stops, a hard limit is hit, or stop_event is set.

    Never hangs: every read has a timeout and the loop has an absolute deadline.

    `on_level(level, speech)` is called for every block (the live meter) and
    `on_audio(block)` for every block that belongs to the utterance, including
    the pre-roll, so a caller can transcribe the turn while it is still being
    spoken. Both are optional and must return quickly.
    """
    max_ms = int(max_ms or cfg.VAD_MAX_MS)
    silence_ms = int(silence_ms if silence_ms is not None else cfg.VAD_SILENCE_MS)
    start_timeout_ms = int(start_timeout_ms if start_timeout_ms is not None else cfg.VAD_START_TIMEOUT_MS)
    threshold = float(threshold if threshold is not None else cfg.VAD_THRESHOLD)
    min_speech_ms = int(min_speech_ms if min_speech_ms is not None else cfg.VAD_MIN_SPEECH_MS)

    sr = cfg.SAMPLE_RATE
    block_samples = max(1, int(sr * cfg.BLOCK_MS / 1000))
    block_bytes = block_samples * 2

    gate = gate or audio.VoiceGate(
        threshold=threshold,
        block_ms=cfg.BLOCK_MS,
        silence_ms=silence_ms,
        min_speech_ms=min_speech_ms,
        noise_mult=cfg.VAD_NOISE_MULT,
        preroll_ms=(cfg.VAD_PREROLL_MS if preroll_ms is None else preroll_ms),
    )

    t_start = time.time()
    frames: list[bytes] = []
    preroll: "collections.deque[bytes]" = collections.deque(maxlen=max(0, gate.preroll_blocks))
    peak = 0.0
    started = False
    speech_at = 0.0
    reason = "max"

    def emit(block: bytes) -> None:
        if on_audio is not None:
            try:
                on_audio(block)
            except Exception:
                pass

    with _rec_lock:
        # Load the phone mic before starting the recording clock. Otherwise the
        # module-load time (often ~1 s) eats into max_ms and truncates short
        # push-to-talk turns.
        if cfg.IS_ANDROID:
            audio.prepare_sles()
        cap = audio.take_capture(sr, device)
        t0 = time.time()
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
                state = gate.push(lvl)
                if on_level is not None:
                    try:
                        on_level(lvl, state in ("start", "speech"))
                    except Exception:
                        pass
                if state == "start":
                    started = True
                    speech_at = time.time()
                    # Keep the blocks from just before the onset: the first
                    # phoneme of a word is usually the quietest part of it.
                    for held in preroll:
                        frames.append(held)
                        emit(held)
                    preroll.clear()
                    frames.append(block)
                    emit(block)
                    break
                preroll.append(block)
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
                state = gate.push(lvl)
                if on_level is not None:
                    try:
                        on_level(lvl, state != "end")
                    except Exception:
                        pass
                frames.append(block)
                emit(block)
                if state == "end":
                    reason = "silence_end"
                    break
        finally:
            try:
                cap.close()
            except Exception:
                pass

    raw = b"".join(frames)
    pcm = raw
    if raw:
        # The hangover and the room noise are not speech: trimming them makes
        # the final transcription faster without touching the words.
        pcm = audio.trim_silence(raw, threshold=max(0.003, gate.base * 0.5), sr=sr)
        if len(pcm) < 320:
            pcm = raw
    stats = {
        "reason": reason,
        "ms": int((time.time() - t_start) * 1000),
        "open_ms": int((t0 - t_start) * 1000),
        "record_ms": int((time.time() - t0) * 1000),
        "speech_at_ms": int((speech_at - t0) * 1000) if speech_at else None,
        "capture": str(getattr(cap, "name", "") or ""),
        "device": str(device or ""),
        "audio_ms": int(len(pcm) / 2 / sr * 1000),
        "raw_ms": int(len(raw) / 2 / sr * 1000),
        "rms": round(audio.rms(pcm), 5),
        "peak": round(peak, 5),
        "noise_floor": round(gate.noise_floor, 5),
        "threshold": round(gate.threshold, 5),
        "gate_threshold": round(gate.base, 5),
        "speech_ms": gate.speech_ms,
        "sr": sr,
        "bytes": len(pcm),
    }
    return Utterance(pcm, sr, stats)


# ----------------------------------------------------------------------------
# Push-to-talk session
# ----------------------------------------------------------------------------

def _mic_device(body: dict) -> str:
    """The microphone the client asked for, if any.

    `{"mic": {"device": "pulse:jarvis_mic"}}` picks that input; an empty
    value keeps the daemon's automatic choice.
    """
    mic = body.get("mic")
    if not isinstance(mic, dict):
        return ""
    return str(mic.get("device") or "").strip()


class PttSession:
    """One push-to-talk recording, owned by a background thread.

    In live mode the session also transcribes the words *while* they are
    being spoken (`partial`) and exposes the input level, so the caller can
    show a caption as it grows instead of waiting for the whole utterance.
    """

    def __init__(self, max_ms: int | None = None, stt_options: dict | None = None,
                 device: str | None = None, silence_ms: int | None = None,
                 start_timeout_ms: int | None = None, preroll_ms: int | None = None,
                 partial: bool = False, keep_warm: bool = False):
        self.id = f"ptt-{int(time.time() * 1000)}"
        self.started_at = time.time()
        self.stt_options = stt_options if isinstance(stt_options, dict) else None
        self.device = (device or "").strip()
        self.silence_ms = int(silence_ms) if silence_ms is not None else None
        self.start_timeout_ms = int(start_timeout_ms) if start_timeout_ms is not None else None
        self.preroll_ms = int(preroll_ms) if preroll_ms is not None else None
        self.partial_enabled = bool(partial)
        self.keep_warm = bool(keep_warm)
        self.stop_event = threading.Event()
        self.state = "listening"      # listening -> transcribing -> done | error | cancelled
        self.result: dict | None = None
        self.error: str | None = None
        # Live caption + meter, read by /ptt/state while the user speaks.
        self.partial = ""
        self.level = 0.0
        self.speaking = False
        # Caption diagnostics, and the language the captions heard: the final
        # decode reuses it instead of paying for detection again.
        self.partial_ms = 0
        self.caption_model = ""
        self.caption_language = ""
        self.caption_probability = 0.0
        self._cancelled = False
        self._done = threading.Event()
        self._pcm = bytearray()
        self._pcm_lock = threading.Lock()
        self._partial_stop = threading.Event()
        self._partial_thread: threading.Thread | None = None
        if self.partial_enabled:
            self._partial_thread = threading.Thread(target=self._partial_loop, daemon=True,
                                                   name=f"{self.id}-partial")
            self._partial_thread.start()
            # Load tiny now, while the user is still speaking: the first
            # caption should not pay for a model load.
            threading.Thread(target=stt.warm_caption, args=(self.stt_options,),
                             daemon=True, name=f"{self.id}-caption-warm").start()
        self._thread = threading.Thread(target=self._run, args=(max_ms,), daemon=True)
        self._thread.start()

    # -- live caption ------------------------------------------------------
    def _on_level(self, level: float, speech: bool) -> None:
        self.level = round(float(level), 5)
        self.speaking = bool(speech)

    def _on_audio(self, block: bytes) -> None:
        with self._pcm_lock:
            self._pcm.extend(block)

    def _partial_loop(self) -> None:
        """Transcribe the utterance so far, over and over, while it grows.

        The caption is a preview, so it uses the tiny model and is replaced by
        the final transcript. Each pass waits for the previous one to finish
        (plus a short breather), so a slow phone never builds a queue of
        caption decodes in front of the final one - that queue used to turn a
        10 s question into a 30 s wait.
        """
        base = max(0.3, float(cfg.LIVE_PARTIAL_S))
        last_audio = 0
        while not self._partial_stop.wait(base):
            if self.state != "listening":
                return
            with self._pcm_lock:
                pcm = bytes(self._pcm)
            # Do not pay for a caption on a cough, and do not re-decode the
            # same words when nothing new was said.
            if len(pcm) < int(cfg.SAMPLE_RATE * 2 * 0.45) or len(pcm) <= last_audio:
                base = 0.25
                continue
            # Only the recent words matter for a caption, and a shorter window
            # is both faster and more accurate for the tail of a monologue.
            limit = int(cfg.SAMPLE_RATE * 2 * cfg.LIVE_PARTIAL_WINDOW_S)
            if len(pcm) > limit:
                pcm = pcm[-limit:]
            opts = self._options_with_language()
            t0 = time.time()
            try:
                res = stt.transcribe_caption(pcm, cfg.SAMPLE_RATE, options=opts)
            except Exception:
                base = 0.5
                continue
            took = time.time() - t0
            if res.get("skipped"):
                # The final decode owns the model; come back soon.
                base = 0.2
                continue
            self.partial_ms = int(took * 1000)
            model = str(res.get("caption_model") or "")
            if model:
                self.caption_model = model
            lang = str(res.get("language") or "")
            prob = float(res.get("probability") or 0.0)
            if lang and prob >= float(cfg.WHISPER_DETECT_MIN_PROB) and not self.caption_language:
                self.caption_language = lang
                self.caption_probability = prob
            text = (res.get("text") or "").strip()
            if text and self.state == "listening":
                self.partial = text
            last_audio = len(pcm)
            # Leave room between passes: a caption that took 1 s should not be
            # followed by another one immediately on a busy phone.
            base = max(0.3, min(1.2, took * 0.5 + 0.15))

    def _options_with_language(self) -> dict | None:
        """The turn options, with the language the captions already heard.

        Only fills an empty language: an explicit setting from the user always
        wins, and English-only models ignore it.
        """
        opts = self.stt_options
        local = dict((opts or {}).get("local") or {})
        if self.caption_language and not str(local.get("language") or "").strip() \
                and not (cfg.WHISPER_LANGUAGE or "").strip():
            local["language"] = self.caption_language
        if not local:
            return opts
        merged = dict(opts or {})
        merged["local"] = local
        return merged

    def _run(self, max_ms: int | None) -> None:
        try:
            utt = record_utterance(
                max_ms=max_ms,
                silence_ms=self.silence_ms,
                start_timeout_ms=self.start_timeout_ms,
                preroll_ms=self.preroll_ms,
                stop_event=self.stop_event,
                device=self.device,
                on_level=self._on_level if self.partial_enabled else None,
                on_audio=self._on_audio if self.partial_enabled else None,
            )
            self._partial_stop.set()
            if self._cancelled or utt.stats.get("reason") == "cancelled":
                self.state = "cancelled"
                return
            if utt.stats["audio_ms"] < 120:
                self.state = "done"
                self.result = {"text": "", "stats": utt.stats, "empty": True,
                               "reason": utt.stats.get("reason")}
                return
            self.state = "transcribing"
            res = stt.transcribe(utt.pcm, utt.sr, options=self._options_with_language())
            res["stats"] = utt.stats
            res["empty"] = not res.get("text")
            self.result = res
            if self._cancelled:
                # The turn was cancelled while it was transcribing, but the
                # words are already here. Keep them: the client that is
                # waiting for this turn must not end up with nothing.
                self.state = "done"
                return
            self.state = "done"
        except Exception as e:
            if self._cancelled:
                self.state = "cancelled"
                return
            self.error = f"{type(e).__name__}: {e}"
            self.state = "error"
        finally:
            self._partial_stop.set()
            self._done.set()
            # Live mode: keep the microphone stream open for the next turn,
            # so the next sentence starts without a device-open pause.
            if self.keep_warm and not self._cancelled:
                try:
                    audio.warm_capture(cfg.SAMPLE_RATE, self.device)
                except Exception:
                    pass

    def stop_and_wait(self, timeout: float = 180.0) -> dict:
        self.stop_event.set()
        if not self._done.wait(timeout=timeout):
            raise audio.AudioError("push-to-talk did not finish in time")
        if self.state == "error":
            raise audio.AudioError(self.error or "push-to-talk failed")
        return {"id": self.id, "state": self.state, "result": self.result}

    def cancel(self) -> None:
        self._cancelled = True
        self.stop_event.set()
        self._done.wait(timeout=10)

    def snapshot(self) -> dict:
        payload = {
            "id": self.id,
            "state": self.state,
            "elapsed_ms": int((time.time() - self.started_at) * 1000),
            "result": self.result,
            "error": self.error,
            "level": self.level,
            "speaking": self.speaking,
            "device": self.device,
            "partial_ms": self.partial_ms,
            "caption_model": self.caption_model,
        }
        if self.partial_enabled:
            payload["partial"] = self.partial
        return payload


_state = {
    "ptt": None,          # type: PttSession | None
    "last_text": "",
    "last_error": None,
    "requests": 0,
    "boot": time.time(),
    # Battery: when something real last happened. Idle status polls do not
    # refresh it, so the daemon can exit even while the UI keeps looking.
    "last_activity": time.time(),
    "warm": False,        # lazy STT warmup already kicked off (once per life)
    # What the speakers last said, so /speech can describe it while it plays.
    "speech": {"text": "", "backend": None, "started_at": 0.0},
}

# Read-only routes the UI polls (read/pause button heartbeat). They must never
# keep an otherwise idle daemon alive.
_LIGHT_PATHS = {"/", "/health", "/ping", "/ptt/state", "/speech"}


def _touch(path: str) -> None:
    """Record real activity; polling endpoints are deliberately excluded."""
    if path not in _LIGHT_PATHS:
        _state["last_activity"] = time.time()


def _maybe_warm_stt(options: dict | None = None) -> None:
    """lazy mode: load the STT model while the user is already speaking.

    Push-to-talk means a transcription is coming anyway, so the CPU work
    overlaps with the recording and the daemon never preloads while idle.
    Fish ASR is cloud-hosted, so selecting it must not load Whisper.
    """
    if stt.resolve_backend(options) == "fish":
        # Do not flip the global warm flag: if the user switches back to
        # local Whisper in this daemon's lifetime, it should still warm lazily.
        return
    if cfg.WARMUP_MODE != "lazy" or _state["warm"]:
        return
    _state["warm"] = True

    def run() -> None:
        try:
            st = stt.warmup(options)
            print(f"[jarvis-voice] stt warm (lazy): {st}", flush=True)
        except Exception as e:
            print(f"[jarvis-voice] stt warmup failed: {e}", flush=True)

    threading.Thread(target=run, daemon=True).start()


def speech_status() -> dict:
    """Playback status for the TUI play/pause button."""
    st = audio.playback_status()
    last = _state["speech"]
    # A cloud reply is rendered before it plays, and a chunked reply has a
    # short gap between the chunks. The speaker is busy in both cases.
    active = bool(st["playing"] or tts.speaking())
    return {
        "ok": True,
        "active": active,
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
        # BaseHTTPRequestHandler reuses this instance for every request on a
        # keep-alive connection, so the cached body must start empty each time.
        self._raw_body: bytes | None = None
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
        cached = getattr(self, "_raw_body", None)
        if cached is not None:
            return cached
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        self._raw_body = raw
        return raw

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
        self._read_body()
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not self._authorized(q):
            return self._send(401, {"error": "unauthorized"})
        path = u.path.rstrip("/") or "/"
        _touch(path)
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
        # Always drain the body, including for routes that take no arguments
        # (pause/resume/interrupt). Unread bytes stay on the keep-alive socket
        # and corrupt the next request into "501 Unsupported method".
        self._read_body()
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not self._authorized(q):
            return self._send(401, {"error": "unauthorized"})
        path = u.path.rstrip("/") or "/"
        _state["requests"] += 1
        _touch(path)
        try:
            if path == "/ptt/start":
                body = self._json_body()
                stt_options = body.get("stt") if isinstance(body.get("stt"), dict) else None
                device = _mic_device(body)
                # Refuse a misconfigured cloud provider before opening the mic.
                stt.validate_options(stt_options)
                if _state["ptt"] and _state["ptt"].state == "listening":
                    # Only a recording is dropped. A turn that is already
                    # transcribing keeps its transcript: the client waiting
                    # for it would otherwise get an empty answer.
                    _state["ptt"].cancel()
                # Block until the phone mic is ready. The UI only flips to
                # "Listening..." after this response, so the stream is already
                # buffering by the time the user starts speaking. prepare_sles
                # keeps the module parent-owned between turns, so later PTT
                # presses do not pay the module-load cost again.
                # Start each PTT turn with a fresh buffered stream. A live
                # conversation keeps the device open instead: the microphone
                # is already listening when the answer ends, so the next
                # turn starts without a device-open pause.
                keep_warm = bool(body.get("keep_warm"))
                if not keep_warm:
                    audio.drop_warm_capture()
                if cfg.IS_ANDROID:
                    audio.prepare_sles()
                cap = audio.warm_capture(cfg.SAMPLE_RATE, device)
                if keep_warm:
                    # Audio captured while the answer was playing belongs to
                    # the speaker, not to the user: do not transcribe it.
                    try:
                        cap.drain()
                    except Exception:
                        pass
                _state["ptt"] = PttSession(
                    max_ms=body.get("max_ms") or body.get("maxMs"),
                    stt_options=stt_options,
                    device=device,
                    silence_ms=body.get("silence_ms"),
                    start_timeout_ms=body.get("start_timeout_ms"),
                    preroll_ms=body.get("preroll_ms"),
                    partial=bool(body.get("partial")),
                    keep_warm=keep_warm,
                )
                _maybe_warm_stt(stt_options)
                return self._send(200, {"ok": True, "ptt": _state["ptt"].snapshot()})

            if path == "/ptt/stop":
                sess = _state["ptt"]
                if not sess:
                    return self._send(409, {"error": "no push-to-talk session running"})
                out = sess.stop_and_wait()
                result = out.get("result") or {}
                if result.get("text"):
                    _state["last_text"] = result["text"]
                # One line per turn: what the daemon heard, without the text.
                st = result.get("stats") or {}
                print(
                    f"[jarvis-voice] ptt turn: {len(result.get('text') or '')} chars, "
                    f"backend={result.get('backend')} model={result.get('model_name')} "
                    f"fallback={result.get('fallback')} rms={st.get('rms')} "
                    f"audio_ms={st.get('audio_ms')} reason={st.get('reason')} "
                    f"mic={st.get('device') or 'auto'} via={st.get('capture') or '?'} "
                    f"stt_ms={result.get('ms')}",
                    flush=True,
                )
                # The transcript also goes to the top level: the plugin reads
                # `text` directly, and older clients keep using `result`.
                payload = {"ok": True, **out}
                if result:
                    payload["text"] = result.get("text", "")
                    for key in ("backend", "model", "model_name", "language", "ms",
                                "empty", "duration_s", "stats", "reason", "fallback"):
                        if key in result:
                            payload[key] = result[key]
                return self._send(200, payload)

            if path == "/ptt/cancel":
                sess = _state["ptt"]
                if sess:
                    sess.cancel()
                # The live conversation is over (or the turn was dropped):
                # nothing needs the microphone stream kept open any more.
                audio.drop_warm_capture()
                return self._send(200, {"ok": True, "cancelled": bool(sess)})

            if path == "/listen":
                body = self._json_body()
                stt_options = body.get("stt") if isinstance(body.get("stt"), dict) else None
                stt.validate_options(stt_options)
                utt = record_utterance(
                    max_ms=body.get("max_ms"),
                    silence_ms=body.get("silence_ms"),
                    start_timeout_ms=body.get("start_timeout_ms"),
                    threshold=body.get("threshold"),
                    min_speech_ms=body.get("min_speech_ms"),
                    device=_mic_device(body),
                )
                if utt.stats["audio_ms"] < 120 or not utt.pcm:
                    return self._send(200, {"ok": True, "text": "", "empty": True, "stats": utt.stats})
                res = stt.transcribe(utt.pcm, utt.sr, options=stt_options)
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
                fish = body.get("fish") if isinstance(body.get("fish"), dict) else None
                # `append` queues the sentence behind what is being read, so
                # a reply that streams in is spoken in order instead of each
                # sentence cutting off the one before it.
                out = tts.speak(text, backend=body.get("backend"),
                                wait=not bool(body.get("async")), fish=fish,
                                append=bool(body.get("append")))
                _state["speech"] = {"text": text, "backend": out.get("backend"), "started_at": time.time()}
                return self._send(200, {"ok": True, **out})

            if path == "/warmup":
                body = self._json_body()
                stt_options = body.get("stt") if isinstance(body.get("stt"), dict) else None
                out = stt.warmup(stt_options)
                if not out.get("ok"):
                    return self._send(503, {"error": out.get("reason") or "warmup failed", **out})
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
                fish = body.get("fish") if isinstance(body.get("fish"), dict) else None
                info = tts.synthesize(text, backend=body.get("backend"), fish=fish)
                data = Path(info["path"]).read_bytes()
                ctype = "audio/mpeg" if str(info.get("path", "")).endswith(".mp3") else "audio/wav"
                return self._send(200, data, ctype=ctype)

            if path == "/interrupt":
                sess = _state["ptt"]
                if sess:
                    sess.cancel()
                tts.stop_speaking()
                audio.stop_playback()
                audio.drop_warm_capture()
                _state["speech"] = {"text": "", "backend": None, "started_at": 0.0}
                return self._send(200, {"ok": True})

            if path == "/probe":
                body = self._json_body()
                cap = audio.probe_capture(device=_mic_device(body))
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
    if cfg.WARMUP_MODE != "boot" or cfg.IDLE_EXIT_S > 0:
        print(f"[jarvis-voice] on-demand: warmup={cfg.WARMUP_MODE}, "
              f"idle-exit={cfg.IDLE_EXIT_S or 'off'}s", flush=True)

    # Only "boot" mode pays for warming at startup. "lazy" (default) waits for
    # push-to-talk, "off" lets the first transcription load the model.
    if probe and cfg.WARMUP_MODE == "boot":
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

    # On-demand exit: after a quiet stretch with nothing real happening, the
    # daemon stops playback (if paused) and leaves. The plugin starts it again
    # on the next voice action, so idle CPU is exactly zero and the models'
    # RAM goes back to the system.
    if cfg.IDLE_EXIT_S > 0:
        def _idle_watchdog():
            idle = cfg.IDLE_EXIT_S
            while True:
                time.sleep(min(30.0, max(5.0, idle / 5.0)))
                sess = _state["ptt"]
                if sess and sess.state in ("listening", "transcribing"):
                    continue
                if time.time() - _state["last_activity"] < idle:
                    continue
                sp = audio.playback_status()
                # tts.speaking() covers the gap between rendered chunks and the
                # queue; checking only the current player let a long reply be
                # mistaken for an idle daemon.
                if tts.speaking() and not sp.get("paused"):
                    continue
                if sp.get("playing") or sp.get("paused"):
                    tts.stop_speaking()
                    audio.stop_playback()
                print(f"[jarvis-voice] idle for {int(idle)}s - exiting "
                      f"(on-demand; JARVIS_VOICE_IDLE_EXIT_S=0 stays resident)", flush=True)
                cfg.clear_runtime()
                try:
                    httpd.shutdown()
                except Exception:
                    pass
                return

        threading.Thread(target=_idle_watchdog, daemon=True).start()

    def _bye(*_a):
        try:
            audio.drop_warm_capture()
            audio.release_sles()
        except Exception:
            pass
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
        # 2 s poll: the shutdown check wakes the CPU ~6x less often than 0.3 s,
        # which is the point on battery. Incoming requests still wake it at once.
        httpd.serve_forever(poll_interval=2.0)
    finally:
        try:
            audio.drop_warm_capture()
            audio.release_sles()
        except Exception:
            pass
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
