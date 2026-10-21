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

import path from "node:path"

// Bun resolves bare `solid-js` to Solid's inert SSR build (the "node" export
// condition); the real TUI bundles the live build. Register OpenTUI's
// server.js -> solid.js patch before the first solid-js import so this process
// runs the same live runtime the host uses.
const solidEntry = Bun.resolveSync("@opentui/solid", import.meta.dir)
const { ensureSolidTransformPlugin } = await import(path.join(path.dirname(solidEntry), "scripts/solid-plugin.js"))
ensureSolidTransformPlugin()

const { ensurePluginRuntime, provides } = await import("@opencode/plugin/runtime")
ensurePluginRuntime()
const { Plugin, PluginContextProvider, usePlugin } = await import("@opencode/plugin/tui")
const { ensureRuntimePluginSupport } = await import("@opentui/solid/runtime-plugin-support/configure")
ensureRuntimePluginSupport({
  additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } },
  preserve: provides,
})

const { testRender } = await import("@opentui/solid")
const { MicButton, SpeakButton } = await import("../ui.tsx")
const plugin = await import("../tui.tsx")
// The same Solid runtime the components use; the live-update checks below
// exercise the real signal path instead of re-mounting with a fixed state.
const solid = await import("solid-js")

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
  // Real signals, exactly like the controller: the buttons read them when the
  // controller repaints them. The repaint registry mirrors the controller's:
  // a state change must repaint the registered text nodes, which is what
  // proves the buttons update LIVE instead of only at mount.
  const { createSignal } = solid
  const [micState, setMicState] = createSignal(mic)
  const [speechState, setSpeechState] = createSignal(speech)
  const repaints = new Set<() => void>()
  const repaint = () => {
    for (const fn of repaints) fn()
  }
  const calls: string[] = []
  const voice = {
    mic: micState,
    speech: speechState,
    addRepaint: (fn: () => void) => {
      repaints.add(fn)
      fn()
    },
    removeRepaint: (fn: () => void) => {
      repaints.delete(fn)
    },
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
      setMicState(() => state)
      repaint()
    },
    setSpeech: (state: string) => {
      setSpeechState(() => state)
      repaint()
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

  // LIVE updates: same mounted component, state changes underneath it. This is
  // what a fresh-mount test cannot catch and what the buttons must survive in
  // the real TUI.
  f.setMic("listening")
  await s.renderOnce()
  check("mic label updates live to listening", s.captureCharFrame().includes("listening"), JSON.stringify(s.captureCharFrame()))
  f.setMic("transcribing")
  await s.renderOnce()
  check("mic label updates live to transcribing", s.captureCharFrame().includes("transcribing"), JSON.stringify(s.captureCharFrame()))
  f.setMic("idle")
  await s.renderOnce()
  const back = s.captureCharFrame()
  check("mic label returns live to idle", back.includes("mic") && !back.includes("listening"), JSON.stringify(back))
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

  // LIVE updates on the same mounted button: read -> pause -> resume -> read.
  f.setSpeech("playing")
  await s.renderOnce()
  check("speak label updates live to pause", s.captureCharFrame().includes("pause"), JSON.stringify(s.captureCharFrame()))
  f.setSpeech("paused")
  await s.renderOnce()
  check("speak label updates live to resume", s.captureCharFrame().includes("resume"), JSON.stringify(s.captureCharFrame()))
  f.setSpeech("idle")
  await s.renderOnce()
  check("speak label returns live to read", s.captureCharFrame().includes("read"), JSON.stringify(s.captureCharFrame()))
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
  const { assistantAnswerText, latestAnswerText, speakable, FISH_STT_LANGUAGES } = await import("../controller.ts")

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
  const longText = `${"This is a sentence with real words. ".repeat(100)}`.trim()
  const long = speakable(longText)
  check("long reply is read in full", long.length > 600 && long.endsWith("real words."), `len=${long.length}`)
  check("an explicit speech limit still clips", speakable(longText, 600).length <= 601)
  check("markdown fences are not read", !speakable("Hi ```code here``` bye").includes("code here"))

  const sttCodes = FISH_STT_LANGUAGES.map((item) => item.code)
  check("Fish STT exposes a broad language list", sttCodes.length >= 60, `codes=${sttCodes.length}`)
  check(
    "Fish STT includes major world languages",
    ["en", "zh", "ja", "ko", "es", "ar", "hi", "fr", "de", "pt"].every((code) => sttCodes.includes(code)),
    sttCodes.join(","),
  )
  check("Fish STT language codes are unique", new Set(sttCodes).size === sttCodes.length)
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
