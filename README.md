# Jarvis Voice

**Local voice chat for OpenCode.** Speak to it, it answers out loud — a Piper
voice in your ear, Whisper ears on your machine. Local by default: no cloud,
no API keys, nothing leaves the device unless you explicitly turn on the
optional Fish Audio voice or speech-to-text.

Press one key, talk, pause, and your words land in the prompt. The reply is
spoken back in a JARVIS-style voice while it types.

Mouse controls do the same: a **🎙 mic** at the bottom-right of the prompt box,
and a **🔊 read / ⏸ pause / ▶ resume** control under every answer, plus a
**◉ live** toggle above the text box for a hands-free voice conversation, all
drawn with your OpenCode theme.

It is built to keep a phone cold: the daemon starts **only when you use voice**,
warms the model **while you speak** (never at boot), and **exits when idle**, so
idle CPU is zero and its memory goes back to the system.

Works the same on **Parrot OS**, **Termux / Android**, and a **normal PC**
(Linux, macOS, Windows).

Built for **OpenCode 2.1.2** (the plugin SDK is pinned to
`@opencode/plugin` 2.1.2 and OpenTUI 0.6.6). It also runs on 2.0.x and 2.1.0:
the plugin picks the prompt API shape that the running host expects.

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
  │  · Whisper / Fish ASR → text│ :8765   │  · voice_status  (tool)       │
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
Speech-to-text is local Whisper by default, with optional Fish Audio cloud ASR
selected explicitly in settings. Text-to-speech is local Piper by default, with
optional Fish Audio cloud voices selected explicitly in settings.

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
   (`bin/termux-pulse`), and the daemon on the Parrot side uses the direct
   `pulse-sles` backend (or `pulse` for a real default source). Everything else
   (Whisper, Piper) runs in Parrot.

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
| `ctrl+alt+v` | start listening; press again to stop |
| `ctrl+alt+p` | read the last answer / pause / resume |
| `/voice` | same thing from the prompt |
| `/voice <text>` | say that text out loud |

Once you start talking, silence ends the turn on its own — no second press
needed. Watch for:

```
🎙 Listening... speak now
📝 Added to the prompt — review it and press send
```

The transcript lands in the prompt box so you can correct it before it is
sent; the answer is spoken back while it appears on screen. Turn the spoken
reply off with **Voice: toggle speaking replies** in the command palette
(`ctrl+p`), and the review step off with **Voice: toggle auto-send**.

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
| `🎙 mic` / `● listening` / `◌ transcribing` | bottom-right of the prompt box | start listening; click again to stop |
| `🔊 read` / `⏸ pause` / `▶ resume` | directly under each assistant answer | read **that answer**; click again to pause it, again to resume |
| `◉ live` / `● live` | top-right of the composer | switch the live voice conversation on or off (also shown on the home screen, where a new chat starts) |

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
* long answers are read in full, with code blocks, tables and markdown
  symbols stripped first.

### Live voice conversation

The `◉ live` button at the top-right of the text box switches a hands-free
conversation on. It is shown in a session and on the home screen, where a new
chat starts:

1. The microphone keeps listening. Each turn ends on silence, exactly like a
   push-to-talk turn.
2. What you said is sent to the agent on its own.
3. The answer is read back to you.
4. The microphone listens again - and again, for as long as live mode is on.

Click `● live` (or the mic button, or run **Voice: live voice conversation**
from the palette) to stop and go back to the manual mode: the mic button then
records one turn at a time again, and the transcript lands in the prompt box
for review.

Live mode uses the same microphone and speech-to-text settings as everything
else, and it honours the auto-send and auto-speak switches.

### The transcript goes into the prompt box

Push-to-talk does **not** send anything by default. When the turn ends, the
transcript is typed into the prompt box so you can read it, fix a wrong word
and then press send yourself. Nothing reaches the agent until you do.

That is deliberate: speech-to-text is never perfect, and a wrong transcript
that is sent immediately is a wrong prompt the agent has already answered.

If you want the hands-free flow, turn **auto-send** on:

* **`Voice: toggle auto-send (transcript goes to the prompt box)`** in the
  command palette, or
