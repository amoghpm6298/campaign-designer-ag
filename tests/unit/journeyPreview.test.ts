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
import { previewFromBlueprint, templateSegments, type PreviewRow } from '../../src/designer/preview';

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

describe('the propose turn puts the schematic in the work pane only', () => {
  // RENAMED 2026-11-04, agent360 port. The panes swapped sides: the
  // conversation is on the LEFT now and the work surface on the RIGHT,
  // matching agent360 and every other Hyperface console. "The left pane"
  // named a position rather than a role, so it stopped being true the
  // moment the layout moved; "the work pane" is what this file was always
  // actually about and cannot be invalidated by a column order.
  //
  // THE RULE UNDER TEST IS UNCHANGED: a proposal draws in the work pane and
  // nowhere else, and drawing it is not approving it.
  it('shows the proposal heading instead of "What I have so far"', () => {
    expect(designer).toContain("'Proposed journey'");
    expect(designer).toContain("'Not built yet. Confirm on the left, or say what to change.'");
  });

  it('banners the schematic as not built', () => {
    expect(designer).toMatch(/Proposed — not built yet\./);
  });

  it('replaces the empty state rather than sitting beside it', () => {
    // Two pictures of the same journey, one of them grey, is worse than
    // either alone. THE RULE IS UNCHANGED; only the thing being replaced
    // was renamed — `.cd-skeleton` was a wireframe pinned to the bottom of
    // the pane, and is now `.cd-empty`, a centred card carrying a headline
    // and one sentence. The pin is on the EXCLUSIVITY, which is what this
    // test has always been about.
    expect(designer).toMatch(/\{preview && <JourneySchematic preview=\{preview\} busy=\{busy\} \/>\}/);
    // `cd-emptystate`, NOT `cd-empty`: the latter is a long-standing
    // modifier on `.cd-body` (`!messages.length && !busy`), and styling it
    // laid the whole two-column body out as one centred row.
    expect(designer).toMatch(/\{!preview && \(\s*<div className="cd-emptystate">/);
    expect(designer, 'the old wireframe is not still mounted somewhere').not.toMatch(/className="cd-skeleton"/);
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

  it('points at the work pane from the confirm gate', () => {
    // RETARGETED 2026-11-04 with the column flip. The gate sits in the
    // conversation column and the journey beside it, so the sentence has to
    // name the other side — and BOTH directions have to move together.
    // The pin is kept precisely because the two can disagree: a gate that
    // points at the pane it is standing in is the defect this catches.
    expect(designer).toContain("' The proposed path is on the right.'");
    expect(designer, 'both sentences moved, not one').toContain(
      "'Not built yet. Confirm on the left, or say what to change.'",
    );
  });

  it('has no template-id panel to hold back, and still knows what a plan on screen is', () => {
    // REPLACED 2026-11-04. This pinned the panel's gate — template ids must
    // not be asked for beside a plan nobody has approved, because it reads
    // as though the campaign already existed.
    //
    // The panel is gone. `NodeForms`' AccountTemplateFields already put the
    // same two fields on the Send node's own drawer, as dropdowns over the
    // real template list, so the panel was a second and worse way to do one
    // thing — the shape this repo named when Condition's "Goal" source and
    // the Goal Check node answered one question and built different graphs.
    //
    // THE RULE THE GATE PROTECTED IS NOW STRUCTURAL: there is nowhere to ask
    // for a template id except the node itself, which only exists once the
    // campaign is built. So the pin is that the panel is gone...
    expect(designer, 'no second template editor').not.toMatch(/cd-sends/);
    expect(designer).not.toMatch(/Apply and revalidate/);
    // ...and that `planOnScreen` still means what the rest of this file
    // relies on, since the numbered-question and Confirm rules read it.
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

describe('the schematic shows the message, not a label for it', () => {
  // THE WORST THING ON THE PROPOSAL SCREEN, measured in `.ux-shots/03-plan`:
  // five send cards all reading "WHATSAPP / A message". The cause was not
  // the renderer — `ViewStep` never declared `copy`, so `previewFromBlueprint`
  // could only ever reach `describe`, and the agent writes a description on
  // some sends and not others. Nobody approves copy they cannot see.
  const withCopy = previewFromBlueprint(
    bp([
      {
        kind: 'send',
        name: 'Day 0 eligibility notice',
        describe: 'Say the purchase qualifies and what the instalment costs.',
        copy: 'Hi {customerFirstName}, your ₹24,000 purchase can be split from ₹2,100 a month.',
        cta: 'Convert now',
        channelPreference: ['WHATSAPP'],
      },
    ]),
  )!;

  it('carries the customer-facing words through to the row', () => {
    expect(withCopy.rows[0]).toMatchObject({
      kind: 'send',
      channel: 'WhatsApp',
      copy: 'Hi {customerFirstName}, your ₹24,000 purchase can be split from ₹2,100 a month.',
      cta: 'Convert now',
    });
  });

  it('never says "A message" again, and says what is actually missing', () => {
    // A send with neither a purpose nor words is a real gap in the plan, so
    // the row states that rather than standing in for the message.
    const bare = previewFromBlueprint(bp([{ kind: 'send', channelPreference: ['SMS'] }]))!;
    const row = bare.rows[0] as { text: string; copy?: string };
    expect(row.text).not.toBe('A message');
    expect(row.text).toMatch(/no description/i);
    // ...and ONLY when there are no words either. A send carrying the
    // message needs no apology for lacking a label; the bubble is the
    // content, and printing both read as a complaint beside the answer.
    const copyOnly = previewFromBlueprint(
      bp([{ kind: 'send', copy: 'Your purchase is still eligible for EMI.', channelPreference: ['SMS'] }]),
    )!;
    expect((copyOnly.rows[0] as { text: string }).text).toBe('');
    expect(row.copy, 'nothing is invented to fill the bubble').toBeUndefined();
  });

  it('draws it as the channel, with placeholders as slots', () => {
    const src = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');
    // The device and the channel class are what make one send card differ
    // from another; without them it is a grey rectangle whatever it carries.
    expect(src).toMatch(/<MessageMock channel=\{row\.channel\} copy=\{row\.copy\}/);
    expect(src).toMatch(/ch-\$\{row\.channel\.toLowerCase\(\)/);
    expect(src, 'placeholders read as slots, not as a name').toMatch(/renderTemplate/);
  });
});

describe('a placeholder is a slot, not a name', () => {
  // The builder's own templates are written `${customerFirstName}`. Splitting
  // on `{…}` alone strands the dollar in the preceding run, and the bubble
  // reads "Hi $ {customerFirstName}" — measured in `.ux-shots-p9/03-plan`.
  it('keeps the $ with the token it belongs to', () => {
    expect(templateSegments('Hi ${customerFirstName}, your card is ready.')).toEqual([
      { text: 'Hi ', token: false },
      { text: '${customerFirstName}', token: true },
      { text: ', your card is ready.', token: false },
    ]);
  });

  it('reads a bare placeholder too, since both spellings are in use', () => {
    expect(templateSegments('Hello {name}')).toEqual([
      { text: 'Hello ', token: false },
      { text: '{name}', token: true },
    ]);
  });

  it('leaves a message with no placeholders as one run', () => {
    expect(templateSegments('Convert before the window closes.')).toEqual([
      { text: 'Convert before the window closes.', token: false },
    ]);
  });

  it('drops the empty runs a split leaves at the edges', () => {
    // `'{a}'.split(...)` yields ['', '{a}', ''] — three segments for one
    // token, and two empty spans in the bubble.
    expect(templateSegments('${only}')).toEqual([{ text: '${only}', token: true }]);
  });
});

describe('the decision does not scroll away', () => {
  // It lived inside `.cd-msgs`, so on a long turn — and a propose turn is
  // always long, it carries the whole strategy — the one thing the manager
  // is here to do sat below a telemetry list and had to be scrolled to.
  const src = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');

  it('is a sibling of the transcript, not a card inside it', () => {
    // MEASURED BY DEPTH, not by index. Comparing positions passes whether
    // the gate is nested or not — the transcript opens first either way —
    // and the first version of this pin did exactly that and survived its
    // own revert. What matters is whether `.cd-msgs` has CLOSED by the time
    // the gate opens, so the tags are counted.
    const msgs = src.indexOf('className="cd-msgs"');
    const confirm = src.indexOf('className="cd-confirm"');
    const compose = src.indexOf('className="cd-compose"');
    expect(msgs).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(msgs);
    expect(confirm).toBeLessThan(compose);

    const between = src.slice(msgs, confirm);
    const opened = (between.match(/<div\b/g) ?? []).length;
    const closed = (between.match(/<\/div>/g) ?? []).length;
    // SELF-CLOSING TAGS ARE NOT OPENS. `<div className="cd-sk-line" />` is
    // matched by `<div\b` and never closes, so a naive `closed - opened`
    // reads -1 in BOTH states and the first version of this failed whether
    // the gate was pinned or nested. Measured: 0 pinned, -1 nested.
    const selfClosing = (between.match(/<div\b[^>]*\/>/g) ?? []).length;
    expect(closed - (opened - selfClosing), 'the transcript has closed before the gate opens').toBe(0);
  });

  it('is still gated on the phase and nothing else', () => {
    // A drawing is not a decision. The preview is tied to `pendingBlueprint`
    // and a held plan draws without offering a button; moving the gate must
    // not have quietly widened what opens it.
    expect(src).toMatch(/\{!busy && phase === 'awaiting-confirmation' && \(/);
    expect(src, 'not keyed on a path existing').not.toMatch(/pendingBlueprint && phase === 'awaiting-confirmation'/);
  });
});

describe('a run that is working, and a turn that failed', () => {
  const src = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');

  it('keeps the live step where it cannot scroll away', () => {
    // The timeline says this too, and it scrolls. A 105-second tool call —
    // measured, `eval/runs/ui-s-1793613837789` — leaves whatever is on
    // screen looking frozen.
    expect(src).toMatch(/\{busy && \(\s*<span className="cd-runbadge">/);
    expect(src).toMatch(/const running = \[\.\.\.liveEvents\]\.reverse\(\)\.find/);
  });

  it('puts no Stop on the badge, because interrupting is the composer\'s job', () => {
    const badge = src.slice(src.indexOf('className="cd-runbadge"'), src.indexOf('className="cd-tabs"'));
    expect(badge).not.toMatch(/Stop|onClick/);
  });

  it('reports a failure even when a campaign is already on the canvas', () => {
    // THE DEFECT. The error was rendered in the canvas and gated on
    // `!graph`, so a refinement that failed over an existing campaign said
    // nothing at all — the one case where the manager most needs to know
    // the change did not land.
    expect(src, 'not gated on there being no graph').not.toMatch(/!busy && !graph && err &&/);
    expect(src).toMatch(/\{err && \(\s*<div className="cd-turnerror" role="alert">/);
  });

  it('is dismissible and sits outside the scrolling transcript', () => {
    const msgs = src.indexOf('className="cd-msgs"');
    const err = src.indexOf('className="cd-turnerror"');
    const between = src.slice(msgs, err);
    const opened = (between.match(/<div\b/g) ?? []).length;
    const closed = (between.match(/<\/div>/g) ?? []).length;
    const selfClosing = (between.match(/<div\b[^>]*\/>/g) ?? []).length;
    expect(closed - (opened - selfClosing), 'outside the transcript').toBe(0);
    expect(src).toMatch(/aria-label="Dismiss"/);
  });
});

describe('the campaign has one state, not a pipeline', () => {
  const src = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../src/designer/designer.css', import.meta.url), 'utf8');

  it('shows the blocking stage, not all five', () => {
    // Three green dots, one amber and one red read as a CI pipeline, and
    // put five verdicts in front of someone who can act on one. `blocking`
    // already picks that one and the sentence under it already spells it
    // out — the dots were a second, worse copy of the same thing.
    expect(src, 'no dot per stage').not.toMatch(/className="cd-stage-dot"/);
    expect(src, 'no row of stage rows').not.toMatch(/className=\{`cd-stage \$\{st\.state\}`\}/);
    expect(src).toMatch(/<span className=\{`cd-statepill \$\{blocking \? blocking\.state : 'ok'\}`\}/);
  });

  it('keeps every stage and its reason on the chip', () => {
    // Collapsing the strip must not throw the detail away: a reader who
    // wants the whole list can still get it.
    expect(src).toMatch(/title=\{stages\.map\(\(st\) => `\$\{st\.label\}: \$\{st\.detail\}`\)\.join/);
  });

  it('leaves no rules behind for the markup it replaced', () => {
    // Dead CSS outlives the markup that used it and reads as live styling
    // to the next person. These eight also carried six raw hex values.
    expect(css).not.toMatch(/^\.cd-stage\b/m);
    expect(css).not.toMatch(/\.cd-stage-dot/);
  });
});

describe('a finding says whose it is', () => {
  const src = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');

  it('reads the basis the server has always recorded', () => {
    // `server/findings.ts` has carried `basis: user | user-belief |
    // assumption` since findings existed, and `recordBarriers` VERIFIES the
    // quote against what the manager actually typed, downgrading one that
    // does not check out. `BriefView` declared neither, so none of it
    // reached the screen and an invented theory read like a quote.
    expect(src).toMatch(/barriers\?: \{ statement: string; basis\?: string; quote\?: string \}\[\]/);
    expect(src).toMatch(/<Basis basis=\{b\.basis\} quote=\{b\.quote\} \/>/);
  });

  it('tells theirs from ours in words, not only in colour', () => {
    const basis = src.slice(src.indexOf('function Basis('), src.indexOf('function Basis(') + 900);
    expect(basis).toMatch(/You said this/);
    expect(basis).toMatch(/Our assumption, untested/);
    // Colour alone fails for anyone who cannot see it, and this is the
    // distinction the product is sold on.
    expect(basis).toMatch(/theirs \? 'theirs' : 'ours'/);
  });

  it('puts the manager\'s own words behind the chip', () => {
    const basis = src.slice(src.indexOf('function Basis('), src.indexOf('function Basis(') + 900);
    expect(basis).toMatch(/title=\{quote \?/);
  });
});
