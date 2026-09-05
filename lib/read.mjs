/**
 * Reads an octx trace file into the model every renderer works from.
 *
 * Blobs are content-addressed and written once, so the reader resolves references lazily
 * through `blob(h)` rather than materializing the whole conversation per request.
 */
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { classifyTool } from "./categorize.mjs"

export function readTrace(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n")
  const blobs = new Map()
  const requests = []
  const byId = new Map()
  const tools = []
  const events = []
  const errors = []
  let header

  for (const line of lines) {
    if (!line) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      errors.push({ kind: "parse", line: line.slice(0, 200) })
      continue
    }
    switch (row.t) {
      case "hdr":
        header = row
        break
      case "blob":
        blobs.set(row.h, row)
        break
      case "req": {
        const req = { ...row, res: undefined }
        requests.push(req)
        byId.set(row.id, req)
        break
      }
      case "res": {
        const req = byId.get(row.req)
        if (req) req.res = row
        else errors.push({ kind: "orphan-res", req: row.req })
        break
      }
      case "tool":
        tools.push(row)
        break
      case "evt":
        events.push(row)
        break
      case "compacting":
        events.push(row)
        break
      case "err":
        errors.push(row)
        break
      default:
        errors.push({ kind: "unknown-record", t: row.t })
    }
  }

  const blob = (h) => blobs.get(h)
  const data = (h) => {
    const b = blobs.get(h)
    if (!b) return undefined
    return b.trunc ? undefined : b.data
  }
  const bytes = (h) => blobs.get(h)?.bytes ?? 0

  return {
    file,
    header,
    session: header?.session ?? path.basename(file, ".ndjson"),
    blobs,
    blob,
    data,
    bytes,
    requests,
    tools,
    events,
    errors,
    /** Requests that are part of the conversation, excluding opencode's title-generator call. */
    get conversation() {
      return requests.filter((r) => r.agent !== "title")
    },
  }
}

/**
 * Enriches a trace with what opencode's own store knows about the session — title, model,
 * cost, opencode version. Best-effort: a missing or locked DB just yields undefined, and the
 * query is read-only.
 */
export function enrichFromDb(sessionID) {
  const db = process.env.OPENCODE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
  if (!fs.existsSync(db)) return undefined
  const sql = `select json_object(
      'title', title, 'version', version, 'cost', cost, 'directory', directory,
      'agent', agent, 'model', model, 'slug', slug,
      'tokens_input', tokens_input, 'tokens_output', tokens_output,
      'tokens_cache_read', tokens_cache_read, 'tokens_cache_write', tokens_cache_write,
      'time_created', time_created
    ) from session where id = '${sessionID.replace(/'/g, "''")}';`
  try {
    const out = execFileSync("sqlite3", ["-readonly", db, sql], { encoding: "utf8", timeout: 5000 }).trim()
    return out ? JSON.parse(out) : undefined
  } catch {
    return undefined
  }
}

/** Splits a request's tools into the groups the context view reports separately. */
export function groupTools(trace, req) {
  const groups = { builtin: [], mcp: [] }
  for (const t of req.tools ?? []) {
    const { kind, server } = classifyTool(t.name)
    const entry = { name: t.name, h: t.h, bytes: trace.bytes(t.h), server }
    if (kind === "tool_builtin") groups.builtin.push(entry)
    else groups.mcp.push(entry)
  }
  return groups
}

/**
 * Classifies each message blob of a request into the categories the context meter reports,
 * attributing every tool result to the tool that produced it.
 *
 * Reasoning is split out from the assistant text it arrives with. Reasoning-model output is
 * echoed back into the prompt on later calls by some providers — on DeepSeek it was 77% of
 * the assistant payload with zero visible text — so folding it into "assistant messages"
 * hides the largest single thing in the window.
 *
 * Each returned part carries its OWN text, not the whole message: the estimator weighs
 * segments against each other, so giving three parts of one message the full message text
 * each would triple-count it.
 */
export function classifyMessages(trace, req) {
  const out = []
  const callTool = new Map() // tool_call id -> tool name

  for (const h of req.messages ?? []) {
    const m = trace.data(h)
    const size = trace.bytes(h)
    if (m === undefined) {
      out.push({ h, size, kind: "message", label: "message (truncated)" })
      continue
    }

    if (req.shape === "anthropic") {
      const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]
      for (const block of content) {
        const blockJson = JSON.stringify(block)
        if (block?.type === "tool_use") {
          callTool.set(block.id, block.name)
          out.push({ h, size: blockJson.length, kind: "tool_call", label: block.name, text: blockJson })
        } else if (block?.type === "tool_result") {
          const name = callTool.get(block.tool_use_id) ?? "?"
          out.push({ h, size: blockJson.length, kind: "tool_result", label: name, text: blockJson })
        } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
          out.push({
            h,
            size: blockJson.length,
            kind: "reasoning",
            label: "reasoning",
            text: block.thinking ?? blockJson,
          })
        } else {
          out.push({
            h,
            size: blockJson.length,
            kind: m.role === "user" ? "user" : "assistant",
            label: m.role,
            text: blockJson,
          })
        }
      }
      continue
    }

    // OpenAI chat-completions
    if (m.role === "tool") {
      const name = callTool.get(m.tool_call_id) ?? m.name ?? "?"
      out.push({ h, size, kind: "tool_result", label: name, text: typeof m.content === "string" ? m.content : undefined })
    } else if (m.role === "assistant") {
      const reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content : ""
      const text = typeof m.content === "string" ? m.content : ""
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
      for (const tc of calls) callTool.set(tc.id, tc.function?.name)

      if (reasoning) out.push({ h, size: reasoning.length, kind: "reasoning", label: "reasoning", text: reasoning })
      if (text) out.push({ h, size: text.length, kind: "assistant", label: "assistant", text })

      const rest = Math.max(size - reasoning.length - text.length, 0)
      if (calls.length) {
        // Parallel calls to the same tool would otherwise read as "bash,bash".
        const names = new Map()
        for (const tc of calls) {
          const n = tc.function?.name ?? "?"
          names.set(n, (names.get(n) ?? 0) + 1)
        }
        const label = [...names].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ")
        out.push({ h, size: rest, kind: "tool_call", label, text: JSON.stringify(calls) })
      } else if (!reasoning && !text) {
        out.push({ h, size, kind: "assistant", label: "assistant", text: JSON.stringify(m) })
      }
    } else {
      out.push({
        h,
        size,
        kind: m.role === "user" ? "user" : "assistant",
        label: m.role,
        text: typeof m.content === "string" ? m.content : JSON.stringify(m),
      })
    }
  }
  return out
}
