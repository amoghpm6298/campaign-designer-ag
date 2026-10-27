// The manager sees the proposed path BEFORE they approve it.
//
// THE DEFECT. `pendingBlueprint` has been on the propose-turn response since
// the confirm gate existed, and was used for exactly one thing: the payload
// sent back when the manager clicked Confirm. Meanwhile the left pane showed
// a grey wireframe captioned "The journey appears here once you approve a
// plan". So the only turn where the manager has a real decision to make —
// approve this, or say what to change — was the turn with the least to look
// at, and the picture arrived after they had already said yes.
//
// WHAT THIS IS NOT. Not `DripCanvas`, which renders a BUILT campaign with
// real nodes, a node drawer and live validation. Mounting that would claim
// the journey exists. `graph` stays null on this turn and the schematic is a
// pure row list with no handlers.
//
// THE RULE THESE TESTS EXIST FOR: every path of every fork is drawn. A
// schematic that renders the treated arm and silently omits the rest path
// tells the manager the campaign reaches everyone when it does not — which
// would make the preview worse than no preview.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { previewFromBlueprint, type PreviewRow } from '../../src/designer/preview';

const designer = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');

const send = (channel: string, describe: string, fallback?: string) => ({
  kind: 'send',
  name: describe,
  objective: ['activate'],
  stage: 'first-touch',
  describe,
  channelPreference: fallback ? [channel, fallback] : [channel],
});

const bp = (steps: unknown[], over: Record<string, unknown> = {}) => ({
  campaignName: 'Activate new cardholders',
  description: 'Fourteen days from issuance.',
  goal: { eventCategory: 'Card Events', eventType: 'CARD_ACTIVATED' },
  entry: { kind: 'audience', entity: 'Card', conditions: [{ attribute: 'PIN Set', operator: 'Equals', value: 'No' }] },
  steps,
  ...over,
});

/** Flattens the nested row tree, for assertions about the whole picture. */
const flatten = (rows: PreviewRow[]): PreviewRow[] =>
  rows.flatMap((r) => (r.kind === 'fork' ? [r, ...r.paths.flatMap((p) => flatten(p.rows))] : [r]));

describe('a linear journey reads top to bottom', () => {
  const p = previewFromBlueprint(
    bp([
      send('WHATSAPP', 'Show them how to set the PIN.'),
      { kind: 'wait', durationHours: 48 },
      send('SMS', 'Remind them it takes two minutes.'),
      { kind: 'exit', reason: 'PIN is set.' },
    ]),
  )!;

  it('names who comes in, in words rather than an entity expression', () => {
    // Attribute labels arrive already human — "PIN Set" comes from the
    // builder's own attribute list — so they are left alone. Only SHOUTED
    // enums get converted, because "Pin set" would be worse than "PIN Set".
    expect(p.entry).toBe('Card: PIN Set equals No');
    expect(p.entry).not.toContain('kind');
  });

  it('leads a send with its channel and what the message is for', () => {
    const first = p.rows[0];
    expect(first.kind).toBe('send');
    expect(first).toMatchObject({ channel: 'WhatsApp', text: 'Show them how to set the PIN.' });
  });

  it('turns an enum into a word', () => {
    // WHATSAPP is not how anyone writes it, and a schematic full of shouted
    // enums reads as a config dump.
    expect(p.rows.filter((r) => r.kind === 'send').map((r) => (r as { channel: string }).channel)).toEqual(['WhatsApp', 'SMS']);
  });

  it('says a wait in days, not in hours', () => {
    expect(p.rows[1]).toEqual({ kind: 'wait', text: 'Wait 2 days' });
  });

  it('keeps an odd duration in hours rather than rounding it away', () => {
    const odd = previewFromBlueprint(bp([{ kind: 'wait', durationHours: 36 }, send('SMS', 'x')]))!;
    expect(odd.rows[0]).toEqual({ kind: 'wait', text: 'Wait 36 hours' });
  });

  it('names the fallback channel on the send that has one', () => {
    const withFallback = previewFromBlueprint(bp([send('WHATSAPP', 'A message.', 'SMS')]))!;
    expect(withFallback.rows[0]).toMatchObject({ channel: 'WhatsApp', fallback: 'SMS' });
  });

  it('states what ends the journey early', () => {
    expect(p.stops).toBe('Stops as soon as card activated');
  });

  it('draws nothing at all when there are no steps', () => {
    // So the caller never renders a heading over an empty frame.
    expect(previewFromBlueprint(bp([]))).toBeNull();
    expect(previewFromBlueprint(null)).toBeNull();
    expect(previewFromBlueprint('not a blueprint')).toBeNull();
  });
});

