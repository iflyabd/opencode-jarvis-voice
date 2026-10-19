/**
 * Shared client for the local Jarvis Voice daemon.
 *
 * Both the server plugin and the TUI plugin use this. The daemon owns the mic,
 * Whisper and Piper, so the plugin only needs HTTP + a way to start it.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

export type DaemonInfo = {
  url: string
  token: string
  port: number
  pid: number
  platform: string
  version: string
}

export type Transcript = {
  ok?: boolean
  text?: string
  empty?: boolean
  backend?: string
  model?: string
  ms?: number
  language?: string
  stats?: Record<string, unknown>
}

export type SpeechStatus = {
  ok?: boolean
  /** True while a local player process is running. */
  active: boolean
  /** True while that player is suspended with SIGSTOP. */
  paused: boolean
  text?: string
  backend?: string | null
  started_at?: number | null
  elapsed_ms?: number
  player?: string | null
}

export type Health = {
  ok: boolean
  daemon: Record<string, unknown>
  audio: {
    capture: { backend: string | null; reason?: string; hints?: string[] } | null
    pulse: { reachable: boolean; detail: string; server: string }
    playback_available: boolean
    sample_rate: number
    vad: Record<string, number>
  }
  stt: { picked: string | null; backends: Array<Record<string, unknown>> }
  tts: { picked: string | null; voice: Record<string, unknown> | null }
  ptt: { id: string; state: string } | null
  speech?: SpeechStatus | null
  last_text: string
  uptime_s: number
}

/* ------------------------------------------------------------------ paths */

export function cacheDir(): string {
  const fromEnv = process.env.JARVIS_VOICE_CACHE
  if (fromEnv) return fromEnv
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg) return join(xdg, "jarvis-voice")
  return join(homedir(), ".cache", "jarvis-voice")
}

export function runtimeFile(): string {
  return join(cacheDir(), "daemon.json")
}

/** Project root (the folder that holds daemon/ and bin/). */
export function projectRoot(): string {
  const fromEnv = process.env.JARVIS_VOICE_HOME
  if (fromEnv && existsSync(join(fromEnv, "bin", "voice"))) return fromEnv
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const root = resolve(here, "..")
    if (existsSync(join(root, "bin", "voice"))) return root
    return root
  } catch {
    return process.cwd()
  }
}

export function launcher(): string {
  return join(projectRoot(), "bin", "voice")
}

/* --------------------------------------------------------------- discovery */

export function readRuntime(): DaemonInfo | null {
  try {
    const file = runtimeFile()
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DaemonInfo>
    if (!raw || !raw.port) return null
    return {
      url: raw.url ?? `http://127.0.0.1:${raw.port}`,
      token: raw.token ?? "",
      port: Number(raw.port),
      pid: Number(raw.pid ?? 0),
      platform: String(raw.platform ?? "unknown"),
      version: String(raw.version ?? "0"),
    }
  } catch {
    return null
  }
}

async function getJson(url: string, token: string, path: string, timeoutMs = 2500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${url}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function ping(info: DaemonInfo, timeoutMs = 2500): Promise<boolean> {
  try {
    const data = (await getJson(info.url, info.token, "/ping", timeoutMs)) as { ok?: boolean }
    return data?.ok === true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ spawn */

let spawnPromise: Promise<DaemonInfo | null> | null = null

export async function ensureDaemon(opts: { start?: boolean; waitMs?: number } = {}): Promise<DaemonInfo | null> {
  const { start = true, waitMs = 30000 } = opts

  const existing = readRuntime()
  if (existing && (await ping(existing))) return existing

  if (!start) return null
  if (spawnPromise) return spawnPromise

  spawnPromise = (async () => {
    const bin = launcher()
    if (!existsSync(bin)) return null
    try {
      const child = spawn(bin, ["up"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      })
      child.unref()
    } catch {
      return null
    }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      const info = readRuntime()
      if (info && (await ping(info, 1500))) return info
    }
    return null
  })()

  try {
    return await spawnPromise
  } finally {
    spawnPromise = null
  }
}

/* -------------------------------------------------------------------- api */

export class DaemonError extends Error {
  status: number
  hints: string[]
  constructor(message: string, status = 0, hints: string[] = []) {
    super(message)
    this.name = "DaemonError"
    this.status = status
    this.hints = hints
  }
}

export async function request<T = unknown>(
  info: DaemonInfo,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; raw?: boolean } = {},
): Promise<T> {
  const { method = "POST", body, timeoutMs = 190000, raw = false } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${info.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${info.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    if (raw) return (await res.arrayBuffer()) as unknown as T
    const text = await res.text()
    let data: unknown = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text }
    }
    if (!res.ok) {
      const d = data as { error?: string; hints?: string[] }
      throw new DaemonError(d?.error ?? `HTTP ${res.status}`, res.status, d?.hints ?? [])
    }
    return data as T
  } catch (e) {
    if (e instanceof DaemonError) throw e
    const msg = e instanceof Error ? e.message : String(e)
    throw new DaemonError(msg.includes("abort") ? "voice daemon timed out" : msg)
  } finally {
    clearTimeout(timer)
  }
}

