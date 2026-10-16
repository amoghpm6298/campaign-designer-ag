// Builds the run log from recorded runs.
//
//   node --experimental-strip-types --import ./agent-proto/register.mjs \
//        docs/buildRunLog.ts
//
// WHY THIS IS TYPESCRIPT AND THE OLD APPENDER IS PYTHON: the log now reports
// which blocks of the working brief were in the prompt on each turn, and the
// only honest way to know that is to assemble the brief with the real
// `briefForPrompt` and look. A Python generator would have to reimplement it
// and would drift. Here nothing is reimplemented.
//
// It REBUILDS rather than appends, so the whole page is always consistent with
// the current template. The source of truth is eval/runs/<run>/turns/*.json,
// written by every live run driver.
//
// The prompt a turn was given is the brief as it stood BEFORE that turn, which
// is the previous turn's recorded brief — not the one in its own record, which
// is the state afterwards. Getting that backwards would attribute a block to
// the turn that created it rather than the turn it acted on.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefForPrompt, newBrief, type WorkingBrief } from '../server/discovery';
import { blocksIn, blocksAbsent, BRIEF_BLOCKS, SYSTEM_SECTIONS, type PromptBlock } from '../server/promptBlocks';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const RUNS = resolve(APP, 'eval/runs');
const OUT = resolve(HERE, 'live-run-log.html');

const e = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Turn HTML-escaped text back into plain text.
 *
 * Needed for anything lifted out of the legacy page: that text was escaped
 * once when it was written, and escaping it again renders the entities
 * themselves. The change log showed `&#x27;` in place of every apostrophe
 * until this was added.
 */
const unesc = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Local wall-clock time, as "YYYY-MM-DD HH:MM".
 *
 * NOT toISOString(). That renders UTC, and a run at 22:38 local showed as
 * 17:08 — five and a half hours adrift, while the 30 archived runs (written by
 * the old Python appender, which used astimezone()) rendered correctly in
 * local time. So the same list carried two timezones, and the change log,
 * which sorts on these strings, ordered them against each other.
 */
const stamp = (d: Date): string => {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

// ----------------------------------------------------------------- records

interface TurnRecord {
  ms: number;
  events: { type?: string; title?: string; detail?: string; data?: Record<string, unknown> }[];
  response: Record<string, unknown>;
}

interface RunMeta {
  /** Short name in the picker. */
  label: string;
  /** What changed in the code before this run. Shown in the change log only. */
  change: string;
  /** The user's own turns, so the transcript shows both sides. */
  turns?: string[];
}

interface Run {
  id: string;
  dir: string;
  meta: RunMeta;
  turns: TurnRecord[];
  when: Date;
}

function loadRuns(): Run[] {
  if (!existsSync(RUNS)) return [];
  const out: Run[] = [];
  for (const d of readdirSync(RUNS)) {
    const dir = resolve(RUNS, d);
    const turnsDir = resolve(dir, 'turns');
    if (!existsSync(turnsDir)) continue;
    const files = readdirSync(turnsDir)
      .filter((f) => /^turn-\d+\.json$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    if (!files.length) continue;
    const turns = files.map((f) => JSON.parse(readFileSync(resolve(turnsDir, f), 'utf8')) as TurnRecord);
    const metaPath = resolve(dir, 'meta.json');
    const meta: RunMeta = existsSync(metaPath)
      ? JSON.parse(readFileSync(metaPath, 'utf8'))
      : { label: d.replace(/-\d{4}-\d{2}-\d{2}T.*$/, ''), change: 'Not recorded for this run.' };
    out.push({ id: `run-${d}`, dir, meta, turns, when: statSync(resolve(turnsDir, files[0])).mtime });
  }
  // Newest first.
  return out.sort((a, b) => b.when.getTime() - a.when.getTime());
}

// ----------------------------------------------------------- archived runs

/**
 * The 30 runs recorded before turn records were kept.
 *
 * Their driver wrote the HTML directly and kept nothing else, so they cannot
 * be re-rendered and can never show prompt blocks — that data was never
 * captured. They are still the history of this system, so they are carried
 * forward as they were rather than dropped or hidden behind a link.
 *
 * Their markup is left EXACTLY as it was and restyled instead. Rewriting 30
 * transcripts' class names to fit a new template risks silently mangling the
 * one thing they are evidence of, for a cosmetic gain.
 */
interface ArchivedRun {
  id: string;
  label: string;
  when: string;
  turns: string;
  secs: string;
  change: string;
  body: string;
}

function loadArchived(): ArchivedRun[] {
  const src = resolve(HERE, 'legacy-run-log.html');
  if (!existsSync(src)) return [];
  const html = readFileSync(src, 'utf8');
  const out: ArchivedRun[] = [];
  for (const art of html.match(/<article class="run"[\s\S]*?<\/article>/g) ?? []) {
    const attr = (n: string) => new RegExp(`data-${n}="([^"]*)"`).exec(art)?.[1] ?? '';
    const id = /id="([^"]*)"/.exec(art)?.[1] ?? '';
    // The change note moves to the change log at the bottom of the page, so it
    // is pulled out here and removed from the run body.
    const chg = /<div class="blk chg">[\s\S]*?<p>([\s\S]*?)<\/p><\/div>/.exec(art);
    let body = art
      // Ends at </p></div>, NOT </div></div>. The first version matched the
      // latter, which does not occur here, so the match ran on and swallowed
      // the opening of the first turn — archived content then escaped its own
      // <article>, lost the .archived scope and rendered unstyled at the page
      // edge. A greedy-enough mistake to break 30 runs at once.
      .replace(/<div class="blk chg">[\s\S]*?<\/p><\/div>/, '')
      // The old template repeated the run name and its stats as an <h3>; the
      // new page already shows those in its own header.
      .replace(/<h3>[\s\S]*?<\/h3>/, '')
      .replace(/^<article class="run"[^>]*>/, '')
      .replace(/<\/article>$/, '');
    out.push({
      id, label: attr('label'), when: attr('when'), turns: attr('turns'), secs: attr('secs'),
      change: unesc(chg?.[1]?.replace(/<[^>]+>/g, '') ?? '').trim() || 'Not recorded for this run.',
      body,
    });
  }
  return out;
}

