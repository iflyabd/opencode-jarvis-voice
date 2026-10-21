/**
 * Jarvis Voice - the two on-screen buttons.
 *
 *   MicButton    appended to `prompt.footer`         (bottom-right of the prompt box)
 *   SpeakButton  appended to `session.composer.top`  (top-right, above the text box)
 *
 * Plugin files are compiled outside the host's own JSX build, and the host
 * renderer only processes reactive text updates during its own repaint passes:
 * a label written from a background continuation (the speech watcher noticing
 * the end of playback) could sit stale until the next unrelated redraw. The
 * text nodes therefore register with the controller (`addRepaint`) and are
 * written directly - content, colour, then a frame request - so a label always
 * follows its signal, in every host build.
 *
 * Colours come from `context.theme` only, so every OpenCode theme stays
 * consistent, and a left-click `onMouseUp` mirrors the host's tab buttons.
 */

import { createSignal, onCleanup } from "solid-js"
import { createElement } from "@opentui/solid"
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

/**
 * A text renderable that is repainted by the controller.
 *
 * `createElement` needs an active renderer, so this is called from a component
 * body (the host mounts those inside its renderer). The returned `paint` also
 * lets the button redraw itself on hover.
 */
function liveText(
  voice: VoiceController,
  props: { fg: () => string; label: () => string },
): { node: any; paint: () => void } {
  const node: any = createElement("text")
  try {
    // Hand the host's own TextRenderable class to the message buttons: a
    // second copy from the plugin's node_modules would be laid out but never
    // drawn by the host renderer.
    voice.registerTextClass?.(node.constructor)
    node.wrapMode = "none"
    node.selectable = false
  } catch {
    /* older renderables: defaults are fine */
  }
  const paint = () => {
    try {
      node.content = props.label()
    } catch {
      /* a failed label must never break the button */
    }
    try {
      node.fg = props.fg()
    } catch {
      /* a missing theme token falls back to the renderable colour */
    }
  }
  voice.addRepaint(paint)
  onCleanup(() => voice.removeRepaint(paint))
  return { node, paint }
}

/** Push-to-talk: click to start listening, click again to send. */
export function MicButton(props: ButtonProps) {
  const [hovered, setHovered] = createSignal(false)

  const theme = () => props.context.theme
  const state = () => props.voice.mic()
  const live = () => props.voice.live?.() === true

  const label = () => {
    if (live()) return "● live"
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
    if (live()) return t.text.feedback.error.base
    switch (state()) {
      case "listening":
        return t.text.feedback.error.base
      case "transcribing":
        return t.text.feedback.info.base
      default:
        return hovered() ? t.text.action.secondary.hovered : t.text.action.secondary.base
    }
  }

  // Built in the component body, not inside a JSX child getter: the renderer
  // context is only guaranteed while the host is mounting this component.
  const { node: text, paint } = liveText(props.voice, { fg, label })

  const hover = (value: boolean) => {
    setHovered(value)
    paint()
  }

  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      ref={(el: any) => {
        micBox = el
      }}
      onMouseOver={() => hover(true)}
      onMouseOut={() => hover(false)}
      onMouseUp={(event: any) => {
        event?.preventDefault?.()
        event?.stopPropagation?.()
        if (event?.button === RIGHT_MOUSE_BUTTON) return
        // While the live conversation runs the mic button stops it.
        if (live()) {
          void props.voice.toggleLive(props.sessionID)
          return
        }
        void props.voice.toggleMic(props.sessionID)
      }}
    >
      {text}
    </box>
  )
}

/** The live button's label, colour and hover handling. */
function liveLabel(props: ButtonProps) {
  const [hovered, setHovered] = createSignal(false)
  const theme = () => props.context.theme
  const on = () => props.voice.live?.() === true

  const label = () => (on() ? "● live" : "◉ live")
  const fg = () => {
    const t = theme()
    if (on()) return t.text.feedback.error.base
    return hovered() ? t.text.action.secondary.hovered : t.text.action.secondary.base
  }

  const { node: text, paint } = liveText(props.voice, { fg, label })

  return {
    text,
    on,
    hover: (value: boolean) => {
      setHovered(value)
      paint()
    },
  }
}

/**
 * The mic button's box, so the live toggle can be lined up with it.
 * The box is used rather than the text node, because a wide glyph (the
 * microphone emoji) is drawn two columns wide but measured as one.
 */
let micBox: any = null

/**
 * The prompt box: the element that holds both the text area and the footer.
 * It is the common ancestor of the editor and the mic button, and its top
 * edge is the top of the text box.
 */
function promptBox(editor: any, mic: any): any {
  if (!editor || !mic) return null
  const chain = (node: any) => {
    const out: any[] = []
    let current = node?.parent
    while (current) {
      out.push(current)
      current = current.parent
    }
    return out
  }
  const micChain = new Set(chain(mic))
  for (const node of chain(editor)) {
    if (micChain.has(node)) return node
  }
  return null
}

