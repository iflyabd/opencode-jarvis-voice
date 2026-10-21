/**
 * Where do the two buttons sit?
 *
 *   - the mic button belongs at the bottom of the text box, on the right
 *   - the live toggle belongs above the text box, on the same right edge
 *
 * The host's composer slot is narrower than the text box, so the toggle has
 * to be moved to the right edge of the box by hand - otherwise it floats in
 * the middle of the screen (see the bug this check guards).
 *
 *   bun run test:layout
 */

import path from "node:path"

const solidEntry = Bun.resolveSync("@opentui/solid", import.meta.dir)
const { ensureSolidTransformPlugin } = await import(path.join(path.dirname(solidEntry), "scripts/solid-plugin.js"))
ensureSolidTransformPlugin()

const { ensurePluginRuntime } = await import("@opencode/plugin/runtime")
ensurePluginRuntime()
const { testRender } = await import("@opentui/solid")
const { ComposerLiveButton, MicButton } = await import("../ui.tsx")

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` (${detail})` : ""}`)
  if (!ok) failures += 1
}

const theme = {
  text: {
    action: { secondary: { base: "#888", hovered: "#aaa" } },
    feedback: { error: { base: "#f00", muted: "#a00" }, info: { base: "#0af", muted: "#08a" } },
  },
}

const calls: string[] = []
const voice: any = {
  mic: () => "idle",
  live: () => false,
  addRepaint: (fn: () => void) => fn(),
  removeRepaint: () => {},
  toggleLive: async (sid?: string) => {
    calls.push(`toggleLive:${sid ?? "-"}`)
  },
}

// The host's layout: a narrow composer slot above the prompt, and the prompt
// itself with a model row, the text area and the footer row.
const setup = await testRender(
  () => (
    <box width={40} height={9} flexDirection="column">
      <box flexShrink={0}>
        <ComposerLiveButton context={{ theme }} voice={voice} sessionID="ses_x" />
      </box>
      <box flexGrow={1} flexDirection="column">
        <box height={1}>
          <text>model · max</text>
        </box>
        <box height={3}>
          <text>type here</text>
        </box>
        <box flexDirection="row" justifyContent="flex-end">
          <MicButton context={{ theme }} voice={voice} sessionID="ses_x" />
        </box>
      </box>
    </box>
  ) as never,
  { width: 40, height: 9 },
)
await setup.renderOnce()
// The toggle is moved to the right edge of the box once the mic is measured.
await new Promise((r) => setTimeout(r, 700))
await setup.renderOnce()
const frame = setup.captureCharFrame()
console.log(frame)
const lines = frame.split("\n")
const liveRow = lines.findIndex((l) => l.includes("live"))
const micRow = lines.findIndex((l) => l.includes("mic"))
// The microphone emoji is drawn two columns wide but measured as one, so the
// comparison is done in columns and allows that one column of slack.
const columns = (line: string) => {
  let n = 0
  for (const ch of line.trimEnd()) n += ch.codePointAt(0)! > 0x2000 ? 2 : 1
  return n
}
const liveRight = liveRow >= 0 ? columns(lines[liveRow]) : -1
const micRight = micRow >= 0 ? columns(lines[micRow]) : -1
check("the live toggle is rendered", liveRow >= 0, `row=${liveRow}`)
check("the live toggle is above the text box", liveRow === 0, `row=${liveRow}`)
check("the mic button is in the footer", micRow >= 0, `row=${micRow}`)
check(
  "the live toggle lines up with the mic button on the right",
  liveRight > 0 && micRight > 0 && Math.abs(liveRight - micRight) <= 1,
  `liveRight=${liveRight} micRight=${micRight}`,
)
setup.renderer.destroy()

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll layout checks passed.")
process.exit(0)
