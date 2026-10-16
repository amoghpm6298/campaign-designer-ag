// What we can check mechanically, and what we cannot.
//
// The trap this file is built to avoid: asserting that the output CONTAINS the
// right headings. Every scored property below is about a DECISION — what the
// agent targeted, what it claimed, what it preserved — not about shape. An
// output can satisfy every structural rule in the prompt and still be a bad
// campaign, which is exactly what the recorded runs show.
//
// Anything that needs judgement (is this question GOOD? is this trade-off well
// argued?) is deliberately absent. Those are collected as notes for a human,
// never scored, and never averaged into a number. A second model is not used
// to judge the first — same family, correlated errors.
import type { Scenario } from './scenarios';
import { ELIGIBILITY_META, EVENT_CATEGORIES } from '../src/data/sharedConstants';
import { auditOptions, unsupportedClaims } from '../server/optionAudit';

export type Outcome = 'pass' | 'fail' | 'n/a';

export interface Check {
  id: string;
  group: 'discovery' | 'strategy';
  /** What a failure would mean for the business, not what rule was broken. */
  asks: string;
  outcome: Outcome;
  detail: string;
}

/** One turn's recorded response, as the driver saves it. */
export interface TurnRecord {
  phase: string;
  reply?: string;
  questions?: string[];
  brief?: {
    questions: { id: string; text: string; impact?: string; addressedInRound?: number }[];
    dimensions?: { name: string; status: string; basis: string; note?: string }[];
    answers: { text: string }[];
    successCriteria?: string[];
    questionResolutions?: { questionId: string; kind?: string; why: string }[];
  };
  strategy?: Record<string, unknown> | null;
  pendingBlueprint?: Record<string, unknown> | null;
  graphReadiness?: { status: string; blockers: string[] } | null;
}

const text = (t: TurnRecord) => `${t.reply ?? ''}`;
const json = (v: unknown) => JSON.stringify(v ?? null);

/** Every attribute the platform actually has, flattened. */
const REAL_ATTRS = new Set(
  Object.values(ELIGIBILITY_META as Record<string, Record<string, unknown>>).flatMap((a) => Object.keys(a)),
);
const REAL_EVENTS = new Set(
  Object.values(EVENT_CATEGORIES as Record<string, { events: string[] }>).flatMap((c) => c.events),
);

const check = (id: string, group: Check['group'], asks: string, ok: boolean | 'n/a', detail: string): Check => ({
  id, group, asks, outcome: ok === 'n/a' ? 'n/a' : ok ? 'pass' : 'fail', detail,
});

// ---------------------------------------------------------------- discovery

/**
 * A run cut short by transport is not evidence about discovery.
 *
 * MEASURED: the same scenario scored pass/pass in one run and fail/fail in
 * another. The difference was 4 transport failures that stopped the run after
 * turn 1 — the user never got to give the answer the checks were looking for.
 * Scoring that as a discovery failure mixes provider noise into a quality
 * measurement, which is the one thing this harness must not do.
 */
