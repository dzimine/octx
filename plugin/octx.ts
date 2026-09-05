/**
 * octx — opencode conversation capture.
 *
 * Records what opencode actually sends to the model: system blocks, tool schemas, every
 * message, and the provider's own token accounting. Writes newline-delimited JSON, one file
 * per session, with content-addressed blob dedup so a long session stays O(n) rather than
 * re-recording the whole conversation on every turn.
 *
 * Install:  ln -s <repo>/plugin/octx.ts ~/.config/opencode/plugin/octx.ts
 * Enable:   set "level" in ~/.config/opencode/octx.json (see octx.example.json)
 *
 * This file is deliberately self-contained — no relative imports. It is loaded through a
 * symlink and relative resolution through one is not worth betting on. The reader side lives
 * in lib/*.mjs; README.md is the format contract between the two.
 *
 * Two hard-won rules, both from the Step 0 spike (see the plan file):
 *
 *   1. NEVER reconstruct the outbound request. `new Request(input, init)` drops non-standard
 *      init options and can consume a stream body — doing so hung `opencode run` at init,
 *      because opencode talks to its own embedded server over fetch. We inspect only bodies
 *      that are already plain strings (what the AI SDK sends) and forward the original
 *      `input, init` untouched.
 *   2. The correlation header carries only an opaque random id. Putting session ids in it
 *      would ship them to the provider, and deleting it afterwards would break SigV4-signed
 *      providers, since `chat.headers` runs before the provider signs. The id maps to the
 *      real context in process memory.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"

const OCTX_VERSION = "0.1.0"
const FORMAT_VERSION = 1
const HEADER = "x-octx-id"

type Level = "off" | "basic" | "full" | "debug"

type Config = {
  level: Level
  dir: string
  maxBlobBytes: number
  redactHeaders: boolean
  retainDays: number
}

const DEFAULTS: Config = {
  level: "off",
  dir: path.join(os.homedir(), ".local", "share", "octx"),
  maxBlobBytes: 262144,
  redactHeaders: true,
  retainDays: 30,
}

const LEVELS: Record<Level, number> = { off: 0, basic: 1, full: 2, debug: 3 }

/**
 * `OCTX=full opencode …` overrides the configured level for one invocation.
 *
 * Accepts a level name, or the usual truthy/falsy spellings for convenience. An unrecognised
 * value is ignored rather than guessed at, so a typo silently falling back to the config file
 * is preferable to a typo silently enabling `debug`.
 */
function envLevel(): Level | undefined {
  const raw = process.env.OCTX?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw in LEVELS) return raw as Level
  if (raw === "1" || raw === "on" || raw === "true" || raw === "yes") return "full"
  if (raw === "0" || raw === "false" || raw === "no") return "off"
  return undefined
}

/** Context captured in `chat.headers`, keyed by the opaque id we put on the wire. */
type ReqContext = {
  session: string
  agent?: string
  messageID?: string
  model?: string
  provider?: string
  limit?: { context: number; output: number }
}

// ---------------------------------------------------------------------------
// Module-level state. Survives repeated `server()` calls within one process:
// opencode re-initializes plugin hooks across instance reload/dispose, but the
// module import is cached, so the fetch patch must be installed exactly once.
// ---------------------------------------------------------------------------

let orig: typeof globalThis.fetch | undefined
const contexts = new Map<string, ReqContext>()
const seenBlobs = new Map<string, Set<string>>() // sessionID -> hashes already written
const reqCounters = new Map<string, number>() // sessionID -> next request id
const sessionFiles = new Map<string, string>() // sessionID -> resolved file path
/** Pending tool calls, callID -> {tool, args, started}. Filled by tool.execute.before. */
const pendingTools = new Map<string, { tool: string; args: unknown; started: number }>()

/** Cap the correlation map so a long-lived server process cannot grow without bound. */
function rememberContext(id: string, ctx: ReqContext): void {
  contexts.set(id, ctx)
  if (contexts.size > 512) {
    const oldest = contexts.keys().next().value
    if (oldest !== undefined) contexts.delete(oldest)
  }
}

// ---------------------------------------------------------------------------
// Config: re-read when its mtime changes, so flipping `level` takes effect on
// the next LLM call without restarting opencode.
// ---------------------------------------------------------------------------

let configCache: { at: number; sig: string; value: Config } | undefined
let configPaths: string[] = []

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

function readConfigFile(file: string): Partial<Config> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<Config>
  } catch {
    return undefined
  }
}

