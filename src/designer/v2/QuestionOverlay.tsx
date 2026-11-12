// The agent's questions, as an overlay on the canvas. Grouped by aspect.
// Skip: the agent assumes every answer and says what it assumed.
// Send answers: anything left blank is treated as skipped.
import { useState } from 'react';
import { answerOf, composeReply, emptyField, groupByAspect, isAnswered, type FieldState } from './logic';
import type { AgentQuestion } from './types';

export function QuestionOverlay({
  intro,
  questions,
  pulse,
  onSubmit,
}: {
  intro: string;
  questions: AgentQuestion[];
  pulse: number;
  onSubmit: (message: string, answers: Record<string, string>, skipped: string[]) => void;
}) {
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const set = (id: string, patch: Partial<FieldState>) => setFields((f) => ({ ...f, [id]: { ...(f[id] ?? emptyField()), ...patch } }));
  const answered = questions.filter((q) => isAnswered(q, fields[q.id])).length;
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
          onSubmit(message ? `${message}${skipped.length ? `\n\n(Skipped ${skipped.length})` : ''}` : 'Skipped these questions.', answers, skipped);
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
                  <div className="cv-q" key={q.id}>
                    <div className="cv-q-text">
                      {q.text}
                      <span className="v2-muted"> · {q.answerType === 'multi' ? 'pick any' : q.answerType === 'single' ? 'pick one' : 'your words'}</span>
                    </div>
                    {q.answerType !== 'open' ? (
                      <>
                        <div className="v2-opts" role={q.answerType === 'single' ? 'radiogroup' : 'group'}>
                          {(q.options ?? []).map((o) => {
                            const on = f.picked.includes(o);
                            return (
                              <button
                                type="button"
                                key={o}
                                className={`v2-opt${on ? ' on' : ''}`}
                                aria-pressed={on}
                                onClick={() =>
                                  q.answerType === 'single'
                                    ? set(q.id, { picked: on ? [] : [o], other: false })
                                    : set(q.id, { picked: on ? f.picked.filter((p) => p !== o) : [...f.picked, o] })
                                }
                              >
                                {o}
                              </button>
                            );
                          })}
                          <button
                            type="button"
                            className={`v2-opt other${f.other ? ' on' : ''}`}
                            aria-pressed={f.other}
                            onClick={() => set(q.id, q.answerType === 'single' ? { other: !f.other, picked: [] } : { other: !f.other })}
                          >
                            Other
                          </button>
                        </div>
                        {f.other && <input className="v2-input" autoFocus placeholder="Type your answer" value={f.text} onChange={(e) => set(q.id, { text: e.target.value })} />}
                      </>
                    ) : (
                      <>
                        {!!q.suggestions?.length && (
                          <div className="v2-opts">
                            {q.suggestions.map((s) => (
                              <button type="button" key={s} className="v2-opt sugg" onClick={() => set(q.id, { text: s })}>
                                {s}
                              </button>
                            ))}
                          </div>
                        )}
                        <textarea className="v2-input" rows={2} placeholder="Your answer" value={f.text} onChange={(e) => set(q.id, { text: e.target.value })} />
                      </>
                    )}
                    {isAnswered(q, f) && q.answerType === 'multi' && <div className="v2-q-ans">→ {answerOf(q, f)}</div>}
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>
        <div className="cv-qa-foot">
          <span className="v2-muted">
            {answered} of {questions.length} answered{answered < questions.length ? ' · the agent will assume the rest and tell you' : ''}
          </span>
          <span className="cv-qa-btns">
            <button type="button" className="cv-btn" title="The agent makes its best assumptions and tells you what it assumed" onClick={() => onSubmit('Skipped these questions.', {}, questions.map((q) => q.id))}>
              Skip
            </button>
            <button type="submit" className="cv-btn primary" disabled={!answered}>
              Send answers
            </button>
          </span>
        </div>
      </form>
    </div>
  );
}
