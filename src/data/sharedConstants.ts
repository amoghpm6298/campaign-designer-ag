// Ported from journeysnudgesemi/emi-conversions-prototype.html (2026-09-25)
// as a one-time fork, not a live shared source — there's no backend
// behind either app, so future edits to these constants in the plain-HTML
// prototype will NOT automatically propagate here. See CLAUDE.md if this
// ever needs re-syncing.
//
// Only the constants Drip Campaigns' own code actually reads are ported —
// confirmed against the real Drip Campaigns source (dcDrawerFormFor,
// dcCondRowsHtml, dcRecomputeLabelMeta, etc.), not assumed from adjacency.
// CHANNEL_LABELS (a near-duplicate of CHANNEL_CONFIG_LABELS with only one
// use site in the original) was deliberately dropped — this port uses
// CHANNEL_CONFIG_LABELS consistently instead.

export type Channel = 'SMS' | 'EMAIL' | 'RCS' | 'WHATSAPP';

export const CHANNEL_CONFIG_LABELS: Record<Channel, string> = {
  SMS: 'SMS',
  EMAIL: 'E-mail',
  RCS: 'RCS',
  WHATSAPP: 'WhatsApp',
};

export interface CommsTemplate {
  id: string;
  name: string;
  channelType: Channel;
  partnerName: string;
  vendorName: string;
  accountName: string;
  createdOn: string;
  message?: string;
  body?: string;
}

export const COMMS_TEMPLATES: CommsTemplate[] = [
  { id: 'CT-3301', name: 'EMI Conversion SMS', channelType: 'SMS', partnerName: 'IndusInd Bank (IBL)', vendorName: 'Karix', accountName: 'IBL-Karix-Txns', createdOn: '22 Jul 2026, 10:12', message: 'Hi ${customerFirstName}, convert your recent purchase to EMI in just 2 taps: ${shortUrl}' },
  { id: 'CT-3288', name: 'Festive Offer Email', channelType: 'EMAIL', partnerName: 'IndusInd Bank (IBL)', vendorName: 'Karix', accountName: 'IBL-Karix-Mktg', createdOn: '18 Jul 2026, 15:40', body: '<h2>Hi ${customerFirstName}</h2><p>Your festive EMI offer is here.</p>' },
  { id: 'CT-3270', name: 'Activation Reminder WhatsApp', channelType: 'WHATSAPP', partnerName: 'Yes Bank', vendorName: 'Gupshup', accountName: 'YES-Gupshup-Onb', createdOn: '10 Jul 2026, 09:05', message: 'Hi ${customerFirstName}, activate your card now: ${shortUrl}' },
  { id: 'CT-3255', name: 'OS-to-EMI RCS Push', channelType: 'RCS', partnerName: 'IndusInd Bank (IBL)', vendorName: 'Karix', accountName: 'IBL-Karix-Txns', createdOn: '02 Jul 2026, 12:00', message: 'Convert your outstanding balance to easy EMIs, ${customerFirstName}.' },
  { id: 'CT-3310', name: 'Auth-to-EMI Consent WhatsApp', channelType: 'WHATSAPP', partnerName: 'IndusInd Bank (IBL)', vendorName: 'Karix', accountName: 'IBL-Karix-Txns', createdOn: '10 Sep 2026, 09:00', message: 'Hi ${customerFirstName}, you have an eligible transaction — convert to EMI in 2 taps: ${shortUrl}' },
  { id: 'CT-3311', name: 'Auth-to-EMI Reminder WhatsApp', channelType: 'WHATSAPP', partnerName: 'IndusInd Bank (IBL)', vendorName: 'Karix', accountName: 'IBL-Karix-Txns', createdOn: '10 Sep 2026, 09:05', message: 'Still deciding? Your EMI conversion offer is open for a limited time: ${shortUrl}' },
  { id: 'CT-3312', name: 'EMI Outcome Notification WhatsApp', channelType: 'WHATSAPP', partnerName: 'IndusInd Bank (IBL)', vendorName: 'Karix', accountName: 'IBL-Karix-Txns', createdOn: '10 Sep 2026, 09:10', message: 'Update on your EMI request: ${emiStatus}. Check Manage EMIs for details.' },
  { id: 'CT-3313', name: 'Card Activation WhatsApp', channelType: 'WHATSAPP', partnerName: 'IndusInd Bank (IBL)', vendorName: 'Karix', accountName: 'IBL-Karix-Onb', createdOn: '10 Sep 2026, 09:15', message: 'Hi ${customerFirstName}, activate your new card and set your PIN: ${shortUrl}' },
  { id: 'CT-3314', name: 'PIN Setup Reminder WhatsApp', channelType: 'WHATSAPP', partnerName: 'IndusInd Bank (IBL)', vendorName: 'Karix', accountName: 'IBL-Karix-Onb', createdOn: '10 Sep 2026, 09:20', message: "You're almost there — finish setting your PIN to start using your card: ${shortUrl}" },
];

