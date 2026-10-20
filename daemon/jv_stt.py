"""
Speech-to-text. 100% local. Picks the best backend that is actually installed.

  faster-whisper   CTranslate2  - fastest on CPU, arm64 friendly (preferred)
  whisper          openai      - reference implementation
  whispercpp       whisper-cli - ggml, tiny footprint
  vosk            vosk        - streaming, very small
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import tempfile
import threading
import time
import wave
from pathlib import Path

import jv_config as cfg


class SttError(RuntimeError):
    pass


_lock = threading.Lock()
_loaded: dict = {}


def _norm(pcm: bytes, sr: int) -> bytes:
    """Whisper wants 16 kHz mono 16-bit."""
    if sr == cfg.SAMPLE_RATE:
        return pcm
    try:
        import audioop

        out, _ = audioop.ratecv(pcm, 2, 1, sr, cfg.SAMPLE_RATE, None)
        return out
    except Exception:
        return pcm


def _pcm_to_float(pcm: bytes):
    try:
        import numpy as np
    except Exception as e:  # pragma: no cover
        raise SttError(f"numpy is required for local STT: {e}")
    a = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0
    return a


# ----------------------------------------------------------------------------
# Backends
# ----------------------------------------------------------------------------

def _faster_whisper_available() -> tuple[bool, str]:
    # find_spec only: importing the package loads ctranslate2/tokenizers, which
    # costs real CPU. Status checks must stay cheap on battery; the real import
    # happens once at transcription time.
    for mod in ("faster_whisper", "ctranslate2", "tokenizers"):
        try:
            if importlib.util.find_spec(mod) is None:
                return False, f"{mod} not installed (pip install faster-whisper)"
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"
    return True, "ok"


def _cached_model(name: str) -> str | None:
    hub = Path.home() / ".cache" / "huggingface" / "hub" / f"models--Systran--faster-whisper-{name}"
    snaps = hub / "snapshots"
    if snaps.exists():
        try:
            cand = sorted([d for d in snaps.iterdir() if d.is_dir()], key=lambda d: d.stat().st_mtime, reverse=True)
            for c in cand:
                # A snapshot needs model.bin to be usable offline.
                if (c / "model.bin").exists():
                    return str(c)
        except Exception:
            pass
    return None


def _resolve_model_ref() -> str:
    """Prefer an explicit local dir, then an already-cached HF snapshot, then the name."""
    if cfg.WHISPER_MODEL_DIR:
        p = Path(cfg.WHISPER_MODEL_DIR).expanduser()
        if p.exists():
            return str(p)
    name = (cfg.WHISPER_MODEL or "auto").strip()
    if name in ("auto", "default"):
        # Fast English model when it is already present, multilingual tiny
        # otherwise. Never download just because the user asked for auto.
        for candidate in ("tiny.en", "tiny", "base.en", "base"):
            hit = _cached_model(candidate)
            if hit:
                return hit
        name = "tiny.en"
    hit = _cached_model(name)
    if hit:
        return hit
    if name == "tiny.en" and not getattr(cfg, "WHISPER_MODEL_EXPLICIT", False):
        # Keep upgrades offline-friendly: if the old multilingual tiny is
        # cached but tiny.en is not, use tiny rather than downloading silently.
        # Running `voice fetch-model tiny.en` (or setting the env var) opts in
        # to the faster English model.
        return _cached_model("tiny") or name
    return name


def _get_faster_whisper_model():
    """Load (once) and return (model, resolved_ref)."""
    from faster_whisper import WhisperModel

    ref = _resolve_model_ref()
    key = ("fw", ref, cfg.WHISPER_DEVICE, cfg.WHISPER_COMPUTE)
    with _lock:
        model = _loaded.get(key)
        if model is None:
            local_only = bool(cfg.WHISPER_MODEL_DIR) or os.environ.get("HF_HUB_OFFLINE") == "1"
            load: dict = {"device": cfg.WHISPER_DEVICE, "compute_type": cfg.WHISPER_COMPUTE}
            if cfg.WHISPER_THREADS > 0:
                # Cap heat on phones; four threads keeps load + inference fast.
                load["cpu_threads"] = cfg.WHISPER_THREADS
            try:
                model = WhisperModel(ref, local_files_only=local_only, **load)
            except Exception as e:
                if not local_only:
                    # Retry pinned to the local cache so a flaky network does not break voice.
                    os.environ["HF_HUB_OFFLINE"] = "1"
                    model = WhisperModel(ref, **load)
                else:
                    raise SttError(
                        f"cannot load faster-whisper model '{ref}': {e}. "
                        f"Set JARVIS_VOICE_WHISPER_DIR to a local model, or run: voice fetch-model {cfg.WHISPER_MODEL}"
                    )
            _loaded.clear()
            _loaded[key] = model
    return model, ref


def transcribe_faster_whisper(pcm: bytes, sr: int = cfg.SAMPLE_RATE) -> dict:
    model, ref = _get_faster_whisper_model()

    audio = _pcm_to_float(_norm(pcm, sr))
    if audio.size == 0:
        return {"text": "", "backend": "faster-whisper", "model": ref, "duration_s": 0.0}
    segments, info = model.transcribe(
        audio,
        language=(cfg.WHISPER_LANGUAGE or None),
        beam_size=cfg.WHISPER_BEAM,
        vad_filter=False,
        condition_on_previous_text=False,
        without_timestamps=True,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    return {
        "text": text,
        "backend": "faster-whisper",
        "model": str(ref),
        "language": getattr(info, "language", None),
        "probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
        "duration_s": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
    }


def transcribe_openai_whisper(pcm: bytes, sr: int = cfg.SAMPLE_RATE) -> dict:
    import whisper  # noqa: F401

    key = ("ow", cfg.WHISPER_MODEL)
    with _lock:
        model = _loaded.get(key)
        if model is None:
            model = whisper.load_model(cfg.WHISPER_MODEL)
            _loaded[key] = model
    audio = _pcm_to_float(_norm(pcm, sr))
    res = model.transcribe(audio, language=(cfg.WHISPER_LANGUAGE or None))
    return {"text": (res.get("text") or "").strip(), "backend": "whisper", "model": cfg.WHISPER_MODEL}


def transcribe_whispercpp(pcm: bytes, sr: int = cfg.SAMPLE_RATE) -> dict:
    exe = shutil.which("whisper-cli") or shutil.which("whisper-cpp") or shutil.which("main")
    if not exe:
        raise SttError("whisper.cpp binary not found")
    model = os.environ.get("JARVIS_VOICE_WHISPERCPP_MODEL", "")
    if not model or not Path(model).exists():
        for cand in (Path.home() / ".cache" / "whisper.cpp", Path("/usr/share/whisper.cpp"), Path(cfg.APP_DIR)):
            if cand.exists():
                hits = list(cand.glob("**/ggml-*.bin"))
                if hits:
                    model = str(hits[0])
                    break
    if not model:
        raise SttError("whisper.cpp model (.bin) not found; set JARVIS_VOICE_WHISPERCPP_MODEL")

    audio = _pcm_to_float(_norm(pcm, sr))
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "in.wav"
        with wave.open(str(wav), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(cfg.SAMPLE_RATE)
            wf.writeframes((audio * 32768.0).astype("<i2").tobytes())
        out_base = Path(td) / "out"
        import subprocess

        p = subprocess.run(
            [exe, "-m", model, "-f", str(wav), "-nt", "-otxt", "-of", str(out_base)],
            capture_output=True,
            timeout=120,
        )
        txt = ""
        cand = Path(str(out_base) + ".txt")
        if cand.exists():
            txt = cand.read_text(encoding="utf-8", errors="replace").strip()
        elif p.stdout:
            txt = p.stdout.decode("utf-8", "replace").strip()
    return {"text": txt, "backend": "whisper.cpp", "model": model}


def transcribe_vosk(pcm: bytes, sr: int = cfg.SAMPLE_RATE) -> dict:
    from vosk import KaldiRecognizer, Model  # type: ignore

    model_dir = os.environ.get("JARVIS_VOICE_VOSK_MODEL", "")
    if not model_dir or not Path(model_dir).exists():
        raise SttError("vosk model dir not set (JARVIS_VOICE_VOSK_MODEL)")
    key = ("vosk", model_dir)
    with _lock:
        model = _loaded.get(key)
        if model is None:
            model = Model(model_dir)
            _loaded[key] = model
    rec = KaldiRecognizer(model, sr)
    rec.SetWords(False)
    rec.AcceptWaveform(_norm(pcm, sr))
    import json

    return {"text": (json.loads(rec.FinalResult()).get("text") or "").strip(), "backend": "vosk", "model": model_dir}


_ORDER = ["faster-whisper", "whisper", "whispercpp", "vosk"]

_AVAIL_TTL = 15.0   # probing is cheap now, but status pages can poll; keep it free
_avail_cache: tuple[float, list[dict]] | None = None


def available_backends() -> list[dict]:
    """Which STT backends are installed (memoised ~15 s)."""
    global _avail_cache
    now = time.time()
    if _avail_cache and now - _avail_cache[0] < _AVAIL_TTL:
        return [dict(b) for b in _avail_cache[1]]
    out = _probe_backends()
    _avail_cache = (now, [dict(b) for b in out])
    return out


def _probe_backends() -> list[dict]:
    out = []
    for name in _ORDER:
        if name == "faster-whisper":
            ok, why = _faster_whisper_available()
            ref = _resolve_model_ref() if ok else ""
            out.append({"backend": name, "ok": ok, "reason": why, "model": ref})
        elif name == "whisper":
            try:
                ok = importlib.util.find_spec("whisper") is not None
                out.append({"backend": name, "ok": ok, "reason": "" if ok else "not installed"})
            except Exception as e:
                out.append({"backend": name, "ok": False, "reason": str(e)})
        elif name == "whispercpp":
            ok = bool(shutil.which("whisper-cli") or shutil.which("whisper-cpp") or shutil.which("main"))
            out.append({"backend": name, "ok": ok, "reason": "" if ok else "binary not found"})
        else:
            ok = bool(os.environ.get("JARVIS_VOICE_VOSK_MODEL"))
            out.append({"backend": name, "ok": ok, "reason": "" if ok else "JARVIS_VOICE_VOSK_MODEL unset"})
    return out


def pick_backend() -> str | None:
    if cfg.STT_BACKEND and cfg.STT_BACKEND != "auto":
        return None if cfg.STT_BACKEND == "none" else cfg.STT_BACKEND
    for b in available_backends():
        if b["ok"]:
            return b["backend"]
    return None


def _pcm_rms(pcm: bytes) -> float | None:
    """Normalised RMS, or None when numpy is unavailable."""
    try:
        import numpy as np

        a = np.frombuffer(pcm, dtype="<i2")
        if a.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(a.astype("float32") ** 2)) / 32768.0)
    except Exception:
        return None


def transcribe(pcm: bytes, sr: int = cfg.SAMPLE_RATE, backend: str | None = None) -> dict:
    """Transcribe 16-bit mono PCM. Returns {text, backend, model, ms}."""
    backend = backend or pick_backend()
    if not backend:
        raise SttError("no local STT backend available. Install one:  pip install faster-whisper")

    level = _pcm_rms(pcm)
    if not pcm or (level is not None and level < cfg.STT_MIN_RMS):
        return {"text": "", "backend": backend, "empty": True, "ms": 0,
                "rms": round(level or 0.0, 6), "duration_s": round(len(pcm) / 2 / sr, 2)}

    t0 = time.time()
    fn = {
        "faster-whisper": transcribe_faster_whisper,
        "faster_whisper": transcribe_faster_whisper,
        "whisper": transcribe_openai_whisper,
        "whispercpp": transcribe_whispercpp,
        "whisper.cpp": transcribe_whispercpp,
        "vosk": transcribe_vosk,
    }.get(backend)
    if fn is None:
        raise SttError(f"unknown STT backend '{backend}'")
    res = fn(pcm, sr)
    res["ms"] = int((time.time() - t0) * 1000)
    res["text"] = (res.get("text") or "").strip()
    return res


def warmup() -> dict:
    """Load the model now so the first real utterance is not slow."""
    b = pick_backend()
    if not b:
        return {"ok": False, "reason": "no backend"}
    t0 = time.time()
    try:
        if b in ("faster-whisper", "faster_whisper"):
            # Load the weights only. A dummy transcription would spend another
            # second decoding silence (and often hallucinate "thank you").
            _get_faster_whisper_model()
        else:
            # Other backends have no separate loader.
            transcribe(b"\x00\x00" * (cfg.SAMPLE_RATE // 4), cfg.SAMPLE_RATE, backend=b)
        return {"ok": True, "backend": b, "ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        return {"ok": False, "backend": b, "reason": str(e)[:300]}


def _main(argv: list[str]) -> int:
    import json

    cmd = argv[1] if len(argv) > 1 else "info"
    if cmd == "info":
        print(json.dumps({"picked": pick_backend(), "backends": available_backends()}, indent=2, default=str))
        return 0
    if cmd == "warmup":
        print(json.dumps(warmup(), indent=2, default=str))
        return 0
    if cmd == "fetch":
        name = argv[2].strip() if len(argv) > 2 and argv[2].strip() else cfg.WHISPER_MODEL
        cfg.WHISPER_MODEL = name
        cfg.WHISPER_MODEL_EXPLICIT = True
        try:
            _model, ref = _get_faster_whisper_model()
            print(json.dumps({"ok": True, "model": name, "path": ref}, indent=2, default=str))
            return 0
        except Exception as e:
            print(json.dumps({"ok": False, "model": name, "error": str(e)}, indent=2, default=str))
            return 1
    if cmd == "file" and len(argv) > 2:
        import jv_audio as audio

        pcm, sr, _ = audio.read_wav(argv[2])
        print(json.dumps(transcribe(pcm, sr), indent=2, default=str))
        return 0
    print("usage: jv_stt.py [info|warmup|fetch [model]|file <wav>]", flush=True)
    return 2


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv))
