# Campaign Designer v3 — behavioural buckets, an isolated journey per bucket

Status: design, for review. Builds on v2 (one agent, one prompt, every tool,
plan file + flags + timeline). Owner: Nimit.

## 1. The core method (never changes)

Every campaign is designed the same way:

1. Understand the business goal (Q&A).
2. Split the eligible audience into **behavioural buckets**: mutually
   exclusive groups defined by what customers do (or don't do).
3. For each bucket, work out **why they are stuck** — the thesis.
4. Design an **isolated journey per bucket**: its own lever, messages,
   timing, channel jobs and success metric.
5. Build it as a campaign the platform can run.

Two settings change *how* the agent does this, never *what* it does.

## 2. Setting A — evidence source (per tenant)

`tenant.warehouseAccess: boolean`, set in `server/tenants.ts`.

| | Warehouse ON | Warehouse OFF |
|---|---|---|
| Where buckets come from | SQL exploration of real data | Manager Q&A + agent hypotheses |
| Bucket size | Measured (count from the rule) | Unknown — said so |
| "Why stuck" thesis | Researched with 2–3 queries per bucket, cites numbers | Manager's view or agent hypothesis, labelled as such |
| Q&A | Shorter and pointed: business context only the manager has, plus confirming what the data shows | Carries the whole load: what they have seen, which behaviours matter |
| First run | Executes the plan | Also validates the buckets: each bucket is a test cell |
| Extra tools | `get_table_schema`, `run_sql_query` (read-only, row cap, timeout) | none |

Prompt: ONE prompt. A shared core plus one swapped **evidence module**
(warehouse-on or warehouse-off). The SQL tools are only offered when the
tenant has a warehouse — that is a capability the tenant lacks, not a stage
gate, so it does not break the "every tool, every turn" rule.

Initial data: the IndusInd mock warehouse from propensity-agent
(`backend/data/bank_data/indusind/*.csv`: customers, transactions,
emi_eligibility, dnc/npa/fraud/cooling_off/complaint lists), loaded into a
local read-only SQLite. TEN-IBL → warehouse ON; other tenants OFF.

## 3. Setting B — bucket membership: locked or open (per campaign, from the brief)

| | Locked | Open (refreshing) |
|---|---|---|
| Who is in a bucket | Whoever matches its rule **as of launch** | Launch members, **plus anyone who newly matches** at each refresh |
| New joiners | None | Join on the refresh cadence (daily / weekly) and start that bucket's journey |
| Someone already on a journey | Continues it | Continues it; never entered twice while a journey is running |
| Builder settings | Entry · Audience, single pull | Entry · Audience with repeat cadence; re-entry after finishing off by default |

The agent **asks or infers** this during the brief ("a Diwali push for today's
eligible base" → locked; "anyone who becomes EMI-eligible should get this" →
open) and states its inference so the manager can correct it. It is a
campaign-level setting: every bucket in the campaign is locked, or every
bucket is open.

## 4. A bucket (same shape in both evidence modes)

```
{
  id, name,                      // "Electronics spenders, no EMI yet"
  behaviour,                     // plain-language definition
  rule,                          // builder conditions (entities, attributes, lookback/absence)
  evidence: 'measured' | 'manager' | 'hypothesis',
  size?,                         // warehouse ON only
  evidenceNotes,                 // the numbers / quotes behind it
  thesis,                        // why they are stuck → the lever
  metric,                        // what success means for this bucket
  holdoutPct?,                   // per-bucket holdout so each journey is measurable
  journey: BpStep[]              // the existing building blocks
}
```

Rules across all buckets:
- Mutually exclusive by **priority order** (first match wins). A final
  "Everyone else" bucket is explicit: its own journey, or deliberately none.
- One shared goal; the goal check after every send exits converters.
- Compliance (DNC, NPA, fraud, cooling-off) applies to all.
- A per-customer message cap across buckets (one journey at a time makes this
  hold by construction).

## 5. How it compiles: one campaign, one path per bucket

```
Entry · Audience  (everyone eligible, not yet at goal; repeat cadence if buckets are open)
  └─ Bucket 1 rule?  ──yes──▶ Bucket 1 journey ──▶ exit
        └─no─▶ Bucket 2 rule? ──yes──▶ Bucket 2 journey ──▶ exit
                └─no─▶ … ──▶ Everyone else journey (or exit)
```

A cascade of conditions gives first-match-wins, which is what makes buckets
mutually exclusive inside one campaign. The agent never writes the cascade:
it writes `buckets[]`, and the compiler (`buildFromBlueprint`) generates it.

**Builder gap (must close first).** Inside a journey, a Condition can only
check Account attributes, transaction history, milestones or the previous
message's outcome. Bucket rules routinely need Customer and Card attributes,
and several of them ANDed. Entry · Audience already supports exactly that
(`EntityConditionBlock`, multi-entity groups, transaction lookback/absence).

Fix: add a Condition source **"Audience rule"** that reuses Entry · Audience's
`EntityConditionBlock` (same data shape, same validation, same UI). This is
also a requirement for the real platform, and is reported as such.

Rule expressibility: a bucket found by SQL may rest on an aggregate the
builder cannot evaluate ("dominant category is electronics", "average
ticket ≥ ₹10K"). The agent then (a) uses the nearest expressible rule and
says what it trades away, or (b) names the **Smart Tag** the bank would need
(e.g. `electronics_heavy`, produced by a propensity labelling agent) — the
builder already has a Smart Tag attribute type.

## 6. Incentives: communication only, for now

The platform has no module for creating or attaching incentives (cashback,
fee waivers, discounts, rewards) yet. During the brief the agent asks whether
an incentive is **already available** for these customers ("No incentive
available" is always an option). If one is, messages may announce it in
exactly the manager's terms. If not, the campaign persuades through
communication alone: awareness, clarity, timing, and reminding customers of
value they already have (card benefits, EMI availability, rewards earned).
The agent never invents or promises an incentive, amount or term.

## 6a. How the plan is made

The plan has two layers: a thin shared shell and an isolated plan per bucket.

**Campaign level (shared, written once)**
- Goal event — the one thing that counts as success; it exits anyone who reaches it.
- Entry — everyone eligible who has not reached the goal; locked or open membership.
- Segmentation logic — why these buckets, their priority order (first match
  wins), and what "everyone else" gets.
- Guardrails for all buckets — compliance, quiet hours, message cap.
- Measurement — a holdout inside every bucket so each journey's effect is
  readable on its own, plus the overall result.

v2's campaign-level "strategy" becomes the segmentation logic; the rest of
the strategy moves down into each bucket.

**Per bucket (isolated), driven by its thesis**
- Lever — what moves this group (awareness, cost reassurance, a reminder of value they already have, a habit cue, or an incentive the bank already has available).
- Journey — the first message attacks the lever; a reaction point only where
  read vs unread changes the next message; ends with an exit or a long-gap
  keepalive.
- Timing, channel and copy specific to the bucket, with a rationale on every
  message citing that bucket's evidence.
- Success metric for the bucket.
- A test inside the bucket only where its thesis is uncertain (e.g. a
  hypothesis bucket tests two levers).

**Evidence changes the inputs**
- Warehouse ON: timing from the bucket's own behaviour (e.g. median gap
  between transactions), channel from its opt-in rates, which existing benefit to stress
  from its top spend categories.
- Warehouse OFF: the same choices stated as assumptions; where one matters,
  the plan tests it instead of guessing.

**Working order**
1. Write the campaign shell.
2. Draft every bucket's journey in one pass.
3. Build the campaign straight away. There are no approvals: the manager
   changes things afterwards through the chat (§7), one bucket or one step at
   a time, and nothing else is reopened.

**Compiles to** the bucket chain in §5. A per-bucket holdout is an experiment
split at the head of the bucket's path with a "no messages" arm.

## 7. The conversation, end to end

No approvals and no stages the manager has to track.

1. **Questions**, as an overlay on the canvas, in rounds: goal, success, any
   incentive already available, window, guardrails, locked vs open buckets
   (asked or inferred), what they have seen. **Skip** (or leaving a question
   blank) tells the agent to make its best assumption, file it as an
   assumption, and say it in one line so the manager can correct it.
2. **Design and build, in one go.** Buckets (warehouse ON: explored and sized
   from data; OFF: hypotheses from the answers and the agent's own knowledge),
   one isolated journey per bucket, then one built campaign. The canvas fills
   in live as each bucket and journey lands.
3. **Changes through chat.** Either a bucket definition (`upsert_bucket`, and
   only that bucket's journey is re-thought) or a surgical flow edit
   (`edit_journey` at an outline address). Rebuild, say exactly what changed;
   the canvas highlights the changed steps and "Show me" jumps to them.

Flags (all start false): `goalClear`, `successClear`, `membershipClear`,
`questionsAnswered` (app), `readyToDesign`, `campaignBuilt` (app).

## 8. Work, in order

1. Builder: "Audience rule" Condition source (reuse `EntityConditionBlock`), with tests.
2. Recipe + compiler: `membership` (locked / open + refresh cadence) and
   `buckets[]` → entry settings + condition cascade + per-bucket journeys.
3. Tenant setting `warehouseAccess`; IndusInd mock warehouse loaded read-only;
   `get_table_schema` / `run_sql_query` tools with row cap and timeout; bucket
   sizes counted from the rule.
4. Prompt: shared core + evidence modules; bucket and per-bucket journey guidance.
5. Plan file: buckets section; flags; timeline entries.
6. UI, canvas first: the campaign as bucket columns in the builder's node
   style (pan, zoom, minimap), questions as a canvas overlay with Skip, chat
   on the right with a cue card, message preview drawer, timeline behind
   "Activity".
7. Verify live on both a warehouse-ON (IBL) and a warehouse-OFF tenant.
