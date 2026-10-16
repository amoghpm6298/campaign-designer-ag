// Runs the fixed scenarios against the REAL orchestrator and records a
// versioned baseline.
//
// Read-only with respect to the product: it imports the server modules and
// calls them exactly as the browser client does. It changes no prompt, no
// gate, and no behaviour.
//
//   node --experimental-strip-types --import ./agent-proto/register.mjs \
//        eval/run.ts [scenarioId ...]
//
// Transport failures are retried and counted SEPARATELY from quality failures.
// A run that never produced an answer is not evidence about discovery.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrateStream } from '../server/orchestrator';
import { seedKnowledgeBase } from '../server/knowledge';
import { SCENARIOS, type Scenario } from './scenarios';
import { discoveryChecks, strategyChecks, qualitativeNotes, type Check, type TurnRecord } from './assertions';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const OUT = resolve(HERE, 'baselines');

function loadEnv() {
  try {
    for (const line of readFileSync(resolve(APP, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* a real shell variable may still be set */ }
}

const MAX_TRANSPORT_RETRIES = 4;

async function oneTurn(state: Record<string, unknown>, textIn: string) {
  const messages = [...(state.messages as { role: string; content: string }[]), { role: 'user', content: textIn }];
  const gen = orchestrateStream({
    sessionId: state.sessionId,
    tenantId: 'TEN-IBL',
    knowledge: state.knowledge,
    discoveryRounds: state.discoveryRounds ?? 0,
    brief: state.brief ?? null,
    session: state.session ?? null,
    currentCampaign: null,
    messages,
  } as never);
  let out = await gen.next();
  while (!out.done) out = await gen.next();
  const res = out.value as unknown as TurnRecord & Record<string, unknown>;
  return { res, messages };
}

async function runScenario(s: Scenario) {
  const knowledge = seedKnowledgeBase();
  const state: Record<string, unknown> = {
    sessionId: `eval-${s.id}-${Date.now()}`,
    knowledge,
    messages: [] as { role: string; content: string }[],
    brief: null,
    session: null,
    discoveryRounds: 0,
  };
  const turns: TurnRecord[] = [];
  const transport: string[] = [];

  for (const [i, textIn] of s.turns.entries()) {
    let ok = false;
    for (let attempt = 1; attempt <= MAX_TRANSPORT_RETRIES && !ok; attempt++) {
      const { res, messages } = await oneTurn(state, textIn);
      if (res.phase === 'error') {
        transport.push(`turn ${i + 1} attempt ${attempt}: ${String(res.reply).slice(0, 110)}`);
        continue; // state not advanced: the failed turn is discarded entirely
      }
      state.messages = [...messages, { role: 'assistant', content: String(res.reply ?? '') }];
      state.brief = res.brief;
      state.session = (res as Record<string, unknown>).session;
      state.discoveryRounds = (res as Record<string, unknown>).discoveryRounds ?? state.discoveryRounds;
      turns.push(res);
      ok = true;
      process.stdout.write(`    turn ${i + 1}: ${res.phase}\n`);
    }
    if (!ok) {
      process.stdout.write(`    turn ${i + 1}: GAVE UP after ${MAX_TRANSPORT_RETRIES} transport failures\n`);
      break;
    }
  }

  const checks: Check[] = turns.length
    ? [...discoveryChecks(s, turns), ...strategyChecks(s, turns)]
    : [];
  return { scenario: s.id, title: s.title, probes: s.probes, turns, checks, transport, notes: qualitativeNotes(turns) };
}

async function main() {
  loadEnv();
  const want = process.argv.slice(2);
  const run = want.length ? SCENARIOS.filter((s) => want.includes(s.id)) : SCENARIOS;
  const results = [];
  for (const s of run) {
    process.stdout.write(`\n${s.id} — ${s.title}\n`);
    results.push(await runScenario(s));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const file = resolve(OUT, `baseline-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ at: stamp, results }, null, 1));

  // --- summary ------------------------------------------------------------
  const tally = (g: 'discovery' | 'strategy') => {
    const cs = results.flatMap((r) => r.checks.filter((c) => c.group === g));
    const pass = cs.filter((c) => c.outcome === 'pass').length;
    const fail = cs.filter((c) => c.outcome === 'fail').length;
    const na = cs.filter((c) => c.outcome === 'n/a').length;
    return { pass, fail, na, total: pass + fail };
  };
  process.stdout.write('\n' + '='.repeat(74) + '\nBASELINE\n' + '='.repeat(74) + '\n');
  for (const r of results) {
    const t = r.transport.length ? `  [${r.transport.length} transport failure(s)]` : '';
    process.stdout.write(`\n${r.scenario}${t}\n`);
    for (const c of r.checks) {
      const mark = c.outcome === 'pass' ? 'PASS' : c.outcome === 'fail' ? 'FAIL' : ' -- ';
      process.stdout.write(`  ${mark} ${c.id} ${c.asks}\n       ${c.detail.slice(0, 150)}\n`);
    }
  }
  const d = tally('discovery');
  const st = tally('strategy');
  process.stdout.write(
    `\nDISCOVERY ${d.pass}/${d.total} passed (${d.na} n/a)\n` +
    `STRATEGY  ${st.pass}/${st.total} passed (${st.na} n/a)\n` +
    `\nsaved: ${file}\n` +
    `\nNOTE: these are mechanical checks on decisions. They do not score whether\n` +
    `the questions were GOOD or the campaign was SMART — see the qualitative\n` +
    `notes in the saved file for what a human must read.\n`,
  );
}

await main();