describe('a condition draws BOTH arms, including the rest path', () => {
  const p = previewFromBlueprint(
    bp([
      {
        kind: 'condition',
        label: 'Assigned limit above the cohort median?',
        on: { entity: 'Account', attribute: 'Credit Limit', operator: 'Greater than', value: '0' },
        yes: [send('WHATSAPP', 'One reminder, since they are already set up.')],
        no: [send('WHATSAPP', 'A reminder.'), { kind: 'wait', durationHours: 24 }, send('SMS', 'One more.')],
      },
    ]),
  )!;

  it('is a fork with two labelled paths', () => {
    const fork = p.rows[0];
    expect(fork.kind).toBe('fork');
    expect((fork as { text: string }).text).toBe('Assigned limit above the cohort median?');
    expect((fork as { paths: { label: string }[] }).paths.map((x) => x.label)).toEqual(['Yes', 'No']);
  });

  it('carries the steps of each arm, so the two treatments are visible', () => {
    const paths = (p.rows[0] as { paths: { rows: PreviewRow[] }[] }).paths;
    expect(paths[0].rows).toHaveLength(1);
    expect(paths[1].rows).toHaveLength(3);
  });

  it('gives an EMPTY arm a path with a note, never no path', () => {
    // The failure this guards. A condition with an empty `no` is the same
    // filter as a narrower entry, and a schematic that omitted it would show
    // a campaign reaching people it drops.
    const lopsided = previewFromBlueprint(
      bp([{ kind: 'condition', label: 'High limit?', yes: [send('WHATSAPP', 'A message.')], no: [] }]),
    )!;
    const paths = (lopsided.rows[0] as { paths: { label: string; note?: string; rows: PreviewRow[] }[] }).paths;
    expect(paths).toHaveLength(2);
    expect(paths[1].label).toBe('No');
    expect(paths[1].note).toBe('No further messages on this path.');
  });

  it('writes a question for a condition the model left unlabelled', () => {
    const unlabelled = previewFromBlueprint(
      bp([{ kind: 'condition', on: { attribute: 'PIN Set', operator: 'Equals', value: 'Yes' }, yes: [], no: [send('SMS', 'x')] }]),
    )!;
    expect((unlabelled.rows[0] as { text: string }).text).toBe('PIN Set equals Yes?');
  });

  it('reads a delivery-outcome condition as a question too', () => {
    const delivery = previewFromBlueprint(
      bp([{ kind: 'condition', outcomes: ['NOT_DELIVERED', 'HARD_BOUNCE'], yes: [send('SMS', 'x')], no: [] }]),
    )!;
    expect((delivery.rows[0] as { text: string }).text).toContain('not delivered');
  });
});

describe('an experiment draws every arm', () => {
  const p = previewFromBlueprint(
    bp([
      {
        kind: 'experiment',
        label: 'Which barrier is real?',
        tests: 'explanation',
        arms: [
          { label: 'How-to', pct: 45, steps: [send('WHATSAPP', 'Here is how to set your PIN.')] },
          { label: 'Reason-to-use', pct: 45, steps: [send('WHATSAPP', 'Your card is ready to use today.')] },
          { label: 'Holdout', pct: 10, steps: [] },
        ],
      },
    ]),
  )!;

  it('draws all three, holdout included', () => {
    const paths = (p.rows[0] as { paths: { label: string }[] }).paths;
    expect(paths).toHaveLength(3);
    expect(paths.map((x) => x.label)).toEqual(['How-to · 45%', 'Reason-to-use · 45%', 'Holdout · 10%']);
  });

  it('shows the holdout as a path that sends nothing, not as an absence', () => {
    const paths = (p.rows[0] as { paths: { note?: string; rows: PreviewRow[] }[] }).paths;
    expect(paths[2].rows).toHaveLength(0);
    expect(paths[2].note).toBeTruthy();
  });

  it('notes a campaign-level control on the way in', () => {
    // `controlPct` is a silent percentage on the blueprint. Unstated, the
    // people who get nothing simply vanish from the picture.
    const held = previewFromBlueprint(bp([send('SMS', 'x')], { controlPct: 10 }))!;
    expect(held.entryNote).toBe('10% are held back with no messages, as a comparison.');
    expect(previewFromBlueprint(bp([send('SMS', 'x')]))!.entryNote).toBeUndefined();
  });
});

