---
name: designer-ui
description: Design, review or change any Campaign Designer / Drip Campaigns screen — layout, copy, states, canvas, or anything a client sees in a demo. Use before editing designer.css, CampaignDesigner.tsx, preview.ts, RunLogsView, KnowledgeBaseView or any wizard surface, and whenever asked whether a screen is demo-worthy.
---

# Designing this product's screens

This is a bank-facing product shown to external clients. A screen is finished
when a campaign manager who has never seen it can tell, in ten seconds, what
the agent knows, what it is proposing, and what they are being asked to do.

## Look at it before you change it

Do not reason about a screen from the source. Render it.

```bash
npm run dev:designer                 # leave running
npm run ux:shots                     # .ux-shots/*.png, every screen
npm run ux:shots -- --width 1280     # the laptop a demo runs on
npm run ux:shots -- --only 03        # one screen while iterating
```

`scripts/ux-shots.mjs` replays recorded turns from `eval/runs/` into the SSE
endpoint, so the screens are the real ones with no model call. Open the PNGs.
Each screen is shot twice — at the fold and full-page — because a decision
below the fold is a decision nobody makes.

Two things this repo has relearned the hard way: **a screenshot that looks
broken is usually geometry, not styling** (measure the element before blaming
the chip), and **a `--stat | tail` is not a measurement** (check the file).

## The foundations are already set. Use them, do not re-invent them.

- **Tokens live in `src/tokens.css`**, derived from the Hyperface logo, with
  every legacy variable name remapped onto them. Use the semantic names
  (`--accent`, `--surface`, `--border`, `--text-muted`, `--t-sm`, `--r-lg`).
  A raw hex in a component is a bug — the palette has to move in one edit.
- **Inter is self-hosted** via `@fontsource-variable/inter`. Do not add a font
  link; the CSP on published pages blocks it and the fallback is silent.
- **Light only. No dark theme, ever**, on any surface of this product. The one
  navy region is the nav rail, which is product chrome, not a theme.
- **The accent is navy, not the brand teal.** Teal fails contrast at small
  sizes and collides with "success". Teal stays decorative: the logo, a live
  dot, a progress fill.

## What a client must never read

The agent's internals are the product's credibility. Every one of these has
been on screen in a real run:

- Tool-result text written **for the model** — "3 question(s) recorded. Now
  write your message, asking them directly."
- Timings and step counts as the dominant element — "Agent responded 105.8s
  Details", "8 steps in this run".
- Internal mechanics — "Question round 1 of 8", "discovery rounds",
  "blueprint", "tool", "gate", "block", "fork".
- Raw field paths and error shapes — "The design could not be built:
  steps[0].branch."
- Third person about the person reading it — "I've sent these questions to
  the campaign manager."

Run detail belongs behind one **Details** affordance, or on the Chats page.
Not in the conversation column, and never above the decision.

## Copy

Short, complete sentences. No em-dash compound clauses. Say what happens, in
the manager's words: *messages*, *who enters*, *what we are testing* — not
*sends*, *entry conditions*, *arms*. A control says exactly what it does
("Confirm and generate"), and the state that follows says it happened.

One affordance per action. If a dropdown already offers "no goal", do not add
a "Clear goal" link beside it.

## Layout rules this product has paid for

- **No dead pane.** The work surface is ~60% of the screen; if it holds four
  small cards at the top and a skeleton pinned at the bottom, it reads as
  broken. Content fills, centres, or the column narrows.
- **Set the reading measure, not the pane.** Prose caps near 65–72ch. A canvas
  or a journey must NOT inherit that cap — `.cd-page > *` once squeezed a
  twenty-node graph into 1024px of a 1900px window.
- **The decision is above the fold** and never below a telemetry list.
- **Wide content scrolls inside its own container.** The page body never
  scrolls sideways.
- **Every path of every fork is drawn**, including the empty one. A schematic
  that silently drops the untreated arm tells the manager the campaign reaches
  everyone when it does not.
- **Align to a grid.** Shared baselines and even gaps are most of what makes a
  screen read as deliberate.

## States are not an afterthought

Every surface needs four, written before the happy path is polished: empty
(what to do first), loading (what is happening, in a sentence), error (what
went wrong and the next move, no stack text), and blocked-but-honest (the
thing was built and something is still outstanding — say which, offer the fix).

An error is not a red headline with a field path. It is one sentence a manager
can act on.

## Before you call a screen demo-ready

1. Shot at 1440 **and** 1280, both looked at.
2. No internal vocabulary anywhere on it (list above).
3. The primary action is visually primary, and reachable without scrolling.
4. Prose has a measure; the canvas does not.
5. Empty, loading, error and blocked states all exist and all read as sentences.
6. Keyboard focus is visible; `prefers-reduced-motion` respected.
7. `npx vitest run tests/unit` and `npx playwright test` green — e2e selects by
   label and role, so a renamed field or a removed control fails loudly rather
   than silently.

## When you change a surface

Source-text pins exist across `tests/unit/` for client-facing copy and for
structure (`chatHistory`, `fourScreens`, `colleagueVoice`). A pin that goes red
is usually telling you a claim in the UI stopped being true. Retarget it to the
new truth with the reason in the file — do not delete it, and do not rewrite
the UI to keep a stale pin alive.
