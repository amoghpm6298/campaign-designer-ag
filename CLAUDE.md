# drip-campaigns — Journey Builder React port

Source of truth for this specific React app (`ib-face-mock/drip-campaigns`),
the React/Vite port of the original plain-HTML Drip Campaigns prototype that
still lives in `journeysnudgesemi`. That folder's own `CLAUDE.md` documents
the *original* prototype's history — this file documents the port's own,
separate history going forward. Early phase work (Phase 0 data/reducer port
through Phase 5 cutover, the Phase 2 visual-design-system pass, the 3→4-step
wizard rebuild) is in the git log as its own commits; this file picks up
from the round below.

## 2026-10-08 — Channel Failover merge, canvas node-design refinement (P0/P1/P2), 4-step rail, width tuning, goal-check bug fix

A long, iterative round driven by direct screenshot feedback, several
distinct pieces:

**Channel Failover folded into Send.** It used to be its own chained node
type (`CHANNEL_FAILOVER`) — now it's an optional `fallbackChannel` on
`SEND` itself (same send, not a separate step), removed from `DcNodeType`
entirely. The Send card shows the primary channel's icon plus, only when a
fallback is configured, the fallback channel's own icon in the same row
(tooltips: `"{channel} · Primary channel"` / `"{channel} · Fallback if
{primary} delivery fails"`) — no channel name as text anywhere on the card.
Migrated the 2 real seed instances by folding one into its preceding Send's
`fallbackChannel` and removing the other as purely redundant with the plain
Send already next to it.

**Canvas node-design refinement — the big one.** Established and applied a
hard rule: *the canvas is an execution map, not a configuration database*.
Every field on every node type was classified P0 (essential, canvas)/P1
(useful, canvas if it genuinely helps)/P2 (config detail, drawer-only), and
the canvas was stripped down to match:
- Entry·Audience: recurrence only (nothing if not repeating) — entity +
  conditions dropped.
- Entry·Event: event category only — conditions dropped.
- Send: step name, template name (own icon, no "Template:" prefix, dropped
  if identical to the step name), timing (clock icon, 12-hour "11:00 AM"
  for absolute / "X days after {anchor}" for relative — no more bare
  ambiguous "11:00"), fallback as its own separated row — account dropped
  entirely.
- Wait for Event: resized `compact → standard`; timeout only, category +
  conditions dropped.
- Condition: kept as-is after an explicit correction — a single *simple*
  condition still gets a real human-readable summary ("Status = Active?"),
  only 2+/complex conditions collapse to "Custom condition" + count. Never
  renders raw operators/values regardless of count; height stays bounded
  (1 condition and 5 conditions render at the same height).
- System-generated badge and Goal Check's "Remove goal check" action:
  de-emphasized from filled colored pills to plain colored text, no
  background — still full-strength color (not disabled-looking), just not
  shouting.
- Reused-node badge: "Reused in N places" → compact "↗ N" + tooltip.

**Top-right is reserved exclusively for the hover remove "✕."** Previously
Entry's START badge and Send's fallback icon were both pushed to the card's
right edge via `margin-left:auto`, which visibly collided with the hover
remove button on short labels (e.g. "ENTRY · EVENT"). Fixed at the shared
card component level, not per-node: all content now flows left-aligned/
inline, and any card that can show the remove action reserves a small fixed
gutter in its identity row at all times (`.dc-node-card.has-remove
.dc-node-type { padding-right: 16px }`) so nothing can ever land under it,
hover or not.

**Node width.** All node types already shared one `DC_CARD_W` constant feeding
dagre (compact/standard only ever differed by padding/min-height) — went
186px (too narrow, routinely truncated) → 440px (too wide, canvas felt
sparse) → **400px**, the final value, picked by visually validating a dense
real campaign at each step.

