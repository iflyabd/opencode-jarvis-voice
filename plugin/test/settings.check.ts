/**
 * Settings checks: the auto toggles read and write the stored values, and the
 * voice reader persona is spoken exactly once per session.
 *
 *   bun run test:settings
 */

import { createStore } from "solid-js/store"
import { createVoiceController, titleSubject } from "../controller.ts"

const cache = "/tmp/opencode/jarvis-voice-settings-cache"
const spoken: string[] = []

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
    if (url.pathname === "/ping") return json({ ok: true })
    if (url.pathname === "/speak") {
      const body = await req.json().catch(() => ({}))
      spoken.push(String((body as any)?.text ?? ""))
      return json({ ok: true, backend: "fake", spoken: true })
    }
    if (url.pathname === "/speech") return json({ ok: true, active: false, paused: false })
    if (url.pathname === "/interrupt") return json({ ok: true })
    if (url.pathname === "/health") {
      return json({
        ok: true,
        daemon: { version: "1" },
        stt: { picked: "faster-whisper", backends: [] },
        audio: { capture: { backend: "pulse-sles" } },
      })
    }
    return json({ error: "not found" })
  },
})

await Bun.write(
  `${cache}/daemon.json`,
  JSON.stringify({
    url: `http://127.0.0.1:${server.port}`,
    token: "t",
    port: server.port,
    pid: 1,
    platform: "linux",
    version: "1",
  }),
)
process.env.JARVIS_VOICE_CACHE = cache

const [store, setStore] = createStore<any>({
  ttsProvider: "local",
  fishApiKey: "",
  fishVoiceId: "",
  fishVoiceName: "",
  fishModel: "s2.1-pro-free",
  sttProvider: "local",
  fishSttModel: "transcribe-1-pro",
  fishSttLanguage: "",
  localModel: "",
  localLanguage: "",
  autoSpeak: true,
  autoSend: false,
  readerRole: "Alfred",
  readerAddress: "boss",
  micSource: "",
})

let title = "Weather in Berlin"
const messages = [
  {
    id: "msg_1",
    type: "assistant",
    time: { created: Date.now() + 1000 },
    content: [{ type: "text", text: "It is sunny in Berlin today" }],
  },
]

