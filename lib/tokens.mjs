/**
 * Token attribution.
 *
 * Three tiers, best available per segment:
 *
 *   1. MEASURED  — the provider's own `usage.input` for a request. The meter total and free
 *                  space are never estimates.
 *   2. DERIVED   — consecutive requests share a byte-stable prefix, so the difference between
 *                  their `usage.input` values is exactly the cost of what was appended. This
 *                  is what makes per-tool-result numbers trustworthy.
 *   3. ESTIMATED — a byte-class heuristic, always rescaled so the segments of a request sum
 *                  to that request's measured total. Used for the opening lump (system +
 *                  tool schemas + first message), which no differencing can pull apart.
 *
 * Every number carries which tier produced it, so a guess is never rendered as a measurement.
 */
import { classifyMessages } from "./read.mjs"
import { splitSystem, classifyTool, CATEGORY_ORDER, CATEGORY_LABEL } from "./categorize.mjs"

/**
 * Dependency-free token estimate.
 *
 * Absolute accuracy barely matters — every result is rescaled against a measured total — so
 * what this needs to get right is the *relative* weight of prose against JSON. The constants
 * are BPE-motivated rather than fitted: a BPE vocabulary merges English into roughly
 * four-character pieces, digits into shorter ones, and punctuation runs (`":`, `",`, `}]`)
 * into pairs. Fitting them to the traces on hand produced a better aggregate and a worse
 * model — the samples share ~90% of their bytes, so the fit collapsed onto one corpus and
 * pushed word length to an implausible 7 chars/token. Deliberately not doing that.
 *
 * Known bias: these weights run high in aggregate against DeepSeek's tokenizer. Calibration
 * divides it out. `test/tokens.test.mjs` reports the standing error so drift stays visible.
 */
export const WEIGHTS = { wordChars: 4, digitChars: 3, punctChars: 2, newline: 0.5 }

export function estimateTokens(input) {
  const str = typeof input === "string" ? input : JSON.stringify(input) ?? ""
  if (!str) return 0
  const parts = str.match(/[A-Za-z]+|[0-9]+|\s+|[^\sA-Za-z0-9]+/g)
  if (!parts) return 1
  let t = 0
  for (const p of parts) {
    const c = p[0]
    if (/[A-Za-z]/.test(c)) t += Math.max(1, Math.ceil(p.length / WEIGHTS.wordChars))
    else if (c >= "0" && c <= "9") t += Math.max(1, Math.ceil(p.length / WEIGHTS.digitChars))
    else if (/\s/.test(p)) t += (p.match(/\n/g)?.length ?? 0) * WEIGHTS.newline
    else t += Math.max(1, Math.ceil(p.length / WEIGHTS.punctChars))
  }
  return Math.max(1, Math.round(t))
}

/** The ordered segment list of a request: system sections, tool schemas, then messages. */
export function segmentsOf(trace, req) {
  const segs = []
  for (const h of req.system ?? []) {
    const text = trace.data(h)
    if (text === undefined) {
      // Truncated blob: keep it as one opaque segment rather than inventing sections.
      segs.push({ key: `sys:${h}`, kind: "system", label: "System prompt", h, bytes: trace.bytes(h), text })
      continue
    }
    // opencode ships the whole system prompt as one string; split it so memory files and
    // skills are reported separately rather than hidden inside "system prompt".
    let offset = 0
    for (const part of splitSystem(text)) {
      segs.push({
        key: `sys:${h}:${offset++}`,
        kind: part.kind,
        label: part.label,
        h,
        bytes: part.text.length,
        text: part.text,
      })
    }
  }
  for (const t of req.tools ?? []) {
    const { kind, server } = classifyTool(t.name)
    segs.push({
      key: `tool:${t.h}`,
      kind,
      label: t.name,
      server,
      h: t.h,
      bytes: trace.bytes(t.h),
      text: trace.data(t.h),
    })
  }
  let i = 0
  for (const m of classifyMessages(trace, req)) {
    // m.text is this part's own text. Falling back to the whole message would count a split
    // message's text once per part and inflate every one of them.
    segs.push({
      key: `msg:${i++}:${m.h}`,
      kind: m.kind,
      label: m.label,
      h: m.h,
      bytes: m.size,
      text: m.text !== undefined ? m.text : trace.data(m.h),
    })
  }
  return segs
}

