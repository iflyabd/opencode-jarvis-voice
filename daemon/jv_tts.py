"""
Text-to-speech. 100% local, Piper first.

  piper (python)  piper-tts package, ONNX runtime - works on arm64/Windows/macOS/Termux
  piper (binary)  the standalone piper executable, if the package is not installed
  espeak-ng       always-there fallback so the assistant is never mute

Repeated short phrases ("Yes sir") are cached as WAV, which removes most of the
perceived latency in a live voice loop.
"""

from __future__ import annotations

import collections
import hashlib
import json
import os
import re
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
          fish: dict | None = None, append: bool = False) -> dict:
    """Synthesize and play through the local speakers.

    One voice at a time. A new utterance takes the speaker: the current
    playback is cut *before* the new one is rendered, because a cloud voice
    can take seconds to synthesize and two voices must never talk over each
    other. An utterance that is superseded while it renders is dropped
    instead of playing later.

    `append=True` is the polite form used for a reply that is being read as
    it streams in: the utterance is put *behind* whatever is playing and the
    speaker reads it in order, so the sentences of one answer never cut each
    other off. A normal call (the read button, a new answer) still takes the
    speaker and drops the waiting queue.
    """
    backend = backend or pick_backend()
    if append:
        return enqueue_speech(text, backend=backend, fish=fish)
    clear_speech_queue()
    return _speak_now(text, backend=backend, wait=wait, fish=fish)


def _speak_now(text: str, backend: str | None = None, wait: bool = True,
               fish: dict | None = None, gen: int | None = None,
               stop: bool = True) -> dict:
    """Take the speaker right now and play this utterance.

    The queue worker passes the generation it already claimed (under the
    queue lock) and `stop=False`: it starts only when the previous utterance
    finished, so there is nothing to cut and nothing that could cut it.
    """
    backend = backend or pick_backend()
    if gen is None:
        gen = _take_speak_generation()
    elif not _speak_current(gen):
        return {"backend": backend, "spoken": False, "superseded": True}
    if stop:
        try:
            audio.stop_playback()
        except Exception:
            pass
    if backend == "fish":
        return _speak_chunked(text, gen, wait, "fish", fish or {})
    # A local voice is rendered in one go, but a long reply still takes a
    # while: chunking it starts the first sentence sooner and keeps the
    # paragraphs running into each other.
    if len(text) > cfg.FISH_CHUNK_CHARS:
        return _speak_chunked(text, gen, wait, backend, fish)
    return _speak_single(text, gen, wait, backend, fish)


# ----------------------------------------------------------------------------
# The speaker: one utterance at a time
# ----------------------------------------------------------------------------

_speak_lock = threading.Lock()
_speak_gen = 0
_speak_active = False


def _take_speak_generation() -> int:
    """Claim the speaker. A newer call supersedes the one before it."""
    global _speak_gen, _speak_active
    with _speak_lock:
        _speak_gen += 1
        _speak_active = True
        return _speak_gen


def _speak_current(gen: int) -> bool:
    with _speak_lock:
        return gen == _speak_gen


def _finish_speak(gen: int) -> None:
    global _speak_active
    with _speak_lock:
        if gen == _speak_gen:
            _speak_active = False


def speaking() -> bool:
    """True while an utterance is being rendered, played or waiting to play."""
    with _speak_lock:
        active = _speak_active
    if active:
        return True
    with _queue_lock:
        return bool(_queue)


# ----------------------------------------------------------------------------
# The speech queue: append a streamed reply instead of cutting it off
# ----------------------------------------------------------------------------

_queue_lock = threading.Lock()
# Bumped whenever the queue is dropped, so an utterance that was already
# popped by the worker cannot start playing over the newer one.
_queue_gen = 0
_queue: "collections.deque[tuple[int, str, str | None, dict | None]]" = collections.deque()
_queue_thread: threading.Thread | None = None
QUEUE_MAX = 64


