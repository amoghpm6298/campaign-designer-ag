// Runs the ten evaluation objectives through the REAL agent and writes one
// record per scenario for a human to assess.
//
// Deliberately not a vitest file. Campaign-design quality is not mechanically
// checkable — agent-proto/validate.ts has said so since the beginning, in the
// 'campaign-quality' check it records as permanently not-run — so this script
// gathers the evidence and a person applies the rubric. Making it a test would
// mean inventing an assertion that quality had been proven, which is exactly
// the claim this prototype refuses to make everywhere else.
//
// Run:  node --experimental-strip-types --import ./agent-proto/register.mjs \
//            agent-proto/evaluateScenarios.ts [scenarioId ...]
// Needs ANTHROPIC_API_KEY. Costs real calls; takes a few minutes per scenario.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrateStream } from '../server/orchestrator.ts';
import { seedKnowledgeBase } from '../server/knowledge.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface Scenario {
  id: string;
  title: string;
  objective: string;
  clarification?: string;
  reasoning: string;
  watchFor: string[];
}

/** The server reads its key from the environment; load .env the way Vite does. */
function loadEnv() {
  try {
    for (const line of readFileSync(resolve(here, '../.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .env; a real shell variable may still be set */
  }
}

async function runTurn(messages: { role: 'user' | 'assistant'; content: string }[], brief: unknown, session: unknown) {
  const gen = orchestrateStream({
    sessionId: `eval-${Date.now()}`,
    tenantId: 'TEN-IBL',
    knowledge: seedKnowledgeBase(),
    discoveryRounds: 0,
    messages,
    brief,
    session,
  } as never);
  let out = await gen.next();
  const tools: string[] = [];
  while (!out.done) {
    const e = out.value as { type: string; title?: string };
    if (e.type === 'model.tool_call.completed') tools.push(e.title ?? '');
    out = await gen.next();
  }
  return { res: out.value as Record<string, any>, tools }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Everything a reviewer needs, and nothing the model said privately. */
function record(s: Scenario, turns: Record<string, unknown>[]) {
  return { id: s.id, title: s.title, objective: s.objective, reviewerNotes: s.reasoning, watchFor: s.watchFor, turns };
}

async function main() {
  loadEnv();
  const set = JSON.parse(readFileSync(resolve(here, 'scenarios/evaluation-set.json'), 'utf8')) as {
    scenarios: Scenario[];
  };
  const only = process.argv.slice(2);
  const scenarios = only.length ? set.scenarios.filter((s) => only.includes(s.id)) : set.scenarios;

  const outDir = resolve(here, 'runs/evaluation');
  mkdirSync(outDir, { recursive: true });

  for (const s of scenarios) {
    const started = Date.now();
    process.stdout.write(`\n=== ${s.id} — ${s.title}\n`);
    const turns: Record<string, unknown>[] = [];
    try {
      let messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: s.objective }];
      let { res, tools } = await runTurn(messages, null, null);
      turns.push(summarise(res, tools));
      report(res, tools, Date.now() - started);

      // A second turn only where the scenario supplies a clarification, so the
      // agent's handling of corrected facts is visible too.
      if (s.clarification) {
        messages = [...messages, { role: 'assistant', content: String(res.reply ?? '') }, { role: 'user', content: s.clarification }];
        const t2 = Date.now();
        ({ res, tools } = await runTurn(messages, res.brief, res.session));
        turns.push(summarise(res, tools));
        report(res, tools, Date.now() - t2);
      }
    } catch (e) {
      turns.push({ error: (e as Error).message });
      process.stdout.write(`  FAILED: ${(e as Error).message}\n`);
    }
    writeFileSync(resolve(outDir, `${s.id}.json`), JSON.stringify(record(s, turns), null, 2) + '\n');
  }
  process.stdout.write(`\nRecords written to ${outDir}\n`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarise(res: Record<string, any>, tools: string[]) {
  return {
    phase: res.phase,
    toolsUsed: tools,
    questions: res.questions,
    strategy: res.strategy,
    openItems: res.graphReadiness ? undefined : undefined,
    entry: res.blueprint?.entry,
    goal: res.blueprint?.goal,
    steps: (res.blueprint?.steps ?? []).map((st: Record<string, unknown>) => ({
      kind: st.kind,
      name: st.name,
      copy: st.copy,
      cta: st.cta,
      durationHours: st.durationHours,
      timeoutDays: st.timeoutDays,
    })),
    graphReadiness: res.graphReadiness,
    reply: res.reply,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function report(res: Record<string, any>, tools: string[], ms: number) {
  process.stdout.write(`  ${Math.round(ms / 1000)}s | phase ${res.phase} | ${tools.length} lookups\n`);
  if (res.blueprint?.entry) process.stdout.write(`  entry: ${JSON.stringify(res.blueprint.entry)}\n`);
  if (res.blueprint?.goal) process.stdout.write(`  goal:  ${JSON.stringify(res.blueprint.goal)}\n`);
  for (const q of res.questions ?? []) process.stdout.write(`  Q: ${q}\n`);
  if (res.phase === 'error') process.stdout.write(`  ERROR: ${res.reply}\n`);
}

await main();
