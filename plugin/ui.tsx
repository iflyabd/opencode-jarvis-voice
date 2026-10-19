/**
 * Jarvis Voice - the two on-screen buttons.
 *
 *   MicButton    appended to `prompt.footer`         (bottom-right of the prompt box)
 *   SpeakButton  appended to `session.composer.top`  (top-right, above the text box)
 *
 * Both follow the host's real interaction pattern (see the built-in tab
 * buttons): a hover colour from the theme's action tokens, a left-click
 * `onMouseUp`, and no local colours of their own - every shade comes from
 * `context.theme`, so every OpenCode theme stays consistent.
 */

import { createSignal } from "solid-js"
import type { VoiceController } from "./controller"

const RIGHT_MOUSE_BUTTON = 2

type ButtonProps = {
  /** The plugin context: `ui.slot`'s sibling services, including the theme. */
  context: any
  /** The shared controller, so a click and the keybinding act on the same state. */
  voice: VoiceController
  /** Session the slot belongs to (prompt.footer / session.composer.top inputs). */
  sessionID?: string
}

/** Push-to-talk: click to start listening, click again to send. */
export function MicButton(props: ButtonProps) {
  const [hovered, setHovered] = createSignal(false)

  const theme = () => props.context.theme
  const state = () => props.voice.mic()

  const label = () => {
    switch (state()) {
      case "listening":
        return "● listening"
      case "transcribing":
        return "◌ transcribing"
      default:
        return "🎙 mic"
    }
  }

  const fg = () => {
    const t = theme()
    switch (state()) {
      case "listening":
        return t.text.feedback.error.base
      case "transcribing":
        return t.text.feedback.info.base
      default:
        return hovered() ? t.text.action.secondary.hovered : t.text.action.secondary.base
    }
  }

  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={(event: any) => {
        event?.preventDefault?.()
        event?.stopPropagation?.()
        if (event?.button === RIGHT_MOUSE_BUTTON) return
        void props.voice.toggleMic(props.sessionID)
      }}
    >
      <text fg={fg()} wrapMode="none" selectable={false}>
        {label()}
      </text>
    </box>
  )
}

/** Speaker: click to read the last reply, then pause / resume it in place. */
export function SpeakButton(props: ButtonProps) {
  const [hovered, setHovered] = createSignal(false)

  const theme = () => props.context.theme
  const state = () => props.voice.speech()

  const label = () => {
    switch (state()) {
      case "playing":
        return "⏸ pause"
      case "paused":
        return "▶ resume"
      default:
        return "🔊 read"
    }
  }

  const fg = () => {
    const t = theme()
    switch (state()) {
      case "playing":
        return hovered() ? t.text.feedback.success.base : t.text.feedback.success.muted
      case "paused":
        return t.text.feedback.warning.base
      default:
        return hovered() ? t.text.action.secondary.hovered : t.text.action.secondary.base
    }
  }

  return (
    <box width="100%" flexDirection="row" justifyContent="flex-end" flexShrink={0}>
      <box
        flexShrink={0}
        paddingRight={1}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={(event: any) => {
          event?.preventDefault?.()
          event?.stopPropagation?.()
          if (event?.button === RIGHT_MOUSE_BUTTON) return
          void props.voice.pauseResume(props.sessionID)
        }}
      >
        <text fg={fg()} wrapMode="none" selectable={false}>
          {label()}
        </text>
      </box>
    </box>
  )
}
