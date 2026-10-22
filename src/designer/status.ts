// One status vocabulary, used by both the Design page and Run Logs so the
// same campaign never reads as two different things in two places.
//
// The five states are deliberately separate. A structurally valid graph is
// not a complete configuration, and neither one makes a campaign importable —
// there is no import path at all.
import type { DesignerResponse } from './types';

export type StageKey =
  | 'design-generated'
  | 'graph-valid'
  | 'config-complete'
  | 'constraints-verified'
  | 'export-eligible';

export interface StageState {
  key: StageKey;
  label: string;
  state: 'done' | 'blocked' | 'pending' | 'partial';
  /** What this means, in the user's terms. */
  detail: string;
  /** What to do next, when this state is what blocks progress. */
  nextAction?: string;
}

const STRUCTURAL_CHECKS = ['no-open-branches', 'referential-integrity', 'fan-out-intent'];

export function campaignStages(res: DesignerResponse | null): StageState[] {
  if (!res || (!res.graph && res.stage !== 'blocked')) {
    return [
      { key: 'design-generated', label: 'Design generated', state: 'pending', detail: 'No campaign yet.' },
      { key: 'graph-valid', label: 'Journey valid', state: 'pending', detail: 'Waiting for a design.' },
      { key: 'config-complete', label: 'Configuration complete', state: 'pending', detail: 'Waiting for a design.' },
      { key: 'constraints-verified', label: 'Operational checks', state: 'pending', detail: 'Waiting for a design.' },
      { key: 'export-eligible', label: 'Ready to export', state: 'pending', detail: 'Waiting for a design.' },
    ];
  }

  const v = res.validation;
  const checks = v?.checks ?? [];
  const byId = (id: string) => checks.find((c) => c.id === id);
  const structuralFail = STRUCTURAL_CHECKS.filter((id) => byId(id)?.status === 'fail');
  const nodeConfig = byId('node-config');
  // node-config also fails for a Send that is only missing the bank's ids.
  // The server already decides whether that is the ONLY reason, and says so
  // by leaving the design exportable.
  const nodeConfigBlockedBeyondBankIds = nodeConfig?.status === 'fail' && !res.exportable;
  const campaignConfig = byId('campaign-config');
  const unresolvedSends = res.sendProposals?.length ?? 0;
  const unverified = v?.unverifiedHardConstraints ?? [];

  const designed = Boolean(res.graph && Object.keys(res.graph.nodes).length > 0);

  return [
    {
      key: 'design-generated',
      label: 'Design generated',
      state: designed ? 'done' : 'blocked',
      detail: designed
        ? `${Object.values(res.graph!.nodes).filter((n) => n.type === 'SEND').length} message step(s) in the journey.`
        : 'The agent could not produce a journey.',
      nextAction: designed ? undefined : 'Describe the objective again, or retry.',
    },
    {
      key: 'graph-valid',
      label: 'Journey valid',
      state: structuralFail.length ? 'blocked' : designed ? 'done' : 'pending',
      detail: structuralFail.length
        ? `Structural problem: ${structuralFail.join(', ')}.`
        : 'Every path connects and terminates.',
      nextAction: structuralFail.length ? 'Ask the agent to rebuild the journey.' : undefined,
    },
    {
      // Renamed from "Configuration complete". The bank's own account and
      // template ids are not part of the DESIGN — they are supplied when the
      // campaign is prepared for upload — so a design that is missing them is
      // not broken, it is unfinished for a different purpose. Showing it as a
      // red blocker next to a green "ready to export" was simply confusing.
      key: 'config-complete',
      label: 'Bank details supplied',
      state:
        nodeConfigBlockedBeyondBankIds || campaignConfig?.status === 'fail'
          ? 'blocked'
          : unresolvedSends > 0
            ? 'partial'
            : designed
              ? 'done'
              : 'pending',
      detail:
        unresolvedSends > 0
          ? `${unresolvedSends} message step(s) still need an account and template ID from your bank. The design exports without them.`
          : campaignConfig?.status === 'fail'
            ? 'Campaign-level settings are incomplete.'
            : 'All required fields are filled in.',
      nextAction: unresolvedSends > 0 ? 'Enter them below before you upload, or export the design as it is.' : undefined,
    },
    {
      key: 'constraints-verified',
      label: 'Operational checks',
      state: unverified.length ? 'partial' : designed ? 'done' : 'pending',
      detail: unverified.length
        ? `${unverified.length} not verified: ${unverified.map(friendlyConstraint).join(', ')}.`
        : 'All applicable checks verified.',
      nextAction: unverified.length ? 'These need a person to confirm before the campaign goes live.' : undefined,
    },
    {
      key: 'export-eligible',
      label: 'Design exportable',
      state: res.exportable ? 'done' : 'blocked',
      detail: res.exportable
        ? 'The design JSON can be copied or downloaded. Import readiness is not verified: the campaign builder has no JSON import, so there is no contract to check it against.'
        : res.exportBlockedReason || 'Some required information is still missing.',
      nextAction: res.exportable ? undefined : 'Complete the blocked step above.',
    },
  ];
}

