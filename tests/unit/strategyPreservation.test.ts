// Phase 2: a recommendation survives its own open questions.
//
// THE DEFECT, reproduced from a real EMI conversation: the model returned a
// complete strategy and honestly listed what it was still unsure about. The
// gate converted the turn into questions, and the orchestrator's question
// path returns with `strategy` and `blueprint` left null — so the whole
// recommendation was destroyed for being honest, and the user was shown the
// application's own sentence ("The agent proposed a strategy while still
// listing open unknowns") instead of the design. The one question that did
// survive was the least useful of them: message copy and CTA wording.
//
// Deterministic throughout. No model calls — the model's side is supplied as
// fixtures, which is what makes these reproducible.
import { describe, it, expect } from 'vitest';
import { discovered } from './support/findings';
import { readFileSync } from 'node:fs';
import {
  evaluateDiscovery,
  newBrief,
  recordQuestions,
  recordAnswer,
  recordDimensions,
  recordSuccessCriteria,
  type OpenItem,
  type WorkingBrief,
} from '../../server/discovery';
/**
 * A brief whose dimensions were all considered.
 *
 * Discovery-first means the application refuses a strategy until something has
 * been considered and nothing is left 'open'. These suites were written to
 * probe OPEN-ITEM handling — which uncertainties block a strategy and which
 * are stated alongside it — so each fixture now carries a completed record,
 * which is also what a real propose turn carries. It also carries one answered
 * round and a settled success measure, because the gate now requires both
 * before a strategy is accepted — the agent cannot self-certify completeness on turn 1.
 * Enforcement itself is tested in discoveryEnforcement.test.ts.
 */
const considered = (b: WorkingBrief): WorkingBrief =>
  recordSuccessCriteria(
    recordAnswer(
      recordDimensions(discovered(b), [
        { name: 'Audience and eligibility', rationale: 'Who should enter the journey.', status: 'retained', basis: 'user' },
      ]),
      'Target customers with an open request.',
    ),
    ['Completed conversions among customers who entered.'],
  );


import { orchestrateStream, renderStrategy, type Strategy } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import type { CampaignBlueprint } from '../../server/blueprint';

const EMI =
  'Customers authorised for an EMI-eligible purchase are not converting. Get more of them to convert before the request expires.';

/** What the model returns for the EMI objective once Phase 1 grounded it. */
const EMI_STRATEGY: Strategy = {
  summary:
    'Enter customers when an authorisation is approved on an EMI-eligible purchase, then prompt conversion twice inside the open window before the request lapses.',
  approach: [
    'Entry on Transaction Events, filtered to an approved customer-initiated authorisation, because that is the moment eligibility begins.',
    'Two messages rather than three: the message cap is 4 and minimum spacing is 48 hours, so three would crowd a short window.',
  ],
  rejected: [{ option: 'Segmenting by transaction amount', why: 'No conversion data by amount exists, so a split would be arbitrary.' }],
  assumptions: ['Silent non-conversion means no EMI request is raised at all, not a failed one.'],
  unknowns: [],
};

const EMI_OPEN_ITEMS: OpenItem[] = [
  {
    kind: 'strategic-ambiguity',
    question: 'How does the platform represent the authorisation expiring',
    whyItMatters: 'It decides whether the journey waits on an event or on a timer.',
    ifUnanswered: 'A timed wait sized to the stated 7-day window.',
  },
  {
    kind: 'evidence-gap',
    question: 'Conversion rate by transaction amount',
    whyItMatters: 'It would settle whether segmenting is worth the complexity.',
  },
  {
    kind: 'optional-preference',
    question: 'Preferred send hour',
    ifUnanswered: 'Mid-morning, outside the 21:00-09:00 quiet hours.',
  },
];

const gate = (openItems: OpenItem[], brief = newBrief(EMI)) =>
  evaluateDiscovery({
    brief: considered(brief),
    modelAction: 'propose',
    modelQuestions: [],
    modelEvidence: [],
    openItems,
    forced: false,
    maxRounds: 8,
  });

