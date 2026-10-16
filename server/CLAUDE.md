# Campaign Designer — the agent

Source of truth for the agentic Campaign Designer: `server/` (orchestrator,
discovery gate, blueprint compiler), `eval/` (the run harness) and
`src/designer/` (the chat UI).

The validators and hard-constraint regression suites have their own file:
`../agent-proto/CLAUDE.md`.

Separate from `../CLAUDE.md`, which documents the hand-built Drip Campaigns
builder. The two share the campaign model, the reducers, the canvas and the
validators, and share nothing of the UI shell. A campaign this agent produces
is the same kind of object as one built by hand, because it is constructed
through the builder's own `dcConfirmAddNode` rather than assembled separately.

## The one thing to know before changing anything

Behavioural rules added to the prompt have reliably produced more honest
output and no change in what gets designed. Three separate rounds of guards,
contingencies and feedback loops did nothing to the campaigns. What has moved
the output, every time, is structural: widening the vocabulary the agent
designs in, or adding a check the application enforces against what was
actually built.

If a change starts turning into prompt wording, that is the signal it has
drifted.

## Standing principle: the strategy comes first, the platform second

Stated by the campaign manager, 2026-10-16, and it decides the phase order:

> "How the bank wants to execute is always secondary. We need the discovery
> and strategy to be top notch first."

The consequences, which are deliberate and should not be softened:

- **The agent proposes without knowing what the builder supports.** The
  builder's vocabulary is withheld until the plan has been approved. A
  proposal written inside the platform's limits is a proposal the platform
  wrote.
- **Some proposals will be unbuildable.** That is the intended outcome, not
  a failure. It is honest, and it tells us what to improve about the platform
  — which a campaign quietly degraded to fit would have hidden.
- **A blocker stops the build.** It does not produce a lesser campaign with a
  footnote. A campaign that silently dropped a requirement is worse than no
  campaign and a plain statement of what is in the way.

This reverses the older instruction to work around gaps and report them
underneath the campaign. That wording and the tests pinning it are what has
to change, not just the behaviour.

## 2026-10-16 — Silence from the model now means the user answered

The application decided whether a question had been answered from one
optional field: the model's own `answered: [ids]` array, read by
`recordAddressedQuestions`. Nothing else was consulted. A model that simply
left the field out therefore produced a brief in which nothing had been
answered, and the application told a campaign manager — who had just
answered both questions plainly, in one message — that their reply did not
cover either, and asked again.

**The content was never lost, and that is what made the bug survivable to
diagnose.** `recordAnswer` stores the reply verbatim in `brief.answers` and
as a `confidence: 'confirmed'` fact, and `briefForPrompt` replays both on
every turn. The model could always see the answer. Only the bookkeeping that
decides whether discovery may progress could not.

**The fix is a flipped default, not a new mechanism.**
`recordUncoveredQuestions` writes the same `addressedInRound` field, so
nothing downstream changed. It is called unconditionally, and an empty list
is the model's claim that nothing went uncovered.

**Forks are the exception, deliberately.** Flipping the default for every
question also discharges a fork nobody answered, and a fork decides WHICH
campaign gets built rather than how well. The two mistakes do not cost the
same: wrongly assuming a detail was answered loses a nuance the model can
still read out of `brief.answers`, while wrongly assuming a fork was
answered builds the wrong campaign silently. So a fork still needs a
positive `answered` claim, and `forkGuardUnderFailure.test.ts` passes
unchanged — its scripted misbehaving model sends `answered: []` and is still
blocked.

A first attempt flipped the default for everything. It broke 59 tests across
9 files, and the 8 in `forkGuardUnderFailure.test.ts` were the ones worth
listening to: they were not encoding an accident, they were encoding the
protection the flip had just removed. The asymmetry above came from reading
those failures rather than rewriting them.

Prompt: `SYSTEM` now says "READ THEIR REPLY AS AN ANSWER FIRST", names the
cost in the user's terms ("telling them a reply you did receive did not
count is wrong and insulting"), and states the fork exception with its
reason. It fits the existing 33,400 cap — length was taken out of redundant
prose rather than raising the cap a fifth time.

Verified: 929 unit (from 922, 7 new covering the default both ways,
idempotence, and a question with no reply yet) and 118 agent-proto.

