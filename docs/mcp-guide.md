# Hyperface Campaign Designer — setup and usage guide for your AI assistant

You are reading this because a Hyperface teammate asked you to connect them to the **Hyperface Campaign Designer** and help them use it. Follow the setup below, then use the tools as described in "How to use it". Speak to your user in plain words; never show them raw JSON.

## What it is

The Campaign Designer is Hyperface's own campaign agent. From a brief, anything from one line ("get dormant cardholders spending again before Diwali") to a full document, it designs a full card campaign for a bank: **buckets** of customers with different reasons for not acting, and a **message journey** for each (WhatsApp, SMS, email; waits; checks; endings). It is reached through an MCP server.

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

Then tell your user: "Done. Restart Claude Code (or open a new session) so the Campaign Designer tools load, then type `/mcp` to check that **campaign-designer** is connected with 10 tools." The tools only appear in a new session.

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
| `get_campaign(campaignId, waitSeconds, details)` | Where the campaign is (`state`, `allowedActions`) and its results (the brief). Always pass `waitSeconds: 50` while the designer is working, and call again until it changes. `details: true` also returns the full design along with the brief: every setting, each bucket's rule and reasoning, every journey step (copy, CTA, link, timing, branches, endings), the designer's notebook (your answers, its notes and assumptions, reasoning, research, each with its source) and the version history. It is large: use it only when your user wants to inspect or review the design. |
| `answer_questions(campaignId, answers, skip)` | Answer the designer's questions (`answers`: question id → text) or skip some or `"all"`. |
| `request_changes(campaignId, request)` | Any change, in plain words. Also how to reply to the designer. |
| `submit_campaign(campaignId, startDate, endDate)` | Submit for execution. Locks the campaign. Dates (YYYY-MM-DD) are optional if the campaign already has them; pass them to set or change them. Start today or later, end after the start (a recurring campaign can use a far-off end). Refused if a journey doesn't fit between the dates. |
| `copy_campaign(campaignId, name)` | A new editable draft from an existing campaign (even a submitted one), keeping the designer's reasoning and chat; the original is unchanged. Use it for a variant: a new season or month, a different audience, a different channel mix or cadence, an A/B alternative. For a different goal, use `create_campaign` instead. Then adapt it with `request_changes`. |
| `withdraw_campaign(campaignId)` | Take a submitted (scheduled or active) campaign back from execution. **This is how to pause a campaign.** It becomes editable again; `submit_campaign` resumes it. |
| `delete_campaign(campaignId)` | Delete a draft (not submitted), e.g. a test. Refused for submitted campaigns: withdraw first. A copy is kept, so the Campaign Designer team can recover a mistaken delete. |
| `get_link(campaignId)` | A fresh canvas link. |
| `list_campaigns()` | All IBL campaigns with state, allowed actions, dates and link. |

## Campaign states

Every campaign response carries `state` and `allowedActions`.

```
 create_campaign / copy_campaign
            │
            ▼
         DRAFT ──── designer builds ────► READY ◄──────────────┐
  (designing: working, asking,            │  │                 │
   or replied to you)                     │  └ request_changes │
            │                             │    (back to DRAFT) │
            │                    submit_campaign               │
            │                    (dates checked)               │
            │                             ▼                    │
            │        SCHEDULED ──start date──► ACTIVE ──end date──► ENDED
            │         (before start)      (between dates)     (after end)
            │              └──── withdraw_campaign (= pause) ───┘
            │                    back to READY
            ▼
  delete_campaign (DRAFT or READY only) ──► DELETED
```

- `draft`: being designed. While the designer is working, `allowedActions` is empty: wait and call `get_campaign` again. If it has **questions**, they are listed and `answer_questions` is allowed. If it **replied** without building (it asked something in its message), answer with `request_changes`. If something **failed**, `error` says so: try `request_changes` once more, then tell your user.
- `ready`: designed and built, with a brief. Change it, submit it, copy it or delete it.
- `scheduled` / `active` / `ended`: submitted for execution and locked; which one depends on today's date and the campaign's dates. Scheduled and active campaigns can be withdrawn (paused). Ended ones can only be copied.
- `deleted`: gone from the list; the Campaign Designer team can recover it.

**Rule: only call a tool that is in `allowedActions`** for that campaign (`get_campaign`, `get_link` and `list_campaigns` are always fine). Anything else will be refused.

## How to use it

1. **Gather the brief.** Before starting, make sure you have what only your user knows, or ask briefly: what customers should do differently; how success is judged; any incentive that **already exists** (with exact terms); timing; message limits. Put all of it in `brief`; a long brief is fine, and the more it has, the fewer questions come back.
   **Ask your user for any data they have, and include it.** It improves the design more than anything else: segment or customer counts, spend or usage patterns, past campaign results (sent, responses, conversions by channel), activation or dormancy rates, opt-in rates, top spend categories. Paste it as it is (tables, CSV, numbers in text). The designer builds and sizes the buckets from it and marks them as based on their data; it never invents numbers.
2. **Ask or assume.** If your user wants a quick first draft, or says "don't ask me anything", use `questions: "assume"`. Otherwise use `"ask"`.
3. **Wait.** Tell your user it takes a few minutes, then poll `get_campaign` with `waitSeconds: 50`. Don't poll faster.
4. **Questions** (state `draft` with `questions`). Show each question with its options and its "why", numbered, so your user can answer quickly. Never invent business facts (offers, limits, dates, numbers). If they don't know or don't care, skip it: the designer will assume and say so. Send with `answer_questions`.
5. **Ready** (state `ready`). Tell your user what was built, from `brief`: the `summary`; the dates it runs (`startDate` → `endDate`); the buckets (name, who, why they're stuck); how each journey works; and `assumptions`, flagged clearly so they can correct them. Give them the `link`.
6. **Changes.** Pass requests on in their words with `request_changes`, then wait and report what changed.
7. **Submit** only when your user explicitly says the campaign is good to go. First confirm the **start and end dates** with them (the brief shows the designer's proposal); pass `startDate` and `endDate` if they want different ones. The campaign is then locked.
8. **Variants**: when your user wants "the same campaign but for …", use `copy_campaign`, then `request_changes` on the copy.
9. **Pause or pull back**: if your user wants to pause a submitted campaign, or change it, use `withdraw_campaign`; resubmit with `submit_campaign` to resume. **Delete** only drafts, and only when your user asks.

## Links

Canvas links open that one campaign **read-only, with no password, for 24 hours** (`linkExpiresAt`). After that, call `get_link` for a fresh one. Links can't change anything; changes go through `request_changes`. Anyone with a link can view that campaign, so share it with care.

## Rules

- The designer only designs communication. It never invents an incentive, an amount or a link, and neither should you.
- One request at a time per campaign: while it is working, wait.
- Don't edit the same campaign in the Hyperface app while you are working on it here.
- If something keeps failing, tell your user to contact the Campaign Designer team (Nimit).
