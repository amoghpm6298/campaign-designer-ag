import { render } from './architectureTable';
console.log(render('Expiring cards + active transactors', [
  { need: 'Card is about to expire',          attribute: 'Card Expiry' },
  { need: 'Customer transacts actively',      attribute: 'Transaction Status' },
  { need: 'Reach them the week before expiry', attribute: 'Card Expiry' },
], 'Card'));
