/**
 * The prompt each phase actually receives.
 *
 * WHY THIS EXISTS. Seventeen test files carried the same copy of this:
 *
 *     const s = readFileSync('../../server/orchestrator.ts', 'utf8');
 *     return /const SYSTEM = `([\s\S]*?)`;\n/.exec(s)![1];
 *
 * — a regex over the server's source, reaching for one giant constant. That
 * constant is gone: there are three manuals now, one per phase, and `ready`
 * and `build` are no longer the same string. A pin that asserts a rule has to
 * name the turn the rule is for, because "it is somewhere in the prompt" stops
 * being a meaningful claim once the prompt differs by phase.
 *
 * These call the real `systemForPhase`, so a pin reads what the model reads
 * rather than what the file happens to contain.
 */
import { systemForPhase, stickyForPhase } from '../../../server/orchestrator.ts';

/** Discovery: the record is open and nothing is being designed. */
export const asking = () => systemForPhase('asking');
/** Plan and Revise: one string, because the manual's own heading covers both. */
export const ready = () => systemForPhase('ready');
/** Confirm: compile the approved path. */
export const build = () => systemForPhase('build');

/** How to write this turn. It rides the end of `systemForPhase`, not the
 *  context message — see that function's own note for the round-two defect
 *  that moved it. */
export const sticky = stickyForPhase;

/**
 * For a rule that is genuinely phase-neutral — the voice, the ban on invented
 * numbers, the ground rules. Asserting on this says "every turn is told
 * this", which is a stronger claim than any single phase.
 */
export const everyPhase = () => [asking(), ready(), build()];
