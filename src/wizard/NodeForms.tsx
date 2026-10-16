// Ported from journeysnudgesemi/emi-conversions-prototype.html's
// dcDrawerFormFor — one component per node type's config form, same
// fields/cascades as the original (Account/Template cascade, Previous-
// step-outcome channel-aware status list, Random/Decision Split dynamic
// branch lists with mid-list insert, etc).
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CHANNEL_CONFIG_LABELS,
  COMMS_TEMPLATES,
  EVENT_CATEGORIES,
  ELIGIBILITY_META,
  LOCKED_ATTR_OPERATORS,
  resolveEntryEventAttrSource,
  deliveryStatusOptionsForSend,
  deliveryStatusOptionsAll,
  type Channel,
  type PrevStepSend,
} from '../data/sharedConstants';
import type { DripGoal, DripMilestoneCondition, DripAgentMessaging } from '../data/graphTypes';
import { dcOrdinal, dcRecurrenceLabel, dcGoalLabel, dcSelectedMulti } from '../reducer/labelMeta';
import { dcNewBranchId } from '../reducer/idGen';
import { dcDefaultTxnHistory, dcDefaultMilestone } from '../reducer/defaultConfig';
import { ConditionsSection, ConditionRows, ValueField } from './ConditionRows';
import { MultiSelectDropdown } from '../components/MultiSelectDropdown';
import { TxnHistoryFields, TxnLookbackFields } from './TxnHistoryFields';
import { MilestoneConditionFields, MilestoneValueField } from './MilestoneFields';
import { MILESTONE_BENEFITS, MILESTONE_OPERATORS } from '../data/sharedConstants';
import { EventScopingFields } from './EventScopingFields';

interface FormProps {
  p: any;
  onChange: (patch: any) => void;
}

// Transaction is a real entity choice here, not a separate toggle or a
// different "kind" of filter — its attributes already exist in
// ELIGIBILITY_META and already render through the same ConditionRows
// every other entity uses. The only things it needs that Customer/
// Account/Card don't are a lookback window and an existence direction
// (see EntityConditionBlock below) — three optional fields, not a
// different shape. Milestone is the real replacement for the fabricated
// Account fields this project briefly had (Milestone Progress %/
// Engagement Tier, removed outright — see CLAUDE.md): a specific
// benefit's Completed/Not-Completed or numeric/percentage progress,
// confirmed directly against ironbank-face-main's own Promotional Nudge
// eligibility form, not a free Account attribute.
const ENTITY_OPTIONS = ['Customer', 'Account', 'Card', 'Transaction', 'Milestone'];

