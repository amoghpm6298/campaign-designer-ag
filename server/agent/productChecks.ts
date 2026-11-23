// Checks on products in a campaign (Smart Engage 2.0): only a product
// sign-ups ("adoption") campaign pitches a product, its chosen one, with the
// sign-up goal; every message that pitches it carries `product: <id>` and links
// to its product page. Cross-selling inside other campaigns is switched off for
// now (Nimit, 2026-11-23): to be tried separately later. Enough of each bucket
// must be eligible.
import type { CampaignContext, CampaignObject } from './types';
import type { BpStep } from '../blueprint';
import type { TenantConfig } from '../tenants';
import { bucketContext } from '../../src/designer/v2/contextView';
import { eligibleShare, productsFor } from '../products';
import { signalsFor } from '../signals';
import { warehouseAvailable } from '../warehouse';

/** At least this share of a bucket must be eligible for the product it is pitched. */
export const MIN_ELIGIBLE_SHARE = 0.5;
export const PRODUCT_GOAL = { eventCategory: 'Product Events', eventType: 'Product Signed Up' };

type Rec = Record<string, unknown>;

export function productProblems(campaign: CampaignObject, context: CampaignContext | null, tenant: Pick<TenantConfig, 'tenantId' | 'warehouse'> | null): string[] {
  const problems: string[] = [];
  const products = productsFor(tenant);
  const adoption = campaign.intent === 'adoption';
  if (adoption) {
    const chosen = products.find((p) => p.product_id === campaign.productId);
    if (!chosen) problems.push(`This campaign sells a product, but "${campaign.productId ?? ''}" is not on the bank's product list. Ask the manager which product (list_products).`);
    if (campaign.goal && (campaign.goal.eventCategory !== PRODUCT_GOAL.eventCategory || campaign.goal.eventType !== PRODUCT_GOAL.eventType))
      problems.push(`This campaign sells a product: its goal is "${PRODUCT_GOAL.eventCategory} / ${PRODUCT_GOAL.eventType}" (edit_campaign), not "${campaign.goal.eventType}".`);
  }
  const bank = tenant?.warehouse?.bank && warehouseAvailable(tenant.warehouse.bank) ? tenant.warehouse.bank : null;
  const signals = signalsFor(tenant);
  const views = bucketContext(context?.entries ?? []);
  const lanes = [
    ...campaign.buckets.map((b) => ({ id: b.id, name: `Bucket "${b.name}"`, journey: b.journey })),
    ...(campaign.everyoneElse?.approach === 'journey' ? [{ id: 'everyone_else', name: 'Everyone else', journey: campaign.everyoneElse.journey }] : []),
  ];
  for (const lane of lanes) {
    const used = new Set<string>();
    const walk = (list: BpStep[] | null | undefined) => {
      for (const st of (list ?? []) as unknown as Rec[]) {
        if (st.kind === 'send' && typeof st.product === 'string' && st.product) {
          const at = `${lane.name} › "${String(st.name ?? 'a message')}"`;
          const p = products.find((x) => x.product_id === st.product);
          used.add(String(st.product));
          if (!p) problems.push(`${at}: "${st.product}" is not on the bank's product list. Use an id from list_products.`);
          else {
            if (p.status !== 'live') problems.push(`${at}: the product "${p.product_name}" is paused. Choose another or remove the pitch.`);
            if (st.link !== p.link) problems.push(`${at}: a message that pitches "${p.product_name}" links to its product page: set link to "${p.link}".`);
            if (adoption && p.product_id !== campaign.productId) problems.push(`${at}: this campaign sells "${campaign.productId}"; pitch that product, not "${p.product_id}".`);
            if (!adoption) problems.push(`${at}: products are only pitched in a product sign-ups campaign. Remove the product from this message.`);
          }
        }
        for (const k of ['yes', 'no', 'otherwise']) if (Array.isArray(st[k])) walk(st[k] as BpStep[]);
        for (const k of ['paths', 'arms']) if (Array.isArray(st[k])) for (const q of st[k] as { steps?: BpStep[] }[]) walk(q.steps);
      }
    };
    walk(lane.journey as BpStep[] | null | undefined);
    if (used.size > 1) problems.push(`${lane.name}: pitches ${used.size} products (${[...used].join(', ')}). One product per bucket.`);
    const sql = views[lane.id]?.sql;
    const p = products.find((x) => used.has(x.product_id));
    if (p && bank && sql) {
      const q = eligibleShare(bank, signals, sql, p);
      if (!('error' in q) && q.size && q.eligible / q.size < MIN_ELIGIBLE_SHARE)
        problems.push(`${lane.name}: only ${q.eligible.toLocaleString('en-IN')} of ${q.size.toLocaleString('en-IN')} (${Math.round((100 * q.eligible) / q.size)}%) are eligible for "${p.product_name}". Narrow the bucket to those eligible, or choose another product.`);
    }
  }
  return problems;
}
