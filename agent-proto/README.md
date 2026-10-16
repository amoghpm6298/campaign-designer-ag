# Agent prototype — vertical slice

The smallest runnable path for the agentic drip-campaign design system:
**schema generated from app source → context → plan → build via the app's own
reducer → validate with the app's own validators → structured run record.**

No UI, no HTML report, no model call, no memory framework, no bank-data access.

```bash
npm run agent:schema     # regenerate the schema artefact from app source
npm run agent:run        # sample scenario (no tenant) end to end, write a run record
npm run agent:e2e        # both end-to-end paths: blocked and usable
npm run agent:test       # regression tests for campaign SHAPE
npm run agent:typecheck  # tsc (the root build only covers src/)
```

Both use `vitest`, which is already a devDependency — **no new dependencies
were added.** (Plain `node file.ts` can't be used: Node 24 strips types but
won't resolve the app's extensionless imports. Vitest reuses the app's own
module resolution.)

## What is reused vs. what is new

Reused from the application, never reimplemented:

| Concern | Function | File |
|---|---|---|
| Build nodes + wiring rules | `dcConfirmAddNode` | `src/reducer/campaignReducer.ts` |
| Per-node required fields | `dcAddFormValid` | `src/reducer/defaultConfig.ts` |
| Submit gate | `dcGraphHasOpenBranches` | `src/reducer/graphOps.ts` |
| Starting config per type | `dcDefaultConfig` | `src/reducer/defaultConfig.ts` |
| Node taxonomy, routing/fan-out | `DC_NODE_META`, `dcCanFanOut` | `src/data/nodeMeta.ts` |
| Vocabulary | `ELIGIBILITY_META`, `COMMS_TEMPLATES`, … | `src/data/sharedConstants.ts` |

The graph is built by calling `dcConfirmAddNode`, so the app's own wiring
applies — auto Goal Checks after Send/Wait, Yes → Goal Reached, the Wait for
Event outcome split. None of that is hand-assembled here.

## Files

- `schema/generateSchema.ts` — generates the artefact **from app source**. Validation *logic* is deliberately not serialised; the agent calls the real functions instead.
- `schema/campaign-schema.json` — generated. Do not edit by hand.
- `context/bank-context.json` — one **fictional** bank (Meridian). Every invented value is labelled `INVENTED`; the few real-sourced ones carry `sourcedFrom`.
- `context/principles.json` — 11 principles, each with a real source reference and a classification (`verified` / `observation` / `hypothesis`). No evidence was invented; judgement calls are classified `hypothesis` and say so.
- `scenarios/auth-txn-to-emi.json` — one scenario with pre-written answers, including **two deliberately unanswered** questions.
- `planner.ts` — deterministic planner (stands in for the agent). Records every decision with its basis, and declares any intentional fan-out in `routingIntent`.
- `planner.regression.task.ts` — asserts campaign **shape**, not schema validity. Verified to fail against the original defect.
- `templateSelect.ts` — scores template **content** (name + real copy) against the step's objective and journey stage. Never invents an id: with no suitable match it returns a proposal.
- `templateSelect.regression.task.ts` — verified to fail against the original first-match-by-channel behaviour.
- `channelAvailability.ts` — verifies the generated graph's Send channels (primary **and** fallback) against the issuer's available list.
- `channelAvailability.regression.task.ts` — verified to fail against planner-filtering-only (all 15 tests).
- `campaignFields.ts` — parses the `DripCampaign` field list from `src/data/graphTypes.ts`, and builds the proposed configuration plus its provenance.
- `campaignFields.regression.task.ts` — campaign config, provenance and drift. 25 tests.
- `hardConstraints.ts` — the registry: every known hard constraint, declared, starting at `not-run`. The outcome is derived from this, not from whichever checks ran.
- `hardConstraints.regression.task.ts` — verified to fail against the implicit-list behaviour (5 of its 15 tests).
- `graphPaths.ts` — `maxSendsOnAnyPath`: most Sends one customer can receive. Shared by the validator and the planner's trace note so they cannot disagree.
- `quietHours.ts` — design-time assessment of configured send times against an issuer-supplied window. `undetermined` is a first-class result.
- `quietHours.regression.task.ts` — verified to fail against both the stale-`absTime` false pass and the old two-value outcome (6 tests each).
- `validate.ts` — thin wrapper; each check names the app function that executed it, and unverifiable checks are listed explicitly.
- `bankConstraints.regression.task.ts` — message-cap enforcement. Verified to fail against the warn-only behaviour (6 of its 10 tests).
- `runScenario.ts` — the pipeline (drift gate → plan → proposal → validate → record). Shared, so the end-to-end tests exercise the same code `agent:run` does rather than a copy of it.
- `fixtures/synthetic-tenant-context.json` — **synthetic test data**, labelled `SYNTHETIC_TEST_FIXTURE`. Exists only so the usable path has end-to-end coverage. Claims no verified tenant-to-issuer mapping.
- `endToEnd.regression.task.ts` — both paths, 18 tests.
- `runs/` — one JSON record per run, plus `latest.json`.

