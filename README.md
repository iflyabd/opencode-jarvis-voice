# Jarvis Voice

**Local voice chat for OpenCode.** Speak to it, it answers out loud — a Piper
voice in your ear, Whisper ears on your machine. No cloud, no API keys, nothing
leaves the device.

Press one key, talk, pause, and your words land in the prompt. The reply is
spoken back in a JARVIS-style voice while it types.

Mouse controls do the same: a **🎙 mic** at the bottom-right of the prompt box,
and a **🔊 read / ⏸ pause / ▶ resume** control under every answer (plus one
above the text box for the newest reply), all drawn with your OpenCode theme.

It is built to keep a phone cold: the daemon starts **only when you use voice**,
warms the model **while you speak** (never at boot), and **exits when idle**, so
idle CPU is zero and its memory goes back to the system.

Works the same on **Parrot OS**, **Termux / Android**, and a **normal PC**
(Linux, macOS, Windows).

---

## How it works

```
   microphone
        │
        ▼
  ┌─────────────────────────────┐         ┌──────────────────────────────┐
  │  daemon (Python)            │  HTTP   │  OpenCode plugin (TypeScript) │
  │  · audio backends           │◄───────►│  · voice_listen  (tool)       │
  │  · voice-activity detection │127.0.0.1│  · voice_speak   (tool)       │
  │  · Whisper  → text          │ :8765   │  · voice_status  (tool)       │
  │  · Piper    → speech        │         │  · push-to-talk keybind       │
  └─────────────────────────────┘         └──────────────────────────────┘
        │
        ▼
   speakers
```

The daemon owns all the native audio work, which is why the same plugin works
everywhere. Each capture backend runs in its **own child process**, so a wedged
ALSA node or a native crash can never take the assistant down — and every read
has a hard timeout, so a dead device reports an error instead of hanging.

---

## Install

```bash
git clone https://github.com/iflyabd/opencode-jarvis-voice
cd opencode-jarvis-voice
./install.sh
```

The installer sets up the Python environment, offers a JARVIS-style Piper voice
(~60 MB, one time), registers the plugin in `~/.config/opencode/cli.json`, and
finishes with `voice doctor`. Restart OpenCode afterwards.

Flags: `--with-voice NAME`, `--no-voice`, `--no-register`, `--no-daemon`.

<details>
<summary>Manual install (the same steps by hand)</summary>

```bash
./bin/voice install            # Python environment (numpy, sounddevice, faster-whisper, piper)
./bin/voice voice fetch jarvis-medium        # the JARVIS voice (~64 MB, one time, default)
./bin/voice doctor             # check everything, with fixes for whatever is broken
./bin/voice up                 # start the daemon
```

