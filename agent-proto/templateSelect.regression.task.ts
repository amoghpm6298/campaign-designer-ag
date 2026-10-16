// Regression tests for template selection.
//
// The defect: the planner took the first template whose channelType matched,
// so an EMI consent ask on EMAIL selected "Festive Offer Email" (CT-3288) —
// right channel, entirely wrong message. Schema validation passed, because a
// template id is a template id.
import { describe, it, expect } from 'vitest';
import { selectTemplate, scoreTemplates, knownPersonalisationFields, type TemplateNeed } from './templateSelect';
import { COMMS_TEMPLATES, type Channel } from '../src/data/sharedConstants';

const emiFirstTouch: TemplateNeed = {
  objective: ['emi', 'convert'],
  stage: 'first-touch',
  describe: 'Your recent purchase is eligible for EMI — convert it before the offer expires.',
};
const emiReminder: TemplateNeed = { ...emiFirstTouch, stage: 'reminder', describe: 'Your EMI offer is still open.' };

describe('template selection', () => {
  it('prefers a relevant template over an unrelated one on the same channel', () => {
    // WhatsApp holds both EMI templates and completely unrelated ones
    // (card activation, PIN setup). The EMI one must win.
    const ranked = scoreTemplates(emiFirstTouch, 'WHATSAPP');
    expect(ranked[0].template.id).toBe('CT-3310'); // Auth-to-EMI Consent
    expect(ranked[0].matched).toEqual(expect.arrayContaining(['objective:emi']));

    // And the unrelated ones are disqualified, not merely ranked lower.
    const activation = ranked.find((r) => r.template.id === 'CT-3313')!;
    expect(activation.score).toBeLessThan(0);
    expect(activation.offTopic).toContain('card activation');
  });

  it('does NOT select the festive email for an EMI ask — the original defect', () => {
    const onlyEmail = selectTemplate(emiFirstTouch, ['EMAIL']);
    // CT-3288 is the only EMAIL template, and it is about festive marketing.
    expect(COMMS_TEMPLATES.filter((t) => t.channelType === 'EMAIL').map((t) => t.id)).toEqual(['CT-3288']);
    expect(onlyEmail.kind).toBe('proposal');
    if (onlyEmail.kind === 'proposal') {
      expect(onlyEmail.reason).toMatch(/festive marketing/i);
    }
  });

  it('skips a cheaper channel that has no suitable template, and records why', () => {
    // EMAIL first (cheapest), then SMS. EMAIL must be skipped for content.
    const choice = selectTemplate(emiFirstTouch, ['EMAIL', 'SMS']);
    expect(choice.kind).toBe('existing');
    if (choice.kind === 'existing') {
      expect(choice.channel).toBe('SMS');
      expect(choice.template.id).toBe('CT-3301'); // EMI Conversion SMS
      expect(choice.reason).toMatch(/EMAIL skipped/);
      expect(choice.reason).toMatch(/festive marketing/i);
    }
  });

  it('never invents a template id when nothing suitable exists', () => {
    // A need no template addresses at all.
    const unmatched: TemplateNeed = {
      objective: ['mortgage', 'refinance'],
      stage: 'first-touch',
      describe: 'Refinance your home loan at a lower rate.',
    };
    const choice = selectTemplate(unmatched, ['SMS', 'EMAIL', 'WHATSAPP']);
    expect(choice.kind).toBe('proposal');
    if (choice.kind === 'proposal') {
      expect(choice.templateId).toBeNull();
      // Nothing resembling a real id may appear anywhere in the proposal.
      const serialised = JSON.stringify(choice);
      expect(serialised).not.toMatch(/"CT-\d+"/);
    }
  });

  it('a proposal carries a messaging direction, sample copy, CTA and real personalisation fields', () => {
    const choice = selectTemplate(
      { objective: ['mortgage'], stage: 'first-touch', describe: 'Refinance your home loan.' },
      ['EMAIL'],
    );
    expect(choice.kind).toBe('proposal');
    if (choice.kind === 'proposal') {
      expect(choice.messagingDirection.length).toBeGreaterThan(0);
      expect(choice.sampleCopy.length).toBeGreaterThan(0);
      expect(choice.cta.length).toBeGreaterThan(0);
      // Personalisation tokens must be ones existing templates really use,
      // not invented variable names.
      const real = knownPersonalisationFields();
      expect(choice.personalisationFields.length).toBeGreaterThan(0);
      for (const f of choice.personalisationFields) expect(real).toContain(f);
    }
  });

  it('flags a weak stage fit and names a better-fitting template instead of silently reusing copy', () => {
    // SMS has one EMI template; it is objective-correct but not written as a
    // reminder. WhatsApp's CT-3311 is. The selector must not switch channel
    // on its own (that would override the bank's cost preference) but must
    // say so.
    const choice = selectTemplate(emiReminder, ['SMS', 'WHATSAPP']);
    expect(choice.kind).toBe('existing');
    if (choice.kind === 'existing') {
      expect(choice.channel).toBe('SMS');
      expect(choice.weakStageFit).toBe(true);
      expect(choice.betterStageFitElsewhere?.id).toBe('CT-3311');
      expect(choice.betterStageFitElsewhere?.channel).toBe('WHATSAPP');
      expect(choice.reason).toMatch(/not stage-specific|would fit the stage better/i);
    }
  });

  it('reports a strong stage fit as such when the right template is reachable', () => {
    const choice = selectTemplate(emiReminder, ['WHATSAPP']);
    expect(choice.kind).toBe('existing');
    if (choice.kind === 'existing') {
      expect(choice.template.id).toBe('CT-3311'); // Auth-to-EMI Reminder
      expect(choice.weakStageFit).toBe(false);
      expect(choice.betterStageFitElsewhere).toBeUndefined();
    }
  });

  it('every selected template id exists in COMMS_TEMPLATES', () => {
    const ids = new Set(COMMS_TEMPLATES.map((t) => t.id));
    for (const chans of [['SMS'], ['WHATSAPP'], ['EMAIL', 'SMS'], ['SMS', 'WHATSAPP']] as Channel[][]) {
      for (const need of [emiFirstTouch, emiReminder]) {
        const c = selectTemplate(need, chans);
        if (c.kind === 'existing') expect(ids.has(c.template.id)).toBe(true);
      }
    }
  });
});
