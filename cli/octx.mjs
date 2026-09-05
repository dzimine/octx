#!/usr/bin/env node
/**
 * octx — inspect what opencode actually sent to the model.
 *
 * Everything here is offline: it reads trace files written by plugin/octx.ts and never
 * contacts a model, so no command costs tokens.
 */
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolveConfig, listTraceFiles, findTrace } from "../lib/format.mjs"
import { readTrace, enrichFromDb } from "../lib/read.mjs"
import { attribute, summarize } from "../lib/tokens.mjs"
import { sessionStats } from "../lib/stats.mjs"
import { renderContext, renderList, renderStats, renderDoctor, human, bytes, dim, bold } from "../lib/render-term.mjs"
import { renderHtml } from "../lib/render-html.mjs"
import { diagnose } from "../lib/doctor.mjs"

const HELP = `
octx — inspect opencode's real context window

  octx ls                            sessions with traces
  octx context [<session>] [--at N]  context window breakdown (default: newest, last call)
  octx show <session> [--req N]      the exact messages sent, per request
  octx stats [<session>]             tool cost, cache hit rate, context growth
  octx report [<session>] [-o FILE]  self-contained HTML report
  octx tail [<session>]              follow a live session
  octx doctor                        why am I not seeing my session?

Options
  --at N, --req N   which LLM call to inspect (1-based; negative counts from the end)
  --json            machine-readable output
  --raw             show full blob contents rather than previews
  -o, --out FILE    output path for report
  --open            open the report when written
  --dir DIR         trace directory (default: from octx.json)

Session may be any unambiguous fragment of a session id. Omit it for the most recent.
`

function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") opts.json = true
    else if (a === "--raw") opts.raw = true
    else if (a === "--open") opts.open = true
    else if (a === "--at" || a === "--req") opts.at = Number(argv[++i])
    else if (a === "-o" || a === "--out") opts.out = argv[++i]
    else if (a === "--dir") opts.dir = argv[++i]
    else if (a === "-h" || a === "--help") opts.help = true
    else opts._.push(a)
  }
  return opts
}

function die(msg) {
  process.stderr.write(`octx: ${msg}\n`)
  process.exit(1)
}

function traceDir(opts) {
  return opts.dir ? path.resolve(opts.dir) : resolveConfig().dir
}

function load(opts, needle) {
  const dir = traceDir(opts)
  let entry
  try {
    entry = findTrace(dir, needle)
  } catch (err) {
    die(err.message)
  }
  if (!entry) {
    die(
      needle
        ? `no trace matching "${needle}" in ${dir}`
        : `no traces in ${dir} — enable octx (see octx.example.json) and run opencode`,
    )
  }
  return { entry, trace: readTrace(entry.file) }
}

/** Resolves --at against a list: 1-based, negative counts from the end, default last. */
function pick(list, at) {
  if (!list.length) return undefined
  if (at == null || Number.isNaN(at)) return list[list.length - 1]
  const i = at < 0 ? list.length + at : at - 1
  return list[Math.max(0, Math.min(list.length - 1, i))]
}

function cmdLs(opts) {
  const dir = traceDir(opts)
  const rows = listTraceFiles(dir).map((f) => {
    const trace = readTrace(f.file)
    const db = enrichFromDb(trace.session)
    const tokens = trace.conversation.reduce((a, r) => Math.max(a, r.res?.usage?.input ?? 0), 0)
    return {
      session: trace.session,
      when: new Date(f.mtime).toISOString().slice(0, 16).replace("T", " "),
      requests: trace.conversation.length,
      tokens,
      size: f.size,
      title: db?.title ?? trace.header?.title,
      file: f.file,
    }
  })
  if (opts.json) return void process.stdout.write(JSON.stringify(rows, null, 2) + "\n")
  process.stdout.write(renderList(rows))
}

function cmdContext(opts) {
  const { trace } = load(opts, opts._[0])
  const summaries = attribute(trace).map(summarize)
  if (!summaries.length) die(`no LLM calls recorded in ${trace.session}`)
  const summary = pick(summaries, opts.at)
  const db = enrichFromDb(trace.session)
  if (opts.json) {
    return void process.stdout.write(
      JSON.stringify(
        {
          session: trace.session,
          title: db?.title,
          request: summary.req.id,
          total: summary.total,
          limit: summary.limit,
          measured: summary.measured,
          categories: summary.categories.map((c) => ({ ...c, items: c.items, tiers: undefined })),
        },
        null,
        2,
      ) + "\n",
    )
  }
  process.stdout.write(renderContext(summary, { title: db?.title ?? trace.header?.title, model: summary.req.model }))
}

function preview(value, raw) {
  if (value === undefined) return dim("(truncated — raise level to \"full\" to keep this)")
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  if (raw || s.length <= 800) return s
  return s.slice(0, 800) + dim(`\n… ${s.length - 800} more chars (--raw for all)`)
}

