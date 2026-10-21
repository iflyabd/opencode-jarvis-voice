/**
 * End-to-end check of the push-to-talk flow against a mock daemon.
 *
 * The bug this guards against: the daemon nests the turn result under
 * `result` and also sends a flat `text`. Reading the wrong field made every
 * turn report "heard nothing", and the transcript was sent to the agent
 * without the user ever seeing it.
 *
 *   bun run test:flow
 */

import { createStore } from "solid-js/store"
import { createVoiceController } from "../controller.ts"

const cache = "/tmp/opencode/jarvis-voice-flow-cache"

// A mock daemon that behaves like the real one.
let polls = 0
let startBody: any = null
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
    if (url.pathname === "/ping") return json({ ok: true })
    if (url.pathname === "/ptt/start") {
      startBody = await req.json()
      return json({ ok: true, ptt: { id: "ptt-1", state: "listening" } })
    }
    if (url.pathname === "/ptt/state") {
      polls += 1
      return json({ ok: true, ptt: { id: "ptt-1", state: polls > 1 ? "done" : "listening" } })
    }
    if (url.pathname === "/ptt/stop") {
      return json({
        ok: true,
        id: "ptt-1",
        state: "done",
        text: "hello from the microphone",
        result: { text: "hello from the microphone", backend: "faster-whisper", stats: { rms: 0.42 } },
        backend: "faster-whisper",
        stats: { rms: 0.42 },
      })
    }
    if (url.pathname === "/ptt/cancel") return json({ ok: true, cancelled: true })
    if (url.pathname === "/speak") return json({ ok: true, backend: "fake", spoken: true })
    if (url.pathname === "/health") {
      return json({
        ok: true,
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
})

const editor = {
  plainText: "",
  gotoBufferEnd() {},
  insertText(text: string) {
    this.plainText += text
  },
  focus() {},
}

const sent: string[] = []
const sentRaw: any[] = []
const dispatched: string[] = []
let hostCommands: any[] = []
let agentBusy = false
const context: any = {
  options: {},
  storage: { store: () => [store, setStore] },
  renderer: { currentFocusedEditor: editor, requestRender() {}, on() {} },
  keymap: {
    commands: () => hostCommands,
    dispatch: (id: string) => {
      dispatched.push(id)
      // The host empties the prompt when it clears it, and when it really
      // submits. A "prompt.submit" without the command does nothing.
      if (id === "prompt.clear") editor.plainText = ""
      else if (id === "prompt.submit" && hostCommands.some((c: any) => c?.id === "prompt.submit")) {
        editor.plainText = ""
      }
    },
  },
  ui: {
    toast: { show() {} },
    dialog: {},
    router: { current: () => ({ type: "session", sessionID: "ses_test" }) },
  },
  data: {
    session: {
      list: () => [{ id: "ses_test" }],
      // The agent picks the message up right after it is sent.
      status: () => (agentBusy ? "busy" : "idle"),
      message: { list: () => [], sync: async () => {} },
    },
  },
  client: {
    server: { info: async () => ({ version: "2.1.1" }) },
    session: {
      prompt: async (input: any) => {
        sentRaw.push(input)
        // OpenCode 2.1 puts the text in `text.text`; 2.0 used a plain string.
        const text = typeof input?.text === "string" ? input.text : (input?.text?.text ?? input?.body?.text ?? "")
        sent.push(text)
        agentBusy = true
        setTimeout(() => {
          agentBusy = false
        }, 200)
        return { id: "msg_1", sessionID: "ses_test", type: "user", payload: { text } }
      },
    },
  },
}

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` (${detail})` : ""}`)
  if (!ok) failures += 1
}

const voice = createVoiceController(context)

// 1. Default: the transcript lands in the prompt box and is NOT sent.
await voice.toggleMic("ses_test")
check("the transcript reaches the prompt box", editor.plainText === "hello from the microphone", editor.plainText)
check("nothing is sent without a review", sent.length === 0, `sent=${sent.length}`)
check("auto-send is off by default", voice.autoSend() === false)

// 2. With auto-send on, the transcript is submitted to the agent. Without a
//    host submit command the plugin falls back to the client API.
setStore("autoSend", true)
editor.plainText = ""
await voice.toggleMic("ses_test")
check("auto-send submits the transcript", sent.length === 1 && sent[0] === "hello from the microphone", sent.join("|"))
check(
  "auto-send uses the OpenCode 2.1 prompt shape",
  sentRaw[0]?.text?.text === "hello from the microphone" && sentRaw[0]?.sessionID === "ses_test",
  JSON.stringify(sentRaw[0]),
)

// 3. With the host's own submit command the text is typed into the prompt
//    and the host sends it - the way Enter does. This is the path that
//    works in a brand new chat, where no session id exists yet.
hostCommands = [{ id: "prompt.submit" }]
const sentBefore = sent.length
editor.plainText = ""
dispatched.length = 0
await voice.toggleMic("ses_test")
check("the host submit command is used when it exists", dispatched.includes("prompt.submit"), dispatched.join(","))
check("the host cleared the prompt, so it was sent", editor.plainText === "", editor.plainText)
check("the client API is not used twice", sent.length === sentBefore, `${sentBefore} -> ${sent.length}`)
hostCommands = []

// 4. The picked microphone travels with the turn.
setStore("micSource", "pulse:jarvis_mic")
await voice.toggleMic("ses_test")
check("the chosen microphone is sent with the turn", startBody?.mic?.device === "pulse:jarvis_mic", JSON.stringify(startBody?.mic))

setStore("micSource", "")
await voice.toggleMic("ses_test")
check("automatic means no device in the request", startBody?.mic?.device === "", JSON.stringify(startBody?.mic))

// 5. Live mode: record, send, read the answer, and keep going until it is
//    switched off.
setStore("autoSend", true)
const sentBeforeLive = sent.length
const liveRun = voice.toggleLive("ses_test")
await new Promise((r) => setTimeout(r, 1500))
check("live mode is on", voice.live() === true)
check("live mode sent the transcript", sent.length > sentBeforeLive, `${sentBeforeLive} -> ${sent.length}`)
await voice.toggleLive("ses_test")
await liveRun
check("live mode is off again", voice.live() === false)

server.stop(true)
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll flow checks passed.")
process.exit(0)
