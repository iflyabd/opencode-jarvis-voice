"""Daemon-side checks for the push-to-talk turn and the microphone choice.

Run with:  npm run test:daemon      (or: .venv/bin/python daemon/test_turns.py)

No audio and no network: the capture and the transcription are stubbed.
"""

from __future__ import annotations

import os
import sys
import threading
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


# --------------------------------------------------------- client liveness

check("a live process is alive", jv_server._pid_alive(os.getpid()))
check("a missing process is gone", not jv_server._pid_alive(999999))
check("the client pid is read", jv_server._client_pid({"client_pid": 424242}) == 424242)
check("a camelCase client pid is read", jv_server._client_pid({"clientPid": 424242}) == 424242)
check("a missing client pid is ignored", jv_server._client_pid({}) == 0)
check("the daemon never watches itself", jv_server._client_pid({"client_pid": os.getpid()}) == 0)


def _client_stop_check() -> None:
    calls: list[str] = []
    real_tts_stop = jv_server.tts.stop_speaking
    real_audio_stop = jv_server.audio.stop_playback
    jv_server.tts.stop_speaking = lambda: calls.append("tts")
    jv_server.audio.stop_playback = lambda: calls.append("audio")
    jv_server._state["speech"] = {"text": "hi", "backend": "fish",
                                  "started_at": time.time(), "client_pid": os.getpid()}
    try:
        jv_server._stop_for_client(os.getpid())
        check("a dead client stops the voice and the microphone",
              calls == ["tts", "audio"] and not jv_server._state["speech"].get("client_pid"),
              f"calls={calls} speech={jv_server._state['speech']}")
    finally:
        jv_server.tts.stop_speaking = real_tts_stop
        jv_server.audio.stop_playback = real_audio_stop
        jv_server._state["speech"] = {"text": "", "backend": None,
                                      "started_at": 0.0, "client_pid": 0}


_client_stop_check()


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

    # This fake has no continuous player: the reader must fall back to the
    # per-clip path, which is what these checks observe.
    def stream_backend(self):
        return None

    def open_pcm_stream(self, sample_rate=44100):
        raise jv_audio.AudioError("fake audio has no stream")

    def decode_pcm(self, path, sample_rate=44100):
        raise jv_audio.AudioError("fake audio has no decoder")


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
    real_stream = jv_tts.audio.stream_backend
    jv_tts.synthesize = fake_synth
    jv_tts.audio.play_wav = fake_play
    # These checks cover the per-clip fallback; the continuous path has its
    # own check below.
    jv_tts.audio.stream_backend = lambda: None
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
        jv_tts.audio.stream_backend = real_stream


_pipeline_checks()


# --------------------------------------------------------- continuous reader

