// The activity row is written for the manager, not for the model.
//
// MEASURED, on every recorded run and visible in `.ux-shots/03-plan`: the
// row under "Putting questions to you" read
//
//   3 question(s) recorded. Now write your message, asking them directly.
//
// The second sentence is an instruction to the MODEL — the note above
// `ask_questions` in `outputTools.ts` explains at length that a tool result
// is the last thing the model reads before it writes, so its register is the
// register the reply comes back in. That string was also the UI's `detail`.
// One string, two readers, and the model's half was on screen in a product
// sold to banks on being inspectable.
//
// The counts leaked through the same hole: "1 barrier(s)", "3 line(s) of
// enquiry", "1 planned step(s)". `(s)` is not a plural; it is a placeholder
// nobody filled in.
//
// `ok` still says whatever steers the next sentence best. `said` is the same
// event told to a person, and the activity row prefers it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyOutputTool } from '../../server/outputTools';
import { newBrief } from '../../server/discovery';

const orchestrator = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

/** Every phrase that is addressed to the model rather than to the manager. */
const TO_THE_MODEL = [
  /now write your message/i,
  /asking them directly/i,
  /send the same plan/i,
  /\bbuild_campaign\b/,
  /\bpropose_strategy\b/,
  /\brecord_findings\b/,
];

const apply = (tool: string, input: unknown) => applyOutputTool(newBrief('Get more EMI conversions') as never, tool, input as never);

describe('what the manager reads about a tool call', () => {
  it('does not carry the instruction the model is given', () => {
    const out = apply('ask_questions', {
      questions: [
        { text: 'How will you judge this worked?', rides: 'shaping' },
        { text: 'Who converts today?', rides: 'fork', ifA: 'target them', ifB: 'find out' },
      ],
    });
    // The model's half is UNCHANGED — this is a split, not a rewrite, and the
    // register that steers the reply is the reason that sentence exists.
    expect(out.ok, 'the model still gets its instruction').toMatch(/now write your message/i);
    expect(out.said, 'and the manager gets a sentence of their own').toBeTruthy();
    for (const phrase of TO_THE_MODEL) {
      expect(out.said, `${phrase} is addressed to the model`).not.toMatch(phrase);
    }
  });

  it('spells the plural instead of printing "(s)"', () => {
    const one = apply('ask_questions', { questions: [{ text: 'Who converts today?', rides: 'shaping' }] });
    const two = apply('ask_questions', {
      questions: [
        { text: 'Who converts today?', rides: 'shaping' },
        { text: 'What stops the rest?', rides: 'shaping' },
      ],
    });
    expect(one.said).toContain('1 question');
    expect(two.said).toContain('2 questions');
    for (const out of [one, two]) {
      expect(out.said, 'a person reads this').not.toContain('(s)');
    }
  });

  it('counts barriers on the record in words, in the sentence the manager sees', () => {
    const out = apply('record_findings', {
      converters: { shape: 'Purchases over ₹10,000', basis: 'user', knowledge: 'known' },
      barriers: [
        {
          id: 'awareness',
          statement: 'They do not know the purchase qualifies',
          basis: 'user',
          lever: 'message',
          quote: 'customers have no idea it can be converted',
        },
      ],
    });
    expect(out.said).toMatch(/1 barrier\b/);
    expect(out.said).not.toContain('(s)');
  });

  it('is what the activity row prefers, with `ok` only as the fallback', () => {
    // Both must move together. Giving the tools a `said` nobody reads, or
    // reading a field no tool sets, each leaves the model's sentence on
    // screen — so the pin is on the expression, not on either half alone.
    expect(orchestrator).toMatch(/detail: applied\.error \?\? applied\.said \?\? applied\.ok,/);
    expect(orchestrator, 'no site still reads `ok` first').not.toMatch(/detail: applied\.error \?\? applied\.ok,/);
  });

  it('does not print "(s)" on the row that counts planned steps either', () => {
    expect(orchestrator).not.toMatch(/planned step\(s\)/);
  });
});
