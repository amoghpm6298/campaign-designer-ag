// Journey/Offer Events' own scoping fields — shared by Goal Definition,
// Entry · Event, and Wait for Event (the three places an Event Category
// is picked), so the two categories' scoping can't drift between call
// sites. Ported from journeysnudgesemi/emi-conversions-prototype.html's
// separate "event-based nudges" EVENT_TRIGGER step, which shows these
// directly above its own Event Conditions block for exactly these two
// categories and nothing else.
//
// Offer Name is a free-text field, not a select — the source's own
// EVENT_TRIGGER step only ever hardcodes one example ('Festive EMI
// Push') for it, with no real catalog anywhere in that file to draw a
// list from (see OFFER_TYPE_OPTIONS's own comment in sharedConstants.ts
// for why `IBL_CAMPAIGNS` doesn't count as one).
import { JOURNEY_OPTIONS, BATCH_OPTIONS, OFFER_TYPE_OPTIONS } from '../data/sharedConstants';

export interface EventScopingValue {
  journey?: string;
  batch?: string;
  offerType?: string;
  offerName?: string;
}

export function EventScopingFields({
  eventCategory,
  value,
  onChange,
}: {
  eventCategory: string;
  value: EventScopingValue;
  onChange: (patch: EventScopingValue) => void;
}) {
  if (eventCategory === 'Journey Events') {
    return (
      <div className="f-row2">
        <div className="f-group">
          <label className="f-label">Journey</label>
          <select className="f-input" value={value.journey || ''} onChange={(e) => onChange({ journey: e.target.value })}>
            <option value="">Select</option>
            {JOURNEY_OPTIONS.map((j) => (
              <option key={j}>{j}</option>
            ))}
          </select>
        </div>
        <div className="f-group">
          <label className="f-label">Batch</label>
          <select className="f-input" value={value.batch || ''} onChange={(e) => onChange({ batch: e.target.value })}>
            <option value="">Select</option>
            {BATCH_OPTIONS.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </div>
      </div>
    );
  }
  if (eventCategory === 'Offer Events') {
    return (
      <div className="f-row2">
        <div className="f-group">
          <label className="f-label">Offer Type</label>
          <select className="f-input" value={value.offerType || ''} onChange={(e) => onChange({ offerType: e.target.value })}>
            <option value="">Select</option>
            {OFFER_TYPE_OPTIONS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
        <div className="f-group">
          <label className="f-label">Offer Name</label>
          <input className="f-input" type="text" placeholder="e.g. Festive EMI Push" value={value.offerName || ''} onChange={(e) => onChange({ offerName: e.target.value })} />
        </div>
      </div>
    );
  }
  return null;
}
