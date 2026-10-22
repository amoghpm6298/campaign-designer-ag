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