**Creation-flow rail.** Replaced the single-row horizontal breadcrumb with a
persistent left rail (modeled directly on this product's own Nudges/Batch/
Incentive wizards) across all 4 steps, Builder included: Back link → title
(folded "New/Edit Campaign" into the one group label, dropped the separate
line that was duplicating it) → numbered-circle stepper with a connecting
line, filled-blue circle + white checkmark when done. Added a 4th step,
**Review**, after Builder — a plain read-back (Campaign/Scope/Experimentation/
Schedule/Goal/Journey) with Save as Draft/Submit for Approval, which moved
here from Builder's old header. Footer CTAs on Basic Details/Goal/Review are
sticky to the viewport bottom and right-aligned. Removed "Skip to Builder";
"Continue to Goal" is now always enabled (not gated on a filled-in name).
Goal's own intentional empty-state gate ("Define a goal" button before the
form appears) was removed too — the form is always there now, leaving Event
Type unset still means no goal, same semantics as before.

**Real bug fix, not cosmetic:** Wait for Event's auto-insert used to wire
its Yes branch straight to a "Goal Reached" node for any *unambiguous*
event (no promoted status attribute, e.g. `Transaction`, `Card Activated`)
— unconditionally, even with **no campaign Goal defined at all**. Surfaced
by the user directly asking "have not defined a goal but how is this
showing Goal Reached?" on a real screenshot. Fixed to require the same
symmetry the sibling status-attribute branch already had: only wire to Goal
Reached when a real Goal is defined *and* it's specifically this event;
otherwise the Yes branch stays open, same as every other "don't guess" case
in that function.

Verified throughout: `tsc --noEmit` clean, unit tests (73 → 75 after the
goal-check regression coverage), e2e tests (26/26 throughout, several
selector/flow updates for the removed Skip-to-Builder and the renamed
fallback DOM classes), clean production build, and real Playwright
screenshot verification at every step (not just test-suite green) — this
whole round was driven by the user reviewing actual rendered screenshots,
not spec compliance alone.

## 2026-10-08 (cont'd) — Re-entry + Guardrails, Basic Details IA cleanup, copy density pass

**Re-entry**, on Basic Details: a one-time gate, distinct from Guardrails
below — checked only when a customer finishes the journey (reaches Exit or
Goal Reached), not on every node. Modeled as `allowReEntry: boolean` +
`reEntryCooloffDuration`/`reEntryCooloffUnit` on `DripCampaign`, reusing
Pause's own `duration`+`unit` shape. Off by default; cool-off of 0 means
immediate re-entry once enabled.

**Guardrails**, a new 5th step (Builder → Guardrails → Review): DNC and NPA
exclusion lists, modeled as `guardrails: { dnc: boolean; npa: boolean }`,
both on by default. Checked continuously at every node — the opposite
execution model from Re-entry's one-time gate, which is why they're two
separate concepts rather than one "exclusions" section. Campaign-priority
/ cross-campaign arbitration (drop a lower-priority campaign when a
customer qualifies for two at once) was discussed and deliberately pushed
to backlog — it needs a cross-campaign evaluation engine this app doesn't
have; per-campaign config can't honestly solve it.

**Basic Details Issuer/Program redesign**, iterated twice in one session
before landing: first pass moved Program(s) to a closed-by-default
`MultiSelectDropdown` (reusing the component already built for Conditions'
multi-select attributes); the user then pointed at a screenshot of the
Nudges wizard's own Issuer/Program layout and asked for that instead —
Issuer dropdown → new **"Apply to all current and future programs"**
toggle (`applyToAllPrograms: boolean` on `DripCampaign`, ported
`.toggle-row`/`.toggle` CSS from the Nudges prototype) → Program as
inline toggle chips (reverted to `ChipPicker`), dimmed and showing "All
programs selected" once the toggle is on. Also removed every
`wiz-group-label` section heading on Basic Details ("Campaign Details",
"Scope", "Experimentation", "Re-entry", "Schedule") per direct request —
fields now flow directly, grouped only by spacing.

**Removed a redundant "Clear Goal" link** on the Goal step — the adjacent
Event Type dropdown already has a "No goal — leave unset" option that
does the same thing; a second control for the same action was pointless
UX clutter, caught by direct user review.