export const PROGRAM_OPTIONS: Record<string, string[]> = {
  'IndusInd Bank (IBL)': ['Platinum Aura', 'Signature Rewards'],
  'Yes Bank': ['Prosperity Card'],
};

const ISSUER_MAKER_CHECKER: Record<string, boolean> = {
  'IndusInd Bank (IBL)': false,
  'Yes Bank': true,
};
const PROGRAM_MAKER_CHECKER: Record<string, boolean> = {
  'Platinum Aura': true,
  'Signature Rewards': false,
  'Prosperity Card': false,
};
// Maker-checker is never determined by scope type alone — it's the
// issuer's own config OR any specifically-selected program's own flag.
export function computeMakerCheckerFlag(issuer: string, programs: string[]): boolean {
  if (ISSUER_MAKER_CHECKER[issuer]) return true;
  return (programs || []).some((p) => PROGRAM_MAKER_CHECKER[p]);
}

export interface EventCategoryMeta {
  events: string[];
  isNew?: boolean;
}
export const EVENT_CATEGORIES: Record<string, EventCategoryMeta> = {
  'Journey Events': { events: ['Journey Progress', 'Pageload', 'Button Click'] },
  'Offer Events': { events: ['Outcome Issuance'] },
  // Proposed, not real in Quibbler today — see the Transaction Event-Based
  // Nudges PRD. Marked isNew so the wizard visibly flags these as
  // not-yet-built rather than blending them in as audited, current
  // behavior.
  'Transaction Events': { events: ['Transaction'], isNew: true },
  'EMI Events': { events: ['EMI_STATUS_CHANGED'], isNew: true },
  'Card Events': { events: ['Card Issued', 'Card Activated', 'Card Loaded', 'Card Inactive'], isNew: true },
};

// Which flow a customer completed a triggering action through.
export const JOURNEY_OPTIONS = ['Txn-to-EMI', 'Multi-Txn-to-EMI', 'OS-to-EMI', 'Onboarding', 'Card Activation'];
export const EVENT_SOURCE_OPTIONS = ['PWA', ...JOURNEY_OPTIONS];

// Real, authoritative `TransactionType` enum — every value except the 2
// @Deprecated Rewards ones.
export const TRANSACTION_SUBTYPE_OPTIONS = [
  'ADD_FUND', 'ADD_FUND_REVERSAL', 'REVERSAL', 'SWEEP_IN', 'SWEEP_OUT',
  'AUTHORIZATION_REVERSAL', 'AUTHORIZE', 'CASHBACK', 'CASHBACK_REVERSAL',
  'CHARGEBACK', 'CHARGEBACK_REVERSAL', 'EMI_PRINCIPAL', 'EMI_INTEREST',
  'EMI_FORECLOSURE_DEBIT', 'FEE', 'FEE_REVERSAL', 'INTEREST', 'INTEREST_REVERSAL',
  'REFUND', 'REFUND_REVERSAL', 'REMITTANCE', 'REMITTANCE_REVERSAL', 'REPAYMENT',
  'REPAYMENT_REVERSAL', 'SETTLEMENT_CREDIT', 'SETTLEMENT_CREDIT_CASH',
  'SETTLEMENT_DEBIT', 'SETTLEMENT_DEBIT_CASH', 'EFT_WITHDRAWAL',
  'EFT_WITHDRAWAL_REVERSAL', 'SURCHARGE', 'SURCHARGE_REVERSAL', 'TAX', 'TAX_REVERSAL',
];

