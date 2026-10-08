// Ported from journeysnudgesemi/emi-conversions-prototype.html's
// dcDrawerFormFor — one component per node type's config form, same
// fields/cascades as the original (Account/Template cascade, Previous-
// step-outcome channel-aware status list, Random/Decision Split dynamic
// branch lists with mid-list insert, etc).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { CHANNEL_CONFIG_LABELS, COMMS_TEMPLATES, EVENT_CATEGORIES, ELIGIBILITY_META, DC_EVENT_ENTITY, deliveryStatusOptionsFor, deliveryStatusOptionsAll, type Channel } from '../data/sharedConstants';
import type { DripGoal } from '../data/graphTypes';
import { dcOrdinal, dcRecurrenceLabel, dcGoalLabel } from '../reducer/labelMeta';
import { dcNewBranchId } from '../reducer/idGen';
import { ConditionsSection, ConditionRows } from './ConditionRows';

interface FormProps {
  p: any;
  onChange: (patch: any) => void;
}

const ENTITY_OPTIONS = ['Customer', 'Account', 'Card'];

export function EntrySegmentForm({ p, onChange }: FormProps) {
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
          <div className="f-group">
            <label className="f-label">Entity</label>
            <select className="f-input" value={p.entity} onChange={(e) => onChange({ entity: e.target.value, conditions: [{ attribute: '', operator: '', value: '' }] })}>
              {ENTITY_OPTIONS.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </div>
          <div className="f-group">
            <label className="f-label">Conditions</label>
            <ConditionRows conditions={p.conditions} entity={p.entity} onChange={(conditions) => onChange({ conditions })} />
          </div>
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
      <ConditionsSection conditions={p.conditions} entity={DC_EVENT_ENTITY[p.eventCategory] || null} onChange={(conditions) => onChange({ conditions })} />
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
        <div className="f-row2">
          <div className="f-group">
            <label className="f-label">After</label>
            <select className="f-input" value={p.relativeAnchor} onChange={(e) => onChange({ relativeAnchor: e.target.value })}>
              <option>Entry</option>
              <option>Previous Step</option>
            </select>
          </div>
          <div className="f-group">
            <label className="f-label">Delay</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="f-input" type="number" min={0} value={p.relativeDuration} onChange={(e) => onChange({ relativeDuration: e.target.value })} />
              <select className="f-input" value={p.relativeUnit} onChange={(e) => onChange({ relativeUnit: e.target.value })}>
                <option>hours</option>
                <option>days</option>
              </select>
            </div>
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
    </>
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
      <ConditionsSection conditions={p.conditions} entity={DC_EVENT_ENTITY[p.eventCategory] || null} onChange={(conditions) => onChange({ conditions })} />
    </>
  );
}

