/**
 * Jarvis Voice - shared controller for the TUI plugin.
 *
 * Owns everything the keymap commands and the on-screen buttons do: push to
 * talk, speaking the last reply, and the play/pause state of the local
 * speaker. State lives in signals here so the buttons and commands always
 * agree (a click and `ctrl+alt+v` flip the same switch).
 *
 * Push-to-talk voice chat, the way a live assistant should feel:
 *
 *   press the key  ->  "Listening..."
 *   speak          ->  voice-activity detection ends the turn on its own
 *   pause          ->  transcript is sent as your message
 *   reply          ->  spoken back through the local Piper voice
 *
 * Pressing the key again while it is listening sends immediately.
 */

import { createSignal, type Accessor } from "solid-js"
import { DaemonError, api, ensureDaemon, summarize, type DaemonInfo, type Health } from "./daemon-client"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type MicState = "idle" | "listening" | "transcribing"
export type SpeechState = "idle" | "playing" | "paused"

export type VoiceController = ReturnType<typeof createVoiceController>

/* ------------------------------------------------------------- utilities */

function errorText(e: unknown, max = 200): string {
  if (e instanceof DaemonError) {
    const hint = e.hints?.[0] ? ` — ${e.hints[0]}` : ""
    // A dead microphone produces one line per backend; the first one plus the
    // fix is all a toast has room for.
    if (e.message.includes("no capture backend works")) {
      return `microphone unavailable${hint || " — run `voice doctor`"}`
    }
    const short = e.message.length > max ? `${e.message.slice(0, max)}...` : e.message
    return `${short}${hint}`
  }
  const msg = e instanceof Error ? e.message : String(e)
  return msg.length > max ? `${msg.slice(0, max)}...` : msg
}

function currentSessionID(context: any): string | undefined {
  try {
    const route = context.ui?.router?.current?.()
    if (route?.sessionID) return route.sessionID
    if (route?.type === "session" && route?.id) return route.id
  } catch {
    /* route not ready */
  }
  try {
    const sessions = context.data?.session?.list?.()
    if (Array.isArray(sessions) && sessions.length) {
      const first = sessions[0]
      return first?.id ?? first?.sessionID
    }
  } catch {
    /* no session data yet */
  }
  return undefined
}

/**
 * Assistant messages look like
 *   { id, type: "assistant", time: {...}, content: [{ type: "text", text }, { type: "reasoning", text }, ...] }
 * The accessors stay tolerant of extra shapes so a schema tweak cannot break voice.
 *
 * Only `type: "text"` parts are the answer: `type: "reasoning"` parts are the
 * grayed-out thinking text and must never be spoken. When a turn contains
 * several text parts (narration between tool calls, then the final answer),
 * the LAST one is the answer; the earlier ones are working notes.
 */
function roleOf(message: any): string {
  return String(message?.type ?? message?.role ?? message?.info?.role ?? "").toLowerCase()
}

export function assistantAnswerText(message: any): string {
  const content = message?.content ?? message?.parts ?? []
  if (Array.isArray(content)) {
    const answers = content.filter(
      (part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim(),
    )
    if (answers.length) return answers[answers.length - 1].text.trim()
    // An assistant message with only reasoning/tool parts has nothing to read.
    if (content.length) return ""
  }
  if (typeof content === "string") return content.trim()
  if (typeof message?.text === "string") return message.text.trim()
  return ""
}

/** A message the reader can speak: an assistant answer with real text. */
export function isReadableAnswer(message: any): boolean {
  return roleOf(message) === "assistant" && assistantAnswerText(message).length > 0
}

/** Newest assistant answer and its id, skipping in-flight ones with nothing yet. */
export function latestAnswer(messages: any[]): { id?: string; text: string } {
  if (!Array.isArray(messages)) return { text: "" }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (roleOf(m) !== "assistant") continue
    const text = assistantAnswerText(m)
    if (text) return { id: typeof m?.id === "string" ? m.id : undefined, text }
  }
  return { text: "" }
}