## Honest status

The current scenario's outcome is **`incomplete`**: nothing failed, but **three
of the six** known hard constraints are unverified, and an unverified hard
constraint is not reported as a pass. Only the message cap and channel
availability are actually verified, and several campaign-level fields are
unresolved. Even at best the output would be
**pre-validated, not import-ready**: the application has no JSON import path,
so no run can prove the campaign would be accepted by it. Checks that pass are
design-time only and do not guarantee runtime enforcement.

Checks that run: schema freshness, per-node config (`dcAddFormValid`), submit
gate (`dcGraphHasOpenBranches`), **fan-out intent** (`dcIsRoutingNode` /
`dcCanFanOut` + the planner's declared `routingIntent`), referential integrity,
and the **bank message cap** — the one bank hard constraint that fails a run.

### Template selection

Scored on content, not channel alone. A template carrying an off-topic signal
(card activation, PIN setup, festive marketing) is **disqualified**, not merely
ranked lower, and an objective match is required — a stage-word coincidence is
not enough. Suitability may override the bank's cheapest-channel preference,
because the wrong message on a cheaper channel is not a saving; when it does,
the recorded reason names the skipped channel and why.

Where a template is objective-correct but not stage-specific (an offer template
reused as a reminder), it is used but flagged `weakStageFit`, naming a better
alternative if one exists on another channel. The selector does not switch
channel for stage fit on its own — that would override a stated bank preference.

With nothing suitable anywhere, `selectTemplate` returns a **proposal**
(messaging direction, sample copy, CTA, personalisation fields drawn from
tokens existing templates really use) and `templateId: null`. The planner then
throws `TemplateGapError` rather than emit a Send with a misleading reference,
since `dcAddFormValid` requires a real template id.

### Campaign-level configuration and provenance

The output is a **proposed campaign configuration**, not just a graph. The
payload stays a plain `DripCampaign` (`src/data/graphTypes.ts`) — no wrapper,
no renaming, no extra keys. What's new is that the campaign-level fields are
no longer literals in `run.task.ts`: each has a recorded basis in
`campaignFieldProvenance`, a **sibling** of `campaign` in the run record and
never inside it.

Seven bases: `user-answer` · `platform-context` · `application-default` ·
`supported-recommendation` · `prototype-default` (a deliberate starting value,
not evidence and not the app's default) · `provisional` (a temporary
identifier) · `unresolved`.

The principle throughout: **a field nobody decided is omitted, not defaulted.**

| Field | Basis | Note |
|---|---|---|
| `issuer` | **unresolved → BLOCKS** | Tenant context is **mandatory**. The app models no `tenant` field (zero occurrences in `src/`), so tenant identity and `issuer` stay distinct and the *platform* asserts the mapping — never derived here. With no tenant, or one whose issuer the app doesn't know, **no campaign is emitted at all** (`campaign: null`) rather than one with an empty required field |
| `id` | **provisional** | A temporary agent-namespaced identifier, not a value the Drip Campaign system issued or persisted |
| `applyToAllPrograms` | **prototype-default** | `true` — a deliberate starting scope the user can change before going live. Not evidence, and not the app's own default (which is `false`) |
| `programs` | **prototype-default** | `[]`, because the model ignores `programs` when the flag is true. **No fabricated program list** |
| `controlPct` | application-default | `10`, from `DripBuilder.tsx:91` `?? 10`. Deliberately *not* the INVENTED bank preference that holds the same number by coincidence |
| `goal` | user-answer | `simulatedAnswers.goal_event` |
| `guardrails` (DNC/NPA) | **unresolved, omitted** | User choices owned by `GuardrailsStep.tsx`. Both default `true` in the UI, but a UI default is not a confirmed choice |
| `allowReEntry` + cool-off | **unresolved, omitted** | Same reasoning. No cool-off is invented |
| `startDate` / `endDate` | **unresolved, omitted** | No objective window, no lead time, and the only calendar is tagged `INVENTED` |

**DNC/NPA were removed from the hard-constraint registry.** Classifying them
as issuer-level constraints read from `bank-context` was a mistake: the app
models them as campaign-level user choices. They are campaign configuration
now, which dropped known hard constraints from 8 to 6.

When tenant context is missing the proposal is a **discriminated union's
blocked branch** — `usable: false`, `campaign: null`, with `blockers`. The run
still completes and reports the missing input; that is deliberately distinct
from having produced a valid configuration. The outcome is `failed` via
`campaign-config`, which is **structural** — `unverifiedHardConstraints` is
untouched, because a missing platform input is not an issuer-level
hard-constraint violation.

`campaign-config` is a **structural** check. It fails on a confirmed model
violation (unknown field, unknown issuer, all-programs combined with a program
list, out-of-range `controlPct`, a field recorded omitted but populated, a
missing provenance entry). An **unresolved** field never fails and never
enters `unverifiedHardConstraints` — a campaign with no dates is legal in the
app today. Whether 10% is the right control group is a quality question, not
validation.

### Two end-to-end scenarios

Tenant context is mandatory, so the production-like sample scenario — which
has none, because there is no platform integration — is expected to come back
**blocked**. That is the honest result, but on its own it left the usable path
untested. Hence two scenarios, independently runnable and deliberately kept
apart:

| | Tenant | Campaign payload | `campaign-config` | Outcome |
|---|---|---|---|---|
| `scenarios/auth-txn-to-emi.json` | none | **none** (`null`) | **fail** | `failed` |
| same + `fixtures/synthetic-tenant-context.json` | synthetic | emitted, issuer `IndusInd Bank (IBL)` | **pass** | `incomplete` |

Unverified hard constraints are **identical** in both (`message-spacing`,
`quiet-hours`, `event-freeze`), and a test asserts that equality directly — a
missing platform input changes the campaign configuration and nothing about
hard-constraint handling.

The synthetic fixture is a separate file, never folded into the sample
scenario, so the default run can never look production-ready. A test asserts
the sample scenario file contains no tenant data at all. The fixture uses a
real application issuer purely so the mapping is not rejected as unknown —
**that does not make the tenant-to-issuer mapping verified.** No production
mapping exists.

### The hard-constraint registry

Every known hard constraint is **declared** in `hardConstraints.ts` and appears
in every run record, including the ones with no check implemented yet.

Before this, the set of constraints the validator knew about was *implicit* —
whichever checks happened to push an entry. A constraint with no check produced
no record, and a missing record was indistinguishable from a pass. The audit
proved the cost: a campaign sending on **RCS, which the context marks
`available: false`**, came back `PRE-VALIDATED` with five applicable hard
constraints never represented at all.

The registry inverts the default. Everything starts at `not-run`; a check can
only improve on that.

| Status | Meaning |
|---|---|
| `pass` | Verified against the campaign, and compliant |
| `fail` | A violation was confirmed |
| `not-run` | **Applies**, but could not be evaluated — keeps the outcome at `incomplete` |
| `not-applicable` | Does not apply, with a stated reason. **Not a pass** — nothing was verified |

Outcome is derived from the registry, not from whichever entries exist:

1. any confirmed violation → `failed`
2. otherwise any *applicable* constraint at `not-run` → `incomplete`
3. `pre-validated` only when every applicable constraint passed

Current state of the six, on the live scenario:

| Constraint | Status | Why |
|---|---|---|
| `channel-availability` | **pass** | Verified against the generated graph |
| `message-cap` | **pass** | Verified per customer path |
| `quiet-hours` | `not-run` | Both Sends are relatively timed |
| `message-spacing` | `not-run` | Holds by construction only (the planner inserts the Pause) |
| `event-freeze` | `not-run` | Calendar unread, and the campaign has no `startDate`/`endDate` to compare |
| `maker-checker` | `not-applicable` | Real mechanism keyed to real issuers; Meridian is fictional. Must be re-classified for a real issuer |

**The run reports `INCOMPLETE` with three unverified constraints.** DNC and NPA
left this registry entirely — see the campaign-configuration section.

The bundled `bank-constraint-enforcement` prose entry is gone — it packed four
distinct constraints into one unmarked string, which is how they stayed
invisible. Cost ceilings are deliberately *not* in the registry: no such limit
exists in the context, so there is no hard constraint to track.

### Channel availability — checked against the graph, not the planner

The planner already filtered unavailable channels when *choosing* one, but
that is construction-time only: the guarantee rested entirely on the planner
being correct, and the audit's probe proved a hand-built RCS campaign passed
as `PRE-VALIDATED`. This check inspects the artefact instead.

**Both channels on a Send are examined.** Channel Failover was folded into
`SEND` as an optional `fallbackChannel`, and the fallback is a real delivery
route — it is what actually delivers when the primary fails. A check reading
only `channel` would miss an unavailable fallback. An empty string means *no
fallback configured*, which is the app's own convention (`dcAddFormValid`:
`if (!p.fallbackChannel) return true`), so it is not counted as a bad channel.

