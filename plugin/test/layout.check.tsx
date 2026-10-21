/**
 * Where do the two buttons sit?
 *
 *   - the mic button belongs at the bottom of the text box, on the right
 *   - the live toggle belongs above the text box, on the same right edge
 *
 * The host's composer slot is narrower than the text box, so the toggle has
 * to be given the width that reaches the mic button - otherwise it floats in
 * the middle of the screen (the bug this check guards).
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
const { ComposerLiveButton, MicButton, PromptFooterLive } = await import("../ui.tsx")

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
let areaBox: any = null
const voice: any = {
  editor: () => areaBox,
  mic: () => "idle",
  live: () => false,
  addRepaint: (fn: () => void) => fn(),
  removeRepaint: () => {},
  toggleLive: async (sid?: string) => {
    calls.push(`toggleLive:${sid ?? "-"}`)
  },
}

// The microphone emoji is drawn two columns wide but measured as one, so the
// comparison is done in columns and allows that one column of slack.
const columns = (line: string) => {
  let n = 0
  for (const ch of line.trimEnd()) n += ch.codePointAt(0)! > 0x2000 ? 2 : 1
  return n
}

function checkArrangement(label: string, setup: any) {
  const lines = setup.captureCharFrame().split("\n")
  const liveRow = lines.findIndex((l) => l.includes("live"))
  const micRow = lines.findIndex((l) => l.includes("mic"))
  const liveRight = liveRow >= 0 ? columns(lines[liveRow]) : -1
  const micRight = micRow >= 0 ? columns(lines[micRow]) : -1
  console.log(`--- ${label} ---`)
  console.log(setup.captureCharFrame())
  check(`${label}: the live toggle is rendered`, liveRow >= 0, `row=${liveRow}`)
  check(`${label}: the live toggle is above the text box`, liveRow === 0, `row=${liveRow}`)
  check(`${label}: the mic button is below`, micRow > liveRow, `mic=${micRow}`)
  check(
    `${label}: the live toggle lines up with the mic button on the right`,
    liveRight > 0 && micRight > 0 && Math.abs(liveRight - micRight) <= 1,
    `liveRight=${liveRight} micRight=${micRight}`,
  )
}

// A session: the toggle sits in the composer slot above the text box. The
// slot is narrower than the box, like the host's.
{
  const setup = await testRender(
    () => (
      <box width={40} height={9} flexDirection="column">
        <box width={18} flexShrink={0}>
          <ComposerLiveButton context={{ theme }} voice={voice} sessionID="ses_x" />
        </box>
        <box flexGrow={1} flexDirection="column">
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
  await new Promise((r) => setTimeout(r, 700))
  await setup.renderOnce()
  checkArrangement("session", setup)
  setup.renderer.destroy()
}

// A brand new chat: there is no slot above the text box, so the toggle is
// anchored to the row over the box from the prompt footer.
{
  const setup = await testRender(
    () => (
      <box width={40} height={9} flexDirection="column">
        <box height={1}>
          <text>header row</text>
        </box>
        <box flexGrow={1} flexDirection="column">
          <box height={3} ref={(el: any) => (areaBox = el)}>
            <text>type here</text>
          </box>
          <box flexDirection="row" justifyContent="flex-end">
            <PromptFooterLive context={{ theme }} voice={voice} sessionID="ses_x" />
          </box>
        </box>
      </box>
    ) as never,
    { width: 40, height: 9 },
  )
  await setup.renderOnce()
  await new Promise((r) => setTimeout(r, 700))
  await setup.renderOnce()
  checkArrangement("new chat", setup)
  setup.renderer.destroy()
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll layout checks passed.")
process.exit(0)
