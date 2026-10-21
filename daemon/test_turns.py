"""Daemon-side checks for the push-to-talk turn and the microphone choice.

Run with:  npm run test:daemon      (or: .venv/bin/python daemon/test_turns.py)

No audio and no network: the capture and the transcription are stubbed.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import jv_audio  # noqa: E402
import jv_server  # noqa: E402
import jv_tts  # noqa: E402

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" ({detail})" if detail else ""))
    if not ok:
        FAILURES.append(name)


# --------------------------------------------------------------------- turns

class _Utt:
    pcm = b"\x01\x00" * 16000
    sr = 16000
    stats = {"audio_ms": 1000, "reason": "ok", "rms": 0.2}


def _turn(cancelled_mid_transcribe: bool) -> dict:
    """Run one PTT turn and return what the client would receive."""
    jv_server.record_utterance = lambda **kw: _Utt()
    holder: list = []

    def fake_transcribe(pcm, sr, backend=None, options=None):
        if cancelled_mid_transcribe:
            # The user pressed the key again while the model was working.
            # cancel() waits for the turn, so only the flag is set here.
            for _ in range(200):
                if holder:
                    break
                time.sleep(0.01)
            if holder:
                holder[0]._cancelled = True
                holder[0].stop_event.set()
        return {"text": "hello there", "backend": "faster-whisper", "model_name": "tiny.en"}

    jv_server.stt.transcribe = fake_transcribe
    sess = jv_server.PttSession(max_ms=1000)
    holder.append(sess)
    sess.stop_event.set()
    out = sess.stop_and_wait(10)
    return out


out = _turn(cancelled_mid_transcribe=False)
check("a normal turn returns the transcript", (out.get("result") or {}).get("text") == "hello there",
      str(out)[:120])

out = _turn(cancelled_mid_transcribe=True)
check("a turn cancelled while transcribing keeps its words",
      (out.get("result") or {}).get("text") == "hello there", str(out)[:120])
check("a cancelled turn is not left hanging", out.get("state") in ("done", "cancelled"), str(out.get("state")))


# ------------------------------------------------------------------ devices

check("a missing mic object means automatic", jv_server._mic_device({}) == "")
check("an empty device means automatic", jv_server._mic_device({"mic": {"device": ""}}) == "")
check("the chosen device is read", jv_server._mic_device({"mic": {"device": "pulse:jarvis_mic"}}) == "pulse:jarvis_mic")
check("a device without a mic key is ignored", jv_server._mic_device({"mic": "jarvis_mic"}) == "")

check("a pulse device only goes to the pulse backends",
      jv_audio.device_for_backend("pulse:jarvis_mic", "pulse-sles") == "jarvis_mic"
      and jv_audio.device_for_backend("pulse:jarvis_mic", "sounddevice") == "")
check("the termux device only goes to the termux backend",
      jv_audio.device_for_backend("termux:default", "termux") == "default"
      and jv_audio.device_for_backend("termux:default", "pulse") == "")
check("a portaudio index only goes to the local backends",
      jv_audio.device_for_backend("index:6", "sounddevice") == "6"
      and jv_audio.device_for_backend("index:6", "pulse") == "")
check("a plain device keeps the old behaviour",
      jv_audio.device_for_backend("hw:1,0", "pulse") == "hw:1,0")

check("a chosen pulse device only tries the pulse backends",
      jv_audio.device_backend_order("pulse:jarvis_mic") == ["pulse-sles", "pulse"],
      str(jv_audio.device_backend_order("pulse:jarvis_mic")))
check("a chosen termux device only tries termux",
      jv_audio.device_backend_order("termux:default") == ["termux"])
check("no device keeps the normal order",
      "pulse-sles" in jv_audio.device_backend_order(""))


# ----------------------------------------------------------------- speaking

class _FakeAudio:
    """Records what the speaker does, without touching a sound card."""

    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.stopped = 0

    def stop_playback(self) -> None:
        self.stopped += 1
        self.events.append("stop")

    def play_wav(self, path, timeout=120) -> dict:
        self.events.append(f"play:{Path(path).stem}")
        return {"backend": "fake", "ok": True}


def _stub_synthesize(events: list[str], delay: float = 0.05):
    def fake(text: str, backend=None, use_cache=True, fish=None):
        events.append(f"synth:{text[:12]}")
        time.sleep(delay)
        out = Path("/tmp/opencode/jarvis-test-tts")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"RIFF" + b"\0" * 64)
        return {"path": str(out), "backend": backend or "fish", "cached": False, "ms": 0}
    return fake


def _speak_checks() -> None:
    events: list[str] = []
    fake_audio = _FakeAudio(events)
    real_audio = jv_tts.audio
    real_synth = jv_tts.synthesize
    jv_tts.audio = fake_audio
    jv_tts.synthesize = _stub_synthesize(events)
    try:
        # 1. An async utterance returns at once and plays in the background.
        out = jv_tts.speak("first reply", backend="fish", wait=False, fish={"apiKey": "k", "voiceId": "v"})
        check("an async utterance returns immediately", out.get("queued") is True, str(out)[:120])
        time.sleep(0.4)
        check("the background job played the clip", "play:jarvis-test-tts" in events, str(events))
        check("the old voice was cut before rendering", events[0] == "stop", str(events))

        # 2. A second utterance supersedes the first: only one voice plays.
        events.clear()
        jv_tts.synthesize = _stub_synthesize(events, delay=0.3)
        jv_tts.speak("one", backend="fish", wait=False, fish={"apiKey": "k", "voiceId": "v"})
        time.sleep(0.05)
        jv_tts.speak("two", backend="fish", wait=False, fish={"apiKey": "k", "voiceId": "v"})
        time.sleep(0.8)
        plays = [e for e in events if e.startswith("play:")]
        check("only one voice plays at a time", len(plays) == 1, str(events))
        check("the newest utterance is the one that plays", "synth:two" in events, str(events))

        # 3. A long reply is rendered in chunks, and the first chunk is
        #    played before the rest is rendered.
        events.clear()
        jv_tts.synthesize = _stub_synthesize(events, delay=0.05)
        long_text = ("One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. " * 12)
        jv_tts.speak(long_text, backend="fish", wait=False, fish={"apiKey": "k", "voiceId": "v"})
        time.sleep(1.2)
        first_play = next((i for i, e in enumerate(events) if e.startswith("play:")), None)
        synths_before = len([e for e in events[:first_play] if e.startswith("synth:")]) if first_play is not None else -1
        total_synths = len([e for e in events if e.startswith("synth:")])
        check("a long reply is rendered in several chunks", total_synths >= 2, str(total_synths))
        check(
            "the first chunk plays before the whole reply is rendered",
            first_play is not None and synths_before == 1,
            f"first_play={first_play} synths_before={synths_before} total={total_synths}",
        )
    finally:
        jv_tts.audio = real_audio
        jv_tts.synthesize = real_synth


_speak_checks()

if FAILURES:
    print(f"\n{len(FAILURES)} check(s) failed")
    raise SystemExit(1)
print("\nAll daemon checks passed.")
