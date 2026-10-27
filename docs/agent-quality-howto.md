# How to implement the quality roadmap

You change code. Paste the diff here for review. Bar: `eval/baselines/target-quality/`.

Work **seed + Step 1 + Step 2** in one pass — they only work together. Then Step 3. Step 4 only if a run still ships the ladder.

Do not add engine features.

Many unit tests **pin the old prompt wording**. When you change `SYSTEM`, update those tests in the same commit or CI will fail and look like a product regression. The tests to expect:

- `tests/unit/promptMethod.test.ts` (reads `SYSTEM` from source; pins “simplest journey”, “Do not add a branch because the builder supports one”, entry-event before sequence)
- `tests/unit/strategyOptions.test.ts` (same)
- `tests/unit/discoveryIsBusinessOnly.test.ts` (keep these passing — they are the phase split)
- Anything that assumes `preferLowerCostChannelFirst: true` or `minHoursBetweenMessages.value === 48` as a **hard** rule (`agent-proto/planner.ts` still reads both)

---

## A. Seed data

### A1. `agent-proto/context/bank-context.json`

**Risk appetite** — today `"level": "conservative"` with “fewer, better-targeted messages.”

Replace with unspecified. Example:

```json
"riskAppetite": {
  "level": "unspecified",
  "notes": [
    "No appetite on file. Design a full plan: more touches and tests where two reasons compete. Do not thin the campaign to be ‘safe’.",
    "If a later issuer file sets conservative, cut number of touches and tests only — not the idea."
  ],
  "assumption": "PRODUCT DEFAULT when missing"
}
```

**Cheaper-first** — today `"preferLowerCostChannelFirst": { "value": true }`.

Set `"value": false` and a comment: do not lead with email because it is cheap. Indian retail: WhatsApp and in-app are how people read; email is backup; SMS is reach.

**48 hours** — today under `hardConstraints.minHoursBetweenMessages.value: 48`.

Do **not** delete the key if TypeScript still requires it (`planner.ts` reads `bank.hardConstraints.minHoursBetweenMessages.value`). Move the *meaning*:

- Keep the key so code compiles, **or** add `softPreferences.minHoursBetweenMessages` and point `knowledge.ts` at the soft one.
- In the JSON `$comment` and in `knowledge.ts` (see A3): label it **preference, not hard**. “Do not nag. You may write sooner if they just opened or clicked.”

**Channels** — add an in-app row next to WhatsApp:

```json
{ "channel": "IN_APP", "relativeCost": 1, "available": true, "assumption": "CONTEXT for strategy. Builder send types may not include this yet; if so, say so at build, do not drop it from the plan." }
```

Tenant `availableChannels` may still be SMS/EMAIL/WHATSAPP only. That is OK for this pass: knowledge dump is what the strategist reads. Do not add a new `Channel` union in `sharedConstants.ts` yet (that is engine).

**Market** — do not rewrite India / ₹ / WhatsApp / UPI / EMI / festive. That is the right seed.

**Calendar** — keep festive entries. Change scope/comments from “not integrated” to: use this in the plan (e.g. do not wait out Diwali if the statement is open now).

**Similar-campaign history** — `knownGaps` already says none. Leave it none. Do not add fake OS→EMI or PIN results.

### A2. `agent-proto/context/principles.json`

- **P-001, P-002** (2% / 0.5% conversion): change `classification` to something the prompt must ignore, or replace `statement` with: “No campaign performance history for this issuer. Do not use a conversion rate.” They are currently `verified` and get into the KB as facts.
- **P-010**: replace cheaper-first with: for Indian retail cardholders, do not lead with email because it is cheapest. Prefer WhatsApp and in-app for a first real ask. Email is backup. SMS is reach.
- **P-011**: replace 48h fatigue with: do not repeat the same ask every two days. If they just opened or clicked, the next message can be the same day (still outside quiet hours).
- Keep P-003 (7-day EMI request window) only as a **product fact**, not “we ran this campaign.”
- Keep P-006 (holdout) and P-008 (stop when goal hit).

### A3. `server/knowledge.ts`

This file **copies** JSON into the prompt. If you only edit JSON, this still says 48h is a hard constraint:

