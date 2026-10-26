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

> **Superseded 2026-10-21.** The exception lasted five days. It was removed
> after it caused the mirror image of the bug this entry is about: the
> manager answered both forks, the agent read them back correctly in prose,
> and the application asked again anyway. See "The fork exception is gone"
> below. The asymmetry stated above is still true; the conclusion drawn from
> it was wrong.

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

## 2026-10-21 — The fork exception is gone, and turn one can no longer be a
channel inventory

Two defects from one live run, both about what the manager sees rather than
what the agent knows. They had the same root shape: the application was
showing its own bookkeeping instead of the conversation.

### The run

Turn 1 opened with "I checked the channels and template availability", then
three numbered questions. Turn 2 the manager answered: "1. Activation means
setting the PIN 2. We measure how many new cardholders activate". The agent
replied "Confirmed so far: activation means setting the PIN, and success is
read as more cardholders activating" — and the client listed those same two
questions again underneath it. By turn 3 there were five numbered questions
on screen, two of which the agent had just said in writing were settled.

### Defect 1: the question list was the backlog, not the ask

The discovery return sent `outstanding(brief)` — every question still open
across the whole conversation. So the list could only grow, and anything the
record had not closed reappeared under the sentence saying it was closed.

Fixed by capturing the question ids present BEFORE the turn ran and returning
only what was added during it, capped at `MAX_QUESTIONS_PER_ROUND`. The brief
still carries the full history, because the brief is the record and the gate
reads it; what the client lists is this turn's ask. The two were conflated,
and only one of them is a view.

### Defect 2: the fork exception made an answer unable to land

Both of those questions were forks. `recordUncoveredQuestions` excepted
forks: a fork stayed outstanding unless the model positively claimed it in
`answered`. The model did not emit `answered`, so the record kept both open —
while its own prose read them back correctly.

Removed. A reply now closes a fork like anything else, and `notCovered` is
the only thing that keeps one open.

**The asymmetry the exception rested on is real and was not the reason to
keep it.** Discharging a fork wrongly does build the wrong campaign. But a
default that cannot be cleared by answering is not caution — it is an
application that cannot hear, and the manager pays for it on every turn
rather than in the rare case. `notCovered` is the better instrument anyway:
it is the model stating that a specific question went untouched, which is a
claim about the reply in front of it, not a standing presumption.

`forkGuardUnderFailure.test.ts` was the file that argued for the exception
five days ago, and it still passes — repointed, not rewritten. Its scripted
model now sends `notCovered: ['q1-1']` alongside the proposal, which makes
the misbehaviour it tests sharper than before: the model is no longer
forgetting its bookkeeping, it is stating that the fork went unanswered and
proposing a campaign against one of the two cohorts anyway. The guard still
stops it.

### Defect 2's cause: turn one had exactly one thing it could do

`list_channels` and `check_template_availability` were the only tools
available before a plan is approved. A model inclined to look something up
first therefore had precisely one thing to look up, and turn one could not
have been anything else. Both joined `BUILD_TIME_TOOLS`, which leaves
discovery with NO lookup tools at all — the intent, not an oversight.

Nothing was lost. `issuerContext` already names the available channels in the
prompt on every turn, and which templates exist is a build-time question: it
cannot change what the campaign should be, only how it gets assembled. The
new test asserts the channel names appear in the request actually sent,
because that is the only place the agent reads from.

### The quotable results

- `toolsForPhase(false)` is now **empty**. `toolsForPhase(true)` is
  `list_event_types, list_audience_attributes, list_channels,
  check_template_availability, list_step_types`.
- The tool-call discovery path returns the questions recorded THIS turn,
  `.filter((q) => !questionIdsBefore.has(q.id)).slice(0, 3)`.
- A user reply addresses every outstanding question it was a reply to,
  forks included; `notCovered` is the only exception, and `answered` still
  works.

### Verified

1002 unit (from 993; 9 new in `turnOneAndQuestionList.test.ts`, each
confirmed to fail against the pre-fix code) and 118 agent-proto. `tsc
--noEmit` and `server:typecheck` clean. `SYSTEM` is 31,003 chars against the
33,400 cap — the fork sentence in the prompt was rewritten rather than left
describing a rule the code no longer follows.

### Not done, on instruction

No refusal ladder was reintroduced, and the dimension blocklist was not
widened.

## 2026-10-21 (cont'd) — The PIN-activation propose turn: `undefined` on
screen, and a gate asking the manager to pick between guesses

Two defects from the same run as the entry above, both on the propose turn,
both the application speaking badly about state it already held. No live
model calls were made to fix either — the run's own turn files were enough.

### `undefined`, printed three times to a campaign manager

The proposal's "Approaches considered" read:

```
Who it reaches: undefined
Why it should work: undefined
What it gives up: undefined
```

under BOTH candidates. The cause is two things written at different times
that never agreed: `propose_strategy`'s schema asks for `audience`,
`tradeOff` and `why`; the `Architecture` type and the renderer read `entry`,
`tradeoff` and `whyChosen`. A missing field is not an error — it renders as
`undefined` — so nothing complained for as long as the tool has existed.

The model's text was good and was being thrown away: *"All new cardholders
issued a card and not yet PIN-set, randomly split into a how-to arm, a
reason-to-use arm and a small no-message holdout, stratified by credit-limit
tier"* became `Who it reaches: undefined`. The chosen candidate's `why` —
*"You said 'probably both' when asked which barrier is stopping
activation"* — was dropped silently rather than printed as `undefined`,
because that line was already conditional.

**It also blunted a check nobody would have noticed.**
`architectureAudit` decides whether two candidates are really different from
`[entry, timing, journey]`, and `entry` was blank on every architecture ever
proposed. Two plans differing only in who they reach would have been called
one plan described twice. This run passed on timing and journey, so the
`differentiated` verdict was right by luck.

Fixed in two places, deliberately:
- **At the tool boundary** (`applyOutputTool`), the aliases are reconciled
  into the one shape everything downstream reads. There is a single point
  where model output becomes application state; a second alias in each reader
  is how this drifts again.
- **In the renderer**, every line is now conditional via one `line()` helper.
  A label with nothing after it is worse than the label's absence — it reads
  as a question put to the manager ("who does this reach?") about a plan that
  has already said.

`mechanism` has no counterpart in the schema at all, so "Why it should work"
is always blank and now always omitted. That is the honest outcome of the
rule rather than a thing to paper over.

### "I am waiting to hear which one you would back"

The manager had said plainly they have no visibility on who already
activates. The agent put up two guess-groups resting on different things —
welcome-offer sign-ups, and customers who already hold another product. The
gate held anyway, said the line above, and re-asked *"who tends to do this
already today"*.

`convertersSettled` required two things in the nobody-knows case: two
distinct, reasoned candidates, AND a manager reply after they were raised.
The second was to stop the agent treating its own suggestion as agreed. It
was wrong on two counts:

- It asked the manager to pick a targeting group out of the agent's own
  guesses — a decision neither of them can make yet, and the thing the
  campaign exists to settle.
- It made a rejection unrepresentable. "Do not target off those guesses" is
  agreement about the state of knowledge, not a refusal to answer; any reply
  settled the finding and no reply left it open, so the one thing the manager
  might actually want to say had nowhere to land.

**Unknown plus two distinct candidates IS this question answered.** The
requirement is dropped, and the protection it reached for lives where it
belongs: `mustLearnAudience` stays true whenever nobody knows, and
`checkAudienceLearning` still refuses a flat single-audience journey, so the
candidates must be told apart by what gets BUILT rather than by another round
of chat.

`converters-unreacted` became unreachable and was deleted rather than left
in place — an unreachable branch makes the next reader work out whether it
was load-bearing. `converters-unknown` remains, and so does the rule that one
candidate is not enough. The generic "who tends to do this already" fallback
in `evaluateDiscovery` needed no change: it only fires while the finding is
open, which it now is not.

### The quotable rules

- **Render skip:** `const line = (label, value) => value && value.trim() ?
  `${label}: ${value.trim()}` : ''` — every architecture field goes through
  it, and a blank one produces no line at all.
- **Converters settled:** `candidates.length >= 2 && complete && distinct`.
  Nothing about replies, rounds or reactions. "Nobody knows" plus two
  candidates resting on DIFFERENT things is the answer; the design then has
  to tell them apart.

### Verified

1013 unit (from 1003; 10 new in `proposeTurnDefects.test.ts`, 6 of which
fail against the pre-fix code, plus two reversed and one added in
`findings.test.ts`) and 118 agent-proto. `tsc --noEmit` and
`server:typecheck` clean. `check:server` is at 37 pre-existing errors with
none in any file touched this session. No prompt, channel, tool-set,
question-list or seed changes.

## 2026-10-21 (cont'd) — Every eligible customer is treated. A dimension
changes the path, not the guest list.

The guiding principle, and it is now enforced in one place and stated in
three. From the PIN-activation run: the manager named assigned credit limit
as a dimension, and the campaign was right to act on it — what was missing is
that a dimension decides which PATH a customer takes and never whether they
are in the campaign at all.

### The structural half: an entry condition is not segmentation

`optionAudit`'s segmentation check read:

```ts
const branches = conditions(bp).length + experiments(bp).length;
const narrowed = (bp.entry?.conditions ?? []).length > 0;
return branches || narrowed ? null : '...the entry narrows nobody...';
```

`narrowed` meant "the entry carries at least one condition". So a campaign
that filtered at the door and then ran one path for the survivors verified
Segmentation as **used**. The audit was rewarding the opposite of
segmentation: narrowing the entry does not treat two groups differently, it
removes one of them.

The new rule, and it is the quotable one:

> Segmentation is verified only by an in-journey split that treats the groups
> differently AND leaves the remainder a path — a condition whose two
> branches differ and are both non-empty, or an experiment whose arms differ.
> Entry conditions are eligibility and cannot carry the claim.

Three gap messages instead of one, because the three states are different
advice: one path for everyone (and the sentence now says entry conditions
cannot carry it); a split where both sides do the same thing; and a split
that sends one group down an empty branch — which is the same filter moved
one step later, and the one the old check could not see at all.

**A holdout arm still counts.** It is declared, measured and accounted for,
which is exactly what an empty condition branch is not.

### The prompt half, which only works because of the above

Three sentences. They are prompt wording, and this file's standing lesson is
that prompt wording alone has never moved what gets designed — they are here
as the counterweight to a rule the audit now enforces, not as the fix.

- §3, the business strategy: *"THE AUDIENCE IS EVERYONE ELIGIBLE WHO HAS NOT
  DONE THE BEHAVIOUR YET. Issued and not yet activated, carrying a balance
  and not yet converted: that is the entry. Narrowing it to the group most
  likely to respond is not strategy, it is abandoning the rest of the problem
  you were asked to solve."*
- §6, the Segmentation option: *"EVERY ELIGIBLE CUSTOMER IS STILL TREATED: a
  dimension splits the treatment inside the entry set — a different cadence,
  channel or copy — and never shrinks the entry to the best-looking bucket.
  The high-limit customers still enter; they may simply get fewer touches. If
  you split, give the remainder a path, so whoever is left still gets a
  campaign. When the manager has named the dimension, do not ask which group
  to target — ask only where the split sits, or default to the cohort's own
  median or tertiles rather than inventing a rupee cutoff, and use only as
  many buckets as their dimension actually needs. If the builder cannot
  express the axis, keep the buckets in the plan, say they cannot be built
  yet, and still message everyone on one path."*
- §7, the journey: *"A SPLIT BELONGS INSIDE THE JOURNEY, NOT AT THE DOOR. Put
  the dimension on a condition, a branch or an experiment, so each group gets
  its own treatment and the remainder keeps a path of its own. Entry
  conditions decide who is ELIGIBLE; they are not segmentation, and the
  application does not accept them as it."*

Two details worth keeping: the split point is a question the agent may ask,
and the cohort's own median or tertiles is the default — a rupee cutoff
nobody named is invention. And the number of buckets follows the manager's
dimension; three tiers off a dimension described as one comparison is
complexity we added.

### Verified

1025 unit (from 1013; 6 new segmentation-audit cases in
`strategyArchitecture.test.ts`, 3 of which fail against the old rule, and 6
new prompt assertions in `strategyOptions.test.ts`) and 118 agent-proto.
`tsc --noEmit` and `server:typecheck` clean; `check:server` at 37
pre-existing errors with none added. `SYSTEM` is 32,361 against the 33,500
cap. No live model calls, and nothing touched in Channel, REACH_ORDER,
toolsForPhase, the question list, the seed, `convertersSettled` or the render
skip.

## 2026-10-21 (cont'd) — The chat bubble is a colleague, not the lab
notebook. The activity panel is a flow, not a tool log.

All of this came from the same PIN-activation run, and the pattern is worth
naming: the parts of that conversation written BY THE APPLICATION read worse
than the parts written by the model. Our own strings were the defect.

### What the manager actually read

Turn 1 opened *"I've sent these two questions to the campaign manager."*
Written to them, about them, in the third person.

Turn 3 said *"I have put up two possible groups to go after and I am waiting
to hear which one you would back"*, then printed this underneath:

```
What I am working through:
- Acquisition channel or offer type at sign-up — set aside: ...
- Credit limit assigned: Manager states higher assigned credit limit
  correlates with faster activation; a real candidate segmentation axis for
  dosage/intensity.
```

Three bullets that were not the two groups, in our vocabulary rather than
theirs, with "set aside" as a status and "Manager states" as the voice.

Meanwhile the activity panel said "Agent thinking", claimed "6 lookups" on a
turn where no lookup tool was even available, and its Details panel opened
into raw JSON with no sentence anywhere in it.

### A1 — the held-proposal reply

The ledger is gone from the reply. The composer is now two things:

```ts
const heldProse = proseBefore(assistantText).trim();
const reply = [heldProse, renderBlocks(delta, decision.advice)].filter(Boolean).join('\n\n');
```

The model's own words when it wrote any, then what is still needed. **Never
the prose alone**: on a held propose turn the prose usually announces the
plan, and printing that by itself tells the manager a plan is settled on the
turn the gate refused it — the same shape as the "Built." defect from earlier
today.

**The ledger was there for a real reason**, recorded in the code it replaced:
an e2e failure where a refused turn rendered neither a question nor a
confirmation gate, so the user had nothing to act on. It was belt-and-braces
for that, and the braces are enough — `!decision.proceed` means at least one
block, and every block produces a part in `renderBlocks`. That is now a test
rather than a paragraph of internal state shown just in case, across three
blocking states plus the all-carried delta where an empty reply would hide.

The record is not hidden. It stays on the brief, and the
`discovery.questions` event still carries it in `data` for the activity
panel.

**One leak in `renderBlocks`**, found while looking: the multi-carried line
joined `clears.how`, and `how` is written for the MODEL — *"Record who
converts, or that nobody knows plus two candidate segments resting on
different things."* A manager cannot act on a sentence that is not addressed
to them. Both branches now use `reason`, which is the manager-facing half of
a block; the single-carried line already did.

### A2 — the tool result was teaching the third person

`ask_questions` returned:

```
Recorded 1 question(s). The manager will see them.
```

A tool result is the last thing the model reads before it writes, so its
register is the register that comes back. The prompt forbids the third person
in words; this was teaching it in practice. Now:

```
1 question(s) recorded. Now write your message, asking them directly.
```

Nothing about who sees it, so there is no third person to copy.

The prompt ban is in as well, as honesty rather than enforcement — the
banned list names what the run produced:

> NEVER WRITE ANY OF THESE: "I've sent these questions", "to the campaign
> manager" or any third-person reference to the person you are addressing,
> "set aside" as a status, "(retained)", "fork", "dosage". You are not
> reporting to someone else about them; you are talking to them. A question
> that double-checks something is welcome. Reprinting a question they have
> already answered is not.

### B — the activity panel

**Titles are the phase, in sentences.** "Gathering context" → "Reading your
brief and bank context". "Agent thinking"/"Agent continuing" → one title per
turn: `isBuildTurn ? 'Building the journey' : decide(brief).proceed ?
'Drafting the plan' : 'Writing a reply'`. That `decide` call is cosmetic and
commented as such — the real gate runs after the rounds. Later rounds keep
the same sentence, because the row is correlated and resolves in place and
the existing `detail` already says which round it is. "Agent answer unusable,
asking again" → "That reply came back empty, asking again" — a sentence about
what happened rather than a verdict on the agent.

**Every row's Details panel has a sentence above the JSON**, from one shared
helper so the two surfaces cannot drift:

```ts
export function detailsText(event: { title?; detail?; type? }): string {
  return event.detail?.trim() || event.title?.trim() || (event.type ? friendlyEvent(event.type) : 'No further detail recorded.');
}
```

So a row reads: **"Recording what you told me about customers"** (title) ·
**"Recorded who converts; 2 barrier(s)."** (detail sentence in the panel) ·
then the full JSON payload, unchanged, behind the same toggle. The JSON was
never the problem — showing only the JSON was.

**The lookup count was wrong, not just badly worded.** It counted every
`model.tool_call*` event, so a discovery turn that wrote three records
reported six lookups. Every tool emit now stamps `data.kind`, and the client
counts distinct correlation ids with `kind === 'lookup'`. Stage cannot carry
this — `requested` and `started` are emitted as 'understanding' for every
tool and only `completed` differs, so counting on stage replaces one wrong
number with another. The summary reads "N steps in this run", and adds ", M
lookups" only when M real lookups happened.

**Logs prefer `event.title`**, with `friendlyEvent` as the fallback for
events that carry none — `e.title?.trim() || friendlyEvent(e.type)`. Not two
maps kept in step by hand: `friendlyEvent` sees only the type, so it cannot
tell "Drafting the plan" from "Writing a reply", and maintaining a parallel
list is how the Logs tab and the Design panel came to name the same run
differently.

**`stripJson` is deleted, not re-worded.** It sliced the text at the first
`{` and, failing that, pulled `"summary"` and `"rationale"` out of a partial
payload with regexes. All three mechanisms were from the JSON-payload era and
two were actively wrong — the brace slice truncated any sentence containing a
brace, and the regexes could put a half-written internal field on screen as
though it were the reply. Replaced by `streamingText(text, fallback)`:
trimmed text, or "Drafting the plan…" / "Writing a reply…".

### Verified

1050 unit (from 1025; 25 new in `colleagueVoice.test.ts`, 7 of which fail
against the pre-fix code) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean; `check:server` adds nothing in
any file touched. `SYSTEM` is 32,747 against the 33,500 cap.

Retargeted: `tests/e2e/designer.spec.ts` matched `/What I am working
through/` to detect a held turn and now matches the block reasons themselves
(`I am still waiting on this|Still open|discovery continues`);
`emptyRoundRecovery.test.ts` pinned the old retry title.

Untouched as instructed: Channel, REACH_ORDER, `toolsForPhase`, the
question-list outstanding filter, `convertersSettled`, the segmentation
audit, the seed JSON, `preferLowerCostChannelFirst`.

## 2026-10-21 (cont'd) — The proposed journey is drawn BEFORE it is approved

The manager was being asked to approve a campaign they could not see.

`pendingBlueprint` has been on the propose-turn response since the confirm
gate existed, and did exactly one job: the payload posted back when the
manager clicked Confirm. Meanwhile the left pane showed a grey wireframe
captioned *"The journey appears here once you approve a plan."* So the one
turn with a real decision in it — approve this, or say what to change — was
the turn with the least to look at, and the picture arrived after they had
already said yes.

The data was there the whole time. This reads it.

### The shape of the change

`src/designer/preview.ts` — `previewFromBlueprint(bp): JourneyPreview | null`.
Pure, no React, unit-tested without a browser. Returns null when there is
nothing to draw, so the caller never renders a heading over an empty frame.

The client view is narrow and local, the same decision as `BriefView`:
`server/blueprint.ts` carries the compiler, the validators and the whole
documented `BpStep` union, and importing it would pull the server's campaign
machinery into the browser bundle to read six fields. `ViewStep` is
optional-everything rather than a discriminated union, deliberately — this
PARSES a payload rather than constructing one, so a blueprint from an older
run or one the model wrote slightly wrong still draws. A crash here would
take the whole propose turn with it.

### The rule the whole thing exists for

**Every path of every fork is drawn, including the one with nothing on it.**
`pathOf` gives an empty path a note — "No further messages on this path." —
rather than omitting it. A schematic that renders the treated arm and
silently drops the rest path tells the manager the campaign reaches everyone
when it does not, which would make the preview worse than no preview. It is
the same failure as the entry-narrowing one the segmentation audit now
refuses, one layer up. A campaign-level `controlPct` becomes a note on entry
for the same reason: the people who get nothing must not simply be absent.

