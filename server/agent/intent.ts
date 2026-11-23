// What a campaign is for (Smart Engage 2.0): chosen when it is created, it
// tells the designer which goal to start from, where to look in the data and
// which levers to use. Shown in the APP STATUS every turn, so the fixed system
// prompt does not grow. Campaigns from before intents existed read as "other".
import type { CampaignIntent, CampaignObject } from './types';
import { CAMPAIGN_INTENTS } from './types';
import { productsFor, productForAgent } from '../products';
import { signalsFor } from '../signals';
import type { TenantConfig } from '../tenants';

export const INTENT_LABEL: Record<CampaignIntent, string> = {
  usage: 'Increase card usage',
  activation: 'Increase card activation',
  adoption: 'Drive product sign-ups',
  churn: 'Reduce churn',
  other: 'Custom campaign',
};

const GUIDE: Record<CampaignIntent, string> = {
  usage:
    'Get existing cardholders to use the card more. Goal: card transactions (Transaction Events / Transaction). Look at spend patterns, categories, frequency and recency. Levers: messages, then offers where words alone won\'t move a bucket.',
  activation:
    'Get cardholders to start using a card they have: the first transaction or activation. Goal: Transaction Events / Transaction (or Card Events / Card Activated when the brief is about activation itself). Look at new cardholders and those inactive since issue. Levers: messages and set-up links (activation, PIN, virtual card), a small first-spend offer where needed.',
  adoption:
    'Sell the product below: get customers to sign up for it. Goal: Product Events / Product Signed Up (the bank reports sign-ups; treat them as instant). Build buckets from who is eligible for the product and WHY each group would want it, from their data. Every message pitches the product, carries it (product: <id>) and links to its product page (link = the product\'s link). An offer is optional, to sweeten it.',
  churn:
    'Keep cardholders who are drifting away. Goal: card transactions (Transaction Events / Transaction) from at-risk customers. Look at declining spend, long gaps, complaints and fees coming due. Levers: messages, retention offers.',
  other: 'Whatever the brief asks for: set the goal, where to look and the levers from the brief.',
};

export const isIntent = (v: unknown): v is CampaignIntent => typeof v === 'string' && (CAMPAIGN_INTENTS as string[]).includes(v);

/** The intent block for the APP STATUS. */
export function intentBlock(c: CampaignObject, tenant: Pick<TenantConfig, 'tenantId' | 'warehouse'> | null): string {
  const intent: CampaignIntent = isIntent(c.intent) ? c.intent : 'other';
  const lines = ['## What this campaign is for (chosen by the manager when creating it)', `- ${INTENT_LABEL[intent]}: ${GUIDE[intent]}`];
  if (intent === 'adoption') {
    const p = productsFor(tenant).find((x) => x.product_id === c.productId);
    lines.push(p ? `- The product: ${JSON.stringify(productForAgent(p, signalsFor(tenant)))}` : `- The product "${c.productId ?? ''}" is not on the bank's product list: ask the manager which product (list_products).`);
  }
  return lines.join('\n');
}
