/** Aggregations shared by `octx stats`, `octx ls` and the HTML report. */
import { attribute, summarize } from "./tokens.mjs"
import { CATEGORY_LABEL, groupCategories } from "./categorize.mjs"

/**
 * Per-call context growth: what each LLM call added, and what the window was made of.
 *
 * The additions are found by comparing segment keys against the previous request, NOT by
 * looking at which segments carry a `derived` tier — a carried segment keeps the tier it was
 * first given, so tier-based filtering yields everything ever added rather than what this
 * call added. Getting that wrong makes every row cumulative.
 *
 * Deltas are measured (provider arithmetic), so they are exact wherever both requests
 * reported usage. A request still in flight has no usage yet and is marked accordingly
 * rather than being silently treated as a drop.
 */
export function growth(trace) {
  const entries = attribute(trace)
  const steps = []

  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]
    const cur = entries[i]

    let n = 0
    while (n < prev.segments.length && n < cur.segments.length && prev.segments[n].key === cur.segments[n].key) n++
    const prefixIntact = n === prev.segments.length
    const added = cur.segments.slice(n)
    const dropped = prev.segments.slice(n)

    const measured = cur.measured && prev.measured
    const drivers = new Map()
    for (const seg of added) {
      const key = `${seg.kind}:${seg.label}`
      const d = drivers.get(key) ?? { label: seg.label, kind: seg.kind, tokens: 0, count: 0 }
      d.tokens += seg.tokens
      d.count += 1
      drivers.set(key, d)
    }

    steps.push({
      id: cur.req.id,
      total: cur.total,
      delta: measured ? cur.total - prev.total : null,
      measured,
      inFlight: !cur.measured,
      // A broken prefix means opencode pruned or compacted: the delta is real but cannot be
      // attributed to what was appended, because things were also removed.
      reset: !prefixIntact,
      droppedCount: dropped.length,
      drivers: [...drivers.values()].sort((a, b) => b.tokens - a.tokens),
    })
  }

  const summaries = entries.map(summarize)
  const measuredSteps = steps.filter((s) => s.measured && !s.reset)
  const addedTotal = measuredSteps.reduce((a, s) => a + Math.max(0, s.delta), 0)

  /**
   * Tool cost as of one call, so the report's tool table can be scoped by the call selector
   * along with everything else below it.
   *
   * The token figure is the call's OWN tool_result category — the tokens those results are
   * still occupying in that window — not a running sum of what every result ever cost. Call
   * counts and output bytes come from the tool executions that had happened by then, matched
   * on timestamp.
   */
  const toolsAt = summaries.map((summary, i) => {
    const cutoff = entries[i].req.ts
    const perTool = new Map()
    const results = summary.categories.find((c) => c.key === "tool_result")
    for (const item of results?.items ?? []) {
      perTool.set(item.label, { tool: item.label, tokens: item.tokens, calls: 0, bytes: 0 })
    }
    for (const exec of trace.tools) {
      if (cutoff && exec.ts && exec.ts > cutoff) continue
      const e = perTool.get(exec.tool) ?? { tool: exec.tool, tokens: 0, calls: 0, bytes: 0 }
      e.calls += 1
      e.bytes += exec.outputBytes ?? 0
      perTool.set(exec.tool, e)
    }
    return [...perTool.values()].sort((a, b) => b.tokens - a.tokens || b.calls - a.calls)
  })

  return {
    opening: entries.length ? { id: entries[0].req.id, total: entries[0].total } : null,
    steps,
    addedTotal,
    finalTotal: entries.length ? entries[entries.length - 1].total : 0,
    callCount: entries.length,
    limit: entries[0]?.req.limit?.context ?? null,
    composition: summaries.map((s, i) => ({
      id: s.req.id,
      total: s.total,
      measured: s.measured,
      categories: s.categories.map((c) => ({ key: c.key, label: c.label, tokens: c.tokens })),
      bands: groupCategories(s.categories),
      tools: toolsAt[i],
    })),
    categoryLabel: CATEGORY_LABEL,
  }
}

export function sessionStats(trace) {
  const attributed = attribute(trace)
  const summaries = attributed.map(summarize)

  const cache = { prompt: 0, read: 0, write: 0 }
  let outputTokens = 0
  let reasoningTokens = 0
  for (const req of trace.requests) {
    const u = req.res?.usage
    if (!u) continue
    if (req.agent === "title") continue
    cache.prompt += u.input ?? 0
    cache.read += u.cache_read ?? 0
    cache.write += u.cache_write ?? 0
    outputTokens += u.output ?? 0
    reasoningTokens += u.reasoning ?? 0
  }

  // Cost per tool, taken from the last request that contains each result so we count the
  // tokens a tool actually left sitting in the context window, not once per resend.
  const perTool = new Map()
  const last = summaries[summaries.length - 1]
  for (const c of last?.categories ?? []) {
    if (c.key !== "tool_result") continue
    for (const item of c.items) {
      const e = perTool.get(item.label) ?? { tool: item.label, tokens: 0, calls: 0, bytes: 0 }
      e.tokens += item.tokens
      e.calls += item.count
      perTool.set(item.label, e)
    }
  }
  for (const t of trace.tools) {
    const e = perTool.get(t.tool) ?? { tool: t.tool, tokens: 0, calls: 0, bytes: 0 }
    e.bytes += t.outputBytes ?? 0
    if (!perTool.has(t.tool)) e.calls = 0
    perTool.set(t.tool, e)
  }

  return {
    session: trace.session,
    requests: trace.conversation.length,
    metaRequests: trace.requests.length - trace.conversation.length,
    toolCalls: trace.tools.length,
    outputTokens,
    // Reasoning billed as OUTPUT — distinct from reasoning occupying the prompt, which some
    // providers echo back and which shows up as its own context category.
    reasoningTokens,
    cache,
    tools: [...perTool.values()].sort((a, b) => b.tokens - a.tokens),
    growth: growth(trace),
    summaries,
  }
}
