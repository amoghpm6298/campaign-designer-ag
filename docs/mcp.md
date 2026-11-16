# Campaign Designer MCP

Use Hyperface's Campaign Designer from your own agent (Claude Code, Claude Desktop, or any MCP client). You describe a campaign idea; Hyperface's campaign agent designs it (customer buckets and a message journey for each); you get back a canvas link. Your agent never designs anything itself: it passes your idea on, relays the agent's questions and your changes, and submits when you say go.

## Connect

You need two things from the Campaign Designer team: the **team token** (each token works on one bank) and the **app password** (to open the canvas links).

**Claude Code**

```
claude mcp add --transport http campaign-designer https://ai.product.hyperface.co/campaigndesigneragent/mcp --header "Authorization: Bearer <team token>"
```

**Claude Desktop / other clients** (MCP config):

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

## How it works

1. **Start**: `start_campaign(idea)`. Say everything you know: goal, who, any incentive that already exists, timing, message limits. You get a `campaignId` and a canvas link straight away.
2. **Follow**: `get_campaign(campaignId, waitSeconds: 50)`, repeated until the status changes. A design takes a few minutes.
3. **Answer**: on `needs_answers`, the agent's questions come with options and why it asks. `answer_questions` with an option or your own words; skip what you don't know and the agent assumes it and says so.
4. **Review**: on `ready`, open the link: the full chat and the campaign canvas. Ask for anything different with `request_changes("make the dormant bucket SMS-first")`.
5. **Submit**: `submit_campaign` when you're happy. It's marked **Submitted for execution** and locked; no more changes.

`list_campaigns` shows every campaign for your bank, with status and link.

## Good to know

- Campaigns made here are ordinary campaigns: they appear on the Campaigns page in the app, and anyone with the link sees the same chat and canvas.
- While the agent is working on a campaign, a second request to it is refused. Wait for `get_campaign` to say it has finished.
- Don't chat with the same campaign in the app while your agent is working on it.
- Campaigns are communication only: the agent never invents an incentive, offer or number.

## For the Campaign Designer team

Tokens live in the server's `.env` as `MCP_TOKENS=label:token:TENANT` (comma-separated for several, at least 16 characters each, e.g. `growth:<token>:TEN-IBL`), and `PUBLIC_APP_URL=https://ai.product.hyperface.co/campaigndesigneragent` (so links use the public address), then restart the app (`pm2 restart campaign-designer`). The label is recorded as "submitted by". Code: `server/mcp/`.
