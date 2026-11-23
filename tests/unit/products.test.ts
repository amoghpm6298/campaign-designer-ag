// Smart Engage 2.0: the bank's products, product campaigns ("adoption") and cross-sells.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProduct, productsFor, saveProduct, setProductStatus } from '../../server/products';
import { productProblems } from '../../server/agent/productChecks';
import { intentBlock } from '../../server/agent/intent';
import { listLinks } from '../../server/links';
import { resolveTenant } from '../../server/tenants';
import { signalsFor } from '../../server/signals';
import { existsSync } from 'node:fs';
import { warehousePath } from '../../server/warehouse';
import type { CampaignObject } from '../../server/agent/types';

const YES = resolveTenant('TEN-YES')!;
const hasYes = existsSync(warehousePath('yesbank'));
const dir = () => mkdtempSync(join(tmpdir(), 'cd-products-'));

describe('the product list', () => {
  it.runIf(hasYes)('starts with card-focused products whose pages are in Links, and each passes its own checks', () => {
    const refs = listLinks('TEN-YES').map((l) => l.ref);
    const list = productsFor(YES, dir());
    expect(list.map((p) => p.product_id)).toEqual(['premium_upgrade', 'addon_card', 'loan_on_card', 'balance_transfer', 'card_protection', 'travel_card']);
    for (const p of list) expect(refs).toContain(p.link);
    for (const p of list) expect(checkProduct(p, signalsFor(YES), refs).problems).toEqual([]);
  });
  it.runIf(hasYes)('a save needs a real link and real signals; pausing keeps it on the list', () => {
    const d = dir();
    const bad = saveProduct(YES, { product_id: 'gold', product_name: 'Gold card', product_type: 'card', description: 'x', link: 'nowhere', eligibility: [{ attribute: 'vip', operator: 'Equals', value: '1' }] }, 'ops', d);
    expect(bad.ok).toBe(false);
    expect(bad.problems!.join(' ')).toMatch(/no link "nowhere"/);
    expect(bad.problems!.join(' ')).toMatch(/"vip" is not a signal/);
    expect(saveProduct(YES, { product_id: 'gold', product_name: 'Gold card', product_type: 'card', description: 'x', link: 'apply_upgrade' }, 'ops', d).ok).toBe(true);
    expect(setProductStatus(YES, 'gold', 'paused', 'ops', d).ok).toBe(true);
    expect(productsFor(YES, d).find((p) => p.product_id === 'gold')!.status).toBe('paused');
  });
});

const send = (extra: Record<string, unknown> = {}) => ({ kind: 'send', name: 'Pitch', channelPreference: ['SMS'], ...extra });
const camp = (journey: unknown[], extra: Partial<CampaignObject> = {}) => ({ goal: { eventCategory: 'Transaction Events', eventType: 'Transaction' }, buckets: [{ id: 'b', name: 'Active', priority: 1, journey }], ...extra }) as unknown as CampaignObject;

describe('without data access', () => {
  it('eligibility rules are kept as written, not checked: nothing can be counted', () => {
    const { checkProduct: check } = { checkProduct };
    const r = check({ product_id: 'x1', product_name: 'X', product_type: 'card', description: 'x', link: 'apply_upgrade', eligibility: [{ attribute: 'spend_90d', operator: 'Greater than', value: '1' }] }, [], ['apply_upgrade']);
    expect(r.problems).toEqual([]);
    expect(r.product!.eligibility).toHaveLength(1);
  });
});

describe('products in journeys', () => {
  it('cross-selling is off outside a product sign-ups campaign; inside one, one product, linked to its page', () => {
    expect(productProblems(camp([send(), { kind: 'goalCheck' }, send({ name: 'Add-on', product: 'addon_card', link: 'apply_addon' })]), null, YES).join(' ')).toMatch(/only pitched in a product sign-ups campaign/);
    const c = (journey: unknown[]) => camp(journey, { intent: 'adoption', productId: 'addon_card', goal: { eventCategory: 'Product Events', eventType: 'Product Signed Up' } });
    expect(productProblems(c([send({ product: 'addon_card', link: 'rewards' })]), null, YES).join(' ')).toMatch(/set link to "apply_addon"/);
    expect(productProblems(c([send({ product: 'addon_card', link: 'apply_addon' })]), null, YES)).toEqual([]);
  });
  it('an adoption campaign sells its chosen product, with the sign-up goal', () => {
    const c = camp([send({ product: 'travel_card', link: 'apply_travel_card' })], { intent: 'adoption', productId: 'card_protection' });
    const p = productProblems(c, null, YES).join(' ');
    expect(p).toMatch(/goal is "Product Events \/ Product Signed Up"/);
    expect(p).toMatch(/sells "card_protection"; pitch that product/);
    const ok = camp([send({ product: 'card_protection', link: 'buy_card_protection' })], { intent: 'adoption', productId: 'card_protection', goal: { eventCategory: 'Product Events', eventType: 'Product Signed Up' } });
    expect(productProblems(ok, null, YES)).toEqual([]);
  });
});

describe('the intent tells the designer where to look', () => {
  it('sign-ups names the product; other intents say nothing about products; old campaigns read as "something else"', () => {
    expect(intentBlock(camp([], { intent: 'adoption', productId: 'travel_card' }), YES)).toMatch(/Drive product sign-ups[\s\S]*"name":"Travel credit card"/);
    expect(intentBlock(camp([], { intent: 'usage' }), YES)).not.toMatch(/product/i);
    expect(intentBlock(camp([]), YES)).toMatch(/Custom campaign/);
  });
});
