/**
 * Self-contained HTML report. One file, no CDN, no external assets: the trace model is
 * embedded as JSON and rendered by a small inline script, so the report keeps working when
 * mailed to someone or opened years later.
 *
 * Works from the same model as the terminal renderer, so the two never disagree.
 */
import { attribute, summarize } from "./tokens.mjs"
import { sessionStats, growth } from "./stats.mjs"
import { driverLabel, groupCategories } from "./categorize.mjs"

const MAX_EMBED = 40000 // per string; keeps a `full`-level trace from ballooning the report

function clip(value) {
  if (value === undefined) return { text: null, truncated: true }
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  if (s.length <= MAX_EMBED) return { text: s, truncated: false }
  return { text: s.slice(0, MAX_EMBED), truncated: true, full: s.length }
}

function buildModel(trace, meta) {
  const summaries = attribute(trace).map(summarize)
  const stats = sessionStats(trace)

  const requests = trace.conversation.map((req, i) => {
    const summary = summaries[i]
    return {
      id: req.id,
      ts: req.ts,
      agent: req.agent,
      model: req.model,
      shape: req.shape,
      url: req.url,
      params: req.params,
      limit: req.limit?.context ?? null,
      total: summary?.total ?? null,
      measured: summary?.measured ?? false,
      categories: (summary?.categories ?? []).map((c) => ({
        key: c.key,
        label: c.label,
        tokens: c.tokens,
        tier: c.tier,
        items: c.items,
      })),
      // Five validated bands for anything that carries colour.
      bands: groupCategories(summary?.categories ?? []),
      system: (req.system ?? []).map((h) => ({ bytes: trace.bytes(h), ...clip(trace.data(h)) })),
      tools: (req.tools ?? []).map((t) => ({ name: t.name, bytes: trace.bytes(t.h), ...clip(trace.data(t.h)) })),
      messages: (req.messages ?? []).map((h) => {
        const m = trace.data(h)
        return { role: m?.role ?? "?", bytes: trace.bytes(h), ...clip(m) }
      }),
      response: req.res
        ? {
            status: req.res.status,
            stop: req.res.stop,
            usage: req.res.usage,
            calls: req.res.calls ?? [],
            ...clip(trace.data(req.res.text)),
          }
        : null,
    }
  })

  return {
    session: trace.session,
    title: meta.db?.title ?? trace.header?.title ?? null,
    slug: meta.db?.slug ?? null,
    directory: trace.header?.directory ?? meta.db?.directory ?? null,
    opencode: meta.db?.version ?? null,
    cost: meta.db?.cost ?? null,
    file: meta.file,
    generated: new Date().toISOString(),
    requests,
    tools: stats.tools,
    growth: (() => {
      const g = growth(trace)
      return {
        ...g,
        steps: g.steps.map((st) => ({ ...st, drivers: st.drivers.map((d) => ({ ...d, text: driverLabel(d) })) })),
      }
    })(),
    cache: stats.cache,
    toolCalls: trace.tools.map((t) => ({
      tool: t.tool,
      title: t.title,
      ms: t.ms,
      bytes: t.outputBytes,
      args: clip(trace.data(t.args)),
      output: clip(trace.data(t.output)),
    })),
    counts: {
      requests: stats.requests,
      metaRequests: stats.metaRequests,
      toolCalls: stats.toolCalls,
      outputTokens: stats.outputTokens,
      reasoningTokens: stats.reasoningTokens,
    },
  }
}