function cmdShow(opts) {
  const { trace } = load(opts, opts._[0])
  const req = pick(trace.conversation, opts.at)
  if (!req) die(`no LLM calls recorded in ${trace.session}`)
  if (opts.json) {
    return void process.stdout.write(
      JSON.stringify(
        {
          ...req,
          system: (req.system ?? []).map((h) => trace.data(h)),
          tools: (req.tools ?? []).map((t) => ({ name: t.name, definition: trace.data(t.h) })),
          messages: (req.messages ?? []).map((h) => trace.data(h)),
          response: req.res ? { ...req.res, text: trace.data(req.res.text) } : undefined,
        },
        null,
        2,
      ) + "\n",
    )
  }

  const out = []
  out.push("")
  out.push(`  ${bold(`request #${req.id}`)} ${dim(`${req.shape} · ${req.model} · agent ${req.agent} · ${req.ts}`)}`)
  out.push(dim(`  params ${JSON.stringify(req.params)}`))
  out.push("")
  for (const h of req.system ?? []) {
    out.push(`  ${bold("SYSTEM")} ${dim(`(${bytes(trace.bytes(h))})`)}`)
    out.push(indent(preview(trace.data(h), opts.raw)))
    out.push("")
  }
  out.push(`  ${bold("TOOLS")} ${dim(`(${(req.tools ?? []).length} definitions, ${bytes((req.tools ?? []).reduce((a, t) => a + trace.bytes(t.h), 0))})`)}`)
  out.push(dim("    " + (req.tools ?? []).map((t) => t.name).join(", ")))
  out.push("")
  for (const h of req.messages ?? []) {
    const m = trace.data(h)
    const role = m?.role ?? "?"
    out.push(`  ${bold(role.toUpperCase())} ${dim(`(${bytes(trace.bytes(h))})`)}`)
    out.push(indent(preview(m, opts.raw)))
    out.push("")
  }
  if (req.res) {
    out.push(`  ${bold("RESPONSE")} ${dim(`${req.res.status} · stop ${req.res.stop} · ${JSON.stringify(req.res.usage)}`)}`)
    if (req.res.text) out.push(indent(preview(trace.data(req.res.text), opts.raw)))
    for (const call of req.res.calls ?? []) out.push(indent(dim(`→ ${call.name}(${call.args})`)))
    out.push("")
  }
  process.stdout.write(out.join("\n"))
}

function indent(text) {
  return String(text)
    .split("\n")
    .map((l) => "    " + l)
    .join("\n")
}

function cmdStats(opts) {
  const { trace } = load(opts, opts._[0])
  const db = enrichFromDb(trace.session)
  const stats = { ...sessionStats(trace), title: db?.title ?? trace.header?.title }
  if (opts.json) {
    return void process.stdout.write(JSON.stringify({ ...stats, summaries: undefined }, null, 2) + "\n")
  }
  process.stdout.write(renderStats(stats))
}

function cmdReport(opts) {
  const { entry, trace } = load(opts, opts._[0])
  const db = enrichFromDb(trace.session)
  const html = renderHtml(trace, { db, file: entry.file })
  const out = path.resolve(opts.out ?? `octx-${db?.slug ?? trace.session.slice(0, 12)}.html`)
  fs.writeFileSync(out, html)
  process.stdout.write(`wrote ${out} ${dim(`(${bytes(fs.statSync(out).size)})`)}\n`)
  if (opts.open) execFile("open", [out], () => {})
}

function cmdTail(opts) {
  const { entry } = load(opts, opts._[0])
  process.stdout.write(dim(`following ${entry.file}\n`))
  let size = 0
  const emit = () => {
    let stat
    try {
      stat = fs.statSync(entry.file)
    } catch {
      return
    }
    if (stat.size <= size) return
    const fd = fs.openSync(entry.file, "r")
    const buf = Buffer.alloc(stat.size - size)
    fs.readSync(fd, buf, 0, buf.length, size)
    fs.closeSync(fd)
    size = stat.size
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row.t === "blob") continue
      if (row.t === "req") process.stdout.write(`${dim(row.ts)} ${bold("req")} #${row.id} ${row.agent ?? ""} ${row.messages?.length ?? 0} msgs, ${row.tools?.length ?? 0} tools\n`)
      else if (row.t === "res") process.stdout.write(`${dim(row.ts)} ${bold("res")} #${row.req} in ${human(row.usage?.input)} out ${human(row.usage?.output)} ${dim(row.stop ?? "")}\n`)
      else if (row.t === "tool") process.stdout.write(`${dim(row.ts)} ${bold("tool")} ${row.tool} ${dim(`${row.ms}ms ${bytes(row.outputBytes)}`)}\n`)
      else process.stdout.write(`${dim(row.ts)} ${row.t}\n`)
    }
  }
  emit()
  setInterval(emit, 400)
}

const [, , command, ...rest] = process.argv
const opts = parseArgs(rest)
if (opts.help || !command || command === "help") {
  process.stdout.write(HELP)
  process.exit(0)
}
function cmdDoctor(opts) {
  const d = diagnose(opts.dir ? path.resolve(opts.dir) : undefined)
  if (opts.json) return void process.stdout.write(JSON.stringify(d, null, 2) + "\n")
  process.stdout.write(renderDoctor(d))
}

const commands = { ls: cmdLs, context: cmdContext, show: cmdShow, stats: cmdStats, report: cmdReport, tail: cmdTail, doctor: cmdDoctor }
const fn = commands[command]
if (!fn) die(`unknown command "${command}"\n${HELP}`)
fn(opts)
