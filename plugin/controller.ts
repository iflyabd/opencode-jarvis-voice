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
 *   pause          ->  transcript is typed into the prompt box for review
 *   reply          ->  spoken back through the local Piper voice
 *
 * The transcript is never sent on its own unless auto-send is switched on
 * (Voice: toggle auto-send). Pressing the key again stops the recording.
 */

import { createSignal, type Accessor } from "solid-js"
import {
  DaemonError,
  api,
  ensureDaemon,
  summarize,
  type DaemonInfo,
  type FishOptions,
  type Health,
  type MicChoice,
  type MicOptions,
  type SttOptions,
} from "./daemon-client"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type MicState = "idle" | "listening" | "transcribing"
export type SpeechState = "idle" | "playing" | "paused"

type VoiceSettings = {
  ttsProvider: "local" | "fish"
  fishApiKey: string
  fishVoiceId: string
  fishVoiceName: string
  fishModel: string
  sttProvider: "local" | "fish"
  fishSttModel: string
  /** Optional ISO 639-1 hint; "" means Fish auto-detects. */
  fishSttLanguage: string
  /** Local Whisper model; "" = automatic (tiny.en plus a multilingual rescue). */
  localModel: string
  /** Optional ISO 639-1 hint for the local model; "" = auto-detect. */
  localLanguage: string
  /** Send the transcript to the agent straight away instead of the prompt box. */
  autoSend: boolean
  /** Read every new answer out loud. */
  autoSpeak: boolean
  /** The microphone to record from; "" = let the daemon pick. */
  micSource: string
}

type FishVoice = { id: string; title: string; description?: string }

const FISH_MODEL = "s2.1-pro-free"
const FISH_STT_MODEL = "transcribe-1-pro"

/**
 * The plugin build that is running in this TUI. It is shown in the status
 * line so a stale TUI (started before an update) is obvious at a glance.
 */
export const PLUGIN_VERSION = "1.8.1"

/**
 * How long a pause ends a live turn.
 *
 * 900 ms is comfortable when you press a key to talk; in a conversation it
 * feels like a broken line. 450 ms still leaves room to breathe between
 * sentences and sends the words while the answer is being thought about.
 */
export const LIVE_SILENCE_MS = 450

/** Local Whisper models the settings can pick. "" means automatic. */
const LOCAL_MODELS: Array<{ id: string; title: string; description: string }> = [
  {
    id: "",
    title: "Automatic (recommended)",
    description: "tiny.en for English, with a multilingual retry when nothing comes back",
  },
  { id: "tiny.en", title: "tiny.en", description: "English only, fastest on a phone" },
  { id: "tiny", title: "tiny", description: "Multilingual, a little slower" },
  { id: "base", title: "base", description: "Multilingual, better accuracy, downloads on first use" },
  { id: "small", title: "small", description: "Multilingual, best accuracy, slow on a phone" },
]

function normalizeLocalModel(value: unknown): string {
  const name = String(value ?? "").trim().toLowerCase()
  return LOCAL_MODELS.some((m) => m.id === name) ? name : ""
}

/**
 * Language hints accepted by Fish Audio ASR. Fish detects the language
 * automatically (80+ languages); this list is a convenience for setting the
 * reported language on short or ambiguous clips. "Other" accepts any ISO
 * 639-1 code.
 */
export const FISH_STT_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: "af", name: "Afrikaans" },
  { code: "sq", name: "Albanian" },
  { code: "am", name: "Amharic" },
  { code: "ar", name: "Arabic" },
  { code: "hy", name: "Armenian" },
  { code: "az", name: "Azerbaijani" },
  { code: "be", name: "Belarusian" },
  { code: "bn", name: "Bengali" },
  { code: "bs", name: "Bosnian" },
  { code: "bg", name: "Bulgarian" },
  { code: "my", name: "Burmese" },
  { code: "ca", name: "Catalan" },
  { code: "zh", name: "Chinese" },
  { code: "hr", name: "Croatian" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "en", name: "English" },
  { code: "et", name: "Estonian" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "gl", name: "Galician" },
  { code: "ka", name: "Georgian" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "gu", name: "Gujarati" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "is", name: "Icelandic" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "kn", name: "Kannada" },
  { code: "kk", name: "Kazakh" },
  { code: "ko", name: "Korean" },
  { code: "ky", name: "Kyrgyz" },
  { code: "lv", name: "Latvian" },
  { code: "lt", name: "Lithuanian" },
  { code: "mk", name: "Macedonian" },
  { code: "ms", name: "Malay" },
  { code: "ml", name: "Malayalam" },
  { code: "mr", name: "Marathi" },
  { code: "mn", name: "Mongolian" },
  { code: "ne", name: "Nepali" },
  { code: "no", name: "Norwegian" },
  { code: "ps", name: "Pashto" },
  { code: "fa", name: "Persian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "pa", name: "Punjabi" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "sr", name: "Serbian" },
  { code: "si", name: "Sinhala" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "so", name: "Somali" },
  { code: "es", name: "Spanish" },
  { code: "sw", name: "Swahili" },
  { code: "sv", name: "Swedish" },
  { code: "tl", name: "Tagalog" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "ur", name: "Urdu" },
  { code: "uz", name: "Uzbek" },
  { code: "vi", name: "Vietnamese" },
  { code: "cy", name: "Welsh" },
  { code: "xh", name: "Xhosa" },
  { code: "zu", name: "Zulu" },
]

function normalizeSttModel(value: unknown): string {
  const model = String(value ?? "").trim()
  return model === "transcribe-1" ? "transcribe-1" : FISH_STT_MODEL
}

function normalizeSttLanguage(value: unknown): string {
  let text = String(value ?? "").trim().toLowerCase()
  if (!text || text === "auto") return ""
  text = text.split(/[-_]/)[0]
  return /^[a-z]{2}$/.test(text) ? text : ""
}

function sttLanguageName(code: string): string {
  if (!code) return "Auto-detect"
  return FISH_STT_LANGUAGES.find((item) => item.code === code)?.name ?? code
}

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
export function latestAnswer(messages: any[]): { id?: string; text: string; created?: number } {
  if (!Array.isArray(messages)) return { text: "" }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (roleOf(m) !== "assistant") continue
    const text = assistantAnswerText(m)
    if (!text) continue
    const created = Number(m?.time?.created ?? m?.timeCreated ?? 0) || undefined
    return { id: typeof m?.id === "string" ? m.id : undefined, text, created }
  }
  return { text: "" }
}

/** Text of the newest assistant message, skipping in-flight ones with nothing yet. */
export function latestAnswerText(messages: any[]): string {
  return latestAnswer(messages).text
}