const CSS = `
:root{color-scheme:light dark;
 --bg:#fbfaf8;--panel:#fff;--ink:#1a1917;--muted:#6b6862;--line:#e5e2dc;--accent:#3b6ea5;
 /* Six categorical slots, validated in both modes against the band order in
    categorize.mjs: worst adjacent CVD ΔE 16.3, normal-vision ΔE 19.6. Messages and Reasoning
    are two steps of green deliberately. The sub-3:1 contrast is relieved by the
    always-present legend labels and the detail table. Do not re-pick these by eye — the
    ordering and the hues were solved together. */
 --g-schemas:#eb6834;--g-overhead:#2a78d6;--g-messages:#1baf7a;--g-reasoning:#007000;
 --g-calls:#eda100;--g-results:#e87ba4;--free:#e0ddd6}
@media (prefers-color-scheme:dark){:root{
 --bg:#16151a;--panel:#1e1d24;--ink:#e8e6e3;--muted:#9a958d;--line:#33313a;--accent:#7fa8d8;
 /* Stepped for the dark surface — selected, not an automatic flip. The greens are re-stepped
    to the ends of the narrower dark lightness band so they still clear ΔE 15 (15.6). */
 --g-schemas:#d95926;--g-overhead:#3987e5;--g-messages:#1cb03c;--g-reasoning:#007c00;
 --g-calls:#c98500;--g-results:#d55181;--free:#2c2a33}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
 font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:20px;margin:0 0 2px;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
 margin:34px 0 12px;font-weight:600}
.sub{color:var(--muted);font-size:13px;margin-bottom:4px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}
.meter{display:flex;height:26px;border-radius:6px;overflow:hidden;background:var(--free);margin:14px 0 6px}
/* 2px surface gap between stacked fills so adjacent bands never bleed together. */
.meter div{transition:width .2s;box-shadow:2px 0 0 var(--panel)}
.meter div:last-child{box-shadow:none}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:20px 0 14px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 15px}
.k-label{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
 font-weight:600;margin-bottom:5px}
/* Proportional figures: tabular-nums makes a standalone value look loose at display size. */
.k-value{font-size:26px;font-weight:600;line-height:1.15;letter-spacing:-.02em}
.k-note{font-size:12px;color:var(--muted);margin-top:2px}
.scope{font-size:12px;color:var(--muted);margin:10px 0 4px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-bottom:18px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;
 letter-spacing:.06em;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr.sub td{color:var(--muted);font-size:12px}
tr.sub td:first-child{padding-left:26px}
tr[hidden]{display:none}
tr.parent{cursor:pointer}
tr.parent:hover td{background:color-mix(in srgb,var(--accent) 7%,transparent)}
.caret{display:inline-block;width:12px;color:var(--muted);font-size:10px;
 transition:transform .12s;transform-origin:45% 50%}
tr.parent[aria-expanded=true] .caret{transform:rotate(90deg)}
.count{font-size:10px;color:var(--muted);margin-left:6px}
.tag{font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:3px;
 padding:0 4px;margin-left:6px;vertical-align:1px}
.tabs{display:flex;gap:4px;margin:18px 0 0;flex-wrap:wrap}
.tabs button{background:none;border:1px solid var(--line);color:var(--muted);border-radius:6px;
 padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.tabs button[aria-selected=true]{background:var(--accent);border-color:var(--accent);color:#fff}
/* .sub sets its own colour, so it must be overridden explicitly on the selected tab or the
   token count renders muted-grey on the accent fill and disappears. */
.tabs button[aria-selected=true] .sub{color:#fff;opacity:.75}
.grow{width:100%;font-size:13px;border-collapse:collapse}
.grow td{padding:4px 8px;border:0;vertical-align:middle;white-space:nowrap}
.grow td.id{color:var(--muted);font-variant-numeric:tabular-nums;width:1%}
.grow td.amt{text-align:right;font-variant-numeric:tabular-nums;width:1%;font-weight:600}
.grow td.trk{width:44%}
.grow td.why{color:var(--muted);white-space:normal}
.trk span{display:block;height:11px;border-radius:3px;background:var(--accent);min-width:2px}
.trk span.neg{background:var(--c-tool_result)}
.comp{display:flex;height:13px;border-radius:3px;overflow:hidden;background:var(--free);min-width:2px}
.comp i{display:block;height:100%;box-shadow:2px 0 0 var(--panel)}
.comp i:last-child{box-shadow:none}
tr.cur td{background:color-mix(in srgb,var(--accent) 9%,transparent)}
.pill{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:1px 7px}
details{border:1px solid var(--line);border-radius:8px;margin-bottom:8px;background:var(--panel)}
summary{cursor:pointer;padding:9px 12px;font-size:13px;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";color:var(--muted);margin-right:8px;display:inline-block}
details[open]>summary::before{content:"▾"}
details .body{padding:0 12px 12px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px;
 overflow-x:auto;font-size:12px;line-height:1.5;max-height:420px;margin:6px 0}
.scroll{overflow-x:auto}
.warn{color:var(--muted);font-size:12px;font-style:italic}
`

