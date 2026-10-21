"""
Text-to-speech. 100% local, Piper first.

  piper (python)  piper-tts package, ONNX runtime - works on arm64/Windows/macOS/Termux
  piper (binary)  the standalone piper executable, if the package is not installed
  espeak-ng       always-there fallback so the assistant is never mute

Repeated short phrases ("Yes sir") are cached as WAV, which removes most of the
perceived latency in a live voice loop.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import jv_config as cfg
import jv_audio as audio
import jv_voices as voices

TTS_CACHE = cfg.CACHE_DIR / "tts"


class TtsError(RuntimeError):
    pass


_voice_obj = None
_voice_path = None
_lock = threading.Lock()


def _piper_python_available() -> tuple[bool, str]:
    try:
        from piper import PiperVoice  # noqa: F401

        return True, "ok"
    except Exception as e:
        return False, str(e)


def _piper_bin() -> str | None:
    return shutil.which("piper")


def _espeak_bin() -> str | None:
    return shutil.which("espeak-ng") or shutil.which("espeak")


_AVAIL_TTL = 15.0   # importing piper pulls in onnxruntime; don't redo it per status poll
_avail_cache: tuple[float, list[dict]] | None = None


def available_backends() -> list[dict]:
    """Which TTS backends work (memoised ~15 s)."""
    global _avail_cache
    now = time.time()
    if _avail_cache and now - _avail_cache[0] < _AVAIL_TTL:
        return [dict(b) for b in _avail_cache[1]]
    out = _probe_backends()
    _avail_cache = (now, [dict(b) for b in out])
    return out


def _probe_backends() -> list[dict]:
    ok_py, why_py = _piper_python_available()
    v = voices.resolve()
    out = [
        {"backend": "piper", "ok": ok_py and bool(v), "reason": "" if ok_py else why_py,
         "voice": v.to_dict() if v else None},
        {"backend": "piper-bin", "ok": bool(_piper_bin()), "reason": "" if _piper_bin() else "piper binary not found",
         "voice": v.to_dict() if v else None},
        {"backend": "espeak", "ok": bool(_espeak_bin()), "reason": "" if _espeak_bin() else "espeak-ng not installed"},
    ]
    return out


def pick_backend() -> str | None:
    if cfg.TTS_BACKEND and cfg.TTS_BACKEND != "auto":
        return None if cfg.TTS_BACKEND == "none" else cfg.TTS_BACKEND
    for b in available_backends():
        if b["ok"]:
            return b["backend"]
    return None


# ----------------------------------------------------------------------------
# Synthesis
# ----------------------------------------------------------------------------

def _syn_config():
    try:
        from piper import SynthesisConfig

        kwargs = {"length_scale": cfg.TTS_LENGTH_SCALE, "noise_scale": cfg.TTS_NOISE_SCALE,
                  "noise_w_scale": cfg.TTS_NOISE_W}
        if cfg.TTS_SPEAKER:
            try:
                kwargs["speaker_id"] = int(cfg.TTS_SPEAKER)
            except ValueError:
                pass
        return SynthesisConfig(**kwargs)
    except Exception:
        return None


def _load_piper(model_path: str):
    global _voice_obj, _voice_path
    from piper import PiperVoice

    with _lock:
        if _voice_obj is not None and _voice_path == model_path:
            return _voice_obj
        v = voices.resolve(prefer=model_path)
        if not v:
            raise TtsError(f"voice not usable: {model_path}")
        _voice_obj = PiperVoice.load(v.model, config_path=v.config)
        _voice_path = model_path
        return _voice_obj


def synth_piper(text: str, out: Path) -> dict:
    v = voices.resolve(prefer=cfg.PIPER_VOICE or None)
    if not v:
        raise TtsError("no Piper voice found - run `voice voice list` / `voice fetch en_GB-alan-medium`")
    voice = _load_piper(v.model)
    with wave.open(str(out), "wb") as wf:
        voice.synthesize_wav(text, wf, syn_config=_syn_config())
    return {"backend": "piper", "voice": v.name, "model": v.model, "sample_rate": v.sample_rate}


def synth_piper_bin(text: str, out: Path) -> dict:
    exe = _piper_bin()
    if not exe:
        raise TtsError("piper binary not found")
    v = voices.resolve(prefer=cfg.PIPER_VOICE or None)
    if not v:
        raise TtsError("no Piper voice found")
    cmd = [exe, "-m", v.model, "-f", str(out)]
    if v.config:
        cmd += ["-c", v.config]
    if cfg.TTS_LENGTH_SCALE and cfg.TTS_LENGTH_SCALE != 1.0:
        cmd += ["--length-scale", str(cfg.TTS_LENGTH_SCALE)]
    p = subprocess.run(cmd, input=text.encode("utf-8"), capture_output=True, timeout=120)
    if p.returncode != 0 or not out.exists():
        raise TtsError(f"piper rc={p.returncode}: {p.stderr.decode('utf-8', 'replace')[:200]}")
    return {"backend": "piper-bin", "voice": v.name, "model": v.model}


def synth_espeak(text: str, out: Path) -> dict:
    exe = _espeak_bin()
    if not exe:
        raise TtsError("espeak-ng not installed")
    voice = os.environ.get("JARVIS_VOICE_ESPEAK_VOICE", "en-gb+m3")
    cmd = [exe, "-v", voice, "-s", os.environ.get("JARVIS_VOICE_ESPEAK_SPEED", "165"), "-w", str(out), text]
    p = subprocess.run(cmd, capture_output=True, timeout=60)
    if p.returncode != 0 or not out.exists():
        raise TtsError(f"espeak rc={p.returncode}")
    return {"backend": "espeak", "voice": voice}


def _fish_error(body: bytes, code: int) -> str:
    msg = ""
    try:
        data = json.loads(body.decode("utf-8", "replace"))
        if isinstance(data, dict):
            msg = str(data.get("message") or data.get("error") or data.get("reason") or "")
    except Exception:
        msg = body.decode("utf-8", "replace").strip()[:300]
    return f"Fish Audio HTTP {code}" + (f": {msg}" if msg else "")


def _fish_request(text: str, api_key: str, voice_id: str, model: str,
                  fmt: str, latency: str) -> bytes:
    payload = json.dumps({
        "text": text,
        "reference_id": voice_id,
        "format": fmt,
        "normalize": True,
        "latency": latency,
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg.FISH_API_URL,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "audio/wav, audio/mpeg",
            "model": model,
            "User-Agent": f"opencode-jarvis-voice/{cfg.DAEMON_VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=cfg.FISH_TIMEOUT) as resp:
            data = resp.read()
    except urllib.error.HTTPError as e:
        raise TtsError(_fish_error(e.read() or b"", e.code)) from e
    except urllib.error.URLError as e:
        raise TtsError(f"Fish Audio unreachable: {e.reason}") from e
    except Exception as e:
        raise TtsError(f"Fish Audio request failed: {e}") from e
    if not data:
        raise TtsError("Fish Audio returned empty audio")
    # A JSON body here is an error even with a 200 status.
    if data[:1] in (b"{", b"["):
        raise TtsError(_fish_error(data, 200))
    return data


def _fix_wav_sizes(path: Path) -> None:
    """Repair streaming WAV headers that advertise a size beyond EOF.

    Fish Audio returns a WAV whose RIFF/data sizes are placeholders
    (0xFFFFFF00-ish) while the payload simply ends at EOF. libsndfile, sox,
    aplay and Python's wave module then believe the clip lasts hours. Rewrite
    the two size fields from the real file length; leave normal WAVs alone.
    """
    try:
        total = path.stat().st_size
        with path.open("rb+") as f:
            head = f.read(12)
            if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
                return
            off = 12
            data_at = data_size = None
            while off + 8 <= total:
                f.seek(off)
                chunk = f.read(8)
                if len(chunk) < 8:
                    break
                cid, size = struct.unpack("<4sI", chunk)
                if cid == b"data":
                    data_at, data_size = off + 8, size
                    break
                off += 8 + size + (size & 1)
            if data_at is None:
                return
            actual = total - data_at
            if actual <= 0:
                return
            if data_size is None or data_size > actual:
                f.seek(data_at - 4)
                f.write(struct.pack("<I", actual))
            riff_size = struct.unpack("<I", head[4:8])[0]
            if riff_size != total - 8:
                f.seek(4)
                f.write(struct.pack("<I", total - 8))
    except Exception:
        # A broken header is less bad than failing a clip that may still play.
        return


def synth_fish(text: str, out: Path, fish: dict | None = None) -> dict:
    """Cloud voice via Fish Audio. Requires an API key and a voice model id."""
    fish = fish or {}
    api_key = str(fish.get("apiKey") or cfg.FISH_API_KEY or "").strip()
    voice_id = str(fish.get("voiceId") or cfg.FISH_VOICE_ID or "").strip()
    model = str(fish.get("model") or cfg.FISH_MODEL or "s2.1-pro-free").strip()
    latency = str(fish.get("latency") or cfg.FISH_LATENCY or "balanced").strip()
    if not api_key:
        raise TtsError("Fish Audio API key is not set (Voice: settings in OpenCode)")
    if not voice_id:
        raise TtsError("Fish Audio voice id is not set (choose a voice in Voice: settings)")

    # WAV avoids a lossy re-encode and is accepted by every local player.
    # If this account/model rejects WAV, fall back to MP3 and remember the path.
    try:
        data = _fish_request(text, api_key, voice_id, model, "wav", latency)
        out.write_bytes(data)
        _fix_wav_sizes(out)
        return {"backend": "fish", "voice": voice_id, "model": model,
                "format": "wav", "path": str(out)}
    except TtsError as e:
        message = str(e).lower()
        if not any(word in message for word in ("format", "wav", "unsupported", "media type")):
            raise
        data = _fish_request(text, api_key, voice_id, model, "mp3", latency)
        mp3 = out.with_suffix(".mp3")
        mp3.write_bytes(data)
        return {"backend": "fish", "voice": voice_id, "model": model,
                "format": "mp3", "path": str(mp3)}


_SYNTH = {"piper": synth_piper, "piper-bin": synth_piper_bin, "espeak": synth_espeak}


# ----------------------------------------------------------------------------
# Cache + public API
# ----------------------------------------------------------------------------

def _cache_key(text: str, backend: str, voice: str = "") -> Path:
    h = hashlib.sha256(
        f"{backend}|{voice}|{cfg.PIPER_VOICE}|{cfg.TTS_LENGTH_SCALE}|{text}".encode()
    ).hexdigest()[:24]
    # Fish primarily returns WAV; an MP3 fallback is cached beside it.
    return TTS_CACHE / f"{h}.wav"


def synthesize(text: str, backend: str | None = None, use_cache: bool = True,
               fish: dict | None = None) -> dict:
    """Render text to an audio file. Returns {path, backend, cached, ms}."""
    text = (text or "").strip()
    if not text:
        raise TtsError("nothing to say")
    backend = backend or pick_backend()
    if not backend:
        raise TtsError("no local TTS backend available. Install piper-tts, or espeak-ng.")

    TTS_CACHE.mkdir(parents=True, exist_ok=True)
    if backend == "fish":
        fish = fish or {}
        api_key = str(fish.get("apiKey") or cfg.FISH_API_KEY or "").strip()
        voice = str(fish.get("voiceId") or cfg.FISH_VOICE_ID or "")
        model = str(fish.get("model") or cfg.FISH_MODEL or "")
        if not api_key:
            raise TtsError("Fish Audio API key is not set (Voice: settings in OpenCode)")
        if not voice:
            raise TtsError("Fish Audio voice id is not set (Voice: settings in OpenCode)")
        out = _cache_key(text, backend, f"{voice}|{model}")
    else:
        out = _cache_key(text, backend)
    cached = [out]
    if backend == "fish":
        cached.append(out.with_suffix(".mp3"))
    if use_cache:
        for c in cached:
            if c.exists() and c.stat().st_size > 44:
                return {"path": str(c), "backend": backend, "cached": True, "ms": 0, "chars": len(text)}

    t0 = time.time()
    fn = _SYNTH.get(backend)
    if backend != "fish" and fn is None:
        raise TtsError(f"unknown TTS backend '{backend}'")
    tmp = out.with_name(f"{out.stem}.part{out.suffix}")
    try:
        info = synth_fish(text, tmp, fish=fish) if backend == "fish" else fn(text, tmp)
    except Exception as e:
        try:
            tmp.unlink()
        except Exception:
            pass
        raise TtsError(f"{backend}: {e}") from e
    actual = Path(info.get("path") or tmp)
    final = out if actual == tmp else out.with_suffix(actual.suffix)
    actual.replace(final)
    info.update({"path": str(final), "cached": False, "ms": int((time.time() - t0) * 1000),
                 "chars": len(text)})
    return info


def speak(text: str, backend: str | None = None, wait: bool = True,
          fish: dict | None = None) -> dict:
    """Synthesize and play through the local speakers."""
    info = synthesize(text, backend=backend, fish=fish)
    # One voice at a time: an older utterance is cut off, not layered under
    # the new one.
    audio.stop_playback()
    if wait:
        play = audio.play_wav(info["path"])
        info["playback"] = play
    else:

        def _play_async() -> None:
            try:
                audio.play_wav(info["path"])
            except audio.AudioError:
                # A stop, interrupt or superseding utterance cancels playback
                # on purpose; only real failures would be worth reporting and
                # the daemon reports those through /speech and /health.
                pass

        threading.Thread(target=_play_async, daemon=True).start()
        info["playback"] = {"backend": "async", "ok": True}
    info["spoken"] = True
    return info


def warmup() -> dict:
    """Pre-render a short phrase so the voice model is resident."""
    try:
        info = synthesize("Ready.")
        return {"ok": True, "backend": info["backend"], "ms": info["ms"]}
    except Exception as e:
        return {"ok": False, "reason": str(e)[:300]}


def _main(argv: list[str]) -> int:
    import json

    cmd = argv[1] if len(argv) > 1 else "info"
    if cmd == "info":
        print(json.dumps({"picked": pick_backend(), "backends": available_backends()}, indent=2, default=str))
        return 0
    if cmd == "say" and len(argv) > 2:
        print(json.dumps(speak(" ".join(argv[2:])), indent=2, default=str))
        return 0
    if cmd == "synth" and len(argv) > 2:
        print(json.dumps(synthesize(" ".join(argv[2:])), indent=2, default=str))
        return 0
    if cmd == "warmup":
        print(json.dumps(warmup(), indent=2, default=str))
        return 0
    print("usage: jv_tts.py [info|say <text>|synth <text>|warmup]", flush=True)
    return 2


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv))