export type AttrType = 'date' | 'select' | 'bool' | 'number' | 'list' | 'smartTag' | 'multiSelect' | 'highestTxnEMI' | 'none';
export interface AttrMeta {
  type: AttrType;
  options?: string[];
}
export const ELIGIBILITY_META: Record<string, Record<string, AttrMeta>> = {
  Customer: {
    'Date of Birth': { type: 'date' },
    'KYC Status': { type: 'select', options: ['Small KYC', 'FKYC'] },
    'FKYC Method': { type: 'select', options: ['CKYC', 'VKYC'] },
    'FKYC Status': { type: 'select', options: ['Not Initiated', 'Pending', 'Rejected', 'Completed'] },
    'Created On': { type: 'date' },
    'Last Updated On': { type: 'date' },
  },
  Account: {
    Status: { type: 'select', options: ['Active', 'Charge off', 'Pending closure', 'Closed', 'Dormant', 'Suspended', 'Forced suspended'] },
    'Smart Tag': { type: 'smartTag' },
    'Statement Due Date': { type: 'date' },
    'Created On': { type: 'date' },
    'Last Updated On': { type: 'date' },
    'Account Block Codes': { type: 'list' },
  },
  Card: {
    Status: { type: 'select', options: ['Active', 'Inactive'] },
    'Smart Tag': { type: 'smartTag' },
    'Card Expiry': { type: 'date' },
    'Card Type': { type: 'select', options: ['Physical', 'Virtual', 'Virtual Upgrade To Physical', 'Phygital'] },
    'Physically Issued': { type: 'bool' },
    'Virtually Issued': { type: 'bool' },
    'Physical Card Activated': { type: 'bool' },
    'Virtual Card Activated': { type: 'bool' },
    'Is Ever Activated': { type: 'bool' },
    Locked: { type: 'bool' },
    Blocked: { type: 'bool' },
    'Created On': { type: 'date' },
    'Last Updated On': { type: 'date' },
    'Card Block Codes': { type: 'list' },
  },
  Transaction: {
    'Transaction Type': { type: 'multiSelect', options: TRANSACTION_SUBTYPE_OPTIONS },
    'Transaction Status': { type: 'multiSelect', options: ['APPROVED', 'SETTLED', 'PARTIALLY_SETTLED', 'EXPIRED', 'CANCELED'] },
    'EMI Eligible': { type: 'bool' },
    'Transaction Amount': { type: 'number' },
    MCC: { type: 'list' },
    'Initiated By': { type: 'select', options: ['CUSTOMER_INITIATED', 'SYSTEM_GENERATED'] },
  },
  'EMI Request': {
    'New Status': { type: 'select', options: ['Pending', 'Successful', 'Failed', 'Expired', 'Cancelled'] },
    'Product Type': { type: 'select', options: ['Single-Txn', 'Multi-Txn', 'Outstanding'] },
    Source: { type: 'select', options: EVENT_SOURCE_OPTIONS },
  },
};

// Real mechanism, confirmed directly against ironbank-face-main's own
// eligibility form (smartNudgesConstants.ts + createEligibilityComponent.js):
// a "Promotional Nudge" scopes its whole User Base to a MILESTONE entity —
// pick one specific, already-configured milestone benefit (live-fetched
// there via BenefitInput; a static illustrative list here, since this app
// has no backend), then either an "Is" check (Completed/Not Completed —
// picking Completed auto-sets value to "100", matching the real form
// exactly) or a numeric/percentage comparator against that one benefit's
// progress. Not an Account attribute, not an "Engagement Tier" — those
// were fabricated and removed outright (see CLAUDE.md). This is the real
// replacement mechanism, reused across Entry · Audience (entity =
// 'Milestone'), Condition (customSource = 'Milestone'), and Branch
// (source = 'Milestone').
export interface MilestoneBenefit {
  id: string;
  name: string;
}
export const MILESTONE_BENEFITS: MilestoneBenefit[] = [
  { id: 'MS-1001', name: 'Spend ₹25,000 in first 30 days' },
  { id: 'MS-1002', name: 'Spend ₹75,000 in first 90 days' },
  { id: 'MS-1003', name: 'Spend ₹1,50,000 in first 180 days' },
  { id: 'MS-1004', name: 'Spend ₹3,00,000 in first 365 days' },
];
export function milestoneBenefitName(id: string | undefined): string {
  return MILESTONE_BENEFITS.find((b) => b.id === id)?.name || '';
}
// Same 8 real operator values as the real app's `deliveryValueListSuperSet`
// (GT/GTE/LT/LTE/BETWEEN/GTE_PCT/LTE_PCT/IS) — not invented labels.
export interface MilestoneOperatorMeta {
  value: string;
  label: string;
}
export const MILESTONE_OPERATORS: MilestoneOperatorMeta[] = [
  { value: 'GT', label: 'Greater than' },
  { value: 'GTE', label: 'Greater than or equal to' },
  { value: 'LT', label: 'Less than' },
  { value: 'LTE', label: 'Less than or equal to' },
  { value: 'BETWEEN', label: 'Between' },
  { value: 'GTE_PCT', label: 'Greater than or equal to percentage' },
  { value: 'LTE_PCT', label: 'Less than or equal to percentage' },
  { value: 'IS', label: 'Is' },
];

