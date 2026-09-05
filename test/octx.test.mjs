/**
 * Round-trip and calibration tests. Run with: node --test test/
 *
 * These guard the two things most likely to rot: the format contract between the plugin
 * (writer) and lib/ (reader), and the token estimator's standing bias against real provider
 * numbers. The calibration test deliberately prints the error rather than only asserting on
 * it, so drift is visible in CI output before it becomes a failure.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { readTrace, groupTools, classifyMessages } from "../lib/read.mjs"
import { attribute, summarize, estimateTokens, segmentsOf } from "../lib/tokens.mjs"
import { sessionStats } from "../lib/stats.mjs"
import { renderHtml } from "../lib/render-html.mjs"
import { renderContext } from "../lib/render-term.mjs"
import { BUILTIN_TOOLS, FORMAT_VERSION, resolveConfig } from "../lib/format.mjs"
import { splitSystem, classifyTool, countSkills } from "../lib/categorize.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(here, "fixtures", "session.ndjson")

test("fixture exists — regenerate with tools/capture-fixture.sh if missing", () => {
  assert.ok(fs.existsSync(FIXTURE), `missing ${FIXTURE}`)
})

test("round trip: every blob reference resolves", () => {
  const trace = readTrace(FIXTURE)
  assert.equal(trace.header.v, FORMAT_VERSION, "format version drift between plugin and lib")
  assert.ok(trace.requests.length > 0, "no requests in fixture")
  assert.deepEqual(trace.errors, [], "reader reported errors")

  for (const req of trace.requests) {
    for (const h of req.system ?? []) assert.ok(trace.blobs.has(h), `unresolved system blob ${h}`)
    for (const t of req.tools ?? []) assert.ok(trace.blobs.has(t.h), `unresolved tool blob ${t.h}`)
    for (const h of req.messages ?? []) assert.ok(trace.blobs.has(h), `unresolved message blob ${h}`)
  }
  for (const t of trace.tools) {
    assert.ok(trace.blobs.has(t.args), `unresolved tool args blob ${t.args}`)
    assert.ok(trace.blobs.has(t.output), `unresolved tool output blob ${t.output}`)
  }
})

test("blobs are deduplicated, not re-recorded per request", () => {
  const trace = readTrace(FIXTURE)
  const refs = trace.requests.flatMap((r) => [...(r.system ?? []), ...(r.tools ?? []).map((t) => t.h)])
  const unique = new Set(refs)
  assert.ok(
    refs.length > unique.size,
    "expected the system prompt and tool schemas to be referenced by several requests",
  )
  // Each hash is written exactly once no matter how many requests reference it.
  const lines = fs.readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const written = lines.filter((l) => l.t === "blob").map((l) => l.h)
  assert.equal(written.length, new Set(written).size, "a blob was written more than once")
})

test("categories sum exactly to the measured prompt total", () => {
  const trace = readTrace(FIXTURE)
  for (const entry of attribute(trace)) {
    if (!entry.measured) continue
    const summary = summarize(entry)
    const sum = summary.categories.reduce((a, c) => a + c.tokens, 0)
    assert.equal(sum, entry.total, `request #${entry.req.id}: categories sum to ${sum}, measured ${entry.total}`)
  }
})

test("differencing derives appended segments exactly", () => {
  const trace = readTrace(FIXTURE)
  const entries = attribute(trace)
  assert.ok(entries.length >= 2, "fixture needs at least two conversation requests")

  const [prev, next] = entries.slice(-2)
  const delta = next.total - prev.total
  const derived = next.segments.filter((s) => s.tier === "derived" || s.tier === "derived-split")
  const derivedSum = derived.reduce((a, s) => a + s.tokens, 0)
  assert.ok(derived.length > 0, "no segments were derived by differencing")
  assert.equal(derivedSum, delta, `derived segments sum to ${derivedSum}, measured delta ${delta}`)
})

test("tool results are attributed to the tool that produced them", () => {
  const trace = readTrace(FIXTURE)
  const last = trace.conversation[trace.conversation.length - 1]
  const results = classifyMessages(trace, last).filter((m) => m.kind === "tool_result")
  assert.ok(results.length > 0, "fixture has no tool results")
  // Every result must name a tool that was actually offered in that request — which covers
  // MCP tools too, not just opencode's built-ins.
  const offered = new Set(last.tools.map((t) => t.name))
  for (const r of results) {
    assert.notEqual(r.label, "?", "a tool result was not matched to its call")
    assert.ok(offered.has(r.label), `tool result attributed to ${r.label}, which was not offered`)
  }
})

test("built-in and MCP tools are separated", () => {
  const trace = readTrace(FIXTURE)
  const groups = groupTools(trace, trace.conversation[0])
  assert.ok(groups.builtin.length > 0, "no built-in tools recognised")
  assert.ok(groups.mcp.length > 0, "fixture has no MCP tools — recapture with tools/capture-fixture.sh")
  for (const t of groups.builtin) assert.ok(BUILTIN_TOOLS.has(t.name), `${t.name} misfiled as built-in`)
  for (const t of groups.mcp) assert.ok(!BUILTIN_TOOLS.has(t.name), `${t.name} misfiled as MCP`)
  // The server prefix is inferred for display only, but it should still work on real names.
  assert.equal(classifyTool("octxfix_bloated_query").server, "octxfix")
  assert.equal(classifyTool("bash").kind, "tool_builtin")
  assert.equal(classifyTool("bash").server, null)
})

test("the context view separates built-in from MCP tool schemas", () => {
  const trace = readTrace(FIXTURE)
  const summary = summarize(attribute(trace).at(-1))
  const keys = summary.categories.map((c) => c.key)
  assert.ok(keys.includes("tool_builtin"), "built-in tools not reported as their own category")
  assert.ok(keys.includes("tool_mcp"), "MCP tools not reported as their own category")

  // The whole point of the split: MCP tools must be attributable individually.
  const mcp = summary.categories.find((c) => c.key === "tool_mcp")
  assert.ok(mcp.items.length > 1, "MCP tools not broken down per tool")
  const biggest = mcp.items[0]
  assert.match(biggest.label, /bloated_query/, "MCP items are not sorted by cost")
})

test("system prompt splits into base, environment, memory files and skills", () => {
  const trace = readTrace(FIXTURE)
  const text = trace.data(trace.conversation[0].system[0])
  const parts = splitSystem(text)
  const kinds = parts.map((p) => p.kind)

  assert.deepEqual(kinds, ["system", "env", "memory", "skills"], "system prompt layout changed")
  // Nothing may be lost or duplicated by the split.
  assert.equal(parts.reduce((a, p) => a + p.text.length, 0), text.length, "split lost or duplicated bytes")

  // Confirm the positionally-identified memory section really is the instruction files.
  const memory = parts.find((p) => p.kind === "memory")
  assert.match(memory.text, /AGENTS\.md|CLAUDE\.md/, "memory section does not name an instruction file")

  const skills = parts.find((p) => p.kind === "skills")
  assert.ok(countSkills(skills.text) > 0, "skills block advertises no skills")
})

test("splitSystem degrades gracefully when the anchors are absent", () => {
  const plain = "You are a helpful assistant."
  assert.deepEqual(splitSystem(plain), [{ kind: "system", label: "System prompt", text: plain }])
  assert.equal(splitSystem("").length, 1)
  assert.equal(splitSystem(undefined).length, 1)

  // Skills present but no env block: the skills block must still be lifted out cleanly.
  const noEnv = "base prompt\n<available_skills>\n  <name>x</name>\n</available_skills>"
  const kinds = splitSystem(noEnv).map((p) => p.kind)
  assert.deepEqual(kinds, ["system", "skills"])
})

test("estimator bias against real provider counts stays within 50%", () => {
  const trace = readTrace(FIXTURE)
  const errors = []
  for (const req of trace.conversation) {
    const real = req.res?.usage?.input
    if (!real) continue
    const est = segmentsOf(trace, req).reduce((a, s) => a + estimateTokens(s.text ?? ""), 0)
    errors.push({ id: req.id, real, est, bias: (est / real - 1) * 100 })
  }
  assert.ok(errors.length > 0, "no measured requests in fixture")
  const mean = errors.reduce((a, e) => a + e.bias, 0) / errors.length
  // Printed rather than silently asserted: the absolute bias is divided out by calibration,
  // so what matters is noticing when it MOVES.
  console.log(
    `    estimator bias: ${mean.toFixed(1)}% mean ` +
      errors.map((e) => `(#${e.id} est ${e.est} vs ${e.real})`).join(" "),
  )
  assert.ok(Math.abs(mean) < 50, `estimator bias ${mean.toFixed(1)}% is out of range`)
})

test("renderers produce output without throwing", () => {
  const trace = readTrace(FIXTURE)
  const summary = summarize(attribute(trace).at(-1))
  const term = renderContext(summary, { title: "test" })
  assert.match(term, /System prompt/)

  const html = renderHtml(trace, { db: { title: "test" }, file: FIXTURE })
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<meta charset="utf-8">/)
  // The embedded model must be valid JSON or the report renders blank.
  const embedded = html.match(/window\.__OCTX__ = (.*?);<\/script>/s)
  assert.ok(embedded, "no embedded model found in report")
  const model = JSON.parse(embedded[1].replace(/\\u003c/g, "<"))
  assert.equal(model.session, trace.session)
  assert.ok(model.requests.length > 0)
})

test("the collapse markup and its CSS are wired up", () => {
  // The category table is built client-side from window.__OCTX__, so the published HTML
  // contains the generator, not the rows. This checks the pieces that must be present for
  // collapsing to work at all; that it actually collapses was verified in a browser.
  const html = renderHtml(readTrace(GROWTH_FIXTURE), { db: {}, file: GROWTH_FIXTURE })

  assert.match(html, /class=sub data-child=[^>]*hidden/, "sub-rows are not emitted hidden")
  assert.match(html, /class=parent aria-expanded=false/, "parent rows are not marked collapsed")
  assert.match(html, /function toggleCat/, "no toggle handler")
  assert.match(html, /window\.toggleCat = toggleCat/, "toggle is not reachable from the onclick")
  // `tr[hidden]` needs an explicit rule: any display value on the row defeats the attribute.
  assert.match(html, /tr\[hidden\]\{display:none\}/, "hidden rows would still render")
  // Only expandable categories become clickable; the rest must not be no-op buttons.
  assert.match(html, /const expandable = EXPANDABLE\.has\(c\.key\) && c\.items\.length>1/)
})

test("the composition chart ships a legend", () => {
  const html = renderHtml(readTrace(GROWTH_FIXTURE), { db: {}, file: GROWTH_FIXTURE })
  assert.match(html, /id="complegend"/, "no legend container")
  assert.match(html, /complegend'\)\.innerHTML/, "legend is never populated")
})

test("reasoning is separated from assistant text and tool calls", async () => {
  const { CATEGORY_ORDER } = await import("../lib/categorize.mjs")
  const trace = readTrace(GROWTH_FIXTURE)
  const last = trace.conversation[trace.conversation.length - 1]

  const parts = classifyMessages(trace, last)
  const reasoning = parts.filter((p) => p.kind === "reasoning")
  assert.ok(reasoning.length > 0, "fixture has no reasoning — recapture with a reasoning model")

  // Each part must carry its OWN text, or the estimator counts a split message once per part.
  for (const p of parts) {
    if (p.text === undefined) continue
    assert.ok(p.text.length <= p.size + 2, `part text (${p.text.length}) exceeds its size (${p.size})`)
  }

  // Reasoning used to land inside tool_call, because it was whatever remained of the
  // message after the visible text. Assert it is now its own category with real weight.
  const summary = summarize(attribute(trace).at(-1))
  const row = summary.categories.find((c) => c.key === "reasoning")
  assert.ok(row, "reasoning is not reported as its own category")
  assert.ok(row.tokens > 0)
  assert.ok(CATEGORY_ORDER.indexOf("reasoning") < CATEGORY_ORDER.indexOf("tool_call"))

  // And the two reasoning numbers are different things: prompt occupancy vs billed output.
  const { sessionStats } = await import("../lib/stats.mjs")
  const stats = sessionStats(trace)
  assert.ok(stats.reasoningTokens > 0, "billed reasoning output not tracked")
  assert.notEqual(stats.reasoningTokens, row.tokens, "the two reasoning figures should not be the same number")
})

test("stats roll up without losing requests", () => {
  const trace = readTrace(FIXTURE)
  const stats = sessionStats(trace)
  assert.equal(stats.requests + stats.metaRequests, trace.requests.length)
  // growth is a model, not a list of totals — one composition row per conversation request.
  assert.equal(stats.growth.composition.length, trace.conversation.length)
  assert.equal(stats.growth.callCount, trace.conversation.length)
})

test("OCTX env var overrides the configured level", () => {
  const original = process.env.OCTX
  try {
    delete process.env.OCTX
    const base = resolveConfig().level

    process.env.OCTX = "full"
    assert.equal(resolveConfig().level, "full")
    process.env.OCTX = "1"
    assert.equal(resolveConfig().level, "full", "truthy spellings should mean full")
    process.env.OCTX = "off"
    assert.equal(resolveConfig().level, "off")
    process.env.OCTX = "BASIC"
    assert.equal(resolveConfig().level, "basic", "level names should be case-insensitive")

    // A typo must fall back to the config file rather than guess — silently enabling
    // `debug` because someone wrote OCTX=debgu would be worse than ignoring it.
    process.env.OCTX = "nonsense"
    assert.equal(resolveConfig().level, base, "an unrecognised value should be ignored")
    process.env.OCTX = ""
    assert.equal(resolveConfig().level, base, "an empty value should be ignored")
  } finally {
    if (original === undefined) delete process.env.OCTX
    else process.env.OCTX = original
  }
})

test("plugin and reader agree on how OCTX is interpreted", () => {
  // plugin/octx.ts cannot import from lib/ (it loads through a symlink), so envLevel() is
  // duplicated. This asserts the two copies stay in step.
  const pluginSource = fs.readFileSync(path.join(here, "..", "plugin", "octx.ts"), "utf8")
  const readerSource = fs.readFileSync(path.join(here, "..", "lib", "format.mjs"), "utf8")
  const clauses = (src) =>
    (src.match(/raw === "[a-z0-9]+"/g) ?? []).sort().join(",")
  assert.equal(
    clauses(pluginSource),
    clauses(readerSource),
    "envLevel() drifted between plugin/octx.ts and lib/format.mjs",
  )
})

test("doctor reports the failure modes that silently prevent capture", async () => {
  const { renderDoctor } = await import("../lib/render-term.mjs")

  const base = {
    plugin: { path: "/p/octx.ts", target: "/repo/plugin/octx.ts", ok: true },
    config: { path: "/c/octx.json", exists: true, level: "basic", dir: "/d" },
    env: { raw: undefined, effective: undefined },
    processes: [],
    traces: { count: 1, newest: null },
  }

  // Plugin missing.
  assert.match(
    renderDoctor({ ...base, plugin: { ...base.plugin, ok: false } }),
    /Plugin not installed/,
  )

  // Tracing off.
  assert.match(renderDoctor({ ...base, config: { ...base.config, level: "off" } }), /Tracing is off/)

  // The exact trap: a session running with no OCTX while the config says off.
  const trapped = renderDoctor({
    ...base,
    config: { ...base.config, level: "off" },
    processes: [{ pid: "123", octx: undefined, readable: true, started: "now" }],
  })
  assert.match(trapped, /capturing nothing/)
  assert.match(trapped, /no restart/, "should say the config file is live-reloaded")
  assert.match(trapped, /shell variable, not an environment/, "should explain the export trap")

  // A typo'd OCTX must be called out, not silently ignored.
  assert.match(
    renderDoctor({ ...base, env: { raw: "debgu", effective: undefined } }),
    /not a valid level/,
  )

  // Healthy state says so and does not emit the shell note.
  const healthy = renderDoctor({
    ...base,
    processes: [{ pid: "123", octx: "basic", readable: true, started: "now" }],
  })
  assert.match(healthy, /capture is enabled/)
  assert.doesNotMatch(healthy, /shell variable/)
})

const GROWTH_FIXTURE = path.join(here, "fixtures", "growth.ndjson")

test("growth deltas are per call, not cumulative", async () => {
  const { growth } = await import("../lib/stats.mjs")
  const trace = readTrace(GROWTH_FIXTURE)
  const g = growth(trace)
  assert.ok(g.steps.length > 5, "growth fixture needs a multi-call session")

  // The bug this guards: carried segments keep the tier they were first given, so filtering
  // by tier yields everything ever added and every row reads as the sum of all before it.
  for (const step of g.steps) {
    if (step.delta == null || step.reset) continue
    const driverSum = step.drivers.reduce((a, d) => a + d.tokens, 0)
    assert.equal(
      driverSum,
      step.delta,
      `call #${step.id}: drivers sum to ${driverSum} but the measured delta is ${step.delta}`,
    )
  }

  // Deltas must reconstruct the running total exactly.
  let running = g.opening.total
  for (const step of g.steps) {
    if (step.delta == null) continue
    running += step.delta
    assert.equal(running, step.total, `call #${step.id}: running total drifted from the measured total`)
  }
})

test("growth totals are internally consistent", async () => {
  const { growth } = await import("../lib/stats.mjs")
  const g = growth(readTrace(GROWTH_FIXTURE))
  const measured = g.steps.filter((s) => s.measured && !s.reset)
  assert.equal(
    g.addedTotal,
    measured.reduce((a, s) => a + Math.max(0, s.delta), 0),
  )
  assert.equal(g.composition.length, g.callCount)
  assert.equal(g.steps.length, g.callCount - 1, "one delta per call after the first")
})

test("a request still in flight is marked, not treated as a drop", async () => {
  const { growth } = await import("../lib/stats.mjs")
  const trace = readTrace(GROWTH_FIXTURE)
  // Drop the last response to simulate a call whose usage has not arrived yet.
  const lines = fs.readFileSync(GROWTH_FIXTURE, "utf8").split("\n").filter(Boolean)
  const lastRes = lines.map((l) => JSON.parse(l)).filter((r) => r.t === "res").pop()
  const trimmed = lines.filter((l) => {
    const r = JSON.parse(l)
    return !(r.t === "res" && r.req === lastRes.req)
  })
  const tmp = path.join(os.tmpdir(), `octx-inflight-${process.pid}.ndjson`)
  fs.writeFileSync(tmp, trimmed.join("\n") + "\n")
  try {
    const g = growth(readTrace(tmp))
    const step = g.steps.find((s) => s.id === lastRes.req)
    assert.ok(step, "the in-flight call should still appear")
    assert.equal(step.delta, null, "an in-flight call must not report a delta")
    assert.equal(step.inFlight, true)
    // It must not be miscounted as a prune.
    assert.equal(step.reset, false)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})

test("growth renders for both long and one-call sessions", async () => {
  const { renderGrowth } = await import("../lib/render-term.mjs")
  const { growth } = await import("../lib/stats.mjs")

  const long = renderGrowth(growth(readTrace(GROWTH_FIXTURE)))
  assert.match(long, /WHAT EACH CALL ADDED/)
  assert.match(long, /COMPOSITION/)
  assert.match(long, /opening prompt/)

  // A session with a single call has nothing to compare and must say so rather than
  // rendering an empty chart.
  const one = {
    opening: { id: 1, total: 100 },
    steps: [],
    addedTotal: 0,
    finalTotal: 100,
    callCount: 1,
    limit: null,
    composition: [{ id: 1, total: 100, measured: true, categories: [] }],
  }
  assert.match(renderGrowth(one), /nothing to compare yet/)
  assert.equal(renderGrowth(null), "")
})

test("colour-carrying charts use validated bands, the table keeps all categories", async () => {
  const { groupCategories, CATEGORY_GROUPS } = await import("../lib/categorize.mjs")
  const trace = readTrace(GROWTH_FIXTURE)
  const summary = summarize(attribute(trace).at(-1))

  const bands = groupCategories(summary.categories)
  // Six is the ceiling: past ~7 classes the right form is a table, and the palette is
  // validated at six slots. Adding a band means re-running the validator.
  assert.ok(bands.length <= 6, "more colour bands than the palette was validated for")
  assert.ok(summary.categories.length > bands.length, "grouping did not reduce anything")
  // Grouping must not lose or invent tokens.
  assert.equal(
    bands.reduce((a, b) => a + b.tokens, 0),
    summary.categories.reduce((a, c) => a + c.tokens, 0),
    "grouping changed the total",
  )
  // Fixed order, never cycled.
  const order = CATEGORY_GROUPS.map((g) => g.key)
  const seen = bands.map((b) => b.key)
  assert.deepEqual(seen, order.filter((k) => seen.includes(k)), "bands are not in fixed order")

  const html = renderHtml(trace, { db: {}, file: GROWTH_FIXTURE })
  // The detail table stays at full granularity — a table is the right form for >7 classes.
  assert.match(html, /Tool results/)
  assert.match(html, /Memory files/)
  // The hand-picked palette had two of the biggest bands at normal-vision dE 6.6. These are
  // the validated replacements; if someone re-picks them by eye, this fails.
  // Light steps, then the dark steps — the greens differ between modes because the dark
  // lightness band is too narrow for the light-mode pair to clear the floor.
  for (const hex of ["#eb6834", "#2a78d6", "#1baf7a", "#007000", "#eda100", "#e87ba4"])
    assert.match(html, new RegExp(hex), `validated light hue ${hex} missing`)
  for (const hex of ["#d95926", "#3987e5", "#1cb03c", "#007c00", "#c98500", "#d55181"])
    assert.match(html, new RegExp(hex), `validated dark hue ${hex} missing`)
  assert.doesNotMatch(html, /#c96f2b|#c98a2b/, "an unvalidated hue came back")

  // Messages and Reasoning must stay adjacent — they are two steps of one green, and the
  // whole band order was solved around keeping orange away from them.
  const keys = CATEGORY_GROUPS.map((g) => g.key)
  assert.equal(
    Math.abs(keys.indexOf("messages") - keys.indexOf("reasoning")),
    1,
    "messages and reasoning are no longer adjacent; the palette was validated for that order",
  )
  assert.ok(
    Math.abs(keys.indexOf("schemas") - keys.indexOf("messages")) > 1 &&
      Math.abs(keys.indexOf("schemas") - keys.indexOf("reasoning")) > 1,
    "the orange band is adjacent to a green one — that is a red-green collision (dE 3.5 deutan)",
  )
})

test("tool cost is available per call, not just for the session", async () => {
  const { growth } = await import("../lib/stats.mjs")
  const g = growth(readTrace(GROWTH_FIXTURE))

  // Every call carries its own tool rows so the report's tool table can be scoped with
  // everything else below the selector.
  assert.equal(g.composition.length, g.callCount)
  for (const c of g.composition) assert.ok(Array.isArray(c.tools), `call #${c.id} has no tool rows`)

  // The opening call has run no tools yet — an empty state, not a missing field.
  assert.deepEqual(g.composition[0].tools, [])

  // Tokens come from that call's own tool_result category, so they grow with the window.
  const early = g.composition[4]
  const last = g.composition[g.composition.length - 1]
  const tok = (rows, tool) => rows.find((r) => r.tool === tool)?.tokens ?? 0
  assert.ok(tok(early.tools, "bash") > 0, "no bash cost recorded at call 5")
  assert.ok(
    tok(last.tools, "bash") > tok(early.tools, "bash"),
    "tool cost should grow as results accumulate",
  )
  // Call counts only include executions that had happened by then.
  const calls = (rows, tool) => rows.find((r) => r.tool === tool)?.calls ?? 0
  assert.ok(calls(early.tools, "bash") < calls(last.tools, "bash"))
})

test("the report scopes every section below the selector, on one fixed scale", () => {
  const html = renderHtml(readTrace(GROWTH_FIXTURE), { db: {}, file: GROWTH_FIXTURE })

  // select() must drive all four scoped sections, not just the meter and the detail.
  for (const fn of ["renderMeter", "renderDeltas", "renderComposition", "renderTools", "renderDetail"])
    assert.match(html, new RegExp(`${fn}\\(`), `select() does not call ${fn}`)

  // Each scoped renderer filters to calls up to the selection.
  assert.match(html, /G\.steps\.filter\(s=>s\.id<=upto\)/, "deltas are not truncated")
  assert.match(html, /G\.composition\.filter\(c=>c\.id<=upto\)/, "composition is not truncated")
  assert.match(html, /G\.composition\.find\(c=>c\.id===upto\)/, "tool cost is not scoped")

  // The maxima are computed ONCE, outside the render functions. If they were recomputed per
  // slice, identical data would appear to change magnitude as the selection moves — the
  // property verified in a browser (a bar stayed at 18.5877% across every selection).
  assert.match(html, /const DMAX = Math\.max\(1, \.\.\.G\.steps/, "delta scale is not session-wide")
  assert.match(html, /const CMAX = Math\.max\(1, \.\.\.G\.composition/, "composition scale is not session-wide")
  assert.doesNotMatch(html, /function renderDeltas\(upto\)\{[\s\S]*?const DMAX/, "DMAX recomputed per slice")
  assert.doesNotMatch(html, /function renderComposition\(upto\)\{[\s\S]*?const CMAX/, "CMAX recomputed per slice")

  // Empty states rather than blank tables.
  assert.match(html, /this is the opening prompt — nothing added yet/)
  assert.match(html, /no tool calls yet at this point/)
})
