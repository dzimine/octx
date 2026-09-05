/**
 * octx spike — throwaway probe. Answers three questions:
 *   1. do provider calls go through globalThis.fetch in this opencode build?
 *   2. does a header injected from the `chat.headers` hook survive to the wrapper?
 *   3. what body shape / streaming mode does the configured provider use?
 * Appends NDJSON to ~/octx-spike.ndjson. Delete once answered.
 *
 * SAFETY RULE learned the hard way: never reconstruct the request for forwarding.
 * `new Request(input, init)` drops non-standard init options (Bun's unix socket,
 * dispatcher, duplex) and can consume a stream body — doing that hung `opencode run`
 * at init, because opencode talks to its own embedded server over fetch. We inspect
 * only when the body is already a plain string (which is what the AI SDK sends), and
 * we always forward the ORIGINAL input/init untouched.
 */
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const OUT = path.join(homedir(), "octx-spike.ndjson")
const MARKER = "x-octx-probe"

let orig: typeof globalThis.fetch | undefined

function log(row: Record<string, unknown>): void {
  try {
    appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n")
  } catch {
    /* never break the session */
  }
}

/** Reads headers out of whatever shape they arrived in, without constructing a Request. */
function headerPairs(input: unknown, init: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const add = (h: unknown): void => {
    if (!h) return
    if (typeof (h as Headers).forEach === "function" && typeof (h as Headers).get === "function") {
      ;(h as Headers).forEach((v, k) => (out[k.toLowerCase()] = v))
    } else if (Array.isArray(h)) {
      for (const [k, v] of h as [string, string][]) out[String(k).toLowerCase()] = String(v)
    } else if (typeof h === "object") {
      for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v)
    }
  }
  if (input && typeof input === "object" && "headers" in (input as any)) add((input as any).headers)
  if (init && typeof init === "object") add((init as any).headers)
  return out
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  if (input && typeof input === "object" && "url" in (input as any)) return String((input as any).url)
  return "<unknown>"
}

async function probeFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> {
  try {
    const url = urlOf(input)
    const method = String((init as any)?.method ?? (input as any)?.method ?? "GET").toUpperCase()
    const headers = headerPairs(input, init)
    const body = (init as any)?.body

    // Only inspect plain-string bodies. Anything else (stream, FormData, Blob) is left alone.
    if (method === "POST" && typeof body === "string" && body.length > 0) {
      let parsed: any
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = undefined
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        log({
          kind: "request",
          method,
          url,
          headerNames: Object.keys(headers),
          marker: headers[MARKER],
          bodyKeys: Object.keys(parsed),
          shape: {
            bytes: body.length,
            stream: parsed.stream,
            model: parsed.model,
            system: Array.isArray(parsed.system) ? `array[${parsed.system.length}]` : typeof parsed.system,
            systemHeads: Array.isArray(parsed.system)
              ? parsed.system.map((s: any) => String(s?.text ?? s).slice(0, 70))
              : typeof parsed.system === "string"
                ? [parsed.system.slice(0, 70)]
                : undefined,
            tools: Array.isArray(parsed.tools) ? parsed.tools.length : typeof parsed.tools,
            toolNames: Array.isArray(parsed.tools)
              ? parsed.tools.slice(0, 60).map((t: any) => t?.name ?? t?.function?.name)
              : undefined,
            messages: Array.isArray(parsed.messages) ? parsed.messages.length : typeof parsed.messages,
            messageRoles: Array.isArray(parsed.messages)
              ? parsed.messages.map((m: any) => m?.role)
              : undefined,
            input: Array.isArray(parsed.input) ? parsed.input.length : typeof parsed.input,
            hasCacheControl: body.includes("cache_control"),
          },
        })
        try {
          appendFileSync(
            path.join(homedir(), "octx-spike-bodies.ndjson"),
            JSON.stringify({ ts: Date.now(), kind: "raw-request", url, marker: headers[MARKER], body: parsed }) + "\n",
          )
        } catch {}
      }
    }
  } catch (err) {
    log({ kind: "wrapper-error", error: String(err) })
  }

  // Forward the ORIGINAL, untouched.
  const res = await orig!(input, init)

  // Background-read a clone of the response so we can see the raw SSE stream.
  try {
    const u = urlOf(input)
    if (u.includes("/chat/completions") || u.includes("/messages") || u.includes("/responses")) {
      void res
        .clone()
        .text()
        .then((text) => {
          appendFileSync(
            path.join(homedir(), "octx-spike-bodies.ndjson"),
            JSON.stringify({ ts: Date.now(), kind: "raw-response", url: u, status: res.status, text }) + "\n",
          )
        })
        .catch(() => {})
    }
  } catch {}

  try {
    log({
      kind: "response",
      url: urlOf(input),
      status: res.status,
      contentType: res.headers.get("content-type"),
    })
  } catch {
    /* ignore */
  }

  return res
}

const main: (() => Promise<object>) & { id?: unknown; server?: unknown } = async () => {
  if (!orig) {
    orig = globalThis.fetch.bind(globalThis)
    globalThis.fetch = probeFetch as typeof globalThis.fetch
    log({ kind: "installed", pid: process.pid })
  }
  return {
    "chat.headers": async (input: any, output: any) => {
      output.headers[MARKER] = JSON.stringify({
        session: input?.sessionID,
        agent: input?.agent,
        messageID: input?.message?.id,
        model: input?.model?.id,
        provider: input?.provider?.info?.id,
        limit: input?.model?.limit,
      })
      log({ kind: "chat.headers", session: input?.sessionID, model: input?.model?.id, limit: input?.model?.limit })
    },
    "chat.params": async (input: any) => {
      log({ kind: "chat.params", session: input?.sessionID, agent: input?.agent, model: input?.model?.id })
    },
    "experimental.chat.system.transform": async (input: any, output: any) => {
      log({
        kind: "system.transform",
        session: input?.sessionID,
        model: input?.model?.id,
        count: output?.system?.length,
        sizes: output?.system?.map((s: string) => s.length),
        heads: output?.system?.map((s: string) => s.slice(0, 70)),
      })
    },
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      const msgs = output?.messages ?? []
      log({
        kind: "messages.transform",
        count: msgs.length,
        session: msgs[0]?.info?.sessionID,
        roles: msgs.map((m: any) => m?.info?.role),
      })
    },
  }
}

const entrypoint = main
entrypoint.id = "octx-spike"
entrypoint.server = main
export default entrypoint