* **Voice: settings → Auto-send transcripts** in the settings dialog.

With auto-send on, the transcript is typed into the prompt box and the host's
own submit command sends it - exactly what pressing Enter does. That path also
works in a **brand new chat**, where no session id exists yet (a session is
only created when the first message is sent). If the host does not expose a
submit command, the plugin posts the message through the client API instead.
Either way the reply is spoken back (when auto-speak is on). With auto-send
off, the reply is still spoken once you send the transcript.

If the host TUI does not expose an editable prompt box, the transcript is
shown in a toast so it can be copied by hand.

### Other commands

| Command | What it does |
|---|---|
| `Voice: push to talk` | record a turn (`ctrl+alt+v`) |
| `Voice: read / pause / resume the reply` | one button for read, pause, resume (`ctrl+alt+p`) |
| `Voice: settings (Fish Audio / transcription / microphone)` | choose the voice and speech-to-text providers, API key, voice, language; inspect mic/STT |
| `Voice: preload the speech model` | load Whisper now so the next transcript is fast |
| `Voice: status` | what mic, STT model, TTS voice are in use, plus the plugin and daemon versions |
| `Voice: cancel listening / stop speaking` | shut it up immediately |
| `Voice: speak the last reply` | read the current answer out loud |
| `Voice: live voice conversation (listen, send, read back)` | switch the live conversation on or off |
| `Voice: toggle speaking replies` | auto-speak the assistant on/off |
| `Voice: toggle auto-send (transcript goes to the prompt box)` | hands-free mode on/off: send the transcript straight away, or drop it in the prompt box for review |

### Optional Fish Audio voices

Piper stays the default and works offline. If you want a cloned or library
voice, Fish Audio can be selected on demand:

1. Open the command palette (`ctrl+p`) and run
   **`Voice: settings (Fish Audio / transcription / microphone)`**, or type
   `/voice-settings`.
