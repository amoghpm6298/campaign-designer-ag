# agent-proto — validators and campaign helpers

Deterministic code the agent's build step relies on (`server/agent/tools.ts` →
`build_campaign`):

- `validate.ts` — checks a built graph against the app's rules and the bank's hard constraints.
- `campaignFields.ts` — turns a built graph into a `DripCampaign` with field provenance.
- `templateSelect.ts` — template choice and proposed messaging when the bank's library is not readable.
- `hardConstraints.ts`, `quietHours.ts`, `channelAvailability.ts`, `graphPaths.ts`, `planner.ts` — the checks behind the validator.
- `schema/` — generates the campaign schema artefact from app source (`npm run agent:schema`).
- `context/` — the synthetic bank context and principles fed to the agent.

Regression suites: `npm run agent:test`.
