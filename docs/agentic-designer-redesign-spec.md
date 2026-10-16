# Agentic Campaign Designer — Redesign Specification

**Status:** proposal for review. Nothing in this document has been implemented.
**Date:** 2026-10-13
**Scope:** `server/`, `src/designer/`, and the parts of `agent-proto/` and `src/` the
agent depends on. The manual Drip Campaign builder is not being changed.

Every claim below is one of four kinds, labelled throughout:

| Label | Meaning |
|---|---|
| **[verified]** | Read in source, or reproduced by running the real function. |
| **[defect]** | Verified behaviour that is wrong against the product objective. |
| **[hypothesis]** | Plausible, not yet demonstrated. Needs a live run to confirm. |
| **[proposed]** | Future behaviour. Does not exist today. |
| **[decision]** | Needs a product owner. Not answerable from the repository. |

No platform capability, event value, bank policy, template or performance figure is
invented here. Where a fact is missing from the repository it is named as missing.

---

## 1. Executive summary and diagnosis

The Campaign Designer does not currently fail because the model reasons badly. It
fails because **the application withholds the facts the model needs, then discards
the reasoning the model produces.**

Five causes, ranked by impact on design quality. All five are verified in source.

1. **The model cannot see allowed attribute values, or which entity an event
   filters on.** Both the capability tools and the prompt vocabulary emit attribute
   *names* only. `DC_EVENT_ENTITY` — the map from event category to filterable
   entity — exists in `src/data/sharedConstants.ts:199` and is referenced **nowhere**
   in `server/`. Every condition the agent writes is therefore a guess, and no
   validator catches a wrong one.
2. **A declared unknown destroys the whole strategy.** When the discovery gate
   overrides a proposal, `orchestrator.ts:669-683` returns with `strategy` and
   `blueprint` still `null`. The user sees one sentence. The system prompt
   *instructs* the model to declare unknowns (`orchestrator.ts:205`), so honesty is
   punished.
3. **The context-suppression heuristic silences the questions that matter.**
   `isAnsweredByContext` (`discovery.ts:331`) counts word overlap against a 6kB
   context blob. Because the vocabulary enumerates every option, any question about
   *choosing between* platform options matches and is suppressed.
4. **Four fields are requested from the model and silently discarded**:
   `workingHypothesis`, `controlPct`, and the Send's `describe`-derived messaging
   (`sampleCopy`, `cta`, `personalisationFields`). The agent's suggested messaging
   never reaches the Send node, the campaign, or the export.
5. **The system prompt teaches discovery procedure, not campaign design.** Measured:
   38% discovery doctrine, 32% JSON schema, 30% rules — of which roughly 400
   characters are design guidance.

The redesign moves work out of the prompt and into three places: **structured
platform context** (so the model stops guessing), **deterministic validation** (so a
guess cannot survive), and **a response contract that carries strategy and open
questions together** (so a recommendation is never thrown away).

---

## 2. Current architecture and verified defects

### 2.1 End-to-end flow

```
browser (CampaignDesigner.tsx)
  POST /api/designer-stream                       apiPlugin.ts:170-201 toRequest()
    orchestrateStream()                           orchestrator.ts:253
      ├─ intent 'confirm'  → NO MODEL CALL        orchestrator.ts:381-426
      │    buildFromBlueprint(client-echoed bp) → buildCampaignProposal → validate
      └─ intent 'converse'
           context assembly                       orchestrator.ts:435-464
           streamClaude(system, messages, tools)   anthropic.ts:238
           tool loop, max 8 rounds                 orchestrator.ts:478-577
           extractJson()                           anthropic.ts:180
           evaluateDiscovery()  ← THE GATE         discovery.ts:191
           → ask | request_evidence | propose
```

The exact payload per call **[verified]**:

- `system` = `SYSTEM` (`orchestrator.ts:169-237`), or `SYSTEM + "STOP CALLING
  TOOLS…"` on the last tool round (`:494`).
- `messages[0]` = `{role:'user', content: buildContextPrompt()}` (`:929-965`).
- `messages[1..]` = the chat history, where **every assistant turn is the
  human-facing rendered prose**, not the JSON the model emitted
  (`CampaignDesigner.tsx:205`).
- `tools` = the five `AGENT_TOOLS` (`agentTools.ts:19-60`). No `tool_choice`, no
  temperature, no extended thinking.

### 2.2 Component responsibilities and defects