### What it is not

Not `DripCanvas`. That renders a BUILT campaign — real nodes, real edges, a
node drawer, live validation, dagre layout — and none of that exists on a
proposal. Mounting it would also say the journey had been created. `graph`
stays null, `cd-has-journey` stays off, and the schematic is a row list with
no click handlers, pinned by a test that greps the component for `onClick`,
`editable` and `DripCanvas`.

Vertical and capped at 520px rather than a pannable canvas, because the job
is to be scannable in ten seconds, not navigable.

### Layout

The preview is in the LEFT pane only, on the same `.cd-work` surface, and it
replaces the skeleton rather than sitting beside it — two pictures of one
journey, one of them grey, is worse than either alone. The four brief cards
and the lines of enquiry collapse to a one-line strip on this phase; at full
size they push the schematic below the fold.

The decision stays on the right: `.cd-confirm` is untouched in the chat
column, with one sentence added — "The proposed path is on the left." The
strategy prose in the last agent bubble is unchanged, and there is no second
copy of the path in the chat.

`.cd-sends` (bank template ids) is held back until something is built.
Asking for template ids beside an unapproved plan reads as though the
campaign already exists, and spends the one decision this turn is for.

**Confirm swaps one picture for another.** While the build runs the schematic
stays up with the banner reading "Building the journey…" — an empty canvas in
between reads as the proposal having been thrown away.

### Verified

1082 unit (from 1050; 32 new in `journeyPreview.test.ts`) plus 118
agent-proto. `tsc --noEmit`, `server:typecheck` and `npm run build` clean;
`check:server` adds nothing. Rendered headlessly against a mocked propose
turn: heading "Proposed journey", banner "Proposed — not built yet.", five
path labels drawn including the empty `No` arm and the 10% holdout, zero
`.cd-skeleton`, zero `.react-flow__node`, `.cd-confirm` in the chat column
and not in the work pane, no sends panel. Then Confirm: banner flips to
"Building the journey…" with all five paths still on screen.

Untouched as instructed: Channel, the seed, the gate, `toolsForPhase`,
`convertersSettled`, the segmentation audit, the orchestrator reply and its
dropped ledger, and the activity titles.

## 2026-10-21 (cont'd) — Every chat is resumable; starting a new one
destroys nothing

"Start over" was a single unconfirmed click in the top-right that called
`clearSession()` and wiped the conversation. There was one session slot in
localStorage, no history, and no way back into a chat once you left it.

Run Logs looked like the history and was not. A `RunLog` is one TURN — a
transcript fragment with no brief, no session state and no pending
blueprint — so a five-turn conversation was five unrelated rows you could
read and never continue.

### The second defect, found while fixing the first

`saveSession` has always persisted `lastResponse`: the whole
`DesignerResponse`, carrying `phase`, `brief`, `session`, `pendingBlueprint`
and `pendingStrategy`. The mount restore read back four fields —
`messages`, `rounds`, `campaign`, `graph` — and ignored the rest. So a plain
RELOAD mid-conversation dropped the brief and the confirm gate while the
data sat in storage untouched.

It stayed invisible because the agent re-derives most of a brief from the
transcript. What it cannot re-derive is the gate state and the proposed
blueprint, which is exactly what a manager loses at the moment they most
want it back. Resume turned out to be mostly a matter of reading what was
always being written.

`stateFrom(session)` is now the single path, used by both the first mount
and a resume, so the two cannot restore different amounts of a conversation.

### The shape

- **`storage.ts`**: a keyed store of sessions, capped at 40, ordered by
  `updatedAt` with a monotonic `seq` to break ties — two saves inside one
  millisecond are ordinary when React flushes two effects together, and with
  a timestamp alone "the chat you were last in" opened the wrong one. Caught
  by a test, not in the browser.
- **Migration**: the old single slot is folded into the store on first read
  and then removed. An upgrade that lost the chat it was built to preserve
  would be a poor advertisement for it.
- **Empty chats are dropped** from the list except the current one — an
  empty session is written on every mount, and listing them fills the page
  with blank rows for an app that was opened and closed.
- **Run Logs becomes Chats**: rows are conversations, built from the session
  store UNION the run logs. Both sources, because they disagree in both
  directions — a chat whose first turn errored has a session and no log, and
  a log can outlive its session once the store hits its cap.
- **Two tabs on a chat**: Conversation and Logs. They answer different
  questions — "what did we agree" and "what did it actually do" — and were
  stacked on one scrolling page, so reading what was said meant scrolling
  past the events and back.
- **Continue this chat** is the primary action, in the header. `Delete` next
  to it. "Clear logs" no longer removes chats.
- **"Start over" is now "New chat"** and mints an id instead of wiping. No
  confirmation dialog, because nothing is destroyed — which is the better
  answer to the same problem.

### One choice worth recording

The Resume tab does not render a second chat UI. Resuming sets the open
session on the shell, which passes it to the ONE `CampaignDesigner` as a
prop and keys the component on it. One designer surface, two ways in; a
second chat implementation inside the list page would have drifted from the
first within a release.

### Found by running it, not by reading it

The chat detail pane was gated on `current` — the most recent `RunLog` — so
a chat with no completed run listed fine and opened to a blank pane. The
chat whose first turn failed is exactly the one someone comes back to, so it
was the worst possible one to have been unopenable. Now gated on the chat,
with each run-specific fact guarded individually.

### Verified

1104 unit (from 1082; 22 new in `chatHistory.test.ts`) and 118 agent-proto.
`tsc --noEmit` and `npm run build` clean; `check:server` adds nothing.
Exercised in a real browser against a mocked API: two chats created, New
chat leaving the first intact, both listed under Chats, tabs switching
Conversation/Logs, and Continue returning to the EMI chat with its message,
its brief strip, the journey preview and the confirm gate all restored.

Not done, deliberately: renaming a chat (the objective is a serviceable
auto-title) and anything beyond this browser — it is all localStorage, so
another machine sees nothing. The server-side `eval/runs/ui-<sessionId>/`
copies are unchanged.

### Same day — Chats became a table, and a run log became end to end

Two corrections to the above, both from looking at it with thirteen chats in
it rather than two.

**The split pane was the Run Logs layout showing through.** A narrow column
of chat cards beside the content made sense when a "row" was one TURN. As a
list of CONVERSATIONS it was a wall of cards with every title truncated,
taking a third of the width from the thing you opened it to read. It is a
table now — Campaign, Outcome, Turns, Last activity, Issuer — and a chat
opens full width with "← All chats" to go back. The page also stopped
falling back to `sessions[0]`, which had it opening mid-conversation in
whatever was newest before you picked anything.

**"Is everything printed in logs? Seems like some info is incomplete."** It
was. Measured on a real recorded turn, the run log dropped:

- `strategy` — 9,626 bytes. The plan: candidate architectures, which was
  chosen, why, and the verdict on whether they really differed.
- `brief` — 10,193 bytes. The findings: who converts, what is stopping the
  rest, every line of enquiry and what became of it.

So the log could tell you a proposal happened and never what was proposed,
or what evidence it rested on — for an agent whose entire purpose is those
two artefacts.

**Paid for by dropping the streaming transport.** 132 of that turn's 158
events were `model.text.delta`, about half the stored bytes, and they are
already reassembled into `reply`. Filtering them at write time more than
covers the brief and the strategy: the log is now SMALLER than it was and
complete. `errorDetail` is stored too, by the standing rule that the raw
provider error is kept everywhere.

A `RunSummary` panel reads them back at the top of the Logs tab as findings
and a plan rather than a JSON dump — objective, how success is judged, who
converts with its candidate segments, the barriers with whether they came
from the manager or the agent, the lines of enquiry with their status, the
plan, the approaches weighed, and what the agent checked. Every field goes
through one `Fact` helper that renders nothing when the value is empty, the
same rule as the architecture renderer: a bare caption reads as a question
about something that was never recorded.

Verified in a browser against a REAL recorded turn replayed through the
mocked API, so the panel is fed exactly what the server produces: ten
populated sections, the table listing one row, the left card list gone, and
the back link working. 1112 unit and 118 agent-proto green.

## 2026-10-22 — Confirm crashed, for every conversation

A live Confirm returned two agent bubbles:

```
Illegal state transition AWAITING_STRATEGY_CONFIRMATION -> CONFIGURATION_INCOMPLETE.
The connection closed before the run finished.
```

Two defects, one in each half of the stack, and neither is rare.

### Generation is two hops; the build tail took one

`AWAITING_STRATEGY_CONFIRMATION -> GENERATING_CAMPAIGN -> (EXPORT_ELIGIBLE |
CONFIGURATION_INCOMPLETE)`. The `isBuildTurn` tail jumped straight to the
outcome, and the table allows only `GENERATING_CAMPAIGN` out of a
confirmation — it is labelled "the only door into generation" — so
`transition` threw.

**The table is not what was wrong.** Widening it to permit the jump would
delete the single guarantee it offers: that no campaign exists without having
passed through generation. The skip was the bug.

The refinement path had the same skip and hid it by assigning the state as a
bare string — no throw, and a built campaign that never entered generation.
Quieter and worse. Both go through `transition` now.

### Why no test caught it, which is the part worth keeping

There has always been a confirm path with both hops: the short-circuit
guarded by `intent === 'confirm' && req.confirmedBlueprint`. Every existing
test supplies `confirmedBlueprint` and therefore walks that one.

The real client cannot. It sends `confirmedBlueprint: pendingBlueprint`, and
a propose turn returns `pendingBlueprint: null` BY DESIGN — so the guard
never passes in the app and EVERY live Confirm fell through to the broken
tail. The code comment above that tail already said "every test supplies
`confirmedBlueprint` directly, so none of them walked the path the app
actually takes". It was right, and it stayed right until this fix.

`confirmReachesGeneration.test.ts` sends `confirmedBlueprint: null` and
delivers the journey through a `build_campaign` tool call, the way the agent
actually does. Reverting either hop fails six of its ten cases with the live
error text.

Two things the fixture taught, both now comments in the test:

- **`isBuildTurn` does not bypass the gate.** An unsatisfied brief holds the
  turn in discovery and the crash never gets a chance to happen, so the
  fixture asserts `decide(brief).proceed` before it proves anything else.
- **The crash sits behind the design audits.** A send that cites no recorded
  barrier is refused by `checkBarrierCoverage` long before the tail, so the
  fixture cites `cost-perception`.

### An error frame is terminal

`stream.ts` set `sawResult` only on a result frame, so an `error` frame
called `onError` and left it false — and when the socket closed the fallback
fired a second time. That is the second bubble: one real failure, one
invented, and the invented one read last. Renamed to `sawTerminal` and set by
both doors; the fallback still fires when NEITHER arrives, because a silent
stream must not read as success.

### Verified

1122 unit (from 1112; 10 new) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. `conversationFlow`'s pin on
`if (isBuildTurn) { const out = buildAndValidate(` was retargeted to require
the hop between them, which is a stronger assertion than the one it replaced.

### Not in this slice

Carrying a blueprint at propose time. That is the next product fix — it buys
the journey preview and removes the second strategy essay on the build turn —
and it is not what this crash was.

## 2026-10-22 (cont'd) — The canvas was empty because the compiler dropped
every step the agent designed

A manager approved a two-arm message-wording experiment and Confirm returned
"Built the journey: 0 message steps, 4 steps in total. It is on the canvas
now." The canvas held an entry, an experiment and two auto-inserted goal
exits. Twelve designed steps, none of them built, and fourteen issues in the
chat — twelve of which were the compiler reporting its own confusion back to
the user.

### Four causes, none of them the agent

**An arm was treated as one step.** `addSteps` honoured its attachment point
for the FIRST step only; every later step called `nextInChain`, which searches
the WHOLE graph. Two arms leave two open slots, so from each arm's second step
the answer was always "2 open slots exist; the continuation is ambiguous". The
code said so in a comment: `target = undefined; // only the first step of an
arm uses the explicit target`.

Ambiguity ACROSS arms is not ambiguity WITHIN one. A chain now continues from
the node it just inserted — `continuationAfter` reads only the slots belonging
to nodes that step created, so the search cannot wander into a sibling arm.
`nextInChain` stays for the genuinely open case.

**A send without `objective` was deleted.** It pushed an issue and returned
before inserting. Both arms opened with one, so even the first step of each
arm was gone. The keywords exist to search a template library: their absence
makes that search worse, it does not make the message imaginary. The step is
built, keywords are derived from the name and description the agent DID write,
and `['message']` is the floor — honest, because it narrows nothing.

**`equals` was rejected as an unknown operator.** It is `Equals` spelled the
way an API is spelled. `builderOperator` folds case and separators and then
matches EXACTLY against `dcOperatorsForAttribute`. `within_days` still fails,
deliberately: the nearest match by string distance is `Less than`, and folding
a relative window into an absolute threshold would silently build a different
campaign than the one approved.

**Invented attributes were written onto the node.** The audience path never
returned early on bad conditions — it put them on the graph. So a node could
carry "PIN Set", which Card does not have, and the campaign looked built while
filtering on nothing. `expressible()` now drops exactly the unbuildable
condition, keeps the rest of the entry and the whole journey, and records a
limitation naming what was asked and what the entity actually has.

**Nothing was added to `src/`.** `sharedConstants.ts` has no diff. An agent
reaching for "PIN Set" on Card is telling us which attribute the platform is
missing; swapping in "Virtual Card Activated" would destroy that signal and
ship the wrong campaign in the same move.

### The prompt was denying two capabilities the builder has

`blueprintVocabulary` listed, under "Builder capabilities this blueprint
CANNOT express":

- "A branch with more than two outcomes… You have the two-way condition only."
- "A condition on anything except the previous send's delivery outcome."

Both false since the entry-vocabulary round. `buildFromBlueprint` compiles
`kind: 'branch'` into DECISION_SPLIT and `condition.on` into a SPLIT on a
customer attribute. So every turn the agent was told its two tools for
treating groups differently did not exist — and then measured on how flat its
campaigns were.

**A test was holding the lie in place.** `constructible()` fed one blueprint
per step kind and omitted `branch`, so "the builder genuinely never constructs
one" passed by sampling rather than by truth. It now feeds a branch and an
attribute condition and asserts the opposite.

A prompt that UNDERSTATES the platform costs more design quality than one that
overstates it: the agent simply stops reaching.

### Confirm can now look the catalogue up

`toolsForPhase(designSeen)` → `toolsForPhase(designSeen || isBuildTurn)`, both
call sites. `designSeen` starts false, so an approval arrived with
`build_campaign` and no `list_*` at all — the model wrote entity names,
attributes and operators from memory on the one turn where each has to be
exact. Discovery is untouched: both operands false still yields `[]`, and
`turnOneAndQuestionList` re-asserts that against the new expression.

`CONDITION.operator` was `{ type: 'string' }`, so `within_days` was valid as
far as the API was concerned and failed deep in the compiler after approval.
It is now an enum computed from `dcOperatorsForAttribute` over every
`AttrType` plus `LOCKED_ATTR_OPERATORS` — derived, not a second hand-written
list.

### Two honesty fixes on the way out

`renderBuildSummary` said "Built the journey… It is on the canvas now"
unconditionally. With zero sends it now says generation produced no message
steps. The compiler fixes make that rare, so it is a safety net — kept because
the rule is.

`limitations` was computed, returned and never rendered, so a journey that
quietly filtered on less than was asked for looked complete. It now prints as
"Platform cannot express yet", which is also the capability backlog.

### Verified

1139 unit (from 1122) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. The checkpoint fixture
reproduces the screenshot — two arms, opening sends with no objective, waits
and second sends — and fails four ways against the pre-fix compiler. No live
Confirm was spent; the next one is worth running because all four causes are
out.

## 2026-10-22 (cont'd) — A plan has to name its sends

A fourteen-day activation proposal described "a staggered multi-touch
sequence over the full 14 days, spaced by read/response rather than a fixed
clock" and named not one message. The manager approved a cadence they could
not see, and the build turn then invented it from that sentence.
Under-dosing is invisible in prose: three touches and nine read the same.

### `touches`, required, minItems 2

Every customer-facing send in the chosen plan, one row each — day, channel,
path, purpose, and what happens if it does not land. Required by the tool
schema, so the provider refuses a plan without it. The same move that stopped
`within_days` an hour earlier: a constraint the API enforces costs nothing to
maintain and fires before any of our code runs.

It carries no node types, entities or events, so the standing principle holds
— the builder's grammar still arrives only after approval. When the
propose-turn preview lands, this is the list it should draw, which is why it
is flat rather than a second step tree.

### No window is parsed, and that was the important decision

The brief asked to gate on "a window of 7+ days". There is no structured
window anywhere — "14 days" lives only inside `approach[]` and `timing` prose
— so that would have meant regexing a number out of free text to RAISE a
block. `record.ts` states the rule the application runs on: a judgement about
someone's words may only ever RELEASE a block, never create one, so a false
positive costs a stated assumption rather than a loop. It is also brittle in
the obvious way: "two weeks", "the first fortnight", "before it expires at
day 7" all read as no window at all.

So the requirement is unconditional. `cadenceBlocks` is the backstop for a
payload that arrives without the field, and the schema does the rest.

### Three things found while building it

**A new block is never one line.** `Block` requires `clears: Mutation`,
`satisfy()` must handle that variant, and `gateClearability` proves by
property that applying the mutation clears the block. `touches` joins
`hypotheses` as a PROPOSAL mutation — something the model writes next time,
not something the brief can be bent into.

**The block must not fire on a build turn.** It did at first, and it broke
Confirm. `building` is true on Confirm and refinement, where the manager has
already approved this plan: refusing there is useless and insulting, because
there is nothing they can do about a missing field from the build turn and
the moment to say so was before they agreed.

**The fork-guard fixture stopped testing forks.** Its injected proposal had
no `touches`, so the fork became the SECOND reason it was held. Fixed the
same way as the barrier citation earlier today — make the proposal valid in
every other respect so the thing under test is the only variable. Worth
noticing as a pattern: each new structural check quietly invalidates
fixtures that were written as "a good proposal", and a fixture that fails for
two reasons proves neither.

### Two descriptions, checked rather than merged

`touches` and the blueprint both describe one journey, and two descriptions
drift — the bug class behind an architecture printing `undefined`, two
event-label maps disagreeing, and one session slot against a keyed store. The
answer is not to delete one: the manager approves the list, the builder needs
the blueprint. `renderBuildSummary` now counts the sends it built against the
sends that were approved and reports any difference. **Counted, never
coerced** — no step is added that nobody designed, and the plan is not edited
to agree with the build.

### §7

"A THREE-MESSAGE CLOCK IS NOT A PLAN" is gone. It was a correction to an
earlier over-correction and it over-corrected in turn: it reads as "do not
list reminders", when the fix for a flat schedule was never to name FEWER
sends — it was to react to what happened. The rule splits in two: EVEN
SPACING WITH NO REACTION IS NOT A PLAN keeps the reaction requirement, NAME
EVERY TOUCH adds the list. Send count still cannot tell two architectures
apart.

`SYSTEM` is 33,420 against the 33,500 cap. The first draft ran 234 over and
the cap was NOT raised a fifth time — the new text was cut instead, which is
the right place to take it from since it is the newest prose in the file.

### Verified

1148 unit (from 1139) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. No live model calls.

### Same day — both "enough sends" counters were measuring the wrong thing

Two follow-ups to the cadence work above, and the first one is a rule I wrote
backwards an hour earlier.

**`cadenceBlocks` measured the BUSIEST path.** `primaryPath` took the path
with the most rows, on the reasoning that a group which mostly acts
unprompted needs only a light touch. Read against the run that prompted all
of this, that IS the failure: the high-limit cohort — the one that
self-activates anyway — got two nudges and cleared the gate, while everyone
else, the people the campaign exists for, got a single send that nothing ever
looked at. A thin path hid behind a busy one.

Worse, I had written a test asserting exactly that: *"measures the BUSIEST
path, so a light path cannot stand in for the cadence"*, expecting
`High limit ×2 + Everyone else ×1` to PASS, with a comment rationalising it.
The comment is what made it read as reasonable. A test can encode a bug as
firmly as code, and a confident comment on a wrong test is harder to spot
than the wrong line itself.

