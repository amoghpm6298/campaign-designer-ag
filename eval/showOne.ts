// One cooperative conversation, printed exactly as the user would see it.
//
// Not a scorer. No verdicts, no checks, no signatures. The only question this
// answers is the one no harness can: is the reasoning any good? So it prints
// the full transcript and gets out of the way.
//
//   node --experimental-strip-types --import ./agent-proto/register.mjs \
//        eval/showOne.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrateStream } from '../server/orchestrator';
import { seedKnowledgeBase } from '../server/knowledge';
import { saysProceed } from '../server/record';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(resolve(APP, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* a real shell variable may still be set */ }

/**
 * A campaign manager at the bank, typing the way one actually types.
 *
 * The earlier version of this script put sentences like "We think
 * interest-cost hesitation is the barrier, but we are honestly not certain"
 * in the user's mouth. Nobody says that — it is a product spec read aloud, and
 * it quietly made the agent's job easier by handing it the analysis already
 * framed. A real manager writes short, plain, slightly messy sentences, gives
 * the one or two numbers they happen to know, and says "not sure" like a
 * person rather than like a requirements document.
 *
 * The answers are still COMPLETE: each one genuinely answers what was asked.
 * Vagueness here would test the agent's patience, not its reasoning.
 */
/**
 * Replaceable from disk, so a real session can be replayed verbatim instead of
 * being paraphrased into this file. `SCENARIO=path/to/turns.json` where the
 * file is a JSON array of user messages, in order.
 */
const TURNS: string[] = process.env.SCENARIO
  ? (JSON.parse(readFileSync(resolve(APP, process.env.SCENARIO), 'utf8')) as string[])
  : [
  'we want more customers converting their outstanding balance into EMI. can you set up a drip campaign for this',
  'just the number of people who convert. not the value. no target as such, we just want it going up month on month',
  'go after the ones who have never started a conversion. the people who started one and dropped off are a separate problem, we will do that separately',
  'honestly not sure. my guess is they see the interest and think it is too expensive. but it could just be they do not know the option is there. we have never tested it',
  'we do not have data on that. roughly 40% of the book is eligible at any given time, that is all I can tell you',
  // The agent should come back with candidate segments and its reasoning.
  // This is the manager reacting to them, which is what the gate waits for.
  'the big purchase one sounds more likely to me. we see a lot of large spends on the premium cards and those are the people who ask about EMI at the branch',
  'no that is everything I have. go ahead and build it',
  // Spare turn. The script running out is NOT the agent failing, and an
  // earlier run ended in discovery purely because there was nobody left to
  // answer. A buffer makes that distinction visible instead of ambiguous.
  'looks fine, go ahead',
];

const state: Record<string, unknown> = {
  sessionId: `show-${Date.now()}`,
  knowledge: seedKnowledgeBase(),
  messages: [] as { role: string; content: string }[],
  brief: null, session: null, discoveryRounds: 0,
  phase: null, pendingBlueprint: null, pendingStrategy: null,
};

let approvalMissed = false;
let approved = false;

const rule = (s: string) => `\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`;

// Every live run is written to disk in the shape docs/append-live-run.py reads,
// so it can go into the run log.
//
// THE DEFECT THIS FIXES: this script printed the conversation to stdout and
// kept nothing. The run was real, it was the best output the system had
// produced, and it could not be logged — the log is append-only from turn
// records, and there were none. Worse, the generator's yielded EVENTS were
// being thrown away by the drain loop, so the tool calls and per-round model
// behaviour the log reports were lost even though the run had produced them.
const RUNS = resolve(APP, 'eval/runs');
const LABEL = process.argv[2] ?? 'happy';
const RUN_DIR = resolve(RUNS, `${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(resolve(RUN_DIR, 'turns'), { recursive: true });

// The run log shows the conversation, so it needs the user's side too. The
// turn records hold only the agent's RESPONSE — the first build of the new log
// rendered every turn with the agent talking to nobody, because this file was
// never written.
writeFileSync(
  resolve(RUN_DIR, 'meta.json'),
  JSON.stringify({
    label: LABEL,
    change: process.argv[3] ?? 'Not recorded for this run.',
    turns: TURNS,
  }, null, 1),
);

for (const [i, textIn] of TURNS.entries()) {
  process.stdout.write(rule(`USER — turn ${i + 1}`));
  process.stdout.write(`\n${textIn}\n`);

  let res: Record<string, unknown> | null = null;
  let events: unknown[] = [];
  let ms = 0;
  // Six attempts, not four, and this is HARNESS patience rather than product
  // behaviour — the orchestrator's own timeout and retry are untouched.
  //
  // MEASURED: failures are bimodal. A call either answers in roughly ten to
  // fifteen seconds or hangs past the 180s abort; there is nothing in between.
  // Turn 2 of one run failed three times and then completed in 70 seconds. So
  // the useful lever is more chances at a fresh call, not a longer wait on one
  // that is already stuck — which is also why the product timeout stays where
  // it is. A real user should not wait longer on a call that has already died.
  for (let attempt = 1; attempt <= 6 && !res; attempt++) {
    const messages = [...(state.messages as { role: string; content: string }[]), { role: 'user', content: textIn }];
    const started = Date.now();
    const collected: unknown[] = [];

    // APPROVAL, which this harness could not express until now.
    //
    // THE GAP THIS CLOSES: the designer's Approve button sends
    // `intent: 'confirm'` with the pending strategy and blueprint, and nothing
    // here ever did. So the approve -> journey -> blocker-report path — the
    // whole second half of the product — had never executed outside unit
    // tests. Every recorded run ended in discovery or at a proposal, which is
    // also why "go ahead and build it" in a scenario did nothing: it was read
    // as one more message rather than as the approval it plainly was.
    //
    // Two ways to approve, because both are real. `@confirm` on its own line
    // is the button, pressed deliberately. Otherwise, a reply that says to
    // proceed WHILE a proposal is on the table is treated as approval, which
    // is what a manager typing "looks fine, go ahead" means.
    // `@confirm` means "approve as soon as there IS something to approve",
    // not "approve on turn 7".
    //
    // THE FLAW THIS FIXES, caught by being asked how I knew turn 7 was the
    // approval point: I did not, and nothing checked. Approval requires a
    // proposal on the table, so a scenario whose `@confirm` landed a turn
    // early silently became an ordinary message and the run proved nothing
    // while appearing to pass. A fixed turn index cannot know when the agent
    // will finish discovering.
    const marker = textIn.trim() === '@confirm';
    const ready = state.phase === 'awaiting-confirmation';
    const confirming = ready && (marker || saysProceed(textIn));
    if (marker && !ready) {
      // Loud, not silent. The run is not testing what it claims to test.
      process.stdout.write(
        `\n[CANNOT APPROVE — nothing is on the table. Phase is "${String(state.phase)}", not "awaiting-confirmation". ` +
          'Sending this as an ordinary message instead; the build path is NOT being exercised.]\n',
      );
      approvalMissed = true;
    }
    const gen = orchestrateStream({
      sessionId: state.sessionId, tenantId: 'TEN-IBL', knowledge: state.knowledge,
      discoveryRounds: state.discoveryRounds ?? 0, brief: state.brief ?? null,
      session: state.session ?? null, currentCampaign: null, messages,
      intent: confirming ? 'confirm' : 'converse',
      confirmedBlueprint: confirming ? state.pendingBlueprint : null,
      confirmedStrategy: confirming ? state.pendingStrategy : null,
    } as never);
    if (confirming) { approved = true; process.stdout.write('\n[approving the proposal on the table]\n'); }
    // Collect, do not discard. The yielded values are the run events.
    let o = await gen.next();
    while (!o.done) { collected.push(o.value); o = await gen.next(); }
    const r = o.value as unknown as Record<string, unknown>;
    if (r.phase === 'error') {
      // Print the REASON, not just that it happened. A run that gave up four
      // times on turn 1 left nothing to diagnose from, which is the second
      // time this exact gap has cost a run.
      // NOT TRUNCATED. It was `.slice(0, 200)`, and the one time that mattered
      // it cut the sentence "You will regain access on 2026-11-01 at 00:00
      // UTC" off after "20" — so the run reported a failure whose single
      // actionable fact had been removed by the failure reporter. A diagnostic
      // that truncates the answer is worse than no diagnostic.
      process.stdout.write(`\n[transport attempt ${attempt} failed: ${String(r.reply ?? 'no detail')}]\n`);
      // A usage or auth failure will not fix itself on a retry. Five more
      // attempts against a spend cap is five more identical errors and a
      // minute of waiting.
      if (/usage limit|credit balance|authentication|invalid x-api-key/i.test(String(r.reply ?? ''))) {
        process.stdout.write('[this will not succeed on retry — stopping the run]\n');
        break;
      }
      continue;
    }
    state.messages = [...messages, { role: 'assistant', content: String(r.reply ?? '') }];
    state.brief = r.brief; state.session = r.session;
    state.discoveryRounds = r.discoveryRounds ?? state.discoveryRounds;
    // Carried so the NEXT turn can approve what this one proposed.
    state.phase = r.phase;
    if (r.phase !== 'error') {
      state.pendingBlueprint = r.pendingBlueprint ?? null;
      state.pendingStrategy = r.strategy ?? null;
    }
    res = r;
    events = collected;
    ms = Date.now() - started;
  }
  if (!res) { process.stdout.write('\n[gave up on this turn]\n'); break; }

  writeFileSync(
    resolve(RUN_DIR, 'turns', `turn-${i + 1}.json`),
    JSON.stringify({ ms, events, response: res }, null, 1),
  );

  process.stdout.write(rule(`AGENT — turn ${i + 1}  [${res.phase}]`));
  process.stdout.write(`\n${String(res.reply ?? '(no text)')}\n`);

  // The application's own verdict on the alternatives, which the reply above
  // already carries — printed separately so it is unmissable.
  const st = res.strategy as { architectureComparison?: { status: string; why: string } } | null;
  if (st?.architectureComparison)
    process.stdout.write(`\n[APPLICATION CHECK — alternatives: ${st.architectureComparison.status}]\n${st.architectureComparison.why}\n`);

  // THE BUILT JOURNEY, printed as a shape rather than left in a JSON file.
  //
  // Without this, approving proved nothing: the run log said `phase: review`
  // and the reader had to go digging to find out whether a graph existed, how
  // many steps it had, or whether any path was left open. An open path is the
  // one defect that makes a campaign unshippable, so it is printed first.
  const campaign = res.campaign as
    | { nodes?: Record<string, { type: string; label?: string }>; edges?: unknown[] }
    | null;
  if (campaign?.nodes) {
    const nodes = Object.values(campaign.nodes);
    const kinds = nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.type] = (acc[n.type] ?? 0) + 1;
      return acc;
    }, {});
    process.stdout.write(
      `\n[JOURNEY BUILT — ${nodes.length} nodes, ${(campaign.edges ?? []).length} edges]\n` +
        Object.entries(kinds)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `  ${n} x ${k}`)
          .join('\n') +
        '\n',
    );
  }
  // THE BLOCKER REPORT. A blocker means nothing was built, deliberately: a
  // campaign that silently dropped a requirement is worse than no campaign and
  // a plain statement of what is in the way. Printed whether or not a graph
  // exists, because the interesting case is a blocker ALONGSIDE a partial
  // build.
  const blockers = res.campaignBlockers as string[] | undefined;
  if (blockers?.length)
    process.stdout.write(`\n[BLOCKED — ${blockers.length}]\n${blockers.map((b) => `  - ${b}`).join('\n')}\n`);
  const unresolved = res.unresolvedCampaignFields as string[] | undefined;
  if (unresolved?.length) process.stdout.write(`\n[UNRESOLVED FIELDS — ${unresolved.length}: ${unresolved.join(', ')}]\n`);
  const issues = res.buildIssues as { message?: string }[] | undefined;
  if (issues?.length)
    process.stdout.write(`\n[BUILD ISSUES — ${issues.length}]\n${issues.map((x) => `  - ${x.message ?? JSON.stringify(x)}`).join('\n')}\n`);

  // Exportability is the single honest summary: can this leave the tool?
  if (res.campaign)
    process.stdout.write(
      `\n[EXPORTABLE: ${res.exportable ? 'yes' : `no — ${String(res.exportBlockedReason ?? 'reason not stated')}`}]\n`,
    );
  const v = res.validation as { errors?: unknown[]; warnings?: unknown[] } | null;
  if (v) process.stdout.write(`[VALIDATION: ${(v.errors ?? []).length} error(s), ${(v.warnings ?? []).length} warning(s)]\n`);
}

// THE VERDICT. A run that never reached a build used to look identical to one
// that did, unless you read every turn. Stated plainly instead.
process.stdout.write(rule('RUN RECORDED'));
process.stdout.write(
  `\nApproval: ${
    approved ? 'given, so the build path ran' : approvalMissed ? 'ATTEMPTED AND IMPOSSIBLE — no proposal was ever on the table' : 'never attempted'
  }\n`,
);
process.stdout.write(`\nTurn records: ${RUN_DIR}/turns\n`);
process.stdout.write(`\nTo put this run in the log:\n  python3 docs/append-live-run.py ${RUN_DIR} --label "${LABEL}" --change "<what changed before this run>"\n`);