const context: any = {
  options: {},
  storage: { store: () => [store, setStore] },
  renderer: { currentFocusedEditor: null, requestRender() {}, on() {} },
  ui: {
    toast: { show() {} },
    dialog: {},
    router: { current: () => ({ type: "session", sessionID: "ses_persona" }) },
  },
  data: {
    session: {
      list: () => [{ id: "ses_persona" }],
      status: () => "idle",
      get: (id: string) => ({ id, title }),
      message: {
        list: () => messages,
        sync: async () => {},
      },
    },
    listen: () => () => {},
  },
  client: { server: { info: async () => ({ version: "2.1.1" }) } },
}

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` (${detail})` : ""}`)
  if (!ok) failures += 1
}

const voice = createVoiceController(context)

check("auto-read starts from the stored setting", voice.autoSpeak() === true)
check("auto-send starts from the stored setting", voice.autoSend() === false)
setStore("autoSpeak", false)
check("auto-read follows a changed setting", voice.autoSpeak() === false)
setStore("autoSpeak", true)
check("auto-read follows the setting back on", voice.autoSpeak() === true)
await voice.toggleAutoSpeak()
check("the auto-read toggle writes the setting", store.autoSpeak === false)
await voice.toggleAutoSpeak()
check("the auto-read toggle writes it back", store.autoSpeak === true)
await voice.toggleAutoSend()
check("the auto-send toggle writes the setting", store.autoSend === true)
await voice.toggleAutoSend()
check("the auto-send toggle writes it back", store.autoSend === false)

// Explicit reads are independent of auto-read; turn the watcher off so it
// cannot add its own answer to the spoken list while the persona is checked.
setStore("autoSpeak", false)
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function upperFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function firstLeadPattern(role: string, address: string, subject: string): RegExp {
  const r = escapeRegExp(role)
  const a = escapeRegExp(address)
  const c = escapeRegExp(upperFirst(address))
  const s = escapeRegExp(subject)
  return new RegExp(
    `^(?:${r} here, ${a}\\.|${r} at your service, ${a}\\.|${c}, ${r} here\\.|${r} reporting, ${a}\\.|${r} ready, ${a}\\.) About ${s}\\.`,
  )
}

function laterLeadPattern(address: string, subject: string): RegExp {
  const a = escapeRegExp(address)
  const c = escapeRegExp(upperFirst(address))
  const s = escapeRegExp(subject)
  const bare = escapeRegExp(upperFirst(subject))
  return new RegExp(
    `^(?:${c}, ${s}\\.|About ${s}, ${a}\\.|On ${s}, ${a}\\.|Regarding ${s}, ${a}\\.|${bare}, ${a}\\.)`,
  )
}

function plainLeadPattern(subject: string): RegExp {
  const s = escapeRegExp(subject)
  const bare = escapeRegExp(upperFirst(subject))
  return new RegExp(`^(?:About ${s}\\.|On ${s}\\.|Regarding ${s}\\.|${bare}\\.)`)
}

const weatherTitle = "Weather in Berlin"
const weatherSubject = titleSubject(weatherTitle)
const firstIndex = spoken.length
await voice.speakLast("ses_persona")
check(
  "the reader introduces itself once and addresses the user",
  firstLeadPattern("Alfred", "boss", weatherSubject).test(spoken[firstIndex] ?? ""),
  JSON.stringify(spoken[firstIndex]),
)

const repeatIndex = spoken.length
await voice.speakLast("ses_persona")
check(
  "the same subject is not announced again",
  spoken[repeatIndex] === "It is sunny in Berlin today",
  JSON.stringify(spoken[repeatIndex]),
)

title = "What's the weather in Berlin?"
const sameSubjectIndex = spoken.length
await voice.speakLast("ses_persona")
check(
  "the same subject is not announced under a different title",
  spoken[sameSubjectIndex] === "It is sunny in Berlin today",
  JSON.stringify(spoken[sameSubjectIndex]),
)
title = weatherTitle

const otherSessionIndex = spoken.length
await voice.speakLast("ses_other")
check(
  "a new session on the same subject greets without repeating it",
  /^(?:Alfred here, boss\.|Alfred at your service, boss\.|Boss, Alfred here\.|Alfred reporting, boss\.|Alfred ready, boss\.)/.test(
    spoken[otherSessionIndex] ?? "",
  ) && !(spoken[otherSessionIndex] ?? "").includes("weather in Berlin"),
  JSON.stringify(spoken[otherSessionIndex]),
)

title = "الطقس في برلين"
await voice.speakLast("ses_persona")
const nonLatinRepeatIndex = spoken.length
await voice.speakLast("ses_persona")
check(
  "a non-Latin subject is not announced twice",
  spoken[nonLatinRepeatIndex] === "It is sunny in Berlin today",
  JSON.stringify(spoken[nonLatinRepeatIndex]),
)

title = "Fix the controller file"
const controllerSubject = titleSubject(title)
const changedIndex = spoken.length
await voice.speakLast("ses_persona")
check(
  "a changed subject is announced",
  laterLeadPattern("boss", controllerSubject).test(spoken[changedIndex] ?? ""),
  JSON.stringify(spoken[changedIndex]),
)

title = weatherTitle
const returnIndex = spoken.length
await voice.speakLast("ses_persona")
check(
  "returning to a previous subject announces it again",
  laterLeadPattern("boss", weatherSubject).test(spoken[returnIndex] ?? ""),
  JSON.stringify(spoken[returnIndex]),
)

const rotationTitles = [
  "Fix the controller file",
  "Update the README",
  "Why is the audio cutting out?",
  "Add a dark mode",
  "Improve the reader reasoning",
]
const beforeRotation = spoken.length
for (const nextTitle of rotationTitles) {
  title = nextTitle
  await voice.speakLast("ses_persona")
}
const shapes = new Set(
  spoken
    .slice(beforeRotation)
    .map((line) => line.replace(/ It is sunny in Berlin today$/, "")),
)
check(
  "later answers rotate through multiple natural shapes",
  shapes.size >= 2,
  JSON.stringify([...shapes]),
)

setStore("readerAddress", "Captain")
title = "Weather in Paris"
const captainSubject = titleSubject(title)
const captainIndex = spoken.length
await voice.speakLast("ses_persona")
check(
  "a changed address applies to the next answer",
  laterLeadPattern("Captain", captainSubject).test(spoken[captainIndex] ?? ""),
  JSON.stringify(spoken[captainIndex]),
)

setStore("readerRole", "")
setStore("readerAddress", "")
title = "Fix the audio cutting out"
const plainSubject = titleSubject(title)
const plainIndex = spoken.length
await voice.speakLast("ses_persona")
check(
  "clearing the persona restores the plain subject",
  plainLeadPattern(plainSubject).test(spoken[plainIndex] ?? ""),
  JSON.stringify(spoken[plainIndex]),
)

voice.dispose()

// A second controller is what a fresh OpenCode boot sees: the stored toggles
// must still be the ones the user left behind.
setStore("autoSpeak", false)
setStore("autoSend", true)
const boot = createVoiceController(context)
check("auto-read survives the next boot", boot.autoSpeak() === false)
check("auto-send survives the next boot", boot.autoSend() === true)
boot.dispose()

// A fresh install has no saved toggle values: review-first is the default.
const [freshStore, setFreshStore] = createStore<any>({ ttsProvider: "local" })
const freshContext = { ...context, storage: { store: () => [freshStore, setFreshStore] } }
const fresh = createVoiceController(freshContext)
check("auto-send is off on a fresh install", fresh.autoSend() === false)
check("auto-read is on on a fresh install", fresh.autoSpeak() === true)
title = weatherTitle
const defaultIndex = spoken.length
await fresh.speakLast("ses_persona")
check(
  "the default reader is Jarvis addressing sir",
  firstLeadPattern("Jarvis", "sir", weatherSubject).test(spoken[defaultIndex] ?? ""),
  JSON.stringify(spoken[defaultIndex]),
)
fresh.dispose()

server.stop(true)
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll settings checks passed.")
process.exit(0)