2. Choose **Fish Audio API key** and paste a key from
   [fish.audio](https://fish.audio) → API keys.
3. Choose **Fish Audio voice** to list the voices in your account, search the
   public Voice Library, or paste a model id directly.
4. Optional: choose **Fish Audio model**. `s2.1-pro-free` is the default;
   `s2-pro` is higher quality and uses paid credits.
5. Choose **Use Fish Audio** (the first menu entry) to make it active.
   Choose **Use local JARVIS voice** to switch back at any time.

The key is kept in OpenCode's local plugin storage, is sent only to
`api.fish.audio` over HTTPS (plus the loopback daemon), and is never written
to the repo, logs, or a toast. With Fish **TTS** active the spoken text is
sent to Fish Audio; mic audio and Whisper transcription stay local unless you
also enable Fish **STT** below. If the key or voice is missing, TTS falls back
to the local Piper voice rather than silently failing.

Advanced/CLI use can set `JARVIS_VOICE_FISH_KEY`, `JARVIS_VOICE_FISH_VOICE`,
and `JARVIS_VOICE_FISH_MODEL`; the settings dialog is preferred because it
stores the key without putting it in a shell history or committed config.

### Choosing the microphone

**Voice: settings → Microphone** lists every input the machine can offer and
lets you pick one:

| Entry | What it is |
|---|---|
| Automatic (recommended) | the daemon picks the first microphone that really delivers audio |
| `jarvis_mic` | the Android phone microphone, captured directly through PulseAudio's SLES source |
| `parrot_mic` | the Termux:API microphone piped in by the Termux audio bridge |
| Termux:API microphone | `termux-microphone-record`, used directly (needs the Termux:API package) |
| PortAudio inputs | every input the sounddevice/PortAudio layer exposes |
| ALSA capture devices | the hardware devices `arecord` can open |

The choice is sent with every turn, so it applies to push-to-talk straight
away. **Test this microphone** measures the input level for a second and
tells you whether the chosen device hears anything. A microphone that is
picked explicitly never falls back to another one: if it cannot be opened,
the turn fails with the reason instead of quietly recording somewhere else.

### Reading a reply with Fish Audio

Cloud voices are not instant, so the daemon does three things to make a reply
start quickly:

- **The request returns at once.** The rendering and the playback happen in
  the background, so the UI shows "playing" immediately instead of waiting
  for the whole clip.
- **The reply is rendered in chunks** (sentences, about 220 characters each).
  The first chunk starts playing as soon as it is ready, and the rest follow
  in order, so the time to the first sound is a fraction of the time to
  render the whole reply. The first chunk is asked for with Fish's fastest
  latency mode.
- **Every chunk is cached**, so reading the same reply again is instant.

Set `JARVIS_VOICE_FISH_CHUNK_CHARS` to change the chunk size (a smaller chunk
starts sooner), and `JARVIS_VOICE_FISH_LATENCY` to change the quality/latency
balance of the rest (`low`, `balanced` or `normal`).

**One voice at a time.** Pressing *read* on another answer while something is
playing cuts the current voice first and starts the new one - two voices never
talk over each other. A reply that is still rendering when a new one starts is
dropped instead of playing later.

### Optional Fish Audio speech-to-text

Local Whisper stays the default, and your mic audio stays on the device unless
you switch this on. When you want cloud ASR — for a language Whisper's tiny
models handle poorly, or for better accuracy on a slow phone — open
`/voice-settings` → **Transcription**:

1. Choose **Use Fish Audio speech-to-text**. The Fish Audio key from the voice
   section is reused; if none is set, the dialog asks for one.
2. Optional: choose **Fish Audio ASR model**. `transcribe-1-pro` is the default
   and recommended — 80+ languages, long recordings, and speaker support.
   `transcribe-1` is the lighter short-clip model.
3. Optional: choose **Fish Audio language**. **Auto-detect** is recommended and
   works across Fish's supported languages. A hint sets the reported language
   when a very short clip cannot be detected on its own; detection still runs.
   Choose **Other ISO 639-1 code** to type any two-letter code.
4. Choose **Use local Whisper** at any time to stop uploading audio.

Fish still detects the language automatically when a hint is set, so the hint
never limits which language can be spoken. The setting affects push-to-talk in
the TUI. The agent's `voice_listen` tool uses the daemon default, which remains
local unless you start the daemon with `JARVIS_VOICE_STT=fish` and
`JARVIS_VOICE_FISH_KEY` in its environment.

> **Privacy and billing:** selecting Fish ASR sends each recorded utterance to
> `api.fish.audio` over HTTPS. The key is stored in OpenCode's local plugin
> storage, never in the repo or logs. Fish ASR uses API credit separate from
> the free TTS model; without credit the daemon returns a clear HTTP 402 error
> and suggests adding credit at `fish.audio/app/developers`.

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

The daemon now opens the **real phone mic directly** through PulseAudio's
`module-sles-source` over that TCP connection. It does not depend on the
virtual `parrot_mic` pipe having a working feeder, so a broken `parrot-audio`
bridge no longer means a silent microphone. The module is loaded when
push-to-talk starts and released when the daemon exits; between turns the
source sits idle.

If you already run a `parrot-audio` bridge, leave it alone if it works: the
daemon prefers a real default source (Bluetooth or USB) and only takes the
direct phone-mic path when the default is a virtual pipe or produces silence.
If an old bridge watchdog is rebuilding PulseAudio in a loop, stop the
watchdog; the direct path keeps working without it.

Then, from Parrot: `./bin/voice doctor` should show a microphone backend
(`pulse-sles` on the reference setup).

Keep it alive across reboots with Termux:Boot — create
`~/.termux/boot/jarvis-voice.sh`:

```sh
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sh /path/to/jarvis-voice/bin/termux-pulse
```

After rebooting, `./bin/voice doctor` should still show the phone mic.

<details>
<summary>How the audio backends are chosen</summary>

Tried in order; the first one that actually delivers samples wins, then the
choice is cached in `~/.cache/jarvis-voice/backend.json`.

| Backend | Where it applies |
|---|---|
| `pulse` | Parrot chroot, Termux, any PulseAudio/PipeWire desktop |
| `pulse-sles` | Android phone mic via PulseAudio `module-sles-source`; loaded on demand |
| `termux` | Android via Termux:API (`pkg install termux-api`) |
| `sounddevice` | Windows, macOS, Linux, Termux with `pkg install portaudio` |
| `arecord` | plain Linux (ALSA) |
| `sox` | anywhere sox is installed |
| `ffmpeg` | last resort; knows pulse, alsa, dshow, avfoundation |

On Android a real default source (Bluetooth/USB) is tried first. If the
default is a virtual pipe or produces only digital silence, the direct phone
mic is tried next. A backend that "works" but returns silence is skipped
instead of being cached as the microphone.

Force one with `JARVIS_VOICE_CAPTURE_BACKEND=pulse` or
`JARVIS_VOICE_CAPTURE_BACKEND=pulse-sles`, or re-probe with
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
| `JARVIS_VOICE_CAPTURE_BACKEND` | auto | force `pulse`, `pulse-sles`, `sounddevice`, `termux`, … |
| `JARVIS_VOICE_SLES` | `1` | set `0` to disable the direct Android phone-mic backend |
| `JARVIS_VOICE_SLES_SOURCE` | `jarvis_mic` | PulseAudio source name used for the direct phone mic |
| `JARVIS_VOICE_STT` | `auto` | `auto`, a local backend, `fish`, or `none`; the TUI setting wins per request |
| `JARVIS_VOICE_STT_RESCUE_RMS` | `0.02` | level above which an empty transcript is retried with a multilingual model |
| `JARVIS_VOICE_WHISPER_MODEL` | `tiny.en` | `tiny.en`, `tiny` (multilingual), `base`, `small`, `medium`, `large-v3` |
| `JARVIS_VOICE_WHISPER_DIR` | — | local model folder, for purely offline use |
| `JARVIS_VOICE_LANGUAGE` | auto | local Whisper hint, e.g. `en` to skip detection |
| `JARVIS_VOICE_PIPER_VOICE` | auto | explicit `.onnx` path or voice name |
| `JARVIS_VOICE_TTS` | auto | `piper`, `piper-bin`, `espeak`, `none` |
| `JARVIS_VOICE_FISH_KEY` | — | optional Fish TTS/ASR key; the settings dialog is preferred |
| `JARVIS_VOICE_FISH_VOICE` | — | optional Fish Audio voice/model id |
| `JARVIS_VOICE_FISH_MODEL` | `s2.1-pro-free` | Fish TTS model header |
| `JARVIS_VOICE_FISH_LATENCY` | `balanced` | `balanced`, `normal`, or `low` |
| `JARVIS_VOICE_FISH_CHUNK_CHARS` | `220` | characters per rendered chunk; smaller starts the voice sooner |
| `JARVIS_VOICE_FISH_ASR_MODEL` | `transcribe-1-pro` | Fish ASR model header (`transcribe-1-pro` or `transcribe-1`) |
| `JARVIS_VOICE_FISH_ASR_URL` | `https://api.fish.audio/v1/asr` | override for testing a proxy or mock |
| `JARVIS_VOICE_FISH_ASR_TIMEOUT` | `60` | seconds to wait for a Fish ASR response |
| `JARVIS_VOICE_VAD_THRESHOLD` | `0.012` | raise it in a noisy room |
| `JARVIS_VOICE_VAD_SILENCE_MS` | `900` | silence that ends a turn |
| `JARVIS_VOICE_LENGTH_SCALE` | `1.0` | Piper speed; `1.1` is a touch slower |
| `JARVIS_VOICE_IDLE_EXIT_S` | `300` | exit after this long with nothing to do; `0` stays resident |
| `JARVIS_VOICE_WARMUP` | `lazy` | `lazy` \| `boot` \| `off` — when the STT model is loaded |
| `JARVIS_VOICE_WHISPER_THREADS` | `4` on Android, `0` elsewhere | cap Whisper's CPU threads; `2` keeps a phone cooler |

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
* **Mic only while needed** — the direct phone-mic source is loaded when the
  first push-to-talk starts, sits idle between turns, and is unloaded when the
  daemon exits. The first press pays a short (~1 s) module-load cost; later
  presses in the same session take only a fraction of a second.
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
zero wake-ups beyond a 2 s shutdown check; with the `tiny.en` model loaded
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
      "options": { "mic": true, "speak": true, "autoSpeak": true, "autoSend": false }
    }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `mic` | `true` | show the 🎙 mic button in the prompt footer |
