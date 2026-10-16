// The OS-to-EMI case, factors taken from the recorded arA dimension record.
// The attribute for each is stated here, not inferred — the table checks
// existence and ownership only.
import { render, entryPoints } from './architectureTable';

console.log(`entry points available: ${entryPoints().length}`);

console.log(render('OS-to-EMI', [
  { need: 'Only EMI-eligible purchases',                 attribute: 'EMI Eligible' },
  { need: 'Has not already raised a conversion request', attribute: 'New Status' },
  { need: 'Time it to the statement due date',           attribute: 'Statement Due Date' },
  { need: 'Outstanding balance above Rs 25,000',         noAttribute: 'no running-balance attribute exists on any entity; Transaction Amount is a single transaction, a different measure at a different grain' },
], /* the agent chose a Transaction-event entry */ 'Transaction'));
