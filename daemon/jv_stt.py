"""
Speech-to-text. 100% local. Picks the best backend that is actually installed.

  faster-whisper   CTranslate2  - fastest on CPU, arm64 friendly (preferred)
  whisper          openai      - reference implementation
  whispercpp       whisper-cli - ggml, tiny footprint
  vosk            vosk        - streaming, very small
"""

from __future__ import annotations

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
    try:
        import faster_whisper  # noqa: F401

        return True, "ok"
    except Exception as e:
        return False, str(e)


def _resolve_model_ref() -> str:
    """Prefer an explicit local dir, then an already-cached HF snapshot, then the name."""
    if cfg.WHISPER_MODEL_DIR:
        p = Path(cfg.WHISPER_MODEL_DIR).expanduser()
        if p.exists():
            return str(p)
    name = cfg.WHISPER_MODEL
    hub = Path.home() / ".cache" / "huggingface" / "hub" / f"models--Systran--faster-whisper-{name}"
    snaps = hub / "snapshots"
    if snaps.exists():
        try:
            cand = sorted([d for d in snaps.iterdir() if d.is_dir()], key=lambda d: d.stat().st_mtime, reverse=True)
            if cand:
                # A snapshot needs model.bin to be usable offline.
                for c in cand:
                    if (c / "model.bin").exists():
                        return str(c)
        except Exception:
            pass
    return name


def transcribe_faster_whisper(pcm: bytes, sr: int = cfg.SAMPLE_RATE) -> dict:
    from faster_whisper import WhisperModel

    ref = _resolve_model_ref()
    key = ("fw", ref, cfg.WHISPER_DEVICE, cfg.WHISPER_COMPUTE)
    with _lock:
        model = _loaded.get(key)
        if model is None:
            local_only = bool(cfg.WHISPER_MODEL_DIR) or os.environ.get("HF_HUB_OFFLINE") == "1"
            try:
                model = WhisperModel(ref, device=cfg.WHISPER_DEVICE, compute_type=cfg.WHISPER_COMPUTE,
                                     local_files_only=local_only)
            except Exception as e:
                if not local_only:
                    # Retry pinned to the local cache so a flaky network does not break voice.
                    os.environ["HF_HUB_OFFLINE"] = "1"
                    model = WhisperModel(ref, device=cfg.WHISPER_DEVICE, compute_type=cfg.WHISPER_COMPUTE)
                else:
                    raise SttError(
                        f"cannot load faster-whisper model '{ref}': {e}. "
                        f"Set JARVIS_VOICE_WHISPER_DIR to a local model, or run: voice fetch-model {cfg.WHISPER_MODEL}"
                    )
            _loaded.clear()
            _loaded[key] = model

    audio = _pcm_to_float(_norm(pcm, sr))
    if audio.size == 0:
        return {"text": "", "backend": "faster-whisper", "model": ref, "duration_s": 0.0}
    segments, info = model.transcribe(
        audio,
        language=(cfg.WHISPER_LANGUAGE or None),
        beam_size=cfg.WHISPER_BEAM,
        vad_filter=False,
        condition_on_previous_text=False,
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


def available_backends() -> list[dict]:
    out = []
    for name in _ORDER:
        if name == "faster-whisper":
            ok, why = _faster_whisper_available()
            ref = _resolve_model_ref() if ok else ""
            out.append({"backend": name, "ok": ok, "reason": why, "model": ref})
        elif name == "whisper":
            try:
                import whisper  # noqa: F401

                out.append({"backend": name, "ok": True, "model": cfg.WHISPER_MODEL})
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


def transcribe(pcm: bytes, sr: int = cfg.SAMPLE_RATE, backend: str | None = None) -> dict:
    """Transcribe 16-bit mono PCM. Returns {text, backend, model, ms}."""
    backend = backend or pick_backend()
    if not backend:
        raise SttError("no local STT backend available. Install one:  pip install faster-whisper")

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
        # ~0.25 s of silence is enough to force the model to load.
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
    if cmd == "file" and len(argv) > 2:
        import jv_audio as audio

        pcm, sr, _ = audio.read_wav(argv[2])
        print(json.dumps(transcribe(pcm, sr), indent=2, default=str))
        return 0
    print("usage: jv_stt.py [info|warmup|file <wav>]", flush=True)
    return 2


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv))
