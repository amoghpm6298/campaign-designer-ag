// Runs each counterfactual pair against the REAL orchestrator and reports
// whether a material change to the business problem changed the campaign.
//
//   node --experimental-strip-types --import ./agent-proto/register.mjs \
//        eval/runCounterfactual.ts [pairId ...]
//
// Read-only with respect to the product: it changes no prompt, no gate, no
// behaviour. Transport failures are retried and counted separately, for the
// same reason as the main harness — a run that never answered is not evidence
// about reasoning.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrateStream } from '../server/orchestrator';
import { seedKnowledgeBase } from '../server/knowledge';
import { PAIRS, type CounterfactualPair, type Arm } from './counterfactuals';
import { compare, experimentArms, signature, type DivergenceResult } from './divergence';
import type { CampaignBlueprint } from '../server/blueprint';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const OUT = resolve(HERE, 'baselines');
const MAX_TRANSPORT_RETRIES = 4;

function loadEnv() {
  try {
    for (const line of readFileSync(resolve(APP, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* a real shell variable may still be set */ }
}

interface ArmRun {
  label: string;
  phase: string;
  reply: string;
  blueprint: CampaignBlueprint | null;
  /** The chosen architecture's own words. Reported, never scored. */
  mechanism: string;
  whyChosen: string;
  architectureCount: number;
  questions: string[];
  transport: string[];
  truncated: boolean;
  turnsRun: number;
}

async function runArm(arm: Arm, idTag: string): Promise<ArmRun> {
  const state: Record<string, unknown> = {
    sessionId: `cf-${idTag}-${Date.now()}`,
    knowledge: seedKnowledgeBase(),
    messages: [] as { role: string; content: string }[],
    brief: null,
    session: null,
    discoveryRounds: 0,
  };
  const transport: string[] = [];
  const questions: string[] = [];
  let last: Record<string, unknown> | null = null;
  /** The latest turn that actually carried a campaign. See the loop below. */
  let proposal: Record<string, unknown> | null = null;
  let done = 0;

  for (const [i, textIn] of arm.turns.entries()) {
    let ok = false;
    for (let attempt = 1; attempt <= MAX_TRANSPORT_RETRIES && !ok; attempt++) {
      const messages = [...(state.messages as { role: string; content: string }[]), { role: 'user', content: textIn }];
      const gen = orchestrateStream({
        sessionId: state.sessionId, tenantId: 'TEN-IBL', knowledge: state.knowledge,
        discoveryRounds: state.discoveryRounds ?? 0, brief: state.brief ?? null,
        session: state.session ?? null, currentCampaign: null, messages,
      } as never);
      let o = await gen.next();
      while (!o.done) o = await gen.next();
      const res = o.value as unknown as Record<string, unknown>;
      if (res.phase === 'error') {
        const why = `turn ${i + 1} attempt ${attempt}: ${String(res.reply).slice(0, 110)}`;
        transport.push(why);
        // Printed, not just collected. Twice now a run has reported GAVE UP
        // with the reason sitting only in an array that is written to the JSON
        // at the end — so a failure in flight was undiagnosable exactly when
        // knowing the cause would have changed what to do about it.
        process.stdout.write(`      ${arm.label} TRANSPORT ${why}\n`);
        continue;
      }
      state.messages = [...messages, { role: 'assistant', content: String(res.reply ?? '') }];
      state.brief = res.brief;
      state.session = res.session;
      state.discoveryRounds = res.discoveryRounds ?? state.discoveryRounds;
      questions.push(...((res.questions as string[]) ?? []));
      last = res;
      done++;
      ok = true;
      process.stdout.write(`      ${arm.label} turn ${i + 1}: ${res.phase}\n`);
    }
    if (!ok) { process.stdout.write(`      ${arm.label} turn ${i + 1}: GAVE UP\n`); break; }

    // Keep the latest turn that actually carried a campaign.
    //
    // DO NOT STOP EARLY HERE. An earlier version did, on the reasoning that
    // the trailing turns were only needed to REACH a proposal — and it
    // invalidated the first verdict this harness produced. One arm proposed at
    // turn 2 and so never received turn 3's audience instruction; the other
    // hit timeouts and ran on. The two arms were then given different inputs,
    // which is enough to make any pair "diverge" on its own and tells us
    // nothing about the business fact the pair varies.
    //
    // Both arms must see identical turns. Tracking the last record that held a
    // blueprint gets the same protection the early stop was reaching for —
    // a later turn cannot erase the campaign — without biasing the input.
    if (last?.phase === 'awaiting-confirmation' && last?.pendingBlueprint) proposal = last;
  }

  // Read from the turn that produced a campaign, falling back to the last
  // turn when none did. Without this, a trailing "go ahead and propose" sent
  // after a proposal already exists can move the session on and clear
  // pendingBlueprint, discarding the thing being compared.
  const src = proposal ?? last;
  const strategy = (src?.strategy ?? null) as
    | { architectures?: { mechanism?: string; whyChosen?: string; chosen?: boolean }[] }
    | null;
  const chosen = strategy?.architectures?.find((a) => a.chosen) ?? strategy?.architectures?.[0];
  return {
    label: arm.label,
    phase: String(src?.phase ?? 'none'),
    reply: String(src?.reply ?? ''),
    blueprint: (src?.pendingBlueprint ?? null) as CampaignBlueprint | null,
    mechanism: chosen?.mechanism ?? '',
    whyChosen: chosen?.whyChosen ?? '',
    architectureCount: strategy?.architectures?.length ?? 0,
    questions,
    transport,
    // Truncated means no campaign was ever produced. Every arm now runs every
    // turn, so a short run means transport gave up, not that it finished early.
    truncated: !proposal,
    /** Recorded so an asymmetry between arms can never hide again. */
    turnsRun: done,
  };
}

type Verdict = DivergenceResult['verdict'] | 'needs-human' | 'inconclusive';

interface PairResult {
  pair: string;
  title: string;
  a: ArmRun;
  b: ArmRun;
  divergence: DivergenceResult | null;
  verdict: Verdict;
  note: string;
}

async function runPair(p: CounterfactualPair): Promise<PairResult> {
  process.stdout.write(`\n  ${p.id} — ${p.title}\n`);
  const a = await runArm(p.a, `${p.id}-a`);
  const b = await runArm(p.b, `${p.id}-b`);

  // A run that never answered, or never reached a proposal, is not evidence
  // about reasoning. Say so rather than scoring it.
  if (a.truncated || b.truncated)
    return { pair: p.id, title: p.title, a, b, divergence: null, verdict: 'inconclusive',
      note: 'one or both arms never produced a campaign — transport, not reasoning' };

  // THE CONFOUND GUARD. A pair is only evidence if both arms were asked the
  // same things. The first verdict this harness produced was DIVERGED on all
  // four aspects, and it was worthless: one arm had proposed early and so
  // never received the turn naming the audience, while the other ran on. Two
  // arms given different inputs will differ for that reason alone.
  //
  // Checked rather than trusted, because I had reasoned that it was fine.
  if (a.turnsRun !== b.turnsRun)
    return { pair: p.id, title: p.title, a, b, divergence: null, verdict: 'inconclusive',
      note: `arms were given different inputs — ${a.label} ran ${a.turnsRun} turns, ${b.label} ran ${b.turnsRun}. Any difference between the campaigns could be that, so this pair is not evidence.` };

  // No blueprint in arm B is the case the pair may have been built to allow.
  // It is NOT auto-passed: "a campaign is the wrong instrument here, and here
  // is what would work" and "the model failed to produce a design" are
  // different things, and nothing mechanical can tell them apart.
  if (!b.blueprint || !a.blueprint)
    return { pair: p.id, title: p.title, a, b, divergence: null, verdict: 'needs-human',
      note: p.passIfNotExecutable
        ? 'an arm produced no campaign, which this pair allows as correct — a human must read the reply and decide whether it declined for the right reason'
        : 'an arm produced no campaign and this pair does not allow that — read the reply' };

  const divergence = compare(a.blueprint, b.blueprint, p.mustDiffer);
  return { pair: p.id, title: p.title, a, b, divergence, verdict: divergence.verdict, note: '' };
}

/** One pair's findings, printed as soon as the pair finishes. */
function pairSection(r: PairResult, p: CounterfactualPair) {
  const L: string[] = [];
  const line = (s = '') => L.push(s);
  {
    line(`\n${'-'.repeat(78)}\n${r.pair}  [${r.verdict.toUpperCase()}]`);
    line(`  ${p.title}`);
    line(`  varies: ${p.varies}`);
    line(`  must differ: ${p.mustDiffer.join(', ')}`);
    // Printed on every pair, pass or fail. The asymmetry that invalidated the
    // first verdict was invisible in the report, and visible only by digging
    // into the raw log — so it goes on the face of the result from now on.
    line(`  turns given: ${r.a.label} ${r.a.turnsRun}, ${r.b.label} ${r.b.turnsRun}${r.a.turnsRun === r.b.turnsRun ? ' (equal)' : ' — NOT EQUAL, see note'}`);
    if (r.note) line(`  NOTE: ${r.note}`);

    if (r.divergence) {
      line('\n  STRUCTURAL COMPARISON');
      for (const asp of r.divergence.aspects) {
        const tag = asp.differs ? 'DIFFERS ' : 'SAME    ';
        const required = p.mustDiffer.includes(asp.aspect) ? ' (required)' : '';
        line(`    ${tag}${asp.aspect}${required}`);
        if (asp.differs) {
          line(`        ${r.a.label}: ${asp.a.slice(0, 120)}`);
          line(`        ${r.b.label}: ${asp.b.slice(0, 120)}`);
        } else {
          line(`        both: ${asp.a.slice(0, 120)}`);
        }
      }
      if (r.divergence.identical)
        line('\n    THE TWO CAMPAIGNS ARE STRUCTURALLY IDENTICAL. Nothing the user said changed the design.');
    }

    for (const [armLabel, arm] of [[r.a.label, r.a], [r.b.label, r.b]] as [string, ArmRun][]) {
      const exp = experimentArms(arm.blueprint);
      const bad = exp.filter((e) => e.cannotDiscriminate);
      if (bad.length)
        line(`\n  EXPERIMENT CANNOT DISCRIMINATE (${armLabel}): ${bad.map((e) => `"${e.label}" — arms ${e.collidingArms.join(' / ')} are the same journey`).join('; ')}`);
    }

    line('\n  MECHANISM, AS THE AGENT DESCRIBED IT  (reported, never scored — a label is not a strategy)');
    line(`    ${r.a.label} (${r.a.architectureCount} architectures): ${r.a.mechanism.slice(0, 220) || '(none recorded)'}`);
    line(`    ${r.b.label} (${r.b.architectureCount} architectures): ${r.b.mechanism.slice(0, 220) || '(none recorded)'}`);

    if (p.knownPlatformLimit) line(`\n  KNOWN PLATFORM LIMIT: ${p.knownPlatformLimit}`);
    line(`\n  A HUMAN MUST JUDGE: ${p.humanMustJudge}`);
  }
  return L.join('\n');
}

function tally(rs: PairResult[]) {
  const L: string[] = [];
  const line = (s = '') => L.push(s);
  const n = (v: Verdict) => rs.filter((r) => r.verdict === v).length;
  line('\n' + '='.repeat(78));
  line(`diverged ${n('diverged')}  partial ${n('partial')}  identical ${n('identical')}  needs-human ${n('needs-human')}  inconclusive ${n('inconclusive')}   of ${rs.length}`);
  line('');
  line('A "diverged" verdict means the two campaigns are not the same campaign.');
  line('It does NOT mean either campaign is good. That judgement is not in this');
  line('file and cannot be — read the mechanism lines and the questions asked.');
  return L.join('\n');
}

async function main() {
  loadEnv();
  const want = process.argv.slice(2);
  const run = want.length ? PAIRS.filter((p) => want.includes(p.id)) : PAIRS;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const file = resolve(OUT, `counterfactual-${stamp}.json`);

  // Persist after EVERY pair, not at the end.
  //
  // The first attempt at this run was interrupted 11 live turns in and lost
  // all of them, because the file was only written once everything finished.
  // A pair costs minutes of real API calls; losing a completed one to an
  // unrelated interruption is pure waste, and worse, it tempts a rerun with
  // fewer pairs just to get an answer out.
  const rs: PairResult[] = [];
  const flush = () =>
    writeFileSync(file, JSON.stringify({
      at: stamp,
      complete: rs.length === run.length,
      pairsRun: rs.length,
      pairsPlanned: run.length,
      results: rs.map((r) => ({
        ...r,
        aSignature: signature(r.a.blueprint),
        bSignature: signature(r.b.blueprint),
      })),
    }, null, 1));
  flush();

  process.stdout.write('\n' + '='.repeat(78) + '\n');
  process.stdout.write('COUNTERFACTUAL BASELINE — did the campaign change when the problem did?\n');
  process.stdout.write('='.repeat(78) + '\n');

  for (const p of run) {
    const r = await runPair(p);
    rs.push(r);
    flush();
    // Printed per pair, so an interrupted run still leaves its finished
    // pairs' findings in the log rather than only in the JSON.
    process.stdout.write(pairSection(r, p) + `\n      [saved ${rs.length}/${run.length}]\n`);
  }

  process.stdout.write(tally(rs));
  process.stdout.write(`\nsaved: ${file}\n`);
}

await main();