| Component | Source | Current behaviour | Defects |
|---|---|---|---|
| Request shaping | `apiPlugin.ts:184-201` | Trusts the browser for `knowledge`, `brief`, `session`, `discoveryRounds` | **[defect]** The KB that reaches the prompt is browser-supplied and editable. Acceptable for a prototype; must be stated, not assumed safe. |
| Knowledge retrieval | `knowledge.ts:205-235` | 3,312 chars: channel costs, operational constraints, 11 principles, brand tone, "performance history: NONE AVAILABLE" | **[defect]** No tenant-specific scoping of principles; all are global. P-003 (EMI request expires after 7 days) is the only domain fact relevant to the EMI case and sits unlabelled among generic ones. |
| Capability vocabulary | `blueprint.ts:520-551` | 2,691 chars: event categories, attribute **names**, channels, 9 template names, step kinds, Goal-Check wiring | **[defect]** No attribute values. No event→entity map. No `isNew` flag. Lists templates as "that exist" even for tenants whose library is unreachable. |
| Capability tools | `agentTools.ts:75-139` | 5 tools over real app source | **[defect]** `list_audience_attributes` returns `Object.keys(attrs)` (`:85`), dropping `AttrMeta.options`. `list_event_types` returns event names only, dropping `isNew` and the entity mapping. |
| System prompt | `orchestrator.ts:169-237` | 7,369 chars | **[defect]** 70% procedure and schema; ~400 chars of design method. Instructs evidence-seeking while the KB states no performance data exists. |
| Discovery gate | `discovery.ts:191-283` | Application decides ask vs propose | **[defect]** Three separate defects, below. |
| Strategy presentation | `orchestrator.ts:885-898` | `renderStrategy` prose | **[defect]** Not reached at all when the gate overrides. |
| Confirmation | `orchestrator.ts:381-426` | Builds the client-echoed blueprint verbatim, no model call | Correct and deliberate. Keep. |
| Graph construction | `blueprint.ts:190-517` | Calls the app's own `dcConfirmAddNode` | **[defect]** Entry-event conditions are never validated (`:230-236`); only audience entries check attribute names (`:242-246`). `conditions()` (`:166`) never checks values. |
| Validation | `agent-proto/validate.ts` | node-config, no-open-branches, fan-out-intent, referential-integrity, campaign-config, channel-availability, message-cap, quiet-hours + a 6-entry hard-constraint registry | **[defect]** No check validates condition attributes or values. A graph carrying `Transaction Status = "Auth"` passes everything. |
| Send messaging | `blueprint.ts:355-399` | `sendProposals[]` on the response | **[defect]** Never written to `_config`; not in the campaign; not in `exportPayload` (`CampaignDesigner.tsx:256-269`). |
| Export | `CampaignDesigner.tsx:256-271` | campaign + provenance + validation + strategy + templateChoices | **[defect]** Gated on `exportable`, which requires every Send to have an account and template ID (`orchestrator.ts:849-850`). For `TEN-IBL` (`templateLibraryAccess: 'unavailable'`) that is never true until a human types them in. |

### 2.3 The three discovery-gate defects **[verified by execution]**

Run against the real retrieved context, with a first-turn proposal declaring three
unknowns:

```
TURN 1 (model proposed) →
  outcome:       "ask_questions"
  questions:     ["Can you confirm the exact message copy and CTA wording?"]
  reason:        "The agent proposed a strategy while still listing open unknowns…"
  overrodeModel: true
```

- **`isAnsweredByContext` suppressed the material questions.** "Whether entry should
  be a Transaction event or an EMI Request event" → topic words
  `[entry, event, request, transaction]`, **4/4 present** in context → suppressed.
  "Which status indicates the EMI request has expired" → 3/4 → suppressed. The words
  are present only because the vocabulary *lists both options*.
- **`isEvidenceGap` is a lexical classifier doing a semantic job**
  (`discovery.ts:293-317`). Measured on real strings: *"The exact message copy and
  CTA wording"* → **material, blocking**; *"the optimal number of reminders"* →
  **evidence, non-blocking**. Both are inverted.
- **`questionsFromUnknowns`** (`:367-375`) then rendered the surviving unknown
  verbatim as the question the user actually received.

### 2.4 Contract defects: fields requested and discarded **[verified]**

| Field | Asked for at | Read at | Consequence |
|---|---|---|---|
| `workingHypothesis` | `orchestrator.ts:212` | nowhere (grep: 2 hits, both declarations) | The model writes a full fallback strategy every discovery round; it is dropped. |
| `controlPct` | `orchestrator.ts:225` | nowhere — `campaignFields.ts:337` hardcodes `controlPct: 10` | A model-chosen holdout is silently replaced. |
| `describe` → copy/CTA | `orchestrator.ts:229` | `templateSelect.ts:212-228` only | Copy becomes `` `Hi ${customerFirstName}, <describe> ${shortUrl}` ``; CTA is one of three hardcoded strings keyed off `stage`. Neither is stored. |

### 2.5 Honesty gap not previously identified **[verified]**

