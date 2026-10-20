/**
 * Jarvis Voice - a read control under every spoken answer.
 *
 * OpenCode 2.0.32 publishes slot paths for the composer and the sidebars, but
 * not for individual messages. The transcript, however, renders every message
 * as a renderable whose id is the message id (`msg_...`) inside the session
 * scrollbox. This module attaches a small button row to those renderables: one
 * row per assistant message that has text to read.
 *
 * It is deliberately defensive:
 *   - only reads the public `id` of a renderable, never private fields;
 *   - creates and destroys its own nodes, and never mutates host content;
 *   - re-scans on session/message events so host re-renders are repaired;
 *   - does nothing at all when the transcript does not expose message ids,
 *     leaving the composer button as the fallback.
 *
 * The renderables are instantiated from the constructors of the host's own
 * renderables (`msg` box, a mounted slot text node). Importing
 * `@opentui/core` here would load a second copy from the plugin's
 * node_modules; its instances are laid out by the host but never drawn.
 *
 * Clicks call the same controller as the composer button, so pause/resume and
 * the on-screen labels agree everywhere.
 */

import { assistantAnswerText, isReadableAnswer, type VoiceController } from "./controller"

const MESSAGE_PREFIX = "msg_"
const BUTTON_PREFIX = "jarvis-read-"

type Entry = {
  messageID: string
  anchor: any
  row: any
  paint: () => void
  gone: boolean
}

function currentSessionID(context: any): string | undefined {
  try {
    const route = context.ui?.router?.current?.()
    if (route?.type === "session" && route?.sessionID) return route.sessionID
    if (route?.sessionID) return route.sessionID
  } catch {
    /* the router is not ready yet */
  }
  return undefined
}

function childrenOf(node: any): any[] {
  try {
    return node?.getChildren?.() ?? []
  } catch {
    return []
  }
}

type ScanNode = {
  kind: "message" | "part"
  messageID: string
  index: number
  node: any
}

/** `session-part:<messageID>:text:<index>` is a separately rendered text part. */
function parseTextPart(id: string): { messageID: string; index: number } | null {
  if (!id.startsWith("session-part:")) return null
  const rest = id.slice("session-part:".length)
  const marker = ":text:"
  const at = rest.lastIndexOf(marker)
  if (at < 0) return null
  const messageID = rest.slice(0, at)
  const index = Number(rest.slice(at + marker.length))
  if (!messageID.startsWith(MESSAGE_PREFIX) || !Number.isInteger(index)) return null
  return { messageID, index }
}

function scanNodes(node: any, out: ScanNode[] = [], depth = 0): ScanNode[] {
  if (!node || depth > 60) return out
  let id = ""
  try {
    id = typeof node.id === "string" ? node.id : ""
  } catch {
    /* a renderable without an id cannot be a message */
  }
  if (id.startsWith(MESSAGE_PREFIX)) {
    out.push({ kind: "message", messageID: id, index: 0, node })
    return out
  }
  const part = parseTextPart(id)
  if (part) {
    out.push({ kind: "part", messageID: part.messageID, index: part.index, node })
    return out
  }
  for (const child of childrenOf(node)) scanNodes(child, out, depth + 1)
  return out
}

