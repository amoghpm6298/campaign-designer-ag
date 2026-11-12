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
    the app), brief, each bucket's behaviour / thesis / evidence / metric,
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

## Rules worth keeping

- Campaigns are communication only. Ask whether an incentive already exists;
  never invent one.
- The model never emits node ids, edge ids, field names or template ids. It
  writes the recipe; `buildFromBlueprint` builds and validates the graph.
- Never invent conversion rates, lifts, cutoffs or rupee figures.
- Repair a failing build; never simplify a journey just to pass it.
- Bank templates live with the bank: sends keep a blank template plus proposed
  copy until real ids are supplied.

## Tests

`tests/unit/agent.test.ts` (state, tools, compile, warehouse, prompt, skips),
`tests/unit/canvasModel.test.ts` (canvas layout and change diff),
`tests/unit/campaignFiles.test.ts` (the two stores, migration, context rules, each tool on its own store, write-through), and
`npm run agent:test` (validators and hard constraints).