/**
 * Read the transcript out of a daemon turn.
 *
 * The daemon nests the turn result under `result` and also sends a flat
 * `text` copy. Older daemons only send `result`, so read both: picking the
 * wrong one is what made every push-to-talk turn report "heard nothing".
 */
export function transcriptText(res: any): string {
  const raw = res?.text ?? res?.result?.text ?? ""
  return String(raw ?? "").trim()
}

/**
 * Put text into an editable prompt box (the host's focused editor).
 * Returns false when the editor does not accept text.
 */
export function insertIntoEditor(editor: any, text: string): boolean {
  if (!editor || typeof editor.insertText !== "function") return false
  try {
    const current = typeof editor.plainText === "string" ? editor.plainText : ""
    const needsSpace = current.length > 0 && !/\s$/.test(current) && !/^\s/.test(text)
    if (typeof editor.gotoBufferEnd === "function") editor.gotoBufferEnd()
    editor.insertText(needsSpace ? ` ${text}` : text)
    return true
  } catch {
    return false
  }
}

/** Turn a markdown answer into something worth listening to. */
export function speakable(text: string, limit = 0): string {
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
  // Read long answers in full. Callers that need a preview can pass an
  // explicit limit; the voice buttons deliberately do not truncate.
  if (limit > 0 && out.length > limit) {
    const cut = out.slice(0, limit)
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "))
    out = stop > limit * 0.4 ? cut.slice(0, stop + 1) : `${cut}...`
  }
  // A reply that was only code or punctuation leaves nothing sayable.
  if (out.replace(/\(code\)/g, " ").replace(/[\s.,:;!?()\-–—…"']/g, "").length < 2) return ""
  return out
}

/**
 * How much of a streaming answer can be read out loud right now.
 *
 * Only whole sentences count, and nothing inside a fenced code block, so a
 * half-written word or a fragment of code is never spoken. The rest of the
 * answer follows as soon as the model writes it.
 */
export function speechCut(text: string): number {
  if (!text) return 0
  let fence = false
  let inlineCode = false
  let cut = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    // A fence only opens at the start of a line.
    if (ch === "`" && text.startsWith("```", i) && (i === 0 || text[i - 1] === "\n")) {
      fence = !fence
      const lineEnd = text.indexOf("\n", i)
      if (lineEnd < 0) break // the fence line is not finished yet
      i = lineEnd
      continue
    }
    if (fence) continue
    if (ch === "`") {
      inlineCode = !inlineCode
      continue
    }
    if (inlineCode) continue
    if (ch === "\n") {
      // A paragraph break is a natural place to start speaking.
      if (text[i + 1] === "\n") cut = i + 1
      continue
    }
    if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
      const next = text[i + 1] ?? ""
      if (next === "" || /\s/.test(next)) cut = i + 1
    }
  }
  return cut
}

/* ------------------------------------------------------------------ controller */

export function createVoiceController(context: any) {
  const [mic, setMic] = createSignal<MicState>("idle")
  const [speech, setSpeech] = createSignal<SpeechState>("idle")
  // Live voice: the mic keeps listening, every turn is sent on its own and
  // the answer is read back, until the user switches it off again.
  const [live, setLive] = createSignal(false)
  // What the microphone is hearing right now, as the live caption. Empty
  // while nothing is being said.
  const [liveCaption, setLiveCaptionSignal] = createSignal("")
  // Which message the current playback belongs to. The composer button and
  // the per-message buttons read this to decide between read/pause/resume.
  const [speakingMessage, setSpeakingMessage] = createSignal<string | null>(null)

  // The host's own TextRenderable class, captured from a mounted button.
  // `message-buttons.ts` must instantiate the host's classes, not a second copy
  // from the plugin's node_modules, or the renderer lays the node out without
  // ever drawing it.
  let hostTextClass: any = null

  // The host's prompt box is a focused text editor. Clicking the mic button
  // can take the focus away from it, so remember the last editor that was
  // focused: the transcript still has to land in the prompt box.
  let lastPromptEditor: any = null
  try {
    const renderer: any = context.renderer
    renderer?.on?.("focused_editor", (editor: any) => {
      if (editor) lastPromptEditor = editor
    })
  } catch {
    /* older hosts: the currently focused editor is enough */
  }

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

  /** The live caption: what the microphone is hearing, as it hears it. */
  function setLiveCaption(value: string): void {
    const next = String(value ?? "").replace(/\s+/g, " ").trim()
    if (liveCaption() === next) return
    setLiveCaptionSignal(next)
    repaint()
  }

  let autoSpeak = context.options?.autoSpeak !== false
  // The moment the plugin started: answers from before that were already
  // seen (or already read) and must not be spoken again.
  const startedAt = Date.now()
  // Answers that were read out loud, so the watcher never repeats one.
  const spokenAnswers = new Set<string>()
  // The newest answer seen per session.
  const seenAnswers = new Map<string, string>()
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
  const optionStt = context.options?.stt ?? context.options?.speechToText ?? {}
  const seedSettings: VoiceSettings = {
    ttsProvider: String(optionFish.provider ?? context.options?.ttsProvider ?? "local") === "fish" ? "fish" : "local",
    fishApiKey: String(optionFish.apiKey ?? context.options?.fishApiKey ?? ""),
    fishVoiceId: String(optionFish.voiceId ?? context.options?.fishVoiceId ?? ""),
    fishVoiceName: String(optionFish.voiceName ?? ""),
    fishModel: String(optionFish.model ?? context.options?.fishModel ?? FISH_MODEL),
    sttProvider: String(optionStt.provider ?? context.options?.sttProvider ?? optionFish.sttProvider ?? "local") === "fish" ? "fish" : "local",
    fishSttModel: normalizeSttModel(optionStt.model ?? context.options?.fishSttModel ?? optionFish.sttModel),
    fishSttLanguage: normalizeSttLanguage(optionStt.language ?? context.options?.fishSttLanguage ?? optionFish.sttLanguage),
    localModel: normalizeLocalModel(optionStt.localModel ?? context.options?.localModel ?? optionFish.localModel),
    localLanguage: normalizeSttLanguage(optionStt.localLanguage ?? context.options?.localLanguage ?? optionFish.localLanguage),
    autoSend: context.options?.autoSend === true,
    autoSpeak: context.options?.autoSpeak !== false,
    micSource: String(context.options?.micSource ?? context.options?.mic ?? "").trim(),
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
      // Keep the live Solid store object; replacing it with a plain object
      // would stop reflecting later setStored() mutations. Settings created
      // before Fish STT existed are missing the new fields, so backfill them
      // in place without touching the user's TTS choice.
      settings = stored
      saveSettings = setStored
      const needsMigration =
        (stored.sttProvider !== "local" && stored.sttProvider !== "fish") ||
        !stored.fishSttModel ||
        typeof stored.fishSttLanguage !== "string" ||
        typeof stored.localModel !== "string" ||
        typeof stored.localLanguage !== "string" ||
        typeof stored.autoSend !== "boolean" ||
        typeof stored.autoSpeak !== "boolean" ||
        typeof stored.micSource !== "string"
      if (needsMigration) {
        void setStored((draft) => {
          if (draft.sttProvider !== "local" && draft.sttProvider !== "fish") {
            draft.sttProvider = seedSettings.sttProvider
          }
          draft.fishSttModel = normalizeSttModel(draft.fishSttModel ?? seedSettings.fishSttModel)
          draft.fishSttLanguage = normalizeSttLanguage(draft.fishSttLanguage ?? seedSettings.fishSttLanguage)
          draft.localModel = normalizeLocalModel(draft.localModel ?? seedSettings.localModel)
          draft.localLanguage = normalizeSttLanguage(draft.localLanguage ?? seedSettings.localLanguage)
          // Review first: the transcript lands in the prompt box.
          if (typeof draft.autoSend !== "boolean") draft.autoSend = seedSettings.autoSend
          if (typeof draft.autoSpeak !== "boolean") draft.autoSpeak = seedSettings.autoSpeak
          if (typeof draft.micSource !== "string") draft.micSource = seedSettings.micSource
        }).catch(() => {
          /* defaults still apply in memory */
        })
      }
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

  function sttRequest(live = false): SttOptions {
    // Always send an explicit backend: it lets the TUI override a daemon
    // environment that defaults to Fish, and local selection must stay local.
    if (settings.sttProvider !== "fish") {
      return {
        backend: "local",
        local: {
          model: normalizeLocalModel(settings.localModel),
          language: normalizeSttLanguage(settings.localLanguage),
          // Live: understand whatever language is spoken on the first try,
          // with the fastest decoding settings.
          ...(live ? { live: true, beam: 1 } : {}),
        },
      }
    }
    return {
      backend: "fish",
      fish: {
        apiKey: (settings.fishApiKey || "").trim(),
        model: normalizeSttModel(settings.fishSttModel),
        language: normalizeSttLanguage(settings.fishSttLanguage),
      },
    }
  }

  function sttReady(): boolean {
    return settings.sttProvider !== "fish" || Boolean((settings.fishApiKey || "").trim())
  }

  /* --------------------------------------------------------- microphone */

  /** The microphone the user picked; "" means "let the daemon choose". */
  function micRequest(): MicOptions {
    return { device: (settings.micSource || "").trim() }
  }

  function micLabel(): string {
    const id = (settings.micSource || "").trim()
    if (!id) return "Automatic (the daemon picks the best microphone)"
    return id
  }

  function sttLabel(): string {
    if (settings.sttProvider !== "fish") {
      const model = normalizeLocalModel(settings.localModel)
      const language = sttLanguageName(normalizeSttLanguage(settings.localLanguage))
      return `Local Whisper · ${model ? model : "auto"} · ${language}`
    }
    const model = normalizeSttModel(settings.fishSttModel)
    const language = sttLanguageName(normalizeSttLanguage(settings.fishSttLanguage))
    const key = (settings.fishApiKey || "").trim()
    return `Fish Audio · ${model} · ${language}${key ? "" : " · key needed"}`
  }

  /* ------------------------------------------------------- prompt box */

  function promptEditor(): any {
    const renderer: any = context.renderer
    const focused = renderer?.currentFocusedEditor
    if (focused && typeof focused.insertText === "function" && !focused.isDestroyed) return focused
    if (lastPromptEditor && typeof lastPromptEditor.insertText === "function" && !lastPromptEditor.isDestroyed) {
      return lastPromptEditor
    }
    return null
  }

  /**
   * Put the transcript into the host's prompt box so the user can correct it
   * and send it with the usual key. Returns false when the TUI does not
   * expose an editable prompt.
   */
  function insertIntoPrompt(text: string): boolean {
    const editor = promptEditor()
    if (!insertIntoEditor(editor, text)) return false
    try {
      const renderer: any = context.renderer
      renderer?.requestRender?.()
      // Hand the focus back to the prompt so the transcript can be edited.
      try {
        if (renderer?.currentFocusedEditor !== editor) editor.focus?.()
      } catch {
        /* focus is a nicety, the text is already in */
      }
    } catch {
      /* rendering is best effort */
    }
    return true
  }

  /* --------------------------------------------------------- auto send */

  function autoSendEnabled(): boolean {
    return settings.autoSend === true
  }

  async function toggleAutoSend(): Promise<void> {
    const next = !autoSendEnabled()
    await persist((draft) => {
      draft.autoSend = next
    })
    toast(
      next
        ? "Transcripts are sent to the agent automatically"
        : "Transcripts land in the prompt box — review and send them yourself",
      next ? "success" : "info",
    )
  }

  function healthSummary(h: Health): string {
    const bits = summarize(h).split(" | ")
    if (settings.sttProvider === "fish") {
      const idx = bits.findIndex((part) => part.startsWith("stt: "))
      const label = `stt: Fish Audio (${normalizeSttModel(settings.fishSttModel)})`
      if (idx >= 0) bits[idx] = label
      else bits.push(label)
    }
    return bits.join(" | ")
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
    toast("Fish Audio key saved.", "success")
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

  /**
   * Pick a language hint. The same list works for the local Whisper model
   * and for Fish ASR; only the wording differs.
   */
  async function chooseLanguageHint(opts: {
    title: string
    current: string
    autoTitle: string
    autoDescription: string
    hintDescription: string
    apply: (code: string) => Promise<void> | void
  }): Promise<void> {
    const options: Array<{ title: string; value: string; description?: string }> = [
      {
        title: opts.autoTitle,
        value: "__auto__",
        description: opts.autoDescription,
      },
      ...FISH_STT_LANGUAGES.map((item) => ({
        title: `${item.name} (${item.code})`,
        value: item.code,
        description: `ISO 639-1 hint: ${item.code}`,
      })),
      {
        title: "Other ISO 639-1 code…",
        value: "__other__",
        description: "Type any two-letter language code",
      },
    ]
    const picked: string | undefined = await context.ui.dialog.select({
      title: opts.title,
      placeholder: "Type to filter, then choose a language",
      options,
      current: opts.current || "__auto__",
    })
    if (picked === undefined) return

    if (picked === "__auto__") {
      await opts.apply("")
      toast("The language will be detected automatically", "success")
      return
    }
    if (picked === "__other__") {
      if (!context.ui?.dialog?.prompt) {
        toast("This TUI cannot prompt for a language code", "warning")
        return
      }
      const raw = await context.ui.dialog.prompt({
        title: `${opts.title} code`,
        description: "Enter a lowercase ISO 639-1 code, e.g. en, es, zh, ja.",
        placeholder: "two-letter code",
        value: opts.current || "",
      })
      if (raw === undefined) return
      const text = raw.trim().toLowerCase()
      if (!text || text === "auto") {
        await opts.apply("")
        toast("The language will be detected automatically", "success")
        return
      }
      const code = normalizeSttLanguage(text)
      if (!code) {
        toast("Use a two-letter ISO 639-1 code such as en, es, zh, or ja", "warning")
        return
      }
      await opts.apply(code)
      toast(`${opts.hintDescription}: ${sttLanguageName(code)} (${code})`, "success")
      return
    }

    const code = normalizeSttLanguage(picked)
    if (!code) return
    await opts.apply(code)
    toast(`${opts.hintDescription}: ${sttLanguageName(code)} (${code})`, "success")
  }

  async function chooseFishSttLanguage(): Promise<void> {
    await chooseLanguageHint({
      title: "Fish Audio STT language",
      current: settings.fishSttLanguage,
      autoTitle: "Auto-detect (recommended)",
      autoDescription: "Fish detects the spoken language; works across its 80+ supported languages",
      hintDescription: "Fish Audio STT language hint",
      apply: async (code) => {
        await persist((draft) => {
          draft.fishSttLanguage = code
        })
      },
    })
  }

  async function chooseLocalLanguage(): Promise<void> {
    await chooseLanguageHint({
      title: "Local Whisper language",
      current: settings.localLanguage,
      autoTitle: "Auto-detect (recommended)",
      autoDescription: "Whisper picks the language; needs a multilingual model",
      hintDescription: "Local Whisper language hint",
      apply: async (code) => {
        await persist((draft) => {
          draft.localLanguage = code
        })
      },
    })
  }

  async function openSttSettings(): Promise<void> {
    if (!context.ui?.dialog?.select) {
      await showVoiceInfo("stt")
      return
    }
    for (;;) {
      const key = (settings.fishApiKey || "").trim()
      const provider = settings.sttProvider
      const model = normalizeSttModel(settings.fishSttModel)
      const language = sttLanguageName(normalizeSttLanguage(settings.fishSttLanguage))
      const localModel = normalizeLocalModel(settings.localModel)
      const localLanguage = sttLanguageName(normalizeSttLanguage(settings.localLanguage))
      const choice: string | undefined = await context.ui.dialog.select({
        title: "Speech-to-text",
        placeholder: "Choose how the microphone is transcribed",
        options: [
          {
            title: provider === "local" ? "Local Whisper (active)" : "Use local Whisper",
            value: "local",
            description: "Private and offline; audio never leaves the device",
          },
          {
            title: provider === "fish" ? "Fish Audio (active)" : "Use Fish Audio speech-to-text",
            value: "fish",
            description: key
              ? `Cloud ASR · key ${maskKey(key)} · audio is uploaded · uses API credit`
              : "Cloud ASR · needs an API key and API credit",
          },
          {
            title: "Local Whisper model",
            value: "localmodel",
            description: localModel
              ? `${localModel} · ${LOCAL_MODELS.find((m) => m.id === localModel)?.description ?? ""}`
              : "Automatic · tiny.en, with a multilingual retry",
          },
          {
            title: "Local Whisper language",
            value: "locallanguage",
            description: `${localLanguage} · auto-detect is recommended`,
          },
          {
            title: "Fish Audio ASR model",
            value: "model",
            description: model === "transcribe-1-pro" ? "transcribe-1-pro (recommended)" : "transcribe-1",
          },
          {
            title: "Fish Audio language",
            value: "language",
            description: `${language} · auto-detect is recommended`,
          },
          {
            title: "Fish Audio API key",
            value: "key",
            description: key ? `Current: ${maskKey(key)}` : "Not set",
          },
          { title: "Done", value: "done" },
        ],
      })
      if (choice === undefined || choice === "done") return

      if (choice === "local") {
        await persist((draft) => {
          draft.sttProvider = "local"
        })
        toast("Speech-to-text: local Whisper (audio stays on this device)", "success")
      } else if (choice === "fish") {
        if (!(settings.fishApiKey || "").trim()) {
          const saved = await setFishKey()
          if (!saved) continue
        }
        await persist((draft) => {
          draft.sttProvider = "fish"
        })
        toast(
          "Fish Audio will transcribe the mic. Audio is sent to api.fish.audio; local Whisper is off. ASR uses API credit separate from the free TTS model.",
          "warning",
        )
      } else if (choice === "model") {
        const picked: string | undefined = await context.ui.dialog.select({
          title: "Fish Audio ASR model",
          placeholder: "Choose the speech-to-text model",
          current: model,
          options: [
            {
              title: "transcribe-1-pro (recommended)",
              value: "transcribe-1-pro",
              description: "80+ languages, long audio, speaker labels; best accuracy",
            },
            {
              title: "transcribe-1",
              value: "transcribe-1",
              description: "Short recordings; lighter response without speaker labels",
            },
          ],
        })
        if (picked) {
          await persist((draft) => {
            draft.fishSttModel = normalizeSttModel(picked)
          })
          toast(`Fish Audio ASR model: ${normalizeSttModel(picked)}`, "success")
        }
      } else if (choice === "language") {
        await chooseFishSttLanguage()
      } else if (choice === "localmodel") {
        const picked: string | undefined = await context.ui.dialog.select({
          title: "Local Whisper model",
          placeholder: "Choose the on-device model",
          current: localModel,
          options: LOCAL_MODELS.map((m) => ({
            title: m.title,
            value: m.id,
            description: m.description,
          })),
        })
        if (picked !== undefined) {
          await persist((draft) => {
            draft.localModel = normalizeLocalModel(picked)
          })
          const name = normalizeLocalModel(picked) || "automatic"
          toast(`Local Whisper model: ${name}`, "success")
        }
      } else if (choice === "locallanguage") {
        await chooseLocalLanguage()
      } else if (choice === "key") {
        await setFishKey()
      }
    }
  }

  async function showVoiceInfo(kind: "mic" | "stt" | "status"): Promise<void> {
    if (kind === "stt" && settings.sttProvider === "fish") {
      const ready = sttReady()
      toast(
        `Transcription: ${sttLabel()}${ready ? "" : " — add the key in Voice: settings"}`,
        ready ? "info" : "warning",
      )
      return
    }
    const info = await daemonOrToast()
    if (!info) return
    try {
      const h: Health = await api.health(info, true)
      if (kind === "status") {
        toast(healthSummary(h), "info")
        return
      }
      if (kind === "mic") {
        const cap: any = h.audio?.capture
        const chosen = (settings.micSource || "").trim()
        toast(
          cap?.backend
            ? `Microphone: ${cap.backend}${cap.rms != null ? ` (level ${Number(cap.rms).toFixed(3)})` : ""}` +
              `${chosen ? ` · ${chosen}` : " · automatic"}`
            : "No working microphone found",
          cap?.backend ? "info" : "error",
        )
        return
      }
      const picked = h.stt?.backends?.find((b: any) => b.backend === h.stt?.picked)
      const model = picked?.model ? String(picked.model).split("/").pop() : ""
      const chosen = normalizeLocalModel(settings.localModel)
      const language = sttLanguageName(normalizeSttLanguage(settings.localLanguage))
      toast(
        `Transcription: ${h.stt?.picked ?? "none"}${model ? ` · ${model}` : ""} · local` +
          `${chosen ? ` · ${chosen}` : ""} · ${language}`,
        "info",
      )
    } catch (e) {
      toast(errorText(e), "error")
    }
  }

  /**
   * Pick the microphone. The list comes from the daemon, so it shows every
   * input the system can offer: PulseAudio sources (the Android phone mic
   * over SLES, the Termux:API bridge), the Termux:API recorder, PortAudio
   * inputs and ALSA capture devices.
   */
  async function openMicSettings(): Promise<void> {
    if (!context.ui?.dialog?.select) {
      await showVoiceInfo("mic")
      return
    }
    const info = await daemonOrToast()
    if (!info) return
    let choices: MicChoice[] = []
    try {
      const devices = await api.devices(info)
      choices = devices?.choices ?? []
    } catch (e) {
      toast(`Could not list the microphones: ${errorText(e)}`, "error")
      return
    }
    if (!choices.length) {
      toast("The daemon did not report any microphones", "warning")
      return
    }

    for (;;) {
      const current = (settings.micSource || "").trim()
      const options: Array<{ title: string; value: string; description?: string }> = choices.map((c) => {
        const active = c.id === current
        const missing = c.available === false
        return {
          title: `${active ? "● " : ""}${c.label}`,
          value: c.id,
          description: [c.detail, missing ? "not available here" : "", active ? "active" : ""]
            .filter(Boolean)
            .join(" · "),
        }
      })
      options.push({ title: "Test this microphone", value: "__test__", description: "Measure the input level for a second" })
      options.push({ title: "Show microphone status", value: "__status__" })
      options.push({ title: "Done", value: "done" })

      const choice: string | undefined = await context.ui.dialog.select({
        title: "Microphone",
        placeholder: "Choose the microphone to record from",
        options,
        current: current || "__auto__",
      })
      if (choice === undefined || choice === "done") return

      if (choice === "__test__") {
        await testMicrophone(info, current)
        continue
      }
      if (choice === "__status__") {
        await showVoiceInfo("mic")
        continue
      }
      await persist((draft) => {
        draft.micSource = choice
      })
      const picked = choices.find((c) => c.id === choice)
      toast(`Microphone: ${picked?.label ?? choice}`, "success")
    }
  }

  /** Measure the level of the chosen microphone without recording a turn. */
  async function testMicrophone(info: DaemonInfo, device: string): Promise<void> {
    toast("Measuring the microphone…", "info")
    try {
      const res = (await api.probe(info, { device })) as { capture?: { backend?: string; rms?: number; reason?: string } }
      const cap = res?.capture ?? {}
      if (!cap.backend) {
        toast(`No working microphone: ${cap.reason ?? "unknown reason"}`, "error")
        return
      }
      const level = typeof cap.rms === "number" ? cap.rms : 0
      toast(
        `Microphone ${cap.backend}: level ${level.toFixed(4)}` +
          (level > 0.01 ? " — it is hearing you" : " — nothing yet, speak and test again"),
        level > 0.01 ? "success" : "warning",
      )
    } catch (e) {
      toast(`Could not test the microphone: ${errorText(e)}`, "error")
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
            description: micLabel(),
          },
          { title: "Transcription", value: "stt", description: sttLabel() },
          {
            title: autoSendEnabled() ? "Auto-send transcripts (on)" : "Auto-send transcripts (off)",
            value: "autosend",
            description: autoSendEnabled()
              ? "Transcripts are sent to the agent as soon as they are transcribed"
              : "Transcripts land in the prompt box so you can correct them before sending",
          },
          {
            title: autoSpeak ? "Speaking replies (on)" : "Speaking replies (off)",
            value: "autospeak",
            description: autoSpeak
              ? "Every new answer is read out loud, starting with the session name"
              : "Answers stay silent",
          },
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
      } else if (choice === "stt") {
        await openSttSettings()
      } else if (choice === "autosend") {
        await toggleAutoSend()
      } else if (choice === "autospeak") {
        toggleAutoSpeak()
      } else if (choice === "mic") {
        await openMicSettings()
      } else if (choice === "status") {
        await showVoiceInfo(choice)
      }
    }
  }

  async function preload(): Promise<void> {
    const info = await daemonOrToast()
    if (!info) return
    if (!sttReady()) {
      toast("Fish Audio STT needs an API key — open Voice: settings → Transcription", "warning")
      return
    }
    try {
      await api.warmup(info, sttRequest())
      toast(
        settings.sttProvider === "fish"
          ? "Fish Audio STT is cloud-hosted; no local model needs loading"
          : "Speech model ready — transcription will be quick",
        "success",
      )
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

  let hostVersion: string | null = null

  /** The host version, so the prompt API is called in the right shape. */
  async function hostVersionString(): Promise<string> {
    if (hostVersion !== null) return hostVersion
    try {
      const info: any = await (context.client as any)?.server?.info?.()
      hostVersion = String(info?.version ?? "")
    } catch {
      hostVersion = ""
    }
    return hostVersion
  }

  function atLeast(version: string, major: number, minor: number): boolean {
    const parts = version.split(".").map((p) => Number(p) || 0)
    const vMajor = parts[0] ?? 0
    const vMinor = parts[1] ?? 0
    if (vMajor !== major) return vMajor > major
    return vMinor >= minor
  }

  /**
   * Does the host expose its own "submit the prompt" command?
   *
   * That command is what Enter does. Using it means the transcript travels
   * the same way a typed message does, which is the only way to send from a
   * brand new chat: there is no session id yet until the first message is
   * sent.
   */
  function hostSubmitCommand(): string | null {
    try {
      const commands = context.keymap?.commands?.() ?? []
      for (const command of commands as any[]) {
        if (command?.id === "prompt.submit") return "prompt.submit"
        if (command?.id === "input.submit") return "input.submit"
      }
    } catch {
      /* the keymap is not available */
    }
    return null
  }

  /**
   * Type the transcript into the prompt and let the host send it - exactly
   * what pressing Enter does.
   *
   * This is the only way to send from a brand new chat: there is no session
   * id until the first message is sent. A real submit empties the prompt
   * box, so that is used to confirm it worked.
   */
  async function submitViaHost(text: string): Promise<boolean> {
    const command = hostSubmitCommand() ?? "prompt.submit"
    if (!insertIntoPrompt(text)) return false
    try {
      context.keymap?.dispatch?.(command)
    } catch {
      try {
        context.keymap?.dispatch?.("prompt.clear")
      } catch {
        /* nothing else to do */
      }
      return false
    }
    await sleep(150)
    const after = promptEditor()
    if (after && typeof after.plainText === "string" && after.plainText.trim() === text.trim()) {
      // The words are still in the box: the host did not send them.
      try {
        context.keymap?.dispatch?.("prompt.clear")
      } catch {
        /* nothing else to do */
      }
      return false
    }
    return true
  }

  /**
   * Send the transcript as the user's message - the same thing pressing
   * Enter in the prompt does.
   *
   * The host's own submit is preferred: the text is typed into the prompt
   * and the host sends it. That works in a new chat, where no session exists
   * yet, and it keeps the TUI in step with what was sent.
   *
   * The client API is the fallback. OpenCode 2.1 moved the prompt text into
   * `text.text`; 2.0 took a plain string. Sending the wrong shape posts an
   * empty message, which is why auto-send used to end up as a toast with the
   * words instead of a message.
   */
  async function submit(sessionID: string | undefined, text: string): Promise<boolean> {
    if (await submitViaHost(text)) return true

    const client: any = context.client
    if (!sessionID || typeof client?.session?.prompt !== "function") {
      // Last resort: leave the text where the user can use it.
      toast(`Transcript (copy it into the prompt): ${text}`, "warning")
      return false
    }
    const version = await hostVersionString()
    const modern = version ? atLeast(version, 2, 1) : true
    const shapes: Array<Record<string, unknown>> = modern
      ? [{ sessionID, text: { text } }, { sessionID, id: { text } }]
      : [{ sessionID, text }, { path: { sessionID }, body: { text } }]
    const errors: string[] = []
    for (const shape of shapes) {
      try {
        const res = await client.session.prompt(shape)
        const sent = typeof res?.payload?.text === "string" ? res.payload.text : undefined
        if (sent !== undefined && sent.trim() !== text.trim()) {
          errors.push("the host posted a different message")
          continue
        }
        if (res === undefined || res === null) {
          errors.push("the host returned nothing")
          continue
        }
        return true
      } catch (e) {
        errors.push(errorText(e))
      }
    }
    toast(`Could not send the transcript: ${errors[0] ?? "unknown error"}`, "error")
    toast(`Transcript (copy it into the prompt): ${text}`, "warning")
    return false
  }

  /* ------------------------------------------------------- speak the reply */

  /**
   * Wait until the answer has been read out loud.
   *
   * A live conversation must not open the microphone again while the speaker
   * is still talking, or the voice hears itself. The answer is read while it
   * streams, so this waits for the *last* sentence, not the first.
   */
  async function waitUntilRead(sessionID: string | undefined): Promise<void> {
    if (!sessionID) return
    let started = false
    let quiet = 0
    for (let i = 0; i < 1600; i++) {
      if (liveStop) return
      let status: string | undefined
      try {
        status = context.data.session.status(sessionID)
      } catch {
        status = undefined
      }
      if (status === "busy") started = true
      // The agent never picked the message up: nothing will be read.
      if (!started && i > 40) return
      const info = await daemon(false)
      if (!info) return
      const state = await api.speech(info).catch(() => null)
      const speaking = state?.active === true
      if (started && status !== "busy" && !speaking && !answerCheck && !answerAgain) {
        quiet += 1
        if (quiet >= 2) return
      } else {
        quiet = 0
      }
      await sleep(250)
    }
  }

  /* ------------------------------------------------- reading the answers */

  /** The name of the session, read out before its answer. */
  function sessionLabel(sessionID: string): string {
    try {
      const info: any = context.data.session.get?.(sessionID)
      const title = String(info?.title ?? "").trim()
      if (!title) return ""
      return title.length > 80 ? `${title.slice(0, 79)}…` : title
    } catch {
      return ""
    }
  }

  /**
   * Speak one piece of a reply.
   *
   * The piece is *appended* to the daemon's speech queue, so the parts of an
   * answer that is still being written are read in order, without one
   * sentence cutting off the one before it and without any gap.
   */
  async function speakChunk(sessionID: string, text: string, messageID?: string): Promise<void> {
    const body = speakable(text)
    if (!body) return
    const info = await daemon(false)
    if (!info) return
    try {
      await api.speak(info, body, { async: true, append: true, ...ttsRequest() })
      setSpeakingMessage(messageID ?? null)
      setSpeechState("playing")
      watchSpeech()
    } catch (e) {
      toast(`Could not speak the reply: ${errorText(e)}`, "error")
    }
  }

  /* ------------------------------------------------------ auto speak watcher */

  let answerTimer: ReturnType<typeof setTimeout> | undefined
  let answerCheck: Promise<void> | undefined
  let answerAgain = false

  /**
   * How much of each answer has already been handed to the speaker.
   *
   * Live mode reads a reply while it is being written; this remembers where
   * the last sentence ended, so the next check continues from there instead
   * of reading the same words twice.
   */
  const readProgress = new Map<string, { spoken: number; labelDone: boolean }>()

  /** Look for a new answer in the session that is on screen and read it. */
  async function checkForNewAnswer(): Promise<void> {
    const sessionID = currentSessionID(context)
    if (!sessionID) return
    let answer: { id?: string; text: string; created?: number }
    try {
      await context.data.session.message.sync(sessionID)
      answer = latestAnswer(context.data.session.message.list(sessionID) ?? [])
    } catch {
      return
    }
    const id = answer.id
    if (!id || !answer.text) return

    let status: string | undefined
    try {
      status = context.data.session.status(sessionID)
    } catch {
      status = undefined
    }
    const writing = status === "busy"
    // A live conversation reads the answer while it is written, the way a
    // phone call would: the first sentence starts long before the last one
    // exists. Everywhere else the whole answer is read once it is complete.
    const streaming = live() && autoSpeak
    const progress = readProgress.get(id)

    if (!progress) {
      if (seenAnswers.get(sessionID) === id) return
      if (spokenAnswers.has(id)) {
        seenAnswers.set(sessionID, id)
        return
      }
      if (answer.created && answer.created < startedAt) {
        // An answer that was already there when the plugin started: it was
        // seen, and probably read, before.
        seenAnswers.set(sessionID, id)
        return
      }
      if (writing && !streaming) return // the answer is still being written
    }

    if (!autoSpeak) {
      if (!writing) {
        seenAnswers.set(sessionID, id)
        spokenAnswers.add(id)
      }
      return
    }

    // Speak up to the last complete sentence, never a half-written one and
    // never a piece of code.
    const cut = writing && streaming ? speechCut(answer.text) : answer.text.length
    const next = progress ?? { spoken: 0, labelDone: false }
    if (cut > next.spoken) {
      const piece = answer.text.slice(next.spoken, cut)
      const label = next.labelDone ? "" : sessionLabel(sessionID)
      next.spoken = cut
      next.labelDone = true
      seenAnswers.set(sessionID, id)
      if (writing) readProgress.set(id, next)
      await speakChunk(sessionID, label ? `${label}. ${piece}` : piece, id)
    }

    if (writing) {
      // More is coming: look again as soon as the next sentence lands.
      scheduleAnswerCheck(350)
      return
    }

    readProgress.delete(id)
    seenAnswers.set(sessionID, id)
    spokenAnswers.add(id)
  }

  function scheduleAnswerCheck(delay = 400): void {
    if (answerTimer) clearTimeout(answerTimer)
    answerTimer = setTimeout(() => {
      answerTimer = undefined
      if (answerCheck) {
        // A check is already reading; ask it to look again when it is done.
        answerAgain = true
        return
      }
      answerCheck = checkForNewAnswer()
        .catch(() => undefined)
        .finally(() => {
          answerCheck = undefined
          if (answerAgain) {
            answerAgain = false
            scheduleAnswerCheck(150)
          }
        })
    }, delay)
  }

  /**
   * Watch the session for new answers and read them out loud.
   *
   * The TUI plugin lives in the session view, so this follows the session the
   * user is working in - including after switching to another one.
   */
  let stopAnswers: (() => void) | undefined
  function watchAnswers(): () => void {
    let off: (() => void) | undefined
    try {
      off = context.data?.listen?.((event: any) => {
        const type = String(event?.details?.type ?? "")
        if (!type) return
        if (type.startsWith("message.") || type.startsWith("session.")) scheduleAnswerCheck()
      })
    } catch {
      off = undefined
    }
    // Catch answers that arrive without an event we listen to.
    const poll = setInterval(() => scheduleAnswerCheck(200), 2000)
    return () => {
      if (answerTimer) clearTimeout(answerTimer)
      clearInterval(poll)
      off?.()
    }
  }

  async function speakReply(sessionID: string | undefined): Promise<void> {
    if (!sessionID) return

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

    let answer: { id?: string; text: string; created?: number } = { text: "" }
    try {
      await context.data.session.message.sync(sessionID)
      answer = latestAnswer(context.data.session.message.list(sessionID) ?? [])
    } catch {
      /* fall through with whatever we have */
    }
    if (!answer.text) return
    const toSay = speakable(answer.text)
    if (!toSay) return
    // An explicit request: it takes the speaker from whatever was being read.
    const info = await daemon(false)
    if (!info) return
    await api.speak(info, toSay, { async: true, ...ttsRequest() })
    setSpeakingMessage(answer.id ?? null)
    setSpeechState("playing")
    watchSpeech()
  }

  /** The current session, waiting for one to show up (a new chat has none). */
  async function resolveSessionID(timeoutMs = 4000): Promise<string | undefined> {
    const steps = Math.max(1, Math.round(timeoutMs / 200))
    for (let i = 0; i < steps; i++) {
      const id = currentSessionID(context)
      if (id) return id
      await sleep(200)
    }
    return undefined
  }

  /* ------------------------------------------------------- live voice mode */

  let liveStop = false
  let liveBusy = false

  /** Switch the live conversation off and drop the capture in progress. */
  function stopLive(): void {
    liveStop = true
    setLiveCaption("")
    setLive(false)
    void (async () => {
      try {
        const info = await daemon(false)
        if (info) await api.pttCancel(info)
      } catch {
        /* the daemon is going away anyway */
      }
    })()
  }

  /**
   * Record one live turn and hand back the transcript.
   *
   * The turn ends on a short silence (a phone call does not wait a full
   * second after a sentence), the words are transcribed while they are spoken
   * for the caption, and the microphone stream stays open for the next turn.
   * Returns "" when nothing was heard or the turn was cancelled.
   */
  async function recordOneTurn(info: DaemonInfo): Promise<string> {
    setLiveCaption("")
    await api.pttStart(info, 120000, sttRequest(true), micRequest(), {
      silenceMs: LIVE_SILENCE_MS,
      startTimeoutMs: 120000,
      partial: true,
      keepWarm: true,
    })
    for (let i = 0; i < 4800; i++) {
      if (liveStop) return ""
      await sleep(120)
      const state = await api.pttState(info).catch(() => null)
      const ptt = state?.ptt
      const st = ptt?.state
      if (typeof ptt?.partial === "string" && ptt.partial) setLiveCaption(ptt.partial)
      if (st === "transcribing") {
        setMicState("transcribing")
        // The final words replace the caption, so nothing flickers twice.
        setLiveCaption("")
      }
      if (!st || (st !== "listening" && st !== "transcribing")) break
    }
    if (liveStop) {
      setLiveCaption("")
      await api.pttCancel(info).catch(() => undefined)
      return ""
    }
    const res = await api.pttStop(info, 150000).catch(() => null)
    setLiveCaption("")
    if (res === null) return ""
    return transcriptText(res)
  }

  /**
   * Live voice conversation: listen, send, read the answer, listen again.
   * Runs until the user switches it off.
   */
  async function liveConversation(sessionID: string | undefined): Promise<void> {
    let sid = sessionID
    let lastMicError = ""
    while (!liveStop) {
      const info = await daemon(true)
      if (!info) return
      if (!sid) sid = currentSessionID(context) ?? undefined
      setMicState("listening")
      let text = ""
      try {
        text = await recordOneTurn(info)
      } catch (e) {
        // A microphone that cannot be opened must not end the conversation:
        // say why once, wait a moment, and keep listening. The user can stop
        // live mode or pick another device in the settings.
        setMicState("idle")
        setLiveCaption("")
        const why = errorText(e)
        if (why !== lastMicError) {
          toast(`Live microphone: ${why}`, "error")
          lastMicError = why
        }
        await sleep(1500)
        continue
      }
      lastMicError = ""
      setMicState("idle")
      if (liveStop) return
      if (!text) continue // nothing was heard: keep listening
      const sent = await submit(sid, text)
      if (!sent) continue
      // A chat that started on the home screen only gets a session id when
      // the first message is sent.
      if (!sid) sid = await resolveSessionID()
      // The answer is read while it streams. Wait for the last sentence to
      // finish, then listen again immediately: the microphone was kept open,
      // so there is no device pause between the turns.
      if (sid) await waitUntilRead(sid)
    }
  }

  async function toggleLive(forcedSessionID?: string): Promise<void> {
    if (live()) {
      stopLive()
      toast("Live voice off", "info")
      return
    }
    if (liveBusy) return
    const info = await daemonOrToast()
    if (!info) return
    liveBusy = true
    liveStop = false
    setLive(true)
    const mic = (settings.micSource || "").trim() || "automatic microphone"
    toast(
      `Live voice on (${mic}) — like a phone call: pause to send, the answer is spoken as it arrives. Click again to stop.`,
      "success",
    )
    try {
      await liveConversation(forcedSessionID ?? currentSessionID(context))
    } catch (e) {
      toast(errorText(e), "error")
    } finally {
      setLive(false)
      liveBusy = false
    }
  }

  /* -------------------------------------------------------- push to talk */

  async function toggleMic(forcedSessionID?: string): Promise<void> {
    const sessionID = forcedSessionID ?? currentSessionID(context)

    if (live()) {
      // The live conversation owns the microphone: the button stops it.
      stopLive()
      toast("Live voice off", "info")
      return
    }

    if (mic() !== "idle") {
      // Second press: stop the recording. The loop below picks the
      // transcript up from its own pttStop call.
      try {
        const info = await daemon(true)
        if (!info) return
        await api.pttStop(info, 120000)
        toast("Stopping…")
      } catch (e) {
        toast(errorText(e), "error")
      }
      return
    }
    if (micBusy) return
    if (!sttReady()) {
      toast("Fish Audio STT needs an API key — open Voice: settings → Transcription", "warning")
      return
    }

    micBusy = true
    micCancelled = false
    setMicState("listening")
    try {
      const info = await daemonOrToast()
      if (!info) return
      await api.pttStart(info, 30000, sttRequest(), micRequest())
      toast("🎙 Listening… speak now")

      // Wait for the capture turn to end on its own (silence detection).
      for (let i = 0; i < 240; i++) {
        await sleep(250)
        const state = await api.pttState(info).catch(() => null)
        const st = state?.ptt?.state
        if (st === "transcribing") setMicState("transcribing")
        if (!st || (st !== "listening" && st !== "transcribing")) break
      }

      setMicState("transcribing")
      // A slow multilingual retry on a phone can take a while; give the turn
      // enough time to finish instead of failing with a timeout.
      const res = await api.pttStop(info, 150000).catch((e: unknown) => {
        toast(errorText(e), "error")
        return null
      })
      if (res === null) return // the failure was already reported
      if (micCancelled) return // cancel() asked for silence
      const text = transcriptText(res)
      if (!text) {
        // Say what the daemon actually saw, so "nothing" is diagnosable.
        const stats = (res as any)?.stats ?? (res as any)?.result?.stats
        const reason = (res as any)?.result?.reason ?? (res as any)?.reason ?? "no speech"
        const level = typeof stats?.rms === "number" ? `, level ${Number(stats.rms).toFixed(3)}` : ""
        const dur = typeof stats?.duration_s === "number" ? "" : ""
        toast(
          `Heard nothing (${reason}${level}${dur}) — check the mic with \`voice doctor\`, ` +
            `or switch the local model in Voice: settings → Transcription`,
          "warning",
        )
        return
      }

      if (autoSendEnabled()) {
        // Hands-free mode: the transcript goes straight to the agent. The
        // watcher reads the answer when it arrives.
        const sent = await submit(sessionID, text)
        if (sent) {
          toast("📤 Sent", "success")
          // A brand new chat only gets a session id when the first message
          // is sent, so look it up again before waiting for the reply.
          const sid = sessionID ?? (await resolveSessionID())
          if (sid) scheduleAnswerCheck(300)
        }
        return
      }

      // Default: the transcript goes into the prompt box so it can be
      // corrected before it is sent.
      if (insertIntoPrompt(text)) {
        toast("📝 Added to the prompt — review it and press send", "success")
      } else {
        toast(`📝 ${text}`, "success")
        toast("Could not open the prompt box — copy the transcript above", "warning")
      }
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
      const daemonVersion = String((h.daemon as any)?.version ?? info.version ?? "?")
      const stale = daemonVersion !== PLUGIN_VERSION
      toast(
        `${healthSummary(h)}${h.audio?.capture?.backend ? "" : " (no mic)"} · ` +
          `plugin ${PLUGIN_VERSION} · daemon ${daemonVersion}` +
          (stale ? " — restart OpenCode to load the new plugin" : ""),
        stale ? "warning" : "info",
      )
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
    void persist((draft) => {
      draft.autoSpeak = autoSpeak
    })
    toast(autoSpeak ? "Replies will be spoken" : "Replies will stay silent", autoSpeak ? "success" : "info")
  }

  function dispose(): void {
    stopSpeechWatch()
    stopAnswers?.()
  }

  // Read every new answer of the session that is on screen.
  stopAnswers = watchAnswers()

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
    /** True while the live conversation is running. */
    live: () => live(),
    /** What the microphone is hearing right now (live mode), else "". */
    liveCaption: () => liveCaption(),
    /** The host's prompt editor, used to anchor the live button on the home screen. */
    editor: () => promptEditor(),
    /** True when transcripts are sent to the agent without a review step. */
    autoSend: () => autoSendEnabled(),
    speakText,
    speakLast,
    speakMessage,
    messageAction,
    pauseResume,
    toggleMic,
    toggleLive,
    cancel,
    status,
    openSettings,
    preload,
    toggleAutoSpeak,
    toggleAutoSend,
    refreshSpeech,
    dispose,
  }
}