describe('the EMI regression: a strategy arrives with its open question, not instead of it', () => {
  it('keeps the recommendation and asks only what is material', () => {
    const d = gate(EMI_OPEN_ITEMS);
    expect(d.outcome).toBe('strategy_with_questions');
    // Exactly one question, and it is the expiry representation.
    expect(d.questions).toHaveLength(1);
    expect(d.questions[0]).toMatch(/expir/i);
    // The evidence gap and the preference are carried, not asked.
    expect(d.openItems).toHaveLength(3);
    expect(d.questions.join(' ')).not.toMatch(/amount|send hour/i);
  });

  it('never makes message copy or CTA wording the blocking question', () => {
    // The actual reported failure. Whatever else is open, an implementation
    // detail must not be what stands between the user and a design.
    const d = gate([
      ...EMI_OPEN_ITEMS,
      { kind: 'optional-preference', question: 'The exact message copy and CTA wording', ifUnanswered: 'Draft copy per step.' },
    ]);
    expect(d.questions.join(' ')).not.toMatch(/copy|CTA/i);
  });

  it('the reply a person reads contains the strategy, not a gate message', () => {
    const d = gate(EMI_OPEN_ITEMS);
    const reply = renderStrategy(EMI_STRATEGY, d.openItems);
    // The design itself.
    expect(reply).toContain(EMI_STRATEGY.summary);
    expect(reply).toMatch(/Transaction Events/);
    expect(reply).toMatch(/Considered and not used/);
    // The open items, grouped by what they are.
    expect(reply).toMatch(/Worth settling before this is built/);
    expect(reply).toMatch(/Data that would improve this/);
    expect(reply).toMatch(/Defaults applied/);
    // ...and what the agent will assume if nobody answers.
    expect(reply).toMatch(/Until then: A timed wait/);
    // Not the application's own explanation of why it asked.
    expect(reply).not.toMatch(/still listing open unknowns/);
  });

  it('a term appearing in retrieved context does not resolve the question', () => {
    // "Transaction", "event", "EMI Request" are all listed in the vocabulary
    // handed to the model. Listing an option is not choosing one.
    const d = gate([
      { kind: 'strategic-ambiguity', question: 'Whether entry is a Transaction event or an EMI Request event' },
    ]);
    expect(d.outcome).toBe('strategy_with_questions');
    expect(d.questions).toHaveLength(1);
  });

  it('but an answer the user actually gave does resolve it', () => {
    let b = newBrief(EMI);
    b = recordQuestions(b, ['How does the platform represent the authorisation expiring?']);
    b = recordAnswer(b, 'There is no expiry event. Treat it as 7 days from authorisation.');
    const d = gate(EMI_OPEN_ITEMS, b);
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.questions).toEqual([]);
  });

  it('records the answer as a confirmed fact, distinct from an assumption', () => {
    let b = newBrief(EMI);
    b = recordQuestions(b, ['Which status marks conversion?']);
    b = recordAnswer(b, 'New Status = Successful.');
    const fact = b.facts.at(-1)!;
    expect(fact.confidence).toBe('confirmed');
    expect(fact.source).toBe('user-answer');
    expect(fact.answers).toEqual(['q1-0']);

    // An assumption the agent made is NOT a confirmed fact, and must not
    // retire the question it was assumed for.
    const assumed = { ...b, facts: [{ statement: 'Assume conversion means Successful', source: 'assumption' as const, round: 1, confidence: 'assumed' as const }] };
    const d = gate([{ kind: 'strategic-ambiguity', question: 'Assume conversion means Successful' }], { ...assumed, questions: [], answers: [] });
    expect(d.outcome).toBe('strategy_with_questions');
  });
});

