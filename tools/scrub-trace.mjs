#!/usr/bin/env node
/**
 * Produce a shareable copy of a trace with every piece of private content replaced.
 *
 * A trace is a verbatim record of what you sent a model: your prompts, the contents of every
 * file a tool read, your shell output, and your system prompt — which on opencode inlines
 * your AGENTS.md/CLAUDE.md. Sharing one unedited publishes all of it.
 *
 * This scrubs the STRUCTURED ndjson rather than the rendered HTML. Post-processing the report
 * would mean pattern-matching prose for secrets and hoping; here every string is reached
 * through the schema, so nothing hides in an unexpected field.
 *
 * What is preserved: the shape. Call count, tool names, message roles, category proportions,
 * measured token counts. Replacement text matches the original's length so the estimated
 * breakdown stays realistic. What is destroyed: all content.
 *
 * Usage: node tools/scrub-trace.mjs <in.ndjson> <out.ndjson> [--title "..."]
 */
import fs from "node:fs"

const [, , inFile, outFile, ...rest] = process.argv
if (!inFile || !outFile) {
  console.error("usage: scrub-trace.mjs <in.ndjson> <out.ndjson> [--title \"...\"]")
  process.exit(1)
}
const titleArg = rest.indexOf("--title")
const TITLE = titleArg >= 0 ? rest[titleArg + 1] : "Example session"

const FAKE_HOME = "/home/dev"
const FAKE_DIR = "/home/dev/demo-project"
const FAKE_SESSION = "ses_demo00000000000000000000000"

/** Deterministic filler, so re-running does not churn the committed output. */
const WORDS = ("the model reads a file and then writes a summary of what it found while the tool " +
  "returns output that gets appended to the conversation so the next call carries it forward " +
  "which is exactly how a context window fills up over a long running session with many steps")
  .split(" ")
function filler(n, seed = 0) {
  if (n <= 0) return ""
  let out = ""
  let i = seed % WORDS.length
  while (out.length < n) {
    out += (out ? " " : "") + WORDS[i % WORDS.length]
    i++
    if (i % 17 === 0) out += "."
    if (i % 43 === 0) out += "\n"
  }
  return out.slice(0, n)
}

/**
 * Applied to EVERY string, whatever field it sits in. Identifiers are rewritten rather than
 * kept, because a session id links a "scrubbed" report straight back to the original.
 */
let REAL_DIR = null // learned from the header, then erased everywhere it appears
function depersonalise(s) {
  if (typeof s !== "string") return s
  let out = s
  if (REAL_DIR) out = out.split(REAL_DIR).join(FAKE_DIR)
  return out
    .replace(/\/Users\/[^\s"',;:)\]]*/g, FAKE_DIR)
    .replace(/\/home\/[^\s"',;:)\]]*/g, FAKE_DIR)
    .replace(new RegExp(process.env.USER ?? "\\u0000", "g"), "dev")
    .replace(/\bses_[A-Za-z0-9]+/g, FAKE_SESSION)
    // Ids may contain underscores (call_00_tY0t…), so the class has to allow them.
    .replace(/\b(?:msg|prt|call|toolu|req)_[A-Za-z0-9_]{4,}/g, (m) => m.split("_")[0] + "_demo")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "dev@example.com")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "0.0.0.0")
    // opencode injects the host OS and shell into its bash tool description. Matched only in
    // that phrasing so the `bash` TOOL NAME is never touched.
    .replace(/OS: \w+, Shell: [\w/.-]+/g, "OS: linux, Shell: sh")
}

/**
 * Keys whose values are structure, not content. Everything NOT listed here is replaced.
 *
 * This is deliberately a denylist-by-default: the first version allowlisted the content keys
 * it knew about (`content`, `text`, `arguments`) and leaked through `url`, `command`,
 * `description`, `prompt`, `title` and `args` — every field it had not thought of. For a
 * redaction tool the safe default is to destroy what it does not recognise.
 */
const STRUCTURAL = new Set([
  "t", "h", "kind", "type", "role", "name", "tool", "id", "callID", "messageID", "tool_call_id",
  "index", "finish_reason", "stop", "agent", "shape", "provider", "model", "req", "status",
  "measured", "reset", "inFlight", "trunc", "ts", "url", "v", "octx", "session", "directory",
  "worktree", "project", "title", "bytes", "outputBytes", "ms", "limit", "params", "usage",
])

/** Rebuilt system prompt: keeps the anchors splitSystem() relies on, drops the content. */
function fakeSystem(original) {
  const s = String(original)
  const size = (re) => (s.match(re)?.[0].length ?? 0)
  const envLen = size(/(?:Here is some useful information[^\n]*\n)?<env>[\s\S]*?<\/env>/)
  const skillsLen = size(/<available_skills>[\s\S]*?<\/available_skills>/)
  const memMatch = s.match(/<\/env>\s*([\s\S]*?)\s*<available_skills>/)
  const memLen = memMatch ? memMatch[1].length : 0
  const baseLen = Math.max(0, s.length - envLen - skillsLen - memLen)

  const base = "You are a coding agent. " + filler(Math.max(0, baseLen - 24), 1)
  const env =
    "Here is some useful information about the environment you are running in:\n<env>\n" +
    filler(Math.max(0, envLen - 90), 2) +
    "\n</env>\n"
  const memory = memLen ? "Instructions from: " + FAKE_HOME + "/AGENTS.md\n" + filler(Math.max(0, memLen - 40), 3) + "\n" : ""
  const skills = skillsLen
    ? "<available_skills>\n  <skill>\n    <name>example-skill</name>\n    <description>" +
      filler(Math.max(0, skillsLen - 120), 4) +
      "</description>\n  </skill>\n</available_skills>"
    : ""
  return base + env + memory + skills
}

/** Replaces content-bearing strings, leaving the schema intact. */
function scrubValue(value, key, seed) {
  if (typeof value === "string") {
    // `url` and `title` are structural in the record schema but free text in practice (a
    // fetched URL, a shell command), so they are neutralised rather than preserved.
    if (key === "url") return /^https?:/i.test(value) ? "https://example.com/page" : depersonalise(value)
    if (key === "title") return filler(Math.min(value.length, 40), seed)
    if (STRUCTURAL.has(key)) return depersonalise(value)
    return filler(value.length, seed)
  }
  if (Array.isArray(value)) return value.map((v, i) => scrubValue(v, key, seed + i))
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, k, seed + k.length)
    return out
  }
  return value
}