function archivedHtml(a: ArchivedRun): string {
  return `
<article class="run archived" id="${e(a.id)}" data-label="${e(a.label)}" data-when="${e(a.when)}" data-turns="${e(a.turns)}" data-secs="${e(a.secs)}">
  <header class="run-hd">
    <h2>${e(a.label)} <span class="pill">archived</span></h2>
    <div class="facts">
      <span><b>${e(a.turns)}</b> turns</span>
      <span><b>${e(a.secs)}s</b> total</span>
      <span>${e(a.when)}</span>
    </div>
    <p class="lead">This run was recorded before turn records were kept, so it cannot show which prompt blocks applied. The transcript is unchanged.</p>
  </header>
  ${a.body}
</article>`;
}

// -------------------------------------------------------- reply rendering

/**
 * Render a reply exactly as the product does, and no better.
 *
 * The app's RichText does two things: a line starting "- " joins a list, and
 * **bold** becomes bold. A "**Approach**" line is therefore a bold LINE, not a
 * heading. An earlier version of this log promoted those to styled headings,
 * which made the page easier to read than the screen it documents — the
 * opposite of the job.
 */
function replyHtml(text: string): string {
  if (!text) return '<p class="na">No reply.</p>';
  const inline = (t: string) => {
    let s = e(t);
    for (;;) {
      const a = s.indexOf('**');
      const b = s.indexOf('**', a + 2);
      if (a === -1 || b === -1) break;
      s = `${s.slice(0, a)}<strong>${s.slice(a + 2, b)}</strong>${s.slice(b + 2)}`;
    }
    return s;
  };
  const out: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) { out.push(`<ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>`); bullets = []; }
  };
  for (const raw of text.split('\n')) {
    if (raw.startsWith('- ')) { bullets.push(inline(raw.slice(2))); continue; }
    flush();
    if (raw.trim()) out.push(`<div>${inline(raw)}</div>`);
  }
  flush();
  return out.join('');
}

// ------------------------------------------------------------ turn pieces

/** Tool calls, in the round they happened, repeats and failures marked. */
function toolsHtml(t: TurnRecord): string {
  const rows: string[] = [];
  let round = 0;
  for (const ev of t.events ?? []) {
    const ty = String(ev.type ?? '');
    if (ty === 'model.started') round++;
    if (!ty.startsWith('model.tool_call.completed') && !ty.startsWith('model.tool_call.failed')) continue;
    const repeat = /already fetched|already called/i.test(ev.detail ?? '') ? '<span class="pill warn">repeat</span>' : '';
    const failed = ty.endsWith('failed') ? '<span class="pill bad">failed</span>' : '';
    rows.push(`<li><span class="rnd">round ${round}</span> ${e(ev.title)} ${repeat}${failed}</li>`);
  }
  return rows.length ? `<ul class="plain">${rows.join('')}</ul>` : '<p class="na">No tools called on this turn.</p>';
}