describe('nothing blocks a recommendation except a material question', () => {
  it('evidence gaps alone proceed', () => {
    const d = gate([{ kind: 'evidence-gap', question: 'Historical conversion rates' }]);
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('optional preferences alone proceed, with the default stated', () => {
    const d = gate([{ kind: 'optional-preference', question: 'Send hour', ifUnanswered: 'Mid-morning.' }]);
    expect(d.outcome).toBe('ready_for_strategy');
    expect(renderStrategy(EMI_STRATEGY, d.openItems)).toMatch(/Until then: Mid-morning/);
  });

  it('operational limitations alone proceed, and are stated', () => {
    const d = gate([{ kind: 'operational-limitation', question: 'Transaction Events is marked not-yet-built' }]);
    expect(d.outcome).toBe('ready_for_strategy');
    expect(renderStrategy(EMI_STRATEGY, d.openItems)).toMatch(/Limitations/);
  });

  it('a model with nothing to propose is handled explicitly, not fabricated', () => {
    // When the model genuinely has no strategy it asks, and the gate says so.
    const d = evaluateDiscovery({
      brief: considered(newBrief(EMI)),
      modelAction: 'ask',
      modelQuestions: ['What outcome counts as success?'],
      modelEvidence: [],
      openItems: [],
      forced: false,
      maxRounds: 8,
    });
    expect(d.outcome).toBe('ask_questions');
    // And the orchestrator refuses rather than inventing one.
    const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(!proposed\) \{/);
    expect(src).toMatch(/The agent did not produce a strategy/);
  });
});

describe('the orchestrator carries the strategy through the same return', () => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('returns strategy and blueprint from one place, and no questions', () => {
    const tail = src.slice(src.lastIndexOf("phase: 'awaiting-confirmation'"));
    // QUESTIONS ARE EMPTY HERE SINCE 2026-10-22, and the reasoning reversed
    // deliberately. This used to carry `gate.questions` so a carried decision
    // stayed visible at the moment of confirmation — which is still the goal,
    // but the client renders this field as a NUMBERED LIST under the agent's
    // message, and a numbered list beside Confirm reads as a form the plan is
    // waiting on. Measured live: the manager answered the question instead of
    // confirming, and confirming would have built the campaign immediately.
    //
    // The points are still visible, in the place that cannot be mistaken for
    // a questionnaire: the reply itself, under "Worth settling before this is
    // built", rendered from `gate.openItems` by `renderStrategy` — which is
    // where they already were.
    //
    // The reply is built ABOVE the return, as `replyText`, so the plain-language
    // check can read it before it is recorded as an application verdict. The
    // construction is therefore asserted against the whole source and the
    // single return against the tail — the intent is unchanged.
    expect(src).toMatch(/const replyText = renderStrategy\(/);
    expect(src).toMatch(
      /brief\.questionResolutions \?\? \[\], brief\.questions, unsupportedClaims\(optionAudits\)/,
    );
    expect(tail).toMatch(/reply: replyText,/);
    expect(tail).toMatch(/strategy,/);
    expect(tail).toMatch(/pendingBlueprint: blueprint/);
    expect(tail).toMatch(/questions: \[\],/);
    expect(tail).not.toMatch(/questions: gate\.questions/);
    // The open items still reach the reply. Same source, same render.
    expect(src).toMatch(/const replyText = renderStrategy\(\n?\s*strategy, gate\.openItems,/);
  });

  it('no longer routes a proposal into the question-only path', () => {
    // That path still exists for a model that asked instead of proposing, and
    // it still returns no strategy — correctly, because there is none.
    const askBlock = src.slice(src.indexOf("if (gate.outcome === 'ask_questions')"), src.indexOf('// Discovery is complete.'));
    expect(askBlock).toMatch(/phase: 'discovery'/);
    expect(askBlock).not.toMatch(/strategy,/);
    // The gate can no longer send a proposal here.
    expect(src).toMatch(/strategy_with_questions/);
  });
});

describe('graph generation stays gated', () => {
  const knowledge = seedKnowledgeBase();
  const blueprint: CampaignBlueprint = {
    campaignName: 'Auth to EMI',
    description: 'Prompt conversion inside the open window.',
    goal: { eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', conditions: [] },
    entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction', conditions: [] },
    steps: [{ kind: 'send', name: 'Nudge', objective: ['emi', 'convert'], stage: 'first-touch', describe: 'Convert now.' }],
  };

  const run = async (over: Record<string, unknown>) => {
    const gen = orchestrateStream({
      sessionId: 'phase2',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 0,
      messages: [{ role: 'user', content: EMI }],
      intent: 'confirm',
      confirmedBlueprint: blueprint,
      ...over,
    } as never);
    let out = await gen.next();
    while (!out.done) out = await gen.next();
    return out.value;
  };

  it('refuses to build without a confirmation for the current strategy', async () => {
    const res = await run({});
    expect(res.campaign).toBeNull();
    expect(res.graph).toBeNull();
    expect(res.reply).toMatch(/Cannot generate from state|No strategy has been confirmed/);
  });

  it('builds once confirmed, and keeps the missing bank IDs out of the design state', async () => {
    const res = await run({
      session: { state: 'AWAITING_STRATEGY_CONFIRMATION', strategyVersion: 1, confirmation: null },
    });
    expect(res.graph).not.toBeNull();
    // Phase 4 split this deliberately. TEN-IBL cannot reach a template
    // library, so the Send has no account or template id — that is something
    // a person supplies when preparing the UPLOAD, and it no longer stops the
    // design itself being exported. See readiness.test.ts for the contract.
    expect(res.designGenerated).toBe(true);
    expect(res.exportable).toBe(true);
    expect(res.sendProposals.length).toBeGreaterThan(0);
    // ...and the missing ids are still tracked, under import readiness.
    expect(res.importReadiness?.status).toBe('unverified');
    expect(res.importReadiness?.outstanding.join(' ')).toMatch(/account and template ID/i);
  });

  it('rejects a blueprint naming an event the platform does not have', async () => {
    const res = await run({
      session: { state: 'AWAITING_STRATEGY_CONFIRMATION', strategyVersion: 1, confirmation: null },
      confirmedBlueprint: { ...blueprint, entry: { kind: 'event', eventCategory: 'Telepathy Events', eventType: 'Hunch' } },
    });
    expect(res.buildIssues.some((i) => /is not a real event/.test(i.problem))).toBe(true);
    expect(res.exportable).toBe(false);
  });
});
