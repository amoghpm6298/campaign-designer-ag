# Campaign Designer — the agent

One agent, one prompt, every tool. It takes a campaign manager from a business
goal to one built campaign with a journey per behavioural bucket, in one
conversation. Design doc: `docs/v3-design.md`.

## Shape

| File | What it holds |
|---|---|
| `agent/prompt.ts` | The single fixed system prompt (core + warehouse ON/OFF module) and the per-turn APP STATUS block |
| `agent/tools.ts` | The toolkit. Every tool is offered every round; none is refused because of where the conversation is. Campaign tools: `get_campaign`, `edit_campaign`, `edit_bucket`, `edit_journey`, `build_campaign`. Context tools: `get_context`, `add_context` |
| `campaignFiles.ts` | The two stores on disk, per chat: `data/campaigns/<sessionId>/campaign.json` (what executes) and `context.json` (what supports it). Atomic writes; migrates the old single file |
| `src/designer/v2/contextView.ts` | Reading the context (latest entry per kind + bucket + topic, history, per-bucket view). Shared by server and browser |
| `agent/state.ts` | Pure state transitions: plan file (brief, campaign shell, buckets), flags, timeline, questions, skips, journey edits |
| `agent/compile.ts` | Plan file → blueprint: the bucket chain (first match wins), holdouts, everyone-else tail, open membership |
| `agent/loop.ts` | The streaming agent loop behind `POST /api/agent/stream`. Loads both stores at the start of a turn, files the manager's answers in the context, and writes whichever store changed through after every tool call; emits `state.updated` so the canvas fills in live |
| `agent/journeySchema.ts` | The journey recipe schema the agent writes |
| `blueprint.ts` | `buildFromBlueprint`: compiles the recipe through the builder's own reducer (`dcConfirmAddNode`) |
| `warehouse.ts` | Read-only SQLite warehouse per tenant (`WAREHOUSE_DIR`), SELECT/WITH only, 200-row cap |
| `anthropic.ts` | The only place the API key is read; streaming client |
| `apiPlugin.ts` | The API, as a Vite dev-server plugin; `passwordGate.ts` gates the hosted copy |

Client: `src/designer/v2/` — canvas first. `CampaignCanvas` + `canvasModel`
(plan file → bucket columns, React Flow, minimap), `canvasNodes` (the builder's
card style), `QuestionOverlay` (Skip / Send answers), `ChatPanel` (tool chips,
cue card), `NodeDrawer` (message preview), `DesignerV2` (layout, Activity drawer).

## How a conversation works

- No approvals. Questions (as a canvas overlay) → buckets, journeys and the
  built campaign in one go → changes through chat.
- **One chat is one campaign, in two stores**, keyed by the chat's session id
  (nobody handles a campaign id):
  - the **campaign object** is what the core engine executes and nothing else:
    name, goal, entry, membership, buckets (id, name, priority, rule, holdout,
    journey) and everyone else. `get_campaign`, `edit_campaign`, `edit_bucket`,
    `edit_journey`, `build_campaign`. Only these mark a build stale.
  - the **campaign context** is everything that supports it: answers (filed by
    the app), brief, each bucket's behaviour / rationale (the AI rationale) / evidence / metric,
    sizing, research, notes, later metrics. Append-only: the latest entry per
    kind + bucket + topic is current, and history is kept, so it can keep being
    enriched. `get_context`, `add_context`.
  Every change is saved the moment it is made. The browser keeps only the
  conversation and loads both from `GET /api/campaign?sessionId=`. On the server
  `data/` is protected from the deploy's rsync. Deliberately not in the
  campaign object yet: the window and message cap (context text for now); each
  message's "why" note stays on the step.
- **The canvas draws what the builder builds**: a step after a fork with
  several open paths is drawn once per path, as the builder places it.
- The backend keeps **flags** that all start false
  (goalClear, successClear, membershipClear, questionsAnswered, readyToDesign,
  campaignBuilt) and an append-only **timeline**, carried with the chat. The app
  writes them, plus a short summary of what is on file, into an APP STATUS block
  on the latest user message, so the system prompt never changes between rounds.
  Flags are guidance, not gates.
- **Skip**: skipped (or blank) questions are marked `skipped`; the agent makes
  its best assumption, files it as an assumption and states it in one line.
- **Changes**: a bucket definition change goes through `edit_bucket` (and its
  reasoning through `add_context`) and only
  that bucket's journey is re-thought; a flow change uses `edit_journey` at an
  outline address. The client diffs the plan file before/after the turn and
  highlights exactly the changed steps.
