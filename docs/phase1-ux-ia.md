# Drip Campaigns — Phase 1: UX / Information Architecture

Status: **proposal, awaiting approval (v3)**. No code changed. No CSS changed. This document is the complete Phase 1 deliverable per the brief's 16-point list.

**v2 revision note:** Phase 1's core model was approved — Goal Check as a first-class node, the P0–P3 hierarchy, fixed sizing, counts-not-expressions, and the four-way Action/Decision/System-Evaluation/Outcome split all stand as proposed. This revision narrows four specific points per follow-up direction: (1) Goal Check's visual weight is clarified as "compact, not less-visible"; (2) Goal Check is removed from the user-addable Add Step picker entirely — it's now automatic-only, with the one legitimate manual use case solved directly rather than by exposing a generic node; (3) Goal Reached's manual availability is restricted to a specific, named use case rather than offered unconditionally; (4) Re-entry is reaffirmed as a documented-but-not-implemented gap, explicitly not part of this approval. A new §10A gives the final user-facing Add Step taxonomy, separate from the internal one.

**v3 revision note:** the overall direction (including the v2 narrowing) is approved. This round re-confirms every v2 decision against a more explicit 9-point checklist and sharpens two things that were previously implicit: (1) Goal Check's distinctiveness must be **structural and semantic, not merely a color/icon difference** — §5's "Visual weight" subsection is rewritten to state the exact semantic contrast ("Has the goal been achieved?" vs. "Does the customer satisfy these conditions?") and ties it to the no-configuration-form structural signal already proposed in §12, rather than leaving the distinction implied; (2) the Review checklist (§1) is expanded to match the specific validation items requested (Entry configured, templates/required fields, unreachable/broken nodes) rather than the shorter five-line placeholder from v2. Two new sections are added and nothing else changes: **§16** records the Phase 2 visual-design brief as a locked set of constraints (modern-but-not-legacy canvas, reduced chrome, Goal Check must stay visible — not be solved by hiding/collapsing it) so it's agreed *before* Phase 2 starts, not decided ad hoc once CSS work begins; **§17** is a short traceability checklist confirming this whole exercise still preserves the core product model (existing APIs/data structures, existing components, no invented backend capability) point-by-point.

Every recommendation below is checked against the real current data model (`graphTypes.ts`, `reducer/*.ts`, `wizard/NodeForms.tsx`) — not invented in the abstract. Where a recommendation requires a data-model change, that's called out explicitly as "Impact."

---

## 1. Recommended information architecture

```
Campaign
 → Basic Details   (name, description, issuer, programs, control %, dates)
 → Goal            (the one business outcome this journey is built around — optional)
 → Journey         (the canvas — entry, actions, waits, decisions, system checks, outcomes)
 → Review          (NEW — currently missing; see §9 of the 16-point list below)
 → Publish         (Submit for Approval → Pending → Approve → Active)
 → Monitor         (Overview canvas / Analytics tab, Pause/Resume/Kill, versioning)
```

This matches the brief's target flow almost exactly. The one gap: there is currently no explicit **Review** step — Submit for Approval goes straight from the canvas to a toast. This isn't being fixed in Phase 1 (no code yet), but it's named here because node-count reduction (§ Goal Check below) makes a pre-submit review surface more valuable, not less.

**Review is explicitly a lightweight validation state, not a new wizard step.** It should not add a fourth step to the Basic Details → Goal → Journey flow, and should not be a new page — it must not become another configuration-heavy screen. The proposed form is a small checklist panel shown above the Submit button (or inline in the builder header), reading:

```
✓ Entry configured
✓ Goal configured (if applicable)
✓ Journey valid — no open branches
✓ All branches/connections resolved
✓ No unreachable or broken nodes
✓ Required fields/templates configured
                              [ Submit for Approval ]
```
*(an item renders as ✗ with a short reason and a jump-link to the offending node/step when it fails — the panel never just says "invalid")*

This is cheap to build *because it needs no new validation logic* — every one of those lines maps directly onto a check the reducer already computes today or can compute from data already on the graph: Entry-configured and Goal-configured are presence checks already used to gate Continue on their respective wizard steps; "no open branches" is the existing `dcGraphHasOpenBranches`; "unreachable or broken nodes" is a graph-reachability walk from `rootId` using data already in `DripGraph` (new *logic*, not a new data model — no field is added anywhere); "required fields/templates configured" reuses each node type's existing `dcAddFormValid` check, just run across every node up front instead of one at a time as each drawer closes. Review simply means surfacing that same state proactively, as a short list with jump-links, instead of reactively, as one combined error message after a failed Submit click. No new data model, no new step in the stepper, no new persisted state.

---

## 2. Recommended node taxonomy

```
ENTRY                     (exactly one, always first)
 • Entry · Audience         (was ENTRY_SEGMENT)
 • Entry · Event            (was ENTRY_EVENT)

ACTIONS                   (things the journey DOES)
 • Send
 • Channel Failover

WAIT                      (things the journey WAITS for)
 • Wait                     (was Pause)
 • Wait for Event           (unchanged)

DECISIONS                 (things the journey DECIDES, driven by customer data)
 • Condition                (was Conditional Split / SPLIT)
 • Branch                   (was Decision Split / DECISION_SPLIT)

EXPERIMENTATION            (chance-driven, not data-driven — deliberately separate from Decisions)
 • Experiment                (was Random Split / RANDOM_SPLIT)

SYSTEM EVALUATION          (NEW category — automatic, system-performed)
 • Goal Check               (NEW node type — see § Goal Check below)

OUTCOMES                   (things that END the journey)
 • Goal Reached             (was Goal-Based Exit / GOAL_EXIT)
 • Exit                     (unchanged)
```

