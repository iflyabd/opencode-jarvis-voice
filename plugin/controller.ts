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
import { DaemonError, api, ensureDaemon, summarize, type DaemonInfo, type FishOptions, type Health } from "./daemon-client"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type MicState = "idle" | "listening" | "transcribing"
export type SpeechState = "idle" | "playing" | "paused"

type VoiceSettings = {
  ttsProvider: "local" | "fish"
  fishApiKey: string
  fishVoiceId: string
  fishVoiceName: string
  fishModel: string
}

type FishVoice = { id: string; title: string; description?: string }

const FISH_MODEL = "s2.1-pro-free"

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

  /* ------------------------------------------------------------- settings */

  const optionFish = context.options?.fishAudio ?? context.options?.fish ?? {}
  const seedSettings: VoiceSettings = {
    ttsProvider: String(optionFish.provider ?? context.options?.ttsProvider ?? "local") === "fish" ? "fish" : "local",
    fishApiKey: String(optionFish.apiKey ?? context.options?.fishApiKey ?? ""),
    fishVoiceId: String(optionFish.voiceId ?? context.options?.fishVoiceId ?? ""),
    fishVoiceName: String(optionFish.voiceName ?? ""),
    fishModel: String(optionFish.model ?? context.options?.fishModel ?? FISH_MODEL),
  }

  // context.storage is durable and shared between TUI instances; keep a plain
  // object fallback so the controller also works in the server-side plugin.
  let settings: VoiceSettings = seedSettings
  let saveSettings: (mutation: (draft: VoiceSettings) => void) => Promise<void> = async (mutation) => {
    mutation(settings)
  }
  try {
    if (context?.storage?.store) {
      const pair = context.storage.store("jarvis-voice.settings.v1", { initial: seedSettings })
      const [stored, setStored] = pair as [
        VoiceSettings,
        (mutation: (draft: VoiceSettings) => void) => Promise<void>,
      ]
      settings = stored
      saveSettings = setStored
    }
  } catch {
    /* storage unavailable: settings stay in memory for this TUI */
  }

  async function persist(mutation: (draft: VoiceSettings) => void): Promise<void> {
    try {
      await saveSettings(mutation)
    } catch (e) {
      toast(`Could not save voice settings: ${errorText(e)}`, "error")
    }
  }

  function maskKey(key: string): string {
    const value = (key || "").trim()
    if (!value) return "not set"
    return value.length <= 4 ? "set" : `••••${value.slice(-4)}`
  }

  function ttsRequest(): { backend?: string; fish?: FishOptions } {
    const key = (settings.fishApiKey || "").trim()
    const voiceId = (settings.fishVoiceId || "").trim()
    if (settings.ttsProvider === "fish" && key && voiceId) {
      return {
        backend: "fish",
        fish: { apiKey: key, voiceId, model: (settings.fishModel || FISH_MODEL).trim() },
      }
    }
    return {}
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

  /* ----------------------------------------------------------- fish audio */

  async function fetchFishVoices(apiKey: string, query = "", selfOnly = true): Promise<FishVoice[]> {
    const url = new URL("https://api.fish.audio/model")
    url.searchParams.set("page_size", "50")
    url.searchParams.set("page_number", "1")
    // Fish's API calls this `self`; the SDK exposes it as self_only.
    if (selfOnly) url.searchParams.set("self", "true")
    if (query.trim()) url.searchParams.set("title", query.trim())

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      })
      const text = await res.text()
      let data: any = {}
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON error body */
      }
      if (!res.ok) {
        const detail = data?.message || data?.error || text.slice(0, 180) || `HTTP ${res.status}`
        throw new Error(`Fish Audio ${res.status}: ${detail}`)
      }
      const items = Array.isArray(data?.items) ? data.items : []
      return items
        .map((v: any) => ({
          id: String(v?._id ?? v?.id ?? ""),
          title: String(v?.title ?? v?.name ?? v?._id ?? "voice"),
          description: [v?.description, Array.isArray(v?.languages) ? v.languages.join(", ") : v?.language, v?.state]
            .filter(Boolean)
            .join(" · "),
        }))
        .filter((v: FishVoice) => v.id)
    } finally {
      clearTimeout(timer)
    }
  }

  async function setFishKey(): Promise<boolean> {
    if (!context.ui?.dialog?.prompt) return false
    const key = await context.ui.dialog.prompt({
      title: "Fish Audio API key",
      description: settings.fishApiKey
        ? `Current: ${maskKey(settings.fishApiKey)}. Paste a new key to replace it.`
        : "Create a key at fish.audio → API keys. It is stored locally by OpenCode, never committed.",
      placeholder: "paste your Fish Audio API key",
    })
    if (key === undefined) return false
    const trimmed = key.trim()
    if (!trimmed) {
      toast("Fish Audio key unchanged", "info")
      return false
    }
    await persist((draft) => {
      draft.fishApiKey = trimmed
      if (!draft.fishModel) draft.fishModel = FISH_MODEL
    })
    toast("Fish Audio key saved. Now choose a voice.", "success")
    return true
  }

  async function promptManualFishVoice(): Promise<void> {
    const voiceId = await context.ui.dialog.prompt({
      title: "Fish Audio voice id",
      description: "Paste the model id from a fish.audio voice URL (/m/<id>).",
      placeholder: "voice model id",
    })
    if (voiceId === undefined || !voiceId.trim()) return
    await persist((draft) => {
      draft.fishVoiceId = voiceId.trim()
      draft.fishVoiceName = voiceId.trim()
      draft.ttsProvider = "fish"
    })
    toast("Fish Audio voice saved", "success")
  }

  async function chooseFishVoice(publicSearch = false): Promise<void> {
    if (!(settings.fishApiKey || "").trim()) {
      const saved = await setFishKey()
      if (!saved) return
    }

    let query = ""
    if (publicSearch) {
      const asked = await context.ui.dialog.prompt({
        title: "Search Fish Audio voices",
        description: "Search the public Voice Library, e.g. jarvis, narrator, British male.",
        placeholder: "search text (leave blank for popular voices)",
      })
      if (asked === undefined) return
      query = asked.trim()
    }

    let voices: FishVoice[] = []
    try {
      voices = await fetchFishVoices((settings.fishApiKey || "").trim(), query, !publicSearch)
    } catch (e) {
      toast(errorText(e), "error")
      await promptManualFishVoice()
      return
    }

    const options: Array<{ title: string; value: string; description?: string }> = [
      { title: "Paste a voice id manually…", value: "__manual__", description: "Use any Fish Audio model id" },
    ]
    if (!publicSearch) {
      options.push({ title: "Search the public Voice Library…", value: "__search__" })
    }
    for (const v of voices) {
      options.push({
        title: v.title || v.id,
        value: v.id,
        description: [v.id, v.description].filter(Boolean).join(" · "),
      })
    }
    if (!voices.length) {
      toast("No voices found. Searching the public library may help.", "warning")
    }

    const picked: string | undefined = await context.ui.dialog.select({
      title: publicSearch ? "Fish Audio public voices" : "Your Fish Audio voices",
      placeholder: "Type to filter, then choose a voice",
      options,
      current: settings.fishVoiceId || undefined,
    })
    if (picked === undefined) return
    if (picked === "__manual__") {
      await promptManualFishVoice()
      return
    }
    if (picked === "__search__") {
      await chooseFishVoice(true)
      return
    }
    const voice = voices.find((v) => v.id === picked)
    await persist((draft) => {
      draft.fishVoiceId = picked
      draft.fishVoiceName = voice?.title || picked
      draft.ttsProvider = "fish"
    })
    toast(`Fish Audio voice: ${voice?.title || picked}`, "success")
  }

  async function showVoiceInfo(kind: "mic" | "stt" | "status"): Promise<void> {
    const info = await daemonOrToast()
    if (!info) return
    try {
      const h: Health = await api.health(info, true)
      if (kind === "status") {
        toast(summarize(h), "info")
        return
      }
      if (kind === "mic") {
        const cap: any = h.audio?.capture
        toast(
          cap?.backend
            ? `Microphone: ${cap.backend}${cap.rms != null ? ` (level ${Number(cap.rms).toFixed(3)})` : ""}`
            : "No working microphone found",
          cap?.backend ? "info" : "error",
        )
        return
      }
      const picked = h.stt?.backends?.find((b: any) => b.backend === h.stt?.picked)
      const model = picked?.model ? String(picked.model).split("/").pop() : ""
      toast(`Transcription: ${h.stt?.picked ?? "none"}${model ? ` · ${model}` : ""} · local`, "info")
    } catch (e) {
      toast(errorText(e), "error")
    }
  }

  async function openSettings(): Promise<void> {
    if (!context.ui?.dialog?.select) {
      toast("Settings need the interactive TUI", "warning")
      return
    }
    for (;;) {
      const provider = settings.ttsProvider === "fish" ? "fish" : "local"
      const key = (settings.fishApiKey || "").trim()
      const voice = settings.fishVoiceName || settings.fishVoiceId || "not chosen"
      const choice: string | undefined = await context.ui.dialog.select({
        title: "Jarvis Voice settings",
        placeholder: "Choose a setting",
        options: [
          {
            title: provider === "fish" ? "Fish Audio (active)" : "Use Fish Audio",
            value: "fish",
            description: key ? `key ${maskKey(key)} · voice ${voice}` : "Add an API key, then choose a voice",
          },
          {
            title: provider === "local" ? "Local JARVIS voice (active)" : "Use local JARVIS voice",
            value: "local",
            description: "Piper, fully offline",
          },
          { title: "Fish Audio API key", value: "key", description: key ? `Current: ${maskKey(key)}` : "Not set" },
          { title: "Fish Audio voice", value: "voice", description: voice },
          { title: "Fish Audio model", value: "model", description: settings.fishModel || FISH_MODEL },
          {
            title: "Search Fish Audio's public voices",
            value: "search",
            description: "Find a voice in the library after setting the key",
          },
          {
            title: "Microphone",
            value: "mic",
            description: "Automatic: direct phone mic on Android, default mic elsewhere",
          },
          { title: "Transcription", value: "stt", description: "Local Whisper, warmed while you speak" },
          { title: "Show voice status", value: "status" },
        ],
      })
      if (choice === undefined) return

      if (choice === "fish") {
        if (!key) {
          await setFishKey()
          if (!(settings.fishApiKey || "").trim()) continue
        }
        if (!settings.fishVoiceId) {
          await chooseFishVoice()
          if (!settings.fishVoiceId) continue
        }
        await persist((draft) => {
          draft.ttsProvider = "fish"
        })
        toast("Fish Audio will read replies. Spoken text is sent to Fish Audio.", "success")
      } else if (choice === "local") {
        await persist((draft) => {
          draft.ttsProvider = "local"
        })
        toast("Using the local JARVIS voice", "success")
      } else if (choice === "key") {
        const saved = await setFishKey()
        if (saved && !settings.fishVoiceId) await chooseFishVoice()
      } else if (choice === "voice") {
        await chooseFishVoice()
      } else if (choice === "search") {
        await chooseFishVoice(true)
      } else if (choice === "model") {
        const model: string | undefined = await context.ui.dialog.select({
          title: "Fish Audio model",
          placeholder: "Choose the TTS model",
          current: settings.fishModel || FISH_MODEL,
          options: [
            {
              title: "s2.1-pro-free",
              value: "s2.1-pro-free",
              description: "Free tier; good default",
            },
            {
              title: "s2-pro",
              value: "s2-pro",
              description: "Higher quality; uses Fish credits",
            },
            { title: "s1", value: "s1", description: "Older model" },
          ],
        })
        if (model) {
          await persist((draft) => {
            draft.fishModel = model
          })
          toast(`Fish Audio model: ${model}`, "success")
        }
      } else if (choice === "mic" || choice === "stt" || choice === "status") {
        await showVoiceInfo(choice)
      }
    }
  }

  async function preload(): Promise<void> {
    const info = await daemonOrToast()
    if (!info) return
    try {
      await api.warmup(info)
      toast("Speech model ready — transcription will be quick", "success")
    } catch (e) {
      toast(`Could not warm the speech model: ${errorText(e)}`, "error")
    }
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
      await api.speak(info, text, { async: true, ...ttsRequest() })
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
      await api.speak(info, text, { async: true, ...ttsRequest() })
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
      await api.speak(info, text, { async: true, ...ttsRequest() })
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
      await api.speak(info, toSay, { async: true, ...ttsRequest() })
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
    openSettings,
    preload,
    toggleAutoSpeak,
    refreshSpeech,
    dispose,
  }
}