`EVENT_CATEGORIES` marks `Transaction Events`, `EMI Events` and `Card Events` with
`isNew: true` — the source comment (`sharedConstants.ts:75-79`) reads *"Proposed, not
real in Quibbler today."* The manual builder surfaces this as "(New)"
(`NodeForms.tsx:270`, `:473`, `GoalDefinitionStep.tsx:55`). **The agent is never told.**
The entire EMI campaign is built on event categories flagged as not-yet-built, and
neither the agent nor the campaign manager is informed.

---

## 3. Target architecture and responsibility boundaries

The split is unchanged in spirit — model reasons, application constructs — but the
boundary moves. Today the application also decides *what the model is allowed to be
uncertain about*. It should not.

```
 ┌─ MODEL owns ───────────────────────┐   ┌─ APPLICATION owns ────────────────────┐
 │ • reading the objective            │   │ • what the platform can express       │
 │ • the design method (§4)           │   │ • allowed values and their sources    │
 │ • which gaps are material          │   │ • validity of every proposed value     │
 │ • the recommended strategy         │   │ • graph construction and wiring        │
 │ • rationale and rejected options   │   │ • export eligibility and state          │
 │ • suggested messaging (advisory)   │   │ • never inventing an ID                 │
 └────────────────────────────────────┘   └───────────────────────────────────────┘
            │                                             │
            └────────── one structured response ──────────┘
                        always carries a strategy
```

Three invariants **[proposed]**:

- **I1 — A recommendation is never discarded.** If the model produces a strategy, the
  user sees it. Open questions are presented *alongside* it, never instead of it.
- **I2 — A value the platform cannot express never reaches a graph.** Validation is
  deterministic and covers conditions, not just required fields.
- **I3 — The application never paraphrases the model.** Generic fallback strings are
  used only when the model genuinely produced nothing.

---

## 4. Campaign reasoning methodology

**[proposed]** A reasoning frame, not a recitation checklist. The model uses the parts
the objective calls for and says which it skipped and why. Ten elements:

1. **Business objective → behaviour.** What is the customer doing today, and what
   should they do instead? State it as an observable action, not a metric.
2. **Observable success.** The real platform event and condition that proves the
   behaviour happened. If no event proves it, say so — this is a material gap.
3. **Entry population.** The real event or audience that defines who enters, with
   attribute values drawn from the allowed list. Distinguish the event that makes
   someone *eligible* from the event that proves *success*.
4. **Opportunity window.** How long the customer has, what closes the window, and how
   the platform represents that closure. If no event represents it, a timed wait is
   the honest substitute — and must be labelled as such.
5. **Intervention hypothesis.** Why these messages should change the behaviour.
   Explicitly a hypothesis; never a predicted lift.
6. **Message purpose and sequence.** What each message must achieve, and why it sits
   where it sits. A message with no distinct job should be removed.
7. **Timing, frequency, channel.** Fitted to the window and to the hard constraints
   (message cap, minimum spacing, quiet hours), with the channel-cost ladder applied
   and any trade-off stated.
8. **Segmentation, branching, experiments, control.** Default is none. Add one only
   with a stated reason, and say what was considered and rejected.
9. **Goal checks, exits, stopping conditions.** What ends the journey, successfully
   or otherwise.
10. **Constraints, evidence gaps, implementation requirements.** Three separate
    lists, not one.

Every significant decision carries: the decision, the information relied on, and the
trade-off accepted. No predicted or measured lift without evidence — the existing
rule at `orchestrator.ts:176` is correct and is retained verbatim.

---

## 5. Discovery and unknown-handling contract

### 5.1 Replace three actions with one response **[proposed]**

The current `ask | request_evidence | propose` trichotomy forces the model to choose
between recommending and asking. The objective requires both at once. Replace with a
**single response shape that always carries a strategy**, plus typed open items:

```jsonc
{
  "strategy": { "summary": "...", "approach": ["decision + why"],
                "rejected": [{"option":"...","why":"..."}],
                "assumptions": ["..."] },
  "blueprint": { /* unchanged shape */ },
  "openItems": [
    { "kind": "strategic-ambiguity",
      "question": "Which transaction status means the authorisation is still open?",
      "whyItMatters": "Entry targets the wrong population if this is wrong.",
      "ifUnanswered": "I will assume APPROVED and say so." },
    { "kind": "evidence-gap", "question": "...", "wouldInform": "...",
      "ifUnanswered": "Single sequence, no segmentation." },
    { "kind": "optional-preference", "question": "...", "default": "..." },
    { "kind": "operational-limitation", "statement": "..." }
  ]
}
```

The fifth category — **implementation requirement** — is **never** produced by the
model. It is computed by the application from the real validators (§6.3), because
only the application knows what a valid graph needs.

### 5.2 What each kind does

| Kind | Author | Blocks strategy display? | Blocks graph build? |
|---|---|---|---|
| strategic-ambiguity | model | **no** — shown with the strategy | no |
| evidence-gap | model | no | no |
| optional-preference | model | no | no |
| operational-limitation | model or app | no | no |
| implementation-requirement | **application only** | no | **yes** |