export function discoveryChecks(s: Scenario, turns: TurnRecord[]): Check[] {
  const truncated = turns.length < s.turns.length;
  const whenComplete = (ok: boolean | 'n/a') => (truncated ? 'n/a' : ok);
  const last = turns[turns.length - 1];
  const brief = last.brief;
  const out: Check[] = [];
  if (!brief) return [check('D0', 'discovery', 'Did the run complete?', false, 'No brief — run failed.')];

  // A usable definition of success, without interrogating for a number that
  // does not exist. Both halves matter: having one, and not chasing it.
  // Only meaningful at proposal time: successCriteria is populated from the
  // propose payload, so a discovery-only run has an empty one by construction.
  // Scoring it there would measure a known lag, not a decision.
  out.push(
    check('D1', 'discovery', 'Did it settle what success means before proposing?',
      last.phase === 'awaiting-confirmation' ? (brief.successCriteria ?? []).length > 0 : 'n/a',
      `phase=${last.phase}; successCriteria: ${json(brief.successCriteria)}`),
  );

  // A cause the user offered must be held as a belief, never promoted to fact.
  if (s.given.statedCause) {
    const beliefs = (brief.dimensions ?? []).filter((d) => d.basis === 'user-belief');
    out.push(
      check('D2', 'discovery', 'Was the user\'s explanation held as a belief, not a finding?',
        whenComplete(beliefs.length > 0),
        beliefs.length ? `held as belief: ${beliefs.map((b) => b.name).join('; ')}` : 'no dimension recorded as user-belief'),
    );
  }

  // A decision-critical question must never be lost. Unanswered forks at the
  // point of proposal mean the agent chose for the user.
  const openForks = brief.questions.filter((q) => q.impact === 'fork' && q.addressedInRound === undefined);
  out.push(
    check('D3', 'discovery', 'Were decision-critical questions resolved before proposing?',
      last.phase === 'awaiting-confirmation' ? openForks.length === 0 : 'n/a',
      openForks.length ? `open at proposal: ${openForks.map((q) => q.id).join(', ')}` : 'none open'),
  );

  // Did the conversation move at all, or was it one intake round?
  const rounds = new Set(brief.questions.map((q) => q.id.split('-')[0])).size;
  out.push(
    check('D4', 'discovery', 'Did discovery go beyond a single intake round?',
      whenComplete(rounds > 1),
      `${brief.questions.length} questions over ${rounds} round(s); ${brief.answers.length} answers`),
  );

  // Did anything the user said actually land as a distinct factor? A run that
  // records the same three generic dimensions for every business is intake.
  if (truncated)
    out.push(check('D-trunc', 'discovery', 'Did the run complete all scenario turns?', 'n/a',
      `only ${turns.length}/${s.turns.length} turns completed — multi-turn checks withheld`));

  const dims = brief.dimensions ?? [];
  out.push(
    check('D5', 'discovery', 'Were dimensions specific to this business problem?',
      dims.length >= 3,
      dims.map((d) => `${d.name} [${d.status}/${d.basis}]`).join(' | ') || 'none'),
  );

  // Nothing numeric may appear that the user did not say and the platform does
  // not define. This is the invention check.
  // Not preceded by a letter or hyphen: "P-010" and "arm-2" are identifiers,
  // not claims. Matching inside them reported a false defect on the first run.
  const nums = (json(last.pendingBlueprint) + text(last)).match(/(?<![A-Za-z-])\d[\d,]{2,}(?![\d%])/g) ?? [];
  const invented = nums.filter(
    (n) => !s.given.userNumbers.some((u) => u.replace(/,/g, '') === n.replace(/,/g, '')),
  );
  out.push(
    check('D6', 'discovery', 'Did it avoid inventing figures the user never gave?',
      invented.length === 0,
      invented.length ? `unexplained figures: ${[...new Set(invented)].join(', ')}` : 'none'),
  );

  // Re-asking across turns. Measured on the first baseline: 4 of 5 scenarios
  // put the same question twice when the user's reply did not answer it — in
  // one case near-verbatim. The agent repeats itself rather than rephrasing,
  // narrowing, or proceeding with a stated assumption.
  //
  // LIMITATION, stated rather than hidden: word overlap catches an obvious
  // repeat and MISSES a reworded one. competing-explanations asks the same
  // question twice at 0.42 overlap, under this threshold. So this check
  // under-reports, and a pass is weaker evidence than a fail.
  const tok = (t: string) => new Set((t.toLowerCase().match(/[a-z]{4,}/g) ?? []));
  const asked = turns.flatMap((t, i) => (t.questions ?? []).map((q) => ({ turn: i, q })));
  let worst = 0; let pair = '';
  for (let i = 0; i < asked.length; i++)
    for (let j = i + 1; j < asked.length; j++) {
      if (asked[i].turn === asked[j].turn) continue;
      const a = tok(asked[i].q); const b = tok(asked[j].q);
      const u = new Set([...a, ...b]).size;
      const jac = u ? [...a].filter((x) => b.has(x)).length / u : 0;
      if (jac > worst) { worst = jac; pair = asked[i].q.slice(0, 60); }
    }
  out.push(
    check('D7', 'discovery', 'Did it avoid re-asking a question it already put?',
      truncated || asked.length <= 1 ? 'n/a' : worst < 0.5,
      worst ? `highest overlap across turns ${worst.toFixed(2)}: "${pair}..."` : 'no cross-turn pairs'),
  );

  return out;
}

// ----------------------------------------------------------------- strategy

