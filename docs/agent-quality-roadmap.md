# Agent quality roadmap

**Bar:** `eval/baselines/target-quality/` (`virtual-pin-set.md`, `os-to-emi.md`).  
**You execute. Review in this chat before merging each step.**  
**Not in scope until the bar holds:** new engine, in-app as a builder channel, DND, time-of-day waits, session persist.

Done when a live run on those two briefs does **not** open with an event/channel question and does **not** propose EMAIL → SMS → WhatsApp every 48 hours.

---

## Seed data (do this with Step 1)

File: `agent-proto/context/bank-context.json` (flows into the prompt via `server/knowledge.ts`).

| Field | Today | Change to |
|---|---|---|
| `riskAppetite.level` | `conservative` | omit, or `unspecified`. Notes: “No appetite on file. Design a full plan (more touches and tests), not a thin one.” |
| `softPreferences.preferLowerCostChannelFirst` | `true` | `false`, or delete. Cheaper-first is **not** the India default. |
| `hardConstraints.minHoursBetweenMessages` | `48` hard | drop from hard constraints, or keep as a **soft** preference with a note: may send sooner if they just opened or clicked. |
| `channels.available` | SMS, WA, email, RCS | keep those; **add IN_APP** as available in **context** (strategy may use it). If the builder cannot emit it yet, that is a **build-time** limitation, not a reason to drop it from the plan. |
| `market` | India, ₹, WhatsApp, UPI, EMI, festive | **keep**. This is the India seed. |
| `eventsCalendar` | invented freeze, “not integrated” | keep 1–2 festive/high-volume rows; status so the agent **uses them in the plan** (do not wait out Diwali on an open statement). |
| Similar-campaign learnings | none, plus fake 2% / 0.5% in principles | **none for this campaign type.** Do not invent OS→EMI or PIN history. |

File: `agent-proto/context/principles.json`

| ID | Today | Change to |
|---|---|---|
| P-001, P-002 | ~2% / 0.5% conversion “verified” | remove from prompt seed, or mark **do not use** — that is fake campaign history. |
| P-010 | cheaper channel first | rewrite: for Indian retail, **do not** lead with email because it is cheap. WhatsApp and in-app are how people actually read. Email is backup. |
| P-011 | space reminders; 48h | rewrite: do not nag; **do** write sooner if they just engaged. Night window comes from quiet hours in context, not from 48h. |
| P-003 | 7-day EMI request | keep only as general IBL product fact if still true, not as “we ran this campaign.” |
| P-006 | holdout | keep. 10% comparison group is in the target runs. |
| P-008 | goal check after send | keep. |

**India (say it once in the system prompt, and keep `market`):**  
You are talking to a campaign manager at an Indian card issuer. Customers are Indian retail cardholders. Use ₹, lakh/crore if amounts come up. WhatsApp and in-app over email-first. EMI on outstanding is a normal product, competing with shop EMI in festive. Do not ask what country this is.

---

## Step 1 — Discovery must not talk about the builder

**Why:** First question today is an event or a field. Target runs ask what success is, who converts, why the rest don’t.

**Touch:** `server/orchestrator.ts` (`SYSTEM`, `systemForPhase`). Discovery + strategy turns: remove “use only events/attributes the tools report,” “read the attribute list,” “say what you skipped.” Add: at most 3 questions; no sample answers or rupee/day examples; offer 2–3 **customer** differences without cutoffs; never ask quiet hours, channel list, Sundays, DND.

**Check:** First turn on OS→EMI is not “Pending or authorisation?” / “which Product Type?”

---

## Step 2 — Stop the ladder heuristics (seed + prompt)

**Why:** Conservative + cheaper-first + 48h **are** the EMAIL→SMS→WhatsApp plan.

**Touch:** Seed table above. Prompt: missing appetite → full plan; do not treat 48h or cheaper-first as hard; do not say “simplest journey / don’t branch because the builder can.”

**Check:** A propose turn does not say “lead with EMAIL because it is cheapest” or “3 of 4 allowed messages.”

---

## Step 3 — Platform topics are not discovery

**Why:** The gate accepts three “dimensions” that are really entry event and channel.

**Touch:** `server/discovery.ts` / `recordDimensions` (and tests that pin platform dimensions as OK). A dimension must be a **customer** factor. Event, channel, template, quiet hours → not a dimension.

**Check:** Filling “which event to enter on” three times cannot unlock strategy.

---

## Step 4 — A channel ladder is not a strategy (only if 1–3 still ship the ladder)

**Why:** Intelligence stays in the prose; the plan is still three sends.

**Touch:** Light check at propose: if there is no split they cared about (started vs not / app vs not) and no “if they don’t open / don’t click,” do not accept as ready. Send back: you still owe the behaviour plan. No new node types.

**Check:** OS→EMI plan splits started vs not; test only on never-started who opened and did not click. PIN plan splits app vs not; test only on opened-and-did-not-click.

---

## Step 5 — Build stays after approve

**Why:** Looking up events in discovery is how KYC shows up.

**Touch:** Confirm `toolsForPhase` still withholds event/attribute/step lists until confirm. Do not add more lookup tools to discovery. After approve, map reached / opened / clicked onto **existing** Send / Wait / Condition / Experiment / Goal Check. If it cannot be built, say so **then**.

**Check:** Discovery turns do not call `list_event_types` / `list_audience_attributes` / `list_step_types`.

---

## Later (not this pass)

In-app as a real builder channel, morning vs evening waits in the graph, DND, persist `brief`/`session` on reload.

---

## Tracking

| Step | Owner | Status |
|---|---|---|
| Seed data (`bank-context`, `principles`, India sentence) | you | not started |
| 1 Discovery prompt | you | not started |
| 2 Ladder heuristics | you | not started |
| 3 Dimensions = customers only | you | not started |
| 4 Ladder is not a strategy | you | not started (only if needed) |
| 5 Build-after-approve still holds | you | not started |
| Review each step in chat | me | waiting |

**How we review:** paste the diff or the files you touched + one live (or scripted) first-turn + propose-turn on OS→EMI. Compare to `eval/baselines/target-quality/os-to-emi.md`.
