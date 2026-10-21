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


# --------------------------------------------------------- chunk pipelining

def _pipeline_checks() -> None:
    """The next chunk must be rendered while the current one is playing.

    Rendering the next chunk only after the current one finished put a
    network round trip of silence between every paragraph.
    """
    events: list[tuple[str, float, float]] = []

    def fake_synth(text: str, backend=None, use_cache=True, fish=None):
        start = time.monotonic()
        time.sleep(0.2)                         # the render takes a moment
        events.append(("synth", start, time.monotonic()))
        out = Path("/tmp/opencode/jarvis-pipeline.wav")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"RIFF" + b"\0" * 64)
        return {"path": str(out), "backend": backend or "fish", "cached": False, "ms": 200}

    def fake_play(path, timeout=120):
        start = time.monotonic()
        time.sleep(0.3)                         # the clip plays for a moment
        events.append(("play", start, time.monotonic()))
        return {"backend": "fake", "ok": True}

    real_synth = jv_tts.synthesize
    real_play = jv_tts.audio.play_wav
    jv_tts.synthesize = fake_synth
    jv_tts.audio.play_wav = fake_play
    try:
        text = ". ".join(f"Sentence number {i} is long enough to need its own chunk" for i in range(6)) + "."
        jv_tts.speak(text, backend="fish", wait=True, fish={"apiKey": "k", "voiceId": "v"})
        kinds = [e[0] for e in events]
        check("the reply is rendered in several chunks", kinds.count("synth") >= 2, str(kinds))
        plays = [e for e in events if e[0] == "play"]
        synths = [e for e in events if e[0] == "synth"]
        check(
            "the next chunk is rendered while the current one plays",
            len(plays) >= 1 and len(synths) >= 2 and synths[1][1] < plays[0][2],
            f"second render at {synths[1][1]:.3f}, first clip ends at {plays[0][2]:.3f}",
        )
    finally:
        jv_tts.synthesize = real_synth
        jv_tts.audio.play_wav = real_play


_pipeline_checks()


# --------------------------------------------------------------- live captions

def _live_caption_checks() -> None:
    """A live turn captions the words while it is still listening."""
    def fake_record(**kw):
        on_level = kw.get("on_level")
        on_audio = kw.get("on_audio")
        if on_level:
            on_level(0.2, True)
        if on_audio:
            on_audio(b"\x01\x00" * 16000)      # one second of audio
        # Keep "listening" until the caller stops the turn, like a real
        # capture would while the user is still speaking.
        stop = kw.get("stop_event")
        deadline = time.time() + 3.0
        while stop is not None and not stop.is_set() and time.time() < deadline:
            time.sleep(0.02)
        return _Utt()

    def fake_transcribe(pcm, sr, backend=None, options=None):
        return {"text": "a partial caption", "backend": "faster-whisper"}

    real_record = jv_server.record_utterance
    real_transcribe = jv_server.stt.transcribe
    jv_server.record_utterance = fake_record
    jv_server.stt.transcribe = fake_transcribe
    try:
        sess = jv_server.PttSession(max_ms=1000, silence_ms=450, partial=True)
        time.sleep(1.3)
        snap = sess.snapshot()
        check("a live turn captions the words while it listens",
              snap.get("partial") == "a partial caption", f"partial={snap.get('partial')!r}")
        check("a live turn reports the input level", snap.get("speaking") is True and snap.get("level") == 0.2,
              f"speaking={snap.get('speaking')} level={snap.get('level')}")
        out = sess.stop_and_wait(10)
        check("the final transcript replaces the caption",
              (out.get("result") or {}).get("text") == "a partial caption",
              str(out.get("result"))[:120])

        plain = jv_server.PttSession(max_ms=1000, silence_ms=450)
        time.sleep(0.15)
        plain.stop_and_wait(10)
        check("a normal turn does not pay for a caption", "partial" not in plain.snapshot(),
              str(plain.snapshot()))
    finally:
        jv_server.record_utterance = real_record
        jv_server.stt.transcribe = real_transcribe


_live_caption_checks()


# ------------------------------------------------------------------ the gate

