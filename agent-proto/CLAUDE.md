# agent-proto — validators, hard constraints and the regression suites

Source of truth for `agent-proto/`. Separate from `../server/CLAUDE.md`
(the agent itself) and `../CLAUDE.md` (the hand-built Drip Campaigns
builder).

This directory answers one question: **is a campaign actually compliant and
buildable?** It never designs anything. It validates, and it does so by
reusing the real application's own functions rather than reimplementing
them, so a verdict here means the same thing a verdict in the builder means.

## The thing that has already caused a false all-clear

**`npm test` does not run anything in this directory.** The regression
suites are `*.task.ts` and run only under `npm run agent:test`, with their
own Vitest config. Reporting "all tests pass" after `npm test` alone has
once meant reporting green while fifty tests in here were failing, including
a crashing planner.

Both commands must be run. There is also `npm run agent:typecheck` for this
directory's own tsconfig, and `npm run check:server` which covers it too.

| command | covers |
|---|---|
| `npm test` | `tests/unit`, i.e. the builder and the agent's own modules |
| `npm run agent:test` | the eight `*.regression.task.ts` suites in here |
| `npm run check:server` | server + eval + agent-proto + tests + docs types |

## The hard-constraint registry, and why it is shaped that way

Every known hard constraint starts at `not-run`. A check can only ever
improve on that. Anything unimplemented therefore stays in the record and
holds the outcome at `incomplete`, rather than vanishing and leaving a clean
report that was never earned.

`unverifiedHardConstraints` is the list of rules nobody actually checked. It
is meant to be non-empty when checks could not run. A shrinking list is only
good news if the checks really ran.

### The defect this shape exists to prevent, which still happened

The per-campaign message cap was invented data modelled as a hard
constraint. When it was removed (banks do not set one uniform per-campaign
limit), the check kept running, because it was gated on `limits` being
present rather than on a cap being present. `limits` still carried quiet
hours and the channel list, so it was truthy; `reach.max > undefined` is
false; and the check recorded **`status: 'pass'` for a rule it had never
evaluated**. The `else` branch written to say "Skipped rather than assumed
satisfied" had become unreachable, and a regression test was pinning the
wrong behaviour.

Fixed by gating on `typeof cap === 'number'`. The lesson generalises: gate a
check on the VALUE it needs, never on the container that might hold it.

`maxMessagesPerCustomerPerCampaign` is now optional on
`EnforceableBankLimits`, and absent in normal operation.

## Measured per customer, not per graph

`maxSendsOnAnyPath` (`graphPaths.ts`) walks customer paths. A global count of
Send nodes is the wrong number on any branching campaign: four parallel
checkpoints are each reached by everyone who entered, while two arms of a
split are reached by half each. A cycle makes the result a lower bound, and
that is reported rather than hidden.

## The context files are fiction, and say so

`context/bank-context.json` is `FICTIONAL_MOCK` and every invented value is
marked `assumption: 'INVENTED'`. `context/principles.json` carries a
classification per principle (`verified` / `observation` / `hypothesis`).
Nothing here should ever be presented to a user as a real bank policy.

Worth knowing when reading them: between them they describe channels, quiet
hours, DNC/NPA, risk appetite, conversion rates and platform mechanics, and
**nothing about why a customer converts**. That gap is what
`server/findings.ts` exists to fill, and the reasoning is written up in
`../server/CLAUDE.md`.
