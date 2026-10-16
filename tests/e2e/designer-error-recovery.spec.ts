// Step 1, client half: a failed turn must not wipe the designer's discovery.
//
// THE DEFECT: `onResult` applied every field unconditionally —
// setBrief(res.brief ?? null), setSession(res.session ?? null) — so an error
// response carrying nulls reset the conversation. The user was told "You can
// retry", but the retry went out with brief:null and the agent started over.
//
// The API is stubbed so the failure can be produced on demand: the real one
// is intermittent (observed twice in three identical live runs), and asserting
// on the REQUEST BODY of the turn after the error is what proves resumption.
import { test, expect } from '@playwright/test';

const DESIGNER = 'http://localhost:5174/designer.html';

const PRIOR_FACT = 'The goal event is EMI_STATUS_CHANGED, New Status = Successful, Source = OS-to-EMI.';

const BRIEF = {
  objective: 'I want to increase OS-to-EMI conversions.',
  objectiveFingerprint: 'conversions emi increase os',
  rounds: 1,
  questions: [{ id: 'q1-0', text: 'Entry on SETTLED only, or also APPROVED?', askedInRound: 1 }],
  answers: [],
  openUncertainties: [],
  evidenceRequests: [],
  facts: [{ statement: PRIOR_FACT, source: 'retrieved', round: 1, confidence: 'confirmed' }],
  limitations: [],
  statedValues: [],
};

const SESSION = { state: 'AWAITING_STRATEGY_CONFIRMATION', strategyVersion: 2, confirmation: null };

/** A response shaped like the real one, with only what the client reads. */
const base = {
  sessionId: 's-stub',
  runId: 'r-stub',
  phase: 'awaiting-confirmation',
  stage: 'proposed',
  reply: 'Here is the proposed strategy.',
  questions: [],
  strategy: { summary: 'Nudge pending OS-to-EMI requests.', approach: [], assumptions: [], unknowns: [] },
  blueprint: null,
  campaign: null,
  graph: null,
  provenance: null,
  unresolvedCampaignFields: [],
  campaignBlockers: [],
  validation: null,
  buildIssues: [],
  templateChoices: [],
  sendProposals: [],
  discoveryRounds: 1,
  discoveryLimitReached: false,
  exportable: false,
  events: [],
  pendingBlueprint: { campaignName: 'OS-to-EMI nudge' },
  designGenerated: false,
  importReadiness: null,
  brief: BRIEF,
  session: SESSION,
  evidenceRequests: [],
  graphReadiness: null,
  model: 'stub-sonnet',
};

/**
 * The error exactly as the server used to send it: nulls for everything that
 * holds discovery. Kept deliberately, so this test proves the CLIENT guard
 * rather than only the server-side fix.
 */
const errorResult = {
  ...base,
  phase: 'error',
  stage: 'error',
  reply: 'The model returned no text at all (stop reason: end_turn). You can retry.',
  strategy: null,
  pendingBlueprint: null,
  brief: null,
  session: null,
};

const frame = (payload: unknown) => `event: result\ndata: ${JSON.stringify(payload)}\n\n`;

test('an error turn does not destroy discovery, and the retry resumes', async ({ page }) => {
  const sent: Record<string, unknown>[] = [];

  await page.route('**/api/designer/stream', async (route) => {
    sent.push(route.request().postDataJSON());
    // Turn 1 succeeds, turn 2 fails, turn 3 is the retry.
    const body = sent.length === 2 ? frame(errorResult) : frame(base);
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  });

  await page.goto(DESIGNER);
  const compose = page.locator('.cd-compose textarea');
  await expect(compose).toBeVisible();

  const send = async (text: string, expectCount: number) => {
    await compose.fill(text);
    await page.getByRole('button', { name: /Design campaign|Apply change/ }).click();
    await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(expectCount);
  };

  await send('I want to increase OS-to-EMI conversions.', 1);
  await send('Fire on APPROVED, right after authorization.', 2);

  // The failure is shown to the user.
  await expect(page.getByText(/returned no text at all/).first()).toBeVisible();

  await send('I want to increase OS-to-EMI conversions.', 3);

  // Turn 2 carried the brief established by turn 1.
  expect((sent[1].brief as typeof BRIEF).facts[0].statement).toBe(PRIOR_FACT);

  // THE REGRESSION: turn 3 — the retry, after the error — must still carry it.
  expect(sent[2].brief).not.toBeNull();
  expect((sent[2].brief as typeof BRIEF).facts[0].statement).toBe(PRIOR_FACT);
  expect(sent[2].session).not.toBeNull();
  expect((sent[2].session as typeof SESSION).strategyVersion).toBe(2);
});
