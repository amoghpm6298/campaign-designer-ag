// Renders the A/B results as one self-contained HTML page.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

function stats(r) {
  const m = r?.metrics ?? {};
  const qs = m.questions ?? [];
  return {
    built: !!m.built,
    turns: m.turns ?? 0,
    seconds: r?.seconds ?? 0,
    questions: qs.length,
    qWords: Math.round(avg(qs.map((q) => words(q.text))) * 10) / 10,
    choicePct: qs.length ? Math.round((100 * qs.filter((q) => q.answerType === 'single' || q.answerType === 'multi').length) / qs.length) : 0,
    typed: m.managerWordsTyped ?? 0,
    clicks: m.clicks ?? 0,
    sends: m.built?.sends ?? 0,
    steps: m.built?.steps ?? 0,
    forks: m.built?.forks ?? 0,
    notes: m.built?.notes?.length ?? 0,
    errors: m.errors?.length ?? 0,
  };
}

const ROWS = [
  ['built', 'Reached a built campaign', (v) => (v ? 'Yes' : 'No'), 'more'],
  ['turns', 'Manager turns', (v) => v, 'less'],
  ['seconds', 'Wall time', (v) => `${Math.floor(v / 60)}m ${v % 60}s`, 'less'],
  ['questions', 'Questions asked', (v) => v, 'none'],
  ['qWords', 'Avg words per question', (v) => v, 'less'],
  ['choicePct', 'Questions answerable by tapping', (v) => `${v}%`, 'more'],
  ['typed', 'Words the manager typed', (v) => v, 'less'],
  ['clicks', 'Taps / clicks', (v) => v, 'none'],
  ['sends', 'Messages in the journey', (v) => v, 'none'],
  ['forks', 'Branches / tests in the journey', (v) => v, 'none'],
  ['notes', 'Build notes / problems', (v) => v, 'less'],
  ['errors', 'Errors', (v) => v, 'less'],
];

function better(dir, a, b) {
  if (dir === 'none' || a === b) return '';
  const av = typeof a === 'boolean' ? Number(a) : a;
  const bv = typeof b === 'boolean' ? Number(b) : b;
  return (dir === 'more' ? bv > av : bv < av) ? 'v2' : 'v1';
}

function scoreBar(v) {
  const n = Number(v) || 0;
  return `<span class="bar"><i style="width:${n * 10}%"></i></span><b>${esc(n)}</b>`;
}