export function SplitForm({ p, onChange, entryEventCategory, previousStepChannel }: FormProps & { goal: DripGoal | null; entryEventCategory: string | null; previousStepChannel: Channel | null }) {
  const sourceEntity = entryEventCategory ? DC_EVENT_ENTITY[entryEventCategory] || null : null;

  let sourceBody: React.ReactNode;
  if (p.customSource === 'Previous step outcome') {
    const outcomeOptions = previousStepChannel ? deliveryStatusOptionsFor(previousStepChannel) : deliveryStatusOptionsAll();
    sourceBody = (
      <div className="f-group">
        <label className="f-label">Outcome{previousStepChannel ? ` (${CHANNEL_CONFIG_LABELS[previousStepChannel]})` : ''} — matches → Yes</label>
        <select className="f-input" value={p.outcome} onChange={(e) => onChange({ outcome: e.target.value })}>
          <option value="">Select outcome</option>
          {outcomeOptions.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        {!previousStepChannel && (
          <p className="f-hint" style={{ margin: '6px 0 0' }}>There's no earlier Send in this chain. Every channel's statuses are listed — pick the one this branch is about.</p>
        )}
      </div>
    );
  } else if (p.customSource === 'Account attribute') {
    sourceBody = (
      <div className="f-group">
        <label className="f-label">Conditions — ALL must match → Yes, otherwise → No</label>
        <ConditionRows conditions={p.customConditions} entity="Account" onChange={(customConditions) => onChange({ customConditions })} />
      </div>
    );
  } else if (sourceEntity) {
    sourceBody = (
      <div className="f-group">
        <ConditionsSection
          conditions={p.customConditions}
          entity={sourceEntity}
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
        <select className="f-input" value={p.customSource} onChange={(e) => onChange({ customSource: e.target.value, outcome: '', customConditions: [] })}>
          <option>Previous step outcome</option>
          <option>Account attribute</option>
          <option>Entry event attribute</option>
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

export function DecisionSplitForm({ p, onChange, entryEventCategory, previousStepChannel }: FormProps & { entryEventCategory: string | null; previousStepChannel: Channel | null }) {
  const sourceEntity = p.source === 'Account attribute' ? 'Account' : p.source === 'Entry event attribute' ? (entryEventCategory ? DC_EVENT_ENTITY[entryEventCategory] : null) : null;
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
    const outcomeOptions = previousStepChannel ? deliveryStatusOptionsFor(previousStepChannel) : deliveryStatusOptionsAll();
    sourceBody = (
      <div className="f-group">
        <label className="f-label">Branches{previousStepChannel ? ` (${CHANNEL_CONFIG_LABELS[previousStepChannel]})` : ''}</label>
        {!previousStepChannel && (
          <p className="f-hint" style={{ margin: '0 0 8px' }}>There's no earlier Send in this chain. Every channel's statuses are listed — pick the one this split is about.</p>
        )}
        {p.branches.map((b: any, i: number) => (
          <div key={b.id || i}>
            <BranchInsertRow onInsert={() => insertBranch(i - 1)} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input className="f-input" type="text" style={{ flex: 1 }} placeholder="Label" value={b.label} onChange={(e) => setBranch(i, { label: e.target.value })} />
              <select className="f-input" style={{ flex: 2 }} value={b.value} onChange={(e) => setBranch(i, { value: e.target.value })}>
                <option value="">Select outcome</option>
                {outcomeOptions.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
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
    const opOptions = attrMeta?.type === 'number' || attrMeta?.type === 'date' ? ['Equals', 'Greater than', 'Less than', 'Between'] : ['Equals', 'Not Equals'];
    const valueField = (b: any, i: number) => {
      if (!attrMeta) return <input className="f-input" type="text" style={{ flex: 1 }} placeholder="Attribute" disabled />;
      if (attrMeta.type === 'select')
        return (
          <select className="f-input" style={{ flex: 1 }} value={b.value} onChange={(e) => setBranch(i, { value: e.target.value })}>
            <option value="">Value</option>
            {(attrMeta.options || []).map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        );
      if (attrMeta.type === 'bool')
        return (
          <select className="f-input" style={{ flex: 1 }} value={b.value} onChange={(e) => setBranch(i, { value: e.target.value })}>
            <option value="">Value</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        );
      if (attrMeta.type === 'number' && b.operator === 'Between')
        return (
          <div style={{ display: 'flex', gap: 6, flex: 1 }}>
            <input className="f-input" type="number" placeholder="From" value={b.value || ''} onChange={(e) => setBranch(i, { value: e.target.value })} />
            <input className="f-input" type="number" placeholder="To" value={b.value2 || ''} onChange={(e) => setBranch(i, { value2: e.target.value })} />
          </div>
        );
      if (attrMeta.type === 'number') return <input className="f-input" type="number" style={{ flex: 1 }} placeholder="Value" value={b.value || ''} onChange={(e) => setBranch(i, { value: e.target.value })} />;
      if (attrMeta.type === 'date') return <input className="f-input" type="date" style={{ flex: 1 }} value={b.value || ''} onChange={(e) => setBranch(i, { value: e.target.value })} />;
      return <input className="f-input" type="text" style={{ flex: 1 }} placeholder="Value" value={b.value || ''} onChange={(e) => setBranch(i, { value: e.target.value })} />;
    };
    sourceBody = (
      <>
        <div className="f-group">
          <label className="f-label">Attribute</label>
          <select className="f-input" value={p.attribute} onChange={(e) => onChange({ attribute: e.target.value })}>
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
            {p.branches.map((b: any, i: number) => (
              <div key={b.id || i}>
                <BranchInsertRow onInsert={() => insertBranch(i - 1)} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <input className="f-input" type="text" style={{ width: 110, flexShrink: 0 }} placeholder="Label" value={b.label} onChange={(e) => setBranch(i, { label: e.target.value })} />
                  <select className="f-input" style={{ width: 110, flexShrink: 0 }} value={b.operator} onChange={(e) => setBranch(i, { operator: e.target.value })}>
                    {opOptions.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                  {valueField(b, i)}
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
  }

  return (
    <>
      <div className="f-group">
        <label className="f-label">Step name</label>
        <input className="f-input" type="text" value={p.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div className="f-group">
        <label className="f-label">Source</label>
        <select className="f-input" value={p.source} onChange={(e) => onChange({ source: e.target.value, attribute: '' })}>
          <option>Previous step outcome</option>
          <option>Account attribute</option>
          <option>Entry event attribute</option>
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