This directly satisfies §3.2 of the requirements: strategy is visible even when the
build is blocked, and only genuine graph-validity gaps stop construction.

### 5.3 Preventing repeat questions without lexical shortcuts

**Delete `isAnsweredByContext`** (`discovery.ts:331`). Replace with two mechanisms
that cannot misfire the same way **[proposed]**:

- **Resolved-facts ledger.** `briefForPrompt` (`discovery.ts:519`) already renders
  "Established (do NOT ask about these again)". Extend it so every user answer and
  every tool result that settles a value is written in as a typed fact
  (`{subject, value, source}`), not free text. Repetition is then prevented by the
  model seeing the answer, not by the application scoring word overlap.
- **Exact-value suppression only.** If the application wants to suppress a question
  automatically, it may do so only when the *specific value* is present in structured
  context — e.g. suppress "what are the valid transaction statuses" because
  `ELIGIBILITY_META.Transaction['Transaction Status'].options` was supplied. Never on
  topic-word overlap.

`isEvidenceGap` (`discovery.ts:293`) is **deleted**, not tuned. The model declares the
kind; a regex no longer guesses it.

### 5.4 Keeping model output visible

`orchestrator.ts:674` currently substitutes `gate.reason` for the model's own words.
**[proposed]** The reply is always the model's `strategy.summary`, with open items
rendered beneath it. Application-authored strings appear only as *labels* on those
items ("Needed before I can build this"), never as the body of the reply.

---

## 6. Platform metadata and validation requirements

This is the highest-impact section. It is context and validation work, not prompt work.

### 6.1 Metadata that must be exposed, with its authoritative source

| Fact | Authoritative source | Exposed today? |
|---|---|---|
| Allowed values per attribute | `ELIGIBILITY_META[entity][attr].options` (`sharedConstants.ts:106`) | **no** — `.keys()` only, in both the tool (`agentTools.ts:85`) and the vocabulary (`blueprint.ts:526`) |
| Attribute input type (`select`, `multiSelect`, `bool`, `number`, `date`, `list`, `smartTag`) | `AttrMeta.type` | **no** |
| Event category → filterable entity | `DC_EVENT_ENTITY` (`sharedConstants.ts:199`) | **no** — unreferenced in `server/` |
| Event category "not yet built" flag | `EventCategoryMeta.isNew` (`:68-71`) | **no** — UI only |
| Locked attribute per event type (Journey/Offer) | `EVENT_ATTR_BY_TYPE` | **no** |
| Operators valid for an attribute type | `ConditionRows.tsx` / `LOCKED_ATTR_OPERATORS` | **no** |
| Milestone benefits and operators | `MILESTONE_BENEFITS`, `MILESTONE_OPERATORS` | **no** |
| Node types and wiring rules | `DC_NODE_META`, `generateSchemaArtefact()` | yes |
| Channel availability and cost order | `tenants.ts` via `list_channels` | yes |
| Template library reachability | `tenants.ts:46,60,76` | yes, but contradicted (§6.4) |

**[proposed]** Expose these through the **tools**, not by growing the static
vocabulary block. Tools are pulled on demand, so a large value catalogue does not sit
in every prompt. Concretely: `list_audience_attributes` returns
`{entity: {attribute: {type, options?, operators}}}`; `list_event_types` returns
`{category: {events, entity, isNew}}`.

### 6.2 Detecting invalid conditions

**[proposed]** One function, used by both the builder and the validator, e.g.
`validateCondition(entity, attribute, operator, value)` returning a typed result. Rules:

- attribute must exist on the entity;
- for `select` / `multiSelect`, the value must be in `options` — case-sensitively,
  reporting the near match (`"Auth"` → `"did you mean AUTHORIZE?"`);
- `number` requires a numeric value, `bool` a boolean, `date` a date;
- operator must be legal for the type.

Wire it in three places: `blueprint.ts:166` (`conditions()`), the entry-event path
(`blueprint.ts:230-236`, which validates nothing today), and a **new
`condition-validity` check** in `agent-proto/validate.ts` so a graph can never pass
validation carrying an unsupported condition (invariant I2).

### 6.3 Implementation requirements, computed not guessed

**[proposed]** After `buildFromBlueprint`, the application derives the
`implementation-requirement` list from what it actually found: unresolved account /
template IDs (already computed, `orchestrator.ts:848`), failed condition validations,
and any `BuildIssue`. These are returned as structured items with the node they
belong to — replacing today's prose blob at `orchestrator.ts:920-922`.

### 6.4 Stale, unavailable and conflicting metadata

- **Unavailable template library.** `blueprintVocabulary` must stop listing
  `COMMS_TEMPLATES` under *"Message templates that exist"* when
  `templateLibraryAccess === 'unavailable'`. One statement, consistent with the tool.