/** All rendered text under a node, used to prove a message box holds its answer. */
function renderedText(node: any, parts: string[] = [], depth = 0): string {
  if (!node || depth > 40) return parts.join(" ")
  try {
    const plain = node.plainText
    if (typeof plain === "string" && plain) parts.push(plain)
  } catch {
    /* not a text renderable */
  }
  for (const child of childrenOf(node)) renderedText(child, parts, depth + 1)
  return parts.join(" ")
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

export function createMessageButtons(context: any, voice: VoiceController) {
  const entries = new Map<string, Entry>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let textClass: any = null

  /**
   * The host's TextRenderable class. The mounted speaker button registers it;
   * before that (or if the speaker button is disabled) borrow the constructor
   * of any existing text renderable, then verify it accepts `content`.
   */
  function resolveTextClass(root: any): any {
    const registered = voice.textClass?.()
    if (typeof registered === "function") return registered
    if (typeof textClass === "function") return textClass

    const stack: any[] = [root]
    while (stack.length) {
      const node = stack.pop()
      let plain: unknown
      try {
        plain = node?.plainText
      } catch {
        plain = undefined
      }
      const ctor = node?.constructor
      if (typeof plain === "string" && typeof ctor === "function" && ctor !== Object) {
        try {
          const probe: any = new ctor(context.renderer, { content: "x", height: 1, width: "auto" })
          let value: unknown
          try {
            value = probe?.plainText
          } catch {
            value = undefined
          }
          try {
            probe?.destroy?.()
          } catch {
            /* detached probe */
          }
          if (value === "x") {
            textClass = ctor
            return ctor
          }
        } catch {
          /* not a plain text renderable; try the next one */
        }
      }
      for (const child of childrenOf(node)) stack.push(child)
    }
    return null
  }

  function colors() {
    const text = context?.theme?.text ?? {}
    const secondary = text.action?.secondary ?? {}
    const success = text.feedback?.success ?? {}
    const warning = text.feedback?.warning ?? {}
    return {
      base: secondary.base ?? "#888888",
      hovered: secondary.hovered ?? secondary.base ?? "#aaaaaa",
      success: success.muted ?? success.base ?? "#5fd75f",
      successHover: success.base ?? "#5fd75f",
      warning: warning.base ?? "#ffaf00",
    }
  }

  function disposeEntry(entry: Entry): void {
    if (entry.gone) return
    entry.gone = true
    voice.removeRepaint(entry.paint)
    try {
      entry.row?.parent?.remove?.(entry.row)
    } catch {
      /* the host already removed the transcript */
    }
    try {
      entry.row?.destroyRecursively?.()
    } catch {
      try {
        entry.row?.destroy?.()
      } catch {
        /* a destroyed renderable cannot be destroyed twice */
      }
    }
  }

  function attach(anchor: any, messageID: string, sessionID: string, root: any): void {
    const renderer = context.renderer
    if (!renderer || disposed || entries.has(messageID) || !anchor?.parent) return

    const BoxClass = anchor.constructor
    const TextClass = resolveTextClass(root)
    if (typeof BoxClass !== "function" || typeof TextClass !== "function") return

    let row: any
    let label: any
    try {
      row = new BoxClass(renderer, {
        id: `${BUTTON_PREFIX}${messageID}`,
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        paddingLeft: 3,
      })
      label = new TextClass(renderer, {
        id: `${BUTTON_PREFIX}text-${messageID}`,
        content: "🔊 read",
        height: 1,
        width: "auto",
        wrapMode: "none",
        selectable: false,
        flexShrink: 0,
      })
      row.add(label)
    } catch {
      try {
        row?.destroy?.()
      } catch {
        /* nothing was attached */
      }
      return
    }

    let hovered = false
    const paint = () => {
      const c = colors()
      const state = voice.speech()
      const mine = voice.speakingMessage?.() === messageID
      let text = "🔊 read"
      let color = hovered ? c.hovered : c.base
      if (mine && state === "playing") {
        text = "⏸ pause"
        color = hovered ? c.successHover : c.success
      } else if (mine && state === "paused") {
        text = "▶ resume"
        color = c.warning
      }
      try {
        label.content = text
      } catch {
        /* keep the host frame alive even if a label write fails */
      }
      try {
        label.fg = color
      } catch {
        /* theme colours are best effort */
      }
    }

    const hover = (value: boolean) => {
      hovered = value
      paint()
    }
    const over = () => hover(true)
    const out = () => hover(false)
    const click = (event: any) => {
      event?.preventDefault?.()
      event?.stopPropagation?.()
      if (event?.button === 2) return
      void voice.messageAction(messageID, sessionID)
    }
    // Mouse events do not bubble from the text child to the row on every
    // host build, so both the full-width row and the label are clickable.
    row.onMouseOver = over
    row.onMouseOut = out
    row.onMouseUp = click
    label.onMouseOver = over
    label.onMouseOut = out
    label.onMouseUp = click

    anchor.add(row)
    // Paint only after the row is attached: a text node written while it is
    // detached can be laid out but never drawn by the host buffer.
    voice.addRepaint(paint)
    try {
      anchor.requestRender?.()
      renderer.requestRender?.()
    } catch {
      /* the next host frame will paint it */
    }

    entries.set(messageID, { messageID, anchor, row, paint, gone: false })
  }

  function scan(): void {
    if (disposed) return
    let root: any
    try {
      root = context.renderer?.root
    } catch {
      root = undefined
    }
    if (!root) return

    const sessionID = currentSessionID(context)
    if (!sessionID) {
      for (const entry of entries.values()) disposeEntry(entry)
      entries.clear()
      return
    }

    let messages: any[] = []
    try {
      messages = context.data?.session?.message?.list?.(sessionID) ?? []
    } catch {
      messages = []
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      for (const entry of entries.values()) disposeEntry(entry)
      entries.clear()
      return
    }

    const byID = new Map<string, any>()
    for (const message of messages) {
      const id = message?.id
      if (typeof id === "string") byID.set(id, message)
    }

    const messageBox = new Map<string, any>()
    const textPart = new Map<string, { index: number; node: any }>()
    for (const found of scanNodes(root)) {
      if (found.kind === "message") {
        messageBox.set(found.messageID, found.node)
        continue
      }
      const current = textPart.get(found.messageID)
      if (!current || found.index > current.index) {
        textPart.set(found.messageID, { index: found.index, node: found.node })
      }
    }

    const seen = new Set<string>()
    for (const messageID of new Set([...messageBox.keys(), ...textPart.keys()])) {
      const message = byID.get(messageID)
      if (!message || !isReadableAnswer(message)) continue
      const answer = assistantAnswerText(message)
      if (!answer) continue

      // A text part with siblings (reasoning, tools, narration) is rendered
      // as its own `session-part:` box after the message box. The answer is
      // the last text part. A lone text part lives inside the message box.
      const part = textPart.get(messageID)
      let anchor = part?.node
      if (!anchor) {
        const box = messageBox.get(messageID)
        if (!box) continue
        // Only use the message box when its rendered text really is this
        // answer; a reasoning-only step is followed by a separate part box.
        const probe = normalized(answer).slice(0, 48)
        if (probe && !normalized(renderedText(box)).includes(probe)) continue
        anchor = box
      }

      seen.add(messageID)
      const existing = entries.get(messageID)
      if (existing) {
        // Same message, but the host may have moved the answer into a new
        // renderable or rebuilt the transcript. Follow it.
        let attached = false
        try {
          attached = existing.anchor === anchor && existing.row?.parent === anchor
        } catch {
          attached = false
        }
        if (attached) continue
        disposeEntry(existing)
        entries.delete(messageID)
      }
      attach(anchor, messageID, sessionID, root)
    }

    for (const [messageID, entry] of entries) {
      if (!seen.has(messageID)) {
        disposeEntry(entry)
        entries.delete(messageID)
      }
    }
  }

  function schedule(ms = 150): void {
    if (disposed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      scan()
    }, ms)
  }

  // Events are the only wake-up source: content deltas are ignored so a long
  // answer does not make the plugin walk the transcript on every token. The
  // ends of text/steps cover the moment when a message's renderable settles.
  const wake = new Set([
    "session.created",
    "session.deleted",
    "session.forked",
    "session.moved",
    "session.viewed",
    "session.idle",
    "session.text.started",
    "session.text.ended",
    "session.step.ended",
    "session.step.failed",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.compaction.ended",
    "session.revert.committed",
    "session.revert.cleared",
  ])

  let off: (() => void) | undefined
  try {
    off = context.data?.listen?.((event: any) => {
      const type = event?.details?.type
      if (typeof type === "string" && wake.has(type)) schedule()
    })
  } catch {
    off = undefined
  }

  return {
    /** Scan as soon as the next frame can have transcript content. */
    schedule,
    scan,
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      try {
        off?.()
      } catch {
        /* already unsubscribed */
      }
      for (const entry of entries.values()) disposeEntry(entry)
      entries.clear()
    },
  }
}