// Which entity Drip's Entry Event / Wait Until / Split "Entry event
// attribute" condition builder resolves to per Event Category.
export const DC_EVENT_ENTITY: Record<string, string> = {
  'Transaction Events': 'Transaction',
  'EMI Events': 'EMI Request',
};
// An entity's one dominant attribute that IS the point of picking that
// event type at all (New Status for EMI_STATUS_CHANGED) — promoted to
// always-visible instead of buried behind "Add condition".
export const DC_PROMOTED_ATTR: Record<string, string> = {
  'EMI Request': 'New Status',
};

// Journey/Offer Events narrowing — ported from
// journeysnudgesemi/emi-conversions-prototype.html's separate
// "event-based nudges" feature (its EVENT_TRIGGER step), not from this
// app's own original Drip Campaigns prototype. That original fell back
// to condRow()'s generic free-text-attribute path for these categories
// (its own DC_EVENT_ENTITY comment: "Journey/Offer/Card Events have no
// such entity yet... so they fall back to a plain text attribute name").
// The richer mechanism below is the one confirmed directly against the
// event-based-nudges wizard specifically, per explicit instruction.
//
// Journey/Offer Events only ever need ONE attribute each, not a full
// entity attribute set — "Event Conditions are attribute-based per event
// type, not entity-based — the attribute is effectively locked once the
// event is chosen" (source's own comment). Transaction/EMI Events keep
// using the generic entity-based ConditionRows builder above instead —
// the same source file reserves the locked-attribute pattern
// specifically for Journey/Offer Events, since Transaction/EMI "each
// genuinely need multiple independent filterable attributes... instead
// of one locked attribute."
export const EVENT_ATTR_BY_TYPE: Record<string, string> = {
  'Journey Progress': 'Status',
  Pageload: 'Page Name',
  'Button Click': 'Button Name',
  'Outcome Issuance': 'Outcome Status',
};
export const LOCKED_ATTR_OPERATORS = ['Equals', 'Not Equals', 'Greater than', 'Less than', 'Is'];

// Which operators a condition row may use for a given attribute. Extracted
// verbatim from ConditionRows.tsx, where it had been inline, because the
// agent's own capability tool needs the SAME answer the builder gives. Two
// copies of this rule would drift, and the agent proposing an operator the
// drawer does not offer is exactly the class of defect that forces a person
// to correct the campaign by hand.
export function dcOperatorsForAttribute(meta: AttrMeta | null | undefined, opts?: { locked?: boolean }): string[] {
  if (opts?.locked) return LOCKED_ATTR_OPERATORS;
  if (meta?.type === 'multiSelect') return ['Any of'];
  if (meta?.type === 'number' || meta?.type === 'date') return ['Equals', 'Greater than', 'Less than', 'Between'];
  return ['Equals', 'Not Equals'];
}

// Journey Events' own scoping selects (shown above its Event Conditions
// in the source). JOURNEY_OPTIONS above is already the real, reused
// constant; BATCH_OPTIONS is newly ported here.
export const BATCH_OPTIONS = ['Aug Festive Batch', 'Sep Reactivation Batch', 'Q3 Consolidation Batch'];

// Offer Events' own scoping selects. OFFER_TYPE_OPTIONS here is the real,
// reused constant from elsewhere in the same source file — the
// EVENT_TRIGGER step's own inline Offer Type list (['CVP','Campaign',
// 'Merchant']) is a separate, shorter, inconsistently-named stub that
// was never wired to this constant; this port uses the real one.
// Offer Name has no equivalent real catalog anywhere in that source —
// its EVENT_TRIGGER step hardcodes exactly one example
// ('Festive EMI Push') and nothing else. `IBL_CAMPAIGNS` elsewhere in
// the same file looks adjacent but is unrelated demo-data-generation
// filler for an EMI-conversions analytics table, not a verified list of
// real offer names for this feature — presenting it as one would be
// inventing a catalog that was never actually built. Offer Name is a
// free-text field here for that reason, not a constrained select.
export const OFFER_TYPE_OPTIONS = ['CVP', 'Campaign Offers', '3rd Party Offers', 'Merchant Offers', 'Bank Offers', 'Activation Offers'];