/**
 * The prompt footer with the live toggle.
 *
 * The toggle is anchored to the row just above the text box, on the same
 * right edge as the mic button. It is rendered inside the footer (which is
 * full width) instead of the composer slot above the box, because that slot
 * is narrower than the text box and can swallow a button that is moved to
 * the right edge.
 */
export function PromptFooterLive(props: ButtonProps) {
  const live = liveLabel(props)

  // OpenTUI only honours `position` when it is set after the element exists.
  const wrapper: any = createElement("box")
  wrapper.position = "relative"
  wrapper.flexShrink = 0
  wrapper.flexDirection = "row"
  wrapper.justifyContent = "flex-end"

  const anchor: any = createElement("box")
  anchor.position = "absolute"
  anchor.left = 0
  anchor.top = -1
  anchor.zIndex = 2000
  anchor.flexShrink = 0

  const label: any = createElement("box")
  label.flexShrink = 0
  label.onMouseOver = () => live.hover(true)
  label.onMouseOut = () => live.hover(false)
  label.onMouseUp = (event: any) => {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (event?.button === RIGHT_MOUSE_BUTTON) return
    void props.voice.toggleLive(props.sessionID)
  }
  label.add(live.text)
  anchor.add(label)
  wrapper.add(anchor)

  // Keep the toggle on the row above the text box, on the mic's right edge.
  const sync = () => {
    wrapper.position = "relative"
    const editor = props.voice.editor?.()
    const box = promptBox(editor, micBox)
    const base = wrapper.y
    if (!box || typeof box.y !== "number" || typeof base !== "number") return
    // One row above the top edge of the text box.
    const offset = Math.round(box.y - 1 - base)
    if (!Number.isFinite(offset)) return
    if (anchor.top !== offset) anchor.top = offset

    // The right edge of the mic button, so the two line up.
    const mic = micBox
    const width = anchor.width
    const right = mic ? mic.x + mic.width : null
    if (right === null || typeof right !== "number" || typeof width !== "number" || width <= 0) return
    const left = Math.round(right - width - wrapper.x)
    if (!Number.isFinite(left)) return
    if (anchor.left !== left) anchor.left = left
  }
  const timer = setInterval(sync, 400)
  onCleanup(() => clearInterval(timer))

  return (
    <box flexShrink={0} flexDirection="row" justifyContent="flex-end">
      {wrapper}
      <MicButton context={props.context} voice={props.voice} sessionID={props.sessionID} />
    </box>
  )
}

/**
 * The live toggle in the row above the text box, in a session.
 *
 * The host's composer slot is narrower than the text box, so the toggle is
 * given the width that reaches the mic button's right edge and is right
 * aligned inside it. It stays in the flow, so the row is never empty and the
 * button can never be swallowed by a narrow slot.
 */
export function ComposerLiveButton(props: ButtonProps) {
  const live = liveLabel(props)

  const root: any = createElement("box")
  root.flexShrink = 0
  root.flexDirection = "row"
  root.justifyContent = "flex-end"

  const label: any = createElement("box")
  label.flexShrink = 0
  label.onMouseOver = () => live.hover(true)
  label.onMouseOut = () => live.hover(false)
  label.onMouseUp = (event: any) => {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (event?.button === RIGHT_MOUSE_BUTTON) return
    void props.voice.toggleLive(props.sessionID)
  }
  label.add(live.text)
  root.add(label)

  // Reach the mic button's right edge, so both buttons line up.
  const sync = () => {
    const mic = micBox
    const right = mic ? mic.x + mic.width : null
    const x = root.x
    if (right === null || typeof right !== "number" || typeof x !== "number") return
    const width = Math.max(0, Math.round(right - x))
    if (root.width !== width) root.width = width
  }
  const timer = setInterval(sync, 400)
  onCleanup(() => clearInterval(timer))

  return <box flexShrink={0}>{root}</box>
}

/**
 * Live voice: the microphone keeps listening, every turn is sent on its own
 * and the answer is read back, until it is switched off again.
 */
export function LiveButton(props: ButtonProps & { compact?: boolean }) {
  const live = liveLabel(props)
  return (
    <box
      width={props.compact ? undefined : "100%"}
      flexDirection="row"
      justifyContent="flex-end"
      flexShrink={0}
    >
      <box
        flexShrink={0}
        paddingRight={1}
        onMouseOver={() => live.hover(true)}
        onMouseOut={() => live.hover(false)}
        onMouseUp={(event: any) => {
          event?.preventDefault?.()
          event?.stopPropagation?.()
          if (event?.button === RIGHT_MOUSE_BUTTON) return
          void props.voice.toggleLive(props.sessionID)
        }}
      >
        {live.text}
      </box>
    </box>
  )
}
