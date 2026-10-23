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
// "turn" ends after two polls; "hold" keeps the microphone open with a
// caption, the way a live conversation waits for the user to speak.
let stateMode: "turn" | "hold" = "turn"
let stopTurns = false
let startFails = 0
const spokenByDaemon: string[] = []
const spokenBodies: any[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
    if (url.pathname === "/ping") return json({ ok: true })
    if (url.pathname === "/ptt/start") {
      startBody = await req.json()
      if (startFails > 0) {
        startFails -= 1
        return new Response(
          JSON.stringify({ error: "microphone 'index:99' could not be opened. sounddevice: nope" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }
      polls = 0
      return json({ ok: true, ptt: { id: "ptt-1", state: "listening" } })
    }
    if (url.pathname === "/ptt/state") {
      polls += 1
      if (stateMode === "hold") {
        return json({ ok: true, ptt: { id: "ptt-1", state: "listening", partial: "hello from", level: 0.05 } })
      }
      return json({ ok: true, ptt: { id: "ptt-1", state: polls > 1 ? "done" : "listening" } })
    }
    if (url.pathname === "/ptt/stop") {
      if (stopTurns) {
        return json({ ok: true, id: "ptt-1", state: "done", text: "", empty: true, stats: { rms: 0.0 } })
      }
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
    if (url.pathname === "/speak") {
      const body = await req.json().catch(() => ({}))
      spokenByDaemon.push(String((body as any)?.text ?? ""))
      spokenBodies.push(body)
      return json({ ok: true, backend: "fake", spoken: true, queued: Boolean((body as any)?.append) })
    }
    if (url.pathname === "/speech") return json({ ok: true, active: false, paused: false })
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
let answerReady = false
let answerID = "msg_answer"
let answerText = "It is sunny in Berlin today"
let eventHandler: any = undefined
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
      get: (id: string) => ({ id, title: "Weather in Berlin" }),
      message: {
        list: () => (answerReady
          ? [
              {
                id: answerID,
                type: "assistant",
                time: { created: Date.now() + 1000 },
                content: [{ type: "text", text: answerText }],
              },
            ]
          : []),
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

// 5. Live mode: record, send, keep going until it is switched off - and do
//    it like a phone call: short hangover, a caption while listening, the
//    microphone kept open, and the answer read while it streams.
setStore("autoSend", true)
setStore("micSource", "pulse:jarvis_mic")
const sentBeforeLive = sent.length
const liveRun = voice.toggleLive("ses_test")
await new Promise((r) => setTimeout(r, 900))
check("live mode is on", voice.live() === true)
check("live mode sent the transcript", sent.length > sentBeforeLive, `${sentBeforeLive} -> ${sent.length}`)
check(
  "live mode uses the microphone chosen in the settings",
  startBody?.mic?.device === "pulse:jarvis_mic",
  JSON.stringify(startBody?.mic),
)
check(
  "a live turn ends on a short pause",
  startBody?.silence_ms === 450,
  JSON.stringify(startBody?.silence_ms),
)
check(
  "a live turn asks for the caption and keeps the microphone open",
  startBody?.partial === true && startBody?.keep_warm === true,
  JSON.stringify({ partial: startBody?.partial, keep_warm: startBody?.keep_warm }),
)
check(
  "a live turn understands any language on the first pass",
  startBody?.stt?.local?.live === true && startBody?.stt?.local?.beam === 1,
  JSON.stringify(startBody?.stt?.local),
)

// 6. While the microphone is held open, the caption shows what is heard and
//    the answer is spoken while it is still being written.
stateMode = "hold"
stopTurns = true
await new Promise((r) => setTimeout(r, 400))
check("the live caption shows what the microphone hears", voice.liveCaption() === "hello from", voice.liveCaption())

agentBusy = true
answerReady = true
answerID = "msg_stream"
answerText = "First sentence is ready. Second one is still bei"
spokenByDaemon.length = 0
spokenBodies.length = 0
eventHandler?.({ details: { type: "message.updated" } })
await new Promise((r) => setTimeout(r, 1000))
check(
  "a finished sentence is read while the answer streams",
  spokenByDaemon.some((t) => t.includes("First sentence is ready.")),
  JSON.stringify(spokenByDaemon),
)
check(
  "a half-written sentence is not read",
  !spokenByDaemon.join(" ").includes("still bei"),
  JSON.stringify(spokenByDaemon),
)
check(
  "a streamed sentence is appended, not forced over the voice",
  spokenBodies.every((b) => b?.append === true),
  JSON.stringify(spokenBodies.map((b) => b?.append)),
)
answerText = "First sentence is ready. Second one is still being written."
agentBusy = false
eventHandler?.({ details: { type: "message.updated" } })
await new Promise((r) => setTimeout(r, 1200))
check(
  "the rest of the answer follows when it is complete",
  spokenByDaemon.some((t) => t.includes("Second one is still being written.")),
  JSON.stringify(spokenByDaemon),
)

await voice.toggleLive("ses_test")
await liveRun
check("live mode is off again", voice.live() === false)
stateMode = "turn"
stopTurns = false
answerReady = false
answerID = "msg_answer"
answerText = "It is sunny in Berlin today"

// 7. Auto-speak: a new answer is read out loud, with the session name first.
answerReady = true
spokenByDaemon.length = 0
eventHandler?.({ details: { type: "message.updated" } })
await new Promise((r) => setTimeout(r, 1200))
check(
  "the new answer is read out loud",
  spokenByDaemon.length === 1,
  `spoken=${JSON.stringify(spokenByDaemon)}`,
)
check(
  "the session subject comes before the answer",
  (spokenByDaemon[0] ?? "").startsWith("About weather in Berlin.") &&
    (spokenByDaemon[0] ?? "").includes("It is sunny in Berlin today"),
  JSON.stringify(spokenByDaemon[0]),
)

// 7. The same answer is never read twice.
eventHandler?.({ details: { type: "message.updated" } })
await new Promise((r) => setTimeout(r, 1200))
check("an answer is not read twice", spokenByDaemon.length === 1, `spoken=${JSON.stringify(spokenByDaemon)}`)

// 8. With auto-speak off, nothing is read.
setStore("autoSpeak", false)
answerReady = false
spokenByDaemon.length = 0
answerReady = true
eventHandler?.({ details: { type: "message.updated" } })
await new Promise((r) => setTimeout(r, 1200))
check("nothing is read with auto-speak off", spokenByDaemon.length === 0, `spoken=${JSON.stringify(spokenByDaemon)}`)

// 9. A microphone that cannot open must not end the live conversation: the
//    reason is shown, and the next turn tries again.
startFails = 2
const sentBeforeRetry = sent.length
const retryRun = voice.toggleLive("ses_test")
await new Promise((r) => setTimeout(r, 1500))
check("live mode stays on when the microphone cannot open", voice.live() === true)
await new Promise((r) => setTimeout(r, 2300))
check(
  "live mode retries the microphone after a failure",
  sent.length > sentBeforeRetry,
  `${sentBeforeRetry} -> ${sent.length}`,
)
await voice.toggleLive("ses_test")
await retryRun
check("live mode can still be stopped after a microphone failure", voice.live() === false)

server.stop(true)
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll flow checks passed.")
process.exit(0)
