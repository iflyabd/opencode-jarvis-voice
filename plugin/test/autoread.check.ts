/**
 * Auto-read after a reboot.
 *
 * The daemon is on-demand: after a reboot there is no `daemon.json` and no
 * process until something asks for one. Auto-read used to call the daemon
 * with `start: false`, so a stored `autoSpeak: true` silently did nothing
 * after a reboot. This check starts from an empty cache, uses a fake `voice
 * up` launcher, and verifies that a new answer starts the daemon and is read.
 *
 *   bun test/autoread.check.ts
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createStore } from "solid-js/store"
import { createVoiceController } from "../controller.ts"

const root = "/tmp/opencode/jarvis-voice-autoread"
const cache = `${root}/cache`
const home = `${root}/home`
const launcher = `${home}/bin/voice`

rmSync(root, { recursive: true, force: true })
mkdirSync(`${home}/bin`, { recursive: true })
mkdirSync(cache, { recursive: true })

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
      return json({ ok: true, backend: "fake", spoken: true, queued: true })
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

// A stand-in for `bin/voice up`: it publishes the runtime file the real
// launcher would publish, pointing at the mock daemon.
writeFileSync(
  launcher,
  `#!/bin/sh
cat > "$JARVIS_VOICE_CACHE/daemon.json" <<'JSON'
{"url":"http://127.0.0.1:${server.port}","token":"t","port":${server.port},"pid":1,"platform":"linux","version":"1"}
JSON
`,
)
chmodSync(launcher, 0o755)

process.env.JARVIS_VOICE_CACHE = cache
process.env.JARVIS_VOICE_HOME = home

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

let eventHandler: any = undefined
let answerReady = false
const answer = {
  id: "msg_after_reboot",
  type: "assistant",
  time: { created: 0 },
  content: [{ type: "text", text: "The answer after a reboot is read aloud." }],
}

const context: any = {
  options: {},
  storage: { store: () => [store, setStore] },
  renderer: { currentFocusedEditor: undefined, requestRender() {}, on() {} },
  keymap: { commands: () => [], dispatch() {} },
  ui: {
    toast: { show() {} },
    dialog: {},
    router: { current: () => ({ type: "session", sessionID: "ses_reboot" }) },
  },
  data: {
    session: {
      list: () => [{ id: "ses_reboot" }],
      status: () => "idle",
      get: (id: string) => ({ id, title: "Weather in Berlin" }),
      message: {
        list: () => (answerReady ? [answer] : []),
        sync: async () => {},
      },
    },
    listen: (handler: any) => {
      eventHandler = handler
      return () => {
        eventHandler = undefined
      }
    },
  },
}

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` (${detail})` : ""}`)
  if (!ok) failures += 1
}

check("the test starts with no daemon runtime", !existsSync(`${cache}/daemon.json`))

const voice = createVoiceController(context)
check("auto-read starts from the stored setting", voice.autoSpeak() === true)

// A new answer arrives after the plugin started, exactly as it would after a
// reboot. The watcher must start the on-demand daemon and read it.
answer.time.created = Date.now() + 1000
answerReady = true
eventHandler?.({ details: { type: "message.updated" } })

for (let i = 0; i < 30 && spoken.length === 0; i++) {
  await new Promise((r) => setTimeout(r, 200))
}

check("the on-demand daemon was started", existsSync(`${cache}/daemon.json`))
check(
  "the new answer is read after a reboot",
  spoken.some((text) => text.includes("The answer after a reboot is read aloud.")),
  JSON.stringify(spoken),
)

voice.dispose()
server.stop(true)
rmSync(root, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll auto-read checks passed.")
process.exit(0)