Then add this folder to `~/.config/opencode/cli.json` yourself:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-jarvis-voice"]
}
```

and restart OpenCode.

`voice install` reuses an existing virtualenv when one already has the
dependencies, so nothing is downloaded twice.

</details>

### Install as an OpenCode package

If OpenCode manages your plugins already, the same repository installs through
it (the Python environment still comes from the clone above — otherwise there is
no daemon to talk to):

```bash
opencode plugin add github:iflyabd/opencode-jarvis-voice
```

<details>
<summary>Running the daemon natively in Termux</summary>

Two ways to run on Android:

1. **Daemon in Parrot (or any Linux), audio from Termux** — what this install
   already does. Termux only has to provide the PulseAudio bridge
   (`bin/termux-pulse`), and the daemon on the Parrot side uses the
   `pulse` backend. Everything else (Whisper, Piper) runs in Parrot.

2. **Daemon natively in Termux** — needs its own dependencies:

   ```bash
   pkg install python-numpy portaudio termux-api
   cd /path/to/jarvis-voice && ./bin/voice install
   ./bin/voice up && ./bin/voice doctor
   ```

   `faster-whisper` pulls in CTranslate2, which has no Termux wheels and may
   fail to build. If it does, install a lighter STT instead and point the daemon
   at it:

   ```bash
   pip install vosk
   export JARVIS_VOICE_STT=vosk
   export JARVIS_VOICE_VOSK_MODEL=~/vosk-model-small-en-us
   ```

   or build whisper.cpp and set `JARVIS_VOICE_WHISPERCPP_MODEL`. `voice doctor`
   reports which backends are actually usable.

</details>

### Use your own Piper voice

`jarvis-medium` (the JARVIS voice) is the default: the installer offers it, and
`voice fetch jarvis-medium` gets it whenever you want it. Any other `.onnx`
plus `.onnx.json` pair works too, wherever it lives:

```bash
./bin/voice voice fetch jarvis-medium           # the JARVIS voice (~64 MB)
./bin/voice voice fetch en_GB-alan-medium       # a lighter British alternative
./bin/voice voice use /path/to/jarvis.onnx      # remember any local voice
./bin/voice voice list                          # see what was found, * = selected
./bin/voice voice where                         # every location that gets scanned
```

A voice named `jarvis-medium` (then `jarvis`) is preferred automatically; after
that the preference order is `en_GB-alan`, `northern_english_male`, `ryan`,
`alba`. You can also point at one directly:

```bash
export JARVIS_VOICE_PIPER_VOICE=/path/to/jarvis.onnx
```

Or list several search folders: `JARVIS_VOICE_VOICE_DIRS=/sdcard/piper:~/voices`

---

## Using it

### Push-to-talk (the live-chat feel)

| | |
|---|---|
| `ctrl+alt+v` | start listening; press again to send immediately |
| `ctrl+alt+p` | read the last answer / pause / resume |
| `/voice` | same thing from the prompt |
| `/voice <text>` | say that text out loud |

Once you start talking, silence ends the turn on its own — no second press
needed. Watch for:

```
🎙 Listening... speak now (press again to send)
📝 refactor the parser and run the tests
```

The transcript is sent as your message, and the answer is spoken back while it
appears on screen. Turn that off with **Voice: toggle speaking replies** in the
command palette (`ctrl+p`).

Suggested chase-cam bindings in `~/.config/opencode/cli.json`:

```jsonc
{
  "keybinds": {
    "voice.pushToTalk": "ctrl+alt+v",
    "voice.cancel": "ctrl+alt+x"
  }
}
```

### On-screen buttons

| Button | Where | Click |
|---|---|---|
| `🎙 mic` / `● listening` / `◌ transcribing` | bottom-right of the prompt box | start listening; click again to stop and send |
| `🔊 read` / `⏸ pause` / `▶ resume` | directly under each assistant answer | read **that answer**; click again to pause it, again to resume |
| `🔊 read` / `⏸ pause` / `▶ resume` | top-right of the composer | read the newest answer, even when older messages are scrolled away |

All are theme-aware (colours come from the active theme's action and feedback
tokens, with hover states) and drive the same state as the keybindings — a
click and `ctrl+alt+v` flip the same switch. They also update **live**: the
label changes the moment the state does, including changes that happen in the
background (the end of playback, a transcription finishing). Pause is a real
pause: the player process is suspended with `SIGSTOP` and continued with
`SIGCONT`, so nothing is re-synthesized and the voice continues exactly where
it stopped.

The per-answer button sits between the answer text and its `Build · …` line,
and it is tied to that message: click the first answer's button and you hear
the first answer, even if ten newer replies exist. Clicking another answer
stops the current one and moves the pause label with it.

> OpenCode v2.0.32 has no plugin slot for individual messages. The per-answer
> row is attached to the transcript's existing message / text-part renderables
> at runtime, using the host's own node classes. That is an internal API: a
> future TUI rewrite can simply hide the rows, in which case the composer
> button keeps working, or need a small update in
> `plugin/message-buttons.ts`. Nothing leaves the process, and the scan runs
> only on session events — never on a timer.

Reading rules:

* a per-answer button reads only that answer; the composer button reads the
  newest answer;
* `reasoning` parts (the grayed-out thinking text) are never spoken;
* when a turn has several text parts (narration between tool calls, then the
  answer), only the **last** one is read;
* the clip is trimmed to a brief, sentence-capped length (~600 characters),
  with code blocks, tables and markdown symbols stripped first.

### Other commands

| Command | What it does |
|---|---|
| `Voice: push to talk` | record a turn (`ctrl+alt+v`) |
| `Voice: read / pause / resume the reply` | one button for read, pause, resume (`ctrl+alt+p`) |
| `Voice: status` | what mic, STT model, TTS voice are in use |
| `Voice: cancel listening / stop speaking` | shut it up immediately |
| `Voice: speak the last reply` | read the current answer out loud |
| `Voice: toggle speaking replies` | auto-speak the assistant on/off |

### Let the agent use voice itself

Three tools are registered, so you can just ask in words:

| Tool | Purpose |
|---|---|
| `voice_listen` | capture one utterance and return the text |
| `voice_speak` | say something out loud in the local voice |
| `voice_status` | report the pipeline, with fixes if something is broken |

> "listen to me for a second and write down what I say"
> "say 'build finished' out loud"
> "is the microphone working?"

---

## Android / Termux: making the microphone work

**This is the one part that needs a Termux-side step.** On Android the mic
belongs to AudioFlinger, and a Linux chroot next to Termux (this repo's
reference setup runs Parrot OS that way) uses `PULSE_SERVER=tcp:127.0.0.1` —
so the Linux side expects a PulseAudio server on the Termux side. Until it is
running, `voice doctor` correctly reports *no capture backend* and nothing can
record.

**Run this inside Termux** (not inside Parrot):

```bash
pkg install pulseaudio        # once
sh /root/jarvis-voice/bin/termux-pulse
```

That starts PulseAudio, bridges it to Android's audio hardware, and opens the
TCP port so Parrot can record and play. It prints the sources it found and
whether the default one is a real microphone.

Keep it alive across reboots with Termux:Boot — create
`~/.termux/boot/jarvis-voice.sh`:

```sh
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sh /path/to/jarvis-voice/bin/termux-pulse
```

Then, from Parrot: `./bin/voice doctor` should show a microphone backend.

<details>
<summary>How the audio backends are chosen</summary>

Tried in order; the first one that actually delivers samples wins, then the
choice is cached in `~/.cache/jarvis-voice/backend.json`.

| Backend | Where it applies |
|---|---|
| `pulse` | Parrot chroot, Termux, any PulseAudio/PipeWire desktop |
| `termux` | Android via Termux:API (`pkg install termux-api`) |
| `sounddevice` | Windows, macOS, Linux, Termux with `pkg install portaudio` |
| `arecord` | plain Linux (ALSA) |
| `sox` | anywhere sox is installed |
| `ffmpeg` | last resort; knows pulse, alsa, dshow, avfoundation |

Force one with `JARVIS_VOICE_CAPTURE_BACKEND=pulse`, or re-probe with
`./bin/voice audio probe`. Playback uses the same philosophy
(`paplay` → `aplay` → `ffplay` → `play` → `sounddevice` → Android media player).

</details>

---

## Diagnostics

```bash
./bin/voice doctor      # full report: tools, packages, voices, mic, verdict
./bin/voice status      # is it running, and what is it using
./bin/voice logs        # follow the daemon log
./bin/voice test        # synthesise, play, probe the mic
./bin/voice listen 5    # record 5 seconds and print the transcript
./bin/voice say "hello" # speak locally
./bin/voice pulse       # is the PulseAudio bridge reachable
```

`doctor` ends with a verdict and the exact command to fix each problem.

---

## Configuration

Everything is an environment variable, read at daemon start:

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_VOICE_PORT` | `8765` | daemon port (auto-increments if taken) |
| `JARVIS_VOICE_PYTHON` | auto-detected | interpreter to run the daemon with |
| `JARVIS_VOICE_INPUT_DEVICE` | auto | device index, name, or pulse source |
| `JARVIS_VOICE_CAPTURE_BACKEND` | auto | force `pulse`, `sounddevice`, `termux`, … |
| `JARVIS_VOICE_WHISPER_MODEL` | `tiny` | `tiny`, `base`, `small`, `medium`, `large-v3` |
| `JARVIS_VOICE_WHISPER_DIR` | — | local model folder, for purely offline use |
| `JARVIS_VOICE_LANGUAGE` | auto | e.g. `en` to skip detection |
| `JARVIS_VOICE_PIPER_VOICE` | auto | explicit `.onnx` path or voice name |
| `JARVIS_VOICE_TTS` | auto | `piper`, `piper-bin`, `espeak`, `none` |
| `JARVIS_VOICE_VAD_THRESHOLD` | `0.012` | raise it in a noisy room |
| `JARVIS_VOICE_VAD_SILENCE_MS` | `900` | silence that ends a turn |
| `JARVIS_VOICE_LENGTH_SCALE` | `1.0` | Piper speed; `1.1` is a touch slower |
| `JARVIS_VOICE_IDLE_EXIT_S` | `300` | exit after this long with nothing to do; `0` stays resident |
| `JARVIS_VOICE_WARMUP` | `lazy` | `lazy` \| `boot` \| `off` — when the STT model is loaded |
| `JARVIS_VOICE_WHISPER_THREADS` | `0` (auto) | cap Whisper's CPU threads; `2` keeps a phone cooler |

