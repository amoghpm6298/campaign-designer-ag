// Turn-1 EMI opener. Measured three live runs, then ui-s-1792770967470.
//
// The manager opened with: no campaign history, a 7-day plan, more eligible
// purchases to EMI. The record now captures those facts. What still leaked
// on the first green opener was the OUTGOING QUESTION LIST: count-versus-value
// survived, the benchmark reprint dropped, and converters were never injected
// because substitution only ran when EVERY question was a history reprint.
import { describe, it, expect } from 'vitest';
import { newBrief, noteOpeningFacts, nextCustomerQuestion } from '../../server/discovery';
import { recordAsked, outstanding } from '../../server/record';

const OPENING =
  'We want more EMI-eligible card purchases to become EMI. We have no campaign history. I need a 7 day plan.';

const COUNT_VS_VALUE =
  'When you say you want more EMI-eligible purchases to convert, is success about the NUMBER of purchases that convert (more cardholders using EMI at all), or the VALUE of spend that moves into EMI (bigger-ticket transactions converting, even if fewer of them)?';

const BENCHMARK =
  'is there a target or benchmark you already have in mind (a conversion rate, an EMI book amount) or is this genuinely the first run?';

describe('the exact EMI opening message', () => {
  it('records the no-history limitation and the 7-day window', () => {
    const b = noteOpeningFacts(newBrief(OPENING), OPENING);
    expect(b.limitations.join(' ')).toMatch(/no campaign history/i);
    expect(b.facts.map((f) => f.statement).join(' ')).toMatch(/7 days/);
    expect(b.facts.map((f) => f.statement).join(' ')).toMatch(/no conversion rate, benchmark, baseline or past result/i);
  });

  it('drops a closed-history reprint and still asks who converts', () => {
    const brief = noteOpeningFacts(newBrief(OPENING), OPENING);
    const asked = recordAsked(
      brief,
      [
        { text: COUNT_VS_VALUE, impact: 'fork' },
        { text: BENCHMARK, impact: 'shaping' },
      ],
      'agent',
    );
    const out = outstanding(asked).map((q) => q.text);
    expect(out.join(' ')).not.toMatch(/benchmark|first run/i);
    expect(out).toContain(COUNT_VS_VALUE);
    expect(out).toContain(nextCustomerQuestion(brief, { skipSuccess: true }));
  });

  it('does not add a second converters question when the agent already asked who converts', () => {
    const brief = noteOpeningFacts(newBrief(OPENING), OPENING);
    const convertersInTheirWords =
      'Among cardholders who make EMI-eligible purchases, have you noticed any pattern in who actually converts to EMI on their own?';
    const asked = recordAsked(brief, [{ text: convertersInTheirWords, impact: 'shaping' }], 'agent');
    expect(outstanding(asked)).toHaveLength(1);
    expect(outstanding(asked)[0].text).toBe(convertersInTheirWords);
  });
});