/** Per-round model behaviour, where the harness captured it. */
function roundsHtml(t: TurnRecord): string {
  const rows = (t.events ?? [])
    .filter((ev) => ev.type === 'model.completed')
    .map((ev) => {
      const d = (ev.data ?? {}) as Record<string, unknown>;
      const u = (d.usage ?? {}) as Record<string, unknown>;
      const think = ((u.output_tokens_details ?? {}) as Record<string, unknown>).thinking_tokens;
      return `<tr><td>${e(d.round)}</td><td>${e(d.stopReason)}</td><td>${e((d.blockTypes as string[] ?? []).join(', '))}</td><td class="n">${e(d.textChars)}</td><td class="n">${e(u.output_tokens)}</td><td class="n">${e(think ?? '—')}</td></tr>`;
    });
  if (!rows.length) return '<p class="na">Per-round data not captured for this run.</p>';
  return `<div class="scroll"><table><thead><tr><th>Round</th><th>Stopped because</th><th>Blocks</th><th>Text chars</th><th>Out tokens</th><th>Thinking</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/** The blocks of the working brief this turn was actually given. */
function promptHtml(briefIn: WorkingBrief): string {
  const text = briefForPrompt(briefIn);
  const on = blocksIn(text);
  const off = blocksAbsent(text);
  const group = (bs: PromptBlock[], g: PromptBlock['group']) => bs.filter((b) => b.group === g);
  const names: Record<PromptBlock['group'], string> = {
    objective: 'Objective', questions: 'Questions', record: 'What is already known', evidence: 'Evidence and conflicts',
  };
  const sections = (Object.keys(names) as PromptBlock['group'][])
    .map((g) => {
      const act = group(on, g);
      if (!act.length) return '';
      return `<div class="pg"><div class="pg-t">${names[g]}</div><ul class="blocks">${act
        .map((b) => `<li><b>${e(b.name)}</b><span>${e(b.purpose)}</span></li>`)
        .join('')}</ul></div>`;
    })
    .filter(Boolean)
    .join('');
  return `
    <p class="lead">${on.length} of ${BRIEF_BLOCKS.length} working-brief blocks were in this turn's prompt. The rest stayed silent because the conversation had not reached them.</p>
    ${sections || '<p class="na">No conditional blocks applied on this turn.</p>'}
    <details class="sub-d"><summary>The ${off.length} that did not apply</summary><ul class="blocks off">${off
      .map((b) => `<li><b>${e(b.name)}</b><span>${e(b.purpose)}</span></li>`)
      .join('')}</ul></details>
    <details class="sub-d"><summary>Exact brief text sent to the model (${text.length.toLocaleString()} characters)</summary><pre>${e(text)}</pre></details>`;
}

/** What the application decided, as opposed to what the agent said. */
function appHtml(r: Record<string, unknown>): string {
  const out: string[] = [];
  const st = (r.strategy ?? null) as Record<string, unknown> | null;
  const comp = st?.architectureComparison as { status: string; why: string } | undefined;
  const warn = (st?.designWarnings ?? []) as string[];
  if (comp)
    out.push(`<div class="chk ${comp.status === 'differentiated' ? 'ok' : 'warn'}"><div class="chk-t">Were the alternatives real? <b>${e(comp.status)}</b></div><p>${e(comp.why)}</p></div>`);
  for (const w of warn) out.push(`<div class="chk warn"><div class="chk-t">What this design cannot do</div><p>${e(w)}</p></div>`);
  const gr = r.graphReadiness as { status?: string; blockers?: string[] } | null;
  if (gr?.blockers?.length)
    out.push(`<div class="chk bad"><div class="chk-t">Cannot be generated yet</div><ul class="plain">${gr.blockers.map((b) => `<li>${e(b)}</li>`).join('')}</ul></div>`);
  const b = (r.brief ?? {}) as Record<string, unknown>;
  const dims = (b.dimensions ?? []) as { name: string; status: string; basis: string; note?: string }[];
  if (dims.length)
    out.push(`<details class="sub-d"><summary>Dimension record after this turn (${dims.length})</summary><ul class="blocks">${dims
      .map((d) => `<li><b>${e(d.name)}</b><span><span class="pill">${e(d.status)}</span><span class="pill">${e(d.basis)}</span> ${e(d.note ?? '')}</span></li>`)
      .join('')}</ul></details>`);
  return out.length ? out.join('') : '<p class="na">No application checks applied on this turn.</p>';
}

// -------------------------------------------------------------- the page

function turnHtml(run: Run, i: number): string {
  const t = run.turns[i];
  const r = t.response;
  const userText = userTurnOf(run, i);
  // The brief as it stood BEFORE this turn. See the file header.
  const prev = i === 0 ? null : (run.turns[i - 1].response.brief as WorkingBrief | null);
  const briefIn = prev ?? newBrief(userText || 'Objective not recorded');
  const qs = (r.questions ?? []) as string[];
  return `
<section class="turn">
  <div class="turn-hd"><span class="tn">Turn ${i + 1}</span><span class="pill ph">${e(r.phase)}</span><span class="pill">${(t.ms / 1000).toFixed(1)}s</span></div>

  <div class="pane">
    <div class="pane-hd">On screen</div>
    <div class="pane-b chat">
      ${userText ? `<div class="msg user"><div class="who">Campaign manager</div><div class="bub">${e(userText)}</div></div>` : ''}
      <div class="msg agent"><div class="who">Agent</div><div class="bub">${replyHtml(String(r.reply ?? ''))}</div></div>
      ${qs.length ? `<div class="qs">${qs.map((q, n) => `<div class="q"><span class="qn">${n + 1}</span>${e(q)}</div>`).join('')}</div>` : ''}
    </div>
  </div>

  <div class="pane">
    <div class="pane-hd">What the agent was told</div>
    <div class="pane-b">${promptHtml(briefIn)}</div>
  </div>

  <div class="pane">
    <div class="pane-hd">What the application decided</div>
    <div class="pane-b">${appHtml(r)}</div>
  </div>

  <details class="sub-d wide"><summary>Tools and model rounds</summary>
    <div class="pane-b">${toolsHtml(t)}${roundsHtml(t)}</div>
  </details>
</section>`;
}

/**
 * The user's words for a turn.
 *
 * Recorded turns hold the response, not the prompt, so the user turn is read
 * from the conversation the response carries where available. Where it is not,
 * the turn is shown without it rather than inventing one.
 */
function userTurnOf(run: Run, i: number): string {
  const t = run.meta.turns;
  if (Array.isArray(t) && t[i]) return t[i];
  return '';
}

function runHtml(run: Run, n: number): string {
  const total = run.turns.reduce((s, t) => s + t.ms, 0) / 1000;
  const last = run.turns[run.turns.length - 1].response;
  const reached = last.phase === 'awaiting-confirmation';
  const blocked = ((last.graphReadiness as { blockers?: string[] } | null)?.blockers ?? []).length > 0;
  return `
<article class="run${n === 0 ? ' on' : ''}" id="${e(run.id)}" data-label="${e(run.meta.label)}" data-when="${stamp(run.when)}" data-turns="${run.turns.length}" data-secs="${total.toFixed(0)}" data-ok="${reached && !blocked}">
  <header class="run-hd">
    <h2>${e(run.meta.label)}</h2>
    <div class="facts">
      <span><b>${run.turns.length}</b> turns</span>
      <span><b>${total.toFixed(0)}s</b> total</span>
      <span><b>${reached ? 'Reached a proposal' : 'Still in discovery'}</b></span>
      ${blocked ? '<span class="pill bad">not buildable</span>' : ''}
    </div>
  </header>
  ${run.turns.map((_, i) => turnHtml(run, i)).join('')}
</article>`;
}

function page(runs: Run[], archived: ArchivedRun[]): string {
  // Newest first across both kinds, so the change log reads as one history.
  const changeLog = [
    ...runs.map((r) => ({ label: r.meta.label, when: stamp(r.when), change: r.meta.change, tag: '' })),
    ...archived.map((a) => ({ label: a.label, when: a.when, change: a.change, tag: ' <span class="pill">archived</span>' })),
  ]
    .sort((a, b) => b.when.localeCompare(a.when))
    .map((r) => `<tr><td><b>${e(r.label)}</b>${r.tag}</td><td>${e(r.when)}</td><td>${e(r.change)}</td></tr>`)
    .join('');
  return `<title>Campaign Agent — Run Log</title>
<style>
  /* Light only. This is an internal observability tool shown on shared
     screens and projectors, where a dark page washes out. */
  :root{
    --ink:#15202b; --ink-2:#4a5a6a; --ink-3:#7a8896;
    --line:#dfe5ea; --line-2:#eef2f5; --bg:#fbfcfd; --card:#fff;
    --accent:#1b5e8f; --accent-soft:#eaf2f8;
    --ok:#1d7a4d; --ok-soft:#e9f6ef; --warn:#8a5a00; --warn-soft:#fdf4e3;
    --bad:#a32c2c; --bad-soft:#fbecec;
    --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:1420px;margin:0 auto;padding:24px 20px 72px}

  /* Two columns: the run list stays put and scrolls on its own, the run
     fills the rest. A top-of-page picker was tried first and wrapped to
     seven rows at 31 runs, pushing the actual content below the fold — it
     got worse with every run added, which is the opposite of what a log
     should do. */
  .shell{display:grid;grid-template-columns:252px minmax(0,1fr);gap:26px;align-items:start}
  h1{font-size:25px;letter-spacing:-.02em;margin:0 0 6px;text-wrap:balance}
  h2{font-size:19px;letter-spacing:-.01em;margin:0}
  h3{font-size:15px;margin:0 0 10px}
  .sub{color:var(--ink-2);max-width:72ch;margin:0 0 22px}
  .na{color:var(--ink-3);font-style:italic;margin:4px 0}
  .lead{color:var(--ink-2);margin:0 0 12px}

  /* run list */
  .nav{position:sticky;top:18px;max-height:calc(100vh - 36px);display:flex;flex-direction:column;gap:9px}
  .nav-hd{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3)}
  .find{font:inherit;font-size:13px;width:100%;padding:7px 10px;border:1px solid var(--line);
    border-radius:8px;background:var(--card);color:var(--ink)}
  .find:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  .picker{display:flex;flex-direction:column;gap:3px;overflow-y:auto;min-height:0;
    padding-right:4px;scrollbar-width:thin}
  .picker button{font:inherit;cursor:pointer;background:none;color:var(--ink-2);
    border:1px solid transparent;border-radius:7px;padding:7px 10px;text-align:left;width:100%}
  .picker button:hover{background:var(--line-2);color:var(--ink)}
  .picker button[aria-current=true]{background:var(--accent);border-color:var(--accent);color:#fff}
  .picker button[hidden]{display:none}
  .picker .nm{font-weight:600;display:block;font-size:13.5px}
  .picker .mt{font-size:11.5px;opacity:.82;display:block}
  .none{color:var(--ink-3);font-style:italic;font-size:13px;padding:6px 10px}

  .run{display:none}
  .run.on{display:block}
  .run-hd{margin:0 0 20px}
  .facts{display:flex;gap:16px;flex-wrap:wrap;color:var(--ink-2);font-size:13px;margin-top:6px}
  .facts b{color:var(--ink)}

  .turn{background:var(--card);border:1px solid var(--line);border-radius:12px;
    padding:18px;margin:0 0 18px}
  .turn-hd{display:flex;align-items:center;gap:9px;margin:0 0 14px}
  .tn{font-weight:650;letter-spacing:-.01em}

  .pane{border:1px solid var(--line-2);border-radius:9px;margin:0 0 12px;overflow:hidden}
  .pane-hd{background:var(--line-2);padding:7px 13px;font-size:12px;font-weight:650;
    letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2)}
  .pane-b{padding:14px}

  /* the chat, mirroring the product */
  .chat{display:flex;flex-direction:column;gap:13px}
  .who{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);margin-bottom:4px}
  .bub{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fff}
  .msg.user .bub{background:var(--accent-soft);border-color:#d3e3ef}
  .bub>div{margin:0 0 7px}
  .bub>div:last-child{margin-bottom:0}
  .bub ul{margin:4px 0 10px;padding-left:20px}
  .bub li{margin:3px 0}
  .qs{display:flex;flex-direction:column;gap:7px}
  .q{display:flex;gap:9px;background:var(--warn-soft);border:1px solid #f0e2c2;
    border-radius:9px;padding:10px 12px}
  .qn{flex:0 0 19px;height:19px;border-radius:50%;background:var(--warn);color:#fff;
    font-size:11px;font-weight:700;display:grid;place-items:center}

  /* prompt blocks */
  .pg{margin:0 0 12px}
  .pg-t{font-size:12px;font-weight:650;color:var(--ink-2);letter-spacing:.04em;
    text-transform:uppercase;margin:0 0 6px}
  ul.blocks{list-style:none;margin:0;padding:0;display:grid;gap:6px}
  ul.blocks li{border-left:2px solid var(--accent);background:#fcfdfe;padding:7px 11px;border-radius:0 7px 7px 0}
  ul.blocks li b{display:block;font-size:13.5px}
  ul.blocks li span{display:block;color:var(--ink-2);font-size:13px}
  ul.blocks.off li{border-left-color:var(--line);opacity:.72}

  /* application checks */
  .chk{border:1px solid var(--line);border-left-width:3px;border-radius:0 8px 8px 0;
    padding:10px 13px;margin:0 0 9px}
  .chk-t{font-weight:600;margin-bottom:3px}
  .chk p{margin:0;color:var(--ink-2)}
  .chk.ok{border-left-color:var(--ok);background:var(--ok-soft)}
  .chk.warn{border-left-color:var(--warn);background:var(--warn-soft)}
  .chk.bad{border-left-color:var(--bad);background:var(--bad-soft)}

  .pill{display:inline-block;font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;
    background:var(--line-2);color:var(--ink-2);letter-spacing:.02em}
  .pill.ph{background:var(--accent-soft);color:var(--accent)}
  .pill.warn{background:var(--warn-soft);color:var(--warn)}
  .pill.bad{background:var(--bad-soft);color:var(--bad)}

  ul.plain{list-style:none;margin:0;padding:0}
  ul.plain li{padding:5px 0;border-bottom:1px solid var(--line-2)}
  ul.plain li:last-child{border-bottom:0}
  .rnd{font:600 11px/1 var(--mono);color:var(--ink-3);margin-right:8px}

  details.sub-d{margin:9px 0 0}
  details.sub-d.wide{border:1px solid var(--line-2);border-radius:9px;overflow:hidden}
  details.sub-d summary{cursor:pointer;color:var(--accent);font-size:13.5px;padding:7px 0}
  details.sub-d.wide summary{background:var(--line-2);padding:7px 13px;color:var(--ink-2);font-weight:650;
    font-size:12px;letter-spacing:.06em;text-transform:uppercase}
  pre{font:12px/1.55 var(--mono);background:#f7f9fa;border:1px solid var(--line);
    border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;margin:8px 0 0}

  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0 0}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line-2);white-space:nowrap}
  th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)}
  td.n{text-align:right;font-family:var(--mono)}

  /* ---- archived runs -------------------------------------------------
     Their markup is the old template's, untouched. These rules restyle it
     with the current tokens so the archive reads as part of the same page
     rather than something bolted on. Nothing here changes a transcript. */
  .archived .turn>.screen,.archived .turn>.behind{border:1px solid var(--line-2);
    border-radius:9px;margin:0 0 12px;overflow:hidden}
  .archived .screen-hd,.archived .behind-hd{background:var(--line-2);padding:7px 13px;
    font-size:12px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2)}
  .archived .screen-body{padding:14px;display:flex;flex-direction:column;gap:13px}
  .archived .behind>.blk,.archived .behind>details{margin:14px}
  .archived .cd-msg-role{font-size:11px;letter-spacing:.07em;text-transform:uppercase;
    color:var(--ink-3);margin-bottom:4px}
  .archived .cd-msg-bubble{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fff}
  .archived .cd-msg.user .cd-msg-bubble{background:var(--accent-soft);border-color:#d3e3ef}
  .archived .cd-msg-bubble>div{margin:0 0 7px}
  .archived .cd-msg-bubble>div:last-child{margin-bottom:0}
  .archived .cd-msg-bubble ul{margin:4px 0 10px;padding-left:20px}
  .archived .cd-qs{display:flex;flex-direction:column;gap:7px}
  .archived .cd-q{display:flex;gap:9px;background:var(--warn-soft);border:1px solid #f0e2c2;
    border-radius:9px;padding:10px 12px}
  .archived .cd-q-n{flex:0 0 19px;height:19px;border-radius:50%;background:var(--warn);color:#fff;
    font-size:11px;font-weight:700;display:grid;place-items:center}
  .archived .cd-confirm{border:1px dashed var(--line);border-radius:9px;padding:12px;background:#fcfdfe}
  .archived .cd-confirm-t{font-weight:600}
  .archived .cd-confirm p{color:var(--ink-2);margin:4px 0 10px}
  .archived .cd-confirm-actions{display:flex;gap:8px}
  .archived .cd-btn{font-size:13px;border:1px solid var(--line);border-radius:7px;padding:6px 12px;color:var(--ink-2)}
  .archived .cd-btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
  .archived .blk-t{font-size:12px;font-weight:650;color:var(--ink-2);letter-spacing:.04em;
    text-transform:uppercase;margin:0 0 6px}
  .archived .blk p{margin:0;color:var(--ink-2)}
  .archived ul.tl{list-style:none;margin:0;padding:0;display:grid;gap:6px}
  .archived ul.tl>li{border-left:2px solid var(--accent);background:#fcfdfe;padding:7px 11px;
    border-radius:0 7px 7px 0}
  .archived ul.tl .sub{color:var(--ink-2);font-size:13px;margin:3px 0 0;max-width:none}
  .archived ol.steps,.archived ol.qs{padding-left:20px;margin:6px 0}
  .archived ol.steps>li{margin:6px 0}
  .archived pre.j{font:12px/1.55 var(--mono);background:#f7f9fa;border:1px solid var(--line);
    border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap}
  .archived .tag{display:inline-block;font-size:11px;font-weight:600;padding:2px 7px;
    border-radius:20px;background:var(--line-2);color:var(--ink-2);margin-right:5px}
  .archived .tag.st-retained,.archived .tag.ok{background:var(--ok-soft);color:var(--ok)}
  .archived .tag.st-unavailable,.archived .tag.bad,.archived .tag.rep{background:var(--bad-soft);color:var(--bad)}
  .archived .tag.st-deferred,.archived .tag.warn{background:var(--warn-soft);color:var(--warn)}
  .archived .tag[class*=ph-]{background:var(--accent-soft);color:var(--accent)}
  .archived details.dx{border:1px solid var(--line-2);border-radius:9px;overflow:hidden;margin:14px}
  .archived details.dx>summary{cursor:pointer;background:var(--line-2);padding:7px 13px;
    color:var(--ink-2);font-weight:650;font-size:12px;letter-spacing:.06em;text-transform:uppercase}
  .archived details.dx>.blk{margin:14px}
  .archived table.g{border-collapse:collapse;width:100%;font-size:13px}
  .archived table.g th,.archived table.g td{text-align:left;padding:6px 10px;
    border-bottom:1px solid var(--line-2)}
  .archived table.g th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)}
  .archived td.n{text-align:right;font-family:var(--mono)}

  /* bottom reference */
  .ref{margin:40px 0 0;padding:24px 0 0;border-top:2px solid var(--line)}
  .ref h3{font-size:16px;margin:0 0 8px}
  .ref section{margin:0 0 28px}
  .ref p{color:var(--ink-2);max-width:74ch}
  .ref table td{white-space:normal}
  code{font:12.5px var(--mono);background:var(--line-2);padding:1px 5px;border-radius:4px}
  @media (max-width:900px){
    .shell{grid-template-columns:1fr;gap:16px}
    .nav{position:static;max-height:none}
    .picker{max-height:190px}
  }
  @media (max-width:640px){.wrap{padding:18px 13px 56px}.turn{padding:13px}}