The daemon writes `~/.cache/jarvis-voice/daemon.json` (URL + token, mode 600).
Requests are authenticated with that token, so other local processes cannot
drive your microphone.

### Battery & resources

Nothing runs unless you use it:

* **Starts on demand** — when you press push-to-talk, click a button, or the
  agent calls a voice tool. Opening OpenCode does not start it.
* **Cheap boot** — under a second, no model loading. The STT model is warmed
  in the background when push-to-talk starts (a transcription is coming
  anyway), so CPU work happens while you speak, never while it sits idle.
* **Exits when idle** — after `JARVIS_VOICE_IDLE_EXIT_S` seconds (default
  300) with no real activity it stops on its own, returning the loaded
  model's memory to the system. Status polls (`/speech`, `/ptt/state`,
  `/ping`) do not count as activity, so a paused-and-abandoned playback is
  stopped and the daemon leaves too. The next voice action starts it again.
* **No background polling** — the TUI watches speech only while speech is
  actually playing (600 ms; 3 s while paused) and stops the moment it ends.
  A dropped health check is retried a couple of times before the button
  believes the daemon is gone, so a paused playback is never mistaken for
  silence.

Measured on the reference Android/Parrot setup: idle daemon **~56 MB RSS**,
zero wake-ups beyond a 2 s shutdown check; with the `tiny` model loaded
**~210 MB** until the idle exit frees it.