### Known, and not from this change

`npm run check:server` reports 33 errors across `eval/run.ts` and nine test
files — implicit `any` in the eval harness, `BpStep` mismatches in test
fixtures. None touch the answer-attribution fields. `tsc --noEmit` and
`server:typecheck` are both clean, so this is the wider config only, and it
is not green despite an earlier entry in this file implying it was.

## 2026-10-16 — The agent had no model of the customer. Findings
(who converts, why the rest do not) made required and empty.

The whole Campaign Designer line of work (`server/`, `eval/`, the designer
app) had never been written up here. This entry covers the round that
changed its reasoning, and the standing decisions that came out of it.

### The diagnosis, which is the important part

The agent designed audience plumbing instead of conversion strategy. Asked
to raise OS-to-EMI conversion it spent both of its fork questions asking
whether it was acceptable to message customers with incomplete KYC, and
whether to hold the campaign for a suppression list. Neither is a question
about EMI conversion.

Reading what it is actually given explains it. Everything is operational:
`bank-context.json` is channels, quiet hours, DNC/NPA and a control-group
percentage; the eleven entries in `principles.json` are two conversion
RATES, five platform mechanics, two experiment methods and two channel
heuristics; `knowledge.ts` adds tone and an explicit `Historical learnings:
NONE AVAILABLE`; `ELIGIBILITY_META` is a catalogue of filterable
attributes. **Not one thing anywhere describes why a customer converts.**
Asked to raise conversion with only that, audience plumbing is the only
thing it CAN reason about.

The design-step schema confirmed the bias. Every requirement slot was
`{need, attribute, event}` under `entryEntity`, so a need with no attribute
had nowhere to go. "They think it is expensive, so the first message has to
reframe the cost" has neither, and the schema pushed it out. Three of four
stated requirements came back as plumbing. Nothing in the wording asked for
that — the slots did.

**This also explains why three rounds of behavioural rules changed nothing.**
Guards, contingencies and feedback loops made the agent more honest about
what it did not know. They never changed what it designed. You cannot rule
your way into knowledge the system does not have.

### What was built

`server/findings.ts` — two findings the agent must establish before it may
propose:
- `Converters` — who converts today, plus `knowledge: 'known' | 'none-yet' | 'unknown'`
- `Barrier[]` — why the rest do not, each with a `lever` and a `quote`

Enforced in the discovery gate (`evaluateDiscovery`), not requested in the
prompt. The gate went from five checks to nine.

**Attribution is verified, not trusted.** `basis: 'user-belief'` was a label
the model could apply to its own invention. A barrier must now carry a
`quote`, and `recordBarriers` checks it against what the manager actually
typed, downgrading to `assumption` when it does not match. Matching is on
significant-word overlap, not substring: a model quoting a conversation
paraphrases, and demanding a literal match would reject honest attributions
more often than dishonest ones. The corpus is answers AND supplied evidence,
because the orchestrator resolves evidence without calling `recordAnswer`.

**`checkBarrierCoverage`** refuses a proposal where a send attacks no named
barrier, or where a barrier the manager raised is addressed by nothing. Sends
carry `barrier` in the blueprint, so the citation is structural.

**`checkAudienceLearning`** refuses a flat single-audience journey when
nobody could say who converts, because such a campaign returns one
undifferentiated number and the next campaign starts as ignorant as this one.

### Standing decisions, each reached by being wrong first

**Nothing is seeded.** A first version shipped five candidate OS-to-EMI
barriers marked unverified. That was wrong twice: a ready-made list turns
discovery into multiple choice, and it caps the answer at whatever the
author thought of, so a real barrier outside it (the EMI option buried in
the app, RMs steering customers away on incentives) is forced into the
nearest box. **Working out the reason IS the job.** An empty required slot
is a question generator; a filled one removes the task.

**"Nobody knows who converts" demands MORE work, not less.** The first
version accepted "we have no data" and proceeded, so the one case needing
the most thought was the one it could skip. It now requires at least two
candidate segments and the manager's reaction before designing.

**The application does not judge whether segments are meaningfully
different.** That is a question about customer behaviour and no code reaches
it. But it is also not the manager's job to notice that two options are one
group renamed. So the agent declares what each candidate `restsOn`, and the
application checks those differ — a structural check on its own claim, the
same shape as an experiment declaring what it tests and the arms having to
really differ.