export const api = {
  health: (info: DaemonInfo, deep = false) => getJsonWithAuth<Health>(info, `/health${deep ? "?deep=1" : ""}`),
  pttStart: (info: DaemonInfo, maxMs?: number) => request(info, "/ptt/start", { body: { max_ms: maxMs } }),
  pttStop: (info: DaemonInfo, timeoutMs = 190000) => request<Transcript>(info, "/ptt/stop", { body: {}, timeoutMs }),
  pttState: (info: DaemonInfo) => getJsonWithAuth<{ ptt: { id: string; state: string } | null }>(info, "/ptt/state"),
  pttCancel: (info: DaemonInfo) => request(info, "/ptt/cancel", { body: {} }),
  listen: (info: DaemonInfo, body: Record<string, unknown> = {}, timeoutMs = 190000) =>
    request<Transcript>(info, "/listen", { body, timeoutMs }),
  speak: (info: DaemonInfo, text: string, opts: { async?: boolean; backend?: string; timeoutMs?: number } = {}) =>
    request(info, "/speak", { body: { text, ...opts }, timeoutMs: opts.timeoutMs ?? 190000 }),
  synth: (info: DaemonInfo, text: string) => request<ArrayBuffer>(info, "/synth", { body: { text }, raw: true }),
  speech: (info: DaemonInfo) => getJsonWithAuth<SpeechStatus>(info, "/speech", 4000),
  pause: (info: DaemonInfo) => request<{ ok?: boolean; paused?: boolean; speech?: SpeechStatus }>(info, "/pause", { body: {}, timeoutMs: 8000 }),
  resume: (info: DaemonInfo) => request<{ ok?: boolean; resumed?: boolean; speech?: SpeechStatus }>(info, "/resume", { body: {}, timeoutMs: 8000 }),
  interrupt: (info: DaemonInfo) => request(info, "/interrupt", { body: {} }),
  probe: (info: DaemonInfo) => request(info, "/probe", { body: {}, timeoutMs: 120000 }),
  devices: (info: DaemonInfo) => getJsonWithAuth<Record<string, unknown>>(info, "/devices"),
  voices: (info: DaemonInfo) => getJsonWithAuth<Record<string, unknown>>(info, "/voices"),
}

async function getJsonWithAuth<T>(info: DaemonInfo, path: string, timeoutMs = 10000): Promise<T> {
  return (await getJson(info.url, info.token, path, timeoutMs)) as T
}

/* ------------------------------------------------------------------ notes */

/** A short human summary of what is (not) working, for toasts and tool output. */
export function summarize(h: Health): string {
  const parts: string[] = []
  const cap = h.audio?.capture?.backend
  parts.push(cap ? `mic: ${cap}` : "mic: unavailable")
  parts.push(`stt: ${h.stt?.picked ?? "none"}`)
  parts.push(`tts: ${h.tts?.picked ?? "none"}`)
  if (h.tts?.voice?.name) parts.push(`voice: ${h.tts.voice.name}`)
  return parts.join(" | ")
}