// Centralizes "what does Condition/Branch's 'Entry event attribute'
// source actually mean for this entry" into one function, reused by both
// SplitForm and DecisionSplitForm so they can't resolve it differently.
// Exactly one of `entity`/`lockedAttr` is ever non-null: Transaction/EMI
// Events resolve a real entity (existing ConditionRows/ELIGIBILITY_META
// path); Journey/Offer Events resolve a locked single attribute instead,
// once their eventType is known; anything else (Card Events, or no
// eventType picked yet) resolves neither, same as today.
export function resolveEntryEventAttrSource(eventCategory: string | null, eventType: string | null): { entity: string | null; lockedAttr: string | null } {
  if (!eventCategory) return { entity: null, lockedAttr: null };
  const entity = DC_EVENT_ENTITY[eventCategory] || null;
  if (entity) return { entity, lockedAttr: null };
  const lockedAttr = eventType ? EVENT_ATTR_BY_TYPE[eventType] || null : null;
  return { entity: null, lockedAttr };
}

// Real per-channel delivery-status vocabulary (Bifrost) — used by Split's
// "Previous step outcome" source and Decision Split's own version of it.
export const DELIVERY_STATUS_COMMON = ['SENT_TO_SERVICE_PROVIDER', 'FAILED', 'UN_CATEGORISED', 'FAILED_ON_UPLOAD', 'FAILED_TO_CONNECT', 'FAILED_SYSTEM_ISSUES'];
export const DELIVERY_STATUS_BY_CHANNEL: Record<Channel, string[]> = {
  SMS: ['SENT', 'DELIVERED', 'UNKNOWN', 'FAILED_DND', 'FAILED_BLACKLIST', 'FAILED_CALL_BARRED', 'FAILED_EXPIRED', 'FAILED_INBOX_FULL', 'FAILED_SUBSCRIBER_ABSENT', 'FAILED_SUBSCRIBER_UNKNOWN', 'FAILED_TEMPLATE_MISMATCH', 'FAILED_URL_MISMATCH', 'FAILED_DLT_FAILURE', 'FAILED_SYSTEM_ISSUES', 'FAILED_PENDING', 'FAILED_OTHER'],
  EMAIL: ['SENT', 'DELIVERED', 'PENDING', 'QUEUED', 'OPENED', 'CLICKED', 'HARD_BOUNCE', 'SOFT_BOUNCE', 'SPAM', 'SUPPRESSED', 'NOT_SENT', 'NOT_DELIVERED', 'FAILED'],
  WHATSAPP: ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'DELETED', 'FAILED', 'UNKNOWN'],
  RCS: ['SENT', 'DELIVERED', 'READ', 'CLICKED', 'REJECTED', 'NOT_SENT', 'NOT_DELIVERED', 'DND', 'FAILED', 'FAILED_EXPIRED', 'FAILED_TO_CONNECT', 'FAILED_TEMPLATE_MISMATCH', 'FAILED_SYSTEM_ISSUES', 'FAILED_OTHER'],
};
// Merged, deduped (common first, then whatever the channel adds that isn't
// already in common).
export function deliveryStatusOptionsFor(channel: Channel): string[] {
  const chanList = DELIVERY_STATUS_BY_CHANNEL[channel] || [];
  return [...DELIVERY_STATUS_COMMON, ...chanList.filter((s) => !DELIVERY_STATUS_COMMON.includes(s))];
}
// No channel known — union across every channel rather than showing nothing.
export function deliveryStatusOptionsAll(): string[] {
  const all = new Set(DELIVERY_STATUS_COMMON);
  Object.values(DELIVERY_STATUS_BY_CHANNEL).forEach((list) => list.forEach((s) => all.add(s)));
  return [...all];
}

// A Send with a fallback channel could have actually delivered via
// either one — "Previous step outcome" needs both channels' vocabularies,
// not just the primary, since the fallback is the one that's genuinely
// unknown-in-advance (it only fires if the primary failed).
export interface PrevStepSend {
  channel: Channel;
  fallbackChannel: Channel | null;
}
export function deliveryStatusOptionsForSend(send: PrevStepSend): string[] {
  const primary = deliveryStatusOptionsFor(send.channel);
  if (!send.fallbackChannel) return primary;
  const fallback = deliveryStatusOptionsFor(send.fallbackChannel);
  return [...new Set([...primary, ...fallback])];
}