Now: EVERY named path needs at least two sends, and the refusal names the
thin path — "Everyone else" gets a single message — so the manager knows
which group is being under-served. A holdout is not caught by this: `touches`
lists customer-facing sends, so a deliberately unmessaged arm contributes no
rows and never appears.

**The Confirm diff compared totals.** `planned = touches.length` against
every SEND node in the graph, and `built_ !== sends` was dead code — the same
expression twice. A two-arm wording experiment builds one skeleton twice, so
four approved touches became eight SEND nodes and the banner reported a
four-message shortfall on a correct build. A banner that cries drift when
nothing drifted teaches people to ignore it, which is worse than no banner.

What a customer experiences is ONE route, so that is what is compared: the
fullest path of the plan against the longest path of the graph.

**`longestSendPath`** lives in `journeySummary.ts`, which already owns graph
walking. Memoised per node, with a visiting guard: the builder allows fan-in —
the canvas has a "Reused in N places" badge for it — so a plain walk would
count a shared ending once per route that reaches it, and would spin for ever
on a cycle. Both are covered by tests rather than assumed, including a
deliberate cycle that must terminate rather than hang a Confirm turn.
GOAL_EXIT is ignored: it is the application's own terminal, not a message.

Still counted, never coerced. No step is invented to make the numbers agree,
and the approved plan is not edited to match the build.

Verified: 1157 unit (from 1148) and 118 agent-proto, everything else clean.
Not in this slice, deliberately: matching day 3 against day 4, or WhatsApp
against SMS. That needs a rule for what counts as "the same touch", which is
a decision rather than an implementation detail.

## 2026-10-22 (cont'd) — One omitted field took down a live Confirm

The manager sent "Confirmed. Build this campaign." and got:

```
Cannot read properties of undefined (reading 'replace')
```

A raw TypeError in the transcript, no canvas, nothing to do next.

### The chain

`build_campaign` requires neither `name` nor `describe`. The model omitted
both. On a real tenant `templateLibraryAccess` is `'unavailable'`, so no
template is ever matched and EVERY send falls through to `proposeMessaging`,
which read `need.describe.replace(...)`.

`TemplateNeed.describe: string` is a statement about what callers should
pass. It is not a guarantee about what arrives from a model. The `stage`
field three lines earlier already had the guard — "a malformed field must be
a reported issue, not a 500" — and these two did not.

### Three fixes, in order of how much they matter

**`proposeMessaging` no longer assumes a string.** `String(need.describe ??
'').trim()`, and with nothing there the placeholder is a greeting and a link
rather than an invented purpose. Making something up would be worse than a
blank: it would read as the agent's intent.

**A send with no name or description still builds.** Both become reported
issues; `describe` falls back through `describe → name → copy → 'this
message'`. The node also gets a `stepName` from the same fallback, because
inserting a SEND whose name is `undefined` is only half-inserting it — the
canvas card renders blank and `sendProposals` cannot be matched back to it.
Same rule as the missing `objective`: a quality problem, not a deleted step.

**The compile boundary is guarded.** The build is the one place where an
unbounded amount of model-authored data meets application code, and the
schema cannot require every field the compiler reads — so there will be
another hole. When there is, it costs a sentence and the provider's own text,
not the session. The brief and the session are returned untouched.

### A third call site the first guard missed

Guarding `buildAndValidate` was not enough. `assessGraphReadiness` dry-runs
the SAME compiler at strategy time, outside that guard — so a hole there
takes down a PROPOSE turn, where nothing is even being constructed. A
readiness check that can crash the thing it is reassuring you about is worse
than no readiness check. It now reports `blocked` with the reason, which is
honest: we do not know whether this would build.

Found by the test failing after the guard was added, not by reading.

### The test tests the guard, not the hole

`buildFailureSurvives.test.ts` mocks `buildFromBlueprint` to throw rather
than feeding it a known-bad payload. A payload that throws today gets fixed
tomorrow and silently takes the test with it; mocking keeps the assertion
about what happens when the compiler fails, whatever the reason.

Getting there took three attempts, each one informative: a malformed
`steps` was absorbed, a broken `arms` was refused by the experiment audit
before the compiler ran, and the audits refuse an uncited send earlier still.
The compiler sits behind three design checks, which is part of why this
survived so long.

`missingTemplate.test.ts` covers the specific hole, and reverting either fix
reproduces the live error text exactly.

### Noticed, not fixed

The experiment audit iterates `arms` as a string when given one, producing
"and and and and" in a message to the manager. It does not throw, so it is
outside this slice.

### Verified

1172 unit (from 1163) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. No strategy change, no new
attributes, nothing added to the tool schema — the compiler has to survive a
live model omit, and now does.

## 2026-10-22 (cont'd) — "I cannot build this. My role stops at proposing."

With the compiler crash fixed, the next live Confirm failed differently: the
agent replied that it could not build, that its role stopped at proposing,
and that the tool was not available to it. No canvas. The compiler never ran.

It was reading exactly what we sent. On that one turn it received, together:

- `tool_choice: 'none'` — a rule written to stop catalogue re-fetches, which
  also forbade `build_campaign`;
- `propose_strategy`, whose own description reads "Do not call
  build_campaign in the same turn: the manager approves the plan first";
- a prompt line asking it to `Return ONLY {"action":"propose",…,"blueprint"}`
  as text rather than call the tool;
- a SYSTEM prompt saying deterministic code builds the graph.

Four instructions, three of them saying do not build. The reply was the
honest reading. **The agent was not wrong; the turn was.**

### Four fixes, all removing a contradiction rather than adding a rule

**The withdrawal is about lookups.** `stopLookingUp` ended a real loop — a
run spent three rounds re-reading results it already had — but it did it by
forbidding EVERY tool. Now `withdrawLookups = stopLookingUp && !isBuildTurn`:
the `list_*` tools drop once exhausted, the output tools always travel, and a
build turn is FORCED to `build_campaign`, because a turn whose entire purpose
is to build has nothing else to decide.

The invariant behind the old test survives and is now stated as itself: the
tools array is never EMPTY. Sending a history of `tool_use` and `tool_result`
blocks with no tools attached made the model answer with an empty turn and
killed three evaluation scenarios. That is what must not come back — not
"every definition always travels".

**`propose_strategy` is off the Confirm turn.** The plan is already approved;
offering to propose it again is an invitation to go round once more, from a
tool that explicitly says not to build. The record tools stay — a build turn
still finds things worth writing down, and dropping them would quietly empty
the record on the last turn of the conversation.

**The prompt asks for the tool.** "CALL build_campaign NOW… never tell them
the build is unavailable to you: it is not, and saying so leaves them with an
approval that did nothing." Plus: if part of the plan cannot be expressed,
call the tool anyway with what can be built and record the gap.

**A build turn is recovered by building.** The empty-round recovery asked for
"the single JSON object described in OUTPUT" with `tool_choice: 'none'` —
which on a Confirm is the same instruction that caused the failure it was
recovering from. Telling a model that just said it cannot build to answer in
prose again is agreement, not recovery. Gated on `!toolBlueprint`, so a turn
that DID build is never asked to build again.

### The typed sentence

The button posts `intent: 'confirm'` AND the words "Confirmed. Build this
campaign." Someone who types those words — reasonably, since they are on
screen in their own transcript — sends no intent, so the turn was not a build
turn at all.

`saysBuildNow` is an EXACT match on that one phrase, deliberately not reusing
`saysProceed`. That helper is loose on purpose ("go ahead", "stop asking")
because a false positive there costs a stated assumption the manager can
correct. Starting a BUILD on a loose match is a different risk: "do not build
it yet" contains "build it".

### Verified

1180 unit (from 1172) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. SYSTEM 33,454 / 33,500.
Reverting the three contradictions fails four of the new tests. Discovery
untouched; no new attributes; no strategy change.

## 2026-10-22 (cont'd) — `(barriers ?? []).some is not a function`

A live OS-to-EMI turn died after the manager mapped click to
page-open/button-click. The model sent `barriers` as a STRING. `?? []` only
replaces null and undefined, so the string survived: `.length` worked,
`.some` did not, and the TypeError escaped as the assistant's message. No
canvas.

**Second crash of this exact class in one day.** The Confirm crash was
`describe.replace` on a field the schema does not require; this is `.some` on
a field whose schema says array. The shared lesson, now written where it will
be read: a declared type is a statement about what callers should pass, and
a model is not a caller. `as Barrier[]` asserts; it does not check.

### The tell was in the same function

`record_dimensions` and `ask_questions`, a few cases below, already did
`Array.isArray(...) ? ... : []`. So `applyOutputTool` carried both habits
side by side and which one a field got was down to who wrote it. That is not
a judgement call worth preserving — it is an inconsistency that reads as one.

`asList` now does it everywhere:

- an array is used;
- **one object becomes a list of one** — a near-miss worth accepting, because
  the model found a single barrier and sent it rather than a list containing
  it;
- anything else becomes EMPTY and is never iterated. A string would otherwise
  yield one "barrier" per character, which is worse than the crash: it would
  have been *recorded*.

A wrong shape returns a tool error naming the shape wanted, reported
separately from "you sent nothing" so the model can tell the two apart. The
brief and session are untouched and the turn continues.

### Four places, not one

`barriers` crashed. `converters` (read as `.shape.trim()`),
`converters.candidates` (`.filter`), `contextChecked`, `questionResolutions`
and `architectures` (`.map`) all had the same shape, each one line from an
iteration. Fixing only the one that happened to fail would have left the
boundary with five known holes and a test proving one of them shut.

Beyond the literal brief, deliberately: the stated goal is that the tool
boundary survives a live wrong shape, and a boundary with holes left in it
does not.

### Verified

1188 unit (from 1180) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. Reverting the coercion
reproduces the live error text. No schema tightening — the boundary had to
survive the wrong shape, not be protected from receiving it.

## 2026-10-22 (cont'd) — Two guards that spoke for the manager

A live Confirm failed twice, on two different checks, and both failures have
the same shape: the application took a position the manager had not taken and
then refused their build over it.

### "You told me: customers may notice individual eligible-purchase pings but tune out…"

They had said nothing of the kind. The agent had floated that as a rival
theory, which is its job. Three mechanisms turned it into their words.

**`recordBarriers` merged and never deleted.** A theory named on turn three
and dropped on turn five stayed on the record for ever. The prompt asks for
barriers on every turn, so a sent list is the agent's current position, not
an increment — `recordConverters` has always replaced for that reason. Now so
does this. The empty guard stays and carries the whole distinction: replace
on SENT, keep on OMITTED, so a converters-only turn does not wipe the
barriers. A barrier that survives also keeps fields the update did not
repeat — terseness is not retraction, and the quote is the evidence.

**`quoteIsTheirs` scored 40% word overlap across the whole transcript.** In a
long EMI conversation that is nearly free: an invented theory borrowed
*customers*, *repeated* and *purchase* from three unrelated sentences, cleared
the bar, and was UPGRADED to `user-belief` by the promotion rule. That rule is
right and stays — a correctly-evidenced barrier mislabelled `assumption` once
deadlocked the gate for eight turns. What changed is the standard of
evidence, not the rule.

The match must now fall inside ONE sentence they wrote, as a contiguous span
scored on content words. **Confinement to a single sentence is the fix**, not
the threshold — the old check could assemble a quote from the whole
conversation.

**The denial case is the trap a contiguity check walks into alone.** "I did
not say they tune out repeated pings" contains the phrase verbatim. So the
text leading up to the match is checked for a denial — with the quote's own
words excluded from that test, which is what lets a barrier that is ITSELF
about an absence ("they do not know how to set the PIN") still verify.

Failing verification only ever RELEASES: the barrier stays an assumption,
which `mustBeAddressed` now excludes, so a false negative costs an obligation
rather than creating one. That is the rule from `record.ts`, holding here too.

**`mustBeAddressed` excludes assumptions.** An invented barrier is a
hypothesis worth testing, not a promise anyone made. `isDesignable` and
`mustTestBarriers` are untouched: a campaign may still be built on an
assumption and must still TEST it when it is all there is.

The refusal copy now says "You told me" only for `user` and `user-belief`.

### "Which groups should this campaign treat differently?"

On an EMI campaign the manager said every eligible purchase, one track, do
not split. Confirm refused the build and asked which groups to treat
differently — **the exact question discovery was rewritten never to ask**,
arriving at the moment they have least power to refuse it.

`mustLearnAudience` is true whenever converters are not `known`, and
`checkAudienceLearning` then refused any flat journey. A design rule that
overrules an explicit instruction is not a rule; it is the application
designing the campaign. It also contradicts the segmentation principle
directly — a dimension changes the PATH, and they had said there is no
dimension. The holdout already gives the comparison against sending nothing.

It is a limitation now. The sentence is unchanged and lands on
`strategy.designWarnings`, which `renderStrategy` prints under "What this
design cannot do" — **recording a cost where nobody reads it is the same as
dropping it**, so the test asserts both the brief and the rendered warning.

### Verified

1205 unit (from 1191) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. Reverting either guard fails
the new tests. Barrier and audience coverage still run on the BUILD turn
only — propose has no journey to check.

### Known residual

Words that coincide inside one of their own sentences can still verify a
quote. That is a far smaller surface than the transcript and needs an
accidental near-collision. Tightening further starts rejecting honest
paraphrases, and the record would then carry the agent's label instead of the
manager's belief — the more expensive mistake of the two.

## 2026-10-22 (cont'd) — A user-stated audience settles who-converts,
whatever `knowledge` says

The third live gate failure of the day, same campaign manager, same shape of
fault as the two above: the application held a position they had not taken.

### The turn, from the record rather than from memory

`eval/runs/ui-s-1792661509156/turns/turn-3.json`:

```json
{ "shape": "No distinguishing pattern found. Every newly issued card that has
   not yet transacted is treated as one group, on one track, with no split by
   how it arrived.",
  "basis": "user", "knowledge": "none-yet", "candidates": [] }
```

They had said: record converters as known, every newly issued card that has
not transacted, one track, do not split. The record held it faithfully. The
reply ends `"I do not yet know who does this today, so I cannot say who the
campaign should go after."` — and re-asked who converts. Propose never fired.
The run only recovered because the model happened to send `knowledge: 'known'`
on the next turn.

### Two true statements, and the gate read the wrong one

`convertersSettled` keyed on `knowledge` first and only accepted a user-stated
shape under `'known'`. But `knowledge` answers *can anyone say who converts
faster today* — "no" was correct here. The AUDIENCE question is *who is this
campaign for*, and they had answered it in one sentence. Both fields were
right; settledness depended on which of two true things the model wrote down.

Now: **`basis === 'user'` plus a non-empty `shape` settles it, whatever
`knowledge` says.** The two-candidate path is the fallback for when there is no
user-stated shape.

`mustLearnAudience` is untouched (`knowledge !== 'known'`), so the obligation
to find out who responds still holds — as a limitation on the design, which is
where the previous slice put it.

### What this gives up, stated rather than buried

`recordConverters` refuses an empty shape outright, so "no user shape" means a
non-user basis in practice. The two-candidate requirement therefore now bites
only where the shape is the AGENT'S — which is where it was always aimed, but
it does mean a user-attributed non-answer ("nobody can say who converts")
settles the finding with no candidates. That is the narrowed remains of the
hole this function's history describes.

Closing it would mean reading their prose to decide whether a shape names a
group or reports an absence, and judging their words to RAISE a block is the
one thing `record.ts` forbids. It is caught on the design instead. There is a
test asserting the residual as behaviour, with that reasoning, so the next
person to tighten this reads it before they do.

### Two fixtures changed basis, and that is the interesting part

`findings.test.ts`'s nobody-knows group and `proposeTurnDefects.test.ts`'s
`pinActivation()` both used `basis: 'user'`. Written that way they now pass
every candidate assertion via the shape clause without a candidate rule ever
running — green, and testing nothing. Both moved to `assumption`, which is
also the honester label for a shape the agent wrote characterising a
non-answer.

**Third time this pattern has appeared today** (the fork-guard fixture with no
`touches`, the confirm fixture with no cited barrier, these two): a change to
what counts as valid silently invalidates fixtures written as "a good
record", and the failure mode is a test that still passes for the wrong
reason. Worth checking the fixtures of every group that touches a rule, not
just the ones that go red.

### Verified

1211 unit (from 1205; 6 new in `findings.test.ts`, 3 of which fail against the
pre-fix clause — confirmed by reverting it) and 118 agent-proto. `tsc
--noEmit`, `server:typecheck` and `npm run build` clean. Nothing pushed. No
prompt, schema, tool or strategy change; `mustLearnAudience`, the segmentation
audit and the barrier rules are untouched.

## 2026-10-22 (cont'd) — The Confirm that looked things up, wrote prose,
and built nothing

A live Confirm on the activation campaign returned "The journey is built…"
with the left pane still reading "What I have so far." No graph in the
response. The activity panel showed lookups. Underneath the sentence, gate
text: "That settled one of the things I was waiting on", plus `belief-untested`
about a PIN/app dimension the manager had rejected.

The canvas draws `res.graph` and there was none, because the compiler never
ran. A real build says "It is on the canvas now" from `renderBuildSummary`.
**The agent's own prose is not evidence that a campaign exists** — and the
application printed it as though it were.

### Why nothing caught it: the recovery could not fire, and could not work

`mustBuild = isBuildTurn && !toolBlueprint` was ORed into the empty-round
recovery, which exists to re-ask after a round that produced nothing usable.
Two independent faults:

- **It was gated on `!toolUses.length`.** Lookups came back to build turns
  earlier the same day, on the good argument that the one turn where entity
  names and operators must be exact is the turn that should check them. From
  that moment a Confirm that looked anything up could never qualify as an
  empty round, however little it built. The two changes were individually
  right and jointly made this unreachable.
- **It could not have applied the result anyway.** The retry read `chunk.text`
  and `chunk.done` and then broke out of the loop. `chunk.toolUse` was never
  collected, so the `build_campaign` call it forced with `tool_choice` was
  discarded unread. It was forcing a build and throwing it away, which is
  indistinguishable from never having asked.

So the build is not that recovery's job any more. `mustBuild` is deleted and
the forced build sits AFTER the round loop, where the only question left is
whether a journey arrived and the answer can be acted on. It sends the output
tools alone — `tool_choice` forces `build_campaign`, so a lookup could not
fire even if it travelled — collects every `tool_use`, and runs it through
`applyOutputTool`, the one boundary where model output becomes application
state.

Nothing is invented: no synthesised blueprint, no promoted prose.

### An approved plan with no journey is an error, not more discovery

With no blueprint the turn fell through to branches written for discovery: the
record had moved, so it returned the discovery phase with the model's sentence
as the reply. That exit is now explicit and returns what the compiler's own
failure returns — nothing built, nothing changed, ask for a change or try
again, with the brief and session intact. Never a graph, never a success
sentence, never the brief pane.

### The second half: the gate was discarding approved builds

Forcing the build is necessary and was not sufficient. `if (!decision.proceed)`
sits in FRONT of the build tail, so a journey could be obtained and then
thrown away — which is what happened live, over `belief-untested`. Refusing
there is the same mistake the cadence block and the audience check each made
in turn: **the moment to raise a gap in the plan is before they approve it.**
Afterwards there is nothing the manager can do with the refusal except approve
again, and the campaign they agreed to does not get built.

So on an approved build the blocks become limitations — each block's `reason`
is its manager-facing half, so it lands verbatim under "What this design
cannot do" and on `brief.verdicts`. Skipping the refusal silently would have
been worse than refusing: the cost would vanish on the one turn that produces
a campaign.

### `approvedPlan`, and the field that looked right and was always empty

```ts
const approvedPlan =
  isBuildTurn && ((req.intent ?? 'converse') === 'confirm' || isRefinement || session.state === 'AWAITING_STRATEGY_CONFIRMATION');
```

The first draft keyed on `req.confirmedStrategy`, which reads as exactly the
right signal — the client posts `confirmedStrategy: pendingStrategy` on
Confirm. **It is always undefined.** `CampaignDesigner` sets its
`pendingStrategy` from `next.pendingStrategy`, and no server response has ever
carried that field; the propose turn returns `strategy`. So the branch would
have been a no-op in the app while passing any test that supplied the field by
hand — the same shape of failure as the `confirmedBlueprint` short-circuit
that hid the Confirm crash for weeks. Both signals used instead are things the
application itself knows.