This directly answers the brief's four-way test (§7): **Actions** = things the user wants the journey to do. **Decisions + Experimentation** = things the journey uses to decide. **System Evaluation** = things the system automatically evaluates. **Outcomes** = things that end the journey. Each node now belongs to exactly one of those four buckets — today's taxonomy doesn't cleanly partition this way, because a goal-check is just a `SPLIT` with a particular `_config.basis`, indistinguishable at the type level from a user-built Condition.

**v3: taxonomy confirmed unchanged.** No new node type is introduced anywhere in this document — the list above is exactly the approved set (Entry·Audience, Entry·Event, Send, Channel Failover, Wait, Wait for Event, Condition, Branch, Experiment, Goal Check, Goal Reached, Exit). Condition, Branch, and Experiment remain three separate types (different execution semantics — AND'd boolean vs. attribute-range vs. pure chance, per the rejected-alternative note below); no node is split or merged purely for visual/organizational convenience.

**This is the internal/engineering taxonomy** — it's how `DcNodeType`/`DC_TYPE_CATEGORIES` should be organized in code, and it's what makes "which bucket does this node belong to" a clean type-level question. It is **not** the grouping shown to users in the Add Step picker — **System Evaluation is not a user-facing category at all** (v2): Goal Check is the only member, it's never user-addable (§5), so there is nothing to pick from in that bucket, ever. The user-facing picker uses a separate, smaller, task-oriented grouping — see §10A.

**Rejected: a single unified "Branch" node with a selectable strategy** (binary / attribute-range / random), the brief's own Option D. I unified Entry (Segment + Scheduled) earlier this session precisely because they shared *identical* downstream semantics and differed only by a timing cadence. Condition, Branch, and Experiment do not pass that test — they have genuinely different execution semantics (AND'd multi-attribute boolean vs. single-attribute N-way range vs. pure percentage chance with no data evaluation at all). Collapsing them into one node with an internal mode-selector would recreate exactly the "one dropdown gates wildly different downstream forms" confusion this whole session has been fixing elsewhere (Split's own Source dropdown, Entry's old Entity-always-visible problem). Keep them separate; fix the *names* and *categories*, not the count.

---

## 3. Recommended terminology