```ts
push({ category: 'Operational constraints', label: 'Minimum hours between messages', value: String(hc.minHoursBetweenMessages.value), ... status: 'invented', scope: 'hard constraint' });
push({ ... label: 'Prefer lower-cost channel first', value: String(bank.softPreferences.preferLowerCostChannelFirst.value), ...});
push({ ... label: 'Risk appetite', value: `${bank.riskAppetite.level}. ${bank.riskAppetite.notes.join(' ')}`, ...});
```

Change:

- 48h → category `Preferences`, scope `preference, may send sooner if they just engaged`.
- Cheaper-first → value false, scope as above.
- Appetite → `unspecified` notes.
- After the channel loop, push `IN_APP` if you added it only in knowledge and not in the JSON loop (the loop is enough if JSON has the row).
- Add one KB line under Market if missing: “The campaign manager and customers are in India. Write like a colleague there.”

Quiet hours stay in Operational constraints. Do not ask the manager; the prompt change below forbids asking.

---

## B. Step 1+2 — Prompt (same pass as seed)

File: `server/orchestrator.ts`

### B1. Opening of `SYSTEM` (around line 370)

Today: generic “bank card-programme” + manager who has never seen internals.

Add, in that first block, complete sentences:

- You are talking to a campaign manager at an **Indian** card issuer. Customers are Indian retail cardholders.
- Write plain, complete sentences. Use ₹ and lakh/crore if amounts come up. Do not use internal words (fork, dimension, rail).
- WhatsApp and in-app are how people actually read. Do not start with email because it is cheap.
- At most three questions per turn. Do not offer sample answers, rupee cutoffs, or “e.g. 7 days vs 14.”
- Never ask quiet hours, Sundays, which channels exist, or DND. Those are in the knowledge base. Apply them. DND is configured later; do not design from a DND list.
- If risk appetite is unspecified, design a **full** plan. If conservative, cut number of touches and tests only.

### B2. Delete or rewrite these GROUND RULES / method lines (they cause bad runs)

| Line (today) | Do this |
|---|---|
| “Use only the events, entities, attributes… the tools report” | **Remove from discovery/strategy.** It forces event questions on turn one. On **build** turns, `systemForPhase(true)` can keep a build-only rule: then you may use what the tools report. Easiest: put that sentence only in the build half of `systemForPhase`, not in the shared `SYSTEM`. |
| “Work through this… skip what it does not, and say which parts you skipped” | **Remove** “say which parts you skipped.” That is the other-product speech. Keep “go deeper where this objective needs it.” |
| “Read the real attribute list and ask which customer differences…” | **Rewrite:** name 2–3 **business** differences that could change **this** goal (e.g. who already has the app, who already started a request, assigned limit) **without** numbers. Do not read builder fields in discovery. |
| “simplest journey” + “Do not add a branch, a reminder or an experiment because the builder supports one” | **Rewrite:** the plan must say what happens if they do not get the message, do not open it, open and do not click, click and do not convert, and if they convert (stop). A chain of three messages on a fixed clock is not a plan. Do not add branches *only* because the builder has them — add them because customer behaviour differs. |
| “Respect … minimum spacing, quiet hours” as if 48h is hard | Quiet hours: obey, do not ask. Spacing: do not nag; same-day OK after a click. |
| “there is no question count” vs max 3 | Keep **at most 3**. Remove “there is no question count.” |

`systemForPhase` today only strips a leftover `"blueprint":{` blob (often a no-op if that string is gone). **Use it** to send a shorter discovery `SYSTEM`: no events/attributes/step kinds; no “check before you commit to an entry trigger.”

`buildContextPrompt` sends the PHASE'S OWN STICKY and nothing else about the turn's job. The three per-phase blocks it used to carry — `# NO BLUEPRINT THIS TURN`, `# THE PLAN YOU PUT UP MUST CARRY ITS PATH`, `# THIS TURN BUILDS THE APPROVED PLAN` — are deleted, because each restated its sticky in different words and the asking one told a discovery turn to describe the journey in `strategy.approach`. Do not add a second block beside a sticky, and do not put `blueprintVocabulary` on discovery: the catalogue is a tool call on the turns that write steps, never a paste.

### B3. Strategy voice (still in SYSTEM, section 3 / 6 / 7)

Tell it to split **What I am taking from you** vs **What I am adding** (plain language, not bracket tags).  
If they cannot rank two reasons, the test sits only on people who **saw** the message and did not start — not on the whole base, not on people who already started the request.  
If there is no similar-campaign learning in the KB, do not speak as if we already know what works. If a learning **does** appear later, say it was a learning and ask if they are sure about their datapoint.