What this deliberately excludes: someone who types "Confirmed. Build this
campaign." DURING discovery. That sentence is on screen in their own
transcript, so it does get typed, and nobody should be able to skip discovery
by repeating it back.

### Two test-shape lessons, both from this slice

**A source-text slice whose end marker no longer exists silently becomes
"the rest of the file".** `emptyRoundRecovery` sliced from `emptyRecoveries++;`
to `if (!toolUses.length) break;` — a line that stopped existing when the
design step landed, so `indexOf` returned -1 and two tests had been asserting
against everything to EOF. They passed because their assertions were positive
matches found further down. Retargeted to the marker that exists, which is
what made a negative assertion possible at all.

**The `phase: 'error'` count is pinned at 8 now, from 7.** That assertion
exists so a new error path has to be looked at rather than slipped in without
the brief, and it did its job.

### Verified

1218 unit (from 1214; 9 new) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean; `check:server` unchanged at 37
pre-existing errors. Each of the four fixes was reverted individually and
fails tests: the forced build (5), collecting its `tool_use` (4), the gate
exemption (2), the build-failure return (1). Nothing pushed.

### Known, not fixed in this slice

`pendingStrategy` is read by the client and sent by nothing, so
`req.confirmedStrategy` is dead on every live Confirm. Harmless now that
nothing depends on it — the only other reader is the `confirmedBlueprint`
short-circuit, which the app never reaches — but it is a field the client
believes it is sending.

## 2026-10-22 (cont'd) — Chats: the logs that were evicted, and the journey
that was never shown

Two questions, and the first one I answered wrongly before measuring it.

### The wrong answer, recorded because it is the lesson

I read `appendRunLog`'s `events: (res.events ?? []).filter(...)`, saw that
events arrive as their own SSE frames, concluded the result frame never
carries an `events` array, and changed the client to collect them itself —
with a comment explaining a defect that does not exist. **`response.events`
is populated.** `base` carries it; a real recorded turn has 229 of them. The
change was reverted and so was the test rewritten to assert the false story.

Reading the code is not measuring it. The recorded turns were on disk the
whole time and one `node -e` would have settled it in ten seconds.

### What was actually wrong: the caps are in different units

Reproduced in a browser with sixteen chats of five turns each.

- Run logs: capped at **60 TURNS** globally, `slice(0, 60)`.
- Sessions: capped at **40 CHATS**.

A turn budget divided by turns-per-chat IS a chat budget. At five turns the
logs covered the newest **twelve** chats; four chats listed, opened, and
showed an empty Logs tab reading *"No run has completed in this chat yet"*
about five runs that had all completed. The transcript went with them,
because the Conversation tab was built from the logs too — while the messages
sat unread in the session store.

Three changes:

- **Eviction is per chat, oldest first** (`pruneRunLogs`), so a chat's logs
  are all there or all gone. The old slice cut mid-chat, which is the hardest
  state to read: nothing says which turns are missing.
- **The transcript falls back to `session.messages`**, which is the better
  source anyway — the chat is what the user keeps, the log is diagnostic
  detail. A chat whose logs went says so, once, at the top.
- **`write` reports failure instead of swallowing it.** It returned void and
  caught everything, so once the quota filled the app carried on as though it
  had saved and every chat and log from then on was silently discarded.
  `appendRunLog` now drops the oldest chat and retries, down to one chat,
  before giving up — the turn that just happened is the one worth keeping.

`MAX_LOG_CHATS` is 12 against `MAX_SESSIONS` 40, and that asymmetry is now a
decision with a number behind it: a real log measures ~40 KB against a ~5 MB
origin quota.

### The journey a chat built had nowhere to be shown

A chat whose whole point was to produce a journey could be opened, read end
to end, and never show the journey. `campaignSnapshot` was already stored and
`DripCampaign.root` is the graph, so nothing new had to be recorded — a third
tab reads it.

`DripCanvas`, the real component, **read-only**. This is not the propose-time
preview, which is a schematic precisely because no journey exists yet; here
one does, so showing the real thing is the honest answer. Editing a past
chat's canvas from a log page would change a campaign with no conversation
around it — Continue the chat to do that.

The tab appears only when a journey exists, and the snapshot is read from the
newest turn that HAS one rather than the newest turn, because a chat usually
continues after the build. The panel is `clamp(420px, 72vh, 900px)`: React
Flow clamps `fitView` at minZoom 0.5, so a short box shows the top of a
twenty-node journey and nothing else.

### A latent crash found by a bad fixture

A hand-seeded session white-screened the entire designer:
`last?.sendProposals.length` — the optional chain stopped at `last`. Every
live response carries the field, which is why it survived; the restore path
reads whatever is in localStorage, and the type saying "required" is a
statement about callers. **Third instance of that exact class today**, after
`describe.replace` and `(barriers ?? []).some`. `questions` had it too; both
fixed, with the remaining short chains checked by a negative assertion.

### Verified

1231 unit (from 1218; 13 new) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. Reverting each fix fails tests:
the chat-aligned cap (2), the quota retry (1), the turn picker (1), the
Journey tab (1). Exercised in a real browser against the recorded turns in
`eval/runs/ui-s-1792661509156` — 5 turn tabs, 26 event rows on turn 5 and 12
on turn 1, 13 node cards on the Journey tab, zero add affordances — and
against the sixteen-chat eviction case, which now keeps its transcript and
says plainly that the detail was discarded. Nothing pushed.

## 2026-10-22 (cont'd) — A plan ready to approve must not arrive looking
like a form

Live EMI run: the strategy appeared with Confirm and one numbered question —
*"Does every EMI-eligible purchase share the same 7-day expiry?"* Answering
it is what took the manager off Confirm: the reply became a discovery turn
and the plan they were one click from approving went back into the
conversation. Clicking Confirm instead produced the graph immediately.

So the highest-frequency miss on this path is **the pairing, not the
compiler** — an approvable plan shown beside something that reads as a form —
and the thing that made it a form was the application, not the model.

### What changed, and what deliberately did not

`strategy_with_questions` still proposes, still shows Confirm, and the gate
still FORMS the question. Two things stop:

- **The response no longer returns them in `questions`.** The client renders
  that field as a numbered list under the agent's message, which is right for
  discovery and wrong next to a button that says the plan is ready.
- **`recordQuestions` no longer runs on this path.** Recording them puts them
  on the brief as outstanding, which makes the manager's next typed message
  an ANSWER rather than a decision about the plan.

**Nothing is hidden.** These items are `strategic-ambiguity` by construction
(`isBlockingItem`), they were already in `gate.openItems`, and
`renderStrategy` already prints that kind under "Worth settling before this
is built". The manager reads every one of them — as open points on a plan
they may still approve.

Discovery before a strategy is untouched: `ask_questions` still returns
numbered questions, still capped at three, and still records them. There is
no plan to approve there, so asking is the point.

### The UI half

While `phase === 'awaiting-confirmation'`: no numbered questions on the
latest assistant turn, and no "Skip & propose". That button offers to produce
the recommendation that is already on screen — it reads as though the plan
were provisional and gives the approval turn a second, competing primary
action. Confirm is the only one. "Request a change" and the message box stay.

### Two things found while doing it, both worth keeping

**I edited the wrong return first.** There are two `phase:
'awaiting-confirmation'` returns and the live one is the EARLIER one, at the
`if (!isBuildTurn)` guard — a propose turn carries no blueprint by design, so
it returns before the blueprint-bearing tail. The tail I changed first only
runs when a BUILD turn's gate says `strategy_with_questions`. Caught by the
new test failing on `pendingBlueprint`, not by reading.

**The propose turn does NOT leave the session in
AWAITING_STRATEGY_CONFIRMATION**, which the slice brief assumed and I would
have assumed too. Verified against the live record: the recorded propose turn
returns `phase: awaiting-confirmation` with `state: AWAITING_USER_ANSWER`.
That state cannot enter generation — the table forbids it — and Confirm
works anyway because the Confirm turn re-enters the same code with
`isBuildTurn` true and walks `STRATEGY_READY ->
AWAITING_STRATEGY_CONFIRMATION` itself before the build tail. Subtle, load
bearing, and one wrong "tidy-up" away from reintroducing the illegal-
transition crash — so the test now pins that the door stays REACHABLE from
whatever state a proposal leaves behind, rather than pinning the state.

### Verified

1239 unit (from 1231; 8 new in `strategyWithQuestions.test.ts`, driving a
real propose turn through `orchestrateStream`) and 118 agent-proto. `tsc
--noEmit`, `server:typecheck` and `npm run build` clean. Reverting the
`questions: []` fails the new test. Two source pins retargeted with their
reasons: `strategyPreservation` (which pinned `questions: gate.questions` as
a feature) and `questionContract` (3 `recordQuestions` call sites, now 2).
Nothing pushed, and neither the experiment-claim nor the send-name slice was
started.

## 2026-10-22 (cont'd) — A trend cuts the treatment, never the door

Entry is every eligible customer who has not done the behaviour. Always.
Knowing who is likelier to convert changes what those people GET — cadence,
channel, wording, an extra touch on one path — and never whether they are in
the campaign. The remainder keeps a path.

That rule was already enforced structurally (the segmentation audit refuses
an entry condition as segmentation, and refuses a split whose remainder gets
an empty branch). What was missing is that three pieces of COPY still handed
the manager a targeting menu, and the agent read them every turn.

### The three menus

- **§2 of SYSTEM named a standing list of customer differences** — "how big
  a limit they were given, whether the app is on their phone, how they were
  sourced" — and told the agent to "put two or three on the table and ask
  which one they would back". A list of factors is a list of answers: every
  objective got the same slots back. It now says to DERIVE them from the
  objective in front of it, and to ask **what they have seen, or that they do
  not track it** — both answers, neither of which changes who enters.
- **`briefForPrompt` ended its candidate block** with "Then ask which they
  would back. Do not pick a target and proceed as though they had agreed to
  it." That is a choice of audience put to someone whose audience is already
  decided. Candidates are **trends to test** now: everyone eligible still
  enters, the treatment is cut by the trend or the trends are tested against
  each other, and the remainder keeps a path. The "wait for their reaction"
  line went too, for the reason `convertersSettled` already records.
- **The gate's clearing instruction** said "two candidate segments". Now
  "candidate trends… the entry stays every eligible customer."

### The no-history case

"We have seen no pattern" or "we do not track it" means one track for
everyone eligible — and the campaign still has to learn. §6 says the run must
produce the trend, and the comparison is **derived from this objective**:
wording, dosage, channel, timing or order, whichever this one is actually
uncertain about. Two message variants is one option, not the default, and
adding sends tests nothing. No history is a reason to test, not a reason to
ship the shyest flat sequence.

### Paid for in characters, not in cap

`SYSTEM` is 33,498 against the 33,500 cap, which was NOT raised a fifth time.
The new rules were paid for by two genuine duplicates: §2 stated "platform
concerns may not occupy a slot" twice, in consecutive paragraphs with the
same three examples, and the "Platform capability decides what gets BUILT"
sentence appeared verbatim in both §6 and §7. The rest came out of this
slice's own new prose, which is the right place to take it from.

### Said plainly: this is prompt wording

The standing lesson at the top of this file is that prompt rules have
reliably produced more honest output and no change in what gets designed. The
parts of this slice with structural backing will hold, because the audit
already enforces them. The part with none is "no history means still test" —
`checkAudienceLearning` was demoted to a limitation yesterday, deliberately,
because it overruled a manager who had said "do not split". Those two pull in
opposite directions and no amount of prompt wording resolves what the gate
decides. If runs come back with flat no-test journeys, the fix is a check on
the built journey, not another sentence here.

### Verified

1252 unit (from 1239; 13 new in `entryAndTrends.test.ts`) and 118
agent-proto. `tsc --noEmit`, `server:typecheck` and `npm run build` clean.
One pin retargeted in `promptMethod`, to the surviving copy of the sentence
whose duplicate paid for this slice. Nothing pushed.

## 2026-10-23 — A plan may not spend a signal it does not have, nor decline
to produce one

Live EMI run on 2efe2e3. Discovery finally asked the right question — "have
you seen a pattern in who does this already, or do you not track it?" — and
the manager answered plainly: they do not track prior EMI, merchant category
or ticket size; one track; the first run should generate that signal.

The strategy then did both wrong things at once:

- **It split day-0 copy by prior EMI versus first-time**, and said the
  manager had flagged that factor — about a factor they had just said they do
  not record. Listing something as untracked is not seeing a trend in it.
- **It parked the wording and dosage test in "hypotheses for future"** while
  designing a seven-day run. There is no later run to inherit a test: with
  nothing compared this time, the next campaign starts exactly as blind.

§2, §3 and §6 already said all of this in words, and the run happened anyway.
So it is checked against the proposal now.

### `trendBlocks`, in the same shape as `cadenceBlocks`

One precondition, two ways of failing it:

```
if (statedTrend(brief) || tests) return [];
return splits ? ['split-without-trend'] : ['nothing-tested'];
```

A stated trend is a pattern they have SEEN, so the cut itself produces the
reading. A comparison produces it directly. What is left is a plan with
neither — and it either cuts the journey on a factor nobody has observed, or
runs flat and learns nothing.

**`statedTrend` reads basis AND status**: `basis: 'user'` with `status:
'retained'`. That pair is the whole point. "We do not track prior EMI" is
recorded against the same dimension NAME with basis `user` — they said the
words — and status `unavailable`. A check reading only the basis would have
taken the live brief as permission to split on prior EMI, which is the
defect. The status is what separates a factor they described from one they
merely named.

**The split is counted as well as claimed.** `Segmentation: used` is the
agent's verdict; two distinct non-`all` paths in `touches` is evidence. The
live plan split the copy by path — a verdict alone would have missed it.

**Experiment arms are not a cut.** Randomly assigned arms make no claim about
who these people are, so they need no stated trend. That is also the legal
move out of the block, which matters: a guard with no legal move is a trap.

**Before Confirm, never after**, like the cadence block. `building` is true
once approved, and refusing then leaves them with an approval that did
nothing.

### A draft that was wrong, recorded because it was plausible

The first version keyed the test rule on `converters.knowledge !== 'known'`
and the split rule on dimensions, reasoning that they answer different
questions. It demanded an experiment ON TOP of a split the manager had asked
for — a second instrument for a question the first one answers. Caught by the
fixture where they HAD stated a trend; collapsed to the single precondition
above.

### The prompt line that was still fighting all of this

§1 said: *"When nobody knows who converts, give TWO candidate segments
resting on different things and wait for their reaction."* A targeting menu,
plus a wait `convertersSettled` stopped requiring three days ago. Replaced
with candidate TRENDS, how this run tells them apart, and "a trend nobody has
seen is what the campaign MEASURES, not what it acts on". The same sentence
lived in `outputTools`' `knowledge` enum description and was replaced there
too — one lie in two places.

`SYSTEM` is 33,500 against the 33,500 cap, not raised. Paid for by trimming
yesterday's own additions: §3 kept only its distinctive half (§6 already
carries the cadence/channel/copy list) and §6 dropped a consequence that is
now the gate's own refusal text.

### A vacuous test, exposed

`entryAndTrends.test.ts` had "does not block a proposal that experiments on a
no-trend brief" whose fixture declared no experiment at all. It passed
because nothing was checking. The new block turned it red, which is the only
reason it was found. It declares the test it names now.

### Verified

1268 unit (from 1252; 16 new) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. Reverting the gate wiring fails
2 tests; ignoring the path evidence fails 1.

### Not in this slice

The architecture comparison failing on a missing `.measurement` — the model
omitted a field §6 asks for in prose and the tool schema does not require.
That is a schema fix, not this rule.

## 2026-10-23 (cont'd) — Two holes in `trendBlocks`, both found by reading
it against the live brief rather than against its own fixture

Yesterday's rules were right and both leaked on the conversation they were
written for.

### A settled audience is not a seen trend

`statedTrend` counted `converters.knowledge === 'known' && basis === 'user'`
as a pattern the manager had observed. On this brief the manager keeps
saying **"record that as known: every eligible purchase, one track"** — a
statement about who ENTERS, which the model files as the converters finding
being settled. So on the real conversation both rules no-opped entirely.

The fixture never caught it because the fixture used `knowledge: 'unknown'`,
which is not what the live run produces. **The fixture was easier than the
case.** It now carries `knowledge: 'known'` and still raises both blocks,
which is the whole point: who is in and who responds differently are
different findings, and only the second one licenses a cut.

`statedTrend` is now exactly one thing: a dimension with `basis: 'user'` and
`status: 'retained'`.

### An experiment is not permission to cut

`if (statedTrend(brief) || tests) return []` let a wording test legalise the
prior-EMI copy split — declare a test anywhere in the plan and the split rule
stopped looking. The two rules are now ordered rather than ORed:

```
if (customerCut) { if (statedTrend) return []; return ['split-without-trend']; }
if (!tests) return ['nothing-tested'];
```

A split the manager DID state a trend for still needs no second instrument —
the cut is the instrument. That release is the only one left.

### Telling an arm from a cut, and which way the doubt runs

An experiment arm is a treatment variant assigned at random and claims
nothing about who these people are. A path named for a customer property
does. The distinction cannot be read from the label alone, so:

```ts
const armsOnly = tests && !cuts && !echoesAFactor;
const customerCut = (cuts || paths.size >= 2) && !armsOnly;
```

**The word match only ever RELEASES.** Any two named paths are a customer cut
by default; they are let through as arms only when the plan declares an
experiment, does not claim segmentation, AND no path echoes a factor already
on the record. Reading it the other way — "that looks like an arm" — would
have the application inventing a reason to ALLOW a split, which is the
mistake `record.ts` warns about, pointed at the model instead of the manager.

So "Prior EMI users" / "First-time" is refused even with Experimentation
declared, because those words are on the record as dimensions. "Arm A — cost
framing" / "Arm B — deadline framing" passes.

### Four fixtures were weaker than the rule, again

`forkGuardUnderFailure` and `strategyWithQuestions` both carry proposals
written as "good in every respect except the thing under test". Dropping the
converters clause made both plans testless, so they were held for a second
reason and proved nothing about forks or open points. Both now declare an
experiment, exactly as they were given `touches` when the cadence block
landed. **Third time this has happened in three slices** — a new structural
check invalidates every fixture written as a valid proposal, and the fixture
list is now the first thing to check, not the last.

### Verified

1270 unit (from 1268) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. Reopening the converters
clause fails 3 tests; restoring the `|| tests` short-circuit fails 1.

## 2026-10-23 (cont'd) — The turn that ended "Recorded."

`eval/runs/ui-s-1792735473522/turns/turn-3.json`. The manager answered three
things in one message: ₹10k purchases convert more, customers do not realise
the purchase qualifies, and it usually happens within thirty minutes. The
agent recorded all of it and called `propose_strategy` with a real plan.

Four application failures then ran into each other, and the manager read
**"Recorded."**

### 1. The tool refused the plan for having one barrier

`propose_strategy` required two architectures to cite two DIFFERENT recorded
barrier ids, and with one recorded it said: *"Record a second candidate
explanation — 'assumption' is an honest basis for one you inferred rather
than were told."*

That is the application instructing the agent to invent a customer problem,
which every other rule in this file exists to prevent. **One recorded barrier
is the ordinary case when someone answers clearly.** A rival to one problem is
a different TREATMENT of it — a different moment, intensity or journey shape
— which is exactly the tuple `architectureAudit` already compares. So the
check asks that question now instead of a cheaper proxy: same barrier is
fine, same `entry || timing || lever || journey` is still "one architecture
described twice".

### 2. Obeying it destroyed the manager's own finding

The follow-up `record_findings` carried ONLY the invented rival, and
replace-on-sent deleted `awareness-gap`. The brief ended the turn holding one
assumption the agent had made up and nothing the manager had said.

`recordBarriers` merges by id now. The replace rule was added for a real
reason — rivals floated early, narrowed later, stayed on the record and
blocked the build — but **replacement cannot tell "I withdraw the others"
from "here is one more", and the second reading is the common one.** The
stale-rival problem has its own instrument already: `lever: 'not-addressable'`
answers a barrier without designing for it, and costs a stated limitation
rather than the manager's words. Empty or omitted still means "do not touch".

### 3. The receipt said nothing had happened

`${after.length - before} barrier(s)` printed **"0 barrier(s)"** four times
while a barrier existed, because re-sending one already recorded is a delta
of zero. It reports the total on the record now.

### 4. The reply denied the turn had tried