def _gate_checks() -> None:
    """The live voice gate: start fast, end fast, ignore the room."""
    gate = jv_audio.VoiceGate(threshold=0.012, block_ms=30, silence_ms=450,
                              min_speech_ms=250, noise_mult=2.4, preroll_ms=300)
    quiet, voice = 0.001, 0.05
    states = [gate.push(quiet) for _ in range(20)]
    states += [gate.push(voice) for _ in range(30)]
    states += [gate.push(quiet) for _ in range(40)]

    check("the gate notices the voice at once", states.index("start") == 20, str(states.index("start")))
    first_end = states.index("end")
    check("the gate ends after a short hangover",
          first_end == 20 + 30 + 14, f"end at {first_end}")
    check("the gate knows how long the speech was", gate.speech_ms == 900, str(gate.speech_ms))
    check("the gate keeps the audio before the onset", gate.preroll_blocks == 10, str(gate.preroll_blocks))

    # A steady fan or a fridge must not be mistaken for a person.
    noisy = jv_audio.VoiceGate(threshold=0.012, block_ms=30, silence_ms=450)
    noisy_states = [noisy.push(0.006 + (0.002 if i % 3 == 0 else 0.0)) for i in range(120)]
    check("a noisy room does not start a turn", "start" not in noisy_states,
          f"floor={noisy.noise_floor:.4f} threshold={noisy.threshold:.4f}")
    check("the threshold follows the room", noisy.threshold > 0.012,
          f"{noisy.threshold:.4f}")

    # A short cough is not a turn either: the minimum speech length applies.
    cough = jv_audio.VoiceGate(threshold=0.012, block_ms=30, silence_ms=450, min_speech_ms=250)
    out = [cough.push(0.05)] + [cough.push(0.001) for _ in range(30)]
    check("a cough does not end as a turn", "end" not in out, str(out[:5]))

    # Trimming what Whisper does not need: a quiet edge around the words.
    tone = b"".join(int(0.2 * 32767 * (1 if i % 2 else -1)).to_bytes(2, "little", signed=True)
                    for i in range(1600))
    silence = b"\x00\x00" * 4800
    trimmed = jv_audio.trim_silence(silence + tone + silence)
    check("the silence around an utterance is trimmed", len(trimmed) < len(silence + tone + silence),
          f"{len(trimmed)} of {len(silence + tone + silence)}")
    check("the words survive the trim", len(trimmed) >= len(tone), str(len(trimmed)))


_gate_checks()


# ------------------------------------------------------------ the voice queue

def _queue_checks() -> None:
    """A reply that streams in is spoken in order, never on top of itself."""
    events: list[tuple[str, str]] = []

    def fake_synth(text: str, backend=None, use_cache=True, fish=None):
        events.append(("synth", text))
        time.sleep(0.05)
        out = Path(f"/tmp/opencode/jv-q-{text[:20].replace(' ', '_')}.wav")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"RIFF" + b"\0" * 64)
        return {"path": str(out), "backend": backend or "fish", "cached": False, "ms": 50}

    def fake_play(path, timeout=120):
        events.append(("play", Path(path).stem))
        return {"backend": "fake", "ok": True}

    real_synth = jv_tts.synthesize
    real_play = jv_tts.audio.play_wav
    jv_tts.synthesize = fake_synth
    jv_tts.audio.play_wav = fake_play
    try:
        fish = {"apiKey": "k", "voiceId": "v"}
        events.clear()
        jv_tts.speak("alpha sentence", backend="fish", append=True, fish=fish)
        jv_tts.speak("beta sentence", backend="fish", append=True, fish=fish)
        time.sleep(0.8)
        played = [e[1] for e in events if e[0] == "play"]
        check("a streamed answer is read in order",
              played == ["jv-q-alpha_sentence", "jv-q-beta_sentence"], str(played))

        # A queued sentence must not cut the voice that is already talking.
        def slow_play(path, timeout=120):
            events.append(("play", Path(path).stem))
            time.sleep(0.25)
            return {"backend": "fake", "ok": True}

        jv_tts.audio.play_wav = slow_play
        events.clear()
        jv_tts.speak("manual reply", backend="fish", wait=False, fish=fish)
        time.sleep(0.12)
        jv_tts.speak("queued tail", backend="fish", append=True, fish=fish)
        time.sleep(1.0)
        played = [e[1] for e in events if e[0] == "play"]
        check("a queued sentence waits for the voice that is playing",
              played == ["jv-q-manual_reply", "jv-q-queued_tail"], str(played))
        jv_tts.audio.play_wav = fake_play

        # The queue is inclusive: `speaking()` stays true between the parts,
        # so the live loop does not open the microphone over its own voice.
        events.clear()
        jv_tts.speak("one part", backend="fish", append=True, fish=fish)
        active = jv_tts.speaking()
        time.sleep(0.4)
        check("a queued utterance counts as speaking", active is True and jv_tts.speaking() is False,
              f"before={active} after={jv_tts.speaking()}")

        # A new, explicit utterance takes the speaker: the waiting reply is
        # dropped instead of being read after the new one.
        events.clear()
        for i in range(5):
            jv_tts.speak(f"waiting part {i}", backend="fish", append=True, fish=fish)
        jv_tts.speak("fresh answer", backend="fish", fish=fish)
        time.sleep(1.2)
        played = [e[1] for e in events if e[0] == "play"]
        check("a new utterance drops the queued reply",
              played == ["jv-q-fresh_answer"], str(played))
        check("the queue is empty after a normal utterance", jv_tts.queue_size() == 0,
              str(jv_tts.queue_size()))
    finally:
        jv_tts.synthesize = real_synth
        jv_tts.audio.play_wav = real_play
        jv_tts.clear_speech_queue()


_queue_checks()

if FAILURES:
    print(f"\n{len(FAILURES)} check(s) failed")
    raise SystemExit(1)
print("\nAll daemon checks passed.")
