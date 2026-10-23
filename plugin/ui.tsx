/**
 * Jarvis Voice - the on-screen controls.
 *
 *   MicButton     appended to `prompt.footer`         (bottom-right of the prompt box)
 *   ComposerLive  appended to `session.composer.top`  (toolbar above the text box:
 *                 auto-read, auto-send, master play/pause, and live)
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
  // The live caption: what the microphone is hearing, as it hears it.
  const caption = () => {
    const heard = String(props.voice.liveCaption?.() ?? "").trim()
    if (!heard) return ""
    return heard.length > 38 ? `${heard.slice(0, 37)}…` : heard
  }

  const label = () => {
    if (live()) {
      const heard = caption()
      if (heard) return `● ${heard}`
      return state() === "transcribing" ? "◌ transcribing" : "● live"
    }
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

type ToolbarButtonOptions = {
  label: () => string
  fg: (hovered: boolean) => string
  click: () => void
}

/** One compact control in the row above the prompt box. */
function toolbarButton(voice: VoiceController, options: ToolbarButtonOptions): any {
  let hovered = false
  const { node: text, paint } = liveText(voice, {
    fg: () => options.fg(hovered),
    label: options.label,
  })

  const box: any = createElement("box")
  box.flexShrink = 0
  box.paddingLeft = 1
  box.onMouseOver = () => {
    hovered = true
    paint()
  }
  box.onMouseOut = () => {
    hovered = false
    paint()
  }
  box.onMouseUp = (event: any) => {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (event?.button === RIGHT_MOUSE_BUTTON) return
    options.click()
  }
  box.add(text)
  return box
}

/**
 * The row above the prompt box:
 *
 *   auto-read  auto-send  play/pause  live
 *
 * Auto-read and auto-send are the two hands-free switches; the middle control is the
 * master play/pause for whatever the reader is speaking right now (and reads
 * the last answer when the speaker is idle). Live stays on the right edge, so
 * the row lines up with the mic button below it.
 */
function createToolbar(props: ButtonProps): any {
  const row: any = createElement("box")
  row.flexShrink = 0
  row.flexDirection = "row"
  row.alignItems = "center"

  const theme = () => props.context?.theme
  const secondary = (hovered: boolean) => {
    const token = theme()?.text?.action?.secondary ?? {}
    return hovered ? (token.hovered ?? token.base) : token.base
  }
  const active = () => theme()?.text?.feedback?.success?.base ?? theme()?.text?.feedback?.info?.base ?? secondary(false)
  const paused = () => theme()?.text?.feedback?.warning?.base ?? secondary(false)

  row.add(
    toolbarButton(props.voice, {
      label: () => (props.voice.autoSpeak?.() ? "◉ auto-read" : "○ auto-read"),
      fg: (hovered) => (props.voice.autoSpeak?.() ? active() : secondary(hovered)),
      click: () => props.voice.toggleAutoSpeak(),
    }),
  )
  row.add(
    toolbarButton(props.voice, {
      label: () => (props.voice.autoSend?.() ? "◆ auto-send" : "◇ auto-send"),
      fg: (hovered) => (props.voice.autoSend?.() ? active() : secondary(hovered)),
      click: () => void props.voice.toggleAutoSend(),
    }),
  )
  row.add(
    toolbarButton(props.voice, {
      label: () => (props.voice.speech?.() === "playing" ? "⏸ pause" : "▶ play"),
      fg: (hovered) => {
        const state = props.voice.speech?.() ?? "idle"
        return state === "playing" || state === "paused" ? paused() : secondary(hovered)
      },
      click: () => void props.voice.pauseResume(props.sessionID),
    }),
  )

  // The live toggle is the rightmost control, so the whole toolbar keeps the
  // same right edge as the mic button.
  const live = liveLabel(props)
  const liveBox: any = createElement("box")
  liveBox.flexShrink = 0
  liveBox.paddingLeft = 1
  liveBox.onMouseOver = () => live.hover(true)
  liveBox.onMouseOut = () => live.hover(false)
  liveBox.onMouseUp = (event: any) => {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (event?.button === RIGHT_MOUSE_BUTTON) return
    void props.voice.toggleLive(props.sessionID)
  }
  liveBox.add(live.text)
  row.add(liveBox)

  return row
}

/**
 * The mic button's box, so the toolbar can be lined up with it.
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

  anchor.add(createToolbar(props))
  wrapper.add(anchor)

  // Keep the toolbar on the row above the text box, on the mic's right edge.
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
  const root: any = createElement("box")
  root.flexShrink = 0
  root.flexDirection = "row"
  root.justifyContent = "flex-end"

  root.add(createToolbar(props))

  // Reach the mic button's right edge, so the whole toolbar lines up.
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