With no proposal, the discovery fallback returned `prose || 'Recorded.'`. The
plan was in the request the whole time. A turn that attempted a proposal can
never again report that it merely filed something: if a propose was refused
and the rounds ran out, the reply names the plan and offers to send it again.

And a refusal is now a correction rather than a restart — the tool result
appends *"Send the SAME plan again with that one thing fixed… two
architectures may cite the SAME barrier as long as they differ in entry,
timing, lever or journey."* Without it the agent abandons a finished plan and
goes back to discovery, which is what it spent the rest of the live turn
doing.

### Two tests encoded the defect

`outputTools`' "rejects two candidates citing the same recorded barrier" and
"says what to do when only one theory of the problem exists" both asserted
the refusal that caused this, the second one pinning the invent-a-barrier
copy verbatim. `findings`' "drops a rival the agent stopped naming" pinned
replace-on-sent. All three replaced, with the reasoning kept.

### Verified

1279 unit (from 1272; 7 new in `refusedProposeIsNotRecorded.test.ts`, which
walks the live sequence) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. Reverting the tool rule fails
2, replace-on-sent fails 3, the fallback fails 1.

### Same day — three leftovers from that fix, two of which made it inert

**The schema still told the model the opposite.** `architectures[].barrier`
read *"Two candidates attacking the SAME barrier are one architecture
described twice."* That description is the instruction the model actually
reads; the validator had been changed and the thing being validated had not.
It now says to cite a recorded id and that two candidates MAY share one when
entry, timing, lever or journey differ. The stale comment at the case said
the same old thing and is rewritten with what the rule cost.

**`proposeRefused` reached through a wrapper that does not exist.**
`propose_strategy` is flat — `applyOutputTool` reads `obj as Strategy` — so
`sent.strategy?.summary` was always undefined and the new fallback could
never name the plan it was built to name. My own fixture had nested the
payload under `strategy`, which is the only reason the test passed: **the
test and the code were wrong in the same direction, so they agreed.** The
fixture sends the flat shape now, and the read takes `summary ??
strategy?.summary`.

**The treatment check ran before the aliasing.** The schema asks for
`audience`; everything downstream reads `entry`. That reconciliation sat at
the END of the case, so the comparison added hours earlier read `a.entry` on
a payload carrying `audience`, found undefined on both candidates, and called
two plans differing only in WHO THEY REACH one architecture described twice.

That is precisely the failure the alias block's own comment already recorded
for `architectureAudit` — "two plans differing only in who they reach would
have been called one plan described twice" — reintroduced one check earlier,
in a file that warns against exactly this. The normalisation is hoisted above
every reader now, which is what "one boundary" was supposed to mean.

Verified: 1280 unit (from 1279) and 118 agent-proto. Reverting the hoist
fails the audience-only case; reverting the flat read fails the fallback.

## 2026-10-23 (cont'd) — "Can barely see anything, why is there so much space
wasted"

A screenshot of the Journey tab on a 1900px window: the journey squeezed into
a 1024px column with 640px of empty page beside it, and the graph still
running off every edge of that column.

Measured in the browser before changing anything, because "looks broken" on a
canvas is a geometry question — the lesson the parallel-path label episode
left. Three causes, none of them the canvas:

**A reading measure applied to a canvas.** `.cd-page > * { max-width: 1024px }`
is right for the transcript and the event list and wrong for a journey. The
first fix targeted `.cd-chat-journey` and did nothing: the cap lands on
`.cd-logs`, the direct child, so the override has to go there. It is scoped
to the journey tab, so the two tabs that are prose keep their measure.

**`fitView` could not fit.** React Flow's default `minZoom` is 0.5 and a
twenty-node journey needs about 0.4, so the fit was clamped and the graph
overflowed however much room it was given. `DripCanvas` takes a `minZoom`
prop now, defaulting to React Flow's own: a surface being WORKED ON should
refuse to shrink past legibility, a surface being READ BACK should fit.

**A fixed box wastes one axis.** At 78vh a wide, shallow journey floated in a
band of empty dotted background. The panel takes its aspect ratio from
`computeDagreLayout` — the same pure layout the canvas itself runs, so it is
the real shape rather than a guess — with min/max-height still bounding it.

One wrong turn worth keeping: given only a ratio and a min-height, the box
satisfied the ratio by growing SIDEWAYS, 1960px inside a 1600px column. The
same overflow in a new costume. `width: 100%` is the anchor; height follows.

### Verified across every shape, not just the one in the screenshot

All six seed journeys, 1900px window: every node rendered, **zero overflow**,
box height adapting from 360px (wide and shallow) to the 82vh cap (deep), and
the eight-node campaign no longer shrunk to 0.5 when it fits at 1.0.

1284 unit (from 1280) and 118 agent-proto; `tsc --noEmit` and `npm run build`
clean.

## 2026-10-23 (cont'd) — One pattern is a candidate, not the architecture

`eval/runs/ui-s-1792738033056`. The manager gave three things: purchases
above ₹10,000 convert more (a pattern they have SEEN), customers do not
realise the purchase qualifies (the barrier), and it usually happens within
thirty minutes (timing). The agent proposed immediately and split the whole
journey on ticket size. It never asked whether anything else had been seen —
not category, not first-time versus repeat, not card type.

**The record afterwards looked like a considered search and was not.** Two
dimensions retained, two deferred. But the second retained one was a clock
(`basis: 'tool'`) and both deferred ones were the agent's own inventions
marked `assumption`. Nobody had been asked anything.

So: ask once, then lock. One question, with "we do not track that" as a
complete answer, and no second round of it.

### `isTimingDimension`, beside `isPlatformDimension`

When they act is not who acts. Everyone passes through the same clock, so a
timing finding paces the journey and never divides the people. **Unlike
`isPlatformDimension` this drops nothing** — a timing finding is worth
keeping and designing around, it simply is not a candidate axis and is not an
answer to "what else have you seen". Classification, not rejection.

### `unprobed-other-axes`

Fires when converters and a designable barrier are settled, exactly ONE
segmentation dimension is `user` + `retained`, and nobody has probed. Three
ways to be probed, all evidence rather than effort: two segmentation
dimensions carrying `basis: 'user'`; one carrying `user` plus `deferred` or
`unavailable` WITH a note ("we do not track category" is an answer, and the
note is where it lives); or a question that plainly asked it having been
answered.

**A dimension the agent deferred by itself is not a probe.** That is the
whole point — `assumption` is the agent talking to itself.

Deliberately silent when there is NO seen axis yet: the who-converts block
still owns that conversation, and two blocks asking adjacent questions read
as the application talking over itself. It is a `blocksFor` block like its
siblings, so `proceedRequested` and the round budget release it, and an
approved Confirm carries it as a limitation.

### `stacked-dimensions`

Two evidenced patterns are a CHOICE. Cutting on both quarters the group
behind each arm and buys a second answer nobody asked for. Refused at propose
time when the plan's named paths echo two different `user` + `retained`
dimensions; allowed when they echo one. Which to pick is never a question to
the manager — "which group should we go after" is what discovery was
rewritten to stop asking.

### Two test assumptions of mine were wrong, and the code was right

`recordAnswer` sets `answeredInRound` (a reply arrived this round), not
`addressedInRound` (this question was dealt with) — the latter comes from
`recordUncoveredQuestions`, called unconditionally in production. The probe
keys on the second deliberately, so a model stating the probe went untouched
cannot clear it by accident. The fixture now walks the production path.

And the timing revert initially passed, because the live record happened to
carry the clock as `basis: 'tool'`. A manager SAYING "most convert within
thirty minutes" is `user` + `retained`, which is the case that actually needs
the classifier — now covered, and the revert fails as it should.

### Prompt

Three short rules next to "ASK WHAT THEY HAVE SEEN": ask once then lock,
time-to-act is not an axis, two seen axes mean a choice. `SYSTEM` is 33,495
against the 33,500 cap, not raised. Paid for entirely by this slice's own
prose plus one unpinned rationale sentence in §6 — an attempt to trim the
segmentation bullet hit five sentences that tests pin as measured lessons and
was reverted, which is the cap comment's own rule working.

### Verified

1303 unit (from 1284; 19 new in `probeThenLock.test.ts`) and 118
agent-proto. Typechecks and build clean. Reverting the gate fails 4;
reverting `isTimingDimension` fails 1. `forkGuardUnderFailure`'s fixture
needed a second axis — fourth time a new structural check has invalidated a
fixture written as a complete brief.

## 2026-10-23 (cont'd) — A clock may not authorise a cut, and a channel has
to earn its job

One pass over the leftover from the probe slice plus the two slices held back
from it. The honest headline is at the bottom: of the three new refusals, the
two new ones do NOT fire on the live run they were specified from, and the
reason is in the spec's own release clauses.

### A. `statedTrend` was still counting the clock

It read every dimension on the brief — `basis: 'user'`, `status: 'retained'`,
timing included. So a manager who had only said "most of them convert within
thirty minutes" authorised a ticket-size split they had never evidenced. It is
now exactly the set `seenAxes` reads, which is also the set
`unprobed-other-axes` reads: segmentation dimensions only. The two rules
cannot drift apart because they are the same question asked twice.

`isTimingDimension` LOST `frequency` and `recency`, which were both wrong.
Purchase frequency and recency of last spend are things one customer does more
than another — a who-axis, and probably the strongest pattern a manager has
actually noticed. Classifying them as timing would have discarded it.

**`sawATrend()` in `firstRunMustTest` was carrying "Days left in the window"**,
which the new classifier correctly calls a clock, so three tests resting on it
went red. The fixture carries a ticket band now and the clock case is its own
test — the one the slice exists for, and it is the one that fails when
`statedTrend` is reverted.

### B. The one probe has to name its axes (prompt only)

The gate forces one extra question and cannot force it to be useful. A blank
"anything else?" gives the manager nothing to react to, so "no" is the only
cheap answer.

**The examples live in the gate's `clears.how`, NOT in SYSTEM**, and that was
not the first draft. `entryAndTrends` pins that EMI's own factors never appear
in the prompt — a measured defect, because when they did, every objective got
EMI's dimensions handed back to it. So SYSTEM asks for "one or two nouns you
derived from THIS objective" and bans `"anything else?" with no noun`, while
the refusal — shown only when the block fires, with the brief in hand — names
category, first-time versus repeat and card type. The pin caught this; reading
the spec did not.

### C. The journey must move on what the customer did

`reactionBlocks`, propose-time, skipped when `building`. Two failures of one
rule, in order: the chosen architecture's `journey` is not
branch-on-response or wait-for-event (an `experiment` is NOT a reaction —
randomised arms learn something, they do not respond to this customer), or it
says it reacts and every touch falls back to the same reminder. The second is
a cheap string check over `ifStillUnconverted` requiring two outcomes named by
type: not delivered, not read, read and no action, converted and stop.

**It never reads a blueprint, and a test greps the function to keep it that
way.** There is no blueprint at propose time, `optionAudit` owns the built
journey after Confirm, and a compiler-injected Goal Check after every send is
not branching — so this check must not be able to be fooled by one, which it
cannot be, because it never looks.

The refusal offers the clock as the RIVAL to reject rather than asking for a
second barrier. Statement-date pacing is a real alternative; inventing a
second customer problem is the thing this file has spent two days removing.

### D. Channels are jobs

`channelJobBlocks` refuses two shapes. One channel for every send while the
others sit unused is habit — unless a different channel is named in
`ifStillUnconverted` as the fallback, which is the only release and does not
require the fallback to have a scheduled row of its own. And two channels to
the same path on the same day is fatigue dressed as coverage; keyed on path
AND day, because different channels on different days is the shape wanted and
two groups each getting their own opening is not spray.

### The measurement, which does not flatter the slice

Run against `eval/runs/ui-s-1792738033056/turns/turn-3.json` — the plan this
pass was specified from — **both new checks return nothing**:

- its chosen architecture declares `branch-on-response`, and its fallbacks
  distinguish not-delivered from not-read from read-with-no-action;
