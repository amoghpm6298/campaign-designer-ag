# Agentic Drip Campaign Designer — prototype

An AI campaign designer built on top of the existing Drip Campaign
application. You describe a business objective in chat; the agent asks what it
genuinely needs, proposes a strategy, and the campaign is built with the
application's **own** graph logic and rendered on its **own** canvas.

## Run it

The Campaign Designer is a **standalone application**. It does not load
`ib-face-mock.html` and has no Communication Hub.

```bash
cd drip-campaigns
npm install
cp .env.example .env              # then put your real key in .env
npm run dev:designer              # http://localhost:5174/designer.html
```

| | Campaign Designer (standalone) | ib-face-mock app |
|---|---|---|
| entry point | `designer.html` → `src/designer-app/main.tsx` | `index.html` → `src/main.tsx` |
| config | `vite.designer.config.ts` | `vite.config.ts` |
| dev | `npm run dev:designer` (:5174) | `npm run dev` (:5173) |
| build | `npm run build:designer` → `dist-designer/` | `npm run build` → `dist/` |

Both share the campaign model, reducers, canvas and validators from `src/`
and `agent-proto/` — nothing is duplicated.

### Environment

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Read **server-side only**. Never bundled into browser code, never logged. |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-5`. Must be a **Sonnet** id; anything else is rejected at startup. |

`.env` is git-ignored. With no key the Designer shows a configuration error —
it does **not** fall back to a mock agent or another provider.

Verify the model is really available to your key: **Knowledge Base → "Verify
model against Anthropic API"**, which calls the live `/v1/models` endpoint.

> The API runs inside the Vite dev server (`server/apiPlugin.ts`), because this
> repo is otherwise a static SPA with no backend. `npm run dev` is the
> supported way to run it. `vite preview` serves the built bundle without a
> module runner, so `/api/*` returns 501 there with a message saying so.

## What it does

| Stage | Where |
|---|---|
| A — understand the objective | chat → `server/orchestrator.ts` |
| B — retrieve context | `server/knowledge.ts` (curated JSON + authoritative app source) |
| C — discovery & strategy | one Claude Sonnet call, max 3 questions/round, 8 rounds |
| D — build the campaign | `server/blueprint.ts` → the app's own `dcConfirmAddNode` |
| E — validate & display | `agent-proto/validate.ts` → the app's own `DripCanvas` |
| F — refine via chat | same orchestrator, full blueprint re-proposed |
| G — copy / download JSON | gated on deterministic validation |

### The model/code boundary

The LLM does business reasoning only. It returns a **blueprint** — intent in a
small closed vocabulary — and never node ids, edge ids, field names or
template ids. `buildFromBlueprint` rejects anything outside the real
vocabulary (invented event types, unknown attributes, arms that don't sum to
100) rather than coercing it, then the application's own reducer builds the
graph and its own validators check it. Templates are chosen by **objective**
and resolved against real `COMMS_TEMPLATES`; if nothing fits, the run reports
a template gap instead of inventing an id.

## Knowledge Base — documents

Upload documents the agent should use as context (brand voice, campaign
learnings, product rules). Scope each one to **all tenants** or **the selected
tenant**; tenant-scoped documents are only ever sent for that tenant.

**What genuinely works:** `.md`, `.txt`, `.csv`, `.json` up to ~390 KB. The
text is extracted in the browser, stored in `localStorage`, sent with the next
agent run and rendered into the prompt — so the agent really does read it, and
the run log records which documents were used.

**What does not:** PDF and Word parsing is **not implemented**. Those files are
refused at selection with a message saying so, rather than accepted and
silently ignored. A document is only marked *Available to agent* once its text
was actually read.

The platform capabilities and sample bank context still feed the agent. They
are reference material rather than per-field settings, so they sit behind
*"What else the agent knows"*.

## Tenant selection

A global dropdown in the Designer's own header, available on every view and
persisted across reloads. **Every tenant is synthetic and labelled so.**

Only a `tenantId` crosses the wire; the server resolves the configuration from
its own registry (`server/tenants.ts`), so a browser cannot supply another
tenant's settings. An unknown id is refused rather than defaulted. Channels and
template-library access are scoped per tenant. Switching tenants does not
reinterpret an open session — a banner says which tenant it was designed for
and offers to start a new one.

This is application context, **not authorization**. There is no real tenant
integration.

## Missing templates — how it works

Bank communication templates live in the **bank's** ecosystem. Hyperface does
not mirror them, so the default for a tenant is `templateLibraryAccess:
'unavailable'`: we cannot see the catalogue at all.

When the agent cannot complete a Send:

1. The campaign is still designed, and the communication step **stays in the
   journey** — it is not dropped over a field only the bank holds.
2. **Channel** and **timing** are recommended, because the agent can judge those.
3. `account` and `templateId` are left at `''` — the **application's own unset
   value** from `dcDefaultConfig`, never an invented id.
4. The agent writes the **messaging direction, sample copy, CTA and
   personalisation tokens**, clearly labelled as a proposal and *not* a
   bank-registered template.
5. The app's own `dcAddFormValid` marks those Sends invalid, `node-config`
   fails, and **export is blocked**. No validator was weakened.
6. The user types the real account and template id in the chat panel and hits
   **Apply and revalidate**; the campaign is rebuilt with those values and
   re-checked.

Three states are kept distinct, because claiming a bank has no template when
we simply cannot see their library would be false:

| Reason | Meaning |
|---|---|
| `template-library-unavailable` | Catalogue not reachable. We cannot confirm or deny. |
| `no-suitable-template` | An accessible library **was** searched and nothing fit. |
| `awaiting-user-input` | Partially supplied; waiting on the rest. |

The seeded sample library is still available under the explicit
`TEN-DEMO` tenant, labelled *"synthetic demo library — not a real bank
catalogue"* in every decision it produces.

## Honest limits

- **Not import-ready.** The application has no JSON import path, so nothing is
  saved, imported or activated, and schema validity does **not** guarantee
  import acceptance. Every export says so.
- **Most curated context is synthetic.** Costs, caps, quiet hours and the
  events calendar come from `agent-proto/context/bank-context.json` and are
  labelled `invented`. They are not real bank policies.
- **No performance data exists**, so the agent is instructed never to claim a
  conversion lift or cost saving.
- **Tenant context is synthetic.** The registry in `server/tenants.ts` is
  invented, and tenant selection is not authorization.
- Three bank hard constraints (message spacing, quiet hours, event freeze)
  remain unverified by the validator and are reported as such.

## Commands

```bash
npm run dev:designer      # the standalone Campaign Designer (API included)
npm run build:designer    # its production build
npm run dev               # the ib-face-mock app, unchanged
npm test                  # unit tests
npx playwright test       # e2e, including tests/e2e/designer.spec.ts
npm run build             # typecheck + production build
npm run server:typecheck  # typecheck server/ under bundler resolution
npm run agent:test        # the deterministic agent-proto regression suite
```
