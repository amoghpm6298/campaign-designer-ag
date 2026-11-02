// The JSON Download is a drip campaign file. Buttons follow this wrapper.
//
// THE LIVE MISS: Copy/Download keyed off `exportPayload`, and the wrapper
// returned null whenever `campaign` was missing even if the canvas had a
// graph. Last Confirm often had both, so the hole stayed hidden. A graph
// with no campaign object must still download.
//
// Drip unwraps `.campaign` and needs `name` AND `root`. A `{ root }` only
// wrapper fails Import. Name comes from the last plan, or "Untitled". Bank
// fields stay empty — do not invent issuer, programs, or template ids.
import type { DripCampaign, DripGraph } from '../data/graphTypes';
import type { DesignerResponse } from './types';

export type ExportSources = {
  campaign: DripCampaign | null;
  graph: DripGraph | null;
  last: DesignerResponse | null;
  tenantId?: string;
  knowledgeVersion?: string;
};

const EMPTY_BANK = {
  issuer: '',
  programs: [] as string[],
};

function planName(last: DesignerResponse | null, campaign: DripCampaign | null): string {
  const fromCampaign = campaign?.name?.trim();
  if (fromCampaign) return fromCampaign;
  const bp = last?.blueprint as { campaignName?: string } | null | undefined;
  const fromPlan = bp?.campaignName?.trim();
  if (fromPlan) return fromPlan;
  const fromLast = last?.campaign?.name?.trim();
  if (fromLast) return fromLast;
  return 'Untitled';
}

function campaignForFile(campaign: DripCampaign | null, graph: DripGraph, last: DesignerResponse | null): DripCampaign {
  if (campaign) return { ...campaign, root: graph };
  return {
    id: last?.campaign?.id ?? 'draft',
    name: planName(last, null),
    ...EMPTY_BANK,
    goal: null,
    controlPct: 10,
    status: 'DRAFT',
    root: graph,
  };
}

/**
 * What the file is called on disk.
 *
 * THE NAME, NOT THE ID. The download read `campaign.id ?? campaign.name`, and
 * a campaign-less Confirm synthesises `id: 'draft'` — so the manager who hit
 * Download got `draft.json`, which is unrecognisable in Finder and
 * indistinguishable between two runs. `id` still travels INSIDE the JSON;
 * drip replaces it on Import. It is just not what to call the file.
 *
 * Anything that is not a letter or a number becomes a hyphen, so a name
 * carrying `₹`, a slash or a colon cannot break the download or nest it in a
 * folder. Capped so a long summary does not become the filename.
 */
export function exportFileName(payload: Record<string, unknown> | null): string {
  const campaign = (payload?.campaign ?? null) as { name?: string } | null;
  // `id` IS NOT IN THIS CHAIN AT ALL, which is what makes `draft.json`
  // unreachable rather than unlikely. `name` is guaranteed non-empty by
  // `buildExportPayload`; a real campaign carrying an empty one falls to the
  // generic word, not to whatever its id happens to be.
  const base = campaign?.name?.trim() || 'campaign';
  const safe = base
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return `${safe || 'campaign'}.json`;
}

/**
 * The Download/Copy payload, or null when there is nothing on the canvas.
 *
 * Built from `graph` even when `campaign` is null. `.campaign.root` is that
 * graph. `.campaign.name` is always a non-empty string.
 */
export function buildExportPayload(src: ExportSources): Record<string, unknown> | null {
  const graph = src.graph ?? src.campaign?.root ?? null;
  // AT LEAST ONE NODE, which is what "a graph on the canvas" means.
  //
  // This read `!graph?.rootId && !nodes.length`, so a graph carrying a
  // `rootId` and NO nodes was downloadable — a file whose root does not
  // exist. Unreachable from a live Confirm, where `res.graph` is either null
  // or a real compile, but `campaign.root` is also read here and a restored
  // session carries whatever was in storage. A hand-seeded one has
  // white-screened this app before.
  if (!Object.keys(graph?.nodes ?? {}).length) return null;
  const root = graph as DripGraph;
  const last = src.last;
  return {
    campaign: campaignForFile(src.campaign, root, last),
    campaignFieldProvenance: last?.provenance ?? null,
    unresolvedCampaignFields: last?.unresolvedCampaignFields ?? [],
    validation: last?.validation ?? null,
    strategy: last?.strategy ?? null,
    templateChoices: last?.templateChoices ?? [],
    generatedBy: { model: last?.model, knowledgeVersion: src.knowledgeVersion, tenantId: src.tenantId },
    suggestedMessaging: (last?.sendProposals ?? []).map((p) => ({
      step: p.stepName,
      channel: p.channel,
      objective: p.messagingDirection,
      suggestedCopy: p.sampleCopy,
      cta: p.cta,
      personalisationTokens: p.personalisationFields,
      status: 'draft copy, written by the agent and not yet reviewed or registered',
    })),
    importReadiness: last?.importReadiness ?? null,
    claim:
      'Proposed campaign design. Nothing here has been saved or activated, and the message copy is a draft for review.',
  };
}