| `speak` | `true` | show the ◉ live button above the text box |
| `autoSpeak` | `true` | speak replies automatically after push-to-talk starts the turn |
| `autoSend` | `false` | send the transcript to the agent as soon as it is transcribed; off means it lands in the prompt box for review |
| `fishAudio` | — | optional `{ provider, apiKey, voiceId, voiceName, model, sttProvider, sttModel, sttLanguage }`; the settings dialog is safer for keys |
| `micSource` | — | the microphone to record from, e.g. `pulse:jarvis_mic`; the settings dialog is easier |
| `stt` | — | optional `{ provider, model, language, localModel, localLanguage }` defaults for speech-to-text; normally set in the settings dialog |

The **`Voice: settings`** dialog is the normal way to configure Fish Audio:
it stores the key in OpenCode's local plugin storage, masks it in the UI, and
lets you switch back to the local Piper voice without editing config files.

### HTTP API

The daemon is a small JSON API on `127.0.0.1`, authenticated with the bearer
token from `~/.cache/jarvis-voice/daemon.json`:

| Endpoint | Purpose |
|---|---|
| `GET /health` | capability report (`?deep=1` re-probes the mic) |
| `POST /ptt/start` · `POST /ptt/stop` · `POST /ptt/cancel` · `GET /ptt/state` | push-to-talk session; `/ptt/start` accepts `{max_ms?, stt?, mic?}` |
| `POST /listen` | record one utterance, return the transcript; accepts `{max_ms?, silence_ms?, stt?}` |
| `POST /transcribe` | raw PCM/WAV in, text out |
| `POST /speak` | synthesize + play (`{text, async?, backend?, fish?}`) |
| `POST /synth` | synthesize only, returns `audio/wav` or `audio/mpeg` |
| `POST /warmup` | load the local STT model now (no audio); accepts `{stt?}` and is a no-op for Fish |
| `GET /speech` | what the speakers are doing now (`active`, `paused`, `elapsed_ms`) |
| `POST /pause` · `POST /resume` | suspend / continue the current playback (`SIGSTOP` / `SIGCONT`) |
| `POST /interrupt` | stop capture and playback |
| `POST /probe` · `POST /shutdown` | re-probe the audio, stop the daemon |

