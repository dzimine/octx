/**
 * octx trace format — the contract between plugin/octx.ts (writer) and the CLI (reader).
 * See README.md for the prose version. Keep FORMAT_VERSION in sync with the plugin.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const FORMAT_VERSION = 1
export const LEVELS = { off: 0, basic: 1, full: 2, debug: 3 }

export const DEFAULT_CONFIG = {
  level: "off",
  dir: path.join(os.homedir(), ".local", "share", "octx"),
  maxBlobBytes: 262144,
  redactHeaders: true,
  retainDays: 30,
}

/** Tools opencode ships itself. Anything else in a request is an MCP tool or a skill. */
export const BUILTIN_TOOLS = new Set([
  "bash",
  "edit",
  "glob",
  "grep",
  "list",
  "patch",
  "apply_patch",
  "read",
  "skill",
  "task",
  "todoread",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
  "question",
  "invalid",
])

/**
 * `OCTX=full opencode …` overrides the configured level for one invocation. Kept identical to
 * the plugin's copy in plugin/octx.ts — that file cannot import from here (it is loaded
 * through a symlink), so this is the one place the two are deliberately duplicated.
 */
export function envLevel() {
  const raw = process.env.OCTX?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw in LEVELS) return raw
  if (raw === "1" || raw === "on" || raw === "true" || raw === "yes") return "full"
  if (raw === "0" || raw === "false" || raw === "no") return "off"
  return undefined
}

export function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

/** Same resolution order the plugin uses: global config, then project override. */
export function resolveConfig(directory = process.cwd()) {
  const files = [
    path.join(os.homedir(), ".config", "opencode", "octx.json"),
    path.join(directory, ".opencode", "octx.json"),
  ]
  let merged = { ...DEFAULT_CONFIG }
  for (const file of files) {
    try {
      merged = { ...merged, ...JSON.parse(fs.readFileSync(file, "utf8")) }
    } catch {
      /* absent or unreadable */
    }
  }
  const fromEnv = envLevel()
  if (fromEnv) merged.level = fromEnv
  if (process.env.OCTX_DIR) merged.dir = process.env.OCTX_DIR
  merged.dir = expandHome(String(merged.dir || DEFAULT_CONFIG.dir))
  return merged
}

/** All trace files under the trace dir, newest first. */
export function listTraceFiles(dir) {
  const out = []
  let days
  try {
    days = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const day of days) {
    if (!day.isDirectory()) continue
    const dayDir = path.join(dir, day.name)
    let entries
    try {
      entries = fs.readdirSync(dayDir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith(".ndjson")) continue
      const file = path.join(dayDir, name)
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      out.push({ file, day: day.name, session: name.replace(/\.ndjson$/, ""), size: stat.size, mtime: stat.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Accepts a full session id or any unambiguous prefix/suffix of one. */
export function findTrace(dir, needle) {
  const all = listTraceFiles(dir)
  if (!needle) return all[0]
  const exact = all.find((t) => t.session === needle)
  if (exact) return exact
  const matches = all.filter((t) => t.session.includes(needle))
  if (matches.length === 0) return undefined
  if (matches.length > 1) {
    const err = new Error(
      `"${needle}" matches ${matches.length} sessions:\n  ` + matches.map((m) => m.session).join("\n  "),
    )
    err.ambiguous = matches
    throw err
  }
  return matches[0]
}