Tuning:

| Situation | Setting |
|---|---|
| Plugged in, want it always resident | `JARVIS_VOICE_IDLE_EXIT_S=0` |
| Very aggressive on battery | `JARVIS_VOICE_IDLE_EXIT_S=60` |
| Phone warms during long dictations | `JARVIS_VOICE_WHISPER_THREADS=2` |
| Want the hot first answer back | `JARVIS_VOICE_WARMUP=boot` |

### Plugin options

The plugin entry in `~/.config/opencode/cli.json` can be an object:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-jarvis-voice",
      "options": { "mic": true, "speak": true, "autoSpeak": true }
    }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `mic` | `true` | show the 🎙 mic button in the prompt footer |
| `speak` | `true` | show the 🔊 read / pause button above the text box |
| `autoSpeak` | `true` | speak replies automatically after push-to-talk starts the turn |

### HTTP API

The daemon is a small JSON API on `127.0.0.1`, authenticated with the bearer
token from `~/.cache/jarvis-voice/daemon.json`:

| Endpoint | Purpose |
|---|---|
| `GET /health` | capability report (`?deep=1` re-probes the mic) |
| `POST /ptt/start` · `POST /ptt/stop` · `POST /ptt/cancel` · `GET /ptt/state` | push-to-talk session |
| `POST /listen` | record one utterance, return the transcript |
| `POST /transcribe` | raw PCM/WAV in, text out |
| `POST /speak` | synthesize + play (`{text, async}`) |
| `POST /synth` | synthesize only, returns `audio/wav` |
| `GET /speech` | what the speakers are doing now (`active`, `paused`, `elapsed_ms`) |
| `POST /pause` · `POST /resume` | suspend / continue the current playback (`SIGSTOP` / `SIGCONT`) |
| `POST /interrupt` | stop capture and playback |
| `POST /probe` · `POST /shutdown` | re-probe the audio, stop the daemon |

