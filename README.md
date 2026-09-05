# octx

This project is a context visualizer for OpenCode. I built it with AI assistance to help me view the harness-AI interplay in details - and as it often happens with Claude Code I couldn’t stop once I started. The result is the tool that one can use to see details on your AI session - aggregate stats better then Claude Code /context  command, and view details of every call. Enjoy understanding your AI interaction!  

## Example

**[See a full example report →](https://dzimine.github.io/octx/)**

An 11-call session with a reasoning model: the context window broken down by category, what
each call added and why, how the window filled up, and the exact payload of every request.

The example is generated from an actual session and then scrubbed with
[`tools/scrub-trace.mjs`](tools/scrub-trace.mjs) — every prompt, tool result, file path,
identifier and system prompt is replaced with synthetic text of the same length, so the shape
and the proportions are real while none of the content is. Use that script on your own traces
before sharing one: a raw trace contains your prompts, the contents of every file your tools
read, and your AGENTS.md.

## Design 
Two pieces:

- **`plugin/octx.ts`** — an opencode server plugin that records the real provider traffic.
- **`cli/octx.mjs`** — a dependency-free Node CLI that reads those traces. It never contacts a
  model, so no command costs tokens.

**Why not opencode's own data?** OpenCode already stores sessions in `~/.local/share/opencode/opencode.db`, 
`opencode stats`and `opencode export` read them. 
But that is opencode's *internal* representation. It does not
contain the system prompt, the tool definitions, MCP tool schemas, cache breakpoints, model
params, or the effect of pruning and compaction — which is precisely what a context breakdown
is made of. octx captures the outbound HTTP body instead, so what you see is what the model saw.

## Install

```sh
tools/install.sh                          # symlink the plugin, seed a disabled config
ln -sfn "$PWD/cli/octx.mjs" ~/.local/bin/octx
```

Then enable it by editing `~/.config/opencode/octx.json`:

```json
{ "level": "full", "dir": "~/.local/share/octx", "maxBlobBytes": 262144, "redactHeaders": true, "retainDays": 30 }
```

| level   | what is recorded |
|---------|------------------|
| `off`   | nothing (default) |
| `basic` | requests, responses, usage, tool calls — blob-deduped, bodies over `maxBlobBytes` truncated |
| `full`  | the above plus untruncated bodies and the literal request/response payloads |
| `debug` | the above plus opencode's raw event stream |

The config is re-read whenever its mtime changes, so **flipping `level` takes effect on the next
LLM call — no opencode restart**. With `level: "off"` the cost is one cached `stat` and one
boolean per outbound fetch: no body inspection, no hook work, no disk writes.

A project can override the global setting with `<project>/.opencode/octx.json`.

### Enabling for one run

```sh
OCTX=full opencode          # capture this session only, whatever the config file says
OCTX=basic opencode
OCTX=off opencode           # force off for one run
OCTX_DIR=/tmp/t OCTX=full opencode

export OCTX=basic           # or set it for the whole terminal, then run opencode
```

**`OCTX=basic` on its own line does not work.** A bare assignment sets a *shell* variable,
which child processes do not inherit — `opencode` never sees it. Use the prefix form above,
or `export`. `octx doctor` detects this case and says so.

`OCTX` beats both config files. It also accepts `1`/`on`/`true` (meaning `full`) and
`0`/`off`/`false`. An unrecognised value is **ignored** rather than guessed at, so a typo
falls back to the config file instead of silently enabling `debug`.

Because an env var cannot change mid-process, setting `OCTX` fixes the level for that run —
the live config-file toggle no longer applies to it. Leave `OCTX` unset if you want to flip
tracing on and off inside a long-lived TUI session.

Precedence: `OCTX` › `<project>/.opencode/octx.json` › `~/.config/opencode/octx.json` › off.

## Use

```
octx ls                            sessions with traces
octx context [<session>] [--at N]  context window breakdown (default: newest, last call)
octx show <session> [--req N]      the exact messages sent, per request
octx stats [<session>]             tool cost, cache hit rate, context growth
octx report [<session>] [--open]   self-contained HTML report
octx tail [<session>]              follow a live session
```

`<session>` may be any unambiguous fragment of a session id; omit it for the most recent.
Add `--json` to any read command for machine-readable output.

### What the call selector scopes

In the HTML report the call selector sits between the KPI tiles and everything else, and that
split is the rule:

| | Scope |
|---|---|
| KPI tiles (LLM calls, tool calls, cache hits, reasoning, cost) | the whole session, always |
| Context window · What each call added · Composition · Tool cost · What was sent | **as of the selected call** |

Selecting an earlier call shows the session as it stood then: later calls are hidden and every
figure below the selector agrees with that slice. The default selection is the last call, so
the default view is the whole session.

Bar scales are computed once across the whole session and do **not** change with the selection —
truncating removes rows, it never resizes the surviving bars. Rescaling per slice would make
identical data appear to change magnitude while browsing.

`octx stats` in the terminal has no interactive selector and stays session-wide; `octx context
--at N` is the terminal equivalent of picking a call.

```
  deepseek-v4-flash · Check ping result and report
  ████████░░░░░░░░░░░░░░░░░░░░  9.6k/1.0M (1.0%)

  System prompt               2.0k ±   20.6%
  Environment                   76 ±    0.8%
  Memory files                 623 ±    6.5%
  Skills                       269 ±    2.8%
  Built-in tools              5.2k ±   54.3%
    └ bash                      1.3k
    └ task                       921
  MCP tools                   1.4k ±   14.1%
    └ octxfix_bloated_query     1.2k
    └ octxfix_echo               114
  Tool calls                    50 ~    0.5%
  Tool results                  17 ~    0.2%
  Free space                  990k       99.0%
```

## Categories, and where they come from

opencode ships the entire system prompt as a **single string**, so the sections have to be
recovered from it. `lib/categorize.mjs` does that with anchors found in captured wire data:

| category | how it is identified |
|---|---|
| System prompt | everything before the environment preamble |
| Environment | the `<env>…</env>` block and its preamble line |
| Memory files | what sits between `</env>` and the skills block — the inlined AGENTS.md / CLAUDE.md |
| Skills | the `<available_skills>…</available_skills>` block |
| Built-in tools | tool names in `BUILTIN_TOOLS` (`lib/format.mjs`) |
| MCP tools | every other tool: opencode exposes them as `<server>_<tool>` |

Memory files are located positionally and then *confirmed* by content, which is what the
test asserts. If opencode changes its prompt assembly the test fails rather than the view
silently mislabelling a section, and `splitSystem` falls back to one undifferentiated
"System prompt" segment when no anchor matches.

The MCP server name is inferred from the prefix before the first underscore, and used only
for display grouping — tool names contain underscores too (`bloated_query`, `apply_patch`),
so the split point is not unambiguous and nothing load-bearing depends on it.

## How tokens are attributed

Three tiers, best available per segment. Every number carries which tier produced it, so a
guess is never rendered as a measurement.

| mark | tier | meaning |
|---|---|---|
| | **measured** | the provider's own `usage.input`. Totals and free space are never estimates. |
| `~` | **derived** | consecutive requests share a byte-stable prefix, so the difference between their `usage.input` values is the exact cost of what was appended. `~` means that exact delta was split across more than one new segment. This is what drives the "what each call added" chart. |
| `±` | **estimated** | a byte-class heuristic, rescaled so a request's segments sum exactly to its measured total. Used for the opening lump — system prompt, tool schemas, first message — which no differencing can pull apart. |

The estimator's constants are BPE-motivated, not fitted: fitting them to the traces on hand
produced a better aggregate and a worse model, because the samples share ~90% of their bytes.
It runs about 30% high in aggregate against DeepSeek's tokenizer; calibration divides that out.
`test/octx.test.mjs` prints the standing bias on every run so drift stays visible.

## The growth charts

**What each call added** is the one chart in the report that is not an estimate: each row is
`usage.input(N) − usage.input(N−1)`, straight from the provider's token counts, labelled with
the segments that appeared between the two calls.

```
  #5     +741  ▄▄▄▄▄                   bash ×2 call, bash result
  #6    +3.2k  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  bash result, bash call
  #7      +667  ▄▄▄▄▄                  bash ×2 call, bash result
  #13  in flight — no usage reported yet

  opening prompt 4.5k · added since 28k · now 41k
```

Three cases it handles rather than papering over:

- **A call still in flight** has no usage yet. It is marked, not silently counted as zero or
  as a drop.
- **A broken prefix** — opencode pruned or compacted, so segments were removed as well as
  added — makes the delta real but unattributable. The row says `pruned` and names how many
  segments went, instead of blaming the wrong tool.
- **A short session** shows what it has and says so, rather than drawing a chart from two
  points that looks like a trend.

The additions for a call are found by comparing segment keys against the previous request.
Filtering by the `derived` tier instead looks equivalent and is not: a carried segment keeps
the tier it was first given, so every row ends up cumulative. `test/octx.test.mjs` asserts
that drivers sum exactly to the measured delta, which pins this down.

**Composition** stacks each call's categories, so you can watch tool results take over the
window while the system prompt and schemas stay flat. Those per-category values are the
rescaled estimates, so the strip shows proportion rather than exact numbers.

### Reasoning

Reasoning models produce two separate token costs, and octx reports them separately because
they behave differently:

| | What it is | Where it shows |
|---|---|---|
| **Billed output** | tokens the model spent thinking on a call | the `Reasoning` KPI tile; `usage.reasoning` per call |
| **Prompt occupancy** | reasoning echoed *back* into the context on later calls | the `Reasoning (thinking)` context category |

Whether the second one exists at all is provider-dependent — many drop reasoning from the
next request. DeepSeek does not: it returns `reasoning_content` on every assistant message,
so it accumulates. On the captured fixture that was **39.7% of the context window, the
single largest category**, against 0 bytes of visible assistant text.

Before this was split out it was not merely lumped in with assistant text — it was counted
as **Tool calls**, because the tool-call segment was sized as "whatever is left of the
message after the visible content". Anthropic `thinking` and `redacted_thinking` blocks are
classified the same way.

### Colour

Anything that carries colour — the meter and the composition strip — shows **five** bands,
not the eleven categories: System & instructions, Tool schemas, Messages, Tool calls, Tool
results. The detail table keeps all eleven, because past roughly seven classes the right
form is a table rather than more hues.

Messages and Reasoning sit next to each other as two steps of green, so the conversation and
the model's scratch work read as related. That constraint drove the rest of the order: in
dark mode the lightness band is only 0.48–0.77 wide, so two greens far enough apart to clear
the ΔE 15 normal-vision floor are necessarily saturated — and a saturated green beside an
orange is the classic red-green confusion (ΔE 3.5 for deuteranopes). Tool schemas, the orange
band, is therefore placed away from the greens rather than in narrative position. The order
was found by searching every arrangement that keeps Messages and Reasoning adjacent and
validating each in both modes: worst adjacent CVD ΔE 16.3 light / 9.1 dark, worst
normal-vision ΔE 19.6 / 15.6.

The greens differ between modes — the light pair cannot clear the floor inside the narrower
dark band, so both are re-stepped rather than flipped. The light mode's sub-3:1 contrast is
relieved by the always-present legend and the detail table.

This replaced a hand-picked eleven-hue set that failed on measurement, not taste: "Tool
calls" `#c96f2b` and "Assistant messages" `#c98a2b` were ΔE **6.6 for normal vision** — two
of the largest bands in the chart, indistinguishable to everyone, colour vision or not. Two
other hues fell below the chroma floor and read as grey. **Do not re-pick these by eye**; a
test asserts the validated values are present and the failed ones have not come back.

## Trace format

`<dir>/<YYYY-MM-DD>/<sessionID>.ndjson`, append-only, one JSON object per line. This is the
contract between the plugin and `lib/`; `lib/format.mjs` holds `FORMAT_VERSION`.

| `t` | fields |
|---|---|
| `hdr` | `v`, `octx`, `ts`, `session`, `directory`, `worktree`, `project` — first line |
| `blob` | `h`, `kind`, `bytes`, `data` — or `trunc: true` + `preview` when over `maxBlobBytes` |
| `req` | `id`, `ts`, `url`, `shape`, `agent`, `messageID`, `model`, `provider`, `limit`, `params`, `system: [h]`, `tools: [{name, h}]`, `messages: [h]`, `raw` |
| `res` | `req`, `ts`, `status`, `usage`, `stop`, `calls`, `text`, `reasoning` |
| `tool` | `ts`, `callID`, `tool`, `ms`, `title`, `args`, `output`, `outputBytes`, `metadata` |
| `compacting` | `ts` — session compaction started |
| `evt` | `type`, `data` — `debug` level only |
| `err` | `where`, `error` |

**Blobs are content-addressed and written once per session.** A 50-turn session re-sends the
same system prompt and tool schemas 50 times; storing them once is what keeps a trace O(n)
instead of O(n²). Blob lines always precede the first record that references them.

`shape` is the provider dialect the request was normalized from: `openai-chat`, `anthropic`,
`openai-responses`, or `unknown`.

## How capture works, and two rules that matter

The plugin patches `globalThis.fetch` in the opencode server process and inspects outbound
provider calls. Two constraints were learned by breaking things:

1. **Never reconstruct the outbound request.** `new Request(input, init)` drops non-standard
   init options and can consume a stream body. Doing so hung `opencode run` at init, because
   opencode talks to its own embedded server over fetch. The wrapper inspects only bodies that
   are already plain strings — what the AI SDK sends — and forwards the original `input, init`
   untouched.
2. **The correlation header carries only an opaque random id.** `chat.headers` injects
   `x-octx-id`, and the id maps to session/agent/model in process memory. Putting session data
   in the header would ship it to the provider, and deleting the header afterwards would break
   SigV4-signed providers, since `chat.headers` runs before the provider signs.

Hooks supply what the wire doesn't carry: `tool.execute.before`/`after` for tool timings and
opencode's rendered output, and `experimental.session.compacting` for compaction boundaries.
`experimental.chat.messages.transform` is deliberately **not** used — it fired for some LLM
calls and not others in the same run.

### Known limits

- A response clone may never resolve when opencode abandons a stream early (observed for the
  title-generator agent), so a `req` with no matching `res` is expected and tolerated.
- opencode's own title-generation call is captured but tagged `agent: "title"` and excluded
  from conversation stats.
- Only `globalThis.fetch` traffic is seen. A provider using a different transport is invisible.

## Test

```sh
node --test "test/*.test.mjs"     # round-trip, attribution, calibration, renderers
tools/capture-fixture.sh          # regenerate test/fixtures/session.ndjson from a live run
```

`capture-fixture.sh` temporarily registers `tools/mcp-fixture-server.mjs` — a throwaway stdio
MCP server with three deliberately different-sized tool schemas — so the fixture always
contains real MCP tools for the built-in/MCP split to be verified against. It removes the
registration afterwards.

`tools/probe.ts` is a standalone opencode plugin that dumps hook order, header propagation
and raw provider bodies. Use it to re-verify the capture assumptions when opencode updates.

## Privacy

Traces contain your full prompts, file contents read by tools, and command output. They live
under `dir` in plaintext. Auth headers are never recorded, and `shell.env` is never logged.

**Before sharing a trace or a report, scrub it:**

```sh
node tools/scrub-trace.mjs <trace.ndjson> clean.ndjson --title "Example session"
octx report --dir <dir containing clean.ndjson> -o report.html
```

The scrubber works on the structured NDJSON rather than the rendered HTML, so every string is
reached through the schema instead of by pattern-matching prose. It replaces content with
filler of the same length — shape and proportions survive, content does not — and rewrites
paths, e-mail addresses, IP addresses and every session/message/tool identifier. Note that a
system prompt is rebuilt rather than edited, because on opencode it inlines your AGENTS.md.

## Credits and prior art

**[ljw1004/opencode-trace](https://github.com/ljw1004/opencode-trace)** — the reason the
capture side works at all. It established that patching `globalThis.fetch` inside an opencode
server plugin is the way to see real provider traffic, that a correlation header links a
request back to its session, and that successive request bodies have to be de-duplicated or a
trace grows O(n²). octx reaches the same conclusions by different means — content-addressed
blobs instead of delta encoding, an opaque correlation id instead of the session id — but the
approach came from reading that project first.

**[IgorWarzocha/Opencode-Context-Analysis-Plugin](https://github.com/IgorWarzocha/Opencode-Context-Analysis-Plugin)**
— showed that a `/context`-style breakdown was something people want from opencode. It takes
the opposite approach, asking the model to analyse opencode's stored messages, which costs
tokens per invocation and works from opencode's internal representation rather than the wire.
Seeing that trade-off is what pushed octx to capture the outbound HTTP body and do all
analysis offline.

**Claude Code's `/context`** — the format this borrows: a context window split into named
categories with a share of the total. octx adds what the wire makes possible — measured
per-call deltas, built-in vs MCP tool schemas, and reasoning separated from assistant text.

**opencode** — for a plugin API with the right hooks (`chat.headers` for correlation,
`tool.execute.*` for timings) and for storing enough in its own SQLite database that the
reader can enrich a trace with a title and cost.

Chart colour, palette validation and the "is it even a chart" call follow Anthropic's
data-visualisation guidance; the palette is checked with its validator rather than by eye,
which is how the report's original hues were found to be indistinguishable.