- **`isNew` categories.** Surfaced to the model and carried into the strategy as an
  operational-limitation open item: *"Transaction Events is marked not-yet-built in
  the platform metadata."*
- **User value conflicts with metadata.** **[proposed]** Never silently accept, never
  silently correct. The application reports the conflict and the model asks one
  targeted question. In the EMI case the user supplied `Product Type = Auth` and
  `New Status = successful`; neither is in the real option lists
  (`Single-Txn | Multi-Txn | Outstanding`, `Pending | Successful | Failed | Expired |
  Cancelled`), and both are on the `EMI Request` entity while their other three values
  are on `Transaction`. Today both are accepted and built. **[decision]** Whether a
  user-supplied value may ever override platform metadata — see §12.

---

## 7. Proposed prompt architecture

Four layers. Static instructions shrink; context grows in structure, not in length.

| Layer | Where it lives | Roughly |
|---|---|---|
| L1 Role and non-negotiables | static system | 900 chars |
| L2 Design method | static system | 1,300 chars |
| L3 Grounding and uncertainty rules | static system | 700 chars |
| L4 Output contract | static system | 1,100 chars |
| Platform facts | **tools**, pulled on demand | — |
| Tenant knowledge, working brief | retrieved context | as today |

Target: ~4,000 static chars against today's 7,369, with the design method growing from
~400 to ~1,300.

### 7.1 Draft system prompt **[proposed]**

> You are a campaign strategist for a bank card-programme marketing platform. You
> design drip campaigns: multi-step customer journeys made of messages, waits,
> branches and exits.
>
> You own the design. Deterministic application code owns construction, validation and
> IDs. You never emit node ids, edge ids, field names or template ids.
>
> **Non-negotiables**
> - Use only the events, entities, attributes, values, channels and step kinds the
>   tools report. Anything else is rejected by the builder.
> - Never claim a conversion lift, a cost saving or a performance number. No
>   performance data exists for this bank. An expected effect is an untested
>   hypothesis and must be labelled as one.
> - A funnel drop-off does not prove its cause.
> - Treat knowledge marked `[status: invented]` as unverified mock data.
> - Respect hard constraints (message cap, minimum spacing, quiet hours, channel
>   availability). Preferences are tradeable; say when you trade one off.
>
> **How to design a campaign**
> Work through these as far as the objective requires, and say which you skipped and
> why. For each decision, state the decision, what you relied on, and the trade-off.
>
> 1. The behaviour that must change, as something the customer does.
> 2. The observable event and condition that proves it happened.
> 3. Who enters: the real event or audience, with real attribute values.
>    Distinguish what makes someone eligible from what proves success.
> 4. The opportunity window: how long they have, what closes it, and how the platform
>    represents that closure.
> 5. Why these messages should change the behaviour. This is a hypothesis.
> 6. What each message must achieve, and why it sits where it sits.
> 7. Timing, frequency and channel, fitted to the window and the hard constraints.
> 8. Segmentation, branching, experiments and control groups: none by default. Add
>    one only with a reason, and say what you rejected.
> 9. What ends the journey, with and without success.
>
> A simple campaign that fits the objective beats an elaborate one.
>
> **Grounding**
> Call the tools before you choose an entry trigger, a goal event, an attribute value
> or a channel. Never ask the user something a tool can answer. Never ask the user to
> confirm a product capability.
>
> **Uncertainty**
> Always recommend. Never withhold a strategy because something is unresolved — say
> what you assumed and what would change your mind. Classify each open item:
> `strategic-ambiguity` (a business definition only the user can settle, which would
> change the design), `evidence-gap` (aggregated data that would improve a decision —
> never a prerequisite; if the user says it is unavailable, accept it immediately and
> never ask again), `optional-preference` (state your default), `operational-limitation`
> (something the platform cannot confirm). Do not raise implementation details such as
> message copy wording as open items — the application tracks what it needs.
>
> **Messaging**
> You suggest messaging; you never select the bank's template. For each message give a
> communication objective, suggested copy, a CTA and the personalisation tokens you
> relied on. The campaign manager supplies the real account and template IDs.
>
> **Output**
> One JSON object, nothing else. [schema as §5.1]

### 7.2 What moves out of the prompt

| Removed | Why | Replaced by |
|---|---|---|
| "Call every tool in ONE batch… two rounds maximum" (`:185`) | latency preference enforced as a correctness rule | nothing |
| The evidence-seeking doctrine (`:193-197`, 3 paragraphs) | conflicts with "performance history: NONE AVAILABLE" | one clause in Uncertainty |
| "list every material thing in strategy.unknowns… your proposal is held" (`:205`) | describes the behaviour being removed | typed `openItems` |
| Template keyword rules (`:175`) | robustness already lives in `objectiveKeywords` (`blueprint.ts:153`) | retained in code only |
| `workingHypothesis` | never read | deleted |