- **Warehouse** is per tenant (`server/tenants.ts`). ON: buckets are explored and
  sized from data. OFF: hypotheses from the answers and the agent's knowledge.
- **Data access for the main agent** (2026-11-20): its own `get_table_schema` +
  `run_sql_query` for exploring (5-10 queries, plus 2-3 "why are they stuck"
  queries per bucket), and `ask_data` for bigger questions: a data analyst
  (`agent/askData.ts`) that returns its ANSWER plus its WORKBOOK (each query's
  purpose, SQL and rows, capped at 20 rows per query / 16k characters), filed as
  research. Tried and reverted the same day: analyst-only access (no SQL for the
  main agent). The agent then asked only ~2 broad questions and stopped testing
  why each bucket is stuck; it explores far more when it can query itself.
  Buckets with SIGNAL rules are sized by code at every build
  (`agent/autoSize.ts`: each signal's SQL, first match wins, do-not-contact and
  NPA left out); other rules are sized by the agent's own sizing SQL or by the
  analyst (`ask_data` with `sizeBucket`).
- **Long turns: compaction, not a low round cap** (2026-11-20, `agent/compaction.ts`,
  modelled on the propensity agent's `services/context_compaction.py`). The context
  only grows WITHIN a turn (between turns the agent restarts from chat text, the
  two stores and the status block), so compaction works mid-turn. Trigger: 75% of
  the model's window (Sonnet 5: 1M, so 750k), or `COMPACT_CUTOFF_TOKENS`. The
  estimate is calibrated every round against the API's real input token count,
  including the fixed system prompt + tools (~35-40k). Tier 1 (code, no AI):
  results older than the last 5 rounds keep 1 row, oldest first, until under the
  cutoff; the turn's opening messages are never touched and a tool call is never
  split from its result. Tier 2: if still over, Sonnet writes one recap of the
  older steps (numbers copied exactly, with their source). Emergency: the API
  refusing the prompt as too long forces both tiers (last 2 rounds kept) and
  retries once. Every `run_sql_query` is filed in the notebook (research, topic
  "query: <purpose>") so shortened rows stay retrievable. Each round's real input
  tokens are kept with the turn's events (`model.completed`); a compaction shows
  in Activity. MAX_ROUNDS is 60, a runaway net only, plus a loop check: the same
  call with the same input a 3rd time (reads exempt), or a rebuild with nothing
  changed, is refused; 3 refusals end the turn. Verified with forced 40k/90k
  cutoffs: turns ran to 44 rounds and finished, with full depth.
- **Insight per bucket, checked twice** (2026-11-20, `agent/insightChecks.ts`).
  The prompt optimises for the campaign's outcome for a sharp, hard-to-move
  Indian audience, and demands honesty (a pattern shared by every group explains
  none of them). Each bucket carries "why stuck" (cites query records WITH ROWS,
  not written notes; without data, basis manager/hypothesis) and "so we" (what
  it changed, naming real steps), shown first on the bucket card. At turn end:
  (1) code checks the notes exist and connect (with a "did you mean" for a
  paraphrased citation); (2) Claude Haiku 5.5 (the one non-Sonnet call, low
  effort, structured output, one retry) grades each bucket against the cited
  rows: backed / non-obvious / follows through; pass is recomputed from those.
  Only buckets whose notes changed are re-graded (re-grading identical text once
  flipped a pass to a fail). Up to 2 send-backs each; after that the failed
  reason shows on the card ("Needs a closer look"). Every check and grade is
  logged to `data/logs/insight-checks.jsonl` (time, tokens, grades) and kept in
  the notebook (topic "insight check"). Measured: a review takes 4-12 s and about
  ₹0.1.
- **Warehouse queries never freeze the server** (2026-11-20). node:sqlite is
  synchronous and can't interrupt a query; one runaway query froze the whole
  server (and ignored a normal stop). SQL the agent or analyst wrote (and bucket
  sizing) runs in its own process (`server/warehouseQuery.mjs`, ~36 ms start-up),
  killed outright at the limit (`WAREHOUSE_QUERY_TIMEOUT_MS`, default 30 s). An
  abandoned worker thread was tried first and kept burning CPU (99% for over an
  hour). Code-built queries (signals, for the cost model) stay in a worker
  thread (`server/warehouseWorker.mjs`): bounded and cached.
- **Two blocks per bucket** (2026-11-23): "rationale" = why this bucket (cited)
  and the bet (worded as a hypothesis); "metric" = what we'll track, by when,
  and what we'd do next. They replace "why stuck / so we" (now gone) and the
  bucket-level "AI rationale" toggle. The card reads top-down: name, size
  (headline, with SQL and Test buttons), one-line who, spend, the two blocks.
  The code check (`insightProblems`) requires both: the rationale cites a real
  query with rows (inline [Q7] or data.queries); the tracking names a next step.
- **A model call that fails on the network, a timeout or an overloaded API is
  retried** (the round, twice, with a pause) instead of ending the turn.
- **Inline sources, checked by code** (2026-11-20, `agent/citations.ts`,
  `src/designer/v2/Citations.tsx`). Every query is filed with a short id (Q1,
  Q2…, never reused). Everything the agent writes cites figures at the end of
  the sentence: [Q7] a query, [M] the manager (brief, messages, answers), [O]
  the offer menu. Code checks every cited number against that source (rounding,
  %, Indian formatting, k/L/crore and simple derivations allowed): a marker to
  nothing or a number not in its source is an error (sent back up to twice, then
  said plainly); a data number with no marker is a warning (logged as
  `citation_check`). Campaign facts (rules, budget, sizes, cost figures, offer
  terms, small counts) are never flagged. On screen each marker is a chip with a
  popover of the rows; texts get a "Sources" footer built from the markers.
  Claims in words (no number) can't be checked by code: that is for the
  whole-campaign review.

- **Smart Engage 2.0: intents and products** (2026-11-23). "Create new
  campaign" asks what it is for: Credit cards (usage, activation, churn,
  something else) and Across the bank (product sign-ups); CASA tiles are shown
  as coming soon. The intent is stored on the campaign on its first turn
  (`campaign.intent`, `productId`; MCP `create_campaign` takes both) and shown
  to the designer every turn as a block in the APP STATUS (`agent/intent.ts`),
  so the fixed prompt doesn't grow. Old campaigns read as "something else".
  **Products** (`server/products.ts`, the NBA agent's offering schema; product
  pages live in Links) are only pitched in a **product sign-ups** campaign: its
  goal is Product Events / Product Signed Up (the bank's feed, treated as
  instant), and every message that pitches it carries `product: <id>` and the
  product's link (`agent/productChecks.ts`). **Cross-selling inside other
  campaigns is off for now**, to be tried separately: a first try showed a
  goal check removes everyone who converted, so a cross-sell "after the goal
  check" can never reach a buyer.

