/**
 * Where does the live button land on the home screen?
 *
 * The home screen (a new chat) publishes no slot above the text box, so the
 * toggle is anchored to the top-right of the text area with an absolutely
 * positioned box inside the prompt footer. The mic button must stay in the
 * footer row, and the toggle must not cover it.
 *
 *   bun run test:layout
 */

import path from "node:path"

const solidEntry = Bun.resolveSync("@opentui/solid", import.meta.dir)
const { ensureSolidTransformPlugin } = await import(path.join(path.dirname(solidEntry), "scripts/solid-plugin.js"))
ensureSolidTransformPlugin()

const { ensurePluginRuntime } = await import("@opencode/plugin/runtime")
ensurePluginRuntime()
const { testRender, createElement } = await import("@opentui/solid")

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` (${detail})` : ""}`)
  if (!ok) failures += 1
}

const refs: any = {}

// The pieces the plugin builds: a positioned wrapper, an absolutely
// positioned anchor inside it, and the mic next to it.
function buildFooter(area: any) {
  const wrapper: any = createElement("box", {})
  wrapper.position = "relative"
  wrapper.flexShrink = 0
  wrapper.flexDirection = "row"
  wrapper.justifyContent = "flex-end"

  const anchor: any = createElement("box", {})
  anchor.position = "absolute"
  anchor.right = 0
  anchor.top = -1
  anchor.zIndex = 2000
  anchor.flexShrink = 0

  const live: any = createElement("text", {})
  live.content = "LIVE"
  anchor.add(live)
  wrapper.add(anchor)

  const mic: any = createElement("text", {})
  mic.content = "mic"
  wrapper.add(mic)

  // The plugin measures the text area and moves the anchor up to it.
  const sync = () => {
    const top = area?.y
    const base = wrapper.y
    if (typeof top !== "number" || typeof base !== "number") return
    const offset = Math.round(top - base)
    if (anchor.top !== offset) anchor.top = offset
  }
  refs.wrapper = wrapper
  refs.anchor = anchor
  refs.area = area
  refs.sync = sync
  return wrapper
}

const setup = await testRender(
  () => (
    <box width={30} height={8} position="relative" flexDirection="column">
      <box height={1}>
        <text>header row</text>
      </box>
      <box height={3} ref={(el: any) => (refs.areaBox = el)}>
        <text>type here</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end">
        {buildFooter(refs.areaBox)}
      </box>
    </box>
  ) as never,
  { width: 30, height: 8 },
)
await setup.renderOnce()
refs.sync?.()
await setup.renderOnce()
const frame = setup.captureCharFrame()
console.log(frame)
const lines = frame.split("\n")
const liveRow = lines.findIndex((l) => l.includes("LIVE"))
const micRow = lines.findIndex((l) => l.includes("mic"))
console.log("area.y", refs.area?.y, "wrapper.y", refs.wrapper?.y, "anchor.top", refs.anchor?.top)
check("the live button is rendered", liveRow >= 0, `row=${liveRow}`)
check("the live button is above the mic button", liveRow >= 0 && micRow >= 0 && liveRow < micRow, `live=${liveRow} mic=${micRow}`)
check("the live button is at the top of the text area", liveRow === 1, `row=${liveRow}`)
check("the live button is on the right", lines[liveRow]?.trimEnd().endsWith("LIVE") === true, JSON.stringify(lines[liveRow]))
check("the mic button is still in the footer", micRow >= 0 && lines[micRow]?.includes("mic") === true, JSON.stringify(lines[micRow]))
setup.renderer.destroy()

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll layout checks passed.")
process.exit(0)