function configSignature(): string {
  return configPaths
    .map((f) => {
      try {
        const s = statSync(f)
        return `${f}:${s.mtimeMs}:${s.size}`
      } catch {
        return `${f}:-`
      }
    })
    .join("|")
}

function config(): Config {
  const now = Date.now()
  // Stat at most once a second; the fetch path must stay cheap when tracing is off.
  if (configCache && now - configCache.at < 1000) return configCache.value
  const sig = configSignature()
  if (configCache && configCache.sig === sig) {
    configCache.at = now
    return configCache.value
  }
  let merged: Config = { ...DEFAULTS }
  // Later paths win: global first, then project.
  for (const file of configPaths) {
    const found = readConfigFile(file)
    if (found) merged = { ...merged, ...found }
  }
  if (!(merged.level in LEVELS)) merged.level = "off"
  // The env var beats both files, since it is the per-invocation override. Note this also
  // disables the live file toggle for `level`: an env var cannot change mid-process, so with
  // OCTX set the level is fixed for the lifetime of this opencode run.
  const fromEnv = envLevel()
  if (fromEnv) merged.level = fromEnv
  if (process.env.OCTX_DIR) merged.dir = process.env.OCTX_DIR
  merged.dir = expandHome(String(merged.dir || DEFAULTS.dir))
  configCache = { at: now, sig, value: merged }
  return merged
}