### B4. Tests you must retarget (same commit)

`promptMethod.test.ts`:

- Change the test that requires `/simplest journey/` and `/Do not add a branch, a reminder or an experiment because the builder supports one/` to pin the **new** sentences instead (behaviour tree; do not add a branch *only* because the builder has one).
- If you move “use only events the tools report” to build-only, add: `systemForPhase(false)` does **not** contain that line; `systemForPhase(true)` may.

Do not weaken `discoveryIsBusinessOnly.test.ts`.

---

## C. Step 3 — Dimensions must be about customers

File: `server/discovery.ts` — `recordDimensions` (around 1738).

**How:** before `merged.push`, skip (or mark `unavailable` with a note, and **do not count toward the 3**) any name/rationale that is clearly implementation. Cheap, strict list of substrings is enough for this pass:

- entry event, event type, event category  
- which channel, channel preference, first channel  
- template, quiet hours, DND, DNC, NPA  
- step kind, node type, builder, platform  

If the model still *asks* those, that is a prompt issue (Step 1). If it *records* them as dimensions, the gate must not treat the brief as complete.

`discoveryIsComplete` / `MIN_DIMENSIONS_CONSIDERED` stay at 3 — but 3 **customer** dimensions.

Add tests in `tests/unit/discoveryDimensions.test.ts` or `discoveryEnforcement.test.ts`:

- recording “Which event to enter on” does not increase the countable list  
- recording “App already on the phone” does  

Do not lowercase-match `channel` inside unrelated words if you can avoid it; match phrases.

Fallback questions in `evaluateDiscovery` (~675): they are generic. Optional in this pass: leave them, because if Step 1 works the model asks first. If you touch them, make them goal-free and still unanchored (“What has to happen for you to say this worked?”) — no EMI/activation examples.

---

## D. Step 4 — Only if 1–3 still produce the ladder

Do **not** implement this until you have run OS→EMI once after A–C.

If the propose still looks like EMAIL → SMS → WhatsApp + 48h:

In `orchestrator.ts`, when `proposed` is set and it is **not** a build turn, if `strategy.approach` (joined) matches a cheap heuristic — e.g. contains `EMAIL` and `SMS` and `WHATSAPP` and (`48` or `cheapest`) and does **not** mention open/click/started — treat as not ready: keep phase discovery, reply that the plan is still a single sequence of messages, and they still need what happens if someone does not open or does not click.

Keep this dumb on purpose. No new graph schema.

---

## E. Step 5 — Confirm build is still after approve

Already true if you do not break it:

- `isBuildTurn` = confirm or refinement (`orchestrator.ts` near the start of `orchestrateStream`)
- `toolsForPhase(designSeen)` — `BUILD_TIME_TOOLS` = `list_event_types`, `list_audience_attributes`, `list_step_types` withheld until the design step on a **build** turn (`server/agentTools.ts`)
- `outputToolsForPhase(false)` has no `build_campaign`

**Do not** set `designSeen = true` on a converse turn. **Do not** add those three tools back to discovery “so questions are more accurate.”

Check: a discovery turn’s tool list is only `list_channels`, `check_template_availability`, plus output tools except `build_campaign`.

---

## F. How to verify (you run, then I review)

From `drip-campaigns/`:

```bash
npx vitest run tests/unit/promptMethod.test.ts tests/unit/discoveryIsBusinessOnly.test.ts tests/unit/discoveryDimensions.test.ts tests/unit/discoveryEnforcement.test.ts tests/unit/strategyOptions.test.ts
```

Then one live OS→EMI first turn + propose (designer or eval). Compare to `eval/baselines/target-quality/os-to-emi.md`.

**Pass:** first questions are success / who converts / a customer difference they did not name. Propose splits never-started vs already-started (or says it still needs that). Test only where two reasons compete. No “lead with EMAIL because cheapest.” No “3 of 4 messages.” No asking quiet hours or DND.

**Fail:** one event/KYC/channel question then the ladder. Send me that transcript; we adjust prompt/gate, not the engine.

---

## G. Do not do in this pass

- New `Channel = 'IN_APP'` in `sharedConstants.ts` and Send forms  
- Real morning/evening wait nodes  
- DND  
- Persist `brief`/`session` in `src/designer/storage.ts`  
- Rewriting `blueprintVocabulary` / compiler  

Those wait until the two target briefs no longer look like `agent-proto/runs/evaluation/S1-*.json`.