Four verdicts per channel use, and only the first is a pass:

| Verdict | Meaning | Result |
|---|---|---|
| `available` | Listed by the issuer, marked available | pass |
| `unavailable` | Listed, marked `available: false` | **fail** |
| `not-listed` | A real app channel the issuer's list omits — not *known* to be available | **fail** |
| `unrecognised` | Not a channel the application recognises at all | **fail** |

`not-listed` fails rather than passes deliberately: defaulting an unlisted
channel to available is the silent-pass failure mode this whole sequence of
work exists to remove.

If the issuer's `channels.available` list is missing, empty, not a list, or
has an entry with no readable name or a non-boolean flag, the check records
`not-run` with the specific problem — never a pass, and never a fail either,
since nothing could be determined. The parameter is typed `unknown` so the
shape is validated at runtime rather than asserted away.

### Bank message cap — the one enforced hard constraint

`maxMessagesPerCustomerPerCampaign` is the first bank hard constraint that
actually **fails a run** rather than being reported. Before this, the planner
wrote a trace note ("Send count 2 exceeds the bank cap 1") and the outcome was
still `pre-validated` — a declared violation with a passing verdict. A
statement in the trace is not compliance.

Measured **per customer**, not per graph: `maxSendsOnAnyPath` (`graphPaths.ts`)
takes the most Sends on any single root-to-terminal path. A global Send-node
count is the wrong number on any branching campaign, because a customer takes
one arm of a routing node, not all of them — counting globally would raise a
false violation on a 3-Send Condition split where nobody receives more than 2.
The planner's trace note reads the same helper, so the note and the verdict
cannot disagree.