/** Internal constraint ids, in words a campaign manager would use. */
export function friendlyConstraint(id: string): string {
  switch (id) {
    case 'message-spacing':
      return 'gap between messages';
    case 'quiet-hours':
      return 'quiet hours';
    case 'event-freeze':
      return 'campaign freeze dates';
    case 'message-cap':
      return 'message limit';
    case 'channel-availability':
      return 'channel availability';
    case 'maker-checker':
      return 'approval routing';
    default:
      return id.replace(/-/g, ' ');
  }
}

/**
 * The sentence an activity row shows, and the one its Details panel repeats.
 *
 * WHY THIS EXISTS AS A FUNCTION. The Details panel used to be the JSON and
 * nothing else — `<pre>{JSON.stringify(event.data)}</pre>` — so expanding a
 * row swapped a human sentence for a payload. The JSON is worth keeping (it
 * is the whole point of Details for anyone debugging a run), but it must not
 * be the only thing there: a panel that opens into raw state cannot be read
 * by the person the run is for.
 *
 * `detail` first because it is the specific thing that happened ("Recorded
 * who converts; 2 barrier(s)"), falling back to the title, which every event
 * has. Never empty, so the panel is always self-contained.
 */
export function detailsText(event: { title?: string; detail?: string; type?: string }): string {
  const detail = event.detail?.trim();
  if (detail) return detail;
  const title = event.title?.trim();
  if (title) return title;
  return event.type ? friendlyEvent(event.type) : 'No further detail recorded.';
}

/**
 * Plain-language labels for execution event types.
 *
 * A FALLBACK, not a parallel naming scheme. Events carry their own `title`,
 * written where they are emitted and specific to the turn — "Drafting the
 * plan" vs "Writing a reply" are both `model.started`, so a type-keyed map
 * cannot tell them apart. Both surfaces therefore prefer `event.title` and
 * come here only when an event has none. Keeping two maps in step by hand is
 * how the Design panel and the Logs tab came to disagree about the same run.
 */
export function friendlyEvent(type: string): string {
  const map: Record<string, string> = {
    'run.started': 'Run started',
    'run.completed': 'Run finished',
    'run.failed': 'Run failed',
    'run.cancelled': 'Cancelled',
    'context.retrieval.started': 'Gathering context',
    'context.retrieval.completed': 'Context gathered',
    'model.started': 'Agent thinking',
    'model.completed': 'Agent responded',
    'model.failed': 'Agent call failed',
    'model.tool_call.requested': 'Tool requested',
    'model.tool_call.started': 'Tool running',
    'model.tool_call.completed': 'Tool result',
    'model.tool_call.failed': 'Tool failed',
    'discovery.questions': 'Questions asked',
    'strategy.proposed': 'Strategy proposed',
    'strategy.confirmed': 'Strategy confirmed',
    'graph.generation.started': 'Building journey',
    'graph.step.created': 'Steps added',
    'graph.generation.completed': 'Journey built',
    'validation.started': 'Validating',
    'validation.completed': 'Validation result',
    export: 'Exported',
  };
  return map[type] ?? type.replace(/[._-]/g, ' ');
}
