# Hyperface Smart Engage 2.0 — setup and usage guide for your AI assistant

You are reading this because a Hyperface teammate asked you to connect them to **Hyperface Smart Engage 2.0** (the campaign designer) and help them use it. Follow the setup below, then use the tools as described in "How to use it". Speak to your user in plain words; never show them raw JSON.

## What it is

Smart Engage 2.0 is Hyperface's own campaign agent. From a brief, anything from one line ("get dormant cardholders spending again before Diwali") to a full document, it designs a full card campaign for a bank: **buckets** of customers with different reasons for not acting, and a **message journey** for each (WhatsApp, SMS, email; waits; checks; endings). It is reached through an MCP server.

**You do not design campaigns yourself.** You pass your user's brief to the designer, relay its questions and your user's changes, tell your user what was built, and submit only when they say so.

## Setup

You need the **team token** your user was given (it starts with `hfcd_`). If they have not given it to you, ask for it. Never print the token back in full, write it into any file other than the MCP configuration, or share it.

- MCP server URL: `https://ai.product.hyperface.co/campaigndesigneragent/mcp`
- Transport: Streamable HTTP
- Auth header: `Authorization: Bearer <team token>`
- Bank: the token works for **IndusInd Bank (IBL)** only.

### If you are Claude Code (you can run shell commands)

Run this, with the token in place of `<team token>`:

```
claude mcp add --transport http --scope user campaign-designer https://ai.product.hyperface.co/campaigndesigneragent/mcp --header "Authorization: Bearer <team token>"
```

Then tell your user: "Done. Restart Claude Code (or open a new session) so the Smart Engage tools load, then type `/mcp` to check that **campaign-designer** is connected with 10 tools." The tools only appear in a new session.

### If you are Claude Desktop or another app that cannot run commands

Tell your user to add this to their MCP configuration and restart the app. In Claude Desktop: Settings → Developer → Edit Config, which opens `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`).

```json
{
  "mcpServers": {
    "campaign-designer": {
      "type": "http",
      "url": "https://ai.product.hyperface.co/campaigndesigneragent/mcp",
      "headers": { "Authorization": "Bearer <team token>" }
    }
  }
}
```

If the file already has an `mcpServers` section, add `campaign-designer` inside it rather than replacing it. On claude.ai, it can instead be added under Settings → Connectors → Add custom connector, if their workspace allows custom headers; otherwise use Claude Code or Claude Desktop.

### Check it works

Once the tools are available, call `list_campaigns`. A list (possibly empty) means it works. "Missing or wrong token" means the header is wrong.

## The tools

