/**
 * `octx doctor` — answers "why am I not seeing my session?".
 *
 * The failure modes are all invisible from the outside: the plugin not symlinked, tracing
 * off, an `OCTX` that was assigned but never exported, or a running opencode that started
 * before tracing was enabled. Each of those looks identical from `octx ls` — an empty or
 * stale listing — so this reports the actual state of each one.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { resolveConfig, envLevel, listTraceFiles } from "./format.mjs"

const PLUGIN_DIR = path.join(os.homedir(), ".config", "opencode", "plugin")
const GLOBAL_CONFIG = path.join(os.homedir(), ".config", "opencode", "octx.json")

/** Running opencode processes, with whether each one has OCTX in its environment. */
function opencodeProcesses() {
  let out = ""
  try {
    out = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" })
  } catch {
    return []
  }
  const pids = out
    .split("\n")
    .slice(1)
    .filter((l) => /\/opencode\b|(^|\s)opencode(\s|$)/.test(l) && !/octx|ps -eo/.test(l))
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean)

  return pids.map((pid) => {
    let env = ""
    try {
      // `ps eww` prints the process environment on macOS/BSD.
      env = execFileSync("ps", ["eww", "-p", pid], { encoding: "utf8" })
    } catch {
      /* not permitted, or the process exited */
    }
    const match = env.match(/\bOCTX=(\S*)/)
    let started
    try {
      started = execFileSync("ps", ["-o", "lstart=", "-p", pid], { encoding: "utf8" }).trim()
    } catch {
      started = undefined
    }
    return { pid, octx: match ? match[1] : undefined, readable: env.length > 0, started }
  })
}

export function diagnose(dirOverride) {
  const cfg = resolveConfig()
  const dir = dirOverride ?? cfg.dir
  const pluginPath = path.join(PLUGIN_DIR, "octx.ts")

  let pluginTarget
  let pluginOk = false
  try {
    pluginTarget = fs.realpathSync(pluginPath)
    pluginOk = fs.existsSync(pluginTarget)
  } catch {
    pluginOk = false
  }

  const traces = listTraceFiles(dir)
  const newest = traces[0]

  return {
    plugin: { path: pluginPath, target: pluginTarget, ok: pluginOk },
    config: { path: GLOBAL_CONFIG, exists: fs.existsSync(GLOBAL_CONFIG), level: cfg.level, dir },
    env: { raw: process.env.OCTX, effective: envLevel() },
    processes: opencodeProcesses(),
    traces: { count: traces.length, newest },
  }
}
