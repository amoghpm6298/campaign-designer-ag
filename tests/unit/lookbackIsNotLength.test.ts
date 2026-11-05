/**
 * LOOKBACK IS NOT CAMPAIGN LENGTH. REACTION ARMS MUST SPEND DIFFERENTLY.
 * APPETITE ONLY SCALES.
 *
 * Three rules copied from the papers into the manuals the model reads, plus
 * the two readers that back them. The papers are the source of truth:
 * `prompt-review-plan-current.md` and `prompt-review-confirm-current.md`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { statedWindow, newBrief, noteOpeningFacts } from '../../server/discovery';
import { journeyReacts, reactsToDelivery } from '../../server/optionAudit';
import { REACTION_RETRY } from '../../server/orchestrator';
import { OUTPUT_TOOLS } from '../../server/outputTools';
import { seedKnowledgeBase } from '../../server/knowledge';
import { asking, ready, build, sticky } from './support/prompts.ts';

describe('the manuals carry the three rules, in the papers’ words', () => {
  it('Plan says a lookback is the audience, not the calendar', () => {
    expect(ready()).toContain('Who is eligible is not how long the campaign runs.');
    expect(ready()).toContain('A lookback in the brief is the audience.');
    expect(ready()).toContain('Use a campaign length only if they asked for one.');
    expect(ready()).toContain('Do not add a last message to fill leftover days.');
    // AND THE LINES THAT TAUGHT THE OPPOSITE ARE GONE. Read together, "one
    // send per group is enough" and "size the plan to the customer's window"
    // told the agent to send as little as it could defend and then spread it.
    expect(ready()).not.toContain('One send per group in the window is enough');
    expect(ready()).not.toContain('Size the plan to the customer');
    expect(ready()).not.toContain('last chance before the window closes');
  });

  it('Plan says equal arms are not a reaction', () => {
    expect(ready()).toContain('If every arm has the same number of messages, it is not a reaction.');
    expect(ready()).toContain('A different channel or a longer wait on the same sequence is not enough.');
  });

  it('Plan says an unstated appetite scales UP', () => {
    expect(ready()).toContain('If there is no appetite on file, send more messages and run a test');
    expect(ready()).toContain('If they are conservative, then fewer messages and no test.');
    expect(ready()).toContain('Spreading a few messages across many days is not a fuller plan.');
  });

  it('Plan says a change after yes compiles, and is not this tool', () => {
    expect(ready()).toContain('If a path is already on file and they have not Confirmed, change that path.');
    expect(ready()).toContain('Once they have said yes, a change compiles. That is Confirm, not this tool.');
  });

  it('Confirm compiles the path plus what this message asked, and says so', () => {
    expect(build()).toContain('The path they approved is the job, plus what this message asked.');
    expect(build()).toContain('Do not add a last message to fill leftover days.');
    expect(build()).toContain('Do not even out the arms.');
    // The honesty closer.
    expect(build()).toContain('On the Confirm click, nothing new is approved. They already approved. You are compiling.');
    expect(build()).toContain('If this message asked for a change, compile what they just asked.');
    expect(build()).toContain('Do not pretend the old path is still the whole job.');
  });

  it('the Confirm STICKY matches the body about a typed change', () => {
    // PINNED ON THE STICKY, NOT ON build(). The body already carries "do not
    // pretend the old path is still the whole job", so asserting it against
    // the whole system string passes whether or not the sticky says it. The
    // sticky is the note about how to write the bubble, and the bubble is
    // where the wrong instruction showed.
    const note = sticky('build');
    expect(note).toContain('On the Confirm click, do not describe a different journey.');
    expect(note).toContain('If this message asked for a change, the bubble is the compiled change.');
    expect(note).toContain('Do not pretend the old path is still the whole job.');
    // The instruction that fought a typed change is gone.
    expect(note).not.toContain('They have approved the path');
    expect(note).not.toMatch(/Do not describe a (?!different journey)/);
    // And the plan tool is still named as absent, in the tools section.
    expect(note).toContain('propose_strategy is not here');
    // The sticky really does travel: it is part of what the model receives.
    expect(build()).toContain(note);
  });

  it('the paper and the manual say the same thing', () => {
    // They are edited together or the paper stops being the source of truth.
    const paper = readFileSync(new URL('../../prompt-review-confirm-current.md', import.meta.url), 'utf8');
    for (const line of [
      'On the Confirm click, do not describe a different journey.',
      'If this message asked for a change, the bubble is the compiled change.',
      'Do not pretend the old path is still the whole job.',
    ]) {
      expect(paper, `the paper must carry: ${line}`).toContain(line);
      expect(sticky('build'), `the sticky must carry: ${line}`).toContain(line);
    }
    expect(paper).not.toContain('They have approved the path');
  });

  it('no reaction-retry in Confirm, and no Download or Import in any manual', () => {
    expect(build().toLowerCase()).not.toContain('reaction retry');
    for (const [name, text] of [['asking', asking()], ['ready', ready()], ['build', build()]] as const) {
      expect(text, `${name} must not mention the export path`).not.toMatch(/\bDownload\b|\bImport\b/);
    }
  });

  it('Discovery gains the one sentence and NOT a how-long question', () => {
    expect(asking()).toContain('Do not ask how long the campaign runs because the brief named a lookback.');
    expect(asking()).toContain('Campaign length is Plan.');
    // A prohibition, not a new question. Discovery asks nothing new.
    expect(asking()).not.toMatch(/How long (would|should|do) you/i);
    expect(asking()).not.toMatch(/how many days/i);
  });
});

describe('statedWindow records a campaign length, never a lookback', () => {
  it('the EMI opener still records 7 days', () => {
    expect(statedWindow('We want more EMI-eligible card purchases to become EMI. I need a 7 day plan.')).toBe('7 days');
    const brief = noteOpeningFacts(newBrief('I need a 7 day plan.'), 'I need a 7 day plan.');
    expect(JSON.stringify(brief.facts ?? [])).toMatch(/7 days/);
  });

  it('a 90-day lookback does NOT record a campaign clock', () => {
    // THE DEFECT. The first "N days" anywhere in the brief became the window
    // the campaign had to work inside, so an eligibility rule handed the agent
    // a calendar — and it added messages to fill it.
    expect(statedWindow('Reactivate cards that have had no transaction in the last 90 days.')).toBeNull();
    expect(statedWindow('Customers quiet for 60 days should hear from us.')).toBeNull();
    expect(statedWindow('No purchase in the last 30 days, get them spending again.')).toBeNull();
    const opener = 'Reactivate cards that have had no transaction in the last 90 days.';
    const brief = noteOpeningFacts(newBrief(opener), opener);
    expect(JSON.stringify(brief.facts ?? []), 'no 90-day clock on the record').not.toMatch(/90 days/);
  });

  it('still reads the other ways they ask for a length', () => {
    expect(statedWindow('I need a 14-day campaign.')).toBe('14 days');
    expect(statedWindow('The plan should run for 10 days.')).toBe('10 days');
    expect(statedWindow('Run it for 21 days.')).toBe('21 days');
    // A lookback and a length in one sentence: the length wins, the lookback
    // is ignored.
    expect(statedWindow('Target anyone with no login in the past 45 days and run it for 7 days.')).toBe('7 days');
  });
});

describe('reactsToDelivery: an arm that reacts spends differently', () => {
  const send = (name: string, ch = ['WHATSAPP']) => ({
    kind: 'send', name, label: name, stage: 'reminder', objective: ['emi'],
    describe: 'd', copy: 'c', channelPreference: ch,
  });
  const bp = (steps: unknown[]) =>
    ({ campaignName: 'x', description: 'd', goal: null, entry: { kind: 'audience', entity: 'Customer', conditions: [] }, steps }) as never;
  const fork = (unread: unknown[], read: unknown[]) => ({
    kind: 'branch', label: 'What it did',
    paths: [
      { label: 'Unread', statuses: ['DELIVERED'], steps: unread },
      { label: 'Read', statuses: ['READ'], steps: read },
    ],
  });

  it('READ 2 against unread 2 is not a reaction', () => {
    expect(journeyReacts(bp([send('open'), fork([send('a1'), send('a2')], [send('b1'), send('b2')])]))).toBe(false);
  });

  it('neither is a channel-only nor a wait-only difference on the same spend', () => {
    expect(journeyReacts(bp([send('open'), fork([send('a', ['SMS'])], [send('b', ['WHATSAPP'])])]))).toBe(false);
    expect(
      journeyReacts(bp([send('open'), fork([{ kind: 'wait', durationHours: 24 }, send('a')], [{ kind: 'wait', durationHours: 72 }, send('b')])])),
    ).toBe(false);
  });

  it('read denser than unread IS a reaction', () => {
    expect(journeyReacts(bp([send('open'), fork([send('a')], [send('b1'), send('b2')])]))).toBe(true);
  });

  it('and so is a Yes/No condition whose sides spend differently', () => {
    const two = { kind: 'condition', label: 'read?', outcomes: ['READ'], yes: [send('y1'), send('y2')], no: [send('n1')] };
    const one = { kind: 'condition', label: 'read?', outcomes: ['READ'], yes: [send('y1')], no: [send('n1')] };
    expect(journeyReacts(bp([send('open'), two]))).toBe(true);
    expect(journeyReacts(bp([send('open'), one]))).toBe(false);
  });

  it('wait-for-event is unchanged, and a who-split may match in count', () => {
    const wfe = bp([send('open'), { kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', timeoutDays: 7, conditions: [] }]);
    expect(journeyReacts(wfe), 'a wait for the behaviour is still a reaction').toBe(true);
    expect(reactsToDelivery(wfe), 'but not a DELIVERY reaction').toBe(false);
    // Two ticket bands with two messages each is a who-split, not a claim
    // about reacting — and nothing holds it.
    const whoSplit = bp([
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', steps: [send('h1'), send('h2')] },
          { label: 'Low', steps: [send('l1'), send('l2')] },
        ],
      },
    ]);
    expect(journeyReacts(whoSplit)).toBe(false);
  });

  it('the retry says it too', () => {
    expect(REACTION_RETRY).toContain('The same number of messages on every arm is not a different job.');
  });
});

describe('the touches schema and the appetite note', () => {
  it('touches asks for every message in order, and names no minimum shape', () => {
    const tool = OUTPUT_TOOLS.find((t) => t.name === 'propose_strategy')!;
    const touches = (tool.input_schema as { properties: { touches: { description: string; minItems: number } } }).properties.touches;
    expect(touches.description).toContain('List every message, in order.');
    expect(touches.description).toContain('Do not add a last message just because time is left on who is eligible.');
    expect(touches.description).not.toContain('first touch, at least one reminder, and the last chance');
    expect(touches.minItems, 'unchanged').toBe(2);
  });

  it('the appetite note scales up rather than designing "the full plan"', () => {
    const kb = JSON.stringify(seedKnowledgeBase());
    expect(kb).toContain('No appetite on file. Send more messages and include a test.');
    expect(kb).toContain('Do not spread a few messages across a long calendar.');
    expect(kb).not.toContain('design the full plan');
  });
});