</style>

<div class="wrap">
  <h1>Campaign Agent — Run Log</h1>
  <p class="sub">Every live run of the campaign-design agent, recorded as it happened. Each turn shows three things: what appeared on screen, which blocks of the prompt the agent was actually given, and what the application checked or overruled afterwards. Transcripts are verbatim. Nothing is reconstructed.</p>

  <div class="shell">
  <nav class="nav" aria-label="Runs">
    <div class="nav-hd" id="count"></div>
    <input class="find" id="find" type="search" placeholder="Filter runs" aria-label="Filter runs">
    <div class="picker" id="picker"></div>
  </nav>

  <main>
    ${runs.length || archived.length
      ? runs.map((r, i) => runHtml(r, i)).join('') + archived.map((a) => archivedHtml(a)).join('')
      : '<p class="na">No runs recorded yet.</p>'}
  </main>
  </div>

  <div class="ref">
    <section>
      <h3>How the prompt is put together</h3>
      <p>The system prompt is the same on every turn. The working brief is not: it is rebuilt each turn from what the conversation has established, so most of its blocks are silent at any one moment. That is usually what explains a turn.</p>
      <table>
        <thead><tr><th>Section</th><th>What it is responsible for</th></tr></thead>
        <tbody>${SYSTEM_SECTIONS.map((s) => `<tr><td><b>${e(s.name)}</b></td><td>${e(s.purpose)}</td></tr>`).join('')}</tbody>
      </table>
    </section>

    <section>
      <h3>How to add a run</h3>
      <p>Runs are recorded by the drivers, then this page is rebuilt from the records. Nothing is written by hand.</p>
      <pre># 1. record a run (writes eval/runs/&lt;label&gt;-&lt;timestamp&gt;/turns/*.json)