// One Entity + its own Conditions (+ lookback/existence, when the entity
// is Transaction) — reused for Entry · Audience's primary block and for
// each additional entity filter, so "Account = Dormant AND Card = Active"
// is just two of these stacked, AND'd, and "no transaction in 90 days" is
// simply a third with entity = Transaction. Only the additional blocks
// are individually removable; the primary block has no remove affordance
// of its own (clearing all its condition rows collapses it back to the
// existing "No conditions are set" empty state instead).
function EntityConditionBlock({
  entity,
  conditions,
  lookbackDuration,
  lookbackUnit,
  existence,
  milestone,
  onEntityChange,
  onConditionsChange,
  onTxnFieldsChange,
  onMilestoneChange,
  onRemove,
}: {
  entity: string;
  conditions: any[];
  lookbackDuration?: number;
  lookbackUnit?: 'days' | 'hours';
  existence?: 'exists' | 'none';
  milestone?: DripMilestoneCondition;
  onEntityChange: (entity: string) => void;
  onConditionsChange: (conditions: any[]) => void;
  onTxnFieldsChange: (patch: { lookbackDuration?: number; lookbackUnit?: 'days' | 'hours'; existence?: 'exists' | 'none' }) => void;
  onMilestoneChange: (milestone: DripMilestoneCondition) => void;
  onRemove?: () => void;
}) {
  const isTxn = entity === 'Transaction';
  const isMilestone = entity === 'Milestone';
  return (
    <div className="f-group" style={onRemove ? { paddingTop: 12, marginTop: 4, borderTop: '1px dashed var(--gray-200)' } : undefined}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <label className="f-label">Entity</label>
        {onRemove && (
          <div className="cond-remove" style={{ width: 'auto', height: 'auto' }} onClick={onRemove} title="Remove this filter">
            ✕
          </div>
        )}
      </div>
      <select className="f-input" value={entity} onChange={(e) => onEntityChange(e.target.value)}>
        {ENTITY_OPTIONS.map((e) => (
          <option key={e}>{e}</option>
        ))}
      </select>
      {isMilestone ? (
        <div style={{ marginTop: 10 }}>
          <MilestoneConditionFields value={milestone ?? dcDefaultMilestone()} onChange={onMilestoneChange} />
        </div>
      ) : (
        <>
          <label className="f-label" style={{ marginTop: 10 }}>
            {isTxn ? (
              <>
                Filters <span style={{ fontWeight: 400, color: 'var(--gray-500)' }}>(optional)</span>
              </>
            ) : (
              'Conditions'
            )}
          </label>
          <ConditionRows conditions={conditions} entity={entity} onChange={onConditionsChange} />
          {isTxn && (
            <div style={{ marginTop: 10 }}>
              <TxnLookbackFields lookbackDuration={lookbackDuration ?? 90} lookbackUnit={lookbackUnit ?? 'days'} existence={existence ?? 'exists'} onChange={onTxnFieldsChange} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function EntrySegmentForm({ p, onChange }: FormProps) {
  const extraGroups = p.extraEntityGroups || [];
  const setExtraGroup = (i: number, patch: any) => {
    const next = extraGroups.map((g: any, idx: number) => (idx === i ? { ...g, ...patch } : g));
    onChange({ extraEntityGroups: next });
  };
  const removeExtraGroup = (i: number) => onChange({ extraEntityGroups: extraGroups.filter((_: any, idx: number) => idx !== i) });
  const addExtraGroup = () => onChange({ extraEntityGroups: [...extraGroups, { entity: 'Customer', conditions: [{ attribute: '', operator: '', value: '' }] }] });
  return (
    <>
      <div className="f-group">
        <label className="f-label">Segment name</label>
        <input className="f-input" type="text" value={p.cohortDesc} onChange={(e) => onChange({ cohortDesc: e.target.value })} />
      </div>
      <div className="f-group">
        <label className="f-label">Runs</label>
        <select className="f-input" value={p.repeat ? 'Repeat' : 'Once'} onChange={(e) => onChange({ repeat: e.target.value === 'Repeat' })}>
          <option value="Once">Once — a static snapshot</option>
          <option value="Repeat">On a repeating schedule</option>
        </select>
      </div>
      {p.repeat && (
        <>
          <div className="f-group">
            <label className="f-label">Repeats</label>
            <select className="f-input" value={p.recurrenceType} onChange={(e) => onChange({ recurrenceType: e.target.value })}>
              <option>Monthly</option>
              <option>Weekly</option>
              <option>Daily</option>
            </select>
          </div>
          {p.recurrenceType === 'Monthly' && (
            <div className="f-group">
              <label className="f-label">On</label>
              <select className="f-input" value={p.dayOfMonth} onChange={(e) => onChange({ dayOfMonth: e.target.value })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {dcOrdinal(d)}
                  </option>
                ))}
                <option value="last">Last day</option>
              </select>
            </div>
          )}
          {p.recurrenceType === 'Weekly' && (
            <div className="f-row2">
              <div className="f-group">
                <label className="f-label">Every</label>
                <input className="f-input" type="number" min={1} value={p.weekInterval} onChange={(e) => onChange({ weekInterval: e.target.value })} />
              </div>
              <div className="f-group">
                <label className="f-label">On</label>
                <select className="f-input" value={p.dayOfWeek} onChange={(e) => onChange({ dayOfWeek: e.target.value })}>
                  {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {p.recurrenceType === 'Daily' && (
            <div className="f-group">
              <label className="f-label">Every N days</label>
              <input className="f-input" type="number" min={1} value={p.dayInterval} onChange={(e) => onChange({ dayInterval: e.target.value })} />
            </div>
          )}
          <div className="f-group">
            <label className="f-label">At</label>
            <input className="f-input" type="time" value={p.timeOfDay} onChange={(e) => onChange({ timeOfDay: e.target.value })} />
          </div>
          <p className="f-hint">{dcRecurrenceLabel(p)}</p>
        </>
      )}
      {p.conditions.length === 0 ? (
        // Entity only has a visible effect once there's a real condition
        // to scope it to — asking for it any earlier is a dead-end choice
        // (Customer vs. Account vs. Card changes nothing about an
        // unfiltered "everyone" segment). So it stays hidden until a
        // condition actually exists, rather than being a mandatory
        // up-front field that does nothing most of the time.
        <div className="f-group">
          <p className="f-hint" style={{ margin: '0 0 6px' }}>
            No conditions are set. This targets everyone{p.repeat ? ' matching this schedule' : ''}.
          </p>
          <div className="add-link" onClick={() => onChange({ conditions: [{ attribute: '', operator: '', value: '' }] })}>
            + Add condition to narrow
          </div>
        </div>
      ) : (
        <>
          <EntityConditionBlock
            entity={p.entity}
            conditions={p.conditions}
            lookbackDuration={p.lookbackDuration}
            lookbackUnit={p.lookbackUnit}
            existence={p.existence}
            milestone={p.milestone}
            onEntityChange={(entity) =>
              onChange({ entity, conditions: [{ attribute: '', operator: '', value: '' }], lookbackDuration: 90, lookbackUnit: 'days', existence: 'exists', milestone: dcDefaultMilestone() })
            }
            onConditionsChange={(conditions) => onChange({ conditions })}
            onTxnFieldsChange={(patch) => onChange(patch)}
            onMilestoneChange={(milestone) => onChange({ milestone })}
          />
          {extraGroups.map((g: any, i: number) => (
            <EntityConditionBlock
              key={i}
              entity={g.entity}
              conditions={g.conditions}
              lookbackDuration={g.lookbackDuration}
              lookbackUnit={g.lookbackUnit}
              existence={g.existence}
              milestone={g.milestone}
              onEntityChange={(entity) =>
                setExtraGroup(i, { entity, conditions: [{ attribute: '', operator: '', value: '' }], lookbackDuration: 90, lookbackUnit: 'days', existence: 'exists', milestone: dcDefaultMilestone() })
              }
              onConditionsChange={(conditions) => setExtraGroup(i, { conditions })}
              onTxnFieldsChange={(patch) => setExtraGroup(i, patch)}
              onMilestoneChange={(milestone) => setExtraGroup(i, { milestone })}
              onRemove={() => removeExtraGroup(i)}
            />
          ))}
          <div className="add-link" onClick={addExtraGroup}>
            + Add another entity filter
          </div>
          <p className="f-hint" style={{ margin: '4px 0 0' }}>
            Every filter here is AND'd together — a customer must match all of them. Pick "Transaction" as the entity to require (or rule out) a qualifying transaction in a lookback window, or "Milestone" to check a specific benefit's progress, instead of a current attribute.
          </p>
        </>
      )}
      {p.repeat && <p className="f-hint">This re-evaluates fresh every time the schedule fires. It isn't a one-time snapshot.</p>}
    </>
  );
}

export function EntryEventForm({ p, onChange }: FormProps) {
  return (
    <>
      <div className="f-group">
        <label className="f-label">Event Category</label>
        <select className="f-input" value={p.eventCategory} onChange={(e) => onChange({ eventCategory: e.target.value, eventType: '' })}>
          {Object.keys(EVENT_CATEGORIES).map((k) => (
            <option key={k} value={k}>
              {k}
              {EVENT_CATEGORIES[k].isNew ? ' (New)' : ''}
            </option>
          ))}
        </select>
      </div>
      <EventScopingFields eventCategory={p.eventCategory} value={p} onChange={onChange} />
      <div className="f-group">
        <label className="f-label">Event Type</label>
        <select className="f-input" value={p.eventType} onChange={(e) => onChange({ eventType: e.target.value })}>
          <option value="">Select event</option>
          {(EVENT_CATEGORIES[p.eventCategory]?.events || []).map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>
      {(() => {
        const { entity, lockedAttr } = resolveEntryEventAttrSource(p.eventCategory, p.eventType);
        return <ConditionsSection conditions={p.conditions} entity={entity} lockedAttribute={lockedAttr} onChange={(conditions) => onChange({ conditions })} />;
      })()}
    </>
  );
}

// accountKey/templateKey let this same pair of fields target either the
// primary account/templateId or (for a Send's optional fallback) a
// separate fallbackAccount/fallbackTemplateId — a template is always
// locked to one channel, so the fallback channel needs its own pair
// rather than sharing the primary's.
function AccountTemplateFields({
  channel,
  p,
  onChange,
  accountKey = 'account',
  templateKey = 'templateId',
  accountLabel = 'Account',
  templateLabel = 'Template',
}: {
  channel: Channel;
  p: any;
  onChange: (patch: any) => void;
  accountKey?: string;
  templateKey?: string;
  accountLabel?: string;
  templateLabel?: string;
}) {
  const account = p[accountKey];
  const templateId = p[templateKey];
  const accounts = [...new Set(COMMS_TEMPLATES.filter((x) => x.channelType === channel).map((x) => x.accountName))];
  const templates = COMMS_TEMPLATES.filter((x) => x.channelType === channel && (!account || x.accountName === account));
  return (
    <>
      <div className="f-group">
        <label className="f-label">{accountLabel}</label>
        <select className="f-input" value={account} onChange={(e) => onChange({ [accountKey]: e.target.value, [templateKey]: '' })}>
          <option value="">Select account</option>
          {accounts.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </div>
      <div className="f-group">
        <label className="f-label">{templateLabel}</label>
        <select className="f-input" value={templateId} onChange={(e) => onChange({ [templateKey]: e.target.value })}>
          <option value="">Select template</option>
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        {!templates.length && (
          <div className="f-hint">
            No {CHANNEL_CONFIG_LABELS[channel]} templates exist yet{account ? ' for this account' : ''}.
          </div>
        )}
      </div>
    </>
  );
}

export function SendForm({ p, onChange }: FormProps) {
  return (
    <>
      <div className="f-group">
        <label className="f-label">Step name</label>
        <input className="f-input" type="text" value={p.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div className="f-row2">
        <div className="f-group">
          <label className="f-label">Channel</label>
          <select
            className="f-input"
            value={p.channel}
            onChange={(e) =>
              onChange({
                channel: e.target.value,
                account: '',
                templateId: '',
                ...(p.fallbackChannel === e.target.value ? { fallbackChannel: '', fallbackAccount: '', fallbackTemplateId: '' } : {}),
              })
            }
          >
            {Object.keys(CHANNEL_CONFIG_LABELS).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_CONFIG_LABELS[c as Channel]}
              </option>
            ))}
          </select>
        </div>
        <div className="f-group">
          <label className="f-label">Timing</label>
          <select className="f-input" value={p.timing} onChange={(e) => onChange({ timing: e.target.value })}>
            <option>Absolute</option>
            <option>Relative</option>
          </select>
        </div>
      </div>
      {p.timing === 'Absolute' ? (
        <div className="f-group">
          <label className="f-label">Send time</label>
          <input className="f-input" type="time" value={p.absTime} onChange={(e) => onChange({ absTime: e.target.value })} />
        </div>
      ) : (
        <div className="f-group">
          <label className="f-label">Delay after previous step</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="f-input" type="number" min={0} value={p.relativeDuration} onChange={(e) => onChange({ relativeDuration: e.target.value })} />
            <select className="f-input" value={p.relativeUnit} onChange={(e) => onChange({ relativeUnit: e.target.value })}>
              <option>hours</option>
              <option>days</option>
            </select>
          </div>
        </div>
      )}
      <AccountTemplateFields channel={p.channel} p={p} onChange={onChange} />
      <div className="f-group">
        <label className="f-label">Fallback Channel</label>
        <select
          className="f-input"
          value={p.fallbackChannel}
          onChange={(e) => onChange({ fallbackChannel: e.target.value, fallbackAccount: '', fallbackTemplateId: '' })}
        >
          <option value="">No fallback</option>
          {Object.keys(CHANNEL_CONFIG_LABELS)
            .filter((c) => c !== p.channel)
            .map((c) => (
              <option key={c} value={c}>
                {CHANNEL_CONFIG_LABELS[c as Channel]}
              </option>
            ))}
        </select>
      </div>
      {p.fallbackChannel && (
        <>
          <AccountTemplateFields
            channel={p.fallbackChannel}
            p={p}
            onChange={onChange}
            accountKey="fallbackAccount"
            templateKey="fallbackTemplateId"
            accountLabel="Fallback Account"
            templateLabel="Fallback Template"
          />
          <p className="f-hint">
            If delivery fails on {CHANNEL_CONFIG_LABELS[p.channel as Channel]}, this sends once via {CHANNEL_CONFIG_LABELS[p.fallbackChannel as Channel]}. Then it continues the sequence.
          </p>
        </>
      )}
      <AgentMessagingPanel messaging={p.agentMessaging} />
    </>
  );
}

/**
 * The agent's suggested message, shown read-only.
 *
 * Read-only on purpose. This is a draft the campaign manager copies into the
 * bank's own template tooling. It is not a registered template and nothing
 * here is sent, so making it editable would imply it feeds a real send.
 * Renders nothing for a Send that no agent proposed.
 */
export function AgentMessagingPanel({ messaging }: { messaging?: DripAgentMessaging | null }) {
  if (!messaging) return null;
  const tokens = messaging.personalisationTokens ?? [];
  return (
    <div className="f-group agent-msg">
      <label className="f-label">Suggested message — draft</label>
      <p className="f-hint">
        Written by the agent. It has not been reviewed or approved by the bank and it is not a registered template. Use
        it as a starting point when you prepare the real message.
      </p>
      <dl className="agent-msg-dl">
        <dt>Purpose</dt>
        <dd>{messaging.objective}</dd>
        {messaging.suggestedCopy && (
          <>
            <dt>{messaging.copySource === 'generated-placeholder' ? 'Placeholder' : 'Draft copy'}</dt>
            <dd>
              {messaging.suggestedCopy}
              {messaging.copySource === 'generated-placeholder' && (
                <span className="f-hint" style={{ display: 'block', marginTop: 4 }}>
                  The agent did not supply copy for this step, so this is a placeholder built from the purpose above.
                  Write the real message yourself.
                </span>
              )}
            </dd>
          </>
        )}
        {messaging.cta && (
          <>
            <dt>Call to action</dt>
            <dd>{messaging.cta}</dd>
          </>
        )}
        {tokens.length > 0 && (
          <>
            <dt>Personalisation</dt>
            <dd>{tokens.map((t) => `\${${t}}`).join(', ')}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function PauseForm({ p, onChange }: FormProps) {
  return (
    <>
      <div className="f-row2">
        <div className="f-group">
          <label className="f-label">Duration</label>
          <input className="f-input" type="number" min={1} value={p.duration} onChange={(e) => onChange({ duration: e.target.value })} />
        </div>
        <div className="f-group">
          <label className="f-label">Unit</label>
          <select className="f-input" value={p.unit} onChange={(e) => onChange({ unit: e.target.value })}>
            <option>days</option>
            <option>hours</option>
          </select>
        </div>
      </div>
    </>
  );
}

export function WaitUntilForm({ p, onChange }: FormProps) {
  return (
    <>
      <div className="f-group">
        <label className="f-label">Event Category</label>
        <select className="f-input" value={p.eventCategory} onChange={(e) => onChange({ eventCategory: e.target.value, eventType: '' })}>
          {Object.keys(EVENT_CATEGORIES).map((k) => (
            <option key={k} value={k}>
              {k}
              {EVENT_CATEGORIES[k].isNew ? ' (New)' : ''}
            </option>
          ))}
        </select>
      </div>
      <EventScopingFields eventCategory={p.eventCategory} value={p} onChange={onChange} />
      <div className="f-group">
        <label className="f-label">Event Type</label>
        <select className="f-input" value={p.eventType} onChange={(e) => onChange({ eventType: e.target.value })}>
          <option value="">Select event</option>
          {(EVENT_CATEGORIES[p.eventCategory]?.events || []).map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>
      <div className="f-row2">
        <div className="f-group">
          <label className="f-label">Timeout after</label>
          <input className="f-input" type="number" min={1} value={p.duration} onChange={(e) => onChange({ duration: e.target.value })} />
        </div>
        <div className="f-group">
          <label className="f-label">Unit</label>
          <select className="f-input" value={p.unit} onChange={(e) => onChange({ unit: e.target.value })}>
            <option>days</option>
            <option>hours</option>
          </select>
        </div>
      </div>
      {(() => {
        const { entity, lockedAttr } = resolveEntryEventAttrSource(p.eventCategory, p.eventType);
        return <ConditionsSection conditions={p.conditions} entity={entity} lockedAttribute={lockedAttr} onChange={(conditions) => onChange({ conditions })} />;
      })()}
    </>
  );
}

export function SplitForm({
  p,
  onChange,
  entryEventCategory,
  entryEventType,
  previousStepChannel,
}: FormProps & { entryEventCategory: string | null; entryEventType: string | null; previousStepChannel: PrevStepSend | null }) {
  const { entity: sourceEntity, lockedAttr } = resolveEntryEventAttrSource(entryEventCategory, entryEventType);

  let sourceBody: React.ReactNode;
  if (p.customSource === 'Previous step outcome') {
    const outcomeOptions = previousStepChannel ? deliveryStatusOptionsForSend(previousStepChannel) : deliveryStatusOptionsAll();
    const channelLabel = previousStepChannel
      ? CHANNEL_CONFIG_LABELS[previousStepChannel.channel] + (previousStepChannel.fallbackChannel ? ` + ${CHANNEL_CONFIG_LABELS[previousStepChannel.fallbackChannel]} fallback` : '')
      : '';
    const selectedOutcomes = dcSelectedMulti(p.outcome, p.outcomes);
    sourceBody = (
      <div className="f-group">
        <label className="f-label">Outcome{channelLabel ? ` (${channelLabel})` : ''} — any match → Yes</label>
        <MultiSelectDropdown
          options={outcomeOptions}
          selected={selectedOutcomes}
          onToggle={(v) => onChange({ outcome: '', outcomes: selectedOutcomes.includes(v) ? selectedOutcomes.filter((x) => x !== v) : [...selectedOutcomes, v] })}
        />
        {!previousStepChannel && (
          <p className="f-hint" style={{ margin: '6px 0 0' }}>There's no earlier Send in this chain. Every channel's statuses are listed — pick the ones this branch is about.</p>
        )}
        <p className="f-hint" style={{ margin: '6px 0 0' }}>Pick every status that should count as a match. Intermediate processing states (e.g. SENT, QUEUED, PENDING) usually aren't final outcomes worth conditioning on.</p>
      </div>
    );
  } else if (p.customSource === 'Account attribute') {
    sourceBody = (
      <div className="f-group">
        <label className="f-label">Conditions — ALL must match → Yes, otherwise → No</label>
        <ConditionRows conditions={p.customConditions} entity="Account" onChange={(customConditions) => onChange({ customConditions })} />
      </div>
    );
  } else if (p.customSource === 'Transaction history') {
    sourceBody = (
      <div className="f-group">
        <TxnHistoryFields value={p.txnHistory ?? dcDefaultTxnHistory()} onChange={(txnHistory) => onChange({ txnHistory })} />
        <p className="f-hint" style={{ margin: '6px 0 0' }}>Checked against the customer's transaction history — not their current attributes. The lookback window is relative to when this node is reached and evaluated.</p>
      </div>
    );
  } else if (p.customSource === 'Milestone') {
    sourceBody = (
      <div className="f-group">
        <MilestoneConditionFields value={p.milestone ?? dcDefaultMilestone()} onChange={(milestone) => onChange({ milestone })} />
        <p className="f-hint" style={{ margin: '6px 0 0' }}>Checks one specific, already-configured milestone benefit's progress at the moment this node is reached — not a general customer or account attribute.</p>
      </div>
    );
  } else if (sourceEntity || lockedAttr) {
    sourceBody = (
      <div className="f-group">
        <ConditionsSection
          conditions={p.customConditions}
          entity={sourceEntity}
          lockedAttribute={lockedAttr}
          onChange={(customConditions) => onChange({ customConditions })}
          label="Conditions — ALL must match → Yes, otherwise → No"
        />
      </div>
    );
  } else {
    sourceBody = (
      <p className="f-hint" style={{ margin: 0 }}>
        {entryEventCategory ? `There are no attributes for ${entryEventCategory} yet. Try "Account attribute" instead, or pick an entry category that has one.` : "Entry isn't an Event Trigger. There's no entry-event attribute to filter on."}
      </p>
    );
  }

  return (
    <>
      <div className="f-group">
        <label className="f-label">Source</label>
        <select className="f-input" value={p.customSource} onChange={(e) => onChange({ customSource: e.target.value, outcome: '', customConditions: [], milestone: dcDefaultMilestone() })}>
          <option>Previous step outcome</option>
          <option>Account attribute</option>
          <option>Entry event attribute</option>
          <option>Transaction history</option>
          <option>Milestone</option>
        </select>
      </div>
      {sourceBody}
    </>
  );
}

function BranchInsertRow({ onInsert }: { onInsert: () => void }) {
  return (
    <div className="dcb-insert-row" onClick={onInsert} title="Insert a branch here">
      <span className="dcb-insert-plus">+</span>
    </div>
  );
}

export function DecisionSplitForm({
  p,
  onChange,
  entryEventCategory,
  entryEventType,
  previousStepChannel,
}: FormProps & { entryEventCategory: string | null; entryEventType: string | null; previousStepChannel: PrevStepSend | null }) {
  const { entity: entryEntity, lockedAttr } = resolveEntryEventAttrSource(entryEventCategory, entryEventType);
  const sourceEntity = p.source === 'Account attribute' ? 'Account' : p.source === 'Entry event attribute' ? entryEntity : null;
  // Journey/Offer Events have no typed entity — Branch gets the same
  // single locked attribute Condition does (see EVENT_ATTR_BY_TYPE),
  // never a Branch-specific scoping UI of its own. `p.attribute` is
  // force-set to this value the moment Source is switched to "Entry
  // event attribute" (below), so it's always populated in this mode —
  // no separate "Select attribute" step, since there's only ever one.
  const isLockedAttrMode = p.source === 'Entry event attribute' && !sourceEntity && !!lockedAttr;
  const attrMeta = sourceEntity && p.attribute ? ELIGIBILITY_META[sourceEntity]?.[p.attribute] : null;

  const setBranch = (i: number, patch: any) => {
    const branches = p.branches.map((b: any, idx: number) => (idx === i ? { ...b, ...patch } : b));
    onChange({ branches });
  };
  const removeBranch = (i: number) => onChange({ branches: p.branches.filter((_: any, idx: number) => idx !== i) });
  const addBranch = () => onChange({ branches: [...p.branches, { id: dcNewBranchId(), label: 'Branch ' + (p.branches.length + 1), operator: 'Equals', value: '', value2: '' }] });
  const insertBranch = (i: number) => {
    const branches = [...p.branches];
    branches.splice(i + 1, 0, { id: dcNewBranchId(), label: 'Branch ' + (branches.length + 1), operator: 'Equals', value: '', value2: '' });
    onChange({ branches });
  };

  let sourceBody: React.ReactNode;
  if (p.source === 'Previous step outcome') {
    const outcomeOptions = previousStepChannel ? deliveryStatusOptionsForSend(previousStepChannel) : deliveryStatusOptionsAll();
    const channelLabel = previousStepChannel
      ? CHANNEL_CONFIG_LABELS[previousStepChannel.channel] + (previousStepChannel.fallbackChannel ? ` + ${CHANNEL_CONFIG_LABELS[previousStepChannel.fallbackChannel]} fallback` : '')
      : '';
    sourceBody = (
      <div className="f-group">
        <label className="f-label">Branches{channelLabel ? ` (${channelLabel})` : ''} — any match routes to that branch</label>
        {!previousStepChannel && (
          <p className="f-hint" style={{ margin: '0 0 8px' }}>There's no earlier Send in this chain. Every channel's statuses are listed — pick the ones this split is about.</p>
        )}
        {p.branches.map((b: any, i: number) => {
          const selectedOutcomes = dcSelectedMulti(b.value, b.values);
          return (
            <div key={b.id || i}>
              <BranchInsertRow onInsert={() => insertBranch(i - 1)} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <input className="f-input" type="text" style={{ flex: 1 }} placeholder="Label" value={b.label} onChange={(e) => setBranch(i, { label: e.target.value })} />
                <div style={{ flex: 2 }}>
                  <MultiSelectDropdown
                    options={outcomeOptions}
                    selected={selectedOutcomes}
                    onToggle={(v) => setBranch(i, { value: '', values: selectedOutcomes.includes(v) ? selectedOutcomes.filter((x) => x !== v) : [...selectedOutcomes, v] })}
                  />
                </div>
                {p.branches.length > 1 && (
                  <div className="cond-remove" onClick={() => removeBranch(i)}>
                    ✕
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div className="add-link" onClick={addBranch}>
          + Add branch
        </div>
        <CatchAllRow />
        <p className="f-hint" style={{ margin: '8px 0 0' }}>Pick every status that should count toward a branch. Intermediate processing states (e.g. SENT, QUEUED, PENDING) usually aren't final outcomes worth conditioning on.</p>
      </div>
    );
  } else if (isLockedAttrMode) {
    // Same shape as the entity-based branches below (label + operator +
    // value per branch, "+ Add branch", catch-all), minus the Attribute
    // picker — there's only one real attribute for this event type, so
    // it's shown fixed rather than offered as a dead 1-option dropdown.
    const toggleBranchMulti = (i: number, val: string) => {
      const b = p.branches[i];
      const values = b.values ? [...b.values] : [];
      const idx = values.indexOf(val);
      if (idx > -1) values.splice(idx, 1);
      else values.push(val);
      setBranch(i, { values, operator: 'Any of' });
    };
    sourceBody = (
      <div className="f-group">
        <label className="f-label">Attribute</label>
        <input className="f-input" type="text" value={lockedAttr || ''} disabled />
        <label className="f-label" style={{ marginTop: 10 }}>
          Branches
        </label>
        {p.branches.map((b: any, i: number) => (
          <div key={b.id || i}>
            <BranchInsertRow onInsert={() => insertBranch(i - 1)} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input className="f-input" type="text" style={{ width: 110, flexShrink: 0 }} placeholder="Label" value={b.label} onChange={(e) => setBranch(i, { label: e.target.value })} />
              <select className="f-input" style={{ width: 110, flexShrink: 0 }} value={b.operator} onChange={(e) => setBranch(i, { operator: e.target.value })}>
                {LOCKED_ATTR_OPERATORS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
              <div style={{ flex: 1 }}>
                <ValueField cond={b} attrMeta={null} onPatch={(patch) => setBranch(i, patch)} onToggleMulti={(v) => toggleBranchMulti(i, v)} />
              </div>
              {p.branches.length > 1 && (
                <div className="cond-remove" onClick={() => removeBranch(i)}>
                  ✕
                </div>
              )}
            </div>
          </div>
        ))}
        <div className="add-link" onClick={addBranch}>
          + Add branch
        </div>
        <CatchAllRow />
      </div>
    );
  } else if (p.source === 'Milestone') {
    sourceBody = (
      <>
        <div className="f-group">
          <label className="f-label">Milestone benefit</label>
          <select
            className="f-input"
            value={p.milestoneBenefitId || ''}
            onChange={(e) => onChange({ milestoneBenefitId: e.target.value })}
          >
            <option value="">Select benefit</option>
            {MILESTONE_BENEFITS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        {p.milestoneBenefitId && (
          <div className="f-group">
            <label className="f-label">Branches</label>
            {p.branches.map((b: any, i: number) => (
              <div key={b.id || i}>
                <BranchInsertRow onInsert={() => insertBranch(i - 1)} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <input className="f-input" type="text" style={{ width: 110, flexShrink: 0 }} placeholder="Label" value={b.label} onChange={(e) => setBranch(i, { label: e.target.value })} />
                  <select
                    className="f-input"
                    style={{ width: 150, flexShrink: 0 }}
                    value={b.operator}
                    onChange={(e) => setBranch(i, { operator: e.target.value, value: '', value2: '', statusChoice: undefined })}
                  >
                    {MILESTONE_OPERATORS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <div style={{ flex: 1 }}>
                    <MilestoneValueField operator={b.operator} value={b.value} value2={b.value2} statusChoice={b.statusChoice} onPatch={(patch) => setBranch(i, patch)} />
                  </div>
                  {p.branches.length > 1 && (
                    <div className="cond-remove" onClick={() => removeBranch(i)}>
                      ✕
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div className="add-link" onClick={addBranch}>
              + Add branch
            </div>
            <CatchAllRow />
          </div>
        )}
      </>
    );
  } else if (!sourceEntity) {
    sourceBody = (
      <p className="f-hint" style={{ margin: 0 }}>
        {entryEventCategory
          ? `There are no attributes for ${entryEventCategory} yet. Try "Account attribute" instead, or pick an entry category that has one.`
          : "Entry isn't an Event Trigger. There's no entry-event attribute to branch on."}
      </p>
    );
  } else {
    const attrOptions = Object.keys(ELIGIBILITY_META[sourceEntity]);
    // multiSelect only has one real operator — same precedent as
    // ConditionRows: shown as already selected, auto-backfilled onto the
    // branch once a value is toggled, rather than a 1-option dropdown.
    const opOptions = attrMeta?.type === 'multiSelect' ? ['Any of'] : attrMeta?.type === 'number' || attrMeta?.type === 'date' ? ['Equals', 'Greater than', 'Less than', 'Between'] : ['Equals', 'Not Equals'];
    const toggleBranchMulti = (i: number, val: string) => {
      const b = p.branches[i];
      const values = b.values ? [...b.values] : [];
      const idx = values.indexOf(val);
      if (idx > -1) values.splice(idx, 1);
      else values.push(val);
      setBranch(i, { values, operator: 'Any of' });
    };
    sourceBody = (
      <>
        <div className="f-group">
          <label className="f-label">Attribute</label>
          <select
            className="f-input"
            value={p.attribute}
            onChange={(e) =>
              // A new attribute can be a completely different value type
              // (e.g. switching from a select to a multiSelect) — every
              // branch's old value/values/value2 is stale the moment the
              // attribute changes, not just hidden.
              onChange({
                attribute: e.target.value,
                branches: p.branches.map((b: any) => ({ ...b, operator: 'Equals', value: '', value2: '', values: [] })),
              })
            }
          >
            <option value="">Select attribute</option>
            {attrOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {p.attribute && (
          <div className="f-group">
            <label className="f-label">Branches</label>
            {p.branches.map((b: any, i: number) => {
              const effectiveOperator = attrMeta?.type === 'multiSelect' ? 'Any of' : b.operator;
              return (
                <div key={b.id || i}>
                  <BranchInsertRow onInsert={() => insertBranch(i - 1)} />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <input className="f-input" type="text" style={{ width: 110, flexShrink: 0 }} placeholder="Label" value={b.label} onChange={(e) => setBranch(i, { label: e.target.value })} />
                    <select className="f-input" style={{ width: 110, flexShrink: 0 }} value={effectiveOperator} onChange={(e) => setBranch(i, { operator: e.target.value })}>
                      {opOptions.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                    <div style={{ flex: 1 }}>
                      <ValueField cond={b} attrMeta={attrMeta} onPatch={(patch) => setBranch(i, patch)} onToggleMulti={(v) => toggleBranchMulti(i, v)} />
                    </div>
                    {p.branches.length > 1 && (
                      <div className="cond-remove" onClick={() => removeBranch(i)}>
                        ✕
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="add-link" onClick={addBranch}>
              + Add branch
            </div>
            <CatchAllRow />
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="f-group">
        <label className="f-label">Step name</label>
        <input className="f-input" type="text" value={p.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div className="f-group">
        <label className="f-label">Source</label>
        <select
          className="f-input"
          value={p.source}
          onChange={(e) => {
            const nextSource = e.target.value;
            // Picking "Entry event attribute" on a Journey/Offer Events
            // entry locks the attribute immediately — there's only one,
            // so there's no separate pick step the way Account attribute
            // has. Any other source (or an entity-based entry) clears it,
            // same as before.
            const nextAttribute = nextSource === 'Entry event attribute' && !entryEntity && lockedAttr ? lockedAttr : '';
            const patch: any = { source: nextSource, attribute: nextAttribute, milestoneBenefitId: '' };
            // Milestone's operator vocabulary (IS/GT/GTE_PCT/etc.) is
            // disjoint from every other source's (Equals/Not Equals/Any
            // of) — stale branches from a previous source would show an
            // operator select with no matching option, so they're reset
            // to a valid Milestone starting point the moment this source
            // is picked, same as the attribute-select's own reset below
            // does when a new attribute is chosen.
            if (nextSource === 'Milestone') {
              patch.branches = p.branches.map((b: any) => ({ ...b, operator: 'IS', value: '', value2: '', values: [], statusChoice: undefined }));
            }
            onChange(patch);
          }}
        >
          <option>Previous step outcome</option>
          <option>Account attribute</option>
          <option>Entry event attribute</option>
          <option>Milestone</option>
        </select>
      </div>
      {sourceBody}
      <p className="f-hint">Branches are checked top to bottom. The customer follows the first match. Anything else falls into the catch-all.</p>
    </>
  );
}

function CatchAllRow() {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, padding: '9px 12px', background: 'var(--gray-50)', borderRadius: 8, color: 'var(--gray-500)', fontSize: 12.5 }}>
      Anything else <span style={{ marginLeft: 'auto' }}>Catch-all</span>
    </div>
  );
}

export function RandomSplitForm({ p, onChange }: FormProps) {
  const total = p.branches.reduce((s: number, b: any) => s + Number(b.pct || 0), 0);
  const setBranch = (i: number, patch: any) => onChange({ branches: p.branches.map((b: any, idx: number) => (idx === i ? { ...b, ...patch } : b)) });
  const removeBranch = (i: number) => onChange({ branches: p.branches.filter((_: any, idx: number) => idx !== i) });
  const addBranch = () => onChange({ branches: [...p.branches, { id: dcNewBranchId(), label: String.fromCharCode(65 + p.branches.length), pct: 0 }] });
  const insertBranch = (i: number) => {
    const branches = [...p.branches];
    branches.splice(i + 1, 0, { id: dcNewBranchId(), label: String.fromCharCode(65 + branches.length), pct: 0 });
    onChange({ branches });
  };
  return (
    <>
      <div className="f-group">
        <label className="f-label">Step name</label>
        <input className="f-input" type="text" value={p.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div className="f-group">
        <label className="f-label">Branches</label>
        {p.branches.map((b: any, i: number) => (
          <div key={b.id || i}>
            <BranchInsertRow onInsert={() => insertBranch(i - 1)} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input className="f-input" type="text" style={{ flex: 2 }} placeholder="Label" value={b.label} onChange={(e) => setBranch(i, { label: e.target.value })} />
              <input className="f-input" type="number" min={1} max={99} style={{ flex: 1 }} value={b.pct} onChange={(e) => setBranch(i, { pct: e.target.value })} />
              <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>%</span>
              {p.branches.length > 2 && (
                <div className="cond-remove" onClick={() => removeBranch(i)}>
                  ✕
                </div>
              )}
            </div>
          </div>
        ))}
        <div className="add-link" onClick={addBranch}>
          + Add branch
        </div>
        <p className="f-hint" style={{ color: total === 100 ? 'var(--gray-500)' : 'var(--warning-text)', fontWeight: total === 100 ? 400 : 600 }}>
          Total: {total}%{total !== 100 ? ' — must add up to 100%' : ''}
        </p>
      </div>
    </>
  );
}

// Goal Check's "edit" view — read-only by design (Phase 1 §5/§12): it
// carries no configuration of its own, so there's nothing a form could
// let someone change. Selecting it shows what it actually does and links
// back to the one place the goal itself IS editable.
export function GoalCheckInfo({ goal, onGoToGoal }: { goal: DripGoal | null; onGoToGoal?: () => void }) {
  const goalLabel = dcGoalLabel(goal);
  return (
    <>
      <div className="f-group">
        <label className="f-label">Goal Check</label>
        <p className="f-hint" style={{ margin: 0 }}>
          Asks exactly one question, automatically, every time: has the campaign goal been achieved?
        </p>
      </div>
      <div className="f-group">
        <label className="f-label">Campaign goal</label>
        <input className="f-input" type="text" value={goalLabel || 'No goal set'} disabled style={{ background: 'var(--gray-100)', color: 'var(--gray-500)' }} />
      </div>
      {onGoToGoal && (
        <div className="add-link" onClick={onGoToGoal}>
          → Edit the campaign goal
        </div>
      )}
    </>
  );
}

export function ReasonForm({ p, onChange }: FormProps) {
  return (
    <div className="f-group">
      <label className="f-label">Reason</label>
      <input className="f-input" type="text" value={p.reason} onChange={(e) => onChange({ reason: e.target.value })} />
    </div>
  );
}
