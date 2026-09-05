/**
 * Labels the parts of a request the way the context view reports them.
 *
 * Every rule here was derived from captured wire data, not from opencode's source. The
 * anchors are checked against reality in test/octx.test.mjs; when opencode changes its
 * prompt assembly, that test fails rather than the view silently mislabelling things.
 */
import { BUILTIN_TOOLS } from "./format.mjs"

/**
 * opencode concatenates the whole system prompt into a single string. Observed structure:
 *
 *   <base opencode prompt>
 *   Here is some useful information about the environment you are running in:
 *   <env>…</env>
 *   <contents of AGENTS.md / CLAUDE.md>
 *   <available_skills>…</available_skills>
 *
 * Skills and the environment block are delimited, so they can be lifted out exactly. What
 * remains between the environment block and the skills block is the instruction files —
 * which is why memory files are identified positionally and then *confirmed* by content,
 * rather than by trying to locate the files on disk and string-match them.
 */
export function splitSystem(text) {
  if (typeof text !== "string" || !text) return [{ kind: "system", label: "System prompt", text: String(text ?? "") }]

  const out = []
  const skills = text.match(/<available_skills>[\s\S]*?<\/available_skills>\s*/)
  const env = text.match(/(?:Here is some useful information about the environment[^\n]*\n)?<env>[\s\S]*?<\/env>\s*/)

  const skillsStart = skills ? skills.index : text.length
  const envStart = env ? env.index : -1
  const envEnd = env ? env.index + env[0].length : -1

  if (envStart === -1) {
    // No environment block to anchor on: only the skills block can be separated safely.
    const head = text.slice(0, skillsStart)
    if (head.trim()) out.push({ kind: "system", label: "System prompt", text: head })
  } else {
    const base = text.slice(0, envStart)
    if (base.trim()) out.push({ kind: "system", label: "System prompt", text: base })
    out.push({ kind: "env", label: "Environment", text: env[0] })

    const middle = text.slice(envEnd, skillsStart)
    if (middle.trim()) out.push({ kind: "memory", label: "Memory files", text: middle })
  }

  if (skills) out.push({ kind: "skills", label: "Skills", text: skills[0] })

  const tail = text.slice(skills ? skillsStart + skills[0].length : skillsStart)
  if (tail.trim()) out.push({ kind: "system", label: "System prompt", text: tail })

  return out.length ? out : [{ kind: "system", label: "System prompt", text }]
}

/** Names of the memory files whose contents opencode inlines into the system prompt. */
export const MEMORY_FILENAMES = ["AGENTS.md", "CLAUDE.md"]

/** How many skills the `<available_skills>` block advertises. */
export function countSkills(text) {
  return typeof text === "string" ? (text.match(/<name>/g) ?? []).length : 0
}

/**
 * opencode exposes MCP tools as `<server>_<tool>` on the wire (confirmed: an MCP server
 * registered as `octxfix` yields `octxfix_ping`, `octxfix_bloated_query`). Anything that is
 * not one of opencode's own tools is therefore an MCP tool.
 *
 * The server name is *inferred* from the prefix and only used for display grouping — tool
 * names contain underscores too (`bloated_query`, `apply_patch`), so the split point is not
 * unambiguous and nothing load-bearing depends on it.
 */
export function classifyTool(name) {
  if (BUILTIN_TOOLS.has(name)) return { kind: "tool_builtin", server: null }
  const underscore = name.indexOf("_")
  return { kind: "tool_mcp", server: underscore > 0 ? name.slice(0, underscore) : null }
}

export const CATEGORY_ORDER = [
  "system",
  "env",
  "memory",
  "skills",
  "tool_builtin",
  "tool_mcp",
  "user",
  "assistant",
  "reasoning",
  "tool_call",
  "tool_result",
  "message",
]

