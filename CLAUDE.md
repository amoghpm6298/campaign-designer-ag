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