function atLeast(level: Level, want: Level): boolean {
  return LEVELS[level] >= LEVELS[want]
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function hashOf(value: unknown): string {
  const json = typeof value === "string" ? value : JSON.stringify(value) ?? "null"
  return createHash("sha256").update(json).digest("hex").slice(0, 16)
}

function fileFor(cfg: Config, session: string): string {
  const cached = sessionFiles.get(session)
  if (cached) return cached
  const day = new Date().toISOString().slice(0, 10)
  const dir = path.join(cfg.dir, day)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${session}.ndjson`)
  sessionFiles.set(session, file)
  return file
}

function write(cfg: Config, session: string, row: Record<string, unknown>): void {
  try {
    appendFileSync(fileFor(cfg, session), JSON.stringify(row) + "\n")
  } catch {
    /* tracing must never break a session */
  }
}

/**
 * Writes a blob once per session and returns its hash. Oversized blobs are recorded as a
 * truncated stub below `full` level, so `basic` stays small without losing the reference.
 */
function blob(cfg: Config, session: string, kind: string, data: unknown): string {
  const json = JSON.stringify(data) ?? "null"
  const h = hashOf(json)
  let seen = seenBlobs.get(session)
  if (!seen) {
    seen = new Set()
    seenBlobs.set(session, seen)
  }
  if (seen.has(h)) return h
  seen.add(h)
  const bytes = json.length
  if (!atLeast(cfg.level, "full") && bytes > cfg.maxBlobBytes) {
    write(cfg, session, {
      t: "blob",
      h,
      kind,
      bytes,
      trunc: true,
      preview: json.slice(0, 2000),
    })
  } else {
    write(cfg, session, { t: "blob", h, kind, bytes, data })
  }
  return h
}

let headerWritten = new Set<string>()

function ensureHeader(cfg: Config, session: string, meta: Record<string, unknown>): void {
  if (headerWritten.has(session)) return
  headerWritten.add(session)
  write(cfg, session, {
    t: "hdr",
    v: FORMAT_VERSION,
    octx: OCTX_VERSION,
    ts: new Date().toISOString(),
    session,
    ...meta,
  })
}

// ---------------------------------------------------------------------------
// Provider adapters — normalize the three request shapes opencode can emit.
// ---------------------------------------------------------------------------

type Normalized = {
  shape: "openai-chat" | "anthropic" | "openai-responses" | "unknown"
  params: Record<string, unknown>
  system: unknown[]
  tools: unknown[]
  messages: unknown[]
}

const PARAM_KEYS = [
  "model",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "reasoning_effort",
  "reasoning",
  "thinking",
  "stream",
  "tool_choice",
  "stop",
  "stop_sequences",
  "parallel_tool_calls",
  "service_tier",
]

function pickParams(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PARAM_KEYS) if (body[k] !== undefined) out[k] = body[k]
  return out
}

function normalize(url: string, body: Record<string, unknown>): Normalized {
  const params = pickParams(body)

  // Anthropic messages API: system is its own field, tools carry input_schema.
  if (Array.isArray(body.messages) && (body.system !== undefined || url.includes("/messages"))) {
    const system = Array.isArray(body.system)
      ? (body.system as unknown[])
      : body.system !== undefined
        ? [body.system]
        : []
    return {
      shape: "anthropic",
      params,
      system,
      tools: Array.isArray(body.tools) ? (body.tools as unknown[]) : [],
      messages: body.messages as unknown[],
    }
  }

  // OpenAI responses API: instructions + input.
  if (Array.isArray(body.input) || url.includes("/responses")) {
    return {
      shape: "openai-responses",
      params,
      system: body.instructions !== undefined ? [body.instructions] : [],
      tools: Array.isArray(body.tools) ? (body.tools as unknown[]) : [],
      messages: Array.isArray(body.input) ? (body.input as unknown[]) : [],
    }
  }

  // OpenAI chat completions: system arrives as leading messages with role "system".
  if (Array.isArray(body.messages)) {
    const all = body.messages as Array<Record<string, unknown>>
    return {
      shape: "openai-chat",
      params,
      system: all.filter((m) => m?.role === "system" || m?.role === "developer").map((m) => m.content),
      tools: Array.isArray(body.tools) ? (body.tools as unknown[]) : [],
      messages: all.filter((m) => m?.role !== "system" && m?.role !== "developer"),
    }
  }

  return { shape: "unknown", params, system: [], tools: [], messages: [] }
}

/** Pulls {name, description, schema} out of whichever tool-definition shape this is. */
function toolInfo(tool: unknown): { name: string; description?: string; schema?: unknown } {
  const t = tool as Record<string, any>
  if (t?.function) {
    return { name: t.function.name, description: t.function.description, schema: t.function.parameters }
  }
  return { name: t?.name ?? "<unknown>", description: t?.description, schema: t?.input_schema ?? t?.parameters }
}

type Usage = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
}

/**
 * Parses usage, assistant text, reasoning and tool calls out of an SSE stream or a plain
 * JSON response body. The assembled text matters at `basic` level, where the raw stream is
 * not stored: without it the final turn's output would be unrecoverable, since every other
 * turn's output reappears in the next request's messages.
 */
function parseUsage(text: string): {
  usage: Usage
  stop?: string
  text?: string
  reasoning?: string
  calls?: Array<{ name?: string; args?: string }>
} {
  const usage: Usage = {}
  let stop: string | undefined
  let content = ""
  let reasoning = ""
  const calls: Array<{ name?: string; args?: string }> = []

  const apply = (u: Record<string, any> | undefined): void => {
    if (!u) return
    // OpenAI-compatible
    if (typeof u.prompt_tokens === "number") usage.input = u.prompt_tokens
    if (typeof u.completion_tokens === "number") usage.output = u.completion_tokens
    if (typeof u.prompt_tokens_details?.cached_tokens === "number")
      usage.cache_read = u.prompt_tokens_details.cached_tokens
    if (typeof u.completion_tokens_details?.reasoning_tokens === "number")
      usage.reasoning = u.completion_tokens_details.reasoning_tokens
    // Anthropic
    if (typeof u.input_tokens === "number") usage.input = (usage.input ?? 0) + u.input_tokens
    if (typeof u.output_tokens === "number") usage.output = u.output_tokens
    if (typeof u.cache_read_input_tokens === "number") usage.cache_read = u.cache_read_input_tokens
    if (typeof u.cache_creation_input_tokens === "number") usage.cache_write = u.cache_creation_input_tokens
  }

  const consider = (obj: any): void => {
    if (!obj || typeof obj !== "object") return
    apply(obj.usage)
    apply(obj.message?.usage)
    apply(obj.response?.usage)
    const fr = obj.choices?.[0]?.finish_reason ?? obj.delta?.stop_reason ?? obj.stop_reason
    if (typeof fr === "string") stop = fr

    // OpenAI chat-completions deltas
    const delta = obj.choices?.[0]?.delta
    if (delta) {
      if (typeof delta.content === "string") content += delta.content
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content
      for (const tc of delta.tool_calls ?? []) {
        const i = typeof tc.index === "number" ? tc.index : calls.length
        if (!calls[i]) calls[i] = { name: undefined, args: "" }
        if (tc.function?.name) calls[i].name = tc.function.name
        if (typeof tc.function?.arguments === "string") calls[i].args = (calls[i].args ?? "") + tc.function.arguments
      }
    }
    // Non-streaming OpenAI
    const msg = obj.choices?.[0]?.message
    if (msg) {
      if (typeof msg.content === "string") content += msg.content
      for (const tc of msg.tool_calls ?? []) calls.push({ name: tc.function?.name, args: tc.function?.arguments })
    }
    // Anthropic content-block deltas
    if (obj.type === "content_block_delta") {
      if (typeof obj.delta?.text === "string") content += obj.delta.text
      if (typeof obj.delta?.thinking === "string") reasoning += obj.delta.thinking
      if (typeof obj.delta?.partial_json === "string") {
        const last = calls[calls.length - 1]
        if (last) last.args = (last.args ?? "") + obj.delta.partial_json
      }
    }
    if (obj.type === "content_block_start" && obj.content_block?.type === "tool_use") {
      calls.push({ name: obj.content_block.name, args: "" })
    }
  }

  const trimmed = text.trimStart()
  if (trimmed.startsWith("{")) {
    try {
      consider(JSON.parse(text))
      return result()
    } catch {
      /* fall through to SSE parsing */
    }
  }

  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      consider(JSON.parse(payload))
    } catch {
      /* partial chunk */
    }
  }
  return result()

  function result() {
    return {
      usage,
      stop,
      text: content || undefined,
      reasoning: reasoning || undefined,
      calls: calls.length ? calls.filter(Boolean) : undefined,
    }
  }
}

// ---------------------------------------------------------------------------
// fetch interception
// ---------------------------------------------------------------------------

const PROVIDER_PATHS = ["/chat/completions", "/messages", "/responses", "/generateContent"]

function urlOf(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  if (input && typeof input === "object" && "url" in (input as any)) return String((input as any).url)
  return ""
}

/** Reads headers out of whatever shape they arrived in, without constructing a Request. */
function headerValue(input: unknown, init: unknown, name: string): string | undefined {
  const probe = (h: any): string | undefined => {
    if (!h) return undefined
    if (typeof h.get === "function") return h.get(name) ?? undefined
    if (Array.isArray(h)) {
      for (const [k, v] of h) if (String(k).toLowerCase() === name) return String(v)
      return undefined
    }
    if (typeof h === "object") {
      for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return String(v)
    }
    return undefined
  }
  return probe((init as any)?.headers) ?? probe((input as any)?.headers)
}

async function tracedFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> {
  let cfg: Config
  try {
    cfg = config()
  } catch {
    return orig!(input, init)
  }
  if (cfg.level === "off") return orig!(input, init)

  let session: string | undefined
  let reqID: number | undefined

  try {
    const url = urlOf(input)
    if (!PROVIDER_PATHS.some((p) => url.includes(p))) return orig!(input, init)

    const body = (init as any)?.body
    if (typeof body !== "string" || body.length === 0) return orig!(input, init)

    const id = headerValue(input, init, HEADER)
    const ctx = id ? contexts.get(id) : undefined
    session = ctx?.session ?? headerValue(input, init, "x-opencode-session") ?? "unknown"

    let parsed: Record<string, unknown> | undefined
    try {
      const candidate = JSON.parse(body)
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate
    } catch {
      parsed = undefined
    }
    if (!parsed) return orig!(input, init)

    ensureHeader(cfg, session, {
      directory: pluginDirectory,
      worktree: pluginWorktree,
      project: pluginProject,
    })

    const norm = normalize(url, parsed)
    reqID = (reqCounters.get(session) ?? 0) + 1
    reqCounters.set(session, reqID)

    const row: Record<string, unknown> = {
      t: "req",
      id: reqID,
      ts: new Date().toISOString(),
      url,
      shape: norm.shape,
      agent: ctx?.agent,
      messageID: ctx?.messageID,
      model: ctx?.model ?? parsed.model,
      provider: ctx?.provider,
      limit: ctx?.limit,
      params: norm.params,
      system: norm.system.map((s) => blob(cfg, session!, "system", s)),
      tools: norm.tools.map((t) => {
        const info = toolInfo(t)
        return { name: info.name, h: blob(cfg, session!, "tool", t) }
      }),
      messages: norm.messages.map((m) => blob(cfg, session!, "message", m)),
    }
    if (atLeast(cfg.level, "full")) row.raw = blob(cfg, session, "raw", parsed)
    write(cfg, session, row)
  } catch (err) {
    if (session) write(cfg, session, { t: "err", ts: new Date().toISOString(), where: "request", error: String(err) })
  }

  // Forward the ORIGINAL, untouched. See rule 1 at the top of this file.
  const res = await orig!(input, init)

  if (session && reqID !== undefined) {
    const capturedSession = session
    const capturedReq = reqID
    try {
      void res
        .clone()
        .text()
        .then((text) => {
          const parsedRes = parseUsage(text)
          const row: Record<string, unknown> = {
            t: "res",
            req: capturedReq,
            ts: new Date().toISOString(),
            status: res.status,
            usage: parsedRes.usage,
            stop: parsedRes.stop,
            calls: parsedRes.calls,
          }
          if (parsedRes.text) row.text = blob(cfg, capturedSession, "text", parsedRes.text)
          if (parsedRes.reasoning) row.reasoning = blob(cfg, capturedSession, "reasoning", parsedRes.reasoning)
          if (atLeast(cfg.level, "full")) row.body = blob(cfg, capturedSession, "response", text)
          write(cfg, capturedSession, row)
        })
        .catch(() => {
          // opencode sometimes abandons a stream (observed for the title agent); the clone
          // then never resolves cleanly. A `req` with no `res` is expected and tolerated.
        })
    } catch {
      /* ignore */
    }
  }

  return res
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

let pluginDirectory = ""
let pluginWorktree = ""
let pluginProject = ""

const main: ((input?: any) => Promise<object>) & { id?: unknown; server?: unknown } = async (
  input?: any,
) => {
  pluginDirectory = input?.directory ?? ""
  pluginWorktree = input?.worktree ?? ""
  pluginProject = input?.project?.id ?? ""

  configPaths = [
    path.join(os.homedir(), ".config", "opencode", "octx.json"),
    ...(pluginDirectory ? [path.join(pluginDirectory, ".opencode", "octx.json")] : []),
  ]
  configCache = undefined

  if (!orig) {
    orig = globalThis.fetch.bind(globalThis)
    globalThis.fetch = tracedFetch as typeof globalThis.fetch
  }

  return {
    /** Injects the opaque correlation id and remembers the real context in memory. */
    "chat.headers": async (hookInput: any, output: any) => {
      try {
        if (config().level === "off") return
        if (!output?.headers) return
        const id = randomBytes(8).toString("hex")
        output.headers[HEADER] = id
        rememberContext(id, {
          session: hookInput?.sessionID,
          agent: hookInput?.agent,
          messageID: hookInput?.message?.id,
          model: hookInput?.model?.id,
          provider: hookInput?.provider?.info?.id,
          limit: hookInput?.model?.limit,
        })
      } catch {
        /* never break a turn */
      }
    },

    "tool.execute.before": async (hookInput: any, output: any) => {
      try {
        if (config().level === "off") return
        pendingTools.set(hookInput.callID, {
          tool: hookInput.tool,
          args: output?.args,
          started: Date.now(),
        })
      } catch {
        /* ignore */
      }
    },

    "tool.execute.after": async (hookInput: any, output: any) => {
      try {
        const cfg = config()
        if (cfg.level === "off") return
        const session = hookInput.sessionID
        const pending = pendingTools.get(hookInput.callID)
        pendingTools.delete(hookInput.callID)
        write(cfg, session, {
          t: "tool",
          ts: new Date().toISOString(),
          callID: hookInput.callID,
          tool: hookInput.tool,
          ms: pending ? Date.now() - pending.started : undefined,
          title: output?.title,
          args: blob(cfg, session, "toolargs", hookInput.args ?? pending?.args),
          output: blob(cfg, session, "toolout", output?.output),
          outputBytes: typeof output?.output === "string" ? output.output.length : undefined,
          metadata: output?.metadata,
        })
      } catch {
        /* ignore */
      }
    },

    "experimental.session.compacting": async (hookInput: any) => {
      try {
        const cfg = config()
        if (cfg.level === "off") return
        write(cfg, hookInput.sessionID, { t: "compacting", ts: new Date().toISOString() })
      } catch {
        /* ignore */
      }
    },

    event: async ({ event }: any) => {
      try {
        const cfg = config()
        if (!atLeast(cfg.level, "debug")) return
        const session =
          event?.properties?.sessionID ??
          event?.properties?.info?.sessionID ??
          event?.properties?.part?.sessionID
        if (!session) return
        write(cfg, session, { t: "evt", ts: new Date().toISOString(), type: event.type, data: event.properties })
      } catch {
        /* ignore */
      }
    },
  }
}

const entrypoint = main
entrypoint.id = "octx"
entrypoint.server = main
export default entrypoint
