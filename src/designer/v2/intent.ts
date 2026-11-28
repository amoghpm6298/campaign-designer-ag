// What a new campaign is for, chosen in the "Create new campaign" modal, held
// until the campaign's first message carries it to the server (which stores it
// on the campaign). Per browser session; an in-memory copy covers a blocked
// sessionStorage.
import type { CampaignKind } from './kind';

export type CampaignIntent = 'usage' | 'activation' | 'adoption' | 'churn' | 'other';
export interface IntentChoice {
  intent: CampaignIntent;
  productId?: string;
  /** The brief typed (or picked) in the modal's last step: sent as the campaign's first message. */
  brief?: string;
  /** Flow (always on) or campaign (one-time): the page it was created from. */
  kind?: CampaignKind;
}

/**
 * Ready-made briefs per intent, offered in the modal's last step, written for
 * the kind being created: a flow's brief says who joins and what they should
 * do within days of joining; a campaign's names a window and a hook. Picking
 * one fills the box; it stays editable.
 */
type Suggestion = { title: string; brief: string };
export const BRIEF_SUGGESTIONS: Record<CampaignKind, Record<CampaignIntent, Suggestion[]>> = {
  flow: {
    usage: [
      { title: 'Light users become regulars', brief: 'An always-on flow for light users: cardholders who used the card only 1 to 3 times in the last 90 days join as they fall into that group. Success is a second transaction within 30 days of joining. WhatsApp first, SMS as backup, at most 4 messages each.' },
      { title: 'Try a new category', brief: 'An always-on flow for cardholders who use the card in only one category (for example only fuel): they join once they have done so for 60 days. Success is a transaction in a new category within 21 days of joining. At most 3 messages each.' },
      { title: 'Spend dips below usual', brief: 'An always-on flow for active cardholders whose spend this month is running well below their usual level. Success is their spend recovering within 30 days of joining. WhatsApp first, at most 3 messages each, offers from our menu if they help, within a monthly budget.' },
    ],
    activation: [
      { title: 'Welcome every new cardholder', brief: 'An always-on welcome flow: every new cardholder joins on the day the card is issued. Success is the first transaction within 30 days of joining. WhatsApp first, SMS as backup, at most 4 messages each. A small first-spend offer from our menu is fine.' },
      { title: 'Issued but not used after 14 days', brief: 'An always-on flow for new cards still unused 14 days after issue: they join on day 14. Success is the first transaction within 21 days of joining. WhatsApp first, SMS as backup, at most 3 messages each.' },
      { title: 'First online purchase', brief: 'An always-on flow for cardholders who have used the card in stores but never online: they join after their third in-store transaction. Success is a first online transaction within 30 days of joining. At most 3 messages each.' },
    ],
    churn: [
      { title: 'Regulars who go quiet', brief: 'An always-on flow for cardholders who used the card regularly but have not transacted for 45 days: they join on day 45. Success is a transaction within 30 days of joining. WhatsApp and SMS, at most 4 messages each. Offers from our menu are fine, within a monthly budget.' },
      { title: 'Spend halves', brief: 'An always-on flow that catches cardholders whose monthly spend has dropped by half or more against their usual level. Success is their spend recovering within 45 days of joining. WhatsApp first, SMS as backup, at most 4 messages each.' },
      { title: 'Annual fee coming due', brief: 'An always-on flow for cardholders whose annual fee is due in 30 days and who use the card little: they join 30 days before the fee date. Success is a transaction before the fee is charged. At most 3 messages each.' },
    ],
    adoption: [
      { title: 'Newly eligible customers', brief: 'An always-on flow selling {product}: customers join as soon as they become eligible for it. Success is a sign-up within 30 days of joining. WhatsApp first, SMS as backup, at most 3 messages each.' },
      { title: 'After a trigger moment', brief: 'An always-on flow selling {product} to customers right after the moment they are most likely to need it (for example a large purchase). Success is a sign-up within 14 days of joining. At most 2 messages each, helpful in tone.' },
      { title: 'Steady cross-sell', brief: 'An always-on flow selling {product} to active cardholders who spend regularly, as they reach 6 months on the card. Success is a sign-up within 30 days of joining. WhatsApp first, at most 3 messages each.' },
    ],
    other: [
      { title: 'Big purchase to EMI', brief: 'An always-on flow: cardholders join right after a purchase of ₹10,000 or more. Success is converting it into an EMI within 14 days of joining. WhatsApp first, SMS as backup, at most 3 messages each.' },
      { title: 'Late payers to autopay', brief: 'An always-on flow for cardholders who paid a bill late: they join after the late payment. Success is autopay set up within 30 days of joining. WhatsApp first, at most 3 messages each.' },
      { title: 'Rewards about to expire', brief: 'An always-on flow for cardholders whose reward points expire in the next 45 days: they join 45 days before expiry. Success is redeeming points before they expire. At most 3 messages each.' },
    ],
  },
  campaign: {
    usage: [
      { title: 'Festive spend push', brief: 'A one-time festive campaign for the next 3 weeks: more card spend from active cardholders who spend below ₹5,000 a month. Success is the total extra spend by the end date. WhatsApp first, SMS as backup, at most 4 messages each. Offers from our menu, within a total budget.' },
      { title: 'Quarter-end spend sprint', brief: 'A one-time 2-week push before the quarter ends: get light users (1 to 3 transactions in the last 90 days) to transact again. Success is the number who transact by the end date. At most 3 messages each, with a last call 2 days before the end.' },
      { title: 'Big sale season', brief: 'A one-time campaign around the upcoming online sale season, for the sale weeks: get cardholders to shop online with the card. Success is total online spend by the end date. WhatsApp first, at most 4 messages each.' },
    ],
    activation: [
      { title: 'Clear the unused-card backlog', brief: 'A one-time 6-week campaign to activate every active credit card that has never been used, whatever its age. Split them by how long the card has sat unused. Success is the number of first transactions by the end date. WhatsApp first, SMS as backup, at most 4 messages each.' },
      { title: 'Festive first purchase', brief: 'A one-time festive campaign for the next 4 weeks: get cardholders who have never used their card to make the first purchase for the festival. Success is first transactions by the end date. A first-spend offer from our menu that ends with the campaign is fine.' },
      { title: 'First online purchase drive', brief: 'A one-time 4-week campaign to get in-store-only cardholders to make a first online purchase. Success is the number of first online transactions by the end date. At most 3 messages each.' },
    ],
    churn: [
      { title: 'Win-back drive', brief: 'A one-time 8-week win-back campaign for cardholders who used the card regularly but have not transacted in the last 45 days. Success is the number who transact by the end date. WhatsApp and SMS, at most 4 messages each. Offers from our menu that end with the campaign are fine.' },
      { title: 'Dormant cards before year end', brief: 'A one-time 6-week campaign before the year ends for cards unused in 6 months or more. Success is any transaction by the end date. At most 3 messages each, with a last call a few days before the end.' },
      { title: 'Spend recovery push', brief: 'A one-time 6-week campaign for cardholders whose monthly spend has dropped by half or more. Success is total recovered spend by the end date. WhatsApp first, SMS as backup, at most 4 messages each.' },
    ],
    adoption: [
      { title: 'Launch push', brief: 'A one-time 6-week launch campaign selling {product} to the cardholders most likely to need it. Success is the number of sign-ups by the end date. WhatsApp first, SMS as backup, at most 3 messages each.' },
      { title: 'Limited-time offer', brief: 'A one-time 4-week campaign selling {product} to active cardholders, with an offer from our menu that ends with the campaign. Success is sign-ups by the end date. WhatsApp first, at most 3 messages each.' },
      { title: 'A short, focused push', brief: 'A one-time two-week push to sell {product} to the best-fit cardholders. Success is sign-ups by the end date. At most 2 messages each, WhatsApp first.' },
    ],
    other: [
      { title: 'Diwali campaign', brief: 'A Diwali campaign for our cardholders over the festive weeks: more card spend, using offers from our menu where they help. Success is total extra card spend by the end date. WhatsApp first, SMS as backup, at most 4 messages each.' },
      { title: 'EMI conversion drive', brief: 'A one-time 6-week campaign: get cardholders who made a big purchase (₹10,000 or more) in the last 30 days to convert it into an EMI. Success is EMI conversions by the end date. At most 3 messages each.' },
      { title: 'Autopay sign-up month', brief: 'A one-time 4-week campaign to get cardholders who pay their bill manually to set up autopay. Success is the number of autopay set-ups by the end date. WhatsApp first, at most 3 messages each.' },
    ],
  },
};

export const INTENTS: { key: CampaignIntent; letter: string; label: string; hint: string }[] = [
  { key: 'usage', letter: 'A', label: 'Increase card usage', hint: 'Get cardholders to use the card more often, or for more.' },
  { key: 'activation', letter: 'B', label: 'Increase card activation', hint: 'Get cardholders to start using a card they already have.' },
  { key: 'adoption', letter: 'C', label: 'Drive product sign-ups', hint: 'Sell a product to your customers: a card upgrade, a loan, insurance.' },
  { key: 'churn', letter: 'D', label: 'Reduce churn', hint: 'Keep cardholders who are drifting away.' },
  { key: 'other', letter: 'E', label: 'Custom campaign', hint: 'Any other credit card campaign. Describe it in your own words.' },
];
/** The intent's name; on a flow, "Custom campaign" reads "Custom flow". */
export const intentLabel = (k: string | null | undefined, kind?: CampaignKind) => {
  const label = INTENTS.find((i) => i.key === k)?.label ?? 'Custom campaign';
  return kind === 'flow' && label === 'Custom campaign' ? 'Custom flow' : label;
};

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
