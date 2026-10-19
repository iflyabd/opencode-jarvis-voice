/**
 * Headless checks for the Jarvis Voice buttons and plugin wiring.
 *
 * Runs the same runtime-plugin-support bootstrap the OpenCode TUI uses, mounts
 * the real components in a test renderer, and clicks them with the mock mouse.
 * No daemon, no audio: the controller is faked so a click can only prove that
 * the wiring is right.
 *
 *   bun run test:ui
 */

import { ensurePluginRuntime, provides } from "@opencode/plugin/runtime"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensurePluginRuntime()
ensureRuntimePluginSupport({
  additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } },
  preserve: provides,
})

const { testRender } = await import("@opentui/solid")
const { MicButton, SpeakButton } = await import("../ui.tsx")
const plugin = await import("../tui.tsx")

/* ------------------------------------------------------------- assertions */

let failures = 0
function check(name: string, condition: boolean, detail?: string) {
  console.log(`[${condition ? "PASS" : "FAIL"}] ${name}${detail && !condition ? ` — ${detail}` : ""}`)
  if (!condition) failures += 1
}

/* ------------------------------------------------------------- fake theme */

// Every token the buttons may read; shapes mirror ResolvedTheme.
const theme = {
  text: {
    base: "#d0d0d0",
    muted: "#808080",
    action: {
      primary: { base: "#5f87ff", hovered: "#87afff" },
      secondary: { base: "#8787af", hovered: "#afafd7" },
      destructive: { base: "#ff5f5f", hovered: "#ff8787" },
    },
    feedback: {
      error: { base: "#ff5f5f", muted: "#af5f5f" },
      warning: { base: "#ffaf00", muted: "#af8700" },
      success: { base: "#5fd75f", muted: "#3faf3f" },
      info: { base: "#5fafff", muted: "#3f87af" },
    },
  },
}

/* --------------------------------------------------------- fake controller */

type FakeVoice = {
  calls: string[]
  voice: Record<string, unknown>
  setMic: (state: string) => void
  setSpeech: (state: string) => void
}

function fakeVoice(mic = "idle", speech = "idle"): FakeVoice {
  let micState = mic
  let speechState = speech
  const calls: string[] = []
  const voice = {
    mic: () => micState,
    speech: () => speechState,
    autoSpeak: () => true,
    speakText: async () => true,
    speakLast: async () => {},
    pauseResume: async (sid?: string) => {
      calls.push(`pauseResume:${sid ?? "-"}`)
    },
    toggleMic: async (sid?: string) => {
      calls.push(`toggleMic:${sid ?? "-"}`)
    },
    cancel: async () => {},
    status: async () => {},
    toggleAutoSpeak: () => {},
    refreshSpeech: async () => {},
    dispose: () => {},
  }
  return {
    calls,
    voice,
    setMic: (state: string) => {
      micState = state
    },
    setSpeech: (state: string) => {
      speechState = state
    },
  }
}

async function mount(render: () => unknown, width = 40, height = 3) {
  const setup = await testRender(render as () => never, { width, height })
  await setup.renderOnce()
  return setup
}

/* --------------------------------------------------------------- mic button */

{
  const f = fakeVoice()
  const s = await mount(() => MicButton({ context: { theme }, voice: f.voice, sessionID: "ses_abc" }))
  const frame = s.captureCharFrame()
  check("mic button renders idle label", frame.includes("mic"), JSON.stringify(frame))
  await s.mockMouse.click(2, 0)
  await s.renderOnce()
  check("mic click calls toggleMic with the slot's session", f.calls.includes("toggleMic:ses_abc"), f.calls.join(","))
  s.renderer.destroy()
}

{
  const f = fakeVoice("listening")
  const s = await mount(() => MicButton({ context: { theme }, voice: f.voice }))
  check("mic button shows listening state", s.captureCharFrame().includes("listening"), JSON.stringify(s.captureCharFrame()))
  s.renderer.destroy()
}

{
  const f = fakeVoice("transcribing")
  const s = await mount(() => MicButton({ context: { theme }, voice: f.voice }))
  check(
    "mic button shows transcribing state",
    s.captureCharFrame().includes("transcribing"),
    JSON.stringify(s.captureCharFrame()),
  )
  s.renderer.destroy()
}

