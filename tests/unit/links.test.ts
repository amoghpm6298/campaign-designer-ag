// The bank's link registry, and how messages use it: the agent may read URLs,
// but a message only ever carries a link reference; the engine resolves it.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLinks, saveLink, retireLink, resolveLink, linkProblem, forAgent } from '../../server/links';
import { initialState } from '../../server/agent/state';
import { runToolCall, type ToolEnv } from '../../server/agent/tools';
import { resolveTenant } from '../../server/tenants';
import { checkJourneys } from '../../server/agent/compile';
import { statusBlock } from '../../server/agent/prompt';
import type { AgentState } from '../../server/agent/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cd-links-'));
  process.env.LINKS_DIR = dir;
});

const env = (): ToolEnv => ({ tenant: resolveTenant('TEN-IBL')!, availableChannels: ['SMS', 'WHATSAPP'], goalStatement: 'x', sessionId: 's1', lookupCache: new Map(), links: listLinks('TEN-IBL') });
const send = (name: string, ch: string, extra: Record<string, unknown> = {}) => ({ kind: 'send', name, stage: 'first-touch', describe: name, objective: ['activation'], channelPreference: [ch], copy: `${name}: your card is ready.`, ...extra });

function built(journey: unknown[]): AgentState {
  let s = runToolCall('edit_campaign', { name: 'C', goal: { eventCategory: 'Card Events', eventType: 'Card Activated' }, entry: { entity: 'Card' }, membership: { type: 'locked' }, everyoneElse: { approach: 'none' } }, initialState(), env()).state;
  const r = runToolCall('edit_bucket', { id: 'b1', name: 'B1', priority: 1, rule: [{ entity: 'Card', conditions: [] }], journey }, s, env());
  expect(r.ok).toBe(true);
  s = r.state;
  return s;
}