const SCRIPT = String.raw`
const M = window.__OCTX__;
const COLORS = {overhead:'--g-overhead',schemas:'--g-schemas',messages:'--g-messages',
  calls:'--g-calls',results:'--g-results',reasoning:'--g-reasoning'};
const EXPANDABLE = new Set(['tool_mcp','tool_builtin','tool_result']);
const cssVar = k => getComputedStyle(document.documentElement).getPropertyValue(COLORS[k]||'--g-messages').trim();
const esc = s => String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const human = n => n==null?'-':n<1000?String(n):n<1e6?(n/1000).toFixed(n<1e4?1:0)+'k':(n/1e6).toFixed(1)+'M';
const bytes = n => n==null?'-':n<1024?n+'B':n<1048576?(n/1024).toFixed(0)+'K':(n/1048576).toFixed(1)+'M';
const mark = t => t==='derived'?'':t==='derived-split'?'<span class=tag title="exact delta, split across segments by estimate">~</span>':'<span class=tag title="estimated, rescaled to the measured total">&pm;</span>';

let current = M.requests.length - 1;

function renderMeter(r){
  const el = document.getElementById('meter');
  const limit = r.limit || r.total;
  el.innerHTML = r.bands.map(c =>
    '<div style="width:'+(c.tokens/limit*100)+'%;background:'+cssVar(c.key)+'" title="'+esc(c.label)+': '+human(c.tokens)+'"></div>').join('');
  document.getElementById('legend').innerHTML = r.bands.map(c =>
    '<span><i style="background:'+cssVar(c.key)+'"></i>'+esc(c.label)+' '+human(c.tokens)+'</span>').join('')
    + (r.limit ? '<span><i style="background:var(--free)"></i>free '+human(r.limit-r.total)+'</span>' : '');
  document.getElementById('headline').innerHTML =
    '<strong>'+human(r.total)+'</strong> / '+human(r.limit||0)+' tokens'
    + (r.limit ? ' <span class=sub>('+(r.total/r.limit*100).toFixed(1)+'% of the window)</span>' : '')
    + (r.measured ? '' : ' <span class=warn>— no usage reported; all figures estimated</span>');

  const rows = [];
  r.categories.forEach((c,ci)=>{
    const expandable = EXPANDABLE.has(c.key) && c.items.length>1;
    const caret = expandable ? '<span class=caret>&#9654;</span>' : '<span class=caret></span>';
    const count = expandable ? '<span class=count>'+c.items.length+'</span>' : '';
    rows.push('<tr'+(expandable?' class=parent aria-expanded=false data-cat="'+ci+'" onclick="toggleCat('+ci+')"':'')+'>'+
      '<td>'+caret+esc(c.label)+count+mark(c.tier)+'</td><td class=n>'+human(c.tokens)+'</td><td class=n>'+
      (r.total?(c.tokens/r.total*100).toFixed(1):'0')+'%</td></tr>');
    if (expandable)
      // Collapsed by default: a long tool list buries the categories underneath it.
      for (const i of c.items) rows.push('<tr class=sub data-child="'+ci+'" hidden><td>'+esc(i.label)+
        (i.count>1?' &times;'+i.count:'')+'</td><td class=n>'+human(i.tokens)+'</td><td class=n></td></tr>');
  });
  if (r.limit) rows.push('<tr><td>Free space</td><td class=n>'+human(r.limit-r.total)+'</td><td class=n>'+
    ((r.limit-r.total)/r.limit*100).toFixed(1)+'%</td></tr>');
  document.getElementById('cattable').innerHTML = rows.join('');

  const u = r.response && r.response.usage;
  document.getElementById('measured').innerHTML = u ?
    'measured: input '+human(u.input)+' &middot; output '+human(u.output)+
    (u.cache_read?' &middot; cache read '+human(u.cache_read)+' ('+(u.input?Math.round(u.cache_read/u.input*100):0)+'% of prompt)':'')+
    (u.cache_write?' &middot; cache write '+human(u.cache_write):'')+
    (u.reasoning?' &middot; reasoning '+human(u.reasoning):'') : '';
}

function toggleCat(ci){
  const parent = document.querySelector('#cattable tr.parent[data-cat="'+ci+'"]');
  const open = parent.getAttribute('aria-expanded') !== 'true';
  parent.setAttribute('aria-expanded', open);
  document.querySelectorAll('#cattable tr[data-child="'+ci+'"]').forEach(el=>{ el.hidden = !open; });
}
window.toggleCat = toggleCat;

function renderDetail(r){
  const part = (label, extra, body, truncated, full) =>
    '<details><summary>'+esc(label)+' <span class=sub>'+esc(extra)+'</span></summary><div class=body>'+
    (body===null ? '<p class=warn>not recorded at this trace level &mdash; set level to "full" to keep it</p>'
                 : '<pre>'+esc(body)+(truncated?'\n… truncated ('+human(full)+' chars total)':'')+'</pre>')+
    '</div></details>';
  const out = [];
  out.push('<h2>Request #'+r.id+' \u00b7 '+esc(r.agent||'')+' \u00b7 '+esc(r.ts)+'</h2>');
  out.push('<div class=sub>'+esc(r.shape)+' &rarr; '+esc(r.url)+'</div>');
  out.push('<pre>'+esc(JSON.stringify(r.params,null,2))+'</pre>');
  r.system.forEach((s,i)=>out.push(part('System block '+(i+1), bytes(s.bytes), s.text, s.truncated, s.full)));
  out.push(part('Tool definitions', r.tools.length+' tools, '+bytes(r.tools.reduce((a,t)=>a+t.bytes,0)),
    r.tools.map(t=>t.name+'  ('+bytes(t.bytes)+')\n'+(t.text||'')).join('\n\n'), false));
  r.messages.forEach((m,i)=>out.push(part('Message '+(i+1)+' — '+m.role, bytes(m.bytes), m.text, m.truncated, m.full)));
  if (r.response){
    const u=r.response.usage||{};
    out.push(part('Response', r.response.status+' \u00b7 stop '+r.response.stop+' \u00b7 in '+human(u.input)+' out '+human(u.output),
      (r.response.text||'')+(r.response.calls.length?'\n\ntool calls:\n'+r.response.calls.map(c=>'  '+c.name+'('+c.args+')').join('\n'):''),
      r.response.truncated, r.response.full));
  }
  document.getElementById('detail').innerHTML = out.join('');
}

// Session-wide maxima, computed ONCE. Truncating the view removes rows; it must never
// resize the surviving bars, or identical data appears to change magnitude as you browse.
const G = M.growth;
const DMAX = Math.max(1, ...G.steps.filter(s=>s.delta!=null).map(s=>Math.abs(s.delta)));
const CMAX = Math.max(1, ...G.composition.map(c=>c.total));

// The legend covers every category in the session, so it does not flicker as rows are hidden.
const compCats = [];
for (const c of G.composition) for (const cat of c.bands)
  if (!compCats.some(x=>x.key===cat.key)) compCats.push({key:cat.key,label:cat.label});
document.getElementById('complegend').innerHTML = compCats.map(cat=>
  '<span><i style="background:'+cssVar(cat.key)+'"></i>'+esc(cat.label)+'</span>').join('');

function renderDeltas(upto){
  const steps = G.steps.filter(s=>s.id<=upto);
  const usable = steps.filter(s=>s.delta!=null);
  document.getElementById('deltas').innerHTML = steps.length ? steps.map(s=>{
    if (s.delta==null) return '<tr><td class=id>#'+s.id+'</td><td class=amt></td><td class=trk></td>'+
      '<td class=why><span class=pill>in flight</span> no usage reported yet</td></tr>';
    const why = s.reset
      ? '<span class=pill>pruned</span> '+s.droppedCount+' segment'+(s.droppedCount===1?'':'s')+' dropped, so the delta is not attributable'
      : esc(s.drivers.slice(0,4).map(d=>d.text).join(', '));
    return '<tr><td class=id>#'+s.id+'</td>'+
      '<td class=amt>'+(s.delta<0?'-':'+')+human(Math.abs(s.delta))+'</td>'+
      '<td class=trk><span class="'+(s.delta<0?'neg':'')+'" style="width:'+(Math.abs(s.delta)/DMAX*100)+'%"></span></td>'+
      '<td class=why>'+why+'</td></tr>';
  }).join('') : '<tr><td class=why>this is the opening prompt — nothing added yet</td></tr>';

  // Footers describe the visible slice, not the whole session, or the numbers would disagree
  // with the rows above them.
  const shown = G.composition.filter(c=>c.id<=upto);
  const addedTotal = usable.filter(s=>!s.reset).reduce((a,s)=>a+Math.max(0,s.delta),0);
  const finalTotal = shown.length ? shown[shown.length-1].total : 0;
  const foot = [];
  if (!usable.length) foot.push('Only '+shown.length+' call'+(shown.length===1?'':'s')+' so far — nothing to compare yet.');
  else {
    const biggest = usable.reduce((a,s)=>Math.abs(s.delta)>Math.abs(a.delta)?s:a);
    if (addedTotal>0 && Math.abs(biggest.delta)/addedTotal>0.4 && usable.length>2)
      foot.push('Call #'+biggest.id+' is '+Math.round(Math.abs(biggest.delta)/addedTotal*100)+'% of everything added so far.');
    foot.push('Opening prompt '+human(G.opening.total)+' · added since '+human(addedTotal)+' · now '+human(finalTotal)+'.');
  }
  document.getElementById('growthfoot').textContent = foot.join(' ');
}

function renderComposition(upto){
  document.getElementById('composition').innerHTML = G.composition.filter(c=>c.id<=upto).map(c=>
    '<tr'+(c.id===upto?' class=cur':'')+'><td class=id>#'+c.id+'</td>'+
    '<td class=amt>'+human(c.total)+(c.measured?'':' <span class=pill>est</span>')+'</td>'+
    '<td class=trk colspan=2><div class=comp style="width:'+(c.total/CMAX*100)+'%">'+
    c.bands.map(cat=>'<i style="width:'+(cat.tokens/c.total*100)+'%;background:'+cssVar(cat.key)+
      '" title="'+esc(cat.label)+': '+human(cat.tokens)+'"></i>').join('')+
    '</div></td></tr>').join('');
}

function renderTools(upto){
  const row = G.composition.find(c=>c.id===upto);
  const tools = row ? row.tools : [];
  document.getElementById('tooltable').innerHTML = tools.length ? tools.map(t=>
    '<tr><td>'+esc(t.tool)+'</td><td class=n>'+human(t.tokens)+'</td><td class=n>'+t.calls+'</td><td class=n>'+bytes(t.bytes)+'</td></tr>').join('')
    : '<tr><td colspan=4 class=warn>no tool calls yet at this point in the session</td></tr>';
}

function select(i){
  current = i;
  document.querySelectorAll('#reqtabs button').forEach((b,j)=>b.setAttribute('aria-selected', j===i));
  const r = M.requests[i];
  const last = i === M.requests.length-1;
  // r.id is opencode's request number, which counts the title call too — so it is not an
  // ordinal into this list. Show the position and the id as separate facts.
  document.getElementById('scope').textContent =
    'Showing the session as of call '+(i+1)+' of '+M.requests.length+
    ' (request #'+r.id+(r.agent ? ', agent ' + r.agent : '')+'). '+
    (last ? 'Everything below is the full session. The tiles above always cover the whole session.'
          : 'Every section below is truncated to this point; later calls are hidden. The tiles above always cover the whole session.');
  renderMeter(r);
  renderDeltas(r.id);
  renderComposition(r.id);
  renderTools(r.id);
  renderDetail(r);
}

document.getElementById('reqtabs').innerHTML = M.requests.map((r,i)=>
  '<button onclick="select('+i+')">#'+r.id+' <span class=sub>'+human(r.total)+'</span></button>').join('');

window.select = select;
select(current);
`

