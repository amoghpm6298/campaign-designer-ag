// What a new campaign is for, chosen in the "Create new campaign" modal, held
// until the campaign's first message carries it to the server (which stores it
// on the campaign). Per browser session; an in-memory copy covers a blocked
// sessionStorage.
export type CampaignIntent = 'usage' | 'activation' | 'adoption' | 'churn' | 'other';
export interface IntentChoice {
  intent: CampaignIntent;
  productId?: string;
}

export const INTENTS: { key: CampaignIntent; letter: string; label: string; hint: string }[] = [
  { key: 'usage', letter: 'A', label: 'Increase card usage', hint: 'Get cardholders to use the card more often, or for more.' },
  { key: 'activation', letter: 'B', label: 'Increase card activation', hint: 'Get cardholders to start using a card they already have.' },
  { key: 'adoption', letter: 'C', label: 'Drive product sign-ups', hint: 'Sell a product to your customers: a card upgrade, a loan, insurance.' },
  { key: 'churn', letter: 'D', label: 'Reduce churn', hint: 'Keep cardholders who are drifting away.' },
  { key: 'other', letter: 'E', label: 'Something else', hint: 'Any other kind of credit card campaign. Describe it in your own words.' },
];
export const intentLabel = (k: string | null | undefined) => INTENTS.find((i) => i.key === k)?.label ?? 'Something else';

const mem = new Map<string, IntentChoice>();
const key = (id: string) => `cd.intent.${id}`;

export function setPendingIntent(sessionId: string, choice: IntentChoice): void {
  mem.set(sessionId, choice);
  try {
    window.sessionStorage.setItem(key(sessionId), JSON.stringify(choice));
  } catch {
    /* the in-memory copy is enough for this tab */
  }
}

export function pendingIntent(sessionId: string): IntentChoice | null {
  if (mem.has(sessionId)) return mem.get(sessionId)!;
  try {
    const raw = window.sessionStorage.getItem(key(sessionId));
    return raw ? (JSON.parse(raw) as IntentChoice) : null;
  } catch {
    return null;
  }
}
