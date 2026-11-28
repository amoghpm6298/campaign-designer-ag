// Flows and campaigns (Smart Engage 2.0). A FLOW is always on: new customers
// join as they become eligible (on a refresh), and it runs from its start date
// until someone stops it. A CAMPAIGN is one-time: the list is fixed at launch
// and it runs between two dates. Chosen when the item is created, never
// inferred, and fixed from then on. Shared by the server and the app.
//
// Underneath both are the same engine object; the kind decides membership
// (flow = open, campaign = locked), whether there is an end date, and which
// rules the designer is given.

export type CampaignKind = 'flow' | 'campaign';
export const CAMPAIGN_KINDS: CampaignKind[] = ['flow', 'campaign'];

export const isKind = (v: unknown): v is CampaignKind => v === 'flow' || v === 'campaign';

/** The kind of an item. Items from before kinds existed: recurring ones are flows, the rest campaigns. */
export function kindOf(c: { kind?: string | null; membership?: { type?: string } | null } | null | undefined): CampaignKind {
  if (isKind(c?.kind)) return c!.kind as CampaignKind;
  return c?.membership?.type === 'open' ? 'flow' : 'campaign';
}

export const KIND_LABEL: Record<CampaignKind, string> = { flow: 'Flow', campaign: 'Campaign' };
export const KIND_PLURAL: Record<CampaignKind, string> = { flow: 'Flows', campaign: 'Campaigns' };
