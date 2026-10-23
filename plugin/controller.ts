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
  /** The name the voice reader uses for itself, e.g. "Jarvis"; "" = no introduction. */
  readerRole: string
  /** What the voice reader calls the user, e.g. "sir"; "" = no address. */
  readerAddress: string
  /** The microphone to record from; "" = let the daemon pick. */
  micSource: string
}

type FishVoice = { id: string; title: string; description?: string }

const FISH_MODEL = "s2.1-pro-free"
const FISH_STT_MODEL = "transcribe-1-pro"

/** The spoken persona defaults; both can be changed or cleared in settings. */
const DEFAULT_READER_ROLE = "Jarvis"
const DEFAULT_READER_ADDRESS = "sir"

/**
 * Keep a custom role or address to one short spoken phrase. Punctuation at the
 * end is dropped because the announcement adds its own comma or full stop.
 */
function cleanPersona(value: unknown, max = 60): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,.;:!?…]+$/g, "")
    .slice(0, max)
    .trim()
}

/**
 * The plugin build that is running in this TUI. It is shown in the status
 * line so a stale TUI (started before an update) is obvious at a glance.
 */
export const PLUGIN_VERSION = "1.11.1"

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

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "kts",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "swift", "scala", "sh", "bash", "zsh",
  "fish", "ps1", "lua", "pl", "r", "dart", "ex", "exs", "erl", "clj", "cljs", "elm",
  "vue", "svelte", "astro", "sql", "wasm", "ipynb", "map",
])
const CONFIG_EXTENSIONS = new Set([
  "toml", "ini", "conf", "config", "env", "properties", "plist", "lock", "yaml", "yml",
])
const DATA_EXTENSIONS = new Set([
  "json", "jsonc", "xml", "csv", "tsv", "log", "db", "sqlite", "parquet",
])
const DOC_EXTENSIONS = new Set(["md", "mdx", "txt", "rst", "adoc", "org", "tex", "pdf", "doc", "docx", "rtf"])
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "avif", "heic"])
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "wma", "aiff"])
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg"])
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"])
const KNOWN_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS, ...CONFIG_EXTENSIONS, ...DATA_EXTENSIONS, ...DOC_EXTENSIONS,
  ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...ARCHIVE_EXTENSIONS,
])

/** Well-known files deserve a name people actually use, not "dot json". */
const SPECIAL_FILE_NAMES: Record<string, string> = {
  "package.json": "the package manifest",
  "package-lock.json": "the package lock file",
  "pnpm-lock.yaml": "the pnpm lock file",
  "yarn.lock": "the yarn lock file",
  "tsconfig.json": "the TypeScript config",
  "jsconfig.json": "the JavaScript config",
  "readme": "the readme",
  "readme.md": "the readme",
  "license": "the license",
  "license.md": "the license",
  "dockerfile": "the Dockerfile",
  "makefile": "the makefile",
  "requirements.txt": "the requirements file",
  ".env": "the environment file",
  ".gitignore": "the git ignore file",
  ".gitattributes": "the git attributes file",
  "opencode.json": "the OpenCode config",
  "opencode.jsonc": "the OpenCode config",
}

/** Names with a dot that are products, not files. */
const DOT_NAMES: Record<string, string> = {
  "node.js": "Node JS",
  "next.js": "Next JS",
  "vue.js": "Vue JS",
  "nuxt.js": "Nuxt JS",
  "react.js": "React",
  "angular.js": "Angular JS",
  "express.js": "Express",
  "three.js": "Three JS",
  "d3.js": "D3",
  "socket.io": "Socket IO",
  "jquery.js": "jQuery",
}

