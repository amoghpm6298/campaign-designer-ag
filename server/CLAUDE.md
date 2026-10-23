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