The optional `stt` object has the shape
`{ "backend": "fish", "fish": { "apiKey": "…", "model": "transcribe-1-pro", "language": "en" } }`.
`backend: "local"` forces on-device Whisper even if the daemon environment
defaults to Fish. The optional `mic` object is
`{ "device": "pulse:jarvis_mic" }` and picks the microphone for that turn.

### Speech-to-text speed & quality

The default is `tiny.en` (English): it is roughly twice as fast as multilingual
`tiny` and more accurate for English. The model is warmed when push-to-talk
starts, while you are speaking, so the first real decode is not paying the full
load cost. On the reference arm64 phone a 1.5 s clip transcribes in about
0.6–0.7 s once the model is loaded; a cold model load is about 0.5 s from the
page cache (a few seconds on a completely cold start).

If an older install only has multilingual `tiny` cached, the daemon uses that
instead of downloading `tiny.en` silently, so upgrades keep working offline.
Run `./bin/voice fetch-model tiny.en` once to get the faster English weights.
Setting `JARVIS_VOICE_WHISPER_MODEL` explicitly always honours your choice.

`tiny.en` is English-only. For another language use multilingual `tiny`, or a
larger model for noisy rooms and accents. Two ways to get there:

* **Voice: settings → Transcription → Local Whisper model** picks the model
  per turn (`tiny.en`, `tiny`, `base`, `small`) and **Local Whisper language**
  sets a language hint.
