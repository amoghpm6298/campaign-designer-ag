// The agent's questions, as an overlay on the canvas. Grouped by aspect.
// Every question has answers to tap, plus Other. Skip on a question strikes it
// out; Skip all sends at once. Skipped and blank questions: the agent assumes
// the answer and says what it assumed.
import { useState } from 'react';
import { renderInline } from '../RichText';
import { answerOf, composeReply, emptyField, groupByAspect, isAnswered, toFormQuestion, type FieldState } from './logic';
import type { AgentQuestion } from './types';

export function QuestionOverlay({
  intro,
  questions: raw,
  pulse,
  onSubmit,
}: {
  intro: string;
  questions: AgentQuestion[];
  pulse: number;
  onSubmit: (message: string, answers: Record<string, string>, skipped: string[]) => void;
}) {
  const questions = raw.map(toFormQuestion);
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const set = (id: string, patch: Partial<FieldState>) => setFields((f) => ({ ...f, [id]: { ...(f[id] ?? emptyField()), ...patch } }));
  const answered = questions.filter((q) => isAnswered(q, fields[q.id])).length;
  const skippedCount = questions.filter((q) => fields[q.id]?.skipped).length;
  const left = questions.length - answered - skippedCount;
  const groups = groupByAspect(questions);

  return (
    <div className="cv-qa-scrim">
      <form
        key={pulse}
        className={`cv-qa${pulse ? ' pulse' : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          const { message, answers } = composeReply(questions, fields);
          const skipped = questions.filter((q) => !answers[q.id]).map((q) => q.id);
          const blank = skipped.length - skippedCount;
          onSubmit(message ? `${message}${blank > 0 ? `\n\n(Left blank ${blank})` : ''}` : 'Skipped these questions.', answers, skipped);
        }}
      >
        <div className="cv-qa-head">
          <h2>A few questions to shape the campaign</h2>
          {intro && <p>{intro}</p>}
        </div>
        <div className="cv-qa-body">
          {groups.map((g) => (
            <fieldset key={g.aspect} className="cv-aspect">
              <legend>{g.aspect}</legend>
              {g.questions.map((q) => {
                const f = fields[q.id] ?? emptyField();
                return (
                  <div className={`cv-q${f.skipped ? ' skipped' : ''}`} key={q.id}>
                    <div className="cv-q-line">
                      <div className="cv-q-text">
                        {renderInline(q.text)}
                        {q.answerType === 'multi' && <span className="v2-muted"> · pick any</span>}
                      </div>
                      <button
                        type="button"
                        className="cv-q-skip"
                        title={f.skipped ? 'Answer this one after all' : 'Skip this question: the agent assumes the answer and tells you'}
                        onClick={() => set(q.id, f.skipped ? { skipped: false } : { skipped: true, picked: [], other: false, text: '' })}
                      >
                        {f.skipped ? 'Undo' : 'Skip'}
                      </button>
                    </div>
                    <div className="v2-opts" role={q.answerType === 'multi' ? 'group' : 'radiogroup'}>
                      {(q.options ?? []).map((o) => {
                        const on = f.picked.includes(o);
                        return (
                          <button
                            type="button"
                            key={o}
                            disabled={f.skipped}
                            className={`v2-opt${on ? ' on' : ''}`}
                            aria-pressed={on}
                            onClick={() =>
                              q.answerType === 'multi'
                                ? set(q.id, { picked: on ? f.picked.filter((p) => p !== o) : [...f.picked, o] })
                                : set(q.id, { picked: on ? [] : [o], other: false })
                            }
                          >
                            {o}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        disabled={f.skipped}
                        className={`v2-opt other${f.other ? ' on' : ''}`}
                        aria-pressed={f.other}
                        onClick={() => set(q.id, q.answerType === 'multi' ? { other: !f.other } : { other: !f.other, picked: [] })}
                      >
                        Other
                      </button>
                    </div>
                    {f.other && !f.skipped && <input className="v2-input" autoFocus placeholder="Type your answer" value={f.text} onChange={(e) => set(q.id, { text: e.target.value })} />}
                    {isAnswered(q, f) && q.answerType === 'multi' && <div className="v2-q-ans">→ {answerOf(q, f)}</div>}
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>
        <div className="cv-qa-foot">
          <span className="v2-muted">
            {[`${answered} answered`, skippedCount ? `${skippedCount} skipped` : '', left ? `${left} left` : ''].filter(Boolean).join(' · ')}
            {answered < questions.length ? ` · the agent will assume the ${skippedCount && left ? 'skipped and blank ones' : skippedCount ? 'skipped ones' : 'rest'} and tell you` : ''}
          </span>
          <span className="cv-qa-btns">
            <button type="button" className="cv-btn" title="The agent makes its best assumptions and tells you what it assumed" onClick={() => onSubmit('Skipped these questions.', {}, questions.map((q) => q.id))}>
              Skip all
            </button>
            <button type="submit" className="cv-btn primary" disabled={!answered && !skippedCount}>
              Send answers
            </button>
          </span>
        </div>
      </form>
    </div>
  );
}
