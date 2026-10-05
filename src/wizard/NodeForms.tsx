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
        <label className="f-label">Entity</label>
        <select className="f-input" value={p.entity} onChange={(e) => onChange({ entity: e.target.value, conditions: [] })}>
          {ENTITY_OPTIONS.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
      </div>
      <div className="f-group">
        <label className="f-label">
          Conditions <span style={{ fontWeight: 400, color: 'var(--gray-500)' }}>(optional — a static snapshot if none set)</span>
        </label>
        <ConditionRows conditions={p.conditions} entity={p.entity} onChange={(conditions) => onChange({ conditions })} />
      </div>
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

export function EntryScheduledForm({ p, onChange }: FormProps) {
  return (
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
      <div className="f-group">
        <label className="f-label">Entity</label>
        <select className="f-input" value={p.entity} onChange={(e) => onChange({ entity: e.target.value, conditions: [] })}>
          {ENTITY_OPTIONS.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
      </div>
      <div className="f-group">
        <label className="f-label">
          Conditions <span style={{ fontWeight: 400, color: 'var(--gray-500)' }}>(optional — everyone matching the entity if none set)</span>
        </label>
        <ConditionRows conditions={p.conditions} entity={p.entity} onChange={(conditions) => onChange({ conditions })} />
      </div>
      <p className="f-hint">Who this pulls in each time the schedule fires — re-evaluated fresh every run, not a one-time snapshot like Entry · Segment.</p>
    </>
  );
}

function AccountTemplateFields({ channel, p, onChange }: { channel: Channel; p: any; onChange: (patch: any) => void }) {
  const accounts = [...new Set(COMMS_TEMPLATES.filter((x) => x.channelType === channel).map((x) => x.accountName))];
  const templates = COMMS_TEMPLATES.filter((x) => x.channelType === channel && (!p.account || x.accountName === p.account));
  return (
    <>
      <div className="f-group">
        <label className="f-label">Account</label>
        <select className="f-input" value={p.account} onChange={(e) => onChange({ account: e.target.value, templateId: '' })}>
          <option value="">Select account</option>
          {accounts.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </div>
      <div className="f-group">
        <label className="f-label">Template</label>
        <select className="f-input" value={p.templateId} onChange={(e) => onChange({ templateId: e.target.value })}>
          <option value="">Select template</option>
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        {!templates.length && (
          <div className="f-hint">
            No {CHANNEL_CONFIG_LABELS[channel]} templates exist yet{p.account ? ' for this account' : ''}.
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
          <select className="f-input" value={p.channel} onChange={(e) => onChange({ channel: e.target.value, account: '', templateId: '' })}>
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
      <p className="f-hint">A goal-check step is auto-inserted right after this Send — same "define once, check everywhere" pattern used across this campaign.</p>
    </>
  );
}

export function ChannelFailoverForm({ p, onChange }: FormProps) {
  return (
    <>
      <div className="f-row2">
        <div className="f-group">
          <label className="f-label">Primary Channel</label>
          <select
            className="f-input"
            value={p.primaryChannel}
            onChange={(e) => onChange({ primaryChannel: e.target.value, ...(p.fallbackChannel === e.target.value ? { fallbackChannel: '' } : {}) })}
          >
            {Object.keys(CHANNEL_CONFIG_LABELS).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_CONFIG_LABELS[c as Channel]}
              </option>
            ))}
          </select>
        </div>
        <div className="f-group">
          <label className="f-label">Fallback Channel</label>
          <select className="f-input" value={p.fallbackChannel} onChange={(e) => onChange({ fallbackChannel: e.target.value, account: '', templateId: '' })}>
            {Object.keys(CHANNEL_CONFIG_LABELS)
              .filter((c) => c !== p.primaryChannel)
              .map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_CONFIG_LABELS[c as Channel]}
                </option>
              ))}
          </select>
        </div>
      </div>
      <AccountTemplateFields channel={p.fallbackChannel} p={p} onChange={onChange} />
      <p className="f-hint">If the primary channel's delivery fails, this sends the above once on the fallback channel before continuing the sequence. A goal-check step is auto-inserted right after, same as after any Send.</p>
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
      <p className="f-hint">A goal-check step is auto-inserted right after the wait ends — if the customer already converted while this was waiting, the campaign catches that before doing anything else.</p>
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

export function SplitForm({ p, onChange, goal, entryEventCategory, previousStepChannel }: FormProps & { goal: DripGoal | null; entryEventCategory: string | null; previousStepChannel: Channel | null }) {
  const goalQ = (dcGoalLabel(goal) || 'Goal') + '?';
  const sourceEntity = entryEventCategory ? DC_EVENT_ENTITY[entryEventCategory] || null : null;

  let sourceBody: React.ReactNode = null;
  if (p.basis === 'Custom condition') {
    if (p.customSource === 'Previous step outcome') {
      const outcomeOptions = previousStepChannel ? deliveryStatusOptionsFor(previousStepChannel) : deliveryStatusOptionsAll();
      sourceBody = (
        <div className="f-group">
          <label className="f-label">Outcome{previousStepChannel ? ` (${CHANNEL_CONFIG_LABELS[previousStepChannel]})` : ''}</label>
          <select className="f-input" value={p.outcome} onChange={(e) => onChange({ outcome: e.target.value })}>
            {outcomeOptions.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
      );
    } else if (p.customSource === 'Account attribute') {
      sourceBody = (
        <div className="f-group">
          <label className="f-label">Condition</label>
          <ConditionRows conditions={p.customConditions} entity="Account" onChange={(customConditions) => onChange({ customConditions })} />
        </div>
      );
    } else if (sourceEntity) {
      sourceBody = (
        <div className="f-group">
          <label className="f-label">Condition</label>
          <ConditionsSection conditions={p.customConditions} entity={sourceEntity} onChange={(customConditions) => onChange({ customConditions })} />
        </div>
      );
    } else {
      sourceBody = (
        <p className="f-hint" style={{ margin: 0 }}>
          {entryEventCategory ? `No typed attributes defined yet for ${entryEventCategory}.` : "Entry isn't an Event Trigger, so there's no entry-event attribute to filter on."}
        </p>
      );
    }
  }

  return (
    <>
      <div className="f-group">
        <label className="f-label">Basis</label>
        <select className="f-input" value={p.basis} onChange={(e) => onChange({ basis: e.target.value })}>
          <option>Goal reached</option>
          <option>Custom condition</option>
        </select>
      </div>
      {p.basis === 'Goal reached' ? (
        <div className="f-group">
          <label className="f-label">Condition</label>
          <input className="f-input" type="text" value={goalQ} disabled style={{ background: 'var(--gray-100)', color: 'var(--gray-500)' }} />
        </div>
      ) : (
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
      )}
      <p className="f-hint">Branches are checked top to bottom — the customer follows the first one that matches. Anything that matches none of them falls into the catch-all at the end.</p>
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
        <label className="f-label">Branches</label>
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
        Entry isn't an Event Trigger, so there's no entry-event attribute to branch on.
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
      <p className="f-hint">Branches are checked top to bottom — the customer follows the first one that matches. Anything that matches none of them falls into the catch-all at the end.</p>
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

export function ReasonForm({ p, onChange }: FormProps) {
  return (
    <div className="f-group">
      <label className="f-label">Reason</label>
      <input className="f-input" type="text" value={p.reason} onChange={(e) => onChange({ reason: e.target.value })} />
    </div>
  );
}
