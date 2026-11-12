# Campaign Designer — the agent

One agent, one prompt, every tool. It takes a campaign manager from a business
goal to a built drip campaign in one conversation.

## Shape

| File | What it holds |
|---|---|
| `agent/prompt.ts` | The single fixed system prompt (Brief → Plan → Build, as guidance) and the per-turn APP STATUS block |
| `agent/tools.ts` | The toolkit. Every tool is offered every round; none is refused because of where the conversation is |
| `agent/state.ts` | Pure state transitions: plan file, progress flags, timeline, questions, sign-offs |
| `agent/loop.ts` | The streaming agent loop behind `POST /api/agent/stream` |
| `agent/journeySchema.ts` | The journey recipe schema the agent writes |
| `blueprint.ts` | `buildFromBlueprint`: compiles the recipe through the builder's own reducer (`dcConfirmAddNode`) |
| `agentTools.ts` | The five platform lookups (events, customer fields, channels, templates, step types) |
| `anthropic.ts` | The only place the API key is read; streaming client |
| `apiPlugin.ts` | The API, as a Vite dev-server plugin; `passwordGate.ts` gates the hosted copy |

Client: `src/designer/v2/` (chat, question form, sign-off bar, inline tool trace,
plan file, flags, timeline).

## How a conversation works

- The backend keeps a **plan file** (brief findings by aspect, strategy,
  journey), **progress flags** that all start false (goalClear, successClear,
  audienceClear, barriersClear, questionsAnswered, briefReady, briefSignedOff,
  planReady, planSignedOff, campaignBuilt) and an append-only **timeline**.
- Every turn the app writes all of it into an APP STATUS block on the latest
  user message, so the system prompt never changes between rounds.
- The agent decides what to do. The prompt says which tools usually fit each
  phase and which flags normally come first, but it may act ahead; when it
  does, the app logs `acted_ahead_of_flags` rather than refusing.
- Who sets what: the agent sets the four clarity flags and the two "ready"
  flags; the manager signs off with a button (or the agent records a chat
  approval with `record_user_acceptance`); the app sets `questionsAnswered`
  and `campaignBuilt`. Editing a signed-off section clears its sign-off.
- Discovery questions are a form: aspect-grouped, one thing per question,
  `single` / `multi` (the UI always adds "Other") or `open` with example
  replies.

## Rules worth keeping

- The model never emits node ids, edge ids, field names or template ids. It
  writes the recipe; `buildFromBlueprint` builds and validates the graph.
- Never invent conversion rates, lifts, cutoffs or rupee figures. With no
  history, the first run establishes the baseline.
- Bank templates live with the bank. With the library unreadable (the default),
  sends keep a blank template plus proposed copy, and export stays blocked
  until real ids are supplied.
- Everyone eligible who has not done the behaviour enters; a pattern changes
  treatment, never entry.

## Tests

`tests/unit/agentV2.test.ts` (state, tools, prompt, UI helpers) and
`npm run agent:test` (validators and hard constraints).
