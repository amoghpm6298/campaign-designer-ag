// What a new campaign is for, chosen in the "Create new campaign" modal, held
// until the campaign's first message carries it to the server (which stores it
// on the campaign). Per browser session; an in-memory copy covers a blocked
// sessionStorage.
export type CampaignIntent = 'usage' | 'activation' | 'adoption' | 'churn' | 'other';
export interface IntentChoice {
  intent: CampaignIntent;
  productId?: string;
  /** The brief typed (or picked) in the modal's last step: sent as the campaign's first message. */
  brief?: string;
}

/** Ready-made briefs per intent, offered in the modal's last step. Picking one fills the box; it stays editable. */
export const BRIEF_SUGGESTIONS: Record<CampaignIntent, { title: string; brief: string }[]> = {
  usage: [
    { title: 'Light users to regular spenders', brief: 'Grow card spend among light users: cardholders who used their card only 1 to 3 times in the last 90 days. Success is a transaction during the campaign, ideally a second one. Run it for the next 6 weeks. WhatsApp first, SMS as backup, at most 4 messages each.' },
    { title: 'Festive season spend push', brief: 'Drive card spend over the coming festive season among active cardholders who spend below ₹5,000 a month. Success is extra spend on the card during the campaign. WhatsApp first, SMS as backup, at most 4 messages each. Use offers from our menu if they help, within a sensible budget.' },
    { title: 'New spend categories', brief: 'Get cardholders who use the card for just one category (for example only fuel or only groceries) to use it in a new category. Success is a transaction in a category they have not used before. Run it for 4 weeks, WhatsApp first, at most 3 messages each.' },
  ],
  activation: [
    { title: 'First purchase on new cards', brief: 'Get new cardholders to make their first purchase: cards issued in the last 90 days that are active but have never been used. Success is the first transaction. Run it for the next 6 weeks. WhatsApp first, SMS as backup, at most 4 messages each. A first-spend offer from our menu is fine.' },
    { title: 'Every unused card', brief: 'Activate every active credit card that has never been used, whatever its age. Split them by how long the card has sat unused, since the reason differs. Success is the first transaction. WhatsApp first, SMS as backup, at most 4 messages each.' },
    { title: 'Activated but never online', brief: 'Get cardholders who use the card only in stores to make their first online purchase. Success is a first online (card-not-present) transaction. Run it for 4 weeks, WhatsApp first, at most 3 messages each.' },
  ],
  churn: [
    { title: 'Win back drifting cardholders', brief: 'Win back cardholders who used the card regularly before but have not transacted in the last 45 days. Success is a transaction during the campaign. Run it for the next 8 weeks. WhatsApp and SMS, at most 4 messages each. Offers from our menu are fine.' },
    { title: 'Falling spend', brief: 'Catch cardholders whose monthly spend has dropped by half or more compared with their usual level, before they stop. Success is their spend recovering during the campaign. Run it for 6 weeks, WhatsApp first, SMS as backup, at most 4 messages each.' },
    { title: 'Long dormant cards', brief: 'Re-engage cardholders who have not used the card in 6 months or more. Success is any transaction. Run it for 6 weeks, at most 3 messages each, with an offer from our menu if it helps.' },
  ],
  adoption: [
    { title: 'Sell to the people who need it most', brief: 'Sell {product} to the cardholders most likely to need it. Success is a sign-up. Run it for the next 6 weeks. WhatsApp first, SMS as backup, at most 3 messages each.' },
    { title: 'Active spenders first', brief: 'Sell {product} to active cardholders who spend regularly. Success is a sign-up. Run it for 4 weeks, WhatsApp first, at most 3 messages each. Keep the tone helpful, not pushy.' },
    { title: 'A short, focused push', brief: 'A two-week push to sell {product} to the best-fit cardholders. Success is a sign-up. At most 2 messages each, WhatsApp first.' },
  ],
  other: [
    { title: 'Convert big purchases to EMI', brief: 'Get cardholders who made a big purchase (₹10,000 or more) in the last 30 days to convert it into an EMI. Success is an EMI conversion. Run it for 6 weeks, WhatsApp first, SMS as backup, at most 3 messages each.' },
    { title: 'Set up autopay', brief: 'Get cardholders who pay their bill manually (and sometimes late) to set up autopay. Success is autopay set up. Run it for 4 weeks, WhatsApp first, at most 3 messages each.' },
    { title: 'Diwali campaign', brief: 'A Diwali campaign for our cardholders: more spend during the festive weeks, using offers from our menu where they help. Success is extra card spend. WhatsApp first, SMS as backup, at most 4 messages each.' },
  ],
};

export const INTENTS: { key: CampaignIntent; letter: string; label: string; hint: string }[] = [
  { key: 'usage', letter: 'A', label: 'Increase card usage', hint: 'Get cardholders to use the card more often, or for more.' },
  { key: 'activation', letter: 'B', label: 'Increase card activation', hint: 'Get cardholders to start using a card they already have.' },
  { key: 'adoption', letter: 'C', label: 'Drive product sign-ups', hint: 'Sell a product to your customers: a card upgrade, a loan, insurance.' },
  { key: 'churn', letter: 'D', label: 'Reduce churn', hint: 'Keep cardholders who are drifting away.' },
  { key: 'other', letter: 'E', label: 'Custom campaign', hint: 'Any other credit card campaign. Describe it in your own words.' },
];
export const intentLabel = (k: string | null | undefined) => INTENTS.find((i) => i.key === k)?.label ?? 'Custom campaign';

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