The cap is passed to `validateCampaignGraph` as a narrow `EnforceableBankCaps`
argument, not the whole `BankContext` — a wider parameter would imply coverage
that does not exist. With no cap supplied the check is recorded `not-run`,
never assumed satisfied.

**Known limitation — fan-out undercounts.** Longest-path is correct for
routing, wrong for fan-out: everyone traverses every parallel path, so two
parallel Sends mean two messages, which this measure reads as one. No current
scenario fans out, and the regression suite asserts the undercount explicitly
so it reads as a known limit rather than as correct. A summed measure for
`dcCanFanOut` nodes is the fix.

**Still not handled**, and listed in every run record: event freezes (calendar
unread, and the campaign carries no `startDate`/`endDate` to compare), risk
appetite (unread), and minimum message spacing (holds only because the planner
inserts the Pause — never verified against the graph). Quiet hours now has its
own check — see below.

### Quiet hours — design-time only, and a third outcome

**Ownership first.** The agent does not own a quiet-hours policy and never
defines one. The window is **issuer-level configuration owned by the Drip
Campaign system**; the validator reads a window it is handed. The prototype's
`21:00–09:00` is **INVENTED mock data** kept only to exercise the code — not a
verified issuer policy. Quiet hours do exist as a real implemented guardrail in
the nudges platform's Frequency Limits step (P-004); those *values* do not.

