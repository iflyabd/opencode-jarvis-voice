/**
 * Jarvis Voice - OpenCode TUI plugin.
 *
 * Push-to-talk voice chat, the way a live assistant should feel:
 *
 *   press the key  ->  "Listening..."
 *   speak          ->  voice-activity detection ends the turn on its own
 *   pause          ->  transcript is typed into the prompt box for review
 *   reply          ->  spoken back through the local Piper voice
 *
 * The transcript is never sent on its own unless auto-send is switched on
 * (Voice: toggle auto-send). Pressing the key again stops the recording.
 *
 * UI buttons (all follow the host theme, clickable with the mouse):
 *   `prompt.footer`         bottom-right of the prompt box: the mic / PTT button
 *   `session.composer.top`  top-right of the text box: the live voice toggle
 *   under each answer       a read / pause / resume button for that message
 *
 * The per-message rows are attached to the transcript renderables for assistant
 * messages and their text parts; see message-buttons.ts. Hosts that do not
 * expose those ids simply show the composer button only.
 *
 * Commands:  voice.pushToTalk (ctrl+alt+v), voice.pauseResume (ctrl+alt+p),
 *            voice.status, voice.cancel, voice.speakLast, voice.toggleAutoSpeak,
 *            voice.toggleAutoSend, voice.toggleLive, /voice
 *
 * Options (plugin options in cli.json):
 *   { "mic": false }          hide the mic button
 *   { "speak": false }        hide the speaker button
 *   { "autoSpeak": false }    start with replies staying silent
 *   { "autoSend": true }      send the transcript straight away (hands-free)
 */

import { Plugin } from "@opencode/plugin/tui"
import { createVoiceController } from "./controller"
import { createMessageButtons } from "./message-buttons"
import { LiveButton, MicButton } from "./ui"

export default Plugin.define({
  id: "jarvis-voice.cli",
  async setup(context) {
    const voice = createVoiceController(context)
    const messages = context.options?.speak === false ? null : createMessageButtons(context, voice)

    if (context.options?.mic !== false) {
      context.ui.slot({
        append: "prompt.footer",
        render: (input) => <MicButton context={context} voice={voice} sessionID={input.sessionID} />,
      })
    }

    if (context.options?.speak !== false) {
      context.ui.slot({
        append: "session.composer.top",
        render: (input) => {
          // Mounting this slot means a session view just appeared; the
          // transcript below it is laid out on the next frames.
          messages?.schedule(350)
          return <LiveButton context={context} voice={voice} sessionID={input.sessionID} />
        },
      })
      // A brand new chat is the home screen, which has no session composer
      // slot: the top of the text box is not a slot there. The toggle is
      // mounted in the prompt box instead, so it sits with the text box and
      // not in the page's status bar.
      context.ui.slot({
        prepend: "prompt.footer",
        render: () => {
          const route = context.ui?.router?.current?.()
          if (route?.type !== "home") return null
          return <LiveButton context={context} voice={voice} />
        },
      })
    }

    // Messages may already be on screen when the plugin loads (--continue,
    // session restored from a tab). The event stream repairs later changes.
    messages?.schedule(700)

    // If speech is already playing (another TUI, an earlier instance), pick the
    // state up so the button shows pause from the first frame.
    void voice.refreshSpeech()

    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [
        {
          id: "voice.pushToTalk",
          title: "Voice: push to talk",
          group: "Jarvis Voice",
          bind: "ctrl+alt+v",
          palette: true,
          suggested: true,
          slash: { name: "voice", arguments: true },
          run: async (input?: string) => {
            const arg = (input ?? "").trim()
            if (arg) {
              // `/voice <text>` -> say it out loud.
              await voice.speakText(arg, `🔊 ${arg}`)
              return
            }
            await voice.toggleMic()
          },
        },
        {
          id: "voice.pauseResume",
          title: "Voice: read / pause / resume the reply",
          group: "Jarvis Voice",
          bind: "ctrl+alt+p",
          palette: true,
          run: async () => {
            await voice.pauseResume()
          },
        },
        {
          id: "voice.status",
          title: "Voice: status",
          group: "Jarvis Voice",
          palette: true,
          run: async () => {
            await voice.status()
          },
        },
        {
          id: "voice.cancel",
          title: "Voice: cancel listening / stop speaking",
          group: "Jarvis Voice",
          palette: true,
          run: async () => {
            await voice.cancel()
          },
        },
        {
          id: "voice.speakLast",
          title: "Voice: speak the last reply",
          group: "Jarvis Voice",
          palette: true,
          run: async () => {
            await voice.speakLast()
          },
        },
        {
          id: "voice.settings",
          title: "Voice: settings (Fish Audio / transcription / microphone)",
          group: "Jarvis Voice",
          palette: true,
          slash: { name: "voice-settings" },
          run: async () => {
            await voice.openSettings()
          },
        },
        {
          id: "voice.preload",
          title: "Voice: preload the speech model",
          group: "Jarvis Voice",
          palette: true,
          run: async () => {
            await voice.preload()
          },
        },
        {
          id: "voice.toggleAutoSpeak",
          title: "Voice: toggle speaking replies",
          group: "Jarvis Voice",
          palette: true,
          run: () => {
            voice.toggleAutoSpeak()
          },
        },
        {
          id: "voice.toggleAutoSend",
          title: "Voice: toggle auto-send (transcript goes to the prompt box)",
          group: "Jarvis Voice",
          palette: true,
          run: async () => {
            await voice.toggleAutoSend()
          },
        },
        {
          id: "voice.toggleLive",
          title: "Voice: live voice conversation (listen, send, read back)",
          group: "Jarvis Voice",
          palette: true,
          run: async () => {
            await voice.toggleLive()
          },
        },
      ],
      bindings: ["voice.pushToTalk", "voice.pauseResume", "voice.status", "voice.cancel", "voice.speakLast"],
    }))

    return () => {
      messages?.dispose()
      voice.dispose()
    }
  },
})