describe('the registry', () => {
  it('seeds example links, saves, retires, and keeps refs stable', () => {
    const seeded = listLinks('TEN-IBL');
    expect(seeded.map((l) => l.ref)).toContain('activate_card');
    expect(seeded.every((l) => l.mock)).toBe(true);
    expect(saveLink('TEN-IBL', { ref: 'Bad Ref', label: 'x', url: 'https://a.in/x' }).ok).toBe(false);
    expect(saveLink('TEN-IBL', { ref: 'new_page', label: 'x', url: 'http://not-secure.in' }).ok).toBe(false);
    expect(saveLink('TEN-IBL', { ref: 'new_page', label: 'New page', purpose: 'p', url: 'https://www.indusind.com/new', shortUrl: 'https://indus.in/Nw1' }).ok).toBe(true);
    expect(listLinks('TEN-IBL').find((l) => l.ref === 'new_page')?.mock).toBeUndefined();
    expect(retireLink('TEN-IBL', 'new_page').ok).toBe(true);
    expect(listLinks('TEN-IBL').find((l) => l.ref === 'new_page')?.status).toBe('retired');
  });

  it('resolves a reference for the engine: short link for SMS, full URL otherwise, and refuses what cannot be sent', () => {
    expect(resolveLink('TEN-IBL', 'activate_card', 'SMS')).toBe('https://indus.in/Ac7k2');
    expect(resolveLink('TEN-IBL', 'activate_card', 'WHATSAPP')).toMatch(/^https:\/\/www\.indusind\.com\//);
    expect(() => resolveLink('TEN-IBL', 'help_activation', 'SMS')).toThrow(/no short link/);
    expect(() => resolveLink('TEN-IBL', 'nope', 'SMS')).toThrow(/no link "nope"/);
    retireLink('TEN-IBL', 'set_pin');
    expect(() => resolveLink('TEN-IBL', 'set_pin', 'WHATSAPP')).toThrow(/retired/);
    expect(linkProblem(listLinks('TEN-IBL'), 'activate_card', 'SMS')).toBeNull();
  });

  it('the agent can read URLs (to understand the destination and fit SMS length)', () => {
    const view = forAgent(listLinks('TEN-IBL')[0]);
    expect(view.url).toMatch(/^https:/);
    expect(view.shortUrlLength).toBe(view.shortUrl!.length);
    const r = runToolCall('list_links', {}, initialState(), env());
    expect(r.ok).toBe(true);
    expect(r.forModel).toContain('activate_card');
  });
});

describe('messages carry references, never URLs', () => {
  it('a valid link is accepted, and no link at all is fine (links are the norm, not mandatory)', () => {
    const s = built([send('Activate', 'SMS', { cta: 'Activate now', link: 'activate_card' }), send('Just so you know', 'WHATSAPP', { cta: 'Activate now' })]);
    expect(s.campaign.buckets[0].journey).toHaveLength(2);
  });

  it('a URL or web address written into copy or CTA is refused', () => {
    const s = built([send('First', 'SMS')]);
    for (const bad of [{ copy: 'Activate at https://indus.in/Ac7k2' }, { copy: 'Visit www.indusind.com today' }, { cta: 'indus.in/activate' }]) {
      const r = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'replace', path: '0', step: send('First', 'SMS', bad) }] }, s, env());
      expect(r.ok).toBe(false);
      expect(r.forModel).toMatch(/never write a URL/);
      expect(r.state).toBe(s);
    }
  });

  it('an unknown or retired link, or an SMS link without a short URL, is refused with the usable links', () => {
    const s = built([send('First', 'SMS')]);
    const unknown = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'replace', path: '0', step: send('First', 'SMS', { link: 'set_pin_page' }) }] }, s, env());
    expect(unknown.ok).toBe(false);
    expect(unknown.forModel).toMatch(/no link "set_pin_page".*Usable links: .*activate_card/);
    const noShort = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'replace', path: '0', step: send('First', 'SMS', { link: 'help_activation' }) }] }, s, env());
    expect(noShort.forModel).toMatch(/no short link yet/);
    const onWhatsApp = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'replace', path: '0', step: send('First', 'WHATSAPP', { link: 'help_activation' }) }] }, s, env());
    expect(onWhatsApp.ok).toBe(true);
    const fallbackSms = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'replace', path: '0', step: send('First', 'WHATSAPP', { link: 'help_activation', fallbackChannel: 'SMS' }) }] }, s, env());
    expect(fallbackSms.ok).toBe(false);
  });

  it('a link retired after the build is caught by the build checks and the status block, and does not block unrelated edits', () => {
    const s = built([send('First', 'SMS', { link: 'set_pin' }), { kind: 'wait', durationHours: 48 }, send('Second', 'WHATSAPP')]);
    retireLink('TEN-IBL', 'set_pin');
    const e = env();
    expect(checkJourneys(s.campaign, e.links).join(' ')).toMatch(/"First": the link "Set your card PIN" \(set_pin\) was retired/);
    expect(statusBlock(s, e.links)).toMatch(/Link problems: .*set_pin/);
    // An unrelated edit (the wait) still goes through.
    expect(runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'replace', path: '1', step: { kind: 'wait', durationHours: 72 } }] }, s, e).ok).toBe(true);
    expect(runToolCall('build_campaign', {}, s, e).forModel).toMatch(/FIX BEFORE YOU FINISH.*retired/);
  });
});

describe('the SMS as it is sent', () => {
  it('copy, then the CTA and a colon, then the short link — no doubled colon, no repeated CTA', async () => {
    const { assembleSms, smsLength } = await import('../../src/designer/v2/smsText');
    const url = 'https://indus.in/Ac7k2';
    expect(assembleSms('Your card is ready', 'Activate now', url)).toBe(`Your card is ready. Activate now: ${url}`);
    expect(assembleSms('Your card is ready. Activate it for ATM use:', 'Activate now', url)).toBe(`Your card is ready. Activate it for ATM use. Activate now: ${url}`);
    expect(assembleSms('Ready to go? Activate now', 'Activate now', url)).toBe(`Ready to go? Activate now: ${url}`);
    expect(assembleSms('Your card is ready. Activate now to start earning rewards:', 'Activate now', url)).toBe(`Your card is ready. Activate now to start earning rewards: ${url}`);
    expect(assembleSms('Just so you know, your card is on its way.', undefined, undefined)).toBe('Just so you know, your card is on its way.');
    expect(smsLength('x'.repeat(161)).parts).toBe(2);
  });

  it('the engine resolves the SMS text from the registry', async () => {
    const { smsTextFor } = await import('../../server/links');
    expect(smsTextFor('TEN-IBL', { copy: 'Your card is ready', cta: 'Activate now', link: 'activate_card' })).toBe('Your card is ready. Activate now: https://indus.in/Ac7k2');
  });
});