export const CATEGORY_LABEL = {
  system: "System prompt",
  env: "Environment",
  memory: "Memory files",
  skills: "Skills",
  tool_builtin: "Built-in tools",
  tool_mcp: "MCP tools",
  user: "User messages",
  assistant: "Assistant messages",
  reasoning: "Reasoning (thinking)",
  tool_call: "Tool calls",
  tool_result: "Tool results",
  message: "Other messages",
}

/**
 * How a growth driver reads in a chart row. A bare "bash" is ambiguous — the call and its
 * result are separate segments with very different sizes — so the kind is spelled out.
 */
export function driverLabel(driver) {
  switch (driver.kind) {
    case "tool_result":
      return `${driver.label} result`
    case "tool_call":
      return `${driver.label} call`
    case "assistant":
      return "assistant text"
    case "reasoning":
      return "reasoning"
    case "user":
      return "user message"
    case "tool_builtin":
    case "tool_mcp":
      return `${driver.label} schema`
    default:
      return driver.label
  }
}

/**
 * The colour-carrying charts group the eleven categories into five bands.
 *
 * Two reasons, both from running the palette validator rather than eyeballing it. Eleven
 * hues cannot clear the CVD and normal-vision separation floors — the hand-picked set had
 * "Tool calls" and "Assistant messages" at ΔE 6.6 for *normal* vision, i.e. indistinguishable
 * to everyone, and they are two of the largest bands. And past roughly seven classes the
 * right form is a table, not more colours. The detail table keeps all eleven rows; the meter
 * and composition strip carry five.
 *
 * Tool results stay their own band rather than merging with tool calls: "what your tools
 * dumped into the window" is the number the whole report exists to surface.
 */
/**
 * Band order is constrained by colour, not just by narrative.
 *
 * Messages and Reasoning sit together and are two steps of green. In dark mode the lightness
 * band is only 0.48-0.67 wide, so two greens that separate from each other by the required
 * ΔE 15 are necessarily saturated — and a saturated green beside an orange is the classic
 * red-green confusion (ΔE 3.5 for deuteranopes when they were adjacent). So Tool schemas,
 * the orange band, is placed away from the greens rather than in narrative position.
 *
 * Both fixed-overhead bands still lead, then the conversation, then tool traffic. Searched
 * over every ordering that keeps Messages and Reasoning adjacent and validated in both modes:
 * worst adjacent CVD ΔE 16.3 light / 9.1 dark, normal-vision 19.6 / 15.6.
 *
 * Reasoning is its own band rather than part of Messages because where a provider echoes it
 * back into the prompt it is routinely the largest thing in the window, and it is the one
 * category you can drop without losing anything the model wrote for you.
 */
export const CATEGORY_GROUPS = [
  { key: "schemas", label: "Tool schemas", members: ["tool_builtin", "tool_mcp"] },
  { key: "overhead", label: "System & instructions", members: ["system", "env", "memory", "skills"] },
  { key: "messages", label: "Messages", members: ["user", "assistant", "message"] },
  { key: "reasoning", label: "Reasoning", members: ["reasoning"] },
  { key: "calls", label: "Tool calls", members: ["tool_call"] },
  { key: "results", label: "Tool results", members: ["tool_result"] },
]

const GROUP_OF = new Map()
for (const g of CATEGORY_GROUPS) for (const m of g.members) GROUP_OF.set(m, g.key)

export function groupOf(categoryKey) {
  return GROUP_OF.get(categoryKey) ?? "messages"
}

/** Rolls a request's categories up into the five bands, preserving CATEGORY_GROUPS order. */
export function groupCategories(categories) {
  const totals = new Map()
  for (const c of categories) {
    const key = groupOf(c.key)
    totals.set(key, (totals.get(key) ?? 0) + c.tokens)
  }
  return CATEGORY_GROUPS.filter((g) => totals.get(g.key) > 0).map((g) => ({
    key: g.key,
    label: g.label,
    tokens: totals.get(g.key),
  }))
}

/** Categories worth breaking down into their individual contributors in the report. */
export const EXPANDABLE = new Set(["tool_mcp", "tool_builtin", "tool_result"])