| Current | Proposed | Why |
|---|---|---|
| Conditional Split | **Condition** | Pairs with "Goal Check" (same register: a check), signals a Yes/No evaluation without implying it branches many ways |
| Decision Split | **Branch** | Describes what it visibly does (fans out by one attribute's value/range) rather than an abstract "decision" |
| Random Split | **Experiment** | It's an A/B test, not a decision based on customer data — moved to its own category for this reason |
| Goal-Based Exit | **Goal Reached** | Reads as the business outcome it represents, not a technical "exit" mechanism |
| Entity (Customer/Account/Card) | *(label removed)* — just show "Customer / Account / Card" directly under **Who** | "Entity" is backend vocabulary with zero business meaning; the three options themselves are already plain language |
| Event Category / Event Type | **What kind of event? / Which event?** | Same two-level picker, softer phrasing — no data-model change, just friendlier form labels |
| Conditions (on Entry/Wait) | **Eligibility** | Reads as a business concept ("who's eligible") rather than a generic technical term |
| EMI Request (entity name shown in condition builder) | **EMI** | Minor — "Request" is an internal modeling detail; "EMI" alone is how ops teams actually say it |

**Not changing:** Send, Channel Failover, Wait for Event, Exit, Account/Card/Transaction as attribute-catalog entity names — these are legitimate domain vocabulary (banks and ops teams already think in accounts/cards/transactions), not backend leakage. Removing them would be removing real concepts, which the brief explicitly says not to do.

---

## 4. Recommended goal model

No change to the data model here — `DripCampaign.goal: {eventCategory, eventType, conditions} | null`, defined once in the Goal Definition step, stays exactly as-is. What changes is how it's *represented on the canvas*: today, "the goal" only ever appears baked into an auto-generated Split's label text (`dcGoalLabel(goal) + '?'`). Under the new model, the goal is referenced by name from every Goal Check node, but still defined in exactly one place. Selecting a Goal Check node doesn't duplicate the goal's configuration into a per-node form — it shows a read-only summary with a direct link back to the Goal Definition step. This is the single clearest way to communicate "this isn't a local setting, it's the one campaign goal" without any new UI chrome.

---

## 5. Recommended goal-check model

**This is the highest-priority change, per the brief.**

### Current problem
A goal-check is not a distinct thing in the data model — it's a `SPLIT` node whose `_config.basis === 'Goal reached'`, auto-created by `dcConfirmAddNode` after every `SEND`/`CHANNEL_FAILOVER`/`PAUSE`. Visually and structurally it is *identical* to a user-built Condition node. That's exactly why "Goal Check" and "Conditional Split" read as competing concepts (brief §1E) — because today, one of them *is* a special case of the other, not a distinct thing.

### Proposed solution
Introduce `GOAL_CHECK` as a real, first-class node type — not a `_config` flag on `SPLIT`.

- **Auto-inserted** after every Send/Channel Failover/Pause (unchanged trigger conditions, unchanged automatic wiring: Yes → auto-created Goal Reached, No → open slot).
- **Not offered as a generic Add Step option.** (Revised in v2 — see "Manual Goal Check," below.)
- **Zero local configuration.** No form fields, no Basis dropdown, no Source picker. It always asks exactly one question: "Has `{the campaign's one goal}` been reached?" — selecting it shows that goal's name + a jump link to Goal Definition, never an editable condition builder.
- **Removal of "Goal reached" as a Condition Basis option.** Condition's own Basis dropdown becomes just the custom-condition sources (Previous step outcome / Account attribute / Entry event attribute) — no more a Condition secretly *being* a goal-check depending on a dropdown value.

### Visual weight (v2 clarification, sharpened in v3)
"Compact" does not mean "less visible," and lower visual weight does not mean lower semantic recognizability — the opposite failure mode (a Goal Check that blends into the canvas or reads as decorative) is exactly as wrong as the current problem (a Goal Check that looks identical to a user-built Condition). The target is: **smaller footprint, higher recognizability.** Concretely (Phase 2 will execute this, but the requirement is locked in now): a Goal Check gets its own distinct icon and accent treatment that appears *nowhere else* in the taxonomy, so it's identifiable from shape/color alone before reading a single word of label text — while occupying less canvas height than a Send or Condition, because it genuinely carries less information (no config, one fixed question). Compact and quiet are about *footprint*, not about *how identifiable it is*.

**v3: the distinction must be structural and semantic, not merely visual (icon/color).** Icon and accent are the *surface* of the distinction, not the source of it — if that were all there was to it, a future restyle could accidentally erase the difference. The real, underlying distinction a user should come away with is a fixed pair of questions that never blur into each other:

> **Goal Check** = *"Has the configured campaign goal been achieved?"* (one question, always the same shape, never configured per-node)
> **Condition** = *"Does the customer satisfy these conditions?"* (a question the user wrote themselves, can be anything, always has a config form behind it)

This is already structural, not just a styling choice: a Goal Check has **no configuration form at all** (§12) — selecting one shows a read-only link to the one campaign goal, never an editable condition builder. A Condition always opens a form with attributes/operators/values to fill in. The icon and compact sizing are there to make that structural fact *legible at a glance*, not to manufacture a distinction that doesn't otherwise exist — so even if Phase 2 styling were stripped away entirely, clicking the node still immediately reveals which kind it is, because the two experiences behind the click are categorically different, not differently skinned versions of the same form.

### Manual Goal Check (v2 — reconsidered; confirmed in v3)
The brief asks whether Goal Check should be freely available as a normal Add Step, and — if there's really only one legitimate manual use case — whether that use case should be solved directly instead. **v3 re-asked this exact question** ("define the legitimate user scenarios that require manual insertion... do not make it easy for users to unnecessarily add repeated Goal Checks") — the analysis and decision below already satisfy it: the default/automatic behavior stays unchanged, and no manual add path exists at all.

There is exactly one: checking "has the goal already been reached" at a point the automatic insertion doesn't cover — concretely, right after Entry, before the first Send, which matters for a recurring/scheduled audience where someone may have already converted since the last time the journey ran. Every other point in the graph where a goal-check would matter (after any Send/Pause/Channel Failover) is already covered automatically.

**Decision: remove `GOAL_CHECK` from the Add Step picker entirely.** It becomes 100% system-generated — never user-added, in any context. This also fully resolves the brief's "prevent duplicate/consecutive goal checks" concern structurally rather than via new validation: if there's no manual add path, there's no way to create one by hand, and the automatic insertion logic never fires a Goal Check immediately after another Goal Check (only after Send/Pause/Channel Failover).

The one real use case (goal-check on entry) is **not** solved by exposing the generic node. The direct fix is a specific, named toggle on the Entry step itself — something like "Also check the goal immediately when someone enters" — which, when enabled, inserts the same automatic Goal Check the system already knows how to build, right after Entry, with no new node type exposed to the user and no way to misuse it. **This toggle is a proposal, not an approval-in-progress** — flagged with exactly the same discipline as Re-entry below: documented here as the recommended direct solution, but not built unless separately approved, so this IA pass doesn't quietly grow new product behavior under the banner of a naming/structure cleanup.

### Goal Reached (v2 — reconsidered; confirmed in v3)
The brief separately asks whether **Goal Reached** should be user-addable at all, given it's the exact outcome type that produced the dead-end problem demonstrated live earlier this session (an unconditional terminal node added after a plain action, with no branch and no way back). **v3 re-confirms the intended default relationship** — Goal Check's "Yes" arm auto-generates Goal Reached as a system outcome — and asks that any surviving manual path be documented with a genuine use case before being retained. The use case and constraint below are that documentation.

**It should stay user-addable, but only for one specific, named use case — not as a generic terminal option offered everywhere an Exit is offered.**

The legitimate case: labeling an *already-decided* branch of a Branch/Decision node as the goal outcome — e.g. an EMI-status Branch whose "Successful" arm should mean the campaign goal was achieved. Here the branching already happened (on a real attribute, with real alternatives), so marking one specific, already-forked arm as "this is the goal" adds information without creating a new dead end — the other arms already exist as separate paths.

The illegitimate case, which must stay structurally discouraged: adding Goal Reached as the sole next step after a non-branching node (Send, Wait, Channel Failover), which silently marks *everyone* who reaches that point as having achieved the goal — exactly the dead-end pattern from the live comparison, just relabeled.

**Decision:**
- Goal Reached **stays in the Add Step picker**, but only ever shown inside a branch arm of an existing Condition/Branch/Experiment node — not as a top-level option after a plain linear node.
- If a user does reach it from a linear node anyway (e.g. by first adding a Condition, then choosing Goal Reached on its only remaining open arm in a way that leaves the other arm unused), the drawer shows a direct warning rather than silently accepting the config: *"This marks everyone who reaches this point as having achieved the goal, unconditionally — did you mean to add a Goal Check first?"* This is a warning, not a hard block — there may be a rare legitimate case (a Branch with only one arm actually wired, by design) where the warning is read and dismissed.
- This is a tightened *rule about where it's offered/warned*, not a new validation subsystem — it reuses the same `isMidEdge`/context-aware picker logic already shipped for the mid-chain-insert hint (§10), applied to one more context (linear vs. branch-arm placement).

### Why this is better
It makes the distinction in brief §1E structural, not just cosmetic. A Goal Check is recognizably different from a Condition because it *behaves* differently in the UI (no config form at all) — not because of a label or an icon that could be ignored. This is the same principle that made the Entry merge work earlier this session: the UI difference should follow from a real difference in what the thing *is*, not be bolted on top of an identical shape.

### Trade-offs
- One new enum value in `DcNodeType`, one new auto-insert branch in `dcConfirmAddNode`, one new (trivial) form component that just renders the linked goal read-only. Low implementation cost.
- Every place that currently reads `node.type === 'SPLIT'` and separately checks `_config?.basis === 'Goal reached'` (label/meta computation, the `dcIsAutoGoalCheckSplit` detector, the "remove goal check" badge logic, seed data) needs updating to instead check `node.type === 'GOAL_CHECK'`. This is mechanical, not risky — it's a rename-and-redirect, not new logic. `dcRemoveGoalCheck` becomes simply `dcRemoveNode` for any `GOAL_CHECK`/system-generated node, generalized rather than goal-check-specific (useful precedent for any future system-generated type).
- Seed data migration: every existing `SPLIT` node whose `meta === 'Goal check, auto-inserted after every Send'` (or the Wait-Until outcome-check variant) becomes a `GOAL_CHECK` node instead. Mechanical, scriptable.
- Because Goal Check is never in the Add Step picker (v2), `GOAL_CHECK` is **not** added to `DC_STEP_TYPES`/`DC_TYPE_CATEGORIES`'s pickable list at all — it only ever needs to exist as a renderable node type, never as a `TypePicker` tile. This is simpler than originally scoped, not more complex: one fewer picker category, no "System Evaluation" group needs to appear in the user-facing Add Step grid (see §10A).

### Impact on existing implementation
- `graphTypes.ts` / `nodeMeta.ts`: add `GOAL_CHECK` to `DcNodeType`, `DC_NODE_META`, `DC_TYPE_CATEGORIES` (new "System Evaluation" group).
- `campaignReducer.ts`: `dcConfirmAddNode`'s Send/Pause/Channel-Failover branch creates a `GOAL_CHECK` node instead of a `SPLIT`; the Wait-Until outcome-check branch likewise.
- `labelMeta.ts`: new `GOAL_CHECK` case — label = the goal's event type name (e.g. "Card Activated"), no condition-string concatenation at all.
- `NodeForms.tsx`: new trivial read-only form (no `onChange` fields beyond nothing — it's not configurable).
- `defaultConfig.ts`: `GOAL_CHECK`'s default `_config` can be `null`/empty; `dcAddFormValid` always returns true for it (nothing to validate).
- `dcIsAutoGoalCheckSplit` → rename/retarget to check `type === 'GOAL_CHECK'` directly, no more meta-string matching.
- Seed data (`seedCampaigns.ts`): migrate every goal-check `SPLIT` to `GOAL_CHECK`.

---

## 6. Recommended split / branch model

Covered in detail in §3 (terminology) and §2 (taxonomy): **Condition** (binary, AND'd multi-attribute) and **Branch** (single-attribute, N-way range) stay structurally exactly as they are today — `SPLIT` and `DECISION_SPLIT` keep their current `_config` shapes and reducer logic unchanged. Only the display name, category grouping, and (per Goal Check above) the removal of the "Goal reached" Basis option change.

**Experiment** (was Random Split) moves out of the Decisions category into its own "Experimentation" group — same reducer logic, same `_config` shape, pure IA regrouping.

---

## 7. Recommended entry model

### Current problem
"Entity: Customer" is backend-shaped vocabulary with no business meaning attached. The entry mechanism (Segment vs. Event) and its sub-concepts (recurrence, conditions) are real and correctly modeled, but presented with internal-system naming.

### Proposed model

```
WHO          Customer / Account / Card           (the word "Entity" disappears — these are the choices themselves)
WHEN         "When something happens" (Event)  or  "On a schedule, or right now" (Audience/Segment)
RE-ENTRY     Can the same customer enter again?   ← genuinely new concept, see below
ELIGIBILITY  (was "Conditions") — what else must be true
```

- **WHO**: no data-model change — same Customer/Account/Card choice, just no "Entity" label anywhere in the UI.
- **WHEN**: this is exactly today's existing fork between `ENTRY_EVENT` and `ENTRY_SEGMENT` (the latter's own `repeat` toggle already covers "on a schedule" vs. "right now, once"). Reframe the *entry-point question* from "which type of Entry node do you want" to "when should someone enter" — same two options underneath, different framing at the point of choice.
- **RE-ENTRY (v2 — documented gap, NOT approved for implementation):** **this does not exist in the data model today.** There is no field anywhere on `DripCampaign` or any node governing whether a customer who already completed (or exited) a journey can enter it again. This is a real gap, correctly surfaced by the brief — but per explicit v2 instruction, this IA pass documents the gap and sketches *what a future model could look like*, without approving or building any of it now. A plausible future shape — `DripCampaign.reentry: { allowed: boolean; cooldownDays?: number }`, campaign-level, surfaced as a single "Can re-enter" toggle (off by default) with an optional cooldown — is recorded here **only so the gap isn't silently lost**, exactly the same treatment given to the Entry-level "check goal on entry" toggle in §5. **No re-entry data model, field, or UI is being added as part of Phase 1 or Phase 2.** It stays a known-absent capability until a separate product decision explicitly approves and scopes it.
- **ELIGIBILITY**: pure rename of "Conditions," no data-model change.

### Should Entry remain a graph node?
**Yes — keep it as a node.** Entry already participates in the same uniform systems every other node gets for free: the drawer-based add/edit flow, Undo/Redo history, the "shared/merge" badge logic (not applicable to Entry specifically, but the point is it's the *same machinery*, not a special case), and — critically for the brief's own debugging requirement (§14) — a future "customer execution trace" wants to start from a real node with a real `id`, not a synthetic journey-level marker that doesn't exist in the graph at all. The cost of keeping Entry as a node is zero: it only ever appears once, at a fixed position, and the canvas already renders it distinctly (its own category color). What *should* change in Phase 2 (visual, not now) is giving it a more obvious "this is where the journey starts" visual treatment rather than looking like just another card in the stack — but that's styling, not architecture.

### Impact on existing implementation
- **Re-entry: no implementation impact in this pass.** Nothing is added to `DripCampaign`, no new toggle, no new form section. The sketch above (`reentry: { allowed, cooldownDays }`) is recorded for a future, separately-approved pass only.
- No change to `ENTRY_SEGMENT`/`ENTRY_EVENT` node types or their `_config` shapes — the only in-scope change here is the WHO/WHEN/ELIGIBILITY relabeling, which is copy-only (no data-model change at all).

---

## 8. Recommended node information hierarchy

Applying the brief's P0/P1/P2/P3 model to every node type, concretely, against the real `_config` shape each one already has:

| Node | P0 (always) | P1 (when it helps) | P2 (rarely) | P3 (panel only) |
|---|---|---|---|---|
| **Send** | "Send" + step name | Channel + timing in plain words ("WhatsApp, 3 days after entry") | Template name (truncated) | Account, full template, variables, delivery rules |
| **Channel Failover** | "WhatsApp → SMS" | — | Template name (truncated) | Account, template |
| **Wait** | "Wait 3 days" | — | — | (nothing further exists) |
| **Wait for Event** | "Wait for [Event]" | Timeout ("up to 7 days") | — | Event category, full eligibility conditions |
| **Condition** | "Condition" + short business question *if derivable*, else generic | "N conditions" (count only, never the expression) | — | Full `ConditionRows` — exactly today's drawer |
| **Branch** | "Branch by [Attribute]" | "N branches" (count) | — | Full range/value list |
| **Experiment** | "Experiment" + name | "N variants" (count; allocation % only if it's short, e.g. "50/50") | — | Full variant list |
| **Goal Check** | "Goal Check" + the goal's short name | — | — | Read-only: full goal definition + jump link |
| **Goal Reached / Exit** | The `reason` text, truncated (~40 chars) | — | — | Full reason text on hover/selection; drawer shows the "unconditional goal" warning (§5) when placed outside a branch arm |
| **Entry** | Audience/trigger short name | Eligibility count, recurrence summary if repeating | — | Full entry config |

The current implementation already puts P3-only information in the side drawer for *configuration* — the actual gap is entirely on the **canvas card**, which today renders `meta` as a single concatenated string that can include a full condition expression (`dcCondSummary` joins every condition with `, `). That concatenation point is exactly where the fix needs to happen: canvas `meta` becomes a short, bounded summary (a count or a short derived phrase); the full detail stays exactly where it already lives today, in the drawer form.

---

## 9. Rules for handling information overload

**v3: these are hard UI principles for Phase 2, not suggestions to weigh against other concerns.** The canvas is a map of journey execution, never a database of configuration; full configuration always lives in the side panel; no node's canvas height may grow because its configuration is complex. Phase 2 must satisfy all four rules below for every node type, with no exceptions carved out for a "just this once" case.

1. **Truncate, never wrap indefinitely.** Any free-text field that can render on canvas (Send step name, Goal/Exit reason, Branch label) gets a fixed character cap (~40 chars) with an ellipsis, full text available via hover title/tooltip and always visible in the drawer.
2. **Counts, not lists.** Multiple conditions/branches/variants render as "N conditions" / "N branches" / "N variants" on canvas — never the enumerated contents. This directly fixes the literal bug shown earlier this session (a Condition's label showing `Status = Active, Status ≠ Active?` on canvas) — under this rule, that card would just read "Condition — 2 conditions," with the actual (now-also-fixed) expression visible only in the drawer.
3. **Fixed node height per size class, never content-driven.** Three classes:
   - **Compact** — Goal Check, Wait, Wait for Event, Exit, Goal Reached (P0, occasionally one short P1 line)
   - **Standard** — Send, Channel Failover, Condition, Branch, Experiment, Entry (P0 + P1, occasionally P2)
   - **Expanded** — none needed today. Every existing node type fits Compact or Standard once P3 detail is fully deferred to the panel; I'm not inventing a use for Expanded that doesn't exist yet.
4. **Prevent dead-ends at the decision point, not three clicks later.** The attribute-catalog gap (only Transaction Events / EMI Events have typed conditions) currently surfaces as a hint *after* a user has already picked an event category and opened a Condition node. Proposed fix: the Event Category picker itself (Goal Definition, Entry · Event, Wait for Event) visually marks which categories support conditions at the point of selection — not invented capability, just moving the same true information earlier, so nobody configures three steps deep before discovering a wall.

---

## 10. Recommended Add Step structure

| Context | What's offered | Rule |
|---|---|---|
| **First step** (empty graph) | Entry · Audience, Entry · Event only | Entry is only ever valid as the start of a journey |
| **After any node** (open slot / grow-leaf, linear) | Full user-facing taxonomy except Entry **and except Goal Check** (never offered, any context — v2) and except Goal Reached (see next row) | Standard case |
| **Inside a branch arm** (Condition/Branch/Experiment's open arm) | Same as above, **plus Goal Reached** | Goal Reached is offered *only* here — an already-forked arm, never a plain linear slot (v2, see §5) |
| **Replacing a node** | Same options "adding here" would offer | Replace = remove + add at the same slot |
| **Inserting mid-chain** (splicing into an already-connected edge) | Full taxonomy shown (minus Goal Check, Entry, Goal Reached — all three excluded for context reasons already, not mid-chain-specific), remaining branching types (Branch, Experiment) **shown disabled with a one-line reason** rather than omitted | See below |

**Change from what's currently shipped:** today's mid-chain picker *omits* branching types entirely with a banner explaining the restriction in prose above the grid. The brief is explicit that omission-without-explanation is worse than visible-but-disabled-with-a-reason. Proposed: show all eligible tiles always, every time, in every context; grey out the structurally-invalid ones with a tooltip ("Branching steps can't be inserted mid-chain — they'd create new paths with nothing to reconnect; add this after the step above instead"). The *reason* mid-chain insert is restricted at all remains genuine and technical (a branching type splicing into one edge has no well-defined "which new branch reconnects to what was already there" answer) — this isn't being removed, just explained in place instead of via a separate banner. Goal Check never appears in any Add Step context (v2, §5), so it needs no disabled-state treatment here at all — it's simply not a tile.

---

## 10A. Final Add Step taxonomy (user-facing) — v2

§2's 7-category internal node taxonomy (Actions / Decisions / Experimentation / System Evaluation / Outcomes / Entry, roughly) is a backend-shaped grouping — organized around *what kind of node this is to the data model*, not around what a user is trying to do. It stays as the internal/engineering grouping (§2 note below), but the Add Step picker itself should use a different, smaller, task-oriented grouping — "what do you want this step to do," not "what category of graph node is this."

**Proposed final user-facing categories:**

| Category | Contains | Why grouped this way |
|---|---|---|
| **Actions** | Send, Channel Failover | "Do something to the customer" — the two step types that actually touch the customer |
| **Wait** | Wait, Wait for Event | "Pause before continuing" — time-based or event-based, both answer "how long do we wait" |
| **Decisions** | Condition, Branch | "Split the path based on something true about the customer" |
| **Experiment** | Experiment | Kept separate from Decisions — allocation-by-chance is a different mental model from allocation-by-truth, conflating them was one of the brief's named confusions |
| **End the Journey** | Exit, Goal Reached *(only offered on a branch arm — grey/disabled elsewhere, per §10)* | "Stop the journey here" — both are terminal; Goal Reached is included but conditionally enabled, not hidden, so its restriction is visible rather than mysterious |

**Explicitly excluded from this grid entirely:**
- **Entry** — not a grid tile at all; gated separately to "first step of an empty graph only" (§10), never competing for attention alongside mid-journey step types.
- **Goal Check** — never a grid tile, in any category, in any context (v2 decision, §5). Doesn't need an "Outcomes" or "System Evaluation" user-facing category at all, because there is no user-facing category that needs to contain it — it's 100% automatic.

This is a smaller surface than the internal taxonomy: 5 user-facing categories instead of 7, two of which (Entry, Goal Check) disappear from the grid entirely rather than becoming categories of one. Fewer decisions at the moment someone clicks "+ Add Step," without losing anything — nothing in §2's internal model is deleted, this is a presentation-layer regrouping of the same underlying `DcNodeType` values.

---

## 11. Recommended structural actions

| Action | Current state | Recommendation |
|---|---|---|
| Delete a node | Visible "✕" on card hover (shipped this session) | Keep as the standard — this pattern generalizes correctly to every node type, system-generated or not |
| Delete a branch/edge with a label (Yes/No/Branch name) | Hover-reveal on the chip itself | Keep — the chip is already a visible, named target; hovering a *labeled* thing to reveal its own control is a reasonable, discoverable pattern |
| Delete a *bare*, unlabeled connector | Hover-reveal on an invisible-until-hover chip (hard to find) | Move to a control on the downstream node/slot itself — never rely on hovering empty canvas space to find a control |
| Remove a system-generated node (Goal Check) while preserving what's built past it | Shipped this session (`dcRemoveGoalCheck`) | Generalize the *mechanism* (collapse-and-reconnect) as the standard pattern for removing any system-generated node, not Goal-Check-specific |
| Replace an auto-generated node | "↻ Auto-added, click to replace" badge | Keep the mechanism; soften the copy to "System step · tap to customize" — "Auto-added" reads like something went wrong, not like an intentional default |
| Add a branch/condition row | Inline "+ Add branch" / "+ Add condition" links | Keep — already low-friction |
| Reconnect nodes (drag to rewire) | Not supported | Out of scope — not proposing new capability here |
| Destructive-action confirmation | None anywhere; Undo is the only safety net | **Keep it this way.** This was a deliberate call earlier this session, not an oversight — every mutation already goes through the same Undo/Redo history stack, so a confirmation dialog on top would be a second safety net for something that already has one, with the actual cost being an extra click on every single edit. Reaffirming, not revisiting. |

---

## 12. System-generated vs. user-configured node model

Two categories, visually distinguished but **never implying lesser importance**:

- **User-configured**: Send, Channel Failover, Wait, Wait for Event, Condition, Branch, Experiment, Exit, Entry, Goal Reached-when-manually-placed-on-a-branch-arm (the one narrow case the picker allows — see §5/§10). Always has a real configuration form with fields to fill in (for Goal Reached, just its `reason` text).
- **System-generated**: Goal Check (always), plus the specific Goal Reached node that's auto-wired under a Goal Check's "Yes" (this one specifically — a manually-added Goal Reached is user-configured, since the user chose its `reason` text themselves).

The distinction communicated on canvas is **"this step is automatically part of how the journey executes"** — not "this is less important" or "this is a placeholder." Per §1 of the brief: Goal Check must never visually disappear or read as decorative metadata. The clearest, most honest way to make this distinction *inherent* rather than a visual overlay someone could ignore: system-generated nodes have genuinely **no configuration form** (covered in § Goal Check above) — the absence of editable fields IS the signal, reinforced by (in Phase 2) a quieter visual treatment, not the other way around.

---

## 13. Before → After journey example

Using DRIP-001 ("Card Activation Reminder") from the real seed data, which already has exactly this shape today:

**Before (current, using today's actual node types/labels):**
```
Entry · Event Trigger — Card Issued
  ↓
Send — Welcome + Activate CTA
  ↓
Split — "Card Activated?" (basis: Goal reached)
  ├─ Yes → Goal-Based Exit — Activated
  └─ No
      ↓
    Pause — Wait 3 days
      ↓
    Send — Reminder 2
      ↓
    Split — "Card Activated?" (basis: Goal reached)
      ├─ Yes → Goal-Based Exit — Activated
      └─ No
          ↓
        Pause — Wait 4 days
          ↓
        Send — Final reminder
          ↓
        Split — "Card Activated?" (basis: Goal reached)
          ├─ Yes → Goal-Based Exit — Activated
          └─ No → Exit — Sequence exhausted
```
13 nodes. Every "Split" node is visually and structurally identical to a user-built Condition — nothing on the canvas tells you these three are system-generated and the campaign has no user-built Conditions at all.

**After (same 13 nodes — the point is clarity, not count):**
```
Entry · Event — Card Issued
  ↓
Send — Welcome + Activate CTA
  ↓
⚙ Goal Check — Card Activated?
  ├─ Yes → Goal Reached — Activated
  └─ No
      ↓
    Wait — 3 days
      ↓
    Send — Reminder 2
      ↓
    ⚙ Goal Check — Card Activated?
      ├─ Yes → Goal Reached — Activated
      └─ No
          ↓
        Wait — 4 days
          ↓
        Send — Final reminder
          ↓
        ⚙ Goal Check — Card Activated?
          ├─ Yes → Goal Reached — Activated
          └─ No → Exit — Sequence exhausted
```
Same 13 nodes, same execution path, zero nodes removed or hidden. What changed: every "Split" is now unmistakably a `Goal Check` (a distinct type, not a Condition wearing a particular Basis value), it carries no configuration of its own, and — in Phase 2 — it will render at the Compact size class with a quiet system-evaluation accent, so a 13-node journey visibly reads as "3 real actions + 3 system checks + 3 waits + 2 outcomes," not "10 split-shaped things with subtly different labels."

---

## 14. How the model scales to 20–50 nodes

The scaling properties come entirely from the rules already defined above, not from anything new:

- **Fixed node sizing** (§9) means node count no longer correlates with canvas sprawl the way content-driven height does today — a 50-node journey is 50 same-sized boxes, not 50 boxes of unpredictable height.
- **Goal Check as its own compact, distinctly-colored type** means a dense journey visually separates into "the real sequence of actions and waits" (Standard-sized, user-configured) versus "the recurring system checks between them" (Compact, quieter) at a glance, without reading every label.
- **Counts instead of expressions** (§9) mean a Condition with 5 AND'd attributes takes the same canvas footprint as one with a single attribute — complexity grows in the side panel, never on the map.
- **The taxonomy's four-way split** (Actions / Decisions+Experiments / System Evaluation / Outcomes) gives a natural basis for a future "collapse system checks" or "filter by category" view *if ever needed* — not being built now, but the model doesn't foreclose it, because the distinction is a real type-level property, not a label convention.

---

## 15. Key decisions and rejected alternatives

| Decision | Rejected alternative | Why rejected |
|---|---|---|
| Goal Check becomes a real node type | Keep it as `SPLIT` + a `basis` flag, just restyle it | Doesn't fix §1E's "competing concepts" problem — the sameness is structural, not visual, so a structural fix is required |
| Condition / Branch / Experiment stay three separate node types | Unify into one "Branch" node with a strategy selector (brief's Option D) | They don't share execution semantics (AND'd boolean vs. attribute-range vs. pure chance) — unifying would recreate the exact "one dropdown, wildly different downstream form" confusion already fixed elsewhere this session |
| Keep Entry as a graph node | Move Entry to pure journey-level config with just a visual start marker | Loses parity with every other node's add/edit/undo machinery for no real benefit, and works against the brief's own debugging requirement (§14) of a real node to anchor a future execution trace |
| No destructive-action confirmation dialogs | Add a confirm step before node/edge deletion | Undo/Redo already covers this; a second safety net costs a click on every edit for marginal benefit — reaffirming a decision made earlier this session, not revisiting it |
| Mid-chain insert shows all types, disabling the invalid ones with a reason | Keep today's shipped behavior (omit + explain via banner) | The brief is explicit that silent omission is worse than visible-but-explained, even when a banner already explains the *category* restriction — showing the specific disabled tiles is more precise than a generic prose note above the grid |
| **(v2)** Goal Check removed from the Add Step picker entirely — 100% system-generated, never user-added; the one real manual use case (check goal on entry) proposed as a dedicated Entry toggle, not approved/built in this pass | Keep Goal Check freely addable as a generic node type | A generic addable Goal Check re-creates exactly the "competing concepts" problem this whole section exists to fix, just with a nicer icon; the real use case is narrow enough to solve directly without exposing the generic node at all |
| **(v2)** Goal Reached stays addable, but only inside an already-forked branch arm, with a warning if placed to unconditionally terminate a linear path | Leave Goal Reached unconditionally addable anywhere an Exit is offered | This is the exact dead-end pattern demonstrated live earlier this session (unconditional terminal node, no branch, no way back) — restricting *where* it's offered fixes the failure mode structurally instead of relying on a user reading a warning they could dismiss every time |
| **(v2)** Re-entry stays a documented gap only — sketched for a future pass, explicitly NOT implemented (no data-model field, no toggle, no UI) in Phase 1 or Phase 2 | Implement a minimal `reentry` field/toggle now, since the brief raised it | Explicit v2 instruction: this IA pass must not expand into new product behaviour under the banner of an IA cleanup — re-entry needs its own separately-scoped decision, not a field added as a side effect of relabeling Entry |

---

## 16. Phase 2 visual-design brief (locked constraints, v3 — not executed yet)

This section records the agreed visual direction for Phase 2 *before* Phase 2 starts, so it's a constraint CSS work is checked against, not a set of preferences improvised once styling begins. Nothing in this section changes any code or CSS now.

**Positioning:** the canvas should read as a modern 2026 B2B SaaS workspace — closer to a clean operational dashboard than a legacy workflow/diagram editor. Keep the existing Hyperface blue/indigo identity; this is a refinement of the current visual language, not a rebrand.

**Do:**
- Use whitespace and typography to carry hierarchy — not borders, not boxes.
- Reduce visual chrome generally: fewer/lighter borders, fewer nested card shadows.
- Make system/evaluation nodes (Goal Check) visually distinct from Action/Decision nodes without making them feel unimportant — distinct ≠ deprioritized (§5).
- Keep the canvas easy to scan at 20–50 nodes (§14) — fixed sizing and counts-not-expressions (§9) are the mechanism; the visual language must not undo that by, e.g., growing a card to fit a long template name.

**Don't:**
- Don't rely on heavily bordered "cards" for every node as the primary way of showing structure.
- Don't use gradients or glassmorphism.
- Don't add animation beyond what's functionally necessary (e.g., a layout transition), and respect `prefers-reduced-motion`.
- Don't lean on excessive rounded-corner treatment as a stand-in for a real design system.

**The one constraint that overrides all visual-density tradeoffs:** Goal Checks must never be hidden, collapsed into journey-level configuration, or otherwise removed from the canvas as a way of reducing visual clutter. If a dense journey needs a density solution, the solution is compact sizing and clearer visual hierarchy (already specified in §5/§9), never making the Goal Check disappear from the execution map. This directly guards against re-introducing, via Phase 2 styling, the exact problem Phase 1 exists to fix — a goal-check that reads as invisible implementation detail rather than a real step in how the journey executes.

---

## 17. Core product model — preserved (v3 traceability checklist)

A direct point-by-point confirmation that this IA exercise has stayed an IA exercise and not quietly become a rewrite:

| Constraint | Status in this document |
|---|---|
| Preserve existing business logic | Unchanged — `SPLIT`/`DECISION_SPLIT`/`RANDOM_SPLIT` reducer logic, auto-insertion triggers (after Send/Pause/Channel Failover), and Yes/No auto-wiring are all kept as-is; only `GOAL_CHECK`'s *type* is new, its *behavior* is the existing auto-goal-check logic renamed and redirected (§5 Trade-offs) |
| Preserve existing APIs/data structures wherever possible | `DripGraph`, `DripNode`, `DripEdge`, `DripCampaign.goal` all unchanged. The only net-new, not-yet-approved data-model item anywhere in this document is `reentry`, and it is explicitly not implemented (§7, §15) |
| Reuse existing components | Add/Edit drawer pattern, `TypePicker`, `ConditionRows`, Undo/Redo history stack, `dcGraphHasOpenBranches` — all reused, none replaced (§1 Review, §5 Impact, §10) |
| Avoid inventing backend capabilities | No new backend concept anywhere — Review (§1) is a client-side read of state the reducer already computes; re-entry (§7) is sketched, not built |
| Data-model changes only where explicitly approved | The only data-model change actually being made is renaming `SPLIT`+`basis` to a real `GOAL_CHECK` type (§5) — explicitly approved, point 1 of this round. Everything else proposed (`reentry`) is marked not-approved |
| Keep Entry as a graph node | Confirmed unchanged (§7, "Should Entry remain a graph node?") |
| Keep Goal as one campaign-level definition referenced by Goal Check nodes | Confirmed unchanged (§4) — Goal Check nodes read the single `DripCampaign.goal`, never duplicate it |
| Keep full configuration in the existing drawer/panel pattern | Confirmed unchanged (§8, §9) — canvas carries P0/P1/occasionally P2 only, P3 detail always stays in the drawer |

---

**Status after this round:** this document now incorporates every point from both review rounds (v2 and v3). Per the brief: **stop here.** No Phase 2 (visual/CSS) work begins until this updated proposal is explicitly approved.

**End of Phase 1 deliverable. No code or CSS has been modified. Awaiting review/approval before Phase 2.**
