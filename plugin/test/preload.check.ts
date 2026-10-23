/**
 * Transcript preload checks.
 *
 * The transcript model is preloaded when OpenCode starts, on by default. The
 * daemon answers `/warmup` with `skipped` when the model is already resident,
 * and the commands-menu toggle must persist and work in both directions.
 *
 *   bun test/preload.check.ts
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createStore } from "solid-js/store"
import { createVoiceController } from "../controller.ts"

const cache = "/tmp/opencode/jarvis-voice-preload-cache"
rmSync(cache, { recursive: true, force: true })
mkdirSync(cache, { recursive: true })

let warmupResponse: any = { ok: true, backend: "faster-whisper", ms: 7 }
const warmups: any[] = []
const toasts: Array<{ message: string; variant?: string }> = []

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
    if (url.pathname === "/ping") return json({ ok: true })
    if (url.pathname === "/warmup") {
      warmups.push(await req.json().catch(() => ({})))
      return json(warmupResponse)
    }
    if (url.pathname === "/speech") return json({ ok: true, active: false, paused: false })
    if (url.pathname === "/interrupt") return json({ ok: true })
    if (url.pathname === "/speak") return json({ ok: true, backend: "fake", spoken: true })
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

// Deliberately no `preloadStt`: this is what an older settings file looks
// like, and the migration must backfill it to on.
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
  readerRole: "Jarvis",
  readerAddress: "sir",
  micSource: "",
})

const context: any = {
  options: {},
  storage: { store: () => [store, setStore] },
  renderer: { currentFocusedEditor: null, requestRender() {}, on() {} },
  ui: {
    toast: {
      show: (options: any) => {
        toasts.push({ message: String(options?.message ?? ""), variant: options?.variant })
      },
    },
    dialog: {},
    router: { current: () => ({ type: "session", sessionID: "ses_preload" }) },
  },
  data: {
    session: {
      list: () => [{ id: "ses_preload" }],
      status: () => "idle",
      get: (id: string) => ({ id, title: "Preload check" }),
      message: {
        list: () => [],
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

// The migration writes the default into storage in the background.
await new Promise((r) => setTimeout(r, 30))
check(
  "transcript preload is on by default for an older settings file",
  voice.preloadEnabled() === true && store.preloadStt === true,
  `enabled=${voice.preloadEnabled()} stored=${store.preloadStt}`,
)

await voice.preloadOnLoad()
check(
  "startup preload warms the local model",
  warmups.length === 1 && warmups[0]?.stt?.backend === "local",
  JSON.stringify(warmups),
)
check("startup preload is silent", toasts.length === 0, JSON.stringify(toasts))

warmupResponse = { ok: true, backend: "faster-whisper", skipped: true, already_loaded: true }
toasts.length = 0
await voice.preload()
check(
  "manual preload reports a model that is already loaded",
  warmups.length === 2 && toasts.at(-1)?.message === "Speech model is already ready",
  JSON.stringify({ warmups: warmups.length, toasts }),
)

warmupResponse = { ok: true, backend: "faster-whisper", ms: 4 }
toasts.length = 0
await voice.preload()
check(
  "manual preload reports when the model is ready",
  warmups.length === 3 && Boolean(toasts.at(-1)?.message.includes("Speech model ready")),
  JSON.stringify({ warmups: warmups.length, toasts }),
)

await voice.togglePreload()
check(
  "the preload toggle turns off and persists",
  voice.preloadEnabled() === false && store.preloadStt === false,
  `enabled=${voice.preloadEnabled()} stored=${store.preloadStt}`,
)

const beforeOff = warmups.length
await voice.preloadOnLoad()
check("startup preload is skipped while the toggle is off", warmups.length === beforeOff)

await voice.preload()
check(
  "manual preload still works while automatic preload is off",
  warmups.length === beforeOff + 1,
  `${beforeOff} -> ${warmups.length}`,
)

await voice.togglePreload()
check(
  "the preload toggle turns back on and persists",
  voice.preloadEnabled() === true && store.preloadStt === true,
  `enabled=${voice.preloadEnabled()} stored=${store.preloadStt}`,
)
for (let i = 0; i < 30 && warmups.length < beforeOff + 2; i++) {
  await new Promise((r) => setTimeout(r, 10))
}
check(
  "turning preload on warms the model immediately",
  warmups.length >= beforeOff + 2,
  `${beforeOff} -> ${warmups.length}`,
)

setStore("sttProvider", "fish")
setStore("fishApiKey", "key")
const beforeFish = warmups.length
toasts.length = 0
await voice.preload()
check(
  "Fish Audio ASR is skipped because it is cloud-hosted",
  warmups.length === beforeFish && Boolean(toasts.at(-1)?.message.includes("cloud-hosted")),
  JSON.stringify({ warmups: warmups.length, toasts }),
)

setStore("fishApiKey", "")
toasts.length = 0
await voice.preload()
check(
  "Fish Audio ASR without a key warns instead of preloading",
  warmups.length === beforeFish && toasts.at(-1)?.variant === "warning",
  JSON.stringify({ warmups: warmups.length, toasts }),
)

voice.dispose()
server.stop(true)
rmSync(cache, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll transcript preload checks passed.")
process.exit(0)
