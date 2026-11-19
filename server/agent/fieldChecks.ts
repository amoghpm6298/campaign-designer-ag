// Checks on personal words in messages ({{field | "fallback"}}): the field is
// a signal the bank has and allows in copy (sensitive ones never are), every
// field has a fallback, and an SMS stays within 160 characters even with the
// longest value. Code only points at problems; the agent fixes them.
import type { CampaignObject } from './types';
import type { BpStep } from '../blueprint';
import type { TenantConfig } from '../tenants';
import { walkSteps } from './stepIds';
import { fieldSamples, signalsFor } from '../signals';
import { incentivesFor } from '../incentives';
import { assembleSms } from '../../src/designer/v2/smsText';
import { fillFields, formatValue, malformedFields, parseFields } from '../../src/designer/v2/personalFields';

/** A short link's length, for counting an SMS before the real link is known. */
const SHORT_LINK = 'https://xx.in/AbCd1';

export function fieldProblems(campaign: CampaignObject, tenant: Pick<TenantConfig, 'incentives' | 'warehouse'> | null): string[] {
  const out: string[] = [];
  const signals = signalsFor(tenant);
  const samples = fieldSamples(tenant, formatValue);
  const offers = incentivesFor(tenant);
  const lanes = [
    ...campaign.buckets.map((b) => ({ name: `Bucket "${b.name}"`, journey: b.journey })),
    ...(campaign.everyoneElse?.approach === 'journey' ? [{ name: 'Everyone else', journey: campaign.everyoneElse.journey }] : []),
  ];
  for (const lane of lanes) {
    walkSteps(lane.journey as BpStep[] | null | undefined, (st) => {
      const s = st as unknown as Record<string, unknown>;
      if (s.kind !== 'send') return;
      const where = `${lane.name} › "${String(s.name ?? s.label ?? 'a message')}"`;
      const text = `${String(s.copy ?? '')} ${String(s.cta ?? '')}`;
      for (const bad of malformedFields(text)) out.push(`${where}: "${bad}" isn't a valid personal field. Write it as {{signal_key | "fallback"}}.`);
      const refs = parseFields(text);
      for (const r of refs) {
        const sig = signals.find((x) => x.key === r.key);
        if (!sig) out.push(`${where}: {{${r.key}}} is not a signal for this bank (list_signals).`);
        else if (sig.sensitivity === 'restricted') out.push(`${where}: {{${r.key}}} is sensitive and can never appear in a message. Remove it.`);
        else if (!sig.usableIn.includes('copy')) out.push(`${where}: {{${r.key}}} can't be used in a message.`);
        if (!r.fallback) out.push(`${where}: {{${r.key}}} needs a fallback for customers with no value: {{${r.key} | "…"}}.`);
      }
      // An SMS (or a message that may fall back to SMS) must fit with the longest value of every field.
      const channels = [...((s.channelPreference as string[] | undefined) ?? []), String(s.fallbackChannel ?? '')];
      if (refs.length && channels.includes('SMS')) {
        const longest = (k: string) => samples.find((x) => x.key === k)?.longest || null;
        const offer = typeof s.incentive === 'string' ? offers.find((o) => o.id === s.incentive)?.offerLine : undefined;
        const sms = assembleSms(fillFields(String(s.copy ?? ''), (r) => longest(r.key)), s.cta as string | undefined, s.link ? SHORT_LINK : undefined, offer);
        if (sms.length > 160) out.push(`${where}: with the longest values filled in, the SMS is ${sms.length} characters (max 160). Shorten the copy.`);
      }
    });
  }
  return out;
}