## Signals and incentives (menus by name)

- **Signals** (`server/signals.ts`): named, defined facts about a customer
  (`spend_90d`, `top_category`, `emi_eligible`, …), worked out from the bank's
  warehouse, plus journey signals (`read_last_message`, …). The agent sees them
  with `list_signals` (no SQL) and may use them in bucket rules as
  `{entity: "Signal", conditions: [...]}`. The builder checks every key against
  the bank's menu. Data signals are "proposed": the engine can't supply them yet.
- **Incentives** (`server/incentives.ts`): special offers on top of what the
  customer is already eligible for, each with its cost to the bank, what it
  `requires` (product eligibility set by the bank; a campaign never grants it),
  who it is meant for, dates and exact terms. Offers carry no budget: spend is
  tracked by each campaign against its own cap (`budgetCap`, the budget pass). One file per bank,
  `data/incentives/<tenantId>.json`, managed by ops on the **Offers** page
  (third item in the nav, `src/designer/OffersView.tsx`). Until the first save
  a bank gets the starting menu (standard card offers). Offers can also be
  added by describing them in words (`server/incentiveDraft.ts`): the model
  drafts the fields, the same checks run, and it fixes what it can itself (up
  to 2 rounds) and asks ops for any fact it lacks, until the draft passes; the
  filled form then opens for review. Nothing is saved without that review. Every save goes through `checkIncentive`: the cost fields must suit
  the cost type and the trigger (share of spend needs a spend trigger, an
  interest discount needs EMI), rules must use real signals, dates must make
  sense, and the customer line is at most 160 characters with no
  link. The most an offer can cost per customer and the goals it serves are
  worked out, not typed. Offers are paused, never deleted (campaigns refer to
  them by id); a paused offer drops off the agent's menu at once and existing
  campaigns that use it are flagged by the offer check. `list_incentives`
  (banks with `incentives: true`) lists valid offers cheapest first and, for a
  sized bucket, counts who qualifies.
- **Prompt sections by bank:** core + data ON/OFF + incentives ON/OFF. With a
  menu, the agent asks about speed vs spend (and an optional budget) in its own
  words and files it as brief topic "Spend".