export function strategyChecks(s: Scenario, turns: TurnRecord[]): Check[] {
  const last = turns[turns.length - 1];
  const out: Check[] = [];
  const st = last.strategy as
    | { architectures?: { name: string; entry: string; chosen: boolean }[]; strategyOptions?: never[] }
    | null
    | undefined;
  const bp = last.pendingBlueprint as Record<string, unknown> | null | undefined;

  if (last.phase !== 'awaiting-confirmation' || !st) {
    return [check('S0', 'strategy', 'Did it reach a strategy?', 'n/a', `phase=${last.phase} — no strategy to score`)];
  }

  // Materially different approaches means different ENTRY, not different copy.
  const arch = st.architectures ?? [];
  const entries = new Set(arch.map((a) => (a.entry ?? '').trim().toLowerCase()));
  out.push(
    check('S1', 'strategy', 'Were the alternatives genuinely different campaigns?',
      arch.length >= 2 && entries.size >= 2,
      arch.length ? arch.map((a) => `${a.chosen ? '*' : ' '}${a.name}: ${a.entry}`).join(' | ') : 'no architectures recorded'),
  );

  // The blueprint must be the architecture it said it chose.
  const chosen = arch.find((a) => a.chosen);
  const bpEntry = json((bp as { entry?: unknown })?.entry).toLowerCase();
  const entryWords = (chosen?.entry ?? '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 4);
  out.push(
    check('S2', 'strategy', 'Does the built campaign match the approach it chose?',
      chosen ? entryWords.some((w) => bpEntry.includes(w)) : 'n/a',
      `chosen="${chosen?.entry ?? '—'}" blueprint entry=${bpEntry.slice(0, 110)}`),
  );

  // No invented platform capability.
  const used = json(bp);
  const fakeAttrs = [...(used.match(/"attribute":\s*"([^"]+)"/g) ?? [])]
    .map((m) => m.replace(/.*"attribute":\s*"/, '').replace(/"$/, ''))
    .filter((a) => !REAL_ATTRS.has(a));
  const fakeEvents = [...(used.match(/"eventType":\s*"([^"]+)"/g) ?? [])]
    .map((m) => m.replace(/.*"eventType":\s*"/, '').replace(/"$/, ''))
    .filter((e) => !REAL_EVENTS.has(e));
  out.push(
    check('S3', 'strategy', 'Did it stay inside real platform capabilities?',
      fakeAttrs.length === 0 && fakeEvents.length === 0,
      [...fakeAttrs, ...fakeEvents].length ? `invented: ${[...fakeAttrs, ...fakeEvents].join(', ')}` : 'all real'),
  );

  // The intended audience must survive, and the proxy must not be used.
  if (s.given.forbiddenProxy) {
    const proxyUsed = used.includes(s.given.forbiddenProxy.attribute);
    const intentKept = s.given.userNumbers.some((n) => text(last).includes(n));
    out.push(
      check('S4', 'strategy', 'Was the intended audience preserved without a stand-in?',
        !proxyUsed && intentKept,
        `${s.given.forbiddenProxy.attribute} in blueprint: ${proxyUsed}; user's figure still stated: ${intentKept}`),
    );
  }

  // No performance claim. There is no history for this bank.
  const claims = text(last).match(/\b\d+(\.\d+)?\s?%|\buplift\b|\bwill increase\b|\bexpect(ed)? (a )?\d/gi) ?? [];
  const realClaims = claims.filter((c) => !/10\s?%/.test(c)); // 10% control group is a design choice, not a claim
  out.push(
    check('S5', 'strategy', 'Did it avoid claiming results it cannot know?',
      realClaims.length === 0,
      realClaims.length ? `claims: ${[...new Set(realClaims)].join(', ')}` : 'none'),
  );

  // Claimed mechanics must exist in the journey.
  const opts = (last.strategy as { strategyOptions?: { option: string; verdict: 'used' | 'not-applicable' | 'cannot-evaluate'; why: string }[] })?.strategyOptions;
  const gaps = unsupportedClaims(auditOptions(opts, bp as never));
  out.push(
    check('S6', 'strategy', 'Do the claimed mechanics exist in the campaign?',
      gaps.length === 0,
      gaps.length ? gaps.map((g) => `${g.option}: ${g.gap}`).join(' | ') : 'all claims supported'),
  );

  // A conflict the scenario knows about must be put to the user as a choice.
  if (s.given.knownConflict) {
    const raised = /Worth settling before this is built|cannot .*both|trade-?off/i.test(text(last));
    out.push(
      check('S7', 'strategy', 'Was the known conflict put to the user as a decision?',
        raised, raised ? 'conflict surfaced' : 'conflict not surfaced to the user'),
    );
  }

  // Can it actually be built?
  out.push(
    check('S8', 'strategy', 'Can the campaign actually be generated?',
      last.graphReadiness ? last.graphReadiness.status !== 'blocked' : 'n/a',
      last.graphReadiness?.blockers?.join(' | ') || 'no blockers'),
  );

  return out;
}

/** Things a human must read. Never scored, never averaged. */
export function qualitativeNotes(turns: TurnRecord[]): string[] {
  const last = turns[turns.length - 1];
  const notes: string[] = [];
  const qs = turns.flatMap((t) => t.questions ?? []);
  if (qs.length) notes.push(`QUESTIONS ASKED (judge whether these are the questions a strategist would ask):\n  - ${qs.join('\n  - ')}`);
  const arch = (last.strategy as { architectures?: { name: string; entry: string; tradeoff: string }[] })?.architectures;
  if (arch?.length)
    notes.push(`ALTERNATIVES (judge whether the second is a real option or an alibi):\n  - ${arch.map((a) => `${a.name} — ${a.tradeoff}`).join('\n  - ')}`);
  return notes;
}
