// A/B: the v1 staged pipeline vs the v2 single agent, on the same scenarios,
// with an LLM playing the campaign manager and a blind LLM judge.
//
//   node eval/ab/ab.mjs [--base http://127.0.0.1:5174] [--only diwali] [--turns 10]
//
// Needs the dev server running (npm run dev:designer) and ANTHROPIC_API_KEY in .env.
// Writes eval/ab/results-<ts>.json and an HTML report next to it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReport } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const BASE = arg('base', 'http://127.0.0.1:5174');
const MAX_TURNS = Number(arg('turns', 10));
const ONLY = arg('only', '');
const OUT = arg('out', '');
const PIPE = arg('pipe', 'both');

const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const KEY = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || env.ANTHROPIC_MODEL || 'claude-sonnet-5';
if (!KEY) throw new Error('ANTHROPIC_API_KEY missing');

// --- scenarios: an opening line, and the facts only the simulated manager knows ---------
const SCENARIOS = [
  {
    id: 'diwali',
    title: 'Drive spends during Diwali',
    opening: 'I want to drive spends during Diwali',
    truth: `You run credit card campaigns at IndusInd Bank.
- Goal: grow total rupee card spend in the 3 weeks before Diwali (not just number of spenders).
- Success: total incremental card spend versus the same window last year.
- Who spends most at Diwali: salaried customers with credit limits above ₹2 lakh, mostly online shopping and electronics.
- Why the rest don't: many don't know about the festive offers; for small payments they default to UPI.
- Offer: 5% cashback on electronics and online shopping, capped at ₹1,500 per card.
- Guardrails: at most 4 messages per customer; WhatsApp and SMS are fine; no messages after 9pm.`,
  },
  {
    id: 'activation',
    title: 'Activate new cards',
    opening: 'Get new cardholders to activate their card',
    truth: `You run credit card lifecycle campaigns at IndusInd Bank.
- Goal: new cardholders set their PIN and make a first transaction within 30 days of issue.
- Success: % of new cards activated (PIN set and first transaction) within 30 days.
- Who activates on their own: customers sourced at a branch activate faster than those sourced digitally or by agents.
- Why the rest don't: they don't know how to set the PIN in the app; some worry about annual fees.
- No special offer this time.
- Guardrails: up to 5 messages; WhatsApp preferred, SMS as backup.`,
  },
  {
    id: 'emi',
    title: 'Convert big purchases to EMI',
    opening: 'Convert big-ticket purchases to EMI',
    truth: `You run EMI and lending campaigns at IndusInd Bank.
- Goal: customers convert card purchases above ₹10,000 into EMI.
- Success: number of purchases converted to EMI (a count, not rupee value).
- Who converts today: repeat EMI users; most who convert do it within 30 minutes of the purchase.
- Why the rest don't: they don't realise the purchase qualifies; some think the interest is too high.
- Offer: reduced processing fee of ₹99 for this campaign.
- Guardrails: no more than 3 messages per purchase; don't spam.`,
  },
].filter((s) => !ONLY || s.id === ONLY);

// --- model helpers ------------------------------------------------------------
async function claude(system, user, maxTokens = 1500) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (res.ok) {
      const j = await res.json();
      return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    if (attempt === 2) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
}
const parseJson = (t) => {
  const m = String(t).match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
};

const managerSystem = (truth) => `You are role-playing a busy campaign manager at an Indian bank, talking to an AI campaign designer. Facts you know (only share what is asked, briefly, in your own words):
${truth}
Behave realistically: short answers, no essays. If asked something not covered by your facts, say you're not sure or you don't track it. If the agent shows you a brief or plan that matches your goal reasonably well, approve it. If it is waiting for your go-ahead, give it.`;