| Tool | Use |
|---|---|
| `create_campaign(brief, questions)` | Create a campaign. `brief` can be one line or a full brief: goal, audience, success, any existing offer (exact terms), dates, limits, notes, past results, data, a pasted document. `questions`: `"ask"` (default) lets the designer come back with clarifying questions; `"assume"` means none: it makes its own calls, lists them as assumptions and builds. Returns a campaign id and link at once; the design takes 3–7 minutes. |
| `get_campaign(campaignId, waitSeconds, details)` | Where the campaign is (`state`, `allowedActions`) and its results (the brief). Always pass `waitSeconds: 50` while the designer is working, and call again until it changes. `details: true` also returns the full design along with the brief: every setting, each bucket's rule and reasoning, every journey step (copy, CTA, link, timing, branches, endings), the designer's notebook (your answers, its notes and assumptions, reasoning, research, each with its source) and the version history. Each journey step carries its `rationale` (the designer's AI rationale: why this step, here, like this) and each A/B test its `hypothesis` and `successMetric`; these are the designer's judgement, not measured facts. It is large: use it only when your user wants to inspect or review the design. |
| `answer_questions(campaignId, answers, skip)` | Answer the designer's questions (`answers`: question id → text) or skip some or `"all"`. |
| `request_changes(campaignId, request)` | Any change, in plain words. Also how to reply to the designer. |
| `submit_campaign(campaignId, startDate, endDate)` | Submit for execution. Locks the campaign. Dates (YYYY-MM-DD) are optional if the campaign already has them; pass them to set or change them. Start today or later, end after the start (a recurring campaign can use a far-off end). Refused if a journey doesn't fit between the dates. |
| `copy_campaign(campaignId, name)` | A new editable draft from an existing campaign (even a submitted one), keeping the designer's reasoning and chat; the original is unchanged. Use it for a variant: a new season or month, a different audience, a different channel mix or cadence, an A/B alternative. For a different goal, use `create_campaign` instead. Then adapt it with `request_changes`. |
| `stop_campaign(campaignId)` | Stop a submitted (scheduled or active) campaign. It goes back to **draft**: editable again, and `submit_campaign` can send it out again later with new dates. Customers' progress is not kept, so it starts fresh. |
| `delete_campaign(campaignId)` | Delete a draft (not submitted), e.g. a test. Refused for submitted campaigns: stop first. A copy is kept, so the Smart Engage team can recover a mistaken delete. |
| `get_link(campaignId)` | A fresh canvas link. |
| `list_campaigns()` | All IBL campaigns with state, allowed actions, dates and link. |

## Campaign states

Every campaign response carries `state` and `allowedActions`.

```
 create_campaign / copy_campaign
            │
            ▼
         DRAFT  (not submitted: designing, asking, or built)
            │   canSubmit: true once it is built AND every message
            │   is approved by the bank (Comm approvals, in the app)
            │
            │ submit_campaign (dates checked)
            ▼
   SCHEDULED ──start date──► ACTIVE ──end date──► ENDED
   (before start)        (between dates)       (after end)
        └──── stop_campaign ──────┘
              back to DRAFT (submit again to rerun)

  delete_campaign (DRAFT only) ──► DELETED
```

- `draft`: not submitted yet. While the designer is working, `allowedActions` is empty: wait and call `get_campaign` again. If it has **questions**, they are listed and `answer_questions` is allowed. If it **replied** without building (it asked something in its message), answer with `request_changes`. If something **failed**, `error` says so: try `request_changes` once more, then tell your user. Once it is **built** there is a brief, and `canSubmit` says whether it can be submitted now; when it is `false`, `notReady` says why (usually messages waiting for the bank's approval, which happens in the app: you can't approve them) and `approvals` gives the counts and any rejection reasons.
- `scheduled` / `active` / `ended`: submitted for execution and locked; which one depends on today's date and the campaign's dates. Scheduled and active campaigns can be stopped (back to draft). Ended ones can only be copied.
- `deleted`: gone from the list; the Smart Engage team can recover it.

**Rule: only call a tool that is in `allowedActions`** for that campaign (`get_campaign`, `get_link` and `list_campaigns` are always fine). Anything else will be refused.

## How to use it

1. **Gather the brief.** Before starting, make sure you have what only your user knows, or ask briefly: what customers should do differently; how success is judged; **how fast they need results and whether they'll spend on offers** (and any budget for them); timing; message limits. Put all of it in `brief`; a long brief is fine, and the more it has, the fewer questions come back.
   **Ask your user for any data they have, and include it.** It improves the design more than anything else: segment or customer counts, spend or usage patterns, past campaign results (sent, responses, conversions by channel), activation or dormancy rates, opt-in rates, top spend categories. Paste it as it is (tables, CSV, numbers in text). The designer builds and sizes the buckets from it and marks them as based on their data; it never invents numbers.
2. **Ask or assume.** If your user wants a quick first draft, or says "don't ask me anything", use `questions: "assume"`. Otherwise use `"ask"`.
3. **Wait.** Tell your user it takes a few minutes, then poll `get_campaign` with `waitSeconds: 50`. Don't poll faster.
4. **Questions** (state `draft` with `questions`). Show each question with its options and its "why", numbered, so your user can answer quickly. Never invent business facts (offers, limits, dates, numbers). If they don't know or don't care, skip it: the designer will assume and say so. Send with `answer_questions`.
5. **Built** (state `draft` with a brief). Tell your user what was built, from `brief`: the `summary`; the dates it runs (`startDate` → `endDate`); the buckets (name, who, `aiRationale`: the designer's reasoning for why they're stuck, which is a judgement, not a measured fact); how each journey works; for each A/B test in a bucket's `tests`, what it is trying to learn (`hypothesis`) and how the winner is judged (`successMetric`); and `assumptions`, flagged clearly so they can correct them. `strategy` is the designer's working plan (buckets, levers, money and budget). If the campaign uses offers, show `potentialSpend` (worked out by code, in three scenarios: if it underperforms / as expected / if it outperforms, the max) against the budget cap; totals need data access, otherwise they're per 1,000 customers. Give them the `link`.
6. **Changes.** Pass requests on in their words with `request_changes`, then wait and report what changed.
7. **Submit** only when `canSubmit` is true and your user explicitly says the campaign is good to go. First confirm the **start and end dates** with them (the brief shows the designer's proposal); pass `startDate` and `endDate` if they want different ones. The campaign is then locked.
8. **Variants**: when your user wants "the same campaign but for …", use `copy_campaign`, then `request_changes` on the copy.
9. **Stop**: if your user wants a submitted campaign stopped, or wants to change it, use `stop_campaign`; it goes back to draft, and `submit_campaign` sends it out again (customers start fresh). **Delete** only drafts, and only when your user asks.

## Offers and spend

For banks with an offer menu, the designer can use special offers (cashback, fee waivers, EMI discounts, milestones) from the bank's menu only, never invented. Offers are chosen per bucket on a cost ladder (messages first, money only where needed), and the exact offer line is added to a message by the system, never written by the AI. If your user gives an offer budget, it becomes the campaign's budget cap: the expected spend must fit it, and the engine stops issuing offers once it's spent. To spend less, ask with `request_changes` (e.g. "keep expected spend under ₹1L"). `details: true` includes the full cost working and `whatWillRun`: exactly what the engine receives.

Buckets can split into routes (e.g. electronics buyers vs grocery buyers), each with its own message and offer. The designer only proposes a split where it has a reason, and a split is made only if the bank's data backs it. To ask for one yourself, use `request_changes` (e.g. "split the Occasional bucket by top spend category"). Routes are designed and priced, but marked proposed: the engine can't route on these signals yet. Messages can also carry personal words, e.g. `{{top_category | "everyday buys"}}`, filled in per customer with a fallback; when you show copy to your user, explain that the field is replaced with each customer's own value.

## Links

Canvas links open that one campaign **read-only, with no password, for 24 hours** (`linkExpiresAt`). After that, call `get_link` for a fresh one. Links can't change anything; changes go through `request_changes`. Anyone with a link can view that campaign, so share it with care.

## Rules

- The designer only designs communication. It never invents an incentive, an amount or a link, and neither should you.
- One request at a time per campaign: while it is working, wait.
- Don't edit the same campaign in the Hyperface app while you are working on it here.
- If something keeps failing, tell your user to contact the Smart Engage team (Nimit).