---

## 8. Messaging and Send-node data contract

### 8.1 What the model can express today vs what survives **[verified]**

The model writes `describe` per Send. `proposeMessaging` turns it into `sampleCopy`,
`cta`, `personalisationFields`; those land in `sendProposals[]` on the response and
**stop there**. The Send's `_config` (`blueprint.ts:375-390`) carries only
`name, channel, account, templateId, timing, relativeAnchor, relativeDuration,
relativeUnit, fallbackChannel`.

### 8.2 Smallest coherent change **[proposed]**

`DripNode._config` is typed `Record<string, unknown>` (`graphTypes.ts:22`) and
`dcConfirmAddNode` stores it with `structuredClone` (`campaignReducer.ts:44`).
**No type change and no schema change are required.** Write one namespaced key:

```jsonc
"_config": {
  "name": "...", "channel": "WHATSAPP", "account": "", "templateId": "",
  "agentMessaging": {
    "objective": "Prompt conversion before the authorisation window closes",
    "suggestedCopy": "...",
    "cta": "...",
    "personalisationTokens": ["customerFirstName", "shortUrl"],
    "recommendedChannel": "WHATSAPP",
    "timingRationale": "48h after entry, inside the open window",
    "source": "agent-suggested — not a bank-registered template"
  }
}
```

Consequences to handle, all verified:

- `dcAddFormValid` (`defaultConfig.ts:105-110`) ignores unknown keys. No validator
  change needed.
- `exportPayload` already serialises `campaign.root` (`CampaignDesigner.tsx:259`), so
  the suggestion travels with the export automatically.
- **`dcEditNode` replaces `_config` wholesale** (`campaignReducer.ts:223`). If a
  campaign manager edits a Send in the manual builder, `agentMessaging` is dropped.
  The Send drawer must carry unknown keys through, or preserve this one explicitly.
  **This is a real dependency on `src/wizard/`, and the only part of this change that
  touches the manual builder.**