function deepDepersonalise(v) {
  if (typeof v === "string") return depersonalise(v)
  if (Array.isArray(v)) return v.map(deepDepersonalise)
  if (v && typeof v === "object") {
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = deepDepersonalise(x)
    return o
  }
  return v
}

const lines = fs.readFileSync(inFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
REAL_DIR = lines.find((l) => l.t === "hdr")?.directory ?? null
const dropped = new Set(
  // The literal provider bodies duplicate everything else and are only present at `full`.
  lines.filter((l) => l.t === "blob" && (l.kind === "raw" || l.kind === "response")).map((l) => l.h),
)

const out = []
let seed = 0
for (const row of lines) {
  seed += 7
  if (row.t === "blob" && dropped.has(row.h)) continue

  switch (row.t) {
    case "hdr":
      out.push({ ...row, session: FAKE_SESSION, directory: FAKE_DIR, worktree: FAKE_DIR, project: "demo", title: TITLE })
      break

    case "blob": {
      // A blob can legitimately carry no data: a tool that returned undefined, or a body
      // truncated at capture time (which keeps only `preview`). Both must survive scrubbing.
      if (row.data === undefined) {
        out.push({
          t: "blob", h: row.h, kind: row.kind, bytes: row.bytes,
          ...(row.trunc ? { trunc: true, preview: filler((row.preview ?? "").length, seed) } : {}),
        })
        break
      }
      let data = row.data
      if (row.kind === "system") data = fakeSystem(data)
      // opencode's own tool schemas are public text; only the cwd it injects is private, so
      // these are depersonalised rather than replaced — it keeps the demo honest.
      else if (row.kind === "tool") data = deepDepersonalise(data)
      else if (typeof data === "string") data = filler(data.length, seed)
      else data = scrubValue(data, row.kind, seed)
      // Keep the record self-consistent: `bytes` is what the reader sizes segments with.
      const bytes = typeof data === "string" ? data.length : JSON.stringify(data).length
      out.push({ t: "blob", h: row.h, kind: row.kind, bytes, data })
      break
    }

    // The three record types below carry BLOB REFERENCES under content-sounding names —
    // req.system[], req.messages[], res.text, tool.args, tool.output. A generic key-based
    // scrub replaces those hashes with prose and silently detaches every segment from its
    // content, which is why these are handled field by field against the format instead.
    case "req":
      out.push({
        t: "req", id: row.id, ts: row.ts,
        url: depersonalise(row.url), shape: row.shape, agent: row.agent,
        messageID: depersonalise(row.messageID), model: row.model,
        provider: row.provider, limit: row.limit, params: row.params,
        system: row.system, tools: row.tools, messages: row.messages,
      })
      break

    case "res":
      out.push({
        t: "res", req: row.req, ts: row.ts, status: row.status,
        usage: row.usage, stop: row.stop,
        // calls[].args IS content (the arguments the model produced), unlike tool.args.
        calls: (row.calls ?? []).map((c, i) => ({ name: c.name, args: filler((c.args ?? "").length, seed + i) })),
        text: row.text, reasoning: row.reasoning,
      })
      break

    case "tool":
      out.push({
        t: "tool", ts: row.ts, callID: depersonalise(row.callID), tool: row.tool, ms: row.ms,
        title: filler(Math.min((row.title ?? "").length, 40), seed),
        args: row.args, output: row.output, outputBytes: row.outputBytes,
        // metadata is an arbitrary payload — it carried parentSessionId. Dropped wholesale
        // rather than enumerating what might be in there.
      })
      break

    default:
      out.push(scrubValue(row, row.t, seed))
  }
}

fs.writeFileSync(outFile, out.map((r) => JSON.stringify(r)).join("\n") + "\n")
console.log(`scrubbed ${lines.length} -> ${out.length} records into ${outFile}`)