async function managerFreeReply(truth, transcript, agentText, questions) {
  const qs = questions?.length ? `\n\nThe questions it asked:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : '';
  return (
    (await claude(
      managerSystem(truth),
      `Conversation so far:\n${transcript}\n\nThe agent just said:\n"""${agentText}"""${qs}\n\nWrite your reply as the manager. Reply text only.`,
      600,
    )) || 'Go ahead.'
  ).trim();
}

async function managerFormAnswers(truth, transcript, questions) {
  const spec = questions
    .map((q) => `- id ${q.id} [${q.aspect}] (${q.answerType}) ${q.text}${q.options?.length ? `\n  options: ${q.options.map((o) => JSON.stringify(o)).join(' | ')} | "Other" (free text)` : ''}${q.suggestions?.length ? `\n  examples: ${q.suggestions.join(' | ')}` : ''}`)
    .join('\n');
  const out = parseJson(
    await claude(
      managerSystem(truth),
      `Conversation so far:\n${transcript}\n\nThe agent sent you a form. Answer it as the manager would.\n${spec}\n\nReturn ONLY JSON: {"answers": {"<id>": {"pick": ["<exact option text>", ...], "other": "<free text or empty>", "text": "<for open questions>"}}}. For single choice pick at most one option. Use "other" only if no option fits. Leave a question out if you would genuinely skip it.`,
      1500,
    ),
  );
  return out?.answers ?? {};
}

// --- SSE ----------------------------------------------------------------------
async function sse(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  let result = null;
  let error = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = frame.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
      const data = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!data) continue;
      let p;
      try {
        p = JSON.parse(data.slice(5).trim());
      } catch {
        continue;
      }
      if (ev === 'event') events.push(p);
      else if (ev === 'result') result = p;
      else if (ev === 'error') error = p.error;
    }
  }
  if (!result) throw new Error(error || 'stream ended without a result');
  return { result, events };
}

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const graphStats = (g) => {
  const nodes = Object.values(g?.nodes ?? {});
  return { steps: nodes.length, sends: nodes.filter((n) => n.type === 'SEND').length, forks: nodes.filter((n) => ['SPLIT', 'DECISION_SPLIT', 'EXPERIMENT'].includes(n.type)).length };
};

// --- v2 driver ------------------------------------------------------------------
async function runV2(sc) {
  const t0 = Date.now();
  const sessionId = `ab-v2-${sc.id}-${Date.now().toString(36)}`;
  const messages = [{ role: 'user', content: sc.opening }];
  const log = [{ role: 'manager', text: sc.opening, kind: 'typed' }];
  let state = null;
  let pending = { answers: undefined, action: null };
  const m = { turns: 0, questions: [], managerWordsTyped: words(sc.opening), clicks: 0, signoffs: 0, errors: [], toolCalls: {}, built: null, flagsByTurn: [] };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    m.turns++;
    let r;
    try {
      ({ result: r } = await sse('/api/agent/stream', { sessionId, tenantId: 'TEN-IBL', messages, state, answers: pending.answers, action: pending.action }));
    } catch (e) {
      m.errors.push(String(e.message || e));
      break;
    }
    state = r.state;
    for (const e of r.events ?? []) if (e.type === 'model.tool_call.completed' || e.type === 'model.tool_call.failed') m.toolCalls[e.data?.tool] = (m.toolCalls[e.data?.tool] ?? 0) + 1;
    if (r.error) m.errors.push(r.errorDetail || r.error);
    messages.push({ role: 'assistant', content: r.reply || '…' });
    const tools = (r.events ?? []).filter((e) => e.type === 'model.tool_call.completed').map((e) => e.title);
    log.push({ role: 'agent', text: r.reply, tools, questions: r.questionItems });
    m.flagsByTurn.push(Object.entries(state.flags).filter(([, v]) => v).map(([k]) => k));
    m.questions.push(...(r.questionItems ?? []));
    if (r.graph) m.built = { ...graphStats(r.graph), notes: r.buildNotes ?? [] };
    if (state.flags.campaignBuilt) break;

    const transcript = log.map((l) => `${l.role}: ${l.text ?? ''}`).join('\n');
    const open = (state.questions ?? []).filter((q) => !q.answer);
    const fromThisTurn = (r.questionItems ?? []).filter((q) => open.some((o) => o.id === q.id));
    pending = { answers: undefined, action: null };
    if (state.pendingSignoff) {
      const text = `Signed off the ${state.pendingSignoff}.`;
      pending.action = { type: 'signoff', section: state.pendingSignoff };
      messages.push({ role: 'user', content: text });
      log.push({ role: 'manager', text, kind: 'click' });
      m.clicks++;
      m.signoffs++;
    } else if (fromThisTurn.length) {
      const a = await managerFormAnswers(sc.truth, transcript, fromThisTurn);
      const answers = {};
      const lines = [];
      for (const q of fromThisTurn) {
        const x = a[q.id];
        if (!x) continue;
        let val;
        if (q.answerType === 'open') {
          val = String(x.text || x.other || (x.pick ?? [])[0] || '').trim();
          if (val) m.managerWordsTyped += (q.suggestions ?? []).includes(val) ? 0 : words(val);
          if (val && (q.suggestions ?? []).includes(val)) m.clicks++;
        } else {
          const picks = (x.pick ?? []).filter((p) => (q.options ?? []).includes(p));
          const usePicks = q.answerType === 'single' ? picks.slice(0, 1) : picks;
          m.clicks += usePicks.length;
          const other = String(x.other || '').trim();
          if (other) {
            m.clicks++;
            m.managerWordsTyped += words(other);
          }
          val = [...usePicks, other ? `Other: ${other}` : ''].filter(Boolean).join(', ');
        }
        if (val) {
          answers[q.id] = val;
          lines.push(`- ${q.text} → ${val}`);
        }
      }
      const text = lines.join('\n') || 'Not sure about these.';
      pending.answers = Object.keys(answers).length ? answers : undefined;
      messages.push({ role: 'user', content: text });
      log.push({ role: 'manager', text, kind: 'form' });
    } else {
      const text = await managerFreeReply(sc.truth, transcript, r.reply, []);
      m.managerWordsTyped += words(text);
      messages.push({ role: 'user', content: text });
      log.push({ role: 'manager', text, kind: 'typed' });
    }
  }
  const pf = state?.planFile ?? null;
  return {
    pipeline: 'v2',
    scenario: sc.id,
    seconds: Math.round((Date.now() - t0) / 1000),
    metrics: m,
    finalFlags: state?.flags,
    timeline: state?.timeline ?? [],
    plan: pf ? { brief: pf.brief, strategy: pf.strategy, journey: pf.journey?.blueprint ?? null } : null,
    log,
  };
}

// --- v1 driver ------------------------------------------------------------------
async function runV1(sc) {
  const t0 = Date.now();
  const sessionId = `ab-v1-${sc.id}-${Date.now().toString(36)}`;
  const messages = [{ role: 'user', content: sc.opening }];
  const log = [{ role: 'manager', text: sc.opening, kind: 'typed' }];
  let brief = null;
  let session = null;
  let rounds = 0;
  let pendingBlueprint = null;
  let pendingStrategy = null;
  let intent = 'converse';
  let lastStrategy = null;
  let lastBlueprint = null;
  const m = { turns: 0, questions: [], managerWordsTyped: words(sc.opening), clicks: 0, signoffs: 0, errors: [], toolCalls: {}, built: null, phases: [] };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    m.turns++;
    let r;
    try {
      ({ result: r } = await sse('/api/designer/stream', {
        sessionId,
        tenantId: 'TEN-IBL',
        messages,
        discoveryRounds: rounds,
        intent,
        confirmedBlueprint: intent === 'confirm' ? pendingBlueprint : null,
        confirmedStrategy: intent === 'confirm' ? pendingStrategy : null,
        brief,
        session,
      }));
    } catch (e) {
      m.errors.push(String(e.message || e));
      break;
    }
    brief = r.brief ?? brief;
    session = r.session ?? session;
    rounds = r.discoveryRounds ?? rounds;
    if (r.strategy) lastStrategy = r.strategy;
    if (r.pendingBlueprint) lastBlueprint = r.pendingBlueprint;
    if (r.blueprint) lastBlueprint = r.blueprint;
    m.phases.push(r.phase);
    for (const e of r.events ?? []) if (e.type === 'model.tool_call.completed' || e.type === 'model.tool_call.failed') m.toolCalls[e.data?.tool] = (m.toolCalls[e.data?.tool] ?? 0) + 1;
    if (r.phase === 'error' || r.errorDetail) m.errors.push(r.errorDetail || r.reply);
    messages.push({ role: 'assistant', content: r.reply || '…' });
    log.push({ role: 'agent', text: r.reply, questions: (r.questions ?? []).map((t) => ({ text: t })) });
    m.questions.push(...(r.questions ?? []).map((t) => ({ text: t, answerType: 'free text', aspect: '—' })));
    if (r.graph) {
      m.built = { ...graphStats(r.graph), notes: [...(r.buildIssues ?? []).map((i) => i.problem), ...(r.campaignBlockers ?? [])] };
      break;
    }
    intent = 'converse';
    if (r.phase === 'awaiting-confirmation') {
      pendingBlueprint = r.pendingBlueprint ?? null;
      pendingStrategy = r.strategy ?? null;
      intent = 'confirm';
      const text = 'Confirmed. Build this campaign.';
      messages.push({ role: 'user', content: text });
      log.push({ role: 'manager', text, kind: 'click' });
      m.clicks++;
      m.signoffs++;
      continue;
    }
    const transcript = log.map((l) => `${l.role}: ${l.text ?? ''}`).join('\n');
    const text = await managerFreeReply(sc.truth, transcript, r.reply, r.questions ?? []);
    m.managerWordsTyped += words(text);
    messages.push({ role: 'user', content: text });
    log.push({ role: 'manager', text, kind: 'typed' });
  }
  return {
    pipeline: 'v1',
    scenario: sc.id,
    seconds: Math.round((Date.now() - t0) / 1000),
    metrics: m,
    plan: { brief: brief ? { findings: summariseV1Brief(brief) } : null, strategy: lastStrategy, journey: lastBlueprint },
    log,
  };
}

function summariseV1Brief(b) {
  const out = [];
  if (b.objective) out.push({ aspect: 'Objective', text: String(b.objective) });
  for (const s of b.successCriteria ?? []) out.push({ aspect: 'Success', text: typeof s === 'string' ? s : s.text ?? JSON.stringify(s) });
  if (b.converters?.shape) out.push({ aspect: 'Who', text: b.converters.shape });
  for (const x of b.barriers ?? []) out.push({ aspect: 'Why not', text: x.statement ?? x.text ?? x.id ?? JSON.stringify(x) });
  return out;
}

// --- judge --------------------------------------------------------------------
async function judge(sc, a, b) {
  const flip = Math.random() < 0.5;
  const [first, second] = flip ? [b, a] : [a, b];
  const show = (r) =>
    JSON.stringify(
      {
        reachedBuiltCampaign: !!r.metrics.built,
        built: r.metrics.built,
        managerTurns: r.metrics.turns,
        questionsAsked: r.metrics.questions.map((q) => q.text),
        strategy: r.plan?.strategy,
        journey: r.plan?.journey,
        transcript: r.log.map((l) => `${l.role}: ${String(l.text ?? '').slice(0, 1200)}`).join('\n'),
      },
      null,
      0,
    ).slice(0, 45000);
  const out = parseJson(
    await claude(
      'You are a senior CRM strategist at an Indian bank, judging two AI campaign-designer sessions for the same goal. Be strict and concrete.',
      `Goal: "${sc.opening}". What the manager actually knew:\n${sc.truth}\n\nSESSION A:\n${show(first)}\n\nSESSION B:\n${show(second)}\n\nScore each session 1-10 on: strategy (is the approach right for the goal and facts), journey (is the built/planned journey sound: entry, goal, timing, channels, reacting to the customer, a sensible test), fidelity (does it use what the manager said, without inventing facts), experience (was the conversation easy for a busy manager: few, simple, relevant questions; reached a result), and overall. Return ONLY JSON: {"A":{"strategy":n,"journey":n,"fidelity":n,"experience":n,"overall":n},"B":{...},"winner":"A"|"B"|"tie","why":"2-3 sentences"}`,
      1200,
    ),
  );
  if (!out) return null;
  const map = (k) => (flip ? (k === 'A' ? 'v2' : 'v1') : k === 'A' ? 'v1' : 'v2');
  return { v1: flip ? out.B : out.A, v2: flip ? out.A : out.B, winner: out.winner === 'tie' ? 'tie' : map(out.winner), why: out.why };
}

// --- main -----------------------------------------------------------------------
const started = new Date();
console.log(`A/B on ${SCENARIOS.map((s) => s.id).join(', ')} against ${BASE}, model ${MODEL}, up to ${MAX_TURNS} turns`);
const runs = await Promise.all(
  SCENARIOS.flatMap((sc) => [
    PIPE === 'v2' ? null : runV1(sc).then((r) => (console.log(`v1 ${sc.id}: ${r.metrics.turns} turns, built=${!!r.metrics.built}, ${r.seconds}s`), r)),
    PIPE === 'v1' ? null : runV2(sc).then((r) => (console.log(`v2 ${sc.id}: ${r.metrics.turns} turns, built=${!!r.metrics.built}, ${r.seconds}s`), r)),
  ].filter(Boolean)),
);
const results = [];
for (const sc of SCENARIOS) {
  const v1 = runs.find((r) => r.pipeline === 'v1' && r.scenario === sc.id);
  const v2 = runs.find((r) => r.pipeline === 'v2' && r.scenario === sc.id);
  let verdict = null;
  if (v1 && v2) try {
    verdict = await judge(sc, v1, v2);
  } catch (e) {
    verdict = { error: String(e.message || e) };
  }
  console.log(`judge ${sc.id}: ${verdict?.winner ?? 'n/a'}`);
  results.push({ scenario: sc, v1, v2, verdict });
}
const stamp = started.toISOString().replace(/[:.]/g, '-');
mkdirSync(here, { recursive: true });
const jsonPath = resolve(here, `results-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify({ startedAt: started.toISOString(), model: MODEL, maxTurns: MAX_TURNS, results }, null, 1));
const htmlPath = OUT ? resolve(OUT) : resolve(here, `report-${stamp}.html`);
writeFileSync(htmlPath, renderReport({ startedAt: started.toISOString(), model: MODEL, maxTurns: MAX_TURNS, results }));
console.log(`\nResults: ${jsonPath}\nReport:  ${htmlPath}`);