**Design-time validation is not runtime enforcement.** A pass means the
campaign's *configured* send times do not violate the window as designed.
Honouring quiet hours at send time is the Drip Campaign runtime's job, and the
application holds no quiet-hours field today. Every passing detail says so.

What can be determined, from the app's own timing model:

| Send timing | Stored as | Determinable? |
|---|---|---|
| `Absolute` | `absTime` — an `<input type="time">`, a time of day, no date | **Yes** → pass / fail |
| `Relative` | "Delay after previous step": a delay from an anchor event | **No** → `not-run` |

The window is half-open `[from, to)`: with `21:00–09:00`, 21:00 is quiet and
09:00 is not. Midnight wrap-around is handled explicitly.

**The trap this had to avoid:** `dcDefaultConfig` ships `absTime: '11:00'` on
*every* Send, so a relative send still carries a stale, unused `11:00` — which
is outside quiet hours. Reading `absTime` without gating on `timing` would have
produced a confident false **pass** on the exact campaign this prototype
generates. The check gates on `timing`, and a test asserts the stale value is
ignored.

#### `outcome: 'incomplete'` — a design decision worth reviewing

Quiet hours is a **hard** constraint that is **unverifiable** for the current
campaign (both Sends are relatively timed). Under the old two-value outcome the
run returned `pre-validated`, which reads as "complies" when the truth is "we
could not tell" — the same defect as the message-cap trace note, one layer up.

So `ValidationReport.outcome` now has three states:

- `failed` — a check found a real violation. Always outranks an unknown.
- `incomplete` — nothing failed, but a hard constraint could not be verified.
- `pre-validated` — everything that ran passed, and no hard constraint was left
  unverified.

`CheckResult.hardConstraint` marks which checks count, and
`unverifiedHardConstraints` lists the ones that were skipped. **The current
scenario now returns `incomplete`, not `pre-validated`** — asserted explicitly
in `run.task.ts` so it is a stated expectation, not drift.

**The earlier under-reporting is fixed.** `incomplete` used to cover the
message cap and quiet hours only, because the other constraints had no
individual records. They are now registry entries — see the registry section
above.

**Not built, on purpose:** `ENTRY_SEGMENT` carries `timeOfDay` when `repeat` is
true, so an audience-entry campaign's entry time *is* known, and a relative
send could in principle be resolved by propagating it through the chain's
Pause durations. That is scheduling work, out of scope for this step. The
current scenario uses `ENTRY_EVENT` (a transaction authorisation), which has no
knowable time at all.

### Chain building

`nextInChain()` appends to the single open slot (`to: null`) if there is one,
else the single childless leaf. It **throws** when the continuation is absent
or ambiguous. There is deliberately no fallback to the root: the earlier
`?? graph.rootId` silently attached a reminder to the entry node as a parallel
path, which both app validators accepted. Intentional fan-out goes through
`fanOutFrom()`, which records it so the validator can tell it apart from an
accident.

Checks that cannot run, recorded in every run record: app import acceptance,
bank-constraint enforcement (the app holds no cost/quiet-hours/frequency
fields at all), campaign quality, maker-checker routing (the real function is
keyed to real issuers; Meridian is fictional).

Schema drift is a hard gate, and it now covers the `DripCampaign` field list
as well as the graph vocabulary.

Two real defects in the gate were found and fixed while extending it, both
masked by each other:

1. `stableHash` called `JSON.stringify(value, Object.keys(value).sort())`. An
   array second argument is an **allowlist replacer applied recursively**, so
   only top-level key names survived and every nested value was stripped. The
   hash was near-constant: it would catch a corrupted committed hash (all the
   original verification actually proved) but **not a real change to the app's
   definitions**.
2. `dcDefaultConfig` mints branch ids from a global counter, so the artefact
   was never byte-comparable run to run. Generated ids are now normalised out
   — a branch id is instance identity, not schema.

Verified properly this time: the hash is identical across three consecutive
generations, and adding a field to `DripCampaign` makes the run fail with
`Schema drift: committed artefact hash … != generated …`.