describe('a branch draws every path', () => {
  it('labels each path with its own comparison', () => {
    const p = previewFromBlueprint(
      bp([
        {
          kind: 'branch',
          label: 'Credit limit band',
          entity: 'Account',
          attribute: 'Credit Limit',
          paths: [
            { label: 'Lower half', operator: 'Less than', value: '50000', steps: [send('SMS', 'Two reminders.')] },
            { label: 'Upper half', operator: 'Greater than', value: '50000', steps: [send('WHATSAPP', 'One reminder.')] },
          ],
        },
      ]),
    )!;
    const fork = p.rows[0] as { text: string; paths: { label: string }[] };
    expect(fork.text).toBe('Credit limit band — Credit Limit');
    expect(fork.paths.map((x) => x.label)).toEqual(['Lower half · less than 50000', 'Upper half · greater than 50000']);
  });
});

describe('a fork nested inside an arm still draws', () => {
  it('recurses, so no path is lost at depth', () => {
    const p = previewFromBlueprint(
      bp([
        {
          kind: 'experiment',
          label: 'Which barrier is real?',
          arms: [
            {
              label: 'How-to',
              pct: 50,
              steps: [
                send('WHATSAPP', 'How to set the PIN.'),
                { kind: 'condition', label: 'Delivered?', yes: [], no: [send('SMS', 'Trying again by SMS.')] },
              ],
            },
            { label: 'Control', pct: 50, steps: [] },
          ],
        },
      ]),
    )!;
    const all = flatten(p.rows);
    expect(all.filter((r) => r.kind === 'fork')).toHaveLength(2);
    expect(all.filter((r) => r.kind === 'send').map((r) => (r as { text: string }).text)).toEqual([
      'How to set the PIN.',
      'Trying again by SMS.',
    ]);
  });
});

describe('a malformed or older blueprint still draws something', () => {
  it('never throws on missing fields', () => {
    // This parses a payload rather than constructing one: a blueprint from an
    // older run, or one the model wrote slightly wrong, must still draw. A
    // crash here would take the whole propose turn with it.
    const rough = previewFromBlueprint({
      steps: [{ kind: 'send' }, { kind: 'wait' }, { kind: 'condition' }, { kind: 'unknown-kind' }, {}],
    })!;
    expect(rough.rows).toHaveLength(5);
    expect(rough.entry).toBe('Everyone eligible');
    for (const r of flatten(rough.rows)) expect(String((r as { text?: string }).text ?? '').length).toBeGreaterThan(0);
  });

  it('reads an event entry as well as an audience entry', () => {
    const evented = previewFromBlueprint(
      bp([send('SMS', 'x')], { entry: { kind: 'event', eventCategory: 'Card Events', eventType: 'CARD_ISSUED' } }),
    )!;
    expect(evented.entry).toBe('When card issued');
  });

  it('reads the extra ANDed entity groups the entry vocabulary supports', () => {
    const grouped = previewFromBlueprint(
      bp([send('SMS', 'x')], {
        entry: {
          kind: 'audience',
          entity: 'Card',
          conditions: [{ attribute: 'PIN Set', operator: 'Equals', value: 'No' }],
          groups: [{ entity: 'Account', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] }],
        },
      }),
    )!;
    expect(grouped.entry).toContain('and');
    expect(grouped.entry).toContain('Status equals Active');
  });
});

// --------------------------------------------------- the pane it renders in