- all six touches are WhatsApp, but every one of them names SMS as the retry,
  which is the release D was specified to grant ("even if SMS is not its own
  touch row").

So what actually held that turn is slice 1's `unprobed-other-axes`, and these
two catch the SHAPE that run risked rather than the payload it produced. That
is worth stating rather than burying: the prose was better than the plan, and
a check that reads the prose inherits that. The backstop is already in place
and is the right one — `optionAudit`'s `channel fallback` reports a gap when
no condition routes the failure path to another channel, so an SMS fallback
that exists only in a sentence is downgraded on the build turn. Tightening the
propose-time release instead would mean refusing a correctly-described
fallback for not having a row, which is a formatting rule.

### Prompt

`SYSTEM` is **33,433 / 33,500**, not raised. Paid for by: the EVEN SPACING
second sentence (now the gate's own refusal text, verbatim), two rationale
clauses in NAME EVERY TOUCH, the "application will downgrade a claim" sentence
in §6 (a mechanism that exists whether or not the prompt mentions it), and the
"made-up number invites them to argue with the number" tail in §2 — the
instruction against inventing a cutoff stays, only its reasoning went. One cut
was WRONG and is restored: "every option you marked 'used' should be visible
in it" is pinned by `strategyOptions`, which is the cap comment's own rule
working for the second slice running.

### Verified

1329 unit (from 1304; 13 in `reactionBlocks.test.ts`, 9 in
`channelJobs.test.ts`, 3 in `probeThenLock`, plus the clock case in
`firstRunMustTest`) and 118 agent-proto. `tsc --noEmit`, `server:typecheck`
and `npm run build` clean. Reverting `statedTrend` to the old `some()` fails
1; reverting the linear refuse fails 5; reverting the habit check fails 3.

**Four fixtures needed a reacting winner** — `firstRunMustTest`,
`entryAndTrends`, `forkGuardUnderFailure`, `strategyWithQuestions`. Fifth
slice running, and `forkGuardUnderFailure`'s third note of this kind in three
days. The fixture list is now genuinely the first thing to check: a payload
written as "a good proposal" is invalidated by every structural check added
after it, and it fails for two reasons while proving neither.

### Not in this slice

No IN_APP send node, no new discovery question beyond the named-axis probe, no
Confirm-time refusal from either new check, and nothing pushed.

## 2026-10-23 (cont'd) — The canvas may not be a clock when the plan claimed
a reaction

`eval/runs/ui-s-1792738033056` turn 4, the Confirm. The approved strategy
declared `branch-on-response` and named another channel for when the first
does not land. What reached the canvas, read off the record rather than
remembered:

```
condition on Transaction.Transaction Amount Greater than 10000
  yes: 2 WhatsApp sends, exit
  no:  experiment (wording), two arms of 4 identical-cadence WhatsApp sends, exit
```

Ten WhatsApp sends, one who-split, a copy test, and a Goal Check stamped after
every send by the compiler. The reply read **"Built the journey: 10 message
steps, 36 steps in total. It is on the canvas now."**

### Measured first, and it changed the design twice

**The approved plan is not on the build turn.** `propose_strategy` is not
offered on a Confirm, so the strategy that turn carries is the SYNTHETIC EMPTY
one — turn 4 has `summary: ''`, `architectures: []`, zero touches. A check
reading only `proposed.strategy` would have been inert in the app and green in
every hand-fed test: the `confirmedStrategy` trap from two slices ago, in a new
costume. So it reads `req.confirmedStrategy ?? proposed.strategy`, and the
client chain that fills it — `setPendingStrategy(res.strategy ?? null)`, posted
as `confirmedStrategy` when `intent === 'confirm'` — is now pinned in a test,
because that link is what makes the whole slice live. (The orchestrator comment
claiming `confirmedStrategy` is always undefined is about a field name the
client never reads; it is wrong about the mechanism, and the test says so.)

**`checkFidelity` could not have caught this, and not for the reason I
assumed.** I expected it to have passed by luck because `derive()` counts ANY
condition as `branch-on-response` — which it does, and which is a real hole.
But on turn 4 there were no architectures on the turn at all, so fidelity
returned null and never ran. Both facts are true; only the second one explains
the live miss.

### `journeyReacts(blueprint)`, in `optionAudit.ts`

True for a `waitForEvent`; for a condition on the PRECEDING SEND's delivery or
read result (`outcomes`) whose two sides do structurally different things; or
for that same condition routing the failure path to a different channel.

False for everything the live build actually did: `condition.on` is a customer
attribute and therefore segmentation, a `branch` is n-way segmentation, an
experiment is randomised arms, `fallbackChannel` is a field rather than a fork
anyone takes, and a compiler-injected Goal Check is not in the blueprint at
all — which is why this reads the blueprint.

**Kept separate from `CHECKS['conditional branching']`** on purpose. That one
decides whether to downgrade a `used` claim in the options table, several tests
rest on any condition counting there, and a footnote and a hard build
consequence should not share a definition without being asked to.

### One retry, then the truth

On a build turn, when the approved winner declared `branch-on-response` or
`wait-for-event` and the blueprint does not react, the model is asked for the
journey once more with `tool_choice: build_campaign` — the same second chance
the empty-blueprint case gets, because a first miss is usually a miss. The
instruction lives on the build turn, NOT in `SYSTEM`: the cap is on the prompt
that travels every turn and this is needed on one. It names the three things
that do not count, each of which the live build did instead of reacting.

If the second journey is still a clock the campaign is **compiled anyway** —
same rule as a send with no description, because an empty canvas helps nobody
— and then:

- the success sentence is not available. `renderBuildSummary` takes a
  `reactionGap` and leads with "… I am not going to call that done", then the
  mismatch, then the two ways forward. A build that did not do what was agreed
  is reported in the first line or it is not reported at all.
- the gap goes on `campaignBlockers` **first**, ahead of the proposal's own
  blockers, rather than only into `designWarnings` and the options table.
- the export invitation is suppressed. "You can export the configuration now"
  under "this is not your plan" is the success sentence coming back through a
  different door.

**Not skipped on `building`.** Every propose-time block is, and that skip is
precisely why Confirm printed a clock: the moment to catch a PLAN is before
approval, but the moment to catch a BUILD is when it is built, and there is no
earlier turn at which this journey existed.

A declared `linear` winner does nothing here — `reactionBlocks` should have
held that plan at propose time, and inventing a reaction the manager never
agreed to is not this function's job. No declared journey does nothing either,
rather than guessing one.

### The fixture had to be copied, not imagined — twice in one slice

My first turn-4 reconstruction gave the ticket-size condition the same steps on
both sides. The revert that should have failed it PASSED, because
`structuralSignature` already called those branches identical, so the
`outcomes` filter was never what the test measured. The real journey is
lopsided — two sends one side, a four-send experiment the other — which is
exactly the shape that makes "any condition counts" a false positive. Reading
the recorded blueprint fixed it in one minute. Second time this slice that
measuring beat guessing, and the lesson is the same one as "reading the code is
not measuring it".

### Verified

1348 unit (from 1329; 19 new in `canvasMustReact.test.ts`) and 118
agent-proto. `tsc --noEmit`, `server:typecheck` and `npm run build` clean.
`SYSTEM` unchanged at **33,433 / 33,500** — no method prose was added to it.
Reverting `journeyReacts` so any condition counts fails 3; reverting the retry
fails 3.

**Replayed against the live run**: approved journey `branch-on-response`,
`journeyReacts(turn-4 blueprint)` false — so this fires on the exact turn that
printed "It is on the canvas now." Unlike last slice's propose-time checks,
which the same run's prose already satisfied.

### Known, and not in this slice

- `derive()` in `architectureAudit.ts` still counts any condition as
  `branch-on-response`, so `checkFidelity` would call a ticket-size split a
  reaction whenever architectures DO travel. It feeds the comparison verdict
  and several tests; pointing it at `journeyReacts` is the obvious follow-up
  and was not asked for.
- The live blueprint used `Greater than` on `Transaction Amount`, and the
  builder accepts only `Equals` / `Not Equals` on a number. The fixture keeps
  it for fidelity. That is a capability gap, reported as a limitation, not a
  reaction problem.
- The `intent === 'confirm' && req.confirmedBlueprint` short-circuit gets no
  reaction check. It cannot fire in the app — a propose turn returns
  `pendingBlueprint: null` — and every test that walks it supplies the
  blueprint by hand.
- Nothing pushed, no live run.

### Same day — two holes the reaction slice left, and the comment that would
have reopened them

**`derive()` still counted any condition as `branch-on-response`.** The same
false positive `journeyReacts` was written to kill, one function along: a
condition on Transaction Amount is a who-split, and tagging it here meant
`checkFidelity` would CONFIRM a declared reaction against a campaign that
branches on the customer. The audit would have blessed the exact build the
retry refuses.

`reactsToDelivery` is now the one definition, factored out of `journeyReacts`
and imported — not restated. Two copies of this rule would drift, and the
drift would be invisible because both halves would keep passing their own
tests. The wait is deliberately NOT folded in: `journeyReacts` is
`reactsToDelivery` OR a wait-for-event, which is the right question for "does
this journey move at all", but an inventory of behaviours must not also call a
wait-for-event journey a branch. A condition is descended into and never
tagged; whether it is a reaction is one function's job.

**`checkFidelity` was reading the wrong strategy on the only turn that
builds.** It took `proposed.strategy?.architectures`, which on a Confirm is
the synthetic empty one — so on live turn 4 it received `[]`, returned null,
and the check that asks "is this the campaign you were sold" never ran. Both
it and `compareArchitectures` now take the same `approvedStrategy`
(`req.confirmedStrategy ?? proposed.strategy`) the reaction retry uses. On a
propose turn `confirmedStrategy` is null, so that path is unchanged.

**`approvedPlan` is still NOT keyed on `confirmedStrategy`, and the comment
now says why.** It claimed the field never arrives, which was wrong about the
mechanism and dangerous in both directions: key the may-we-build flag onto it
and a typed "Confirmed. Build this campaign." during discovery skips the gate;
stop reading it for the plan's CONTENT and the reaction and fidelity checks go
inert again. Two jobs, two reads — the plan's content is client-supplied, and
a payload carrying a strategy is not evidence that discovery happened. A test
greps the block for the old wording, which is why the correction in the
comment paraphrases it rather than quoting it.

**Replayed against the live run:** `derive(turn-4 blueprint)` is now `linear,
experiment` — no reaction — and `checkFidelity(approved, built)` returns *ok:
false*, "Chose a "branch-on-response" journey, but the built campaign does
linear, experiment." On the real turn it returned null.

1357 unit (from 1348; 9 new in `canvasMustReact.test.ts`) and 118 agent-proto;
typechecks and build clean, `SYSTEM` untouched at 33,433. Reverting `derive()`
to "any condition" fails 4; reverting the fidelity input fails 2.

Known and still not done: `derive()` does not walk `branch` paths, so sends
nested inside an n-way split contribute no `linear` tag. Pre-existing, nothing
in this slice depends on it, and changing it moves fidelity verdicts that
nothing currently covers.

## 2026-10-23 (cont'd) — The journey can branch on what the last message
reported, and it is a decision rather than a stamp

`eval/runs/ui-s-1792748248345` turn 5. The Confirm built a Transaction Amount
branch, waits of 24/48/72 hours, SMS as a field on the send, seventeen Goal
Checks, and not one split on the previous step's outcome. The reply correctly
called the canvas a clock — and `REACTION_RETRY` then asked for "the failure
path on a different channel", which was the application asking for the wrong
thing twice over.

### The blueprint had no words for the fix

The builder's Decision Split has routed on "Previous step outcome" since long
before any of this, and `kind: 'branch'` could only ask for an attribute. So
`condition.outcomes` (Yes/No) was the agent's only engagement fork, and
WhatsApp reports THREE people once a message lands: delivered-and-unread, read
-and-not-acted-on, dismissed. Two nested Yes/Nos put one of them a level
deeper for no reason a customer experiences.

`kind: 'branch'` now has a second shape, discriminated by what is present
rather than by a new kind, because the builder draws both with one node and
only its `source` differs. Attribute branch: `entity` + `attribute`, paths
carry `operator`/`value`. Outcome branch: neither, paths carry `statuses`, and
it needs a preceding Send. Compiled through `dcConfirmAddNode('DECISION_SPLIT')`
with `branches[].values` — the multi-select the form itself stores — and the
catch-all stays the reducer's.

### A CAPABILITY, NOT AN INJECT, and this is the half that was easy to get wrong

A split after every send is a clock with extra nodes. The compiler builds an
outcome split only where the blueprint asks for one, never inserts one, and a
test pins that a send/wait/send blueprint compiles zero of them.
`reactsToDelivery` asks whether the journey has ONE designed check whose arms
do different jobs — not whether every send has one. One or two checks on a
path is the shape; the retry and the vocabulary both say so in those words,
and a test greps the retry for the stamp wording an earlier draft of mine
actually had ("after each Send, branch on what that send reported").

### What is not an arm, enforced at compile time

- **Undelivered.** FAILED*, UNKNOWN, NOT_DELIVERED, HARD_BOUNCE and the SMS
  FAILED_* codes are `fallbackChannel` on that Send — the same message
  attempted elsewhere. A FAILED-only arm is dropped with a limitation saying
  exactly that, and the rest of the journey is built.
- **In flight.** QUEUED, SENT, PENDING. The arm would catch whoever the
  campaign looked at mid-flight rather than a person who did something.
- **A status the channel does not emit.** CLICKED on a WhatsApp send is
  reported and never coerced to the nearest thing it does report.
- **Overlapping arms.** READ claimed by two arms routes one person two ways
  and the reducer would take whichever edge matched first. The earlier arm
  keeps it; the later one is reported.
- **A "converted" arm.** The Goal Check after each send already takes anyone
  who booked off the path, and those Goal Checks stay visible.

`server/deliveryStatuses.ts` holds the classification and imports the
vocabulary — `DELIVERY_STATUS_BY_CHANNEL` and `deliveryStatusOptionsForSend`,
which already knew the subtlety nobody would guess: a send with a fallback
could have landed on either channel, so both vocabularies apply. That is why
OPENED is legal after a WhatsApp send whose fallback is EMAIL, and there is a
test for it.

### The channel-fallback leg of `reactsToDelivery` is gone

It counted "the No arm goes out on a different channel" as the reaction, and
that definition is where the retry's SMS-arm instruction came from. Deleted,
with the live run named in the comment. `walk()` also descends into
`branch.paths` now — it never did, so an outcome branch was invisible to every
check in `optionAudit`, and so was anything nested in a ticket-size arm.
`derive()` walks them too, for the linear tag.

### Done when, measured

The full EMI design compiles: eligible-purchase event entry, the ₹10,000
attribute branch, a wording experiment on the fuller path, WhatsApp with SMS
fallback on three sends, **exactly one** Previous-step-outcome split with
DELIVERED / READ / DELETED arms, 12 Goal Checks, zero open paths, zero issues,
and `journeyReacts` true.

One thing the fixture taught: a trailing `exit` after a fork produces the
compiler's existing "N open slots exist; the continuation is ambiguous" issue.
That rule is older than this slice and the vocabulary already says a trailing
exit is optional — the fixture drops them and compiles clean.

### Verified

1390 unit (from 1357; 26 new in `outcomeBranch.test.ts` plus the retry and
status pins) and 118 agent-proto. `tsc --noEmit`, `server:typecheck` and
`npm run build` clean. `SYSTEM` is **33,475 / 33,500**, not raised — the new
channel sentence was paid for by two §7 bullets the slice makes wrong
("the message did not reach them at all" is a field, not a journey case) and
by trimming its own prose.

Reverting the outcome-branch compile fails 12; reverting `walk()`'s descent
fails 2; reverting `derive()`'s fails 1.

**Fixtures retargeted, and the reason is the measured one:** `namedOutcomes`
no longer counts "not delivered, try another channel" as one of the two named
cases, because it was the easiest of the four to write and said nothing about
anyone who actually received the message. Six fixtures used exactly that
sentence as half their requirement. They now name the unread case as well, and
a test pins the old pairing as insufficient.

### Superseded mid-slice, deliberately recorded

The first version of this work made the three-way WhatsApp split a rule — the
retry said "after each Send, branch", and the vocabulary said those three
statuses "want three different next steps". That is the stamp, and it was
replaced before anything shipped: the agent must DECIDE which send is worth
reading back and say why in `approach`. No auto-insert was ever built, so
there was nothing to tear out of the compiler.

## 2026-10-23 (cont'd) — Confirm is offered only when the STEPS do the fork

`ui-s-1792748248345`. The strategy declared branch-on-response and named
unread against read; the journey was a Transaction Amount branch and three
waits. Both halves came out of one model call on one turn, so the essay could
not stand in for the step list — and the manager was shown Confirm, approved
it, and the build-turn retry had to ask for the fork after the fact.

`reactionBlocks` now reads the journey as well as the prose, through the SAME
`journeyReacts` the build turn uses. One definition of "the next step depends
on what they did with the last message", read on both turns, rather than a
propose-time approximation that can drift from it. The refusal names the one
fork to add and what to keep: the who-split stays, no split after every send,
no FAILED arm.

### Where the lock binds, measured rather than assumed

The slice brief said `propose_strategy` already returns a blueprint. **It does
not.** Measured before writing anything: `propose_strategy`'s schema has no
blueprint, its handler returns `{strategy, openItems}`, the live proposing turn
(turn 4) carries `strategy: true, blueprint: false`, and
`systemForPhase(false)` replaces the grammar with "OMITTED THIS TURN" on
purpose — the standing principle that the plan is agreed in business terms
before it is mapped to the builder.

So the rule as literally specified — hold when there is no blueprint — would
have refused EVERY first propose with no legal move, which is the unclearable
block `gate.ts` exists to make impossible. What shipped instead: **the steps
decide where they travel, and the prose checks stand alone where they do
not.** The JSON propose path (`{action:'propose', strategy, blueprint}`) has
always carried steps and binds today — three existing fixtures went red the
moment the wiring landed, which is how I know. The tool path does not, and
making it carry them is a product decision about that principle rather than a
gate fix. Stated here, and pinned by a test, so the limit is not rediscovered
as a bug.

### Three holes in the same lock

**Converting is not a landed case.** "Still unread" plus "if they converted we
stop" cleared the gate while the plan said nothing about the person who read
the message and did not act. Whoever books is taken off the path by the Goal
Check the compiler inserts after every send — the platform's own terminal, not
a person who needs a next job. `namedOutcomes` drops it, the `clears.how` says
why, and the test that accepted that pairing is flipped.

**`ifStillUnconverted`'s own description still led with "not delivered".** The
schema description is the thing the model actually reads, and it was teaching
the case the gate had stopped counting. It now names the people who GOT the
message, with undelivered as `fallbackChannel` and converting excluded.

**Different waits were reading as different jobs.** `structuralSignature`
carries `wait:24` against `wait:72`, so two arms that both wait and then send
the same reminder passed as a reaction. `jobSignature` is the same walk with
the duration dropped, used ONLY by the engagement comparison —
`structuralSignature` is shared with the experiment audits, where a different
wait is a legitimate difference between arms, and a timing experiment is one
of the four claims the schema allows. Changing it globally would have silently
reclassified every one of those.

### A trailing exit after a fork

Pre-existing, and the agent writes one almost every time: after a fork there
is no single continuation, so `nextInChain` reported "N open slots exist; the
continuation is ambiguous" on a correct journey. The exit is now skipped
silently when there is more than one open slot and it is not the first step on
its path — never attached to one arbitrary arm, and `i > 0` keeps an exit that
is an arm's only step exactly as it was.

**My first pin for this was vacuous and measuring it is what showed me.** With
arms that TERMINATE there is exactly one open slot left — the reducer's
catch-all — so the issue never arose and the test passed against the unfixed
compiler. The real case is arms that end on a send: three open slots, one
reported issue before, zero after, and the same number of exits either way.

### Verified

1406 unit (from 1390) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. `SYSTEM` untouched at 33,475 —
this slice adds no method prose.

Reverting the steps leg fails 3; the converted removal fails 1; `jobSignature`
fails 1; the trailing-exit skip fails 1.

**Three fixtures needed one engagement fork** — `strategyWithQuestions`,
`firstRunMustTest` and `forkGuardUnderFailure`, the last for the fourth time.
Each declares a branch-on-response winner and carried a clock, so each was
held for a reason its own file is not about. `forkGuardUnderFailure` is on
EMAIL, so its arms are OPENED and CLICKED — the statuses that channel actually
reports.

## 2026-10-23 (cont'd) — The first propose carries the journey

`ui-s-1792748248345` turn 4: `propose_strategy` returned an essay,
`blueprint: false`, and Confirm appeared under it. The canvas was invented on
the turn AFTER the manager signed, from a second model output they never saw.

The withhold that caused it was the wrong reading of strategy-before-platform.
The rule worth keeping is narrower and unchanged: **while still learning who
converts, do not talk events, attributes or step kinds**, because an agent
handed the filterable field list reasons in those terms and the business
question goes untouched. It says nothing about the turn that asks someone to
approve a sequence. That turn must carry the sequence.

### `journeyAllowed`, a second flag

`systemForPhase` was one boolean, and discovery and propose are both "not a
build turn". It now takes `(isBuildTurn, journeyAllowed)`:

- asking turn: today's omission, unchanged;
- ready to propose: the grammar travels, and so does the CATALOGUE — the
  entity, attribute and event names from `blueprintVocabulary`. Confirm
  compiles these steps now, so an attribute invented at propose time would
  reach the canvas as a dropped condition. The build-turn instructions stay
  build-only;
- build turn: unchanged.

`journeyAllowed` is `decide(brief, {}).proceed && !forcedBy` — the record half
of the gate with the escapes excluded, so **a spent round budget does not hand
over the vocabulary**. Recomputed per model call rather than once per turn, so
a turn that records the last finding in round 1 can carry the path in round 2.

**What `systemForPhase` actually withholds is one GROUND RULE, and I had to
measure that to write the test honestly.** The step grammar is no longer prose
in SYSTEM at all — it moved into the tool schemas — so the two strings differ
by the vocabulary rule and nothing else, and the existing assertions about
`"kind":"branch"` leaking pass because SYSTEM contains none of it on any turn.
The real withholding is `outputToolsForPhase` (no `build_campaign`) and the
catalogue block in the context prompt. Both still apply. `SYSTEM` is unchanged
at 33,475: the release is a gate, not new prose.

### The path travels in `propose_strategy`

`BLUEPRINT_SCHEMA` is hoisted and shared by both tools — `propose_strategy`'s
`blueprint` property and `build_campaign`'s whole input are the same object,
with `$defs: { step: STEP_DEF }` on both so the `$ref` resolves. A second copy
of that grammar is how the architecture field names and the two event-label
maps drifted.

The handler refuses a plan with no path and says what to send. Refused there
rather than in the gate because the tool result is a sentence the model can
act on, and because it applies to every winner: a linear plan needs its
sequence approved too.

### Three dead paths this turned live, all measured first

1. **`pendingBlueprint` was null**, so the client posted
   `confirmedBlueprint: null` and the confirm short-circuit was unreachable.
   It is the proposed path now — which also gives `previewFromBlueprint`
   something to draw for the first time since it was written.
2. **The propose return left the session in `AWAITING_USER_ANSWER`**, and the
   table allows generation only from `AWAITING_STRATEGY_CONFIRMATION`. That
   cost nothing while Confirm fell through to the build tail, which walks the
   hops itself. With a real path posted back, Confirm takes the short-circuit
   and `mayGenerate` asks `canTransition` directly — so the first Confirm
   would have returned *"Cannot generate from state AWAITING_USER_ANSWER"*: a
   manager pressing the button and being told no. The propose return now walks
   `STRATEGY_READY -> AWAITING_STRATEGY_CONFIRMATION`, bumps the version and
   clears any stale confirmation.
3. **The short-circuit's staleness heuristic has never run.** It fingerprints
   the blueprint description plus the strategy summary and compares that to
   the objective. My first probe failed it at 0.06 — and my probe was a
   two-sentence summary I had written. Against the REAL recorded text it
   scores 0.50 against a 0.25 floor. No change made; the risk is a terse
   summary, and `objectiveFingerprint.test.ts` already exists because this
   bit once before.

### The lock now bites the live path

A reactive winner with no journey is a hold, because sending one is legal —
which is exactly what 20611bb declined to do while it was illegal. Replayed
against the live record: the turn-4 essay (`branch-on-response`) is held with
no path, and held again with the clock turn 5 actually built.

### Verified

1414 unit (from 1406) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. `SYSTEM` unchanged at 33,475.

Reverting the missing-steps hold fails 1; the tool's path requirement fails 1;
`pendingBlueprint` fails 2; the state hop fails 2; `journeyAllowed` fails 1.
The last of those is a source grep rather than a behaviour test, because the
flag is a closure inside `orchestrateStream` — the behaviour either side of it
is covered by `systemForPhase` directly.

**Six fixtures needed a path**, and the shape is now shared rather than copied
a seventh time: `tests/unit/support/journeys.ts` exports `reactingPath()`.
`outputTools`, `proposeTurnDefects`, `refusedProposeIsNotRecorded`,
`entryAndTrends`, `reactionBlocks` and `strategyWithQuestions` all use it.
Two tests were FLIPPED rather than retargeted — the ones pinning that a
missing journey is silent — and both carry the old reasoning, because it was
correct when there was no legal way to send one.

## 2026-10-23 (cont'd) — The catalogue is a tool call, not a paste

The builder's vocabulary was being stuffed into the prompt — and, once
`propose_strategy` started carrying the path, into its schema on asking turns
too. Both are the same mistake in two places: handing the agent the filterable
field list as TEXT, on turns that are not writing steps, while withholding the
LOOKUPS from the one turn that is.

### Three phases, two facts

`outputToolsForPhase(isBuildTurn, journeyAllowed = false)`:

- **asking** — record tools, `ask_questions`, `request_evidence`, and
  `propose_strategy` **stripped of `blueprint` and `$defs`**. The tool stays,
  because the GATE decides when a proposal is allowed; a model that proposes
  early should be refused by the record rather than left unable to speak. Its
  schema drops from 9,991 to 3,707 characters, and no step kind, stage enum or
  entry shape reaches that turn.
- **propose-ready** — the same list with the grammar back.
- **Confirm** — unchanged: `build_campaign`, no `propose_strategy`.

The stripper returns a copy, and there is a test for that: mutating
`OUTPUT_TOOLS` in place would have removed `blueprint` for every later caller
in the process.

`toolsForPhase(isBuildTurn || journeyAllowed() || designSeen)` — lookups now
travel with the path. Propose-ready is the turn that must name real events,
attributes, operators and values, because **Confirm compiles exactly its
path**, so a name guessed there becomes a condition dropped from the
manager's canvas. Asking leaves all three operands false and gets nothing.

### Nothing pastes the catalogue any more

`blueprintVocabulary` is gone from `buildContextPrompt` on both the ready and
the build branch — the import with it. What replaces it on a ready turn is
three sentences: carry the path in `propose_strategy.blueprint`, look it up
before writing it (naming the four tools and what each answers), and do not
call `build_campaign`. Confirm keeps CHECK, DO NOT RECALL, which now means
something because the lookups are actually on the call. Asking still gets NO
BLUEPRINT THIS TURN. One joined string per branch, no nested lists.

`issuerContext` stays on every turn: which channels an issuer has is bank
context and shapes a strategy.

In SYSTEM, one line changed — "Use the catalogue's per-channel list" became
"Call list_channels for that channel's own status list". HOW TO DESIGN is
untouched.

### Retargeted, not deleted

`discoveryIsBusinessOnly`'s central pin was "the vocabulary arrives only when
something is being BUILT", enforced by gating a paste. The rule it protected
is intact and the instrument changed, so the test now pins that **nothing**
pastes it (`'# Vocabulary you must stay inside'` and
`blueprintVocabulary(availableChannels` appear nowhere in the orchestrator),
that the lookups are gated on the three-way expression, and that an asking
turn's `propose_strategy` carries no `"branch"`, `"waitForEvent"`,
`first-touch`, `campaignName`, `$defs` or `extraEntityGroups`.

**A first version of that assertion failed on a bare `"kind"`** — which is
`openItems[].kind`, a legitimate field with nothing to do with steps. Measured
and narrowed to the strings that are actually the grammar.

Four source-text pins on `toolsForPhase(designSeen || isBuildTurn)` and
`outputToolsForPhase(isBuildTurn)` were repointed at the new expressions, in
`confirmReachesGeneration`, `conversationFlow`, `emptyRoundRecovery` and
`turnOneAndQuestionList`.

### A test that was asserting something else than it said

`turnOneAndQuestionList`'s "still tells the agent which channels exist" read
`typeof req.system === 'string' ? req.system : ... req.messages` — and
`system` is always a string, so the messages were never consulted and the
assertion was really "the channel names are hardcoded in the method prompt".
It now reads the whole request, which is what its own comment claims. The
channel list lives in `issuerContext`, in the first user message, which is
where bank context belongs.

That test went red from an uncommitted SYSTEM pass in the working tree (HEAD's
SYSTEM contains all four channel names; the working copy contains only SMS) —
not from this change. Fixing the ternary is the repair either way.

### Verified

1421 unit and 118 agent-proto. `tsc --noEmit`, `server:typecheck` and
`npm run build` clean.

Reverting the asking-turn strip fails 2; reverting the lookups to
`designSeen || isBuildTurn` fails 2.

`llm-prompt.html` regenerated: the catalogue row reads "No longer pasted
anywhere", operators and allowed values are `result` on both propose and
Confirm, the journey grammar is `schema` on both and absent on asking, and
the propose panel says the catalogue arrives only if the model calls a lookup.

### Not in this change

No short-system rewrite, no drip PRD, no IN_APP work. The uncommitted SYSTEM
and test edits already in the tree are left exactly as they are.

### Same day — the escape could not comply with the rule it was held to

The phasing above was right for discovery and wrong for a forced propose.
`journeyAllowed` excluded the gate's escapes, so a manager typing "go ahead",
or a spent round budget, produced a turn that MUST propose with no
`blueprint` field in `propose_strategy`'s schema and no lookups on the call —
while `applyOutputTool` refused a plan without a path and `reactionBlocks`
held one, both telling the model to send the thing it had no way to send.
Before the strip, every converse turn's `propose_strategy` carried the
grammar, so a forced propose could attach a path. The strip made that a
regression.

**The obvious fix is half a fix, and measuring showed which half.**
`decide(brief, {}).proceed` sees the BUDGET escape, because rounds live on the
record — and misses the typed one entirely, because "go ahead" is a fact about
the TURN. Measured on a thin record: budget-spent gives `proceed: true,
forcedBy: 'budget'`, while "ok go ahead" gives `proceed: false` from the
record and `forcedBy: 'user'` only in the turn's own decision. A record-only
reading would have left exactly the half a manager triggers by typing.

So it is the same input the turn's own decision uses:

```ts
const journeyAllowed = () => !isBuildTurn && decide(brief, { proceedRequested: limitReached }).proceed;
```

`limitReached` already folds rounds spent, `forceProposal` and `saysProceed`,
and `decide` short-circuits on it. `readyForPlan` is folded in: nothing else
needed "ready and not forced". Verified end to end — asking gets 0 lookups and
no blueprint field; budget-spent and "go ahead" both get 5 lookups and the
blueprint field.

**Two prompt lies went with it.** `# How to write this turn` named all five
tools on every turn, including `build_campaign` on a discovery turn where it
is not registered — and naming a tool the model cannot call is how a live
Confirm came to reply that the build was unavailable to it. It is now one
sentence per phase. And SYSTEM's journey line said "Call list_channels" on
asking turns where that tool does not exist; it now says "Where list_channels
is on the turn". SYSTEM is 32,301 and HOW TO DESIGN is untouched.

The retargeted pin is "releases it on EVERY turn that may propose, escapes
included" — a source grep for the expression plus the behaviour on all three
brief states, so the next person to narrow it has to read why. Reverting to
either the old conjunct or the record-only reading fails it.

1422 unit, 118 agent-proto, typechecks and build clean. `llm-prompt.html`
regenerated: the propose panel says a forced propose lands there too.

## 2026-10-24 — The loop was the record, not the gate

`eval/runs/ui-s-1792770967470`. Confirm landed on turn 7 after the manager had
repeated the same two facts four times. Every hold was correct. What made it a
loop is that their English did not write the fields the gate reads, and a held
propose threw the payload away. Three fixes, all record-side.

### 1. A labelled send is not a blank send

Turn 8's Confirm raised "needs an objective", "needs a name" AND "needs a
describe" on four sends that carried `label`, `copy` and `cta` — twelve issues,
`designGenerated: false`, export blocked on a journey that already had
everything a person needs to read it.

`describe` was the leftover. The other two read `name || label` and
`describe || copy`; this one read `describe || copy` alone, while the value
that actually fills the step two lines below is `givenDescribe || givenName`.
One condition for all three now: report when the send says NOTHING, stay quiet
when it says something under a different field name. The genuinely blank send
still reports all three and is still built, never deleted.

### 2. Their sentence closes the probe

`unprobed-other-axes` clears only through `otherAxesProbed`, which wants a
second segmentation dimension with `basis: 'user'` or a recorded question
matching "anything else". In turn 4 the manager closed it — and the agent WROTE
their closure down, as a dimension note reading *"Manager confirmed they do not
track any other pattern beyond ticket size"*, with `basis: 'none'`. The gate
reads the basis, not the note. So the hold reprinted through turns 5, 6 and 7
over a question answered in the first of them.

`noteClosedOtherAxes(brief, text)` sits beside `noteOpeningFacts` and runs on
EVERY converse turn, outside all three existing branches — each of those is
conditional on something (pending evidence, an outstanding question, a changed
objective) and this must not be. `brief.answers` never grew past turn 4 either,
because every question was already addressed and nothing recorded the reply, so
reading `latestUserText` directly is what makes it work in exactly that state.

When their sentence says there is nothing else, every segmentation dimension
that is NOT the seen axis becomes `unavailable`, `basis: 'user'`, carrying their
words as the note. Ticket size untouched. No axis invented. It only ever
RELEASES.

**`readsAsDecline` + `mentionsData` was the wrong pair** and that is worth
keeping: they want a data-noun, and "I do not track anything else" has none.
The nouns here are ELSE, OTHER, SECOND, ONLY.

`segmentationDimensions` and `seenAxes` moved from `gate.ts` into
`discovery.ts` and are imported back, because both files now need the same two
rules and gate already imports discovery — the other direction is a cycle.

### 3. A refusal on one point is not a reason to start the rest again

Turns 5 and 6 each produced a `propose_strategy` result and were held. The
held branch returns `strategy: null` and `pendingBlueprint: null` — correctly,
nothing is approvable — and that threw the payload away, so each attempt
started from the model's MEMORY of the last one. A payload with seven named
paths and real per-case fallbacks was refused for something else; the next one
came back with two paths and a generic "still unconverted".

`brief.lastProposal` carries the last ACCEPTED proposal (plan + path) across a
hold, written only when `propose_strategy` returns ok with non-empty steps.
`fillFromLastProposal` restores three regressions in a LATER call:

- no steps at all → the stashed path;
- fewer than two landed cases named, when the stash named two or more → the
  stashed `ifStillUnconverted`, matched by path, or by channel when the path
  was renamed;
- paths exploded into engagement arms ("{who} — unread arm") → collapsed back
  to the who-split. Unread and read are what the JOURNEY forks on; as path
  names they double the audience count and leave every path one send deep.

**It will not merge a linear clock over a stashed outcome fork.** If this
payload's journey does not react and the stashed one did, the stash is left
alone and `reactionBlocks` holds the turn — swapping the journey silently would
hand back an approval for steps the model did not send. A first propose with no
journey is still refused: there is nothing stashed to fill from. And the tool
result says what it restored rather than doing it quietly.

Confirm still appears only when `decide().proceed`, and a held plan still never
reaches `pendingBlueprint`.

### Verified

1443 unit (from 1426; 3 in `missingTemplate`, 5 in `probeThenLock`, 9 new in
`heldProposeKeepsItsColumns`) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. SYSTEM untouched at 32,301 — no
prompt was added for any of this.

Reverting the `describe` condition fails 2; disabling `noteClosedOtherAxes`
fails 2; dropping the stash write fails 4.

## 2026-10-24 (cont'd) — A clock may win. Unread/read is an upgrade, not a
pass mark

`eval/runs/ui-s-1792829868203` turns 3 to 5. Turn 3: six prose captions
accepted as `blueprint.steps`, then held `no-reaction`. Turn 4: a real fork,
held `cadence-unnamed`, with path names like "High ticket - delivered, not
read". Turn 5: two paths plus a day-2 SMS and a day-2 WhatsApp on "Standard
ticket", held `channel-spray` — the two exclusive arms of one fork counted as
two sends to one person. The manager ended up clerking DELIVERED by hand.

### The reversal, and it is of my own over-correction

`reactionBlocks` refused any winner that was not branch-on-response or
wait-for-event. The measured failure it came from was narrower: a plan that
CLAIMED a reaction and shipped a timed drip. I generalised that into "a clock
is never a plan", which is the application designing the campaign — a
ticket-size split with a sensible cadence is something a manager can run on
Monday.

What survives is the shape this codebase actually trusts: **compare the claim
against the choice.** Two things can be wrong and only these two.

- *Claimed and not built* — a reactive winner still needs two landed cases
  named in `touches` AND a blueprint that `journeyReacts`. A ticket-size
  diamond alone is not that fork: who they are is not what they did.
- *Written and then abandoned* — a new code, `chose-clock-over-reaction`. If
  the architectures include a reactive candidate and the winner is the clock,
  they described the upgrade and picked the weaker one. The refusal says so in
  their terms, keeps the who-split explicitly, and offers dropping the rival
  as a legal move, so it cannot trap.

If every candidate is a clock, there is no hold. **A who-split plus a clock
Confirms**, which is the end of the story this slice is about.

The old "no chosen candidate at all" hold did not need keeping: a proposal
with a reactive candidate and no winner lands in the new rule, which is the
case that matters.

### They stack: who-split, then a fork inside a group

SYSTEM's "EVEN SPACING WITH NO REACTION IS NOT A PLAN" was fighting all of
this and is replaced in words, not shortened away: a steady cadence is a
complete plan; unread/read is intelligence on top, worth having where it
changes the next job; the fork may sit on the first send and on a later one
only if those two people need a different job, and if they would get the same
reminder, do not fork; copy matches the arm — repeat the fact to someone who
has not read it, change the argument for someone who has; unread and read are
NOT two more audiences; and if both candidates are written, the reacting one
wins. 32,757 against the 33,500 cap.

### The form must not mix who with what they did

**Captions are not steps.** The tool accepted a "6-step path" of prose because
the check asked only whether the array was non-empty; the compiler would have
hit `Unknown step kind "undefined"` on each one. It now requires every element
to be an object with a string `kind`, and the refusal names the grammar. A
first propose with no journey is still refused the same way.

**The ARM regex died on a comma.** `[^,]*?` could not match "High ticket -
delivered, not read" or "Standard ticket - both arms", so nothing collapsed
and the engagement arm stayed in the path name. Anchored on the separator
after the WHO name now; once the suffix starts with a landed case the rest may
say anything. A who-name that merely contains a hyphen ("Co-brand cards") is
left alone, and there is a test for that.

**Exclusive arms are not spray.** Two rows on one path and one day with
different channels are the two sides of one fork when their
`ifStillUnconverted` name DIFFERENT landed cases — nobody receives both. The
same sentence on both still means both would fire, which is the fatigue the
block exists for. `clears.how` no longer says "put SMS on the undelivered
fork": unread and read are landed cases, and the fix is one arm each.

Also fixed while in there: the live turn-5 tool result read "I restored the
journey, from the last plan you sent that I accepted from the last plan you
sent that I accepted" — my own duplicated clause from yesterday.

### Verified

1451 unit (from 1443) and 118 agent-proto. `tsc --noEmit`,
`server:typecheck` and `npm run build` clean.

Reverting the clock-may-win branch fails 3; reverting the exclusive-arms
exemption fails 1; reverting the caption guard fails 2.

Nothing auto-inserts a fork, Confirm does not require unread/read, and a held
plan still never reaches `pendingBlueprint`.

### Same day — the probe reprinted after the taught answer

Two bugs, both mine from the fix above, both measured before touching
anything.

**`closesOtherAxes` did not match the sentence the product teaches.** SYSTEM
says "We do not track that" closes it, the hold's own text says *"If you do
not track anything else, say so"*, and the first-run fixtures type exactly
that — and the matcher only knew "anything else", "no other pattern" and
"that is all we track". So the manager gave the taught answer and the hold
reprinted.

Added anaphoric forms: `do not track that | it | those | them | any of that |
either`. **The object has to be a PRONOUN**, which is what keeps the
scoreboard out: "we do not track that" closes the question just asked, while
"we do not track conversion rates" and "we do not have conversion data" are
about history, which has its own limitation. Letting those in would close a
question nobody answered, and there are now four negatives pinning it.

**`noteClosedOtherAxes` bailed when there was nothing to rewrite.** `if
(!closing.length) return brief` — so on a brief whose only segmentation
dimension was the seen axis, because the agent had never parked a leftover
category row, even a perfect "we don't track anything else" was a no-op. The
good sentence failed too.

It now writes a confirmed FACT whenever they close — quoting them, the same
instrument `noteOpeningFacts` uses for "no campaign history" — and rewrites
leftover dimensions as well when there are any. **One definition of done, not
two.** `otherAxesProbed` gains a fourth leg that reads that fact: the three
older ones read dimensions and question text, and a conversation is neither.

No axis is invented. Writing a fake "merchant category" row to satisfy the
two-user-dimensions rule would put a customer cut on the record nobody named,
and the next turn could design on it. The seen axis is untouched, including
the manager's own "₹10,000 line" in its note.

**A test of mine was wrong and the code was right:** I asserted that no rupee
figure appears anywhere in the dimensions after a close, which correct
behaviour fails — THEIR figure is in that note and must survive. The
invention worth forbidding is a cutoff the application wrote, and the way to
check it is that nothing changed.

No new hold, no new question, one call site, SYSTEM untouched at 32,757.

1453 unit and 118 agent-proto. Dropping the "track that" patterns fails 3;
restoring the early return fails 1; letting a conversion-rate close count
fails 1.

## 2026-10-24 (cont'd) — The tool schema and the tool result were telling the
model opposite things

`eval/runs/ui-s-1792834072700` turn 3. The manager had just given the
barrier. Discovery was not finished: no success measure, the second-pattern
probe never asked, two dimensions one of which was the agent's own assumption.
So `journeyAllowed` was false and `outputToolsForPhase` had stripped
`blueprint` and `$defs` off `propose_strategy` — correctly; the agent must not
learn the builder while it is still asking who converts.

Then `applyOutputTool` refused every submit with *"Send the SAME plan again
with "blueprint" filled in — the path you are asking them to approve, in the
same grammar build_campaign uses"*, and the orchestrator wrapped it with *"do
not start over and do not go back to discovery"*. **Five attempts, identical
error**, including an invented object using `type` instead of `kind`, an
array, and a paragraph. The agent then dumped the plan into the chat and asked
the manager to approve it by hand. `strategy` stayed null, Confirm never
appeared. It was right to call that a wall.

The comment above `withoutJourneyGrammar` already said the intended shape: a
model that proposes early is refused BY THE RECORD, not told to send a field
the tool does not have.

### Two exits, and they no longer share a sentence

`decide(brief).proceed` false — this turn cannot carry a journey. Refused
whatever arrived, including a `blueprint` smuggled in as an extra field. The
message never says "filled in", "the SAME plan", "build_campaign" or a step
kind. It says discovery is not finished, names what is actually still open
(how they would judge success; whether anything else they have SEEN splits who
acts), and says to ask or to record instead — plus, because this is what the
live agent did, *do not put the plan in the chat and ask them to approve it by
hand*. `strategy` stays undefined and nothing is stashed.

`decide(brief).proceed` true — today's checks, unchanged: a real blueprint,
steps that are objects with a string `kind`, captions refused with the grammar
named, fill-from-stash as it was.

And the orchestrator's wrapper is now gated on the ready-turn error. It is a
PAYLOAD correction — "one thing is wrong, fix it and resend" — and appended to
"discovery is not finished" it told the model to resend a plan it had just
been told it may not send. That is why the live model resubmitted five times
instead of asking.

**One residual, stated rather than discovered later.** The schema is gated on
`journeyAllowed`, which includes the turn's escapes (`limitReached` folds
rounds, `forceProposal` and `saysProceed`); this reads `decide(brief)`, which
sees the record and the round budget but not a manager typing "go ahead" on a
thin record. On that one turn the field is in the schema and this still reads
not-ready. Closing it needs the flag threaded into `applyOutputTool`, which
the brief alone cannot supply.

### Six fixtures were never gate-ready

`heldProposeKeepsItsColumns`, `outputTools`, `refusedProposeIsNotRecorded`,
`outcomeBranch`, `proposeTurnDefects` — all called `propose_strategy` on briefs
that passed the TOOL's own checks and not the record gate, so they were
testing the asking-turn path while claiming to test architectures, renderers
and stash merges. Each now carries converters, success criteria and three
reasoned dimensions. **Seventh slice running** that a new structural check
exposed fixtures written as "valid for the checks that existed then"; the
difference this time is that the check revealed they were never ready in the
first place.

### Verified

1461 unit and 118 agent-proto. `tsc --noEmit`, `server:typecheck` and
`npm run build` clean. SYSTEM untouched at 32,757; `blueprint` is still off
the asking-turn schema; no prose plan is accepted so Confirm can appear.

Putting "send blueprint" back on an asking-turn miss fails 3; dropping the
path requirement on a ready turn fails 6; appending the wrapper to every
propose failure fails 1; restoring `blueprint` on the asking schema fails 2.

## 2026-10-24 (cont'd) — One fact about the turn; an asking turn may write the
record and may not write a path; the asking prompt is discovery only

Three slices in the order they depend on each other. A is plumbing, C is the
product fix the live run demanded, B only shortens the asking prompt.

### Measured first, and the second run is worse than it reads

`ui-s-1792834072700` turn 3: the asking schema had no `blueprint`, the handler
demanded one, five identical errors, the plan dumped into the chat.

`ui-s-1792835962676` turn 3: **three** `propose_strategy` calls, each carrying
the manager's own measure in `successCriteria` — *"the count of EMI-eligible
purchases that convert during the 7-day window, per the manager's own
instruction"* — all three refused whole, `brief.successCriteria` still `[]` on
turns 1, 2 and 3. The reply then opened:

> "I'm hitting a gate that still treats 'how success should be judged' as
> unresolved, even though you've told me twice it's the number of purchases
> converted."

The agent reported our bug to the campaign manager, in the chat, by name. It
also spent three `record_dimensions` retries looking for a door that did not
exist, and one of those failed too.

**And we had already written the catch-22 down.** `discovery.ts` ~2417: *"
`successCriteria` lags by one turn because it is only populated from the
model's own propose payload, so the brief must say 'record it', not 'ask
again'."* That field existed on ONE tool, the one an asking turn refuses, and
`briefForPrompt` instructed the model to record it there. The brief named a
field the turn could not reach — the same shape as the schema-versus-handler
contradiction, one layer up. `nextCustomerQuestion` then re-asked on exactly
that state: success empty AND a reply already in hand.

### Slice A — `turnPhase(brief, { isBuildTurn, limitReached })`

`asking | ready | build`, in `gate.ts`, and every reader takes it.

Seven places behaved differently per phase and each computed its own answer:
`systemForPhase(isBuildTurn, journeyAllowed)` (two booleans, four states, one
impossible), `toolsForPhase(isBuildTurn || journeyAllowed() || designSeen)`,
`outputToolsForPhase(isBuildTurn, journeyAllowed())`, `applyOutputTool` —
which asked `decide(brief)` with **no escape at all** — the "do not go back to
discovery" wrapper, keyed on a regex over our own refusal text, and two
`decide(...)` calls passing only `saysProceed(latestUserText)`.

**The inputs diverged, and the divergence was the live wall.** `limitReached`
folds all three escapes (round budget, `forceProposal`, `saysProceed`), so a
manager typing "go ahead" on a thin record got a schema WITH `blueprint` and a
handler that refused the payload for arriving on an unfinished record. The two
`decide` calls are the mirror image: they could not see the budget or the
button while the schema could, so a spent budget asked for a plan and then
held the plan that came back. `evaluateDiscovery` already took `limitReached`
as `forced`, which is how that stayed invisible.

**One argument, not two booleans.** `systemForPhase` and
`outputToolsForPhase` take a `TurnPhase`; a caller cannot pass a pair that
cannot exist, and cannot compute the second half from a different escape set.

**Evaluated per model ROUND, not once per turn.** Round one may file the last
finding the record needed, and round two of the same turn is then genuinely
ready to carry a path. A value frozen at the start of `orchestrateStream`
would file success and hold the asking schema for the rest of the turn — a
one-round-late loop of exactly the kind this replaces. The thunk stays a
thunk; the round reads it once into `const phase`.

**Inside one model response the phase is fixed, and that is deliberate.** The
schema the model wrote against cannot change halfway through a batch, so a
`propose_strategy` arriving beside the `record_findings` that completed the
record is still an asking-turn propose. The NEXT round carries the path.
`decide` is no longer imported by `outputTools.ts` at all, which is the
structural version of "the handler does not re-derive".

### Slice C — the record and the path are two capabilities

`record_findings` gains `successCriteria`, and a success-only call is a
complete call. It used to error for carrying neither converters nor barriers,
which would have been the same trap one field along.

**A refused proposal gives up its record fields before it is refused.**
`applyRecordFields` applies `successCriteria`, `converters`, `barriers` and
`dimensions` through the recorders that already own them — `recordBarriers`
still verifies quotes, `recordDimensions` still normalises an assumption to
deferred, `recordSuccessCriteria` still replaces and still treats an empty
list as silence. No second parser, and no regex over their chat.

It is the FIRST thing in the case, ahead of even the summary check: every
check below judges a plan, and this turn is not judging a plan. The live
payload would have been harvested anyway; a thinner one would have been thrown
away with the manager's own words still in it.

**"Still open" is composed from the brief as it now is.** Reading the incoming
brief would file success and then tell them to go and ask for it, which is
what the live gate did three turns running. With success filed the sentence
drops it; with success still empty the next move names the tool that can take
it.

**Replayed against the live turn.** Phase `asking`; the manager's measure
lands; the plan is still refused with the same sentence; `strategy` undefined
and nothing stashed; and `decide` goes from `['awaiting-reply',
'success-unsettled']` to `['awaiting-reply']`. The re-ask cause is gone. The
remaining block is the record saying a reply has to arrive, which is correct.

`nextCustomerQuestion`'s success clause now fires only when nothing has been
answered yet. It had no production caller — `record.ts` passes
`skipSuccess: true` and `evaluateDiscovery` has its own ladder — so this is
the clause being made correct for the next caller rather than a live fix, and
it is written up that way.

**The residual, stated rather than discovered later.** Success is now
self-certifiable one step earlier: the agent can clear a record block with
text it wrote. In the live payload criterion 1 is theirs and criterion 2 —
*"this run's count establishes the baseline"* — is the agent's. Propose never
attributed success either, so the bar is unchanged; what changed is when it
can be reached. A quote check on success was deliberately NOT added:
`quoteIsTheirs` took two attempts to get right on barriers, and a false
negative here would deadlock the one finding managers answer most clearly.

### Slice B — the asking prompt is a straight cut

§3 to §8 out: the platform mapping, the sequence and entry event, the
hypothesis, the seven options, the journey (NAME EVERY TOUCH, A STEADY
CADENCE, IF YOU WRITE BOTH) and the customer copy. All of it about a campaign
the turn may not design yet, read on every discovery round of every
conversation. §9 stays, because it is about the record.

Two paragraphs the cut strands go with it: the `openItems` kind-list, the
limitation paragraph that names those kinds and means nothing without them,
and *"Propose a complete, coherent strategy even when something is open"* —
which invites on an asking turn the exact move A's refusal exists to stop.

**`SYSTEM` is untouched and both other phases get it whole**, so every
`promptMethod` pin — that test regexes the constant out of this file's source
— is unaffected. Nothing was rewritten, §2 was not touched, and no method was
added.

**It throws on a missing marker.** Both silent alternatives are worse: falling
back to the full prompt hands the design method to a discovery turn with
nothing to say so, and a slice whose end marker has gone quietly becomes "the
rest of the file" — which is how two `emptyRoundRecovery` tests came to assert
against everything to EOF. Every test run imports this, so a broken marker
cannot reach a conversation.

**One bug of mine, caught by measuring rather than reading.** The first cut
took its end marker with it, so §9, QUESTIONS AND OPEN ITEMS and the whole
OUTPUT chapter vanished from the asking prompt and the only sign was a length.
The cut now stops BEFORE the second marker and searches for it from the start
of the cut, and a test asserts the twelve things an asking turn must still
contain rather than only the eleven it must not.

**The §1 tension is left in place, deliberately**: the first turn must ask how
success is judged AND find who converts. That is why the live EMI run opened
on count-versus-value, and it is not a prose problem to solve in this slice.

### Verified

**1487 unit (from 1461) and 118 agent-proto.** `tsc --noEmit`,
`server:typecheck` and `npm run build` clean.

Character counts: `SYSTEM` constant **32,757 / 33,500**, not raised and not
edited. `systemForPhase('asking')` **17,837**, bounded by a new test at
22,000 — the 33,500 cap does not reach a string the asking turn no longer
receives in full. Ready and build **32,779** each and identical, which is the
runtime length of the same constant.

Reverts, each run: the asking prompt keeping the design chapters fails 3; the
cut eating its end marker fails 1; the handler re-deriving the phase from the
brief fails 3; refusing the asking propose without harvesting fails 2;
`record_findings` losing `successCriteria` fails 4.

Retargeted rather than rewritten: six source-text pins on the old expressions
(`confirmReachesGeneration`, `conversationFlow`, `emptyRoundRecovery`,
`turnOneAndQuestionList`, `discoveryIsBusinessOnly`, `heldProposeKeepsItsColumns`),
and roughly forty boolean call sites across eight test files mapped to the
phase. The wrapper pin is now the phase rather than `!/Discovery is not
finished/`, which coupled it to copy that is free to change.

`llm-prompt.html` regenerated: the method row says an asking turn gets
discovery only, and the dump reports asking at 17,837 against 32,779.

### Not in this slice

No live EMI run. SYSTEM not grown, the cap not raised, no prose plan accepted,
`blueprint` still off the asking schema, no regex over their chat, no quote
check on success, §2 untouched, nothing committed or pushed.

## 2026-10-24 (cont'd) — One definition of done, owned by the record. The
reply closes the question; an asking turn has no plan tool

`eval/runs/ui-s-1792839251135`. Three turns, and the manager finished the
work: success is the number of conversions, ₹10,000-plus purchases convert on
their own, the barrier is that customers think it costs extra, and the
extra-axis probe came back *"1. not something we track"*. Every finding
reached the brief. The run ended in discovery with nothing on the canvas, the
plan in the chat, and a request that they type "go ahead".

### The record could not hear them

All four questions ended the run with `answeredInRound: 0` and
`addressedInRound: undefined`. Read off the turn files rather than guessed:

- live ingest called `recordAnswer`, which sets the FIRST field;
- `outstanding` and `decide` read the SECOND;
- `recordReply` had closed both since the day it was written, and nothing in
  production called it — its own comment says it "replaces `recordAnswer` +
  `recordAddressedQuestions` + `recordUncoveredQuestions`";
- the tool-only exit (`!parsed.ok && recordedViaTools`) returns before the one
  closer that did run on the parsed path;
- `questionResolutions` with `carried` does not write the field either.

So `decide(turn-3 brief)` was `['awaiting-reply']` — on four answered
questions — and `turnPhase` was `asking`. Which still offered
`propose_strategy` and then refused it, and the refusal's "still open" list
named success and the second-pattern probe: **the two things they had
answered**, and not the one thing that was actually blocking.

### Live ingest uses the one write that already existed

`receive` — `recordReply` plus `settleUnknowns` — is the orchestrator's ingest
now, at both call sites. No third closer was added.

`recordReply` is also COMPOSED from `recordAnswer` rather than restating it:
the answer text, the confirmed fact carrying the ids it settles, and
`answeredInRound` come from one function, and closing what was on screen is
the one thing this adds. Two implementations of "a reply arrived" is how the
two fields came to disagree in the first place.

**Round counting unified by taking the bump OUT.** `recordReply` advanced
`brief.rounds` and `recordAnswer` did not, so wiring it in would have counted
a round for the reply AND a round for the questions that went out with it.
`MAX_ROUNDS` is "rounds of QUESTIONS before the agent must work with what it
has", so the counter stays with `recordQuestions` and
`recordEvidenceRequests`. One meaning, one writer.

**`awaitingAnswer` reads `outstanding(brief)`**, not `answeredInRound`. The
old test could not see a question `reopen` had put back, which is the same
field confusion one layer up.

**`notCovered` is a bounded RE-OPEN, in both places it appears.** The parsed
path called `recordUncoveredQuestions`, which with everything already closed
is a no-op; it calls `reopen` now. And `record_findings` has carried
`notCovered` in its schema and its input type since the tool existed with
nothing reading it — the one bounded way to say "their reply did not touch
that question" did nothing on the production path. Wired, with
`REOPEN_LIMIT` still stopping the same question coming back for ever.

### `propose_strategy` is absent on an asking turn

`outputToolsForPhase('asking')` is `ask_questions`, `record_findings`,
`record_dimensions`, `request_evidence`. `withoutJourneyGrammar` and the
asking-turn refuse-and-harvest branch are deleted.

**The stripped-schema design was mine, yesterday, and it was wrong.** The
reasoning — the gate should decide when a proposal is allowed, and a model
that proposes early should be refused by the record rather than left unable to
speak — reads well and failed twice: `ui-s-1792834072700` turn 3 sent the same
plan five times and then asked for approval by hand, and this run asked for
"go ahead". **A tool on the list is an invitation.** Refusing an invitation we
extended teaches the model that the plan is the move and the refusal is an
obstacle to work around.

Nothing is lost, because `record_findings` now takes `successCriteria`
alongside the two customer findings. Findings are FILED, not smuggled through
a refused plan.

`applyOutputTool` therefore takes **no phase argument**. It read
`decide(brief)`, then took the phase, then stopped needing one: the question
only ever existed to serve the branch that is gone. A `propose_strategy` call
on an asking turn is now impossible through the API and a test bug anywhere
else.

**One prompt lie went with it.** The asking turn's "how to write this turn"
line named `propose_strategy` as the plan tool. Naming a tool the model cannot
call is how a live Confirm came to reply that the build was unavailable to it.
It now names the four it has and says neither plan tool is on the turn.

### A refusal quotes `decide`, not a list written here

Every refusal in the propose case goes through one `refuse()` that appends the
live `decide(brief).blocks` reasons. `Block.reason` is already the
manager-facing half, so nothing is paraphrased.

Usually that is empty, because the tool is only on the list when the gate says
ready. It is NOT empty when the turn was FORCED there — the round budget, Skip
& propose, or a typed "go ahead" — and that is exactly the turn where what is
still open matters. The two-item list it replaces named what I had guessed
were the likely blocks; on the live brief both were done and the real one was
`awaiting-reply`, which it never mentioned.

The canned *"Tell me to go ahead and I will send it again"* was NOT patched.
It is set in exactly one place — a refused `propose_strategy` — and that tool
is no longer on an asking turn, so the path stops firing for this miss. There
is a test pinning that there is still exactly one setter. `saysProceed` keeps
its job (Skip & propose, an explicit stop-asking) and does not resurrect a
refused payload.

### Their sentence closes the probe, and files the axes that question named

`closesOtherAxes` matched none of *"not something we track"*: no "else" noun,
and the object is the indefinite "something" rather than a pronoun. Added, and
still anaphoric — "we do not track conversion rates" names its own subject and
stays out, because history has its own limitation and closing a question
nobody answered is the one thing this may not do.

The rewrite half already existed and now runs: every segmentation dimension
that is not the seen axis becomes `unavailable`, `basis: 'user'`, carrying
their sentence as the note. The axes came from rows already on the brief — the
two the probe named — rather than from parsing our own question text, which
would write dimension rows nobody can audit. Ticket size stays the seen split,
no axis is invented, and nothing was added to satisfy `MIN_DIMENSIONS`.

### Replayed against the live run

The turn-3 brief, through the real ingest with their real reply:

```
outstanding   4 -> 0
decide        ['awaiting-reply'] -> []
turnPhase     asking -> ready          (no proceedRequested, nothing typed)
probe         closed; merchant category and card usage unavailable/user
rounds        0 -> 0                    (not double-counted)
```

### Tests: rewritten, not preserved

`replyClosesTheQuestion.test.ts` walks the three turns of this conversation
through `receive` and `record_findings` and ends ready with nothing
outstanding.

The pins that encoded the old split were rewritten rather than retargeted,
because each was asserting the symptom:

- `answerAttribution` pinned model-claimed `answered` as the ONLY closer — "a
  reply nobody attributes leaves every question open". That contract is what
  stalled this run. Now: a reply closes what was on screen, `notCovered` /
  `reopen` is the bounded exception, a resolution is commentary, and the
  verification rules (ids must be real, counts come from state, a proposal
  cannot silently drop a question) are untouched.
- `probeThenLock` called `recordUncoveredQuestions(recordAnswer(...), [])` and
  commented it as "THE PRODUCTION PATH". It was not, and a fixture asserting a
  path nothing walks is how three turns of this survived. Pointed at `receive`.
- `turnOneAndQuestionList` required `outstanding(...) > 0` after a reply —
  true only because of the bug. It now pins what the test is about: raising no
  questions does not delete the questions already asked.
- `forkGuardUnderFailure` hand-built "only q1-0 was addressed", a state
  production can no longer produce. Its fixture stops pre-closing anything and
  walks the live sequence instead: receive closes both, the model's
  `notCovered` reopens the fork, the guard refuses. Its anti-trap test now
  asserts the SECOND turn proceeds, which is `REOPEN_LIMIT` working.
- `objectiveClarification`'s "every question already answered" brief carried
  `answeredInRound` only — the bug state — so the orchestrator correctly
  treated the next message as an answer and never reached the branch those
  tests are about.

### Verified

**1493 unit (from 1483) and 118 agent-proto.** `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. `SYSTEM` untouched at 32,757 /
33,500; asking 17,837.

Reverts, each run: ingest back to `recordAnswer` fails 3; `recordReply` not
closing `addressedInRound` fails 8; `propose_strategy` back on the asking list
fails 9; the probe matcher losing "not something we track" fails 1; the
refusal not quoting live blocks fails 1.

`llm-prompt.html` regenerated: the asking panel says there is no plan tool,
and the asking turn's four tools are listed.

### Not in this slice

Turn 1 opening on count-versus-value is leftover prompt and was left alone. No
SYSTEM growth, no new discovery question, no auto-inserted forks, no invented
cutoffs, `MAX_TOOL_ROUNDS` unchanged, nothing committed or pushed.

### Known residual

A message that arrives when NOTHING is outstanding still records no answer —
the ingest branch is conditional on `awaitingAnswer`, as it has always been.
So a volunteered fact after every question is closed is readable in the
transcript and absent from `brief.answers`, which is the corpus
`quoteIsTheirs` checks a barrier against. `noteClosedOtherAxes` reads
`latestUserText` directly for exactly this reason. Widening ingest to record
every message is a separate decision about what counts as an answer.

## 2026-10-24 (cont'd) — A pattern they stated counts, whichever honest label
the model gave it

`eval/runs/ui-s-1792842540156`. Three turns, Confirm never appeared,
`lastPhase` discovery, `strategy` null, the run titled "Waiting for your
answer".

**The ingest lid from the previous entry held.** All five questions carry
`addressedInRound`, `awaiting-reply` is gone, nobody was asked to type "go
ahead". What blocked `decide` was the record reading its own labels too
narrowly: `['converters-unknown', 'too-few-dimensions']`.

### What the manager said, and what the record did with it

They said "10k+ txns convert more" — and said it twice; their second reply
reads *"already said txn 10k+ convert more"*. Asked about category: "nothing as
of now". The model wrote all of it down:

```
converters   shape "Transactions of ₹10,000 and above convert … at a
             noticeably higher rate", basis user-belief, ONE candidate
dimensions   Transaction ticket size            retained / user-belief
             Purchase category or merchant type deferred / assumption
```

Four rules then each read one field and said no:

- `convertersSettled` accepted `basis: 'user'` or two candidate groups, so
  who-converts stayed open on a brief holding their sentence;
- `seenAxes` accepted `basis: 'user'` only, so ticket size was **invisible** —
  `unprobed-other-axes` never even ran, because it needs exactly one seen axis
  to fire;
- `recordAsked` injected "Who tends to do this already today" as q0-4, after
  q0-1 had asked the same thing and been answered;
- two real dimension rows then failed `MIN_DIMENSIONS`.

The turn therefore stayed `asking`, `propose_strategy` was not on the list,
and round 1 dumped a seven-day email trade-off into the chat with no tool
calls at all. **That essay is a consequence, not a second defect** — it is
what a model does when it has a plan and no tool to put it in.

### `user-belief` counts, in both readers

`convertersSettled` and `seenAxes` now accept `user` **and** `user-belief`,
the way barriers always have. `assumption` still settles nothing.

The distinction that matters is not which label — it is **theirs versus
ours**. A pattern the manager has noticed is, read strictly, a conjecture
about why customers behave, which is exactly what `user-belief` is for; read
the other way it is a fact they own. Both are defensible for one sentence, and
a gate that accepts one of them turns settledness into a coin toss on wording.

No quote checker was added: `Converters` has no quote field, and a new
judgement of their words to RAISE a block is the one thing `record.ts` forbids.

### The probe is counted from the record, not from a phrase

The question that closed it read *"BEYOND transaction size, have you noticed
any difference by purchase category or merchant type…"*. The question-text leg
of `otherAxesProbed` wanted "besides" or "anything else". Adding "beyond"
would buy this run and lose the next: the question is the agent's own prose
and there is no list of its wordings.

So a fifth leg reads the record instead. Once a pattern has been **seen**, a
question we asked that NAMES another axis on the brief — matched on the
dimension row's own content words — and that carries `addressedInRound` is the
probe, whatever words it used. Two auditable halves: a dimension row, and the
ingest write. A question still outstanding does not count, and there is a test
for that using `reopen`.

**Nothing was added to `closesOtherAxes`.** "nothing as of now" is still not a
taught phrase, and their words are untouched.

### Three raised lines of enquiry are not a second investigation

`too-few-dimensions` is skipped once there is a seen axis AND an answered
probe — the same pair `unprobed-other-axes` is built on, so the two rules
agree by construction rather than by wording. On this brief the only way to
reach three rows would have been for the agent to invent an axis nobody named,
and the record would then carry a customer cut out of nowhere.

`MIN_DIMENSIONS` still means what it meant while the search is open, and
`gateClearability`'s pin on it was retargeted to a brief where nothing has
been seen — its old fixture (two `retained` / `user` rows) is now a CLOSED
search, which is the new rule working.

### The inject keys on the shape, not on settledness

`nextCustomerQuestion` returns the who-converts question only when there is no
`converters.shape` at all. Stronger than waiting for `convertersSettled`, and
deliberately: both reasons a shape can be unsettled are reasons to say
something OTHER than the generic question. An `assumption` shape needs the
manager's view of what the AGENT wrote; a non-answer shape needs the design to
learn it. The BLOCK is untouched either way — `converters-unknown` still holds
an assumption shape, and its `clears.how` says what to do.

### Replayed against the live brief

```
convertersSettled   false -> true
seenAxes            []    -> ['Transaction ticket size']
otherAxesProbed     false -> true      (their words unchanged)
decide              ['converters-unknown','too-few-dimensions'] -> []
turnPhase           asking -> ready    (nothing typed, no proceedRequested)
recordAsked         injects only the question it was given
```

`tests/unit/statedPatternCounts.test.ts` reads that brief off
`eval/runs/ui-s-1792842540156/turns/turn-3.json` rather than restating it as a
cleaner fixture, so the pin cannot drift from what the agent actually
produced.

### Verified

**1510 unit (from 1494) and 118 agent-proto.** `tsc --noEmit`,
`server:typecheck` and `npm run build` clean. SYSTEM untouched at 32,757.

Reverts, each run: `convertersSettled` back to `user`-only fails 5; `seenAxes`
back to `user`-only fails 7; dropping the record leg of `otherAxesProbed`
fails 5; `too-few-dimensions` demanding a third row fails 3; the inject keyed
on settledness fails 1.

**One revert initially passed and the test was the weak one, not the code.**
Keying the inject on settledness is inert on this brief now that the basis
rule is fixed — both locks hold it shut. The case that exercises the second
lock on its own is an `assumption` shape: the block stands, and the generic
question still must not reprint. With that test added the revert fails.

### Not in this slice

SYSTEM untouched; `recordUncoveredQuestions` neither deleted nor aliased;
ingest not widened for volunteered lines after a closed record; the canned
go-ahead sentence not patched; no live run; nothing committed or pushed.
Confirm is still the act that builds — this only lets the plan tool appear.