function transcript(r) {
  return (r?.log ?? [])
    .map((l) => {
      if (l.role === 'manager')
        return `<div class="m user"><span class="who">Manager${l.kind === 'click' ? ' · clicked' : l.kind === 'form' ? ' · form' : ''}</span>${esc(l.text).replace(/\n/g, '<br>')}</div>`;
      const tools = l.tools?.length ? `<div class="tools">${l.tools.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : '';
      const qs = l.questions?.length
        ? `<ol class="qs">${l.questions
            .map(
              (q) =>
                `<li>${q.aspect && q.aspect !== '—' ? `<em>${esc(q.aspect)}</em> ` : ''}${esc(q.text)}${q.answerType && q.answerType !== 'free text' ? ` <span class="t">${esc(q.answerType)}</span>` : ''}${q.options?.length ? `<div class="opts">${q.options.map((o) => `<span>${esc(o)}</span>`).join('')}<span class="oth">Other</span></div>` : ''}</li>`,
            )
            .join('')}</ol>`
        : '';
      return `<div class="m agent"><span class="who">Agent</span>${tools}${esc(l.text || '').replace(/\n/g, '<br>')}${qs}</div>`;
    })
    .join('');
}

function planBlock(r) {
  const p = r?.plan;
  if (!p) return '<p class="muted">No plan.</p>';
  const s = p.strategy ?? {};
  const strategyRows = [
    ['Hypothesis', s.hypothesis],
    ['Approach', s.approach ?? (Array.isArray(s.approach) ? s.approach.join(' ') : undefined) ?? s.summary],
    ['Alternative', s.alternative ?? s.architectures?.filter?.((a) => !a.chosen)?.map?.((a) => a.name ?? a.label)?.join(', ')],
    ['Measurement', s.measurement],
  ].filter(([, v]) => v);
  const findings = p.brief?.findings ?? [];
  const steps = (p.journey?.steps ?? []).length;
  return `
  ${findings.length ? `<h4>Brief</h4><dl>${findings.map((f) => `<dt>${esc(f.aspect)}</dt><dd>${esc(f.text)}</dd>`).join('')}</dl>` : ''}
  ${strategyRows.length ? `<h4>Strategy</h4><dl>${strategyRows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</dd>`).join('')}</dl>` : ''}
  ${p.journey ? `<h4>Journey</h4><p class="muted">${esc(p.journey.campaignName || '')} · ${steps} top-level steps</p><details><summary>Journey recipe (JSON)</summary><pre>${esc(JSON.stringify(p.journey, null, 1))}</pre></details>` : ''}
  ${r?.metrics?.built?.notes?.length ? `<h4>Build notes</h4><ul>${r.metrics.built.notes.slice(0, 12).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
}

export function renderReport({ startedAt, model, maxTurns, results }) {
  const wins = { v1: 0, v2: 0, tie: 0 };
  for (const r of results) if (r.verdict?.winner) wins[r.verdict.winner] = (wins[r.verdict.winner] ?? 0) + 1;
  const dims = ['strategy', 'journey', 'fidelity', 'experience', 'overall'];
  const avgScore = (p, d) => Math.round(avg(results.map((r) => Number(r.verdict?.[p]?.[d]) || 0).filter(Boolean)) * 10) / 10;
  const agg = (p, k) => Math.round(avg(results.map((r) => Number(stats(r[p])[k]) || 0)) * 10) / 10;

  const scenarioSections = results
    .map((r) => {
      const a = stats(r.v1);
      const b = stats(r.v2);
      const v = r.verdict ?? {};
      return `
<section class="scn" id="${esc(r.scenario.id)}">
  <h2>${esc(r.scenario.title)} <span class="win ${esc(v.winner ?? '')}">${v.winner ? (v.winner === 'tie' ? 'Tie' : `${v.winner} wins`) : 'Not judged'}</span></h2>
  <p class="open">Opening message: “${esc(r.scenario.opening)}”</p>
  ${v.why ? `<p class="why"><b>Judge:</b> ${esc(v.why)}</p>` : ''}
  <div class="grid2">
    <div class="card"><h3>Judge scores</h3><table class="scores"><thead><tr><th></th><th>v1 staged</th><th>v2 one agent</th></tr></thead><tbody>
      ${dims.map((d) => `<tr><td>${d}</td><td>${scoreBar(v.v1?.[d])}</td><td>${scoreBar(v.v2?.[d])}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><h3>Measured</h3><table class="metrics"><thead><tr><th></th><th>v1</th><th>v2</th></tr></thead><tbody>
      ${ROWS.map(([k, label, fmt, dir]) => {
        const w = better(dir, a[k], b[k]);
        return `<tr><td>${label}</td><td class="${w === 'v1' ? 'best' : ''}">${esc(fmt(a[k]))}</td><td class="${w === 'v2' ? 'best' : ''}">${esc(fmt(b[k]))}</td></tr>`;
      }).join('')}
    </tbody></table></div>
  </div>
  <div class="grid2 side">
    <div class="card"><h3>v1 · staged pipeline</h3><details open><summary>Conversation</summary><div class="tx">${transcript(r.v1)}</div></details><details><summary>Final plan</summary>${planBlock(r.v1)}</details></div>
    <div class="card"><h3>v2 · one agent</h3><details open><summary>Conversation</summary><div class="tx">${transcript(r.v2)}</div></details><details><summary>Final plan</summary>${planBlock(r.v2)}</details>
      ${r.v2?.timeline?.length ? `<details><summary>Backend timeline (${r.v2.timeline.length})</summary><ol class="tl">${r.v2.timeline.map((t) => `<li class="${esc(t.type)}"><b>${esc(t.actor)}</b> ${esc(t.note)}</li>`).join('')}</ol></details>` : ''}
    </div>
  </div>
</section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Designer A/B Results</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1a1d24;--ink2:#4b5260;--ink3:#8a909c;--line:#e3e5ea;--v1:#c2410c;--v2:#3b5bdb;--good:#2b8a3e;--goodbg:#e6f6ea;--accent:#3b5bdb}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121317;--card:#1a1c22;--ink:#eceef2;--ink2:#b5bac4;--ink3:#868c98;--line:#2d3039;--v1:#fb923c;--v2:#8ea2ff;--good:#69db7c;--goodbg:#173322;--accent:#8ea2ff}}
:root[data-theme="dark"]{--bg:#121317;--card:#1a1c22;--ink:#eceef2;--ink2:#b5bac4;--ink3:#868c98;--line:#2d3039;--v1:#fb923c;--v2:#8ea2ff;--good:#69db7c;--goodbg:#173322;--accent:#8ea2ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:28px;margin:4px 0 6px;letter-spacing:-.01em}h2{font-size:20px;margin:0 0 6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}h3{font-size:14px;margin:0 0 10px}h4{margin:14px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink3)}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);font-weight:600}.muted{color:var(--ink3)}
.lede{color:var(--ink2);max-width:820px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;min-width:0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}
@media(max-width:820px){.grid2,.grid4{grid-template-columns:1fr}}
.kpi .n{font-size:26px;font-weight:700}.kpi .l{font-size:12.5px;color:var(--ink2)}
.v1c{color:var(--v1)}.v2c{color:var(--v2)}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink3)}
td.best{color:var(--good);font-weight:600;background:var(--goodbg)}
.bar{display:inline-block;width:70px;height:6px;border-radius:3px;background:var(--line);margin-right:8px;vertical-align:middle;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
.scn{margin-top:38px;padding-top:8px;border-top:1px solid var(--line)}
.win{font-size:12px;padding:3px 10px;border-radius:999px;background:var(--line);color:var(--ink2);font-weight:600}.win.v2{background:color-mix(in srgb,var(--v2) 18%,transparent);color:var(--v2)}.win.v1{background:color-mix(in srgb,var(--v1) 18%,transparent);color:var(--v1)}
.open{color:var(--ink2);margin:0}.why{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;color:var(--ink2)}
details{margin-top:10px}summary{cursor:pointer;font-weight:600;font-size:13px;color:var(--ink2)}
.tx{display:grid;gap:8px;margin-top:10px;max-height:720px;overflow:auto;padding-right:4px}
.m{padding:9px 12px;border-radius:10px;font-size:13.5px;border:1px solid var(--line)}.m.user{background:color-mix(in srgb,var(--v2) 8%,var(--card))}.m.agent{background:var(--card)}
.who{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);margin-bottom:3px}
.tools{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}.tools span{font-size:11.5px;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--ink2)}
.qs{margin:8px 0 0;padding-left:18px}.qs li{margin:4px 0}.qs em{font-style:normal;font-weight:600;color:var(--accent);font-size:12px}.qs .t{font-size:11px;color:var(--ink3)}
.opts{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.opts span{font-size:11.5px;border:1px solid var(--line);border-radius:999px;padding:1px 8px}.opts .oth{border-style:dashed}
dl{display:grid;grid-template-columns:130px 1fr;gap:4px 12px;margin:0}dt{font-weight:600;font-size:13px}dd{margin:0;color:var(--ink2);font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;font-size:11.5px;background:var(--bg);border-radius:8px;padding:8px;max-height:360px;overflow:auto}
.tl{font-size:12.5px;padding-left:18px}.tl li.acted_ahead_of_flags{color:var(--v1)}
.theme{position:fixed;right:16px;bottom:16px;border:1px solid var(--line);background:var(--card);color:var(--ink2);border-radius:999px;padding:7px 12px;cursor:pointer;font:500 12px system-ui}
</style></head><body><div class="wrap">
<div class="eyebrow">Campaign Designer · live A/B</div>
<h1>v1 staged pipeline vs v2 one agent</h1>
<p class="lede">Same opening message, same simulated campaign manager (an LLM given the facts below and told to answer briefly), run against both pipelines until a campaign was built or ${esc(maxTurns)} turns passed. A separate LLM judge saw both sessions blind, in random order. Model: ${esc(model)}. Run started ${esc(new Date(startedAt).toLocaleString())}. One run per scenario, so treat differences as directional, not statistically settled.</p>
<div class="grid4">
  <div class="card kpi"><div class="n"><span class="v2c">${wins.v2}</span> – <span class="v1c">${wins.v1}</span>${wins.tie ? ` <span class="muted">(${wins.tie} tie)</span>` : ''}</div><div class="l">Judge wins, v2 – v1</div></div>
  <div class="card kpi"><div class="n"><span class="v2c">${avgScore('v2', 'overall')}</span> vs <span class="v1c">${avgScore('v1', 'overall')}</span></div><div class="l">Avg overall score /10</div></div>
  <div class="card kpi"><div class="n"><span class="v2c">${agg('v2', 'turns')}</span> vs <span class="v1c">${agg('v1', 'turns')}</span></div><div class="l">Avg manager turns</div></div>
  <div class="card kpi"><div class="n"><span class="v2c">${agg('v2', 'typed')}</span> vs <span class="v1c">${agg('v1', 'typed')}</span></div><div class="l">Avg words the manager typed</div></div>
</div>
<div class="card"><h3>Average judge scores</h3><table class="scores"><thead><tr><th></th><th>v1 staged</th><th>v2 one agent</th></tr></thead><tbody>
${dims.map((d) => `<tr><td>${d}</td><td>${scoreBar(avgScore('v1', d))}</td><td>${scoreBar(avgScore('v2', d))}</td></tr>`).join('')}
</tbody></table></div>
${scenarioSections}
<p class="muted" style="margin-top:40px">Generated by eval/ab/ab.mjs. Raw results are in the JSON file beside this report.</p>
</div>
<button class="theme" onclick="var r=document.documentElement,c=r.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');r.setAttribute('data-theme',c==='dark'?'light':'dark')">Toggle theme</button>
</body></html>`;
}