### Speech-to-text quality

The default `tiny` model is chosen because it is already cached and runs offline
immediately — it transcribes clean Piper speech perfectly. For noisy rooms or
accents, a larger model is noticeably better:

```bash
export JARVIS_VOICE_WHISPER_MODEL=base    # or small / medium
./bin/voice restart
```

On this arm64 device expect roughly real-time with `tiny`; `base` is about
twice as slow. Piper's `low` voices are also faster than `medium` if you want a
snappier reply.

---

## Layout

```
opencode-jarvis-voice/
├── install.sh                # one-shot installer (Python env, voice, plugin, doctor)
├── package.json              # OpenCode plugin package (also installable via `opencode plugin add`)
├── bin/
│   ├── voice                 # one entry point: up, doctor, install, voice, …
│   └── termux-pulse          # Android audio bridge (run inside Termux)
├── daemon/
│   ├── jv_server.py          # HTTP API + push-to-talk sessions + playback control
│   ├── jv_audio.py           # capture/playback backends, crash-isolated, pause/resume
│   ├── jv_stt.py             # faster-whisper / whisper / whisper.cpp / vosk
│   ├── jv_tts.py             # Piper / piper binary / espeak
│   ├── jv_voices.py          # Piper voice discovery, registry, download
│   └── jv_config.py          # paths, platform detection, tuning
├── plugin/
│   ├── index.ts              # server plugin: voice_listen, voice_speak, voice_status
│   ├── tui.tsx               # TUI plugin: keymap layer + slot buttons
│   ├── ui.tsx                # the mic and read/pause buttons (theme-aware, clickable)
│   ├── controller.ts         # push-to-talk, speech state, answer picking
│   ├── daemon-client.ts      # shared daemon discovery + HTTP
│   └── test/ui.check.ts      # headless button checks (`bun run test:ui`)
└── requirements.txt
```

The only Python dependencies are `numpy` and `sounddevice`; STT and TTS are
optional accelerants that the daemon reports on and degrades without.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `microphone unavailable` | `bash bin/termux-pulse` inside Termux, then `./bin/voice audio probe` |
| `no local TTS backend` | `./bin/voice voice fetch en_GB-alan-medium` |
| espeak voice instead of Piper | no voice found — `./bin/voice voice list` |
| It hears you but the transcript is wrong | bigger model: `JARVIS_VOICE_WHISPER_MODEL=base` |
| It cuts you off too early | `JARVIS_VOICE_VAD_SILENCE_MS=1500` |
| It triggers on background noise | `JARVIS_VOICE_VAD_THRESHOLD=0.02` |
| The key does nothing | restart OpenCode; confirm `voice.pushToTalk` in `ctrl+p` |
| The buttons are missing | restart OpenCode; `opencode plugin list` should show this folder |
| `⏸ pause` does nothing | the daemon is older than the plugin — `./bin/voice restart` |
| It reads the wrong text | it reads only the last answer's final text part; if a turn is still running, wait for it to finish |
| First voice action after a quiet spell takes ~1 s | that is the daemon starting again — normal on battery; `JARVIS_VOICE_IDLE_EXIT_S=0` avoids it |
| Keep it resident for a long session | `JARVIS_VOICE_IDLE_EXIT_S=0 ./bin/voice restart` |
| Nothing at all | `./bin/voice doctor` — it names the broken part and the fix |