const URL_PATTERN = /\b(?:https?|ftp|file):\/\/[^\s<>"'`]+/gi
const URL_ONLY_PATTERN = /^(?:https?|ftp|file):\/\/\S+$/i
const EMAIL_PATTERN = /\b[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[A-Za-z]{2,}\b/g
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HASH_PATTERN = /\b[a-f0-9]{7,64}\b/gi
const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|dev|ai|co|edu|gov|app|xyz|me)\b/gi
const WINDOWS_PATH_PATTERN = /[A-Za-z]:[\\/][^\s<>"'`]+/g
const UNIX_PATH_PATTERN = /(?<![\w])(?:~[\\/]|\.{1,2}[\\/]|\/)[^\s<>"'`]+/g
const RELATIVE_PATH_PATTERN = /(?<![\w/])(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?=$|[\s),.;:!?])/g
const RELATIVE_FOLDER_PATTERN = /(?<![\w/])(?:[\w.-]+[\\/]){2,}[\w.-]+/g
const DOTFILE_PATTERN = /(?<![\w/])\.([A-Za-z][A-Za-z0-9_-]{0,30})\b/g
const BARE_FILE_PATTERN = /(?<![\w/])([\w.-]+)\.([A-Za-z][A-Za-z0-9]{0,7})\b/g
const VERSION_PATTERN = /\bv(\d+(?:\.\d+)+)\b/gi
const DATE_PATTERN = /\b(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/g
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu
const GENERIC_TITLES = new Set([
  "new session", "new chat", "untitled", "untitled session", "untitled chat",
  "session", "chat", "welcome", "home", "main", "opencode",
])

/** A title that is only one of these has no useful subject to announce. */
const GENERIC_SUBJECTS = new Set(["this", "that", "it", "thing", "stuff", "task", "work", "something"])

/** Leading verbs that describe the action, not the subject of the session. */
const TITLE_ACTION_VERBS = new Set([
  "fix", "add", "implement", "make", "update", "improve", "remove", "refactor",
  "continue", "help", "debug", "investigate", "check", "review", "write", "create",
  "build", "run", "test", "explain", "tell", "show", "find", "use", "install",
  "configure", "set", "change", "read", "speak", "start", "stop", "enable",
  "disable", "support", "return", "keep", "ensure", "avoid", "prevent", "handle",
  "allow", "simplify", "summarize", "summarise", "clean", "tune", "polish",
  "redesign", "rewrite", "move", "rename", "delete", "drop", "restore", "save",
  "load", "send", "fetch", "parse", "render", "cache", "stream", "switch",
])

const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "have", "has", "had", "will", "would", "can", "could",
  "should", "shall", "may", "might", "must", "i", "me", "my", "we", "us", "our",
  "you", "your", "he", "she", "it", "they", "them", "their", "this", "that",
  "these", "those", "there", "here", "to", "of", "and", "or", "but", "if",
  "then", "so", "because", "as", "while", "when", "where", "why", "how", "what",
  "which", "who", "whom", "whose", "with", "without", "into", "over", "under",
  "after", "before", "between", "through", "during", "about", "regarding", "on",
  "in", "at", "for", "from", "by", "not", "no", "yes", "please", "just", "very",
  "much", "more", "most", "really", "also", "too", "now", "again", "thanks",
])

/** Short connectors that belong inside a subject ("weather in Berlin"). */
const TITLE_CONNECTORS = new Set(["in", "on", "at", "near", "for", "of", "from", "by", "about"])

/** Particles that keep a phrasal verb together ("cutting out"). */
const TITLE_PARTICLES = new Set(["out", "up", "down", "off"])

const TITLE_COPULAS = new Set(["is", "are", "was", "were", "be", "been", "being", "am"])

const TITLE_META_PREFIXES: RegExp[] = [
  /^(?:please|kindly)\b[\s,;:-]*/i,
  /^(?:can|could|would|will)\s+you\b[\s,;:-]*/i,
  /^(?:i\s+(?:want|need|would\s+like)\s+to|i'd\s+like\s+to)\b[\s,;:-]*/i,
  /^(?:help\s+me|let'?s|let\s+us)\b[\s,;:-]*/i,
  /^(?:we\s+(?:need|should|must)\s+to|you\s+should)\b[\s,;:-]*/i,
  /^(?:make\s+sure|ensure\s+that)\b[\s,;:-]*/i,
  /^(?:it\s+would\s+be|this\s+should\s+be|the\s+goal\s+is\s+to)\b[\s,;:-]*/i,
  /^(?:need|needs|have|has|want|wants)\s+to\b[\s,;:-]*/i,
  /^(?:first|initial|later|subsequent|next|every|each)\s+(?:answer|response|reply|message)s?(?:\s+per\s+session)?\b[\s,;:-]*/i,
  /^(?:requirements?|objectives?|goals?|context|background|details?)\b[\s,;:-]*/i,
  /^(?:[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,2}\s+here)\b(?=[,.;:]|\s+(?:sir|madam|ma'am|boss|about|on|regarding)\b)[\s,.;:-]*/i,
  /^(?:hi|hello|hey)\b[\s,.;:-]*/i,
  /^(?:task|todo|goal)\b[\s,;:-]*/i,
]

/** Names that should keep their capitalization after "About". */
const TITLE_PROPER_NOUNS = new Set([
  "jarvis", "opencode", "github", "hostinger", "piper", "whisper", "parrot",
  "termux", "telegram", "openai", "anthropic", "deepseek", "fish", "linux",
  "berlin", "london", "paris", "tokyo", "new york",
])

const TITLE_QUESTION_FRAME =
  /^(?:why|how|what|when|where|who|which)\s+(?:(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|to)\s+)?(?:(?:i|we|you|it|they|he|she)\s+)?/i

const TITLE_YES_NO_FRAME =
  /^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\s+(?:there|it|i|we|you|they|he|she)\b[\s,;:-]*/i

function lowerFirst(value: string): string {
  const text = String(value ?? "").trim()
  if (!text) return ""
  const firstWord = text.split(/\s+/)[0]?.toLowerCase() ?? ""
  if (TITLE_PROPER_NOUNS.has(firstWord)) return text
  return /^[A-Z0-9]{2,}\b/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1)
}

function upperFirst(value: string): string {
  const text = String(value ?? "").trim()
  if (!text) return ""
  return /^[A-Z0-9]{2,}\b/.test(text) ? text : text.charAt(0).toUpperCase() + text.slice(1)
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Compare titles and subjects without case, punctuation or spacing noise. */
function titleKey(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** Split `jv_audio`, `autoSpeak`, `controller.ts` into natural words. */
function humanizeIdentifier(value: string): string {
  return String(value ?? "")
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()))
    .join(" ")
}

/** What to call a path when it is not worth reading every segment. */
function pathReference(token: string): string {
  let raw = String(token ?? "").trim()
  raw = raw.replace(/[.,;:!?…–—]+$/g, "")
  raw = raw.replace(/[)\]}]+$/g, "")
  raw = raw.replace(/(?::\d+(?::\d+)?|#L\d+)$/i, "")
  if (!raw) return "the folder"
  if (/^(?:https?|ftp|file):\/\//i.test(raw)) return "the link"
  const windows = /^[A-Za-z]:[\\/]/.test(raw)
  const parts = raw.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ""
  if (!last) return "the folder"
  const lower = last.toLowerCase()
  if (SPECIAL_FILE_NAMES[lower]) return SPECIAL_FILE_NAMES[lower]
  const lastDot = last.lastIndexOf(".")
  const dotfile = last.startsWith(".") && last.indexOf(".", 1) < 0
  if (dotfile) {
    const name = humanizeIdentifier(last.slice(1))
    return name ? `the ${name} file` : "the file"
  }
  const hasExtension = lastDot > 0 && lastDot < last.length - 1
  if (!hasExtension) {
    const name = humanizeIdentifier(last)
    return name ? `the ${name} folder` : "the folder"
  }
  const stem = last.slice(0, lastDot)
  const ext = last.slice(lastDot + 1).toLowerCase()
  // A dotted stem such as a settings file reads best by its last real name.
  const stemParts = stem.split(".").filter((part) => part && !/^v?\d+$/i.test(part))
  const name = humanizeIdentifier((stemParts[stemParts.length - 1] ?? stem).replace(/[._-]+/g, " "))
  const shortName = name.split(/\s+/).slice(0, 4).join(" ") || "file"
  if (IMAGE_EXTENSIONS.has(ext)) return "the image"
  if (AUDIO_EXTENSIONS.has(ext)) return "the audio file"
  if (VIDEO_EXTENSIONS.has(ext)) return "the video"
  if (ARCHIVE_EXTENSIONS.has(ext)) return "the archive"
  if (CONFIG_EXTENSIONS.has(ext)) return `the ${shortName} config`
  if (DOC_EXTENSIONS.has(ext)) return `the ${shortName} document`
  if (CODE_EXTENSIONS.has(ext)) return `the ${shortName} file`
  if (DATA_EXTENSIONS.has(ext)) return `the ${shortName} file`
  return `the ${shortName} file`
}

/** Keep the sentence's full stop when a path or link is replaced. */
function replaceToken(match: string, replacement: string): string {
  const trailing = match.match(/[.,;:!?…)\]}–—]+$/)?.[0] ?? ""
  return `${replacement}${trailing}`
}

/** Replace paths, links, hashes and symbols with words a voice can say. */
function naturalizeSpeech(input: string): string {
  let out = String(input ?? "")

  // Markdown that may still be in a title as well as an answer.
  out = out
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_{2,}([^_]+)_{2,}/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\[[ xX]\]\s*/g, "")

  // Products whose dot is not a file extension.
  out = out.replace(/\b(?:node|next|vue|nuxt|react|angular|express|three|d3|socket|jquery)\.(?:js|io)\b/gi, (match) => DOT_NAMES[match.toLowerCase()] ?? match)

  // Dates are numbers, not folders: 10/23/2026 should never become a path.
  out = out.replace(DATE_PATTERN, (match) => match.replace(/[/-]/g, " "))

  // Links and addresses first, before their slashes look like a path.
  out = out.replace(URL_PATTERN, (match) => replaceToken(match, "the link"))
  out = out.replace(EMAIL_PATTERN, (match) => replaceToken(match, "the email address"))
  out = out.replace(DOMAIN_PATTERN, (match) => replaceToken(match, "the website"))

  // File paths. Absolute paths first, then relative ones, so a Windows drive
  // letter is not mistaken for prose.
  out = out.replace(WINDOWS_PATH_PATTERN, (match) => replaceToken(match, pathReference(match)))
  out = out.replace(UNIX_PATH_PATTERN, (match) => replaceToken(match, pathReference(match)))
  out = out.replace(RELATIVE_PATH_PATTERN, (match) => replaceToken(match, pathReference(match)))
  out = out.replace(RELATIVE_FOLDER_PATTERN, (match) => replaceToken(match, pathReference(match)))
  out = out.replace(DOTFILE_PATTERN, (match, name: string) => {
    const special = SPECIAL_FILE_NAMES[`.${String(name).toLowerCase()}`]
    return special ?? `the ${humanizeIdentifier(name) || "hidden"} file`
  })
  out = out.replace(BARE_FILE_PATTERN, (match, stem: string, ext: string) => {
    const cleanStem = String(stem).replace(/[^A-Za-z0-9]/g, "")
    if (cleanStem.length < 2 || !KNOWN_EXTENSIONS.has(String(ext).toLowerCase())) return match
    return pathReference(match)
  })

  // Long identifiers are noise when spoken aloud; give the listener the role.
  out = out.replace(UUID_PATTERN, "the identifier")
  out = out.replace(HASH_PATTERN, (match, offset: number, whole: string) => {
    if (!/[a-f]/i.test(match) || !/\d/.test(match)) return match
    const before = String(whole).slice(Math.max(0, offset - 24), offset).toLowerCase()
    if (/\bcommit\s+$/.test(before)) return "that"
    return /\b(?:head|sha|hash|revision|commit)\b/.test(before) ? "the commit" : "the identifier"
  })

  // Arrows, maths and currency become words before the symbol sweep.
  out = out
    .replace(VERSION_PATTERN, (match, version: string, offset: number, whole: string) => {
      const before = String(whole).slice(Math.max(0, offset - 10), offset).toLowerCase()
      return /version\s+$/.test(before) ? version : `version ${version}`
    })
    .replace(/\b(\d+(?:\.\d+)?)\s*°C\b/gi, "$1 degrees Celsius")
    .replace(/\b(\d+(?:\.\d+)?)\s*°F\b/gi, "$1 degrees Fahrenheit")
    .replace(/\b(\d+)\s*%/g, "$1 percent")
    .replace(/\$\s*(\d+(?:\.\d+)?)/g, "$1 dollars")
    .replace(/€\s*(\d+(?:\.\d+)?)/g, "$1 euros")
    .replace(/£\s*(\d+(?:\.\d+)?)/g, "$1 pounds")
    .replace(/#\s*(\d+)/g, "number $1")
    .replace(/<->|↔/g, " and ")
    .replace(/->|→|⇒|=>/g, " to ")
    .replace(/<-|←/g, " from ")
    .replace(/(?:^|\s)-\s*(?=\d)/g, " minus ")
    .replace(/(?<=\w)-(?=\w)/g, " ")
    .replace(/≥/g, " at least ")
    .replace(/≤/g, " at most ")
    .replace(/≠/g, " not equal to ")
    .replace(/±/g, " plus or minus ")
    .replace(/≈/g, " about ")
    .replace(/×/g, " by ")
    .replace(/÷/g, " divided by ")
    .replace(/&(?:amp|lt|gt|quot);/gi, (match) => ({
      "&amp;": " and ", "&lt;": " less than ", "&gt;": " greater than ", "&quot;": "",
    }[match.toLowerCase()] ?? " "))

  // A final sweep for symbols that a synthesizer would otherwise spell out.
  out = out
    .replace(EMOJI_PATTERN, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, "")
    .replace(/[–—―]/g, ", ")
    .replace(/[•·▪▫◦✓✔★☆]/g, " ")
    .replace(/[\[\]{}<>()]/g, " ")
    .replace(/[*_~^`|\\]/g, " ")
    .replace(/[@]/g, " at ")
    .replace(/[&]/g, " and ")
    .replace(/[+]/g, " plus ")
    .replace(/[=]/g, " equals ")
    .replace(/%/g, " percent")
    .replace(/…/g, ".")
    .replace(/(?<!\d):(?!\d)/g, ", ")
    .replace(/;/g, ", ")
    .replace(/\//g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([,.;!?])(?:\s*[,.;!?])+/g, "$1")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/^\s*[,.;:!?]+\s*/, "")
    .trim()
  return out
}

/** Clean a title without shortening it; the summarizer needs the whole thing. */
function cleanTitleText(title: string): string {
  const original = String(title ?? "").trim()
  if (!original) return ""
  if (URL_ONLY_PATTERN.test(original)) return ""

  const compact = original.replace(/[^A-Za-z0-9]/g, "")
  if (compact.length >= 8 && /^[0-9a-f]+$/i.test(compact) && /[a-f]/i.test(compact) && /\d/.test(compact)) {
    return ""
  }
  if (/^(?:ses|msg|ptt|conn|req|run|step)[_-][A-Za-z0-9_-]+$/i.test(original)) return ""

  const originalKey = original.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  if (GENERIC_TITLES.has(originalKey)) return ""
  if (/^(?:new|untitled)\s+(?:session|chat)(?:\s+\d+)*$/.test(originalKey)) return ""

  const cleaned = original
    .replace(/^\s*(?:session|chat|conversation)\s*(?:title|name)?\s*[,:\-–—]\s*/i, "")
    .replace(/^\s*(?:re|fwd)\s*:\s*/i, "")
  let text = naturalizeSpeech(cleaned)
    .replace(/^\s*[,.;:!?]+\s*/, "")
    .trim()

  // A title that is one code identifier reads better split into words.
  if (/^[A-Za-z_$][\w$.-]*$/.test(text) && (/[a-z][A-Z]/.test(text) || text.includes("_"))) {
    text = humanizeIdentifier(text)
  }

  const key = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  if (!key || GENERIC_TITLES.has(key)) return ""
  if (/^(?:new|untitled)\s+(?:session|chat)(?:\s+\d+)*$/.test(key)) return ""
  if (!/\p{L}{2,}/u.test(text)) return ""
  return text.trim()
}

/** One natural phrase for a session title, without paths, hashes or symbols. */
export function naturalTitle(title: string): string {
  let text = cleanTitleText(title)
  if (!text) return ""

  // Keep the announcement short enough to feel like a subtitle, not a report.
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length > 12) text = words.slice(0, 12).join(" ")
  if (text.length > 72) {
    const cut = text.slice(0, 72)
    const at = cut.lastIndexOf(" ")
    text = at > 36 ? cut.slice(0, at) : cut
  }
  return text.replace(/[\s.,;:!?…]+$/g, "").trim()
}

/** Is the title a question, an instruction, or a plain topic? */
export function titleKind(title: string): "question" | "action" | "topic" {
  const original = String(title ?? "").trim()
  if (!original) return "topic"
  if (
    /\?\s*$/.test(original) ||
    /^(?:how|what|why|when|where|who|which|can|could|should|would|is|are|do|does|did)\b/i.test(original)
  ) {
    return "question"
  }
  const first = original.match(/^([A-Za-z][A-Za-z'’-]*)/)?.[1]?.toLowerCase() ?? ""
  return TITLE_ACTION_VERBS.has(first) ? "action" : "topic"
}

function stripTitleMeta(value: string): string {
  let text = value.trim()
  for (let pass = 0; pass < 4; pass++) {
    const before = text
    for (const pattern of TITLE_META_PREFIXES) text = text.replace(pattern, "").trim()
    if (text === before) break
  }
  return text
}

function stripTitleQuestion(value: string): string {
  let text = value.trim()
  // "Is there a way to ..." is all frame and no subject.
  text = text.replace(
    /^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\s+there\s+(?:a|any)\s+way\s+to\b[\s,;:-]*/i,
    "",
  )
  text = text.replace(TITLE_YES_NO_FRAME, "")
  text = text.replace(TITLE_QUESTION_FRAME, "")
  text = text.replace(/^(?:a|any)\s+way\s+to\b[\s,;:-]*/i, "")
  return text.trim()
}

/** Keep the first real clause; the rest is usually explanation, not subject. */
function firstTitleClause(value: string): string {
  let text = value.trim()
  const patterns = [
    /\s+(?:because|so\s+that|so|but|however|although|though|while|when|whenever|if|unless|which|that|who|where)\s+/i,
    /\s+and\s+/i,
    /\s*[,;]\s*/,
    /\s+[–—-]\s+/,
  ]
  for (const pattern of patterns) {
    const parts = text.split(pattern)
    if (parts.length > 1 && parts[0].trim().split(/\s+/).filter(Boolean).length >= 2) {
      text = parts[0].trim()
    }
  }
  // "dynamic reader roles with multiple versions" -> "dynamic reader roles".
  const withParts = text.split(/\s+with\s+/i)
  if (withParts.length > 1 && withParts[0].trim().split(/\s+/).filter(Boolean).length >= 3) {
    text = withParts[0].trim()
  }
  return text.trim()
}

/**
 * Pull the noun phrase out of a title.
 *
 * The reader should say "About the audio cutting out", not read a whole
 * instruction. This is deliberately local and deterministic: first remove
 * frames ("why is", "please fix", "how do I"), then keep the first strong
 * phrase, preserving short connectors such as "in Berlin".
 */
function focusTitleSubject(value: string): string {
  const text = value.trim()
  if (!text) return ""
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9'’+.-]*/g) ?? []
  if (!words.length) return ""
  const leadingThe = /^the\b/i.test(text)

  const isContent = (word: string): boolean => {
    const lower = word.toLowerCase()
    return (!TITLE_STOPWORDS.has(lower) || TITLE_PARTICLES.has(lower)) && /[A-Za-z0-9]/.test(word)
  }

  const runs: Array<{ words: string[]; count: number }> = []
  let current: string[] = []
  let count = 0
  const flush = () => {
    if (current.length && count) runs.push({ words: current, count })
    current = []
    count = 0
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const lower = word.toLowerCase()
    if (isContent(word)) {
      current.push(word)
      count += 1
      continue
    }
    const next = words[i + 1]
    if (
      (TITLE_CONNECTORS.has(lower) || TITLE_COPULAS.has(lower)) &&
      current.length &&
      next &&
      isContent(next)
    ) {
      current.push(word)
      continue
    }
    flush()
  }
  flush()

  // The first phrase with two content words is almost always the topic; a
  // later longer run is usually the explanation that follows it.
  const preferred = runs.find((run) => run.count >= 2) ?? runs.slice().sort((a, b) => b.count - a.count)[0]
  let phrase = (preferred?.words ?? words.slice(0, 3)).filter(
    (word) => !TITLE_COPULAS.has(word.toLowerCase()),
  )
  if (!phrase.length) return ""

  // "a dark mode" -> "dark mode"; "the" is useful, "a" is not.
  while (phrase.length && /^(?:a|an)$/i.test(phrase[0])) phrase.shift()
  while (
    phrase.length &&
    (TITLE_STOPWORDS.has(phrase[0].toLowerCase()) || TITLE_CONNECTORS.has(phrase[0].toLowerCase()))
  ) {
    phrase.shift()
  }
  // Keep a leading "the" for a concrete subject ("the controller file").
  if (leadingThe && !/^the$/i.test(phrase[0] ?? "")) phrase.unshift("the")
  while (phrase.length) {
    const last = phrase[phrase.length - 1].toLowerCase()
    if (TITLE_PARTICLES.has(last) && phrase.length > 1) break
    if (!TITLE_STOPWORDS.has(last) && !TITLE_CONNECTORS.has(last)) break
    phrase.pop()
  }
  if (phrase.length > 7) phrase = phrase.slice(0, 7)
  while (
    phrase.length &&
    (TITLE_STOPWORDS.has(phrase[phrase.length - 1].toLowerCase()) ||
      TITLE_CONNECTORS.has(phrase[phrase.length - 1].toLowerCase()))
  ) {
    phrase.pop()
  }

  const subject = phrase
    .join(" ")
    .replace(/^[,.;:!?…\s]+|[,.;:!?…\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!subject) return ""
  const key = subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  if (!key || GENERIC_SUBJECTS.has(key) || key === "the") return ""
  return lowerFirst(subject)
}

/** The summarized subject of a session title, ready to sit after "About". */
export function titleSubject(title: string): string {
  const text = cleanTitleText(title)
  if (!text) return ""

  let working = stripTitleMeta(text)
  for (let pass = 0; pass < 4; pass++) {
    const before = working
    working = stripTitleQuestion(working)
    const action = working.match(/^([A-Za-z][A-Za-z'’-]*)\b[\s,;:-]*(.*)$/)
    if (action && TITLE_ACTION_VERBS.has(action[1].toLowerCase())) {
      working = action[2].trim().replace(/^(?:me|us|it|this|that)\s+/i, "")
    }
    working = stripTitleMeta(working)
    if (working === before) break
  }
  // "Sir, about ..." / "sir. About ..." is an address, not the subject.
  working = working.replace(
    /^(?:[A-Za-z][A-Za-z'’-]*)[.,;:]\s+(?=(?:about|on|regarding)\b)/i,
    "",
  )
  working = working.replace(/^(?:about|regarding|on)\s+/i, "").trim()
  working = working.replace(
    /^((?:the\s+)?[A-Za-z0-9][\w' -]*)\s+(?:works?|fails?|breaks?|happens?|cuts?\s+out)[?.!]*$/i,
    "$1",
  )
  working = firstTitleClause(working)
  return focusTitleSubject(working)
}

type SubjectLead = "about" | "on" | "regarding" | "bare"

function subjectSentence(subject: string, lead: SubjectLead): string {
  const lower = lowerFirst(subject)
  if (!lower) return ""
  if (lead === "bare") return `${upperFirst(lower)}.`
  const prefix = lead === "about" ? "About" : lead === "on" ? "On" : "Regarding"
  return `${prefix} ${lower}.`
}

function subjectClause(subject: string, lead: SubjectLead): string {
  return subjectSentence(subject, lead).replace(/\.$/, "")
}

/**
 * The spoken subject before an answer. It is deliberately a sentence of its
 * own: "About the controller file." reads better than a raw path, and the
 * answer that follows still sounds like a conversation.
 */
export function titleAnnouncement(title: string): string {
  const subject = titleSubject(title)
  if (!subject) return ""
  return subjectSentence(subject, titleKind(title) === "question" ? "on" : "about")
}

/** Turn a markdown answer into something worth listening to. */
export function speakable(text: string, limit = 0): string {
  let out = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " JVCODEFENCE ")
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
  out = naturalizeSpeech(out)
    .replace(/JVCODEFENCE/gi, " a code block ")
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
  if (out.replace(/a code block/gi, " ").replace(/[^\p{L}\p{N}]+/gu, "").length < 2) return ""
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

  function setLiveState(value: boolean): void {
    setLive(value)
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
    // Review-first is the default: a transcript lands in the prompt box until
    // the user explicitly turns auto-send on.
    autoSend: context.options?.autoSend === true,
    autoSpeak: context.options?.autoSpeak !== false,
    readerRole: cleanPersona(
      context.options?.readerRole ?? context.options?.role ?? DEFAULT_READER_ROLE,
    ) || "",
    readerAddress: cleanPersona(
      context.options?.readerAddress ?? context.options?.address ?? context.options?.userTitle ?? DEFAULT_READER_ADDRESS,
    ) || "",
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
        typeof stored.readerRole !== "string" ||
        typeof stored.readerAddress !== "string" ||
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
          if (typeof draft.readerRole !== "string") draft.readerRole = seedSettings.readerRole
          if (typeof draft.readerAddress !== "string") draft.readerAddress = seedSettings.readerAddress
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

  /* --------------------------------------------------------- auto toggles */

  /**
   * The toolbar, the watcher and the settings dialog all read the same stored
   * value. A preference saved by an earlier TUI therefore wins over the
   * default, and a click cannot leave the label out of step with the setting.
   */
  function autoSpeakEnabled(): boolean {
    return typeof settings.autoSpeak === "boolean" ? settings.autoSpeak : seedSettings.autoSpeak
  }

  function autoSendEnabled(): boolean {
    return typeof settings.autoSend === "boolean" ? settings.autoSend : seedSettings.autoSend
  }

  /* ------------------------------------------------------- reader persona */

  function readerRole(): string {
    // A store created before this setting existed has no string yet; use the
    // default until the migration writes it, but let an explicitly cleared
    // value ("") stay cleared.
    return cleanPersona(typeof settings.readerRole === "string" ? settings.readerRole : seedSettings.readerRole)
  }

  function readerAddress(): string {
    return cleanPersona(
      typeof settings.readerAddress === "string" ? settings.readerAddress : seedSettings.readerAddress,
    )
  }

  /** Sessions where the reader has already introduced itself. */
  const introducedSessions = new Set<string>()
  /** Sessions where any lead has been spoken, so first/later shapes differ. */
  const leadSeenSessions = new Set<string>()
  /** Per-session variant cursor; it keeps later answers from repeating. */
  const leadState = new Map<string, { count: number; last: number }>()
  /** The last title/subject that was read, so a continuing thread stays quiet. */
  let lastReadTitleKey = ""
  let lastReadSubjectKey = ""

  function pickLeadVariant(length: number, seed: string, last = -1): number {
    if (length <= 1) return 0
    let index = hashString(seed) % length
    if (index === last) index = (index + 1) % length
    return index
  }

  /**
   * The spoken lead before an answer.
   *
   * The role introduces itself once per session, then later answers rotate
   * through several natural shapes: address first ("Sir, about ..."), subject
   * first ("About ..., sir"), "On ..." and "Regarding ...". The subject is the
   * summarized title, never the raw title, and the first answer gets a wider
   * set of introductions so a long session does not sound like a loop.
   *
   * A subject is only announced when it changes. Consecutive reads of the same
   * title or subject return no lead at all (except the one-time role greeting),
   * and switching to another subject and back makes it announce again.
   */
  function readerLead(sessionID: string, title: string, seed = ""): string {
    const role = readerRole()
    const address = readerAddress()
    const subject = titleSubject(title)
    const kind = titleKind(title)
    const currentTitleKey = titleKey(title)
    const currentSubjectKey = titleKey(subject)
    const sameAsLastRead =
      Boolean(currentTitleKey && currentTitleKey === lastReadTitleKey) ||
      Boolean(currentSubjectKey && currentSubjectKey === lastReadSubjectKey)
    const mentionSubject = Boolean(subject) && !sameAsLastRead
    const spokenSubject = mentionSubject ? subject : ""
    const firstAnswer = !leadSeenSessions.has(sessionID)
    const introduce = Boolean(role) && !introducedSessions.has(sessionID)

    const rememberRead = () => {
      if (currentTitleKey || currentSubjectKey) {
        lastReadTitleKey = currentTitleKey
        lastReadSubjectKey = currentSubjectKey
      }
    }

    // A later answer on the same thread has nothing new to announce. The very
    // first answer can still say hello, just without repeating the subject.
    if (!mentionSubject && !(firstAnswer && introduce)) {
      rememberRead()
      return ""
    }

    const state = leadState.get(sessionID) ?? { count: 0, last: -1 }
    const primaryLead: SubjectLead = kind === "question" ? "on" : "about"
    const primary = spokenSubject ? subjectSentence(spokenSubject, primaryLead) : ""
    const about = spokenSubject ? subjectSentence(spokenSubject, "about") : ""
    const on = spokenSubject ? subjectSentence(spokenSubject, "on") : ""
    const regarding = spokenSubject ? subjectSentence(spokenSubject, "regarding") : ""
    const bare = spokenSubject ? subjectSentence(spokenSubject, "bare") : ""
    const aboutClause = spokenSubject ? subjectClause(spokenSubject, "about") : ""
    const onClause = spokenSubject ? subjectClause(spokenSubject, "on") : ""
    const regardingClause = spokenSubject ? subjectClause(spokenSubject, "regarding") : ""
    const bareClause = spokenSubject ? subjectClause(spokenSubject, "bare") : ""
    const lower = spokenSubject ? lowerFirst(spokenSubject) : ""
    const addressCap = address ? upperFirst(address) : ""

    let variants: string[]
    let index: number

    if (firstAnswer && introduce) {
      variants = address
        ? [
            `${role} here, ${address}. ${primary}`,
            `${role} at your service, ${address}. ${primary}`,
            `${addressCap}, ${role} here. ${primary}`,
            `${role} reporting, ${address}. ${primary}`,
            `${role} ready, ${address}. ${primary}`,
          ]
        : [
            `${role} here. ${primary}`,
            `${role} at your service. ${primary}`,
            `${role} reporting. ${primary}`,
            `${role} ready. ${primary}`,
          ]
      index = pickLeadVariant(variants.length, `${sessionID}|first|${role}|${address}|${spokenSubject}`)
    } else if (firstAnswer && address) {
      variants = [
        `${addressCap}, ${lower}.`,
        `${aboutClause}, ${address}.`,
        `${addressCap}, here is ${lower}.`,
      ]
      index = pickLeadVariant(variants.length, `${sessionID}|first-address|${address}|${spokenSubject}`)
    } else if (firstAnswer) {
      variants = [about, on, regarding, bare]
      index = pickLeadVariant(variants.length, `${sessionID}|first-subject|${spokenSubject}`)
    } else if (address) {
      variants = [
        `${addressCap}, ${lower}.`,
        `${aboutClause}, ${address}.`,
        `${onClause}, ${address}.`,
        `${regardingClause}, ${address}.`,
        `${bareClause}, ${address}.`,
      ]
      index = pickLeadVariant(variants.length, `${sessionID}|later|${seed}|${spokenSubject}|${state.count}`, state.last)
    } else {
      variants = [about, on, regarding, bare]
      index = pickLeadVariant(variants.length, `${sessionID}|later-subject|${seed}|${spokenSubject}|${state.count}`, state.last)
    }

    const text = (variants[index] ?? "")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,!?])/g, "$1")
      .trim()
    rememberRead()
    if (!text) return ""
    leadSeenSessions.add(sessionID)
    if (introduce) introducedSessions.add(sessionID)
    leadState.set(sessionID, { count: state.count + 1, last: index })
    return text
  }

  function readerSummary(): string {
    const role = readerRole()
    const address = readerAddress()
    if (!role && !address) return "No introduction and no address"
    const parts: string[] = []
    parts.push(role ? `role ${role}` : "no role introduction")
    parts.push(address ? `calls you ${address}` : "no address")
    return parts.join(" · ")
  }

  async function toggleAutoSend(): Promise<void> {
    const next = !autoSendEnabled()
    await persist((draft) => {
      draft.autoSend = next
    })
    repaint()
    toast(
      next
        ? "Push-to-talk transcripts are sent to the agent automatically"
        : "Push-to-talk transcripts land in the prompt box — review and send them yourself",
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

  /**
   * The reader's persona: the name it introduces itself with and the words it
   * uses for the user. Both are free text so a user can be "sir", "boss",
   * "Captain" or anything else, and both can be cleared.
   */
  async function openReaderSettings(): Promise<void> {
    if (!context.ui?.dialog?.select || !context.ui?.dialog?.prompt) {
      toast("Voice reader settings need the interactive TUI", "warning")
      return
    }
    for (;;) {
      const choice: string | undefined = await context.ui.dialog.select({
        title: "Voice reader",
        placeholder: "Choose a setting",
        options: [
          {
            title: "Reader role",
            value: "role",
            description: readerRole() ? `Introduces itself as ${readerRole()}` : "No introduction",
          },
          {
            title: "What the reader calls you",
            value: "address",
            description: readerAddress() ? `Calls you ${readerAddress()}` : "No address",
          },
          { title: "Done", value: "done" },
        ],
      })
      if (choice === undefined || choice === "done") return

      if (choice === "role") {
        const raw = await context.ui.dialog.prompt({
          title: "Voice reader role",
          description:
            "The name the reader uses for itself, e.g. Jarvis. Leave blank to remove the introduction.",
          placeholder: "Jarvis",
          value: readerRole(),
        })
        if (raw === undefined) continue
        const value = cleanPersona(raw)
        await persist((draft) => {
          draft.readerRole = value
        })
        repaint()
        toast(value ? `Voice reader role: ${value}` : "Voice reader introduction cleared", "success")
      } else if (choice === "address") {
        const raw = await context.ui.dialog.prompt({
          title: "What should the reader call you?",
          description: "For example sir, boss, Captain or your name. Leave blank to stop using an address.",
          placeholder: "sir",
          value: readerAddress(),
        })
        if (raw === undefined) continue
        const value = cleanPersona(raw)
        await persist((draft) => {
          draft.readerAddress = value
        })
        repaint()
        toast(value ? `The reader will call you ${value}` : "Reader address cleared", "success")
      }
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
          { title: "Voice reader role and address", value: "reader", description: readerSummary() },
          {
            title: autoSendEnabled() ? "Auto-send transcripts (on)" : "Auto-send transcripts (off)",
            value: "autosend",
            description: autoSendEnabled()
              ? "Push-to-talk transcripts are sent to the agent as soon as they are transcribed"
              : "Push-to-talk transcripts land in the prompt box so you can correct them before sending",
          },
          {
            title: autoSpeakEnabled() ? "Auto-read replies (on)" : "Auto-read replies (off)",
            value: "autospeak",
            description: autoSpeakEnabled()
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
      } else if (choice === "reader") {
        await openReaderSettings()
      } else if (choice === "autosend") {
        await toggleAutoSend()
      } else if (choice === "autospeak") {
        await toggleAutoSpeak()
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
      const lead = sessionLead(sid, answer.id ?? "last")
      const toSay = lead ? `${lead} ${text}` : text
      const info = await daemonOrToast()
      if (!info) return
      await api.speak(info, toSay, { async: true, ...ttsRequest() })
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
      const lead = sessionLead(sid, messageID)
      const toSay = lead ? `${lead} ${text}` : text
      const info = await daemonOrToast()
      if (!info) return
      if (speech() !== "idle") {
        // Another answer (or an arbitrary /voice phrase) owns the speaker.
        // Stop it first so the new read starts at the beginning.
        await api.interrupt(info).catch(() => undefined)
      }
      await api.speak(info, toSay, { async: true, ...ttsRequest() })
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

  /**
   * The spoken lead before an answer: the reader's optional introduction and
   * address, then the summarized session subject.
   *
   * Session titles are often the first thing the user typed: a path, a file
   * name, a hash or a long instruction. `titleSubject` reduces that to a short
   * noun phrase ("the controller file") and `readerLead` rotates natural lead
   * shapes around it. Identifiers and generic placeholders are skipped.
   */
  function sessionLead(sessionID: string, seed = ""): string {
    try {
      const info: any = context.data.session.get?.(sessionID)
      return readerLead(sessionID, String(info?.title ?? ""), seed)
    } catch {
      return readerLead(sessionID, "", seed)
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
    const streaming = live() && autoSpeakEnabled()
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

    if (!autoSpeakEnabled()) {
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
      const label = next.labelDone ? "" : sessionLead(sessionID, id)
      next.spoken = cut
      next.labelDone = true
      seenAnswers.set(sessionID, id)
      if (writing) readProgress.set(id, next)
      await speakChunk(sessionID, label ? `${label} ${piece}` : piece, id)
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
    const body = speakable(answer.text)
    if (!body) return
    const lead = sessionLead(sessionID, answer.id ?? "reply")
    const toSay = lead ? `${lead} ${body}` : body
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
    setLiveState(false)
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
    setLiveState(true)
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
      setLiveState(false)
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

  async function toggleAutoSpeak(): Promise<void> {
    const next = !autoSpeakEnabled()
    await persist((draft) => {
      draft.autoSpeak = next
    })
    repaint()
    toast(next ? "Replies will be spoken" : "Replies will stay silent", next ? "success" : "info")
  }

  function dispose(): void {
    stopSpeechWatch()
    stopAnswers?.()
    // Best effort on unload (Ctrl+C can kill the process before this
    // completes); the daemon's client-pid watchdog is the reliable layer.
    void (async () => {
      try {
        const info = await daemon(false)
        if (info) await api.interrupt(info)
      } catch {
        /* the TUI is going away */
      }
    })()
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
    autoSpeak: () => autoSpeakEnabled(),
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