/* ------------------------------------------------------------- speak button */

{
  const f = fakeVoice()
  const s = await mount(() => SpeakButton({ context: { theme }, voice: f.voice, sessionID: "ses_xyz" }), 40, 3)
  check("speak button renders idle label", s.captureCharFrame().includes("read"), JSON.stringify(s.captureCharFrame()))
  await s.mockMouse.click(34, 0)
  await s.renderOnce()
  check("speak click calls pauseResume with the slot's session", f.calls.includes("pauseResume:ses_xyz"), f.calls.join(","))
  s.renderer.destroy()
}

{
  const f = fakeVoice("idle", "playing")
  const s = await mount(() => SpeakButton({ context: { theme }, voice: f.voice }), 40, 3)
  check("speak button shows pause while playing", s.captureCharFrame().includes("pause"), JSON.stringify(s.captureCharFrame()))
  s.renderer.destroy()
}

{
  const f = fakeVoice("idle", "paused")
  const s = await mount(() => SpeakButton({ context: { theme }, voice: f.voice }), 40, 3)
  check("speak button shows resume while paused", s.captureCharFrame().includes("resume"), JSON.stringify(s.captureCharFrame()))
  s.renderer.destroy()
}

/* ----------------------------------------------------------- answer picking */

{
  const { assistantAnswerText, latestAnswerText, speakable } = await import("../controller.ts")

  const withThinking = {
    type: "assistant",
    content: [
      { type: "reasoning", text: "Let me think about the deep internal reasoning..." },
      { type: "text", text: "Let me look at the files first." },
      { type: "tool", id: "t1" },
      { type: "text", text: "The answer is 42." },
    ],
  }
  check(
    "reads only the final answer text part",
    assistantAnswerText(withThinking) === "The answer is 42.",
    JSON.stringify(assistantAnswerText(withThinking)),
  )
  check(
    "never reads reasoning parts",
    !assistantAnswerText(withThinking).includes("thinking"),
  )
  check(
    "reasoning-only message is empty",
    assistantAnswerText({ type: "assistant", content: [{ type: "reasoning", text: "hmm hmm" }] }) === "",
  )
  check(
    "latest answer skips trailing user turns",
    latestAnswerText([
      { type: "user", content: [{ type: "text", text: "question?" }] },
      { type: "assistant", content: [{ type: "text", text: "answer one" }] },
      { type: "user", content: [{ type: "text", text: "next question" }] },
    ]) === "answer one",
  )
  check("code-only reply is not spoken", speakable("```js\nconst x = 1\n```") === "", JSON.stringify(speakable("```js\nconst x = 1\n```")))
  const long = speakable(`${"This is a sentence with real words. ".repeat(100)}`)
  check("long reply is cut to a brief length", long.length <= 601, `len=${long.length}`)
  check("markdown fences are not read", !speakable("Hi ```code here``` bye").includes("code here"))
}

/* ----------------------------------------------------------- plugin wiring */

{
  const slots: any[] = []
  const layers: any[] = []
  const context: any = {
    options: {},
    ui: { slot: (claim: any) => slots.push(claim), toast: { show: () => {} } },
    keymap: { layer: (make: any) => layers.push(make()) },
    theme,
    data: { session: { list: () => [] } },
    client: {},
  }
  const cleanup = await plugin.default.setup(context)
  check("plugin registers two slots", slots.length === 2, `got ${slots.length}`)
  check(
    "mic button appends to prompt.footer",
    slots.some((s) => s.append === "prompt.footer" && typeof s.render === "function"),
    slots.map((s) => s.append).join(","),
  )
  check(
    "speak button appends to session.composer.top",
    slots.some((s) => s.append === "session.composer.top" && typeof s.render === "function"),
    slots.map((s) => s.append).join(","),
  )
  const layer = layers[0]
  const ids = (layer?.commands ?? []).map((c: any) => c.id)
  check(
    "pause/resume command exists with a keybinding",
    ids.includes("voice.pauseResume") && (layer?.bindings ?? []).includes("voice.pauseResume"),
    ids.join(","),
  )
  check("setup returns a cleanup function", typeof cleanup === "function", typeof cleanup)
  if (typeof cleanup === "function") cleanup()
}

/* ------------------------------------------------------------------ result */

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll UI checks passed.")
process.exit(0)
