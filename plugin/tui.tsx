/**
 * Jarvis Voice - OpenCode TUI plugin.
 *
 * Push-to-talk voice chat, the way a live assistant should feel:
 *
 *   press the key  ->  "Listening..."
 *   speak          ->  voice-activity detection ends the turn on its own
 *   pause          ->  transcript is sent as your message
 *   reply          ->  spoken back through the local Piper voice
 *
 * Pressing the key again while it is listening sends immediately.
 *
 * UI buttons (both follow the host theme, clickable with the mouse):
 *   `prompt.footer`         bottom-right of the prompt box: the mic / PTT button
 *   `session.composer.top`  top-right of the text box: the speaker / pause button
 *
 * Commands:  voice.pushToTalk (ctrl+alt+v), voice.pauseResume (ctrl+alt+p),
 *            voice.status, voice.cancel, voice.speakLast, voice.toggleAutoSpeak,
 *            /voice
 *
 * Options (plugin options in cli.json):
 *   { "mic": false }          hide the mic button
 *   { "speak": false }        hide the speaker button
 *   { "autoSpeak": false }    start with replies staying silent
 */

import { Plugin } from "@opencode/plugin/tui"
import { createVoiceController } from "./controller"
import { MicButton, SpeakButton } from "./ui"

export default Plugin.define({
  id: "jarvis-voice.cli",
  async setup(context) {
    const voice = createVoiceController(context)

    if (context.options?.mic !== false) {
      context.ui.slot({
        append: "prompt.footer",
        render: (input) => <MicButton context={context} voice={voice} sessionID={input.sessionID} />,
      })
    }

    if (context.options?.speak !== false) {
      context.ui.slot({
        append: "session.composer.top",
        render: (input) => <SpeakButton context={context} voice={voice} sessionID={input.sessionID} />,
      })
    }

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
          id: "voice.toggleAutoSpeak",
          title: "Voice: toggle speaking replies",
          group: "Jarvis Voice",
          palette: true,
          run: () => {
            voice.toggleAutoSpeak()
          },
        },
      ],
      bindings: ["voice.pushToTalk", "voice.pauseResume", "voice.status", "voice.cancel", "voice.speakLast"],
    }))

    return () => {
      voice.dispose()
    }
  },
})