- **Offers in journeys:** a send carries `incentive: <id>` only; the system adds
  the offer's exact `offerLine` after the copy (like a link: `withOfferLine` /
  `assembleSms`). Copy with amounts is flagged.
- **Cost: a step-by-step funnel** (2026-11-23, `server/costModel.ts`). Every
  message carries the designer's `funnel` estimates: `opens` (of those it's
  delivered to; none for SMS) and `converts` (of those who open, or receive for
  SMS: reach the goal; on an offer message, take the offer up), each one best
  estimate `{rate, why}` **for the people who arrive at that step**, given what
  happened before. Delivery is the bank's rate per channel (Knowledge Base ›
  Delivery, `bankSettings.deliveryRates`, typical rates to start). Code walks
  each journey with a running count: delivered × opens × converts; goal checks
  remove converters; branches on the last message split by those counts; signal
  routes by real sizes; tests by percentage; the bank's SMS retry is added for
  undelivered WhatsApp/RCS. An offer's **estimated** cost = those who take it
  up (among those who qualify, once per customer) × the average reward; its
  **max** = everyone who qualifies takes it. Bucket max = its most expensive
  offer path (alternative paths: the larger; signal routes: the sum); campaign
  max = the sum. The build tells the designer the funnel per message (who
  arrives, delivered, opened, converted). `funnelChecks.ts`: every message has
  its estimates. Whether a rate is right is the designer's judgement (a later
  message can convert better: it depends on the message); a keyword check on
  the reason was tried and removed the same day (it passed "urgency" in a
  reason arguing for a lower rate). Replaces reach/redeem and
  the three scenarios. Never stored; data OFF → per 1,000.
- **Checks** (`server/agent/offerChecks.ts`): offer on the menu, valid, fits the
  goal, no amounts in copy, funnel estimates present, enough of the bucket qualifies,
  incentive strategy note + Spend brief, and the BUDGET PASS (as expected over
  `budgetCap` → cut offers, not people). Reported after every build and block
  submit.
- **Routes inside a bucket (signal switches):** a `branch` with `signal: <key>`
  and paths `{label, operator, value, steps}` + a required `otherwise`. Route
  sizes are set arithmetic in code (`customerIds` in `server/warehouse.ts`,
  cached), and offers inside a route are costed on the route. Checks
  (`server/agent/routeChecks.ts`): hidden minimum route size per bank
  (`minRouteSize`, default max(1,000, 5%)), at most 2 deep, 4 routes, an
  everyone-else route.
- **Splits are the main agent's alone** (2026-11-20; the split helpers were
  removed). When it suspects a group needs different treatment, it tests that
  with its own cited queries and splits only if the data backs it (edit_journey
  replace_from, one signal switch); otherwise it says in the bucket's "so we"
  what it tested. Old campaigns may still show split ideas from the helper era.
- **Personal words (dynamic messages):** copy may carry `{{signal_key | "fallback"}}`
  (signals usable in copy, never restricted ones). The engine fills each
  customer's value, formatted by code (`src/designer/v2/personalFields.ts`), or
  the fallback. Checks (`server/agent/fieldChecks.ts`): real signal, allowed in
  copy, fallback present, SMS ≤160 with the longest value. The canvas shows a
  sample value chip; the engine export lists `personalFields`. Wording-only
  differences use this instead of a split.
- **Design vs what runs:** `campaign.json` is the full design (reasoning
  included). At submit, `server/engineExport.ts` keeps only the engine's
  fields and writes a frozen `engine.json`. Problems block submit.

## Rules worth keeping

- Never invent an incentive. Banks with a menu: offers only from
  `list_incentives`. Banks without: ask whether one already exists.
- The model never emits node ids, edge ids, field names or template ids. It
  writes the recipe; `buildFromBlueprint` builds and validates the graph.
- Never state conversion rates, lifts, cutoffs or rupee figures as fact: funnel
  estimates are the designer's judgement, said so, and code works out the rupees.
- Repair a failing build; never simplify a journey just to pass it.
- Bank templates live with the bank: sends keep a blank template plus proposed
  copy until real ids are supplied.

## Tests

`tests/unit/agent.test.ts` (state, tools, compile, warehouse, prompt, skips),
`tests/unit/canvasModel.test.ts` (canvas layout and change diff),
`tests/unit/campaignFiles.test.ts` (the two stores, migration, context rules, each tool on its own store, write-through), and
`npm run agent:test` (validators and hard constraints).