- **`exportable` must stop depending on resolved template IDs** for the suggestion to
  be usable. Today (`orchestrator.ts:849-850`) an unresolved Send blocks export, so
  with `TEN-IBL` the suggested messaging can never be exported at all. **[proposed]**
  Separate *exportable* (the design is complete and valid) from *import-ready* (the
  bank's IDs are filled in), and label the export accordingly.

No template catalogue is created. No account or template ID is invented.

---

## 9. Strategy-to-graph translation

### 9.1 Verified mapping

| Blueprint step | Node built | Source |
|---|---|---|
| `entry.kind='event'` | `ENTRY_EVENT` | `blueprint.ts:236` |
| `entry.kind='audience'` | `ENTRY_SEGMENT` | `:252` |
| `send` | `SEND` | `:393` |
| `wait` | `PAUSE` | `:404` |
| `waitForEvent` | `WAIT_UNTIL` | `:421` |
| `exit` | `EXIT` | `:426` |
| `experiment` | `RANDOM_SPLIT` + arms | `:454-464` |
| `condition` | `SPLIT` (`customSource: 'Previous step outcome'` only) | `:473-486` |
| — | `GOAL_CHECK` + `GOAL_EXIT` auto-inserted by the reducer | `campaignReducer.ts:61-65` |

### 9.2 Gap between what the model can recommend and what the platform supports

**[verified]** The platform supports these; the blueprint vocabulary cannot express them:

| Platform capability | Where it exists | Expressible by the agent? |
|---|---|---|
| `DECISION_SPLIT` (N-way Branch) | `nodeMeta.ts`, builder | **no** |
| `SPLIT` on Attribute / Entry-event attribute / Transaction history / Milestone | `NodeForms.tsx`, `defaultConfig.ts` | **no** — only delivery outcome |
| Manually added `GOAL_CHECK` | added 2026-10-12 | no |
| Entry · Audience `extraEntityGroups`, Milestone entity, Transaction lookback | `graphTypes.ts`, `NodeForms.tsx` | no |
| Send `fallbackChannel` | `defaultConfig.ts:61` | no — hardcoded `''` (`blueprint.ts:389`) |
| Per-send timing | `timing`/`absTime`/`relativeDuration` | no — hardcoded `Relative, 0 hours` (`:385-388`) |
| Parallel paths / fan-out | `dcCanFanOut`, `growLeaf` | no — `routingIntent` is always `{fanOut: []}` (`orchestrator.ts:824`), so declared fan-out is impossible and the validator would flag any |
| Campaign `controlPct`, guardrails, re-entry | `DripCampaign` | no — `controlPct` discarded, rest omitted by design |

**[proposed]** Close three of these, because they are needed for ordinary campaign
design, and leave the rest documented as known limits:

1. **Per-send timing** — a `delay` on the send step, so the model stops expressing
   every wait as a separate `PAUSE` node.
2. **Attribute-based `condition`** — the single most common branch in real campaigns,
   and the one the EMI case would want for "did they convert on a smaller amount".
3. **`fallbackChannel`** — one optional field; the platform already supports it and
   P-009 in the KB describes exactly when to use it.

`DECISION_SPLIT`, Milestone conditions, fan-out and the audience extensions stay out
of scope for this round, and the strategy must say so when it would otherwise want one.
**No new graph capability is proposed. Every item above already exists in the builder.**

---

## 10. Evaluation plan

### 10.1 What exists today **[verified]**

`tests/unit/` holds `discoveryGate`, `discoveryIntelligence`, `discoveryValidation`,
`conversationFlow`, `blueprint`, `missingTemplate`. They assert gate mechanics — that a
material gap blocks, that an evidence gap does not, that a tool returns real data.
**Every one of them would still pass with the EMI behaviour exactly as reported.**
`validate.ts:556` already concedes the point: a `campaign-quality` check recorded as
`not-run`, *"Not mechanically checkable."*

### 10.2 Two test tiers **[proposed]**

- **Tier 1 — deterministic, no model.** Fixed blueprint and brief fixtures through the
  real gate, builder and validators. Fast, runs in CI.
- **Tier 2 — live-model scenario suite.** Real Sonnet calls, graded against explicit
  criteria. Run on demand, never in CI. **Nothing in this document claims live-model
  behaviour has been tested; no live run was performed for this specification.**

### 10.3 Scenarios

| # | Scenario | Tier | Pass criteria |
|---|---|---|---|
| S1 | **EMI, full transcript.** Objective + the user's six corrections | 2 | Strategy presented in the same turn as any question. Entry uses `Transaction Events / Transaction`. Conditions use real values (`AUTHORIZE`, `APPROVED`, `CUSTOMER_INITIATED`). The `Product Type = Auth` conflict is reported, not accepted. Message copy is never a blocking question. Window reasoning references the 7-day fact (P-003) or states it is unverified. |
| S2 | **Ambiguous objective** ("increase engagement") | 2 | At most 3 questions, each would change the design. A baseline strategy still accompanies them. |
| S3 | **Sufficient context** (objective naming entry, goal and window) | 2 | Zero questions. Strategy proposed on turn 1. |
| S4 | **Invalid condition value** — blueprint with `Transaction Status = "Auth"` | 1 | `condition-validity` check fails; build blocked; near-match suggested; no graph emitted. |
| S5 | **Unknown attribute on entry event** | 1 | Rejected (today: silently accepted — this test fails before the fix). |
| S6 | **Evidence declined** ("we have no conversion data") | 1+2 | Never re-asked; recorded as a limitation; strategy proceeds with a stated baseline. |
| S7 | **Strategic ambiguity present** | 1 | Strategy *and* question both returned. `strategy !== null` on an `ask` outcome — the direct regression test for defect #2. |
| S8 | **Optional preference only** | 1 | No question; default applied and stated. |
| S9 | **Unresolved template IDs** (`TEN-IBL`) | 1 | Graph builds; `agentMessaging` present on every Send; export permitted and labelled not-import-ready. |
| S10 | **Confirmation flow** | 1 | No model call on confirm; graph matches the confirmed blueprint byte-for-byte on a re-run. |
| S11 | **Stale confirmation** | 1 | Objective change invalidates it (already covered; keep). |
| S12 | **Refinement** ("make the second message SMS") | 1+2 | Exactly one field differs from the prior graph. Diff asserted node by node. |
| S13 | **`isNew` disclosure** | 1 | A campaign entering on `Transaction Events` carries the not-yet-built limitation in its strategy. |

### 10.4 Grading tier 2

**[decision]** Tier-2 scenarios need a rubric with a human or model grader. Proposed
rubric per scenario: *grounding* (every value real), *completeness* (methodology
elements present where relevant), *parsimony* (no unjustified branch), *honesty* (no
unevidenced claim), *actionability* (a campaign manager could act on it). Pass = all
five. Who grades, and how often this runs, is a product decision.

---

## 11. Phased implementation plan

Ordered by impact on design quality, not by ease. Each phase is independently
shippable and independently verifiable.

### Phase 1 — Ground the model (highest impact)
**Problem:** the agent guesses values and entities.
**Changes:** `agentTools.ts` emits `options`, `type`, `operators`, `DC_EVENT_ENTITY`,
`isNew`. `blueprint.ts:520` stops listing templates when the library is unreachable.
**Depends on:** nothing.
**Verified by:** S4, S5, S13 plus a live S1 re-run.
**Risk:** larger tool payloads. `TRANSACTION_SUBTYPE_OPTIONS` alone is 34 values —
truncation at `orchestrator.ts:574` is 8,000 chars per result, so measure before
shipping.

### Phase 2 — Stop discarding strategies
**Problem:** defect #2 and #3; the EMI conversation's actual failure.
**Changes:** new response contract (§5.1); `evaluateDiscovery` becomes a classifier
over typed `openItems` instead of a veto; delete `isEvidenceGap` and
`isAnsweredByContext`; `reply` carries the model's own words.
**Depends on:** Phase 1 for the questions to be worth asking.
**Verified by:** S2, S3, S6, S7, S8.
**Risk:** the gate is the main safety net against premature generation. The *state
machine* (`campaignState.ts`) is the real guard and is unchanged — generation still
requires `AWAITING_STRATEGY_CONFIRMATION` plus `mayGenerate()`. Confirm this before
loosening the gate.

### Phase 3 — Deterministic condition validation
**Problem:** invalid values reach a graph that passes every check.
**Changes:** `validateCondition`; wire into `blueprint.ts:166` and `:230-236`; new
`condition-validity` check in `validate.ts`.
**Depends on:** Phase 1 (same metadata).
**Verified by:** S4, S5.
**Risk:** stricter validation will block blueprints that build today. Expected, and the
point — but it will look like a regression in demos.

### Phase 4 — Messaging contract
**Problem:** the agent's messaging never reaches anyone.
**Changes:** `agentMessaging` on Send `_config`; Send drawer preserves unknown keys;
separate *exportable* from *import-ready*.
**Depends on:** nothing. **Touches `src/wizard/` — the only phase that does.**
**Verified by:** S9.
**Risk:** the drawer round-trip. If the form drops the key, a single manual edit
silently erases the suggestion.

### Phase 5 — Prompt rewrite
**Problem:** no design methodology.
**Changes:** §7.1 replaces `orchestrator.ts:169-237`.
**Depends on:** Phases 1–2. **Doing this first would change little** — that is the
central finding of the audit.
**Verified by:** S1, S2, S3 graded against §10.4.

### Phase 6 — Close the three expressiveness gaps
Per-send timing, attribute-based condition, fallback channel (§9.2).
**Verified by:** extended S1 and S12.

### Cross-cutting risks

- **No live baseline exists.** Nobody has measured today's output quality, so
  improvement cannot be demonstrated. **Capture 5–10 live transcripts before Phase 1.**
- **Browser-supplied state.** `knowledge`, `brief` and `session` round-trip through the
  client (`apiPlugin.ts:188-199`). Fine for a prototype; a blocker for anything real.
- **Model behaviour is not guaranteed by any of this.** Phases 1–4 make bad output
  *detectable and impossible to build*; they do not make good output certain.

---

## 12. Decisions requiring a product owner

1. **User value vs platform metadata.** When a campaign manager supplies a value the
   metadata does not contain (`Product Type = Auth`), may the agent build it with a
   warning, or must it block? Recommendation: **block, and name the near match** — a
   campaign that targets no one is worse than one that is late.
2. **Does an unverified-by-platform campaign deserve an export?** Entering on an
   `isNew` event category means the trigger may not exist in Quibbler yet.
   Recommendation: **allow, with the limitation printed in the export payload.**
3. **Should `request_evidence` survive at all?** The KB states no performance data
   exists for this bank. Recommendation: **keep the category, drop the doctrine** —
   one clause, not three paragraphs.
4. **Exportable vs import-ready.** §8.2 proposes splitting them so suggested messaging
   can leave the tool. This changes what the Export button means.
5. **Tier-2 grading.** Who grades, against what rubric, how often (§10.4).
6. **Scope of the strategy↔graph gap.** §9.2 proposes closing three of eight. Confirm
   the three, or re-rank.

---

## Appendix A — Reproduction notes

The gate behaviour in §2.3 was reproduced by calling the real exported functions
(`evaluateDiscovery`, `isEvidenceGap`, `isAnsweredByContext`, `knowledgeForPrompt`,
`blueprintVocabulary`, `runTool`) against the real `TEN-IBL` tenant, outside the repo,
with no files modified. The full retrieved context measured 6,004 characters: 3,312 of
knowledge base and 2,691 of vocabulary.

## Appendix B — Conflicts found in the source material

Documented rather than resolved, per the working constraints.

1. **The product overview says the agent decides "message direction and copy."** The
   build generates copy from a format string (`templateSelect.ts:220`). The overview
   describes an intent the implementation does not meet.
2. **The vocabulary lists nine templates as existing; the tool says the library is
   unreachable.** Both are in context simultaneously for `TEN-IBL`.
3. **The prompt asks for `controlPct`; `campaignFields.ts:337` hardcodes 10**, with a
   comment acknowledging it is "required by the model, so it cannot be omitted."
4. **`AGENT_PROTOTYPE.md` and this specification may disagree** on the agent's scope.
   Source was treated as authoritative throughout.
