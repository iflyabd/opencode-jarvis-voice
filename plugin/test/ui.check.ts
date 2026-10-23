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
const { ComposerLiveButton, MicButton } = await import("../ui.tsx")
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
  setLive: (state: boolean) => void
  setAutoSpeak: (state: boolean) => void
  setAutoSend: (state: boolean) => void
}

function fakeVoice(mic = "idle", speech = "idle", live = false): FakeVoice {
  // Real signals, exactly like the controller: the buttons read them when the
  // controller repaints them. The repaint registry mirrors the controller's:
  // a state change must repaint the registered text nodes, which is what
  // proves the buttons update LIVE instead of only at mount.
  const { createSignal } = solid
  const [micState, setMicState] = createSignal(mic)
  const [speechState, setSpeechState] = createSignal(speech)
  const [liveState, setLiveState] = createSignal(live)
  const [autoSpeakState, setAutoSpeakState] = createSignal(true)
  const [autoSendState, setAutoSendState] = createSignal(false)
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
    autoSpeak: autoSpeakState,
    autoSend: autoSendState,
    live: liveState,
    toggleLive: async (sid?: string) => {
      calls.push(`toggleLive:${sid ?? "-"}`)
    },
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
    toggleAutoSpeak: () => {
      calls.push("toggleAutoSpeak")
      setAutoSpeakState((value) => !value)
      repaint()
    },
    toggleAutoSend: async () => {
      calls.push("toggleAutoSend")
      setAutoSendState((value) => !value)
      repaint()
    },
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
    setLive: (state: boolean) => {
      setLiveState(() => state)
      repaint()
    },
    setAutoSpeak: (state: boolean) => {
      setAutoSpeakState(() => state)
      repaint()
    },
    setAutoSend: (state: boolean) => {
      setAutoSendState(() => state)
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

/* ------------------------------------------------------------- live button */

{
  const f = fakeVoice()
  const s = await mount(() => ComposerLiveButton({ context: { theme }, voice: f.voice, sessionID: "ses_xyz" }), 40, 3)
  const firstFrame = s.captureCharFrame()
  check("the composer toolbar renders read", firstFrame.includes("read"), JSON.stringify(firstFrame))
  check("the composer toolbar renders send", firstFrame.includes("send"), JSON.stringify(firstFrame))
  check("the auto-read toggle has an auto- label", firstFrame.includes("◉ auto-read"), JSON.stringify(firstFrame))
  check("the auto-send toggle has an auto- label", firstFrame.includes("◇ auto-send"), JSON.stringify(firstFrame))
  check("the composer toolbar renders the master play control", firstFrame.includes("▶ play"), JSON.stringify(firstFrame))
  check("live button renders the idle label", firstFrame.includes("live"), JSON.stringify(firstFrame))

  const line = firstFrame.split("\n")[0] ?? ""
  const clickWord = async (word: string) => {
    const at = line.indexOf(word)
    check(`the ${word} control has a clickable position`, at >= 0, `line=${JSON.stringify(line)}`)
    if (at < 0) return
    await s.mockMouse.click(at, 0)
    await s.renderOnce()
  }

  await clickWord("read")
  check("read click toggles auto-read", f.calls.includes("toggleAutoSpeak"), f.calls.join(","))
  check("auto-read turns off in place", s.captureCharFrame().includes("○ auto-read"), JSON.stringify(s.captureCharFrame()))
  f.setAutoSpeak(true)
  await s.renderOnce()
  check("auto-read turns back on in place", s.captureCharFrame().includes("◉ auto-read"), JSON.stringify(s.captureCharFrame()))

  await clickWord("send")
  check("send click toggles auto-send", f.calls.includes("toggleAutoSend"), f.calls.join(","))
  check("auto-send turns on in place", s.captureCharFrame().includes("◆ auto-send"), JSON.stringify(s.captureCharFrame()))

  await clickWord("▶")
  check("master play calls pause/resume for the session", f.calls.includes("pauseResume:ses_xyz"), f.calls.join(","))
  f.setSpeech("playing")
  await s.renderOnce()
  check("master control shows pause while the reader is speaking", s.captureCharFrame().includes("⏸ pause"), JSON.stringify(s.captureCharFrame()))
  f.setSpeech("paused")
  await s.renderOnce()
  check("master control shows play while the reader is paused", s.captureCharFrame().includes("▶ play"), JSON.stringify(s.captureCharFrame()))
  f.setSpeech("idle")

  await s.mockMouse.click(36, 0)
  await s.renderOnce()
  check("live click calls toggleLive with the slot's session", f.calls.includes("toggleLive:ses_xyz"), f.calls.join(","))

  // The label follows the live state, live.
  f.setLive(true)
  await s.renderOnce()
  check("live label updates when the conversation starts", s.captureCharFrame().includes("● live"), JSON.stringify(s.captureCharFrame()))
  s.renderer.destroy()
}

{
  // The mic button stops the live conversation instead of recording.
  const f = fakeVoice("idle", "idle", true)
  const s = await mount(() => MicButton({ context: { theme }, voice: f.voice, sessionID: "ses_live" }), 40, 3)
  check("mic button shows the live state", s.captureCharFrame().includes("live"), JSON.stringify(s.captureCharFrame()))
  await s.mockMouse.click(2, 0)
  await s.renderOnce()
  check("mic click stops the live conversation", f.calls.includes("toggleLive:ses_live"), f.calls.join(","))
  check("mic click does not start a one-shot recording", !f.calls.includes("toggleMic:ses_live"), f.calls.join(","))
  s.renderer.destroy()
}

/* ----------------------------------------------------------- answer picking */

{
  const { assistantAnswerText, latestAnswerText, speakable, transcriptText, insertIntoEditor, FISH_STT_LANGUAGES } = await import(
    "../controller.ts"
  )

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

  const { naturalTitle, titleAnnouncement, titleSubject } = await import("../controller.ts")
  check(
    "a plain title becomes a natural subject",
    titleAnnouncement("Weather in Berlin") === "About weather in Berlin.",
    JSON.stringify(titleAnnouncement("Weather in Berlin")),
  )
  check(
    "the subject is the short noun phrase, not the whole title",
    titleSubject("Weather in Berlin") === "weather in Berlin",
    JSON.stringify(titleSubject("Weather in Berlin")),
  )
  check(
    "a path title names the thing, not the path",
    titleAnnouncement("/root/jarvis-voice/plugin/controller.ts") === "About the controller file.",
    JSON.stringify(titleAnnouncement("/root/jarvis-voice/plugin/controller.ts")),
  )
  check(
    "a path title with an instruction drops the imperative",
    titleAnnouncement("Fix /root/jarvis-voice/plugin/controller.ts") === "About the controller file.",
    JSON.stringify(titleAnnouncement("Fix /root/jarvis-voice/plugin/controller.ts")),
  )
  check(
    "a question title is summarized to its subject",
    titleAnnouncement("Why is the audio cutting out?") === "On the audio cutting out.",
    JSON.stringify(titleAnnouncement("Why is the audio cutting out?")),
  )
  check(
    "a question frame is removed without losing the noun",
    titleSubject("How does the reader work?") === "the reader",
    JSON.stringify(titleSubject("How does the reader work?")),
  )
  check(
    "a subject containing 'here' is not mistaken for a greeting",
    titleSubject("The reader here is broken") === "the reader",
    JSON.stringify(titleSubject("The reader here is broken")),
  )
  check(
    "a long instruction keeps only its leading subject",
    titleSubject("Implement dynamic reader roles with multiple versions and summarize titles") ===
      "dynamic reader roles",
    JSON.stringify(titleSubject("Implement dynamic reader roles with multiple versions and summarize titles")),
  )
  check(
    "a question inside a long title is reduced to the subject",
    titleSubject("First answer per session: Jarvis here, sir. About weather in Berlin.") ===
      "weather in Berlin",
    JSON.stringify(titleSubject("First answer per session: Jarvis here, sir. About weather in Berlin.")),
  )
  check(
    "an instruction keeps its real object",
    titleSubject("Update the README and bump all version files to 1.11.1") === "the README",
    JSON.stringify(titleSubject("Update the README and bump all version files to 1.11.1")),
  )
  check("a hash-only title is skipped", naturalTitle("3f2a9c1b") === "", JSON.stringify(naturalTitle("3f2a9c1b")))
  check("a generic new-session title is skipped", naturalTitle("New session") === "", JSON.stringify(naturalTitle("New session")))
  check(
    "a long path is replaced by the file name",
    speakable("Open /root/jarvis-voice/plugin/controller.ts.") === "Open the controller file.",
    JSON.stringify(speakable("Open /root/jarvis-voice/plugin/controller.ts.")),
  )
  check(
    "a link is not read as a URL",
    speakable("See https://example.com/docs.") === "See the link.",
    JSON.stringify(speakable("See https://example.com/docs.")),
  )
  check(
    "a commit hash is not spelled out",
    speakable("Commit a193906 fixed it.") === "Commit that fixed it.",
    JSON.stringify(speakable("Commit a193906 fixed it.")),
  )

  const { speechCut } = await import("../controller.ts")
  check(
    "a streamed answer is cut after a whole sentence",
    speechCut("First sentence. Second one is still bei") === "First sentence.".length,
    String(speechCut("First sentence. Second one is still bei")),
  )
  check(
    "a streamed answer is not cut inside a word",
    speechCut("No full stop yet and the mod") === 0,
    String(speechCut("No full stop yet and the mod")),
  )
  check(
    "a streamed answer is not cut inside a code block",
    speechCut("Look:\n```js\nconst x = 1\n```\nAnd done. Tail") === "Look:\n```js\nconst x = 1\n```\nAnd done.".length,
    String(speechCut("Look:\n```js\nconst x = 1\n```\nAnd done. Tail")),
  )
  check(
    "an unfinished code block is never read",
    speechCut("Look:\n```js\nconst x = 1") === 0,
    String(speechCut("Look:\n```js\nconst x = 1")),
  )
  check(
    "an inline code stop does not count as a sentence",
    speechCut("Use `a.b` here") === 0,
    String(speechCut("Use `a.b` here")),
  )

  const sttCodes = FISH_STT_LANGUAGES.map((item) => item.code)
  check("Fish STT exposes a broad language list", sttCodes.length >= 60, `codes=${sttCodes.length}`)
  check(
    "Fish STT includes major world languages",
    ["en", "zh", "ja", "ko", "es", "ar", "hi", "fr", "de", "pt"].every((code) => sttCodes.includes(code)),
    sttCodes.join(","),
  )
  check("Fish STT language codes are unique", new Set(sttCodes).size === sttCodes.length)

  // The daemon nests the turn result under `result` and also sends a flat
  // `text`. Reading the wrong one is what made every turn say "heard nothing".
  check("transcript is read from the flat field", transcriptText({ text: "hello there" }) === "hello there")
  check(
    "transcript is read from the nested result",
    transcriptText({ ok: true, result: { text: "hello there" } }) === "hello there",
  )
  check("an empty transcript stays empty", transcriptText({ result: { text: "  " } }) === "")
  check("a missing transcript is empty", transcriptText({}) === "")

  // The transcript has to land in the prompt box so it can be corrected.
  const editor = {
    plainText: "",
    gotoBufferEnd() {
      this.ended = true
    },
    insertText(text: string) {
      this.plainText += text
    },
  }
  check("the transcript is written into the prompt", insertIntoEditor(editor, "hello there") && editor.plainText === "hello there")
  editor.plainText = "already typed"
  insertIntoEditor(editor, "more words")
  check("the transcript is appended to what is there", editor.plainText === "already typed more words", editor.plainText)
  check("a missing editor is reported", insertIntoEditor(null, "hello") === false)
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
    "live button appends to session.composer.top",
    slots.some((s) => s.append === "session.composer.top" && typeof s.render === "function"),
    slots.map((s) => s.append).join(","),
  )
  check(
    "the prompt footer has one claim, so the mic button is never replaced",
    slots.filter((s) => (s.append ?? s.prepend) === "prompt.footer").length === 1,
    slots.map((s) => s.append ?? s.prepend).join(","),
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