/** Text of the newest assistant message, skipping in-flight ones with nothing yet. */
export function latestAnswerText(messages: any[]): string {
  return latestAnswer(messages).text
}

/** Turn a markdown answer into something brief and worth listening to. */
export function speakable(text: string, limit = 600): string {
  let out = text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_{2,}([^_]+)_{2,}/g, "$1")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim()
  if (out.length > limit) {
    const cut = out.slice(0, limit)
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "))
    out = stop > limit * 0.4 ? cut.slice(0, stop + 1) : `${cut}...`
  }
  // A reply that was only code or punctuation leaves nothing sayable.
  if (out.replace(/\(code\)/g, " ").replace(/[\s.,:;!?()\-–—…"']/g, "").length < 2) return ""
  return out
}

/* ------------------------------------------------------------------ controller */

export function createVoiceController(context: any) {
  const [mic, setMic] = createSignal<MicState>("idle")
  const [speech, setSpeech] = createSignal<SpeechState>("idle")
  // Which message the current playback belongs to. The composer button and
  // the per-message buttons read this to decide between read/pause/resume.
  const [speakingMessage, setSpeakingMessage] = createSignal<string | null>(null)

  // The host's own TextRenderable class, captured from a mounted button.
  // `message-buttons.ts` must instantiate the host's classes, not a second copy
  // from the plugin's node_modules, or the renderer lays the node out without
  // ever drawing it.
  let hostTextClass: any = null

  /**
   * State changes here repaint the on-screen buttons directly.
   *
   * The buttons' text nodes subscribe with `addRepaint`. The host's renderer
   * only processes reactive updates during its own repaint passes, so a state
   * written from a background continuation (the speech watcher noticing the
   * end of playback, the mic turn ending) could otherwise sit unnoticed and
   * leave the button showing a stale label until the next unrelated redraw.
   * Writing the nodes and requesting a frame always lands.
   */
  type Repaint = () => void
  const repaints = new Set<Repaint>()

  function addRepaint(fn: Repaint): void {
    repaints.add(fn)
    try {
      fn()
    } catch {
      /* one broken subscriber must not break the rest */
    }
  }

  function removeRepaint(fn: Repaint): void {
    repaints.delete(fn)
  }

  function repaint(): void {
    for (const fn of repaints) {
      try {
        fn()
      } catch {
        /* isolated: a failed paint is not a reason to skip the others */
      }
    }
    try {
      context?.renderer?.requestRender?.()
    } catch {
      /* a missing renderer only means one late frame */
    }
  }

  function setSpeechState(value: SpeechState): void {
    setSpeech(value)
    repaint()
  }

  function setMicState(value: MicState): void {
    setMic(value)
    repaint()
  }

  let autoSpeak = context.options?.autoSpeak !== false
  let micBusy = false // guards double-starts while the first start is in flight
  let micCancelled = false // set by cancel() so the listen loop stays quiet
  let speechTimer: ReturnType<typeof setTimeout> | null = null
  let speechPolling = false

  function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    try {
      context.ui.toast.show({ title: "Jarvis Voice", message, variant, duration: variant === "error" ? 9000 : 4000 })
    } catch {
      /* the TUI is gone; nothing to do */
    }
  }

  async function daemon(start = true): Promise<DaemonInfo | null> {
    try {
      return await ensureDaemon({ start })
    } catch {
      return null
    }
  }

  async function daemonOrToast(): Promise<DaemonInfo | null> {
    const info = await daemon(true)
    if (!info) toast("voice daemon unavailable — run `voice up` in the jarvis-voice folder", "error")
    return info
  }

  /* ------------------------------------------------------------ speech state */

  // While the daemon is speaking we poll its state so the button follows along
  // (playing -> pause icon, paused -> resume icon). Deliberately light on
  // battery: 600 ms while playing, 3 s while paused, and the moment speech is
  // over the chain stops completely - the TUI never wakes the CPU for nothing.
  const SPEECH_POLL_PLAYING_MS = 600
  const SPEECH_POLL_PAUSED_MS = 3000
  const SPEECH_POLL_RETRY_MS = 700
  // A single failed health check is not proof the daemon is gone: a dropped
  // keep-alive connection used to flip the button to idle and abandon the
  // watch while audio was still playing. Give it a few polls first.
  const SPEECH_MAX_MISSES = 3
  let speechMisses = 0

  function stopSpeechWatch(): void {
    speechMisses = 0
    if (speechTimer !== null) {
      clearTimeout(speechTimer)
      speechTimer = null
    }
  }

  /** Playback is over: no message owns the speaker any more. */
  function endPlayback(): void {
    setSpeakingMessage(null)
    setSpeechState("idle")
    stopSpeechWatch()
  }

  function scheduleSpeechPoll(ms: number): void {
    if (speechTimer !== null) return
    speechTimer = setTimeout(() => {
      speechTimer = null
      void refreshSpeech()
    }, ms)
  }

  async function refreshSpeech(): Promise<void> {
    if (speechPolling) return
    speechPolling = true
    try {
      const info = await daemon(false)
      if (!info) {
        speechMisses += 1
        if (speechMisses < SPEECH_MAX_MISSES) {
          scheduleSpeechPoll(SPEECH_POLL_RETRY_MS)
          return
        }
        endPlayback()
        return
      }
      const st = await api.speech(info)
      speechMisses = 0
      const next = st.active ? (st.paused ? "paused" : "playing") : "idle"
      if (next === "idle") {
        endPlayback()
      } else {
        setSpeechState(next)
        scheduleSpeechPoll(next === "paused" ? SPEECH_POLL_PAUSED_MS : SPEECH_POLL_PLAYING_MS)
      }
    } catch {
      // A restarting daemon is not an error the user must see; the watcher
      // keeps polling quietly for a moment and only then gives up.
      speechMisses += 1
      if (speechMisses < SPEECH_MAX_MISSES) {
        scheduleSpeechPoll(SPEECH_POLL_RETRY_MS)
        return
      }
      endPlayback()
    } finally {
      speechPolling = false
    }
  }

  function watchSpeech(): void {
    speechMisses = 0
    scheduleSpeechPoll(SPEECH_POLL_PLAYING_MS)
  }

  /* -------------------------------------------------------------- speak text */

  async function speakText(text: string, title?: string): Promise<boolean> {
    const info = await daemonOrToast()
    if (!info) return false
    try {
      await api.speak(info, text, { async: true })
      setSpeakingMessage(null)
      setSpeechState("playing")
      watchSpeech()
      toast(title ?? `🔊 ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`)
      return true
    } catch (e) {
      toast(`Could not speak: ${errorText(e)}`, "error")
      return false
    }
  }

  /** Speak the newest assistant answer of a session. */
  async function speakLast(sessionID?: string): Promise<void> {
    const sid = sessionID ?? currentSessionID(context)
    if (!sid) {
      toast("No active session to read from", "warning")
      return
    }
    try {
      await context.data.session.message.sync(sid)
      const messages = context.data.session.message.list(sid) ?? []
      const answer = latestAnswer(messages)
      const text = speakable(answer.text)
      if (!text) {
        toast("The last reply has nothing to read", "warning")
        return
      }
      const info = await daemonOrToast()
      if (!info) return
      await api.speak(info, text, { async: true })
      setSpeakingMessage(answer.id ?? null)
      setSpeechState("playing")
      watchSpeech()
    } catch (e) {
      toast(errorText(e), "error")
    }
  }

  /** Read one specific assistant message, replacing anything already playing. */
  async function speakMessage(messageID: string, sessionID?: string): Promise<void> {
    const sid = sessionID ?? currentSessionID(context)
    if (!sid) {
      toast("No active session to read from", "warning")
      return
    }
    try {
      await context.data.session.message.sync(sid)
      const messages = context.data.session.message.list(sid) ?? []
      const message = messages.find((m: any) => m?.id === messageID)
      if (!message || !isReadableAnswer(message)) {
        toast("This message has nothing to read", "warning")
        return
      }
      const text = speakable(assistantAnswerText(message))
      if (!text) {
        toast("This message has nothing to read", "warning")
        return
      }
      const info = await daemonOrToast()
      if (!info) return
      if (speech() !== "idle") {
        // Another answer (or an arbitrary /voice phrase) owns the speaker.
        // Stop it first so the new read starts at the beginning.
        await api.interrupt(info).catch(() => undefined)
      }
      await api.speak(info, text, { async: true })
      setSpeakingMessage(messageID)
      setSpeechState("playing")
      watchSpeech()
    } catch (e) {
      toast(errorText(e), "error")
    }
  }

  /** Click on a message button: pause/resume it, or start reading it. */
  async function messageAction(messageID: string, sessionID?: string): Promise<void> {
    if (speakingMessage() === messageID && speech() !== "idle") {
      await pauseResume(sessionID)
      return
    }
    await speakMessage(messageID, sessionID)
  }

  /** Evaluated by the speak button: idle -> read, playing -> pause, paused -> resume. */
  async function pauseResume(sessionID?: string): Promise<void> {
    const state = speech()
    if (state === "idle") {
      await speakLast(sessionID)
      return
    }
    const info = await daemonOrToast()
    if (!info) return
    try {
      if (state === "playing") {
        await api.pause(info)
        setSpeechState("paused")
        watchSpeech()
      } else {
        await api.resume(info)
        setSpeechState("playing")
        watchSpeech()
      }
    } catch (e) {
      toast(errorText(e), "error")
      void refreshSpeech()
    }
  }

  /* --------------------------------------------------------------- submit text */

  async function submit(sessionID: string | undefined, text: string): Promise<boolean> {
    const client: any = context.client
    if (sessionID) {
      // The generated client has been seen in both flat and nested shapes;
      // try the natural one first, then the explicit path/body form.
      try {
        await client.session.prompt({ sessionID, text })
        return true
      } catch {
        /* fall through */
      }
      try {
        await client.session.prompt({ path: { sessionID }, body: { text } })
        return true
      } catch (e) {
        toast(`Could not send the transcript: ${errorText(e)}`, "error")
      }
    }
    // Last resort: leave the text where the user can use it.
    toast(`Transcript (copy it into the prompt): ${text}`, "warning")
    return false
  }

  /* ------------------------------------------------------- speak the reply */

  async function speakReply(sessionID: string | undefined): Promise<void> {
    if (!sessionID) return
    const info = await daemon(false)
    if (!info) return

    // Wait for the turn to finish, using the session status the TUI already tracks.
    for (let i = 0; i < 900; i++) {
      let status: string | undefined
      try {
        status = context.data.session.status(sessionID)
      } catch {
        status = undefined
      }
      if (status === undefined) break // no status data available; fall back to what we have
      if (status === "idle") {
        if (i < 2) {
          await sleep(400) // give the transcript a moment to land
          if (context.data.session.status(sessionID) === "idle") break
        } else {
          break
        }
      }
      await sleep(300)
    }

    let answer: { id?: string; text: string } = { text: "" }
    try {
      await context.data.session.message.sync(sessionID)
      answer = latestAnswer(context.data.session.message.list(sessionID) ?? [])
    } catch {
      /* fall through with whatever we have */
    }
    if (!answer.text) return
    const toSay = speakable(answer.text)
    if (!toSay) return
    try {
      await api.speak(info, toSay, { async: true })
      setSpeakingMessage(answer.id ?? null)
      setSpeechState("playing")
      watchSpeech()
    } catch (e) {
      toast(`Could not speak the reply: ${errorText(e)}`, "error")
    }
  }

  /* -------------------------------------------------------- push to talk */

  async function toggleMic(forcedSessionID?: string): Promise<void> {
    const sessionID = forcedSessionID ?? currentSessionID(context)

    if (mic() !== "idle") {
      // Second press: stop listening and send what we have. The loop below
      // picks the transcript up from its own pttStop call.
      try {
        const info = await daemon(true)
        if (!info) return
        await api.pttStop(info, 30000)
        toast("Sending what I heard…")
      } catch (e) {
        toast(errorText(e), "error")
      }
      return
    }
    if (micBusy) return

    micBusy = true
    micCancelled = false
    setMicState("listening")
    try {
      const info = await daemonOrToast()
      if (!info) return
      await api.pttStart(info, 30000)
      toast("🎙 Listening… speak now (press again to send)")

      // Wait for the capture turn to end on its own (silence detection).
      for (let i = 0; i < 240; i++) {
        await sleep(250)
        const state = await api.pttState(info).catch(() => null)
        const st = state?.ptt?.state
        if (st === "transcribing") setMicState("transcribing")
        if (!st || (st !== "listening" && st !== "transcribing")) break
      }

      setMicState("transcribing")
      const res = await api.pttStop(info, 60000).catch((e: unknown) => {
        toast(errorText(e), "error")
        return null
      })
      if (res === null) return // the failure was already reported
      if (micCancelled) return // cancel() asked for silence
      const text = (res.text ?? "").trim()
      if (!text) {
        toast("Heard nothing — check the mic with `voice doctor`", "warning")
        return
      }
      toast(`📝 ${text}`, "success")
      const sent = await submit(sessionID, text)
      if (sent && autoSpeak) void speakReply(sessionID)
    } catch (e) {
      toast(errorText(e), "error")
    } finally {
      micBusy = false
      setMicState("idle")
    }
  }

  /* --------------------------------------------------------------- actions */

  async function cancel(): Promise<void> {
    if (mic() !== "idle") micCancelled = true
    try {
      const info = await daemonOrToast()
      if (!info) return
      await api.interrupt(info)
      endPlayback()
      toast("Stopped.")
    } catch (e) {
      toast(errorText(e), "error")
    }
  }

  async function status(): Promise<void> {
    try {
      const info = await daemonOrToast()
      if (!info) return
      const h: Health = await api.health(info, true)
      toast(`${summarize(h)}${h.audio?.capture?.backend ? "" : " (no mic)"}`, "info")
      if (!h.audio?.capture?.backend) {
        const hint = h.audio?.capture?.hints?.[0]
        if (hint) toast(hint, "warning")
      }
    } catch (e) {
      toast(errorText(e), "error")
    }
  }

  function toggleAutoSpeak(): void {
    autoSpeak = !autoSpeak
    toast(autoSpeak ? "Replies will be spoken" : "Replies will stay silent", autoSpeak ? "success" : "info")
  }

  function dispose(): void {
    stopSpeechWatch()
  }

  return {
    mic: mic as Accessor<MicState>,
    speech: speech as Accessor<SpeechState>,
    /** The message whose audio is playing (or paused), if any. */
    speakingMessage: speakingMessage as Accessor<string | null>,
    /** The host's TextRenderable class, learned from a mounted slot button. */
    textClass: () => hostTextClass,
    registerTextClass: (ctor: any) => {
      if (!hostTextClass && typeof ctor === "function") hostTextClass = ctor
    },
    /** Buttons register their text nodes here; every state change repaints. */
    addRepaint,
    removeRepaint,
    autoSpeak: () => autoSpeak,
    speakText,
    speakLast,
    speakMessage,
    messageAction,
    pauseResume,
    toggleMic,
    cancel,
    status,
    toggleAutoSpeak,
    refreshSpeech,
    dispose,
  }
}
