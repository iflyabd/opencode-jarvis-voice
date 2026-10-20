/**
 * Jarvis Voice - OpenCode server plugin.
 *
 * Gives the agent local ears and a local voice:
 *   voice_listen  - capture one spoken utterance from the mic and return the text
 *   voice_speak   - say text out loud through the local Piper voice
 *   voice_status  - report the audio / STT / TTS pipeline
 *
 * Everything runs on the device by default: Whisper (or Vosk / whisper.cpp) for
 * speech to text, Piper for the voice. No cloud calls, no API keys. The TUI
 * settings can optionally send spoken replies to Fish Audio; these agent tools
 * keep using the local voice.
 *
 * The heavy lifting lives in a small local daemon (see ./daemon) so this plugin
 * never needs a native audio stack.
 */

import { Plugin } from "@opencode/plugin"
import { DaemonError, api, ensureDaemon, summarize, type DaemonInfo, type Health } from "./daemon-client"

async function daemon(): Promise<DaemonInfo> {
  const info = await ensureDaemon({ start: true })
  if (!info) {
    throw new Error(
      "Jarvis Voice daemon is not running and could not be started. Run `voice up` (in the jarvis-voice folder) and try again.",
    )
  }
  return info
}

function errText(e: unknown): string {
  if (e instanceof DaemonError) {
    const hints = e.hints?.length ? `\n${e.hints.map((h) => `- ${h}`).join("\n")}` : ""
    // A missing microphone produces one line per audio backend; keep the first.
    const message = e.message.includes("no capture backend works")
      ? `microphone unavailable: ${e.message.split(" | ")[0]}`
      : e.message
    return `voice daemon error: ${message}${hints}`
  }
  return e instanceof Error ? e.message : String(e)
}

export default Plugin.define({
  id: "jarvis-voice",
  async setup(ctx) {
    // ------------------------------------------------------------------ tools
    const registration = await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "voice",
        description: "Local voice input and output (microphone, speech-to-text, text-to-speech).",
      })

      editor.add({
        name: "listen",
        description:
          "Listen to the microphone and return what the user said as text. Blocks until the user stops " +
          "speaking (silence detection) or the time limit is reached. Use this when the user asks you to " +
          "listen, or when a spoken answer is expected.",
        input: {
          type: "object",
          properties: {
            max_ms: { type: "number", description: "Hard limit for the whole utterance in milliseconds (default 30000)." },
            silence_ms: { type: "number", description: "Silence that ends the utterance, in milliseconds (default 900)." },
            start_timeout_ms: {
              type: "number",
              description: "How long to wait for speech to begin before giving up, in milliseconds (default 12000).",
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "voice" },
        execute: async (input, context) => {
          const args = (input ?? {}) as { max_ms?: number; silence_ms?: number; start_timeout_ms?: number }
          await context.progress?.({ status: "listening" })
          try {
            const info = await daemon()
            const started = Date.now()
            const res = await api.listen(
              info,
              {
                max_ms: args.max_ms ?? 30000,
                silence_ms: args.silence_ms,
                start_timeout_ms: args.start_timeout_ms,
              },
              (args.max_ms ?? 30000) + 60000,
            )
            const text = (res.text ?? "").trim()
            const reason = (res.stats as { reason?: string } | undefined)?.reason
            if (!text) {
              return {
                content:
                  `No speech detected via the ${info.platform} microphone (reason: ${reason ?? "silence"}). ` +
                  `Check the mic with \`voice doctor\`.`,
              }
            }
            return {
              content:
                `Heard (${res.backend ?? "stt"}, ${Date.now() - started} ms): "${text}"\n` +
                `Reason: ${reason ?? "ok"}`,
            }
          } catch (e) {
            return { content: errText(e) }
          }
        },
      })

      editor.add({
        name: "speak",
        description:
          "Say text out loud on the local speakers using the on-device Jarvis voice. Use it to answer " +
          "when the user is in voice mode, or when they ask you to say something.",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "The text to speak." },
            async: { type: "boolean", description: "Return immediately instead of waiting for playback to finish." },
          },
          required: ["text"],
          additionalProperties: false,
        },
        options: { namespace: "voice" },
        execute: async (input) => {
          const { text, async: asyncPlay } = (input ?? {}) as { text?: string; async?: boolean }
          if (!text || !text.trim()) return { content: "Nothing to speak: text was empty." }
          try {
            const info = await daemon()
            const res = (await api.speak(info, text, { async: asyncPlay })) as Record<string, unknown>
            const voice = (res.voice as string) ?? (res.backend as string) ?? "local voice"
            return { content: `Spoke ${String(text).length} characters with ${voice}.` }
          } catch (e) {
            return { content: errText(e) }
          }
        },
      })

      editor.add({
        name: "status",
        description:
          "Report the local voice pipeline: microphone, speech-to-text backend, text-to-speech backend, " +
          "the selected Piper voice, and any hints to fix a broken part.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "voice" },
        execute: async () => {
          try {
            const info = await daemon()
            const h: Health = await api.health(info, true)
            const lines = [
              `daemon: v${info.version} on ${info.platform} (${info.url})`,
              summarize(h),
              `vad: thr=${h.audio?.vad?.threshold} silence=${h.audio?.vad?.silence_ms}ms max=${h.audio?.vad?.max_ms}ms`,
            ]
            if (!h.audio?.capture?.backend) {
              lines.push(`mic problem: ${h.audio?.capture?.reason ?? "unknown"}`)
              for (const hint of h.audio?.capture?.hints ?? []) lines.push(`hint: ${hint}`)
            }
            return { content: lines.join("\n") }
          } catch (e) {
            return { content: errText(e) }
          }
        },
      })
    })

    // --------------------------------------------------------------- commands
    const commands = await ctx.command.transform((editor) => {
      editor.add({
        name: "voice",
        description: "Capture one spoken utterance and send it as your next message",
        execute: async ({ sessionID, prompt, delivery }) => {
          try {
            const info = await daemon()
            const res = await api.listen(info, { max_ms: 30000, start_timeout_ms: 15000 }, 90000)
            const text = (res.text ?? "").trim()
            if (!text) return
            await ctx.session.prompt({ sessionID, text, delivery })
          } catch (e) {
            await ctx.session.synthetic({ sessionID, text: `[voice] ${errText(e)}` })
          }
        },
      })
    })

    return async () => {
      await registration.dispose()
      await commands.dispose()
    }
  },
})
