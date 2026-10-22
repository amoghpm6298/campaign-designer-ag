# Target-quality conversations (not model output)

These are **hand-authored** conversations that define the bar for discovery and strategy.

They are **not** recorded agent runs. Existing files in `eval/baselines/` (`baseline-*.json`, `counterfactual-*.json`) are what the current agent actually produced — mostly EMAIL → SMS → WhatsApp ladders. Do not treat those as the quality target.

When discovery and strategy are good enough, a live run on the same briefs should look **like these**: same kinds of questions, same kind of plan, same voice. Not the same words.

## The two baselines

| File | Brief | Why it is here |
|---|---|---|
| `virtual-pin-set.md` | Virtual card issued; goal is PIN set | Behaviour tree (did not land / did not open / opened no click / clicked no PIN) plus channel and timing |
| `os-to-emi.md` | Outstanding statement → EMI | Same bar on a different goal; no prior campaign of this type; plain Indian banking English |

## Product rules these already assume

- Context in first (policy, appetite, learnings, calendar, channels including in-app). Do not ask the manager for quiet hours, Sundays, channel list, or DND.
- If risk appetite is missing → fuller plan (more touches and tests). If conservative → fewer touches and tests.
- DND is configured after build. Do not design from a DND list.
- If a learning exists and the manager has a datapoint, put the learning down and ask if they are sure about theirs. These two runs assume **no similar-campaign history**.
- Calendar is built into the plan, not asked as trivia.
- Platform capabilities only after they approve the plan.
- At most three questions a turn. No sample answers, no rupee/day cutoffs from the agent. Offer business differences (limit, app, started vs not) without putting numbers in their mouth.
- Stop messaging when the goal happens.
- Voice: complete, simple sentences. EMI, outstanding, statement, WhatsApp, in-app. No “rail,” “readout,” “spine.”

## How to use

Judge a new run against the **shape** of these files (what got asked, what got split, where the test sat, whether converted users leave). Do not require a verbatim match.