def _stream_checks() -> None:
    """A whole reply must go through one player, not one player per chunk."""
    class FakeStream:
        sample_rate = jv_audio.STREAM_RATE

        def __init__(self) -> None:
            self.writes: list[bytes] = []
            self.closed = 0
            self.terminated = 0

        def write(self, pcm: bytes) -> None:
            self.writes.append(pcm)

        def close(self, wait: bool = True) -> int:
            self.closed += 1
            return 0

        def terminate(self) -> None:
            self.terminated += 1

    stream = FakeStream()
    renders: list[str] = []
    real = (jv_tts.audio.stream_backend, jv_tts.audio.open_pcm_stream,
            jv_tts.audio.decode_pcm, jv_tts.audio.play_wav, jv_tts.synthesize)

    def fake_synth(text: str, backend=None, use_cache=True, fish=None):
        renders.append(text)
        out = Path(f"/tmp/opencode/jv-stream-{len(renders)}.wav")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"RIFF")                 # decode is stubbed below
        return {"path": str(out), "backend": backend or "fish", "cached": False, "ms": 1}

    def fake_decode(path, sample_rate=44100):
        return b"\x00\x00" * (sample_rate // 10)  # 0.1 s of silence

    def no_per_clip(*_a, **_k):
        raise AssertionError("the reader fell back to one player per chunk")

    jv_tts.audio.stream_backend = lambda: "ffplay"
    jv_tts.audio.open_pcm_stream = lambda sample_rate=44100: stream
    jv_tts.audio.decode_pcm = fake_decode
    jv_tts.audio.play_wav = no_per_clip
    jv_tts.synthesize = fake_synth
    try:
        text = "First sentence. " + " ".join(
            f"Sentence number {i} is here." for i in range(20))
        expected = jv_tts._split_for_speech(text, first_chars=jv_tts.cfg.FISH_FIRST_CHUNK_CHARS)
        jv_tts.speak(text, backend="fish", wait=True, fish={"apiKey": "k", "voiceId": "v"})
        check("a whole reply opens one continuous player",
              stream.closed == 1 and stream.terminated == 0,
              f"closed={stream.closed} terminated={stream.terminated}")
        check("every rendered chunk is written to that stream",
              len(stream.writes) == len(renders) == len(expected) and len(renders) >= 3,
              f"writes={len(stream.writes)} renders={len(renders)} chunks={len(expected)}")
        check("the continuous stream keeps the reply in order",
              renders == expected, str(renders)[:160])
    finally:
        (jv_tts.audio.stream_backend, jv_tts.audio.open_pcm_stream,
         jv_tts.audio.decode_pcm, jv_tts.audio.play_wav, jv_tts.synthesize) = real


_stream_checks()


def _partial_write_checks() -> None:
    """A pipe may accept fewer bytes than it was given; never drop the rest."""
    class PartialPipe:
        def __init__(self) -> None:
            self.data = bytearray()
            self.calls = 0

        def write(self, data) -> int:
            self.calls += 1
            chunk = bytes(data)[:3]
            self.data.extend(chunk)
            return len(chunk)

        def flush(self) -> None:
            pass

    class Proc:
        def __init__(self) -> None:
            self.stdin = PartialPipe()

        def poll(self):
            return None

    stream = object.__new__(jv_audio.PcmStream)
    stream._proc = Proc()
    stream._closed = False
    stream._bytes = 0
    stream._err = []
    stream.write(b"abcdefgh")
    check("a partial pipe write is completed",
          bytes(stream._proc.stdin.data) == b"abcdefgh" and stream._proc.stdin.calls == 3,
          f"data={bytes(stream._proc.stdin.data)!r} calls={stream._proc.stdin.calls}")
    check("a partial pipe write counts every byte", stream._bytes == 8, str(stream._bytes))


_partial_write_checks()


# ---------------------------------------------------------- the chosen device

def _device_checks() -> None:
    """A chosen microphone is never replaced by some other one."""
    tried: list[tuple[str, str]] = []

    def fake_spawn(name, sr, device=None):
        tried.append((name, device or ""))
        raise jv_audio.AudioError(f"{name}: nope")

    real_spawn = jv_audio.spawn_capture
    jv_audio.spawn_capture = fake_spawn
    try:
        try:
            jv_audio.open_capture(device="index:99")
        except Exception:
            pass
        names = [n for n, _ in tried]
        check("a chosen device never falls back to another backend",
              names and all(n in ("sounddevice", "arecord", "ffmpeg") for n in names),
              str(tried))
        check("a chosen device never opens the pulse default by accident",
              "pulse-sles" not in names and "pulse" not in names, str(tried))
        check("sox never touches a chosen device",
              "sox" not in names, str(tried))
        check("a chosen device is handed to the backend",
              jv_audio.backend_command("sounddevice", 16000, "index:99")[-1] == "99",
              str(jv_audio.backend_command("sounddevice", 16000, "index:99")[-3:]))
        sox_cmd = jv_audio.backend_command("sox", 16000, "alsa:hw:1,0")
        check("sox gets a real input device, not the default one",
              "alsa" in sox_cmd and "hw:1,0" in sox_cmd and "-d" not in sox_cmd, str(sox_cmd))
        legacy_cmd = jv_audio.backend_command("sox", 16000, "hw:1,0")
        check("a legacy ALSA id reaches sox as ALSA too",
              "alsa" in legacy_cmd and "hw:1,0" in legacy_cmd, str(legacy_cmd))
        check("sox is never offered a named/index device",
              jv_audio._backend_uses_device("sox", "name:USB Audio") is False
              and jv_audio._backend_uses_device("sox", "index:4") is False)

        tried.clear()
        try:
            jv_audio.open_capture(device="pulse:jarvis_mic")
        except Exception:
            pass
        names = [n for n, _ in tried]
        check("a pulse source only tries the pulse backends",
              names == ["pulse-sles", "pulse"], str(tried))
        pcmd = jv_audio.backend_command("pulse", 16000, "pulse:jarvis_mic")
        check("a pulse source reaches the player as its name",
              any("jarvis_mic" in str(part) for part in pcmd), str(pcmd))
    finally:
        jv_audio.spawn_capture = real_spawn


_device_checks()


# --------------------------------------------------------------- live captions

def _live_caption_checks() -> None:
    """A live turn captions the words while it is still listening."""
    final_options: list = []

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

    def fake_caption(pcm, sr, options=None):
        return {"text": "a partial caption", "backend": "faster-whisper",
                "language": "en", "probability": 0.92, "caption_model": "tiny"}

    def fake_transcribe(pcm, sr, backend=None, options=None):
        final_options.append(options)
        return {"text": "a partial caption", "backend": "faster-whisper"}

    real_record = jv_server.record_utterance
    real_transcribe = jv_server.stt.transcribe
    real_caption = jv_server.stt.transcribe_caption
    jv_server.record_utterance = fake_record
    jv_server.stt.transcribe = fake_transcribe
    jv_server.stt.transcribe_caption = fake_caption
    try:
        sess = jv_server.PttSession(max_ms=1000, silence_ms=450, partial=True)
        time.sleep(1.3)
        snap = sess.snapshot()
        check("a live turn captions the words while it listens",
              snap.get("partial") == "a partial caption", f"partial={snap.get('partial')!r}")
        check("a live turn reports the input level", snap.get("speaking") is True and snap.get("level") == 0.2,
              f"speaking={snap.get('speaking')} level={snap.get('level')}")
        check("the caption uses the small caption model",
              snap.get("caption_model") == "tiny", str(snap.get("caption_model")))
        check("the caption reports how long it took",
              isinstance(snap.get("partial_ms"), int) and snap.get("partial_ms") >= 0,
              str(snap.get("partial_ms")))
        out = sess.stop_and_wait(10)
        check("the final transcript replaces the caption",
              (out.get("result") or {}).get("text") == "a partial caption",
              str(out.get("result"))[:120])
        opts = final_options[-1] or {}
        check("the final decode reuses the language the caption heard",
              (opts.get("local") or {}).get("language") == "en", str(opts))

        plain = jv_server.PttSession(max_ms=1000, silence_ms=450)
        time.sleep(0.15)
        plain.stop_and_wait(10)
        check("a normal turn does not pay for a caption", "partial" not in plain.snapshot(),
              str(plain.snapshot()))
    finally:
        jv_server.record_utterance = real_record
        jv_server.stt.transcribe = real_transcribe
        jv_server.stt.transcribe_caption = real_caption


_live_caption_checks()


# ------------------------------------------------------- fast local transcription

def _stt_speed_checks() -> None:
    """The local decoder is set up to be fast: tiny detects, big decodes fixed."""
    import jv_stt as stt

    pcm24 = b"\x00\x01" * 24000
    out = stt._norm(pcm24, 24000)
    seconds = len(out) / 2 / 16000
    check("audio is resampled to 16 kHz on Python 3.13", abs(seconds - 1.0) < 0.02,
          f"{seconds:.3f}s")

    real_cached = stt._cached_model
    try:
        stt._cached_model = lambda name: "/tmp/model" if name in ("tiny", "small") else None
        check("live captions prefer the tiny model",
              stt._caption_model_name("small") == "tiny", stt._caption_model_name("small"))
    finally:
        stt._cached_model = real_cached

    loud = b"\x00\x10" * 16000
    # The final decode runs on another thread; hold the model there while the
    # caption thread asks for it.
    held, release = threading.Event(), threading.Event()

    def hold_model():
        stt._infer_lock.acquire()
        held.set()
        release.wait(5)
        stt._infer_lock.release()

    holder = threading.Thread(target=hold_model, daemon=True)
    holder.start()
    held.wait(2)
    try:
        skipped = stt.transcribe_caption(loud, 16000, {})
    finally:
        release.set()
        holder.join(2)
    check("a caption is skipped while the final decode owns the model",
          skipped.get("skipped") is True, str(skipped))

    captured: dict = {}

    class _Info:
        language = "ar"
        language_probability = 0.9
        duration = 1.0

    class _Model:
        def transcribe(self, audio, **kw):
            captured["language"] = kw.get("language")
            return [], _Info()

    real_get = stt._get_faster_whisper_model
    real_detect = stt.detect_language
    stt._get_faster_whisper_model = lambda model=None: (_Model(), "/tmp/model", model or "tiny")
    stt.detect_language = lambda pcm, sr=16000, model=None, fallback=None: ("ar", 0.9)
    try:
        res = stt.transcribe_faster_whisper(loud, 16000, model="small")
    finally:
        stt._get_faster_whisper_model = real_get
        stt.detect_language = real_detect
    check("tiny detects the language before the big model decodes",
          captured.get("language") == "ar", str(captured))
    check("the final decode knows where the language came from",
          res.get("language_source") == "tiny", str(res.get("language_source")))

    check("both the caption and final models stay loaded",
          stt._LOADED_MAX >= 2, str(stt._LOADED_MAX))


_stt_speed_checks()


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
        time.sleep(0.9)
        spoken = [text for kind, text in events if kind == "synth"]
        played = [e[1] for e in events if e[0] == "play"]
        check("a streamed answer is read in order",
              len(spoken) == 1 and spoken[0].find("alpha") < spoken[0].find("beta"),
              str(spoken))
        check("sentences that arrive together share one player", len(played) == 1, str(played))

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
        jv_tts.audio.play_wav = slow_play
        jv_tts.speak("one part", backend="fish", append=True, fish=fish)
        active = jv_tts.speaking()
        time.sleep(0.9)
        check("a queued utterance counts as speaking", active is True and jv_tts.speaking() is False,
              f"before={active} after={jv_tts.speaking()}")
        jv_tts.audio.play_wav = fake_play

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


# --------------------------------------------------------------- the reader

def _reader_checks() -> None:
    """The reader must cut a clip once, never restart it, and never go mute."""
    import struct
    import wave

    # These checks are about the per-clip fallback; the continuous stream has
    # its own check above. Keeping them on the fallback also keeps the tests
    # from touching the sound card.
    real_stream_backend = jv_tts.audio.stream_backend
    jv_tts.audio.stream_backend = lambda: None

    clip = Path("/tmp/opencode/jv-reader-check.wav")
    clip.parent.mkdir(parents=True, exist_ok=True)
    clip.write_bytes(b"RIFF" + b"\0" * 64)

    real_block = jv_audio._blocking_play
    real_last = jv_audio._playback_state.get("last_ok")
    real_hint = jv_audio._PLAYBACK_HINT
    hint = Path("/tmp/opencode/jv-playback-hint")
    try:
        hint.unlink()
    except OSError:
        pass
    jv_audio._PLAYBACK_HINT = hint
    calls: list[str] = []
    try:
        # 1. A player that dies after it started must not be followed by
        #    another player replaying the same clip from the beginning.
        jv_audio._playback_state["last_ok"] = None
        candidates = jv_audio._playback_candidates()
        check("the device has at least two playback candidates", len(candidates) >= 2, str(candidates))

        def late_failure(cmd, timeout):
            calls.append(cmd[0].rsplit("/", 1)[-1])
            time.sleep(0.45)
            raise jv_audio.AudioError("stream died after starting")

        jv_audio._blocking_play = late_failure
        raised = False
        try:
            jv_audio.play_wav(clip)
        except jv_audio.AudioError as e:
            raised = "after audio started" in str(e)
        check("a clip that already played is not replayed on another backend",
              raised and len(calls) == 1, f"raised={raised} calls={calls}")

        # 2. A player that fails before any sound is safe to replace.
        calls.clear()

        def early_failure(cmd, timeout):
            calls.append(cmd[0].rsplit("/", 1)[-1])
            if len(calls) == 1:
                raise jv_audio.AudioError("sink refused")
            return None

        jv_audio._blocking_play = early_failure
        jv_audio._playback_state["last_ok"] = None
        got = jv_audio.play_wav(clip)
        check("a player that fails before any sound falls through",
              got.get("backend") == candidates[1] and len(calls) == 2,
              f"{got} candidates={candidates} calls={calls}")

        # 3. The player that worked last time goes first next time.
        jv_audio._blocking_play = lambda cmd, timeout: None
        got = jv_audio.play_wav(clip)
        check("the last working player is tried first",
              got.get("backend") == candidates[1],
              f"{got} candidates={candidates}")
    finally:
        jv_audio._blocking_play = real_block
        jv_audio._playback_state["last_ok"] = real_last
        jv_audio._PLAYBACK_HINT = real_hint
        try:
            clip.unlink()
            hint.unlink()
        except OSError:
            pass

    # A reply that opens with one very long sentence must still get a short
    # first chunk: the cap has to split that sentence, not accept a full-size
    # unit just because it is the first one.
    long_first = ("word " * 60).strip() + "."
    parts = jv_tts._split_for_speech(long_first)
    check("a long first sentence still gets a short first chunk",
          len(parts[0]) <= jv_tts.cfg.FISH_FIRST_CHUNK_CHARS
          and " ".join(parts) == long_first,
          f"first={len(parts[0])} chunks={len(parts)}")

    # 4. A transient Fish failure is retried, and every chunk still plays.
    real_synth = jv_tts.synthesize
    real_play = jv_tts.audio.play_wav
    real_pick = jv_tts.pick_backend
    real_limit = jv_tts.cfg.FISH_CHUNK_CHARS
    jv_tts.cfg.FISH_CHUNK_CHARS = 16
    events: list[tuple[str, str]] = []
    attempts: dict[str, int] = {}
    path_text: dict[str, str] = {}

    def flaky_synth(text: str, backend=None, use_cache=True, fish=None):
        attempts[text] = attempts.get(text, 0) + 1
        if "fails" in text and attempts[text] <= 2:
            raise jv_tts.TtsError("Fish Audio HTTP 503")
        out = Path(f"/tmp/opencode/jv-reader-{len(path_text)}.wav")
        out.write_bytes(b"RIFF" + b"\0" * 64)
        path_text[str(out)] = text
        return {"path": str(out), "backend": backend or "fish", "cached": False, "ms": 1}

    def fake_play(path, timeout=120):
        events.append(("play", path_text.get(str(path), Path(path).stem)))
        return {"backend": "fake", "ok": True}

    jv_tts.synthesize = flaky_synth
    jv_tts.audio.play_wav = fake_play
    try:
        sentence = ("alpha beta gamma delta " * 8).strip() + " omega."
        split = jv_tts._split_for_speech("Short first. " + sentence + " Final.", max_chars=20)
        check("a long sentence never jumps ahead of the sentence before it",
              split[0] == "Short first."
              and " ".join(split) == "Short first. " + sentence + " Final.",
              str(split)[:160])

        text = "First part. It fails now. Last part."
        jv_tts.speak(text, backend="fish", wait=True, fish={"apiKey": "k", "voiceId": "v"})
        played = [value for kind, value in events if kind == "play"]
        check("a failed chunk is retried and the reply still finishes",
              attempts.get("It fails now.") == 3
              and played == ["First part.", "It fails now.", "Last part."],
              f"attempts={attempts} played={played}")

        # 5. When Fish stays down the local voice takes over instead of
        #    leaving the rest of the answer unread.
        events.clear()
        attempts.clear()
        path_text.clear()
        used: list[str | None] = []

        def fish_down_synth(text: str, backend=None, use_cache=True, fish=None):
            used.append(backend)
            if backend == "fish":
                raise jv_tts.TtsError("Fish Audio HTTP 503")
            out = Path(f"/tmp/opencode/jv-local-{len(path_text)}.wav")
            out.write_bytes(b"RIFF" + b"\0" * 64)
            path_text[str(out)] = text
            return {"path": str(out), "backend": backend, "cached": False, "ms": 1}

        jv_tts.synthesize = fish_down_synth
        jv_tts.pick_backend = lambda: "piper"
        jv_tts.speak("One part. Two part. Three part.", backend="fish", wait=True,
                     fish={"apiKey": "k", "voiceId": "v"})
        played = [value for kind, value in events if kind == "play"]
        check("Fish going down mid-reply continues with the local voice",
              "fish" in used and "piper" in used
              and played == ["One part.", "Two part.", "Three part."],
              f"used={used} played={played}")

        # 6. An interrupt invalidates the reader: the next paragraph must not
        #    start over the newly requested read.
        events.clear()
        attempts.clear()
        path_text.clear()
        jv_tts.synthesize = flaky_synth
        jv_tts.cfg.FISH_CHUNK_CHARS = 8
        total = 8

        def slow_play(path, timeout=120):
            events.append(("play", path_text.get(str(path), Path(path).stem)))
            time.sleep(0.35)
            return {"backend": "fake", "ok": True}

        jv_tts.audio.play_wav = slow_play
        long_text = " ".join(f"Part {i}." for i in range(total))
        jv_tts.speak(long_text, backend="fish", wait=False, fish={"apiKey": "k", "voiceId": "v"})
        time.sleep(0.1)
        dropped = jv_tts.stop_speaking()
        time.sleep(1.0)
        played = [value for kind, value in events if kind == "play"]
        check("an interrupt stops a chunked reply and clears what waits",
              len(played) <= 1 and jv_tts.speaking() is False,
              f"played={played} dropped={dropped} speaking={jv_tts.speaking()}")
        jv_tts.cfg.FISH_CHUNK_CHARS = 16
    finally:
        jv_tts.synthesize = real_synth
        jv_tts.audio.play_wav = real_play
        jv_tts.pick_backend = real_pick
        jv_tts.cfg.FISH_CHUNK_CHARS = real_limit
        jv_tts.clear_speech_queue()

    # 7. Trimming happens once, when the clip is created - never while a
    #    cached file might be playing.
    real_synth = jv_tts.synthesize

    def silent_tail(text: str, out: Path):
        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(struct.pack("<h", 8000) * 4000)  # 0.25 s of tone
            w.writeframes(struct.pack("<h", 0) * 4000)     # 0.25 s of silence
        return {"path": str(out), "backend": "trimtest"}

    jv_tts._SYNTH["trimtest"] = silent_tail
    try:
        text = f"trim check {time.time_ns()}"
        info = jv_tts.synthesize(text, backend="trimtest")
        with wave.open(info["path"], "rb") as w:
            seconds = w.getnframes() / w.getframerate()
        check("a rendered clip is trimmed before it is cached",
              0.25 <= seconds < 0.4, f"{seconds:.3f}s")
        size = Path(info["path"]).stat().st_size
        again = jv_tts.synthesize(text, backend="trimtest")
        check("a cached clip is returned unchanged",
              again.get("cached") is True
              and Path(info["path"]).stat().st_size == size,
              f"cached={again.get('cached')} size={size}")
        try:
            Path(info["path"]).unlink()
        except OSError:
            pass
    finally:
        jv_tts._SYNTH.pop("trimtest", None)
        jv_tts.synthesize = real_synth
        jv_tts.audio.stream_backend = real_stream_backend


_reader_checks()

if FAILURES:
    print(f"\n{len(FAILURES)} check(s) failed")
    raise SystemExit(1)
print("\nAll daemon checks passed.")