node --experimental-strip-types --import ./agent-proto/register.mjs \\
     eval/showOne.ts &lt;label&gt;

# 2. optional: describe what changed, so it appears in the change log below
#    eval/runs/&lt;run&gt;/meta.json
#    { "label": "schema", "change": "Mechanism fields enforced", "turns": ["...", "..."] }

# 3. rebuild this page
node --experimental-strip-types --import ./agent-proto/register.mjs \\
     docs/buildRunLog.ts</pre>
    </section>

    <section>
      <h3>Change log</h3>
      <p>What changed in the code before each run. This is what makes two runs comparable.</p>
      <div class="scroll"><table>
        <thead><tr><th>Run</th><th>When</th><th>What changed before it</th></tr></thead>
        <tbody>${changeLog || '<tr><td colspan="3" class="na">No runs recorded yet.</td></tr>'}</tbody>
      </table></div>
    </section>

    <section>
      <h3>What this page does not tell you</h3>
      <p>The application can check that a campaign is internally consistent, that two alternatives genuinely differ, and that a claim matches what was built. It cannot judge whether a strategy is a good idea. That still needs a person to read one.</p>
    </section>
  </div>
</div>

<script>
  // Built from the runs themselves, so adding a run needs no change here.
  (function () {
    var runs = [].slice.call(document.querySelectorAll('article.run'));
    var list = document.getElementById('picker');
    if (!runs.length || !list) return;
    // The remember flag is false on the initial selection. Writing the hash on load
    // made the browser treat it as a fragment navigation and jump past the
    // page heading — the log opened 188px down with its own title off-screen.
    function show(id, remember) {
      runs.forEach(function (r) { r.classList.toggle('on', r.id === id); });
      [].forEach.call(list.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-current', String(b.dataset.target === id));
      });
      if (remember && history.replaceState) history.replaceState(null, '', '#' + id);
    }
    runs.forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.target = r.id;
      b.innerHTML = '<span class="nm">' + r.dataset.label + '</span>' +
        '<span class="mt">' + r.dataset.when + ' &middot; ' + r.dataset.turns + ' turns &middot; ' + r.dataset.secs + 's</span>';
      b.addEventListener('click', function () { show(r.id, true); });
      list.appendChild(b);
    });
    var count = document.getElementById('count');
    var find = document.getElementById('find');
    var empty = document.createElement('div');
    empty.className = 'none';
    empty.textContent = 'No run matches that.';
    empty.hidden = true;
    list.appendChild(empty);

    function filter() {
      var q = (find.value || '').toLowerCase().trim();
      var shown = 0;
      [].forEach.call(list.querySelectorAll('button'), function (b) {
        var hit = !q || b.textContent.toLowerCase().indexOf(q) !== -1;
        b.hidden = !hit;
        if (hit) shown++;
      });
      empty.hidden = shown > 0;
      count.textContent = shown === runs.length
        ? runs.length + ' runs'
        : shown + ' of ' + runs.length + ' runs';
    }
    find.addEventListener('input', filter);
    filter();

    var want = location.hash.replace('#', '');
    show(runs.some(function (r) { return r.id === want; }) ? want : runs[0].id, false);
  })();
</script>`;
}

const runs = loadRuns();
const archived = loadArchived();
writeFileSync(OUT, page(runs, archived));
process.stdout.write(
  `built ${OUT}\n` +
  `${runs.length} recorded run(s): ${runs.map((r) => `${r.meta.label} (${r.turns.length} turns)`).join(', ') || 'none'}\n` +
  `${archived.length} archived run(s) carried forward\n`,
);