**Copy density pass, app-wide**: several hint/sub-text strings across
Basic Details, Goal Definition, Conditions, Guardrails, and the node
config forms (Pause, Send fallback, Decision/Random Split, mid-chain
insert) were long em-dash-joined compound sentences — flagged directly
("these are v dense copies"). Rewritten throughout as short, complete
sentences with no em-dash joins. This is now a standing rule for all
future copy in this app, not just a one-time cleanup.

Verified: `tsc --noEmit` clean, unit tests (75/75 throughout), e2e tests
(26/26 — 2 of them needed a `Continue to Guardrails` click inserted ahead
of their existing `Continue to Review` click, since Guardrails now sits
between Builder and Review), clean production build, and Playwright
screenshot verification of every visual change (toggle on/off states,
chip selection, dimmed Program picker).

## 2026-10-08 (cont'd) — Condition/Branch gap fixes; re-entry + repeating-audience spec

A pass driven by a built node-reference doc (an Artifact — every node's
config fields, dropdown values, and outputs, read directly off
`defaultConfig.ts`/`nodeMeta.ts`/`sharedConstants.ts`) surfacing real
gaps once everything was written down in one place:

**Condition (SPLIT) now actually validates.** It previously had no entry
in `dcAddFormValid` at all — you could save a Yes/No fork that checked
nothing (no outcome picked, zero conditions). Now requires a real
`outcome`, 1+ `customConditions`, or (new) a defined campaign Goal,
depending on source.

**Condition gained a 4th source: "Goal."** Previously there was no way
to manually check "has this customer achieved the campaign goal?"
anywhere except via the auto-generated, non-removable-content
`GOAL_CHECK` node that only ever appears right after a Send/Pause.
Picking "Goal" as a Condition's source checks the same thing manually,
anywhere in the graph, blocked if no campaign Goal is defined yet.

**Branch (DECISION_SPLIT) now properly supports multiSelect/smartTag/list
attributes.** Its own per-branch value field was a separate, incomplete
implementation that silently fell through to a plain text input for
those types (e.g. "Engagement Tier"), while Condition's equivalent
(`ConditionRows.tsx`'s `ValueField`, now exported) handled them properly
via a real checkbox picker. Branch now reuses that same component, plus
the matching "Any of" operator auto-fill multiSelect needs. The
`dcAddFormValid` check for Branch was also fixed to recognize a
multiSelect branch's `values[]` as a filled-in value, not just `value`
(it previously always rejected multiSelect branches as incomplete).

**"Previous step outcome" now accounts for a Send's fallback channel.**
Previously it only ever looked at the primary channel
(`previousStepChannel` in `DripBuilder.tsx` returned a bare `Channel`),
even though a fallback channel could be the one that actually delivered.
Now carries both (`PrevStepSend = { channel, fallbackChannel }` in
`sharedConstants.ts`), and `deliveryStatusOptionsForSend` merges both
channels' delivery-status vocabularies — the field label reads e.g.
"(WhatsApp + SMS fallback)" when one's configured.

Verified: `tsc --noEmit` clean, unit tests (75/75), e2e tests (26/26),
clean production build, and live Playwright verification of all four
fixes (disabled/enabled Add Step states, the merged-channel outcome
label, the Goal source's info text, and a real checkbox picker for
Engagement Tier on a Branch).

**Re-entry × repeating Entry · Audience — the combined eligibility rule
(spec only, nothing to implement — this app has no execution engine):**
these are two independent flags (`repeat` on Entry · Audience; `allowReEntry`
+ cool-off on the campaign) with no code connecting them, which is a real
gap the moment a real backend executes this. The agreed rule, for any
audience pull (first run or a scheduled repeat): a customer is eligible
to enter if (1) they currently match the entry's entity + conditions,
**and** (2) they have no currently-active, unfinished run of this same
campaign — this part is a hard rule, not configurable, regardless of
Re-entry's setting, since nothing should ever double-enter someone who's
mid-journey — **and** (3) either they've never been through this
campaign before, or their last run finished (reached Exit or Goal
Reached) **and** `allowReEntry` is true **and** at least the cool-off
duration has passed since that finish. Rule 2 and rule 3 are both
needed: rule 2 alone doesn't cover someone who's already finished and
rule 3 alone doesn't stop a parallel duplicate entry for someone still
running.