**Eligibility gaps are never put to the user as a choice.** `briefBack` used
to end with "that difference is the user's decision, not yours" for every
unmet requirement, and the model obeyed — that one sentence produced the KYC
question. It now splits: a gap in WHO IS REACHED is still the manager's call;
a gap in WHO IS EXCLUDED is plumbing and becomes a limitation.

**The entry vocabulary was narrower than the platform.** The agent emitted
one entity and a flat condition list, so it told a manager the platform could
not combine KYC status with account standing in one entry, and could not test
for the absence of a record. Both have been buildable for months
(`extraEntityGroups`; `existence: 'none'` with a lookback). Added to the
blueprint. The honest caveat, now stated in the campaign: absence is measured
over a window, not over all time.

### Two defects in our own verification

**`server/` was not being typechecked.** A `server:typecheck` script existed
with full coverage and was simply never run; `tsc --noEmit` covers only
`src`. The server runs under `--experimental-strip-types`, which removes
types without checking them. Pointing a checker at it found fifteen errors
immediately. Both are now clean, and `npm run check:server` covers
server + eval + agent-proto + tests + docs.

**A hard constraint reported a pass it never earned**, as a direct result of
removing the invented message cap. Written up where it belongs, in
`../agent-proto/CLAUDE.md`.

### Prompt

Raised to 33,400 chars, deliberately and for capability only. A prior comment
here claimed ~2,700 chars could be reclaimed by generating the JSON schemas
from types; that was wrong, and is corrected — most of that block is
placeholder prose the types cannot generate and several tests pin verbatim.
The three-case rule for "nobody knows who converts" lives in `briefForPrompt`
rather than the system prompt, so it costs no budget and appears only when
it applies.

### Designer UI

The layout now follows the phase. It was a fixed 420px chat rail against a
canvas holding ~70% of the screen and empty for the whole discovery phase,
which is most of a session: laid out as a canvas tool with a chat sidebar
when it is really a conversation that eventually produces a canvas. Before a
journey exists the conversation takes the centre at a 760px reading column;
after, the original split applies unchanged. Taken from the propensity-agent
(`nudges/marketing-automation/propensity-agent`), whose chat is a centred
`max-w-3xl` column and whose canvas is a panel that arrives when there is
something to show. Its dark sidebar was deliberately not carried over.
Its suggestion-chip pattern became a one-click "I am not sure" under the
agent's questions, which is the answer the agent now explicitly invites.

### The eval scenario was the binding constraint

Every one of the ~36 recorded runs used the same five scripted replies in
`eval/showOne.ts`. With the gate at nine checks, five replies cannot satisfy
it: the first run on this build ended all five turns in `discovery`, held
correctly on "has not established which customers convert today", because
turn five says "we do not have data on that" and there was no sixth turn in
which to react to the candidate segments. **The script ran out, not the
agent.** Extended to eight turns, including a reply reacting to the
candidates and a spare, so that ending in discovery means something.

`MAX_DISCOVERY_ROUNDS` is 8 and has still never been exercised.

### Transport

Added an idle watchdog to the streaming call. The measured failure is always
the same shape: several chunks arrive, then the connection goes quiet. The
total budget still had to run down, so a stall obvious at thirty seconds cost
a hundred and eighty, and one turn burned four attempts and twelve minutes.
The watchdog aborts 45s after the last chunk, armed only AFTER the first
chunk because time to first token is legitimately long. It does not make
calls succeed more often; it makes a dead one fail fast.

### Verified

902 unit tests (from 841) and 118 agent-proto. **Both suites must be run:**
`npm test` does not cover `agent-proto/*.task.ts`, which has caused one false
all-clear. `npm run check:server` and `npm run build` clean.

### Still open

- The three-run bar has not been met. One run on the current build is not
  evidence, and the earlier one could not complete for the reason above.
- The discovery-gate diagram in the overview artefact is at nine gates and
  reads dense. If it becomes a wall, split it into "what must be known before
  designing" and "what the built campaign is checked against".
- A session run by hand in the designer stays in `localStorage` and never
  reaches the published run log, while scripted runs do. That is backwards.