function estimateOf(seg) {
  if (seg.text !== undefined) return estimateTokens(seg.text)
  // Truncated blob: fall back to its recorded byte length.
  return Math.max(1, Math.round(seg.bytes / 3.6))
}

/** Distributes `total` across `segs` in proportion to their estimates. */
function scaleToTotal(segs, total, tier) {
  const ests = segs.map(estimateOf)
  const sum = ests.reduce((a, b) => a + b, 0)
  if (sum <= 0 || total == null) {
    return segs.map((s, i) => ({ ...s, tokens: ests[i], tier: "estimated" }))
  }
  const factor = total / sum
  const out = segs.map((s, i) => ({ ...s, tokens: Math.round(ests[i] * factor), tier }))
  // Push the rounding remainder onto the largest segment so the sum is exactly `total`.
  const diff = total - out.reduce((a, s) => a + s.tokens, 0)
  if (diff !== 0 && out.length) {
    let big = 0
    for (let i = 1; i < out.length; i++) if (out[i].tokens > out[big].tokens) big = i
    out[big].tokens += diff
  }
  return out
}

function sharedPrefix(prev, next) {
  let n = 0
  while (n < prev.length && n < next.length && prev[n].key === next[n].key) n++
  return n
}

/**
 * Attributes tokens to every segment of every conversation request, carrying exact values
 * forward across requests wherever the prefix is stable.
 *
 * Returns one entry per request: { req, total, measured, segments: [{…, tokens, tier}] }.
 */
export function attribute(trace) {
  const out = []
  let prev // { segs (attributed), total }

  for (const req of trace.conversation) {
    const segs = segmentsOf(trace, req)
    const total = req.res?.usage?.input ?? null

    if (prev && total != null && prev.total != null) {
      const n = sharedPrefix(prev.segs, segs)
      const carried = prev.segs.slice(0, n).map((s) => ({ ...s, tier: s.tier === "estimated" ? "estimated" : s.tier }))
      const carriedTokens = carried.reduce((a, s) => a + s.tokens, 0)
      const fresh = segs.slice(n)
      const delta = total - carriedTokens

      // Only trust differencing when the prefix really is the whole of the previous request
      // and the delta is sane. Pruning, compaction or a tool-set change breaks the assumption.
      if (n > 0 && n === prev.segs.length && delta >= 0 && fresh.length) {
        const attributed = scaleToTotal(fresh, delta, fresh.length === 1 ? "derived" : "derived-split")
        out.push({ req, total, measured: true, segments: [...carried, ...attributed] })
        prev = { segs: [...carried, ...attributed], total }
        continue
      }
    }

    // No usable predecessor: calibrate the whole request against its measured total.
    const attributed = scaleToTotal(segs, total, total == null ? "estimated" : "calibrated")
    out.push({ req, total: total ?? attributed.reduce((a, s) => a + s.tokens, 0), measured: total != null, segments: attributed })
    prev = { segs: attributed, total }
  }
  return out
}

/** Rolls one attributed request up into the categories the context meter displays. */
export function summarize(entry) {
  const cats = new Map()
  for (const s of entry.segments) {
    const key = CATEGORY_ORDER.includes(s.kind) ? s.kind : "message"
    let c = cats.get(key)
    if (!c) {
      c = { key, label: CATEGORY_LABEL[key], tokens: 0, bytes: 0, items: new Map(), tiers: new Set() }
      cats.set(key, c)
    }
    c.tokens += s.tokens
    c.bytes += s.bytes
    c.tiers.add(s.tier)
    const item = c.items.get(s.label) ?? { label: s.label, tokens: 0, count: 0 }
    item.tokens += s.tokens
    item.count += 1
    c.items.set(s.label, item)
  }
  const categories = CATEGORY_ORDER.filter((k) => cats.has(k)).map((k) => {
    const c = cats.get(k)
    return {
      ...c,
      items: [...c.items.values()].sort((a, b) => b.tokens - a.tokens),
      tier: c.tiers.has("estimated") || c.tiers.has("calibrated")
        ? "estimated"
        : c.tiers.has("derived-split")
          ? "derived-split"
          : "derived",
    }
  })
  return {
    req: entry.req,
    total: entry.total,
    measured: entry.measured,
    limit: entry.req.limit?.context ?? null,
    categories,
  }
}