* **Automatic** (the default) does the same thing for you: it starts with the
  fast `tiny.en`, and when that model hears nothing in audio that clearly had
  energy, it retries once with a cached multilingual model and keeps using
  that model afterwards. An English-only model simply cannot decode another
  language, and that used to look like "nothing was heard".

Alternatively select Fish Audio ASR
in `/voice-settings` → **Transcription**; it supports 80+ languages and does
the decoding on Fish's servers, at the cost of uploading the utterance and
using paid API credit:

```bash
export JARVIS_VOICE_WHISPER_MODEL=tiny      # multilingual
export JARVIS_VOICE_WHISPER_MODEL=base      # better accuracy, ~2x slower
./bin/voice restart
```

A near-silence guard runs before Whisper, so a muted or dead microphone
returns an empty transcript instead of Whisper's “thank you” hallucinations.
The daemon also rejects a capture backend that returns pure digital silence,
which is how the silent `parrot_mic` pipe is bypassed automatically.

On Android four Whisper threads are used by default for speed. Set
`JARVIS_VOICE_WHISPER_THREADS=2` if the phone gets warm during long
dictations. Piper's `low` voices are also faster than `medium` if you want a
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
│   ├── jv_stt.py             # faster-whisper / whisper / whisper.cpp / vosk / Fish ASR
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
| `microphone unavailable` | in Termux run `sh bin/termux-pulse` (PulseAudio + TCP), then `./bin/voice audio probe`; the daemon loads the phone mic directly |
| The old `parrot_mic` is silent | the daemon bypasses a dead virtual pipe and uses `pulse-sles`; if a bridge watchdog keeps rebuilding PulseAudio, stop that watchdog |
| `no local TTS backend` | `./bin/voice voice fetch en_GB-alan-medium` |
| espeak voice instead of Piper | no voice found — `./bin/voice voice list` |
| It hears you but the transcript is wrong | bigger model: `JARVIS_VOICE_WHISPER_MODEL=base`; `tiny.en` is English-only |
| `Heard nothing` | the toast now shows what the daemon heard (reason and level). Check the mic with `voice doctor`; if you speak another language, pick a multilingual model in **Voice: settings → Transcription → Local Whisper model** — the automatic mode already retries with `tiny` when the English model comes back empty |
| The transcript is not sent | that is the default: it lands in the prompt box so you can correct it. Press send, or turn on **Voice: toggle auto-send** for hands-free mode |
| The status line says "restart OpenCode" | the TUI is still running an older plugin build. Restart OpenCode so the new plugin is loaded |
| Fish Audio says key/voice not set | `ctrl+p` → **Voice: settings**, add the API key, then choose a voice |
| Fish Audio HTTP 401/402 | check the key on fish.audio; the free TTS model may need credit for some voices. Fish **ASR** uses separate API credit — add it at `fish.audio/app/developers` |
| Fish ASR reports the wrong language | leave the language on **Auto-detect**. A hint only sets the reported language when a very short clip cannot be detected; it does not force the transcript |
| Local Whisper is still used after choosing Fish | open `/voice-settings` → **Transcription** and confirm **Fish Audio (active)**; push-to-talk sends the choice with every turn, while the agent's `voice_listen` tool follows the daemon default |
| It cuts you off too early | `JARVIS_VOICE_VAD_SILENCE_MS=1500` |
| It triggers on background noise | `JARVIS_VOICE_VAD_THRESHOLD=0.02` |
| The key does nothing | restart OpenCode; confirm `voice.pushToTalk` in `ctrl+p` |
| The buttons are missing | restart OpenCode; `opencode plugin list` should show this folder |
| `⏸ pause` does nothing | the daemon is older than the plugin — `./bin/voice restart` |
| It reads the wrong text | it reads only the last answer's final text part; if a turn is still running, wait for it to finish |
| First push-to-talk after a quiet spell takes ~1 s | the daemon and phone-mic module are starting; later turns in the same session take only a fraction of a second. `JARVIS_VOICE_IDLE_EXIT_S=0` keeps it ready |
| Keep it resident for a long session | `JARVIS_VOICE_IDLE_EXIT_S=0 ./bin/voice restart` |
| Nothing at all | `./bin/voice doctor` — it names the broken part and the fix |