export function renderHtml(trace, meta = {}) {
  const model = buildModel(trace, meta)
  const json = JSON.stringify(model).replace(/</g, "\\u003c")
  const title = model.title ? `${model.title}` : model.session
  const cache = model.cache.prompt ? ((model.cache.read / model.cache.prompt) * 100).toFixed(1) + "%" : "-"

  // Standalone file: it carries its own charset, or the em-dashes and middots arrive as mojibake.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>octx — ${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(title)}</h1>
  <div class="sub mono">${escapeHtml(model.session)}</div>
  <div class="sub">${escapeHtml(model.directory ?? "")}${model.opencode ? ` · opencode ${escapeHtml(model.opencode)}` : ""}</div>

  <div class="kpis">
    <div class="kpi">
      <div class="k-label">LLM calls</div>
      <div class="k-value">${model.counts.requests}</div>
      <div class="k-note">${model.counts.metaRequests ? `+${model.counts.metaRequests} title` : "&nbsp;"}</div>
    </div>
    <div class="kpi">
      <div class="k-label">Tool calls</div>
      <div class="k-value">${model.counts.toolCalls}</div>
      <div class="k-note">${model.tools.length} tool${model.tools.length === 1 ? "" : "s"} used</div>
    </div>
    <div class="kpi">
      <div class="k-label">Cache hits</div>
      <div class="k-value">${cache}</div>
      <div class="k-note">of ${model.cache.prompt ? Math.round(model.cache.prompt / 1000) + "k" : "0"} prompt tokens</div>
    </div>
    ${
      model.counts.reasoningTokens
        ? `<div class="kpi">
      <div class="k-label">Reasoning</div>
      <div class="k-value">${model.counts.reasoningTokens >= 1000 ? (model.counts.reasoningTokens / 1000).toFixed(1) + "k" : model.counts.reasoningTokens}</div>
      <div class="k-note">output tokens thinking</div>
    </div>`
        : ""
    }
    <div class="kpi">
      <div class="k-label">Cost</div>
      <div class="k-value">${model.cost != null ? "$" + model.cost.toFixed(4) : "—"}</div>
      <div class="k-note">${model.cost != null ? "reported by opencode" : "not reported"}</div>
    </div>
  </div>

  <div class="tabs" id="reqtabs"></div>
  <div class="scope" id="scope"></div>

  <h2>Context window</h2>
  <div class="card">
    <div id="headline"></div>
    <div class="meter" id="meter"></div>
    <div class="legend" id="legend"></div>
    <div class="scroll"><table>
      <thead><tr><th>Category</th><th class="n">Tokens</th><th class="n">Share</th></tr></thead>
      <tbody id="cattable"></tbody>
    </table></div>
    <div class="sub" id="measured" style="margin-top:12px"></div>
  </div>

  <h2>What each call added</h2>
  <div class="card">
    <div class="sub">Deltas between consecutive calls. These come from the provider's own token
      counts, so unlike the category breakdown they are measured, not estimated.</div>
    <div class="scroll"><table class="grow"><tbody id="deltas"></tbody></table></div>
    <div class="sub" id="growthfoot" style="margin-top:12px"></div>
  </div>

  <h2>Composition</h2>
  <div class="card">
    <div class="sub">What the window was made of at each call.</div>
    <div class="scroll"><table class="grow"><tbody id="composition"></tbody></table></div>
    <div class="legend" id="complegend" style="margin-top:14px"></div>
  </div>

  <h2>Tool cost</h2>
  <div class="card scroll"><table>
    <thead><tr><th>Tool</th><th class="n">Tokens in context</th><th class="n">Calls</th><th class="n">Output</th></tr></thead>
    <tbody id="tooltable"></tbody>
  </table></div>

  <h2>What was sent</h2>
  <div id="detail"></div>

  <p class="sub" style="margin-top:40px">
    Generated by octx from ${escapeHtml(model.file ?? "")} at ${escapeHtml(model.generated)}.
    <span class="tag">&plusmn;</span> estimated, rescaled to the measured total.
    <span class="tag">~</span> exact delta split across segments.
  </p>
</div>
<script>window.__OCTX__ = ${json};</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
}