describe('the propose turn puts the schematic in the left pane only', () => {
  it('shows the proposal heading instead of "What I have so far"', () => {
    expect(designer).toContain("'Proposed journey'");
    expect(designer).toContain("'Not built yet. Confirm on the right, or say what to change.'");
  });

  it('banners the schematic as not built', () => {
    expect(designer).toMatch(/Proposed — not built yet\./);
  });

  it('replaces the skeleton rather than sitting beside it', () => {
    // Two pictures of the same journey, one of them grey, is worse than
    // either alone.
    expect(designer).toMatch(/\{preview && <JourneySchematic preview=\{preview\} busy=\{busy\} \/>\}/);
    expect(designer).toMatch(/\{!preview && \(\s*<div className="cd-skeleton"/);
  });

  it('does not mount DripCanvas or set a graph for a proposal', () => {
    // The preview is drawn from `pendingBlueprint`; `graph` is still null, so
    // the real canvas stays unmounted and `cd-has-journey` stays off. A
    // proposal must not look like a built campaign.
    expect(designer).toMatch(/\{graph && \(/);
    expect(designer).toMatch(/graph \? 'cd-has-journey' : 'cd-no-journey'/);
    // RETARGETED 2026-10-26: the preview is tied to the PATH, not the phase.
    // It was `phase === 'awaiting-confirmation' ? previewFromBlueprint(...)`,
    // so a held turn carrying a real filed journey drew nothing at all —
    // measured on `eval/runs/ui-s-1792843757296` turn 3, where the manager
    // read an essay about a path the server had already accepted. Drawing is
    // not approving: `graph` is still null above, and Confirm is still gated
    // on the phase.
    expect(designer).toMatch(/previewFromBlueprint\(pendingBlueprint\), \[pendingBlueprint\]/);
    expect(designer).not.toMatch(/phase === 'awaiting-confirmation' \? previewFromBlueprint/);
  });

  it('still gates CONFIRM on the phase, so a drawing is not a decision', () => {
    // The whole point of splitting them: a held turn may show the journey and
    // must not show the button.
    expect(designer).toMatch(/\{!busy && phase === 'awaiting-confirmation' && \(/);
  });

  it('shrinks the brief to a strip and hides the lines of enquiry', () => {
    expect(designer).toMatch(/briefView && preview && \(\s*<div className="cd-briefstrip">/);
    expect(designer).toMatch(/briefView && !preview && \(\s*<div className="cd-work-grid">/);
    expect(designer).toMatch(/briefView\?\.dimensions\?\.length\) && !preview/);
  });

  it('keeps the confirm gate in the chat column, not in the work pane', () => {
    // The layout rule: the picture is on the left, the decision is on the
    // right. `cd-confirm` must stay a sibling of the messages.
    const chat = designer.slice(designer.indexOf('className="cd-chat'), designer.indexOf('cd-sends'));
    expect(chat).toContain('className="cd-confirm"');
    const work = designer.slice(designer.indexOf('className="cd-work hf-scroll"'), designer.indexOf('{graph && ('));
    expect(work).not.toContain('cd-confirm');
  });

  it('points at the left pane from the confirm gate', () => {
    expect(designer).toContain("' The proposed path is on the left.'");
  });

  it('holds the template-id panel back until something is built', () => {
    // `sendProposals?.length` since 2026-10-22: the chain stopped at `last`,
    // so a stored response without the field took the whole designer down.
    // The condition under test — held back until something is built — is
    // unchanged.
    // RETARGETED: two phases carry a plan now, so the gate is `planOnScreen`
    // (`awaiting-confirmation` or `revising`). Asking for template ids beside
    // an unapproved plan reads as though the campaign already existed,
    // whichever of the two it is.
    expect(designer).toMatch(/last\?\.sendProposals\?\.length && !planOnScreen/);
    expect(designer).toMatch(/const planOnScreen = phase === 'awaiting-confirmation' \|\| phase === 'revising';/);
  });

  it('keeps the schematic up while the journey is being built', () => {
    // Confirm swaps one picture for another. An empty canvas in between reads
    // as the proposal having been thrown away.
    expect(designer).toMatch(/busy \? 'Building the journey…' : 'Proposed — not built yet\.'/);
  });

  it('draws the proposal read-only, with no editing affordance', () => {
    const schematic = designer.slice(designer.indexOf('function JourneySchematic'), designer.indexOf('function PreviewRows'));
    for (const forbidden of ['onClick', 'onEditNode', 'editable', 'DripCanvas']) {
      expect(schematic, forbidden).not.toContain(forbidden);
    }
  });

  it('does not import the server blueprint into the browser bundle', () => {
    const preview = readFileSync(new URL('../../src/designer/preview.ts', import.meta.url), 'utf8');
    expect(preview).not.toMatch(/from '\.\.\/\.\.\/server\//);
    expect(designer).not.toMatch(/from '\.\.\/\.\.\/server\/blueprint'/);
  });
});