def _wait_speaker_idle(timeout: float = 300.0) -> bool:
    """Wait for the utterance that is playing now to finish."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with _speak_lock:
            if not _speak_active:
                return True
        time.sleep(0.03)
    return False


def _queue_run() -> None:
    """Play the queued utterances one after another, in order."""
    global _queue_thread
    while True:
        with _queue_lock:
            if not _queue:
                _queue_thread = None
                return
            token, text, backend, fish = _queue.popleft()
        if token != _queue_gen:
            continue
        # A queued sentence follows what is playing, it never cuts it.
        if not _wait_speaker_idle():
            continue
        with _queue_lock:
            if token != _queue_gen:
                continue
            # Claim the speaker while the queue lock is held: a normal
            # utterance that arrives after this point takes the generation
            # and drops this item instead of being cut by it.
            gen = _take_speak_generation()
        try:
            _speak_now(text, backend=backend, wait=True, fish=fish, gen=gen, stop=False)
        except Exception:
            # A failed utterance must not stop the ones behind it - and must
            # not leave the speaker marked as busy either.
            try:
                _finish_speak(gen)
            except Exception:
                pass


def enqueue_speech(text: str, backend: str | None = None,
                   fish: dict | None = None) -> dict:
    """Queue an utterance behind what is already being said."""
    global _queue_thread
    text = (text or "").strip()
    if not text:
        return {"backend": backend, "spoken": False, "queued": False, "pending": 0}
    with _queue_lock:
        pending = len(_queue)
        if pending >= QUEUE_MAX:
            # A runaway stream must not grow without bound.
            return {"backend": backend, "spoken": False, "queued": False,
                    "pending": pending, "full": True}
        _queue.append((_queue_gen, text, backend, fish))
        pending = len(_queue)
        if _queue_thread is None or not _queue_thread.is_alive():
            _queue_thread = threading.Thread(target=_queue_run, daemon=True, name="tts-queue")
            _queue_thread.start()
    return {"backend": backend or pick_backend(), "spoken": True, "queued": True,
            "pending": pending, "chars": len(text)}


def clear_speech_queue() -> int:
    """Drop everything that is waiting to be read."""
    global _queue_gen
    with _queue_lock:
        _queue_gen += 1
        dropped = len(_queue)
        _queue.clear()
    return dropped


def queue_size() -> int:
    with _queue_lock:
        return len(_queue)


def _speak_single(text: str, gen: int, wait: bool, backend: str | None,
                  fish: dict | None) -> dict:
    """Render one clip and play it."""
    if wait:
        info = synthesize(text, backend=backend, fish=fish)
        if not _speak_current(gen):
            info.update({"spoken": False, "superseded": True})
            _finish_speak(gen)
            return info
        try:
            info["playback"] = audio.play_wav(info["path"])
        finally:
            _finish_speak(gen)
        info["spoken"] = True
        return info

    def _run() -> None:
        try:
            info = synthesize(text, backend=backend, fish=fish)
            if not _speak_current(gen):
                return
            audio.play_wav(info["path"])
        except audio.AudioError:
            # A stop, interrupt or superseding utterance cancels playback on
            # purpose; only real failures would be worth reporting and the
            # daemon reports those through /speech and /health.
            pass
        except Exception:
            pass
        finally:
            _finish_speak(gen)

    # The request returns straight away: the reply is already on its way to
    # the speakers, and the caller can show the "playing" state at once.
    threading.Thread(target=_run, daemon=True).start()
    return {"backend": backend, "spoken": True, "queued": True, "ms": 0,
            "chars": len(text or ""), "playback": {"backend": "async", "ok": True}}


# ----------------------------------------------------------------------------
# Fish: render the reply in chunks so the first sound arrives early
# ----------------------------------------------------------------------------

def _split_for_speech(text: str, max_chars: int | None = None) -> list[str]:
    """Split a reply into chunks that can be rendered one at a time.

    The split follows sentence boundaries: a cloud voice that renders a whole
    reply in one request can take many seconds before the first sound, while
    the first chunk is ready in a fraction of that time.
    """
    limit = max_chars or cfg.FISH_CHUNK_CHARS
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return []
    chunks: list[str] = []
    current = ""
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > limit:
            # A very long sentence: break it on word boundaries.
            piece = ""
            for word in sentence.split(" "):
                if piece and len(piece) + len(word) + 1 > limit:
                    chunks.append(piece)
                    piece = word
                else:
                    piece = f"{piece} {word}".strip()
            if piece:
                current = f"{current} {piece}".strip()
            continue
        if current and len(current) + len(sentence) + 1 > limit:
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        chunks.append(current)
    return [c for c in chunks if c]


def _trim_wav_tail(path: Path, keep_ms: int = 60) -> None:
    """Cut the silence at the end of a clip so the chunks join up.

    Every rendered chunk ends with a little silence. Left alone, those tails
    add up to a pause between the paragraphs of a reply.
    """
    try:
        import array
        import sys as _sys

        with wave.open(str(path), "rb") as w:
            params = w.getparams()
            frames = w.readframes(w.getnframes())
        if not frames:
            return
        width = max(1, params.sampwidth or 2)
        count = len(frames) // width
        samples = array.array("h")
        samples.frombytes(frames[: count * width])
        if _sys.byteorder == "big":
            samples.byteswap()
        floor = 250  # about -42 dB: the noise floor of a rendered clip
        last = -1
        for i in range(count - 1, -1, -1):
            if abs(samples[i]) > floor:
                last = i
                break
        if last < 0:
            return
        keep = int((params.framerate or 16000) * keep_ms / 1000)
        end = min(count, last + keep)
        if end >= count:
            return
        with wave.open(str(path), "wb") as w:
            w.setparams(params)
            w.writeframes(samples[:end].tobytes())
    except Exception:
        # Not a plain WAV (the MP3 fallback): leave the clip as it is.
        return


def _speak_chunked(text: str, gen: int, wait: bool, backend: str, fish: dict | None) -> dict:
    """Render a reply chunk by chunk and play it in order.

    The next chunk is rendered while the current one is playing, so the reply
    does not stop between the paragraphs while the next request is made.
    """
    chunks = _split_for_speech(text)
    if len(chunks) <= 1:
        return _speak_single(text, gen, wait, backend, fish)

    state = {"chunks": len(chunks), "ms": 0}

    def _render(chunk: str, fast: bool) -> dict:
        options = dict(fish or {})
        if fast and backend == "fish":
            # The first sound matters most: ask Fish for the fastest
            # first chunk it can give.
            options["latency"] = "low"
        t0 = time.time()
        info = synthesize(chunk, backend=backend, fish=options or None)
        state["ms"] += int((time.time() - t0) * 1000)
        try:
            _trim_wav_tail(Path(info["path"]))
        except Exception:
            pass
        return info

    def _play(path: str) -> None:
        try:
            audio.play_wav(path)
        except audio.AudioError:
            pass
        except Exception:
            pass

    def _run() -> None:
        pending: dict | None = None
        for index, chunk in enumerate(chunks):
            if not _speak_current(gen):
                return
            if pending is None:
                pending = _render(chunk, index == 0)
            current = pending
            pending = None
            # Play this chunk while the next one is rendered in the background.
            player = threading.Thread(target=_play, args=(current["path"],), daemon=True)
            player.start()
            if index + 1 < len(chunks):
                try:
                    pending = _render(chunks[index + 1], False)
                except Exception:
                    pending = None
            player.join()
            if not _speak_current(gen):
                return

    def _run_and_finish() -> None:
        try:
            _run()
        finally:
            _finish_speak(gen)

    if wait:
        _run_and_finish()
    else:
        threading.Thread(target=_run_and_finish, daemon=True).start()
    return {"backend": backend, "spoken": True, "queued": True, "ms": 0,
            "chunks": state["chunks"], "chars": len(text or ""),
            "playback": {"backend": "async", "ok": True}}


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
