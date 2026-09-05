/** Terminal rendering: the context meter, session listing, stats tables. */
import { EXPANDABLE, driverLabel } from "./categorize.mjs"

const C = process.stdout.isTTY && !process.env.NO_COLOR
const dim = (s) => (C ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (C ? `\x1b[1m${s}\x1b[0m` : s)
const cyan = (s) => (C ? `\x1b[36m${s}\x1b[0m` : s)
const yellow = (s) => (C ? `\x1b[33m${s}\x1b[0m` : s)
export { dim, bold, cyan, yellow }

export function human(n) {
  if (n == null) return "-"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k"
  return (n / 1_000_000).toFixed(1) + "M"
}

export function bytes(n) {
  if (n == null) return "-"
  if (n < 1024) return n + "B"
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + "K"
  return (n / 1024 / 1024).toFixed(1) + "M"
}

export function bar(fraction, width = 40, ch = "█", empty = "░") {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return ch.repeat(filled) + empty.repeat(width - filled)
}

/** `derived` numbers came from provider arithmetic; anything else is flagged. */
function tierMark(tier) {
  if (tier === "derived") return "  "
  if (tier === "derived-split") return dim(" ~")
  return dim(" ±")
}

/**
 * The context meter. `summary` comes from tokens.summarize().
 */
export function renderContext(summary, meta = {}) {
  const lines = []
  const { total, limit, categories, measured } = summary
  const model = meta.model ?? summary.req.model ?? "?"
  const title = meta.title ? ` · ${meta.title}` : ""

  lines.push("")
  lines.push(`  ${bold(model)}${dim(title)}`)
  if (limit) {
    const frac = total / limit
    lines.push(`  ${cyan(bar(frac, 44))}  ${human(total)}/${human(limit)} ${dim(`(${(frac * 100).toFixed(1)}%)`)}`)
  } else {
    lines.push(`  ${human(total)} tokens ${dim("(model context limit unknown)")}`)
  }
  lines.push(dim(`  request #${summary.req.id} · ${summary.req.ts}${measured ? "" : " · NO USAGE REPORTED, all figures estimated"}`))
  lines.push("")

  // Width has to account for the indented sub-rows too, or their token columns drift.
  const itemWidth = Math.max(
    0,
    ...categories.filter((c) => EXPANDABLE.has(c.key)).flatMap((c) => c.items.map((i) => i.label.length + 2)),
  )
  const width = Math.max(...categories.map((c) => c.label.length), itemWidth, 14)
  for (const c of categories) {
    const pct = total ? (c.tokens / total) * 100 : 0
    lines.push(
      `  ${c.label.padEnd(width)}  ${String(human(c.tokens)).padStart(7)}${tierMark(c.tier)}  ${String(pct.toFixed(1)).padStart(5)}%  ${dim(bar(pct / 100, 20, "▄", " "))}`,
    )
    // Break down the categories where knowing the individual contributors is the point.
    if (EXPANDABLE.has(c.key) && c.items.length > 1) {
      for (const item of c.items.slice(0, 8)) {
        lines.push(
          dim(
            `    └ ${item.label.padEnd(width - 2)}  ${String(human(item.tokens)).padStart(7)}        ${item.count > 1 ? `×${item.count}` : ""}`,
          ),
        )
      }
      if (c.items.length > 8) lines.push(dim(`    └ … ${c.items.length - 8} more`))
    }
  }

  if (limit) {
    const free = limit - total
    lines.push("")
    lines.push(`  ${"Free space".padEnd(width)}  ${String(human(free)).padStart(7)}      ${String(((free / limit) * 100).toFixed(1)).padStart(5)}%`)
  }

  const usage = summary.req.res?.usage
  if (usage) {
    const cached = usage.cache_read ?? 0
    lines.push("")
    lines.push(
      dim(
        `  measured: input ${human(usage.input)} · output ${human(usage.output)}` +
          (cached ? ` · cache read ${human(cached)} (${((cached / usage.input) * 100).toFixed(0)}% of prompt)` : "") +
          (usage.cache_write ? ` · cache write ${human(usage.cache_write)}` : "") +
          (usage.reasoning ? ` · reasoning ${human(usage.reasoning)}` : ""),
      ),
    )
  }
  lines.push("")
  lines.push(dim("  ± estimated (rescaled to the measured total)   ~ exact delta split across segments"))
  lines.push("")
  return lines.join("\n")
}

export function renderList(rows) {
  if (!rows.length) return dim("\n  no traces found — is octx enabled? see octx.example.json\n")
  const out = ["", `  ${bold("SESSION".padEnd(32))} ${bold("WHEN".padEnd(17))} ${bold("REQ".padStart(4))} ${bold("TOKENS".padStart(8))} ${bold("SIZE".padStart(6))}  ${bold("TITLE")}`]
  for (const r of rows) {
    out.push(
      `  ${r.session.slice(0, 32).padEnd(32)} ${r.when.padEnd(17)} ${String(r.requests).padStart(4)} ${human(r.tokens).padStart(8)} ${bytes(r.size).padStart(6)}  ${dim((r.title ?? "").slice(0, 44))}`,
    )
  }
  out.push("")
  return out.join("\n")
}

export function renderStats(stats) {
  const out = [""]
  out.push(`  ${bold(stats.session)}${stats.title ? dim(" · " + stats.title) : ""}`)
  out.push(
    dim(
      `  ${stats.requests} LLM calls (+${stats.metaRequests} title) · ${stats.toolCalls} tool calls · ${human(stats.outputTokens)} output tokens` +
        (stats.reasoningTokens ? ` (${human(stats.reasoningTokens)} reasoning)` : ""),
    ),
  )
  out.push("")

  if (stats.cache.prompt > 0) {
    const hit = (stats.cache.read / stats.cache.prompt) * 100
    out.push(`  ${"Cache hit rate".padEnd(22)} ${hit.toFixed(1)}%  ${dim(`(${human(stats.cache.read)} of ${human(stats.cache.prompt)} prompt tokens)`)}`)
    out.push("")
  }

  if (stats.tools.length) {
    out.push(`  ${bold("TOOL COST")}  ${dim("tokens added to context by each tool's results")}`)
    const width = Math.max(...stats.tools.map((t) => t.tool.length), 10)
    const max = Math.max(...stats.tools.map((t) => t.tokens), 1)
    for (const t of stats.tools) {
      out.push(
        `  ${t.tool.padEnd(width)}  ${String(human(t.tokens)).padStart(7)}  ${String(t.calls).padStart(3)}× ${dim(bar(t.tokens / max, 24, "▄", " "))} ${dim(bytes(t.bytes))}`,
      )
    }
    out.push("")
  }

  out.push(renderGrowth(stats.growth))
  return out.join("\n")
}

/**
 * "What each call added" — the deltas are measured, so this is the one chart in the report
 * that is not an estimate. Followed by a compact composition strip.
 */
export function renderGrowth(g) {
  const out = []
  if (!g || !g.opening) return ""

  out.push(`  ${bold("WHAT EACH CALL ADDED")}  ${dim("measured, not estimated")}`)
  out.push("")

  const usable = g.steps.filter((s) => s.delta != null)
  if (!usable.length) {
    out.push(dim(`  only ${g.callCount} call${g.callCount === 1 ? "" : "s"} so far — nothing to compare yet`))
    out.push("")
  } else {
    const max = Math.max(...usable.map((s) => Math.abs(s.delta)), 1)
    for (const s of g.steps) {
      const id = String("#" + s.id).padStart(4)
      if (s.delta == null) {
        out.push(`  ${id}  ${dim("in flight — no usage reported yet")}`)
        continue
      }
      const sign = s.delta < 0 ? "-" : "+"
      const amount = `${sign}${human(Math.abs(s.delta))}`.padStart(8)
      const note = s.reset
        ? dim(`context pruned — ${s.droppedCount} segment${s.droppedCount === 1 ? "" : "s"} dropped`)
        : dim(s.drivers.slice(0, 3).map(driverLabel).join(", "))
      out.push(`  ${id}  ${amount}  ${bar(Math.abs(s.delta) / max, 22, "▄", " ")}  ${note}`)
    }
    out.push("")

    const biggest = usable.reduce((a, s) => (Math.abs(s.delta) > Math.abs(a.delta) ? s : a))
    if (g.addedTotal > 0 && Math.abs(biggest.delta) / g.addedTotal > 0.4 && usable.length > 2) {
      out.push(
        dim(`  call #${biggest.id} is ${Math.round((Math.abs(biggest.delta) / g.addedTotal) * 100)}% of everything added this session`),
      )
    }
    out.push(
      dim(`  opening prompt ${human(g.opening.total)} · added since ${human(g.addedTotal)} · now ${human(g.finalTotal)}`),
    )
    out.push("")
  }

  if (g.composition.length > 1) {
    out.push(`  ${bold("COMPOSITION")}  ${dim("what the window was made of, per call")}`)
    const max = Math.max(...g.composition.map((c) => c.total), 1)
    // The HTML report separates five bands by colour; a terminal has no colour budget for
    // that, so it shows the same numbers at three-glyph granularity.
    const glyphs = { overhead: "▒", schemas: "░", messages: "▓", calls: "▓", results: "█", reasoning: "▚" }
    for (const c of g.composition) {
      let strip = ""
      for (const cat of c.bands) {
        const width = Math.round((cat.tokens / max) * 34)
        strip += (glyphs[cat.key] ?? "▓").repeat(Math.max(cat.tokens > 0 && width === 0 ? 1 : 0, width))
      }
      out.push(`  ${String("#" + c.id).padStart(4)}  ${String(human(c.total)).padStart(7)}  ${dim(strip)}`)
    }
    out.push(dim("            ▒ system & instructions   ░ tool schemas   ▓ messages & tool calls"))
    out.push(dim("            █ tool results   ▚ reasoning"))
    out.push("")
  }
  return out.join("\n")
}

const OK = C ? "\x1b[32m✓\x1b[0m" : "ok "
const BAD = C ? "\x1b[31m✗\x1b[0m" : "XX "
const WARN = C ? "\x1b[33m!\x1b[0m" : "!  "

/** Renders `octx doctor`: state of each thing that can silently prevent capture. */
export function renderDoctor(d) {
  const out = [""]
  const problems = []

  out.push(`  ${d.plugin.ok ? OK : BAD} plugin    ${dim(d.plugin.target ?? d.plugin.path)}`)
  if (!d.plugin.ok) problems.push("Plugin not installed. Run tools/install.sh")

  const envNote = d.env.raw !== undefined ? ` ${dim(`(OCTX=${d.env.raw || "<empty>"})`)}` : ""
  if (d.env.raw !== undefined && d.env.effective === undefined) {
    out.push(`  ${WARN} level     ${d.config.level} ${dim("— OCTX set but unrecognised, ignored")}${envNote}`)
    problems.push(`OCTX="${d.env.raw}" is not a valid level. Use full, basic, debug or off.`)
  } else if (d.env.effective) {
    out.push(`  ${OK} level     ${bold(d.config.level)} ${dim("(from OCTX, overrides the config file)")}`)
  } else {
    out.push(`  ${d.config.level === "off" ? BAD : OK} level     ${bold(d.config.level)} ${dim(`(from ${d.config.path})`)}`)
    if (d.config.level === "off") {
      problems.push(`Tracing is off. Set "level" in ${d.config.path}, or run: OCTX=basic opencode`)
    }
  }

  out.push(`  ${OK} trace dir ${dim(d.config.dir)} ${dim(`· ${d.traces.count} trace${d.traces.count === 1 ? "" : "s"}`)}`)

  if (!d.processes.length) {
    out.push(`  ${dim("·")} opencode  ${dim("no running sessions")}`)
  } else {
    for (const p of d.processes) {
      if (!p.readable) {
        out.push(`  ${WARN} opencode  pid ${p.pid} ${dim("— environment not readable")}`)
        continue
      }
      const tracing = p.octx !== undefined ? `OCTX=${p.octx}` : "no OCTX — uses the config file"
      const good = p.octx !== undefined || d.config.level !== "off"
      out.push(`  ${good ? OK : BAD} opencode  pid ${p.pid} ${dim(`${tracing}${p.started ? " · started " + p.started : ""}`)}`)
      if (p.octx === undefined && d.config.level === "off") {
        problems.push(
          `opencode pid ${p.pid} is running without OCTX and the config says off, so it is capturing nothing.\n` +
            `      It reads the config file live — setting "level" now starts capture on its next message, no restart.`,
        )
      }
    }
  }

  if (d.traces.newest) {
    const age = Date.now() - d.traces.newest.mtime
    const mins = Math.round(age / 60000)
    out.push(
      `  ${dim("·")} newest    ${dim(`${d.traces.newest.session} · ${mins < 1 ? "just now" : mins + " min ago"}`)}`,
    )
  }

  if (problems.length) {
    out.push("")
    for (const p of problems) out.push(`  ${yellow("→")} ${p}`)
  } else {
    out.push("")
    out.push(dim("  capture is enabled and a running session will be recorded"))
  }

  // The trap that prompted this command existing.
  if (d.env.raw === undefined && d.processes.some((p) => p.readable && p.octx === undefined)) {
    out.push("")
    out.push(
      dim("  note: `OCTX=basic` on its own line sets a shell variable, not an environment"),
    )
    out.push(dim("        variable. Use `export OCTX=basic` or `OCTX=basic opencode`."))
  }
  out.push("")
  return out.join("\n")
}
