// The Flows page and the Campaigns page: every flow (always on) or one-time
// campaign for this bank as a card, and the way to start a new one. One
// component, filtered by kind. Opening a card loads its campaign and its chat from the
// server, exactly as it was left.
import { useEffect, useState } from 'react';
import { Calendar, MessageSquare, Plus, Repeat, Route, X } from 'lucide-react';
import { apiUrl } from '../api';
import type { KnowledgeBase, Tenant } from '../types';
import { DesignerV2, loadChat, type Stored } from './DesignerV2';
import { IntentModal, LOOK } from './IntentModal';
import { intentLabel, type CampaignIntent, type IntentChoice } from './intent';
import { KIND_LABEL, KIND_PLURAL, type CampaignKind } from './kind';
import './v2.css';

export interface CampaignSummary {
  sessionId: string;
  tenantId: string;
  name: string;
  ask: string;
  built: boolean;
  buckets: number;
  messages: number;
  membership: 'one-time' | 'recurring' | null;
  refresh?: string;
  version: number;
  updatedAt: string;
  submitted?: { at: string; by: string; startDate?: string; endDate?: string };
  schedule?: { startDate: string; endDate?: string } | null;
  state: CampaignState;
  /** Flow (always on) or campaign (one-time). */
  kind?: CampaignKind;
  /** A flow converted from a campaign. */
  origin?: { fromId: string; fromName: string };
  /** A campaign that became flows. */
  convertedTo?: { toId: string; toName: string }[];
  /** What it is for; campaigns from before intents read as "other". */
  intent?: CampaignIntent;
}

export type CampaignState = 'draft' | 'scheduled' | 'active' | 'ended' | 'stopped';
/** The states each kind can be in, in order. A flow never ends by itself; it is live until stopped. */
export const STATES_BY_KIND: Record<CampaignKind, { key: CampaignState; label: string; hint: string }[]> = {
  flow: [
    { key: 'draft', label: 'Draft', hint: 'Not live yet' },
    { key: 'scheduled', label: 'Scheduled', hint: 'Goes live on its start date' },
    { key: 'active', label: 'Live', hint: 'Running: new customers join as they become eligible' },
    { key: 'stopped', label: 'Stopped', hint: 'Was live and has been stopped' },
  ],
  campaign: [
    { key: 'draft', label: 'Draft', hint: 'Not submitted yet' },
    { key: 'scheduled', label: 'Scheduled', hint: 'Submitted, before its start date' },
    { key: 'active', label: 'Active', hint: 'Submitted, between its dates' },
    { key: 'ended', label: 'Ended', hint: 'Submitted, after its end date' },
  ],
};
/** Every state, for pages that show both kinds. */
export const STATES = [...STATES_BY_KIND.campaign, STATES_BY_KIND.flow[3]];
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const ago = (iso: string) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

export function CampaignsHome({ tenant, kind, onOpen, onCreate }: { tenant: Tenant; kind: CampaignKind; onOpen: (id: string) => void; onCreate: (choice: IntentChoice) => void }) {
  const noun = KIND_LABEL[kind].toLowerCase();
  const states = STATES_BY_KIND[kind];
  // "New flow" / "New campaign" first asks what it is for.
  const [choosing, setChoosing] = useState(false);
  const [list, setList] = useState<CampaignSummary[] | null>(null);
  const [filter, setFilter] = useState<CampaignState | 'all'>('all');
  // Tapping a card's intent tab shows only that intent; tapping it again shows all.
  const [intentFilter, setIntentFilter] = useState<CampaignIntent | null>(null);
  const toggleIntent = (k: CampaignIntent) => setIntentFilter((cur) => (cur === k ? null : k));
  useEffect(() => {
    let live = true;
    setList(null);
    fetch(apiUrl(`/api/campaigns?tenantId=${encodeURIComponent(tenant.tenantId)}`))
      .then((r) => r.json())
      .then((d: { campaigns?: CampaignSummary[] }) => live && setList((d.campaigns ?? []).filter((c) => (c.kind ?? 'campaign') === kind)))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [tenant.tenantId, kind]);

  const inIntent = (list ?? []).filter((c) => !intentFilter || (c.intent ?? 'other') === intentFilter);
  return (
    <div className="cv-home">
      {choosing && (
        <IntentModal
          tenantId={tenant.tenantId}
          kind={kind}
          onClose={() => setChoosing(false)}
          onPick={(c) => {
            setChoosing(false);
            onCreate({ ...c, kind });
          }}
        />
      )}
      <header className="cv-home-head">
        <div>
          <h1 className="cv-home-title">
            {/* A four-point star: draws the eye, and hints at the AI behind the page. */}
            <svg className="cv-spark" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 0 L15.2 8.8 L24 12 L15.2 15.2 L12 24 L8.8 15.2 L0 12 L8.8 8.8 Z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="0.6" />
            </svg>
            {KIND_PLURAL[kind]}
          </h1>
          <p>
            {tenant.displayName}
            {list ? ` · ${list.length} ${noun}${list.length === 1 ? '' : 's'}` : ''}
            {' · '}
            {kind === 'flow' ? 'Always on: customers join as they become eligible' : 'One-time: a fixed list, between two dates'}
          </p>
        </div>
        <button className="cv-btn primary" onClick={() => setChoosing(true)}>
          <Plus size={15} /> New {noun}
        </button>
      </header>

      {list === null ? (
        <div className="cv-home-empty">Loading {noun}s…</div>
      ) : list.length === 0 ? (
        <div className="cv-home-empty">
          <b>No {noun}s yet</b>
          <p>
            {kind === 'flow'
              ? 'A flow runs all the time: say who should join and what they should do, and the designer builds it.'
              : 'A campaign is a one-time push between two dates: say what you want customers to do, and the designer builds it.'}
          </p>
          <button className="cv-btn primary" onClick={() => setChoosing(true)}>
            <Plus size={15} /> Create your first {noun}
          </button>
        </div>
      ) : (
        <>
        <div className="cv-states" role="tablist">
          <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            All <span>{inIntent.length}</span>
          </button>
          {states.map((s) => (
            <button key={s.key} role="tab" title={s.hint} aria-selected={filter === s.key} className={`st-${s.key}${filter === s.key ? ' on' : ''}`} onClick={() => setFilter(s.key)}>
              {s.label} <span>{inIntent.filter((c) => c.state === s.key).length}</span>
            </button>
          ))}
          {intentFilter && (() => {
            const { Icon } = LOOK[intentFilter];
            return (
              <button className="cv-intent-filter" onClick={() => setIntentFilter(null)} title="Show every intent" aria-label={`Showing ${intentLabel(intentFilter, kind)} only. Clear.`}>
                <Icon size={13} aria-hidden="true" /> {intentLabel(intentFilter, kind)} <X size={13} aria-hidden="true" />
              </button>
            );
          })()}
        </div>
        {/* One grid; each card carries its intent as a small tab on its top edge. */}
        <div className="cv-grid cv-grid-tabbed">
          {inIntent
            .filter((c) => filter === 'all' || c.state === filter)
            .map((c) => (
              <CampaignCard key={c.sessionId} c={c} kind={kind} onOpen={onOpen} onIntent={toggleIntent} intentOn={!!intentFilter} />
            ))}
        </div>
        </>
      )}
    </div>
  );
}

/** Loads a campaign's chat from the server, then opens it. */
export function CampaignView({ knowledge, tenant, sessionId, onBack }: { knowledge: KnowledgeBase; tenant: Tenant; sessionId: string; onBack: () => void }) {
  const [initial, setInitial] = useState<Stored | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setInitial(undefined);
    loadChat(sessionId).then((c) => live && setInitial(c));
    return () => {
      live = false;
    };
  }, [sessionId]);
  if (initial === undefined) return <div className="cv-home-empty">Opening…</div>;
  return <DesignerV2 key={sessionId} knowledge={knowledge} tenant={tenant} sessionId={sessionId} initial={initial} onBack={onBack} />;
}

function CampaignCard({ c, kind, onOpen, onIntent, intentOn }: { c: CampaignSummary; kind: CampaignKind; onOpen: (id: string) => void; onIntent: (k: CampaignIntent) => void; intentOn: boolean }) {
  return (
    <button className="cv-camp" onClick={() => onOpen(c.sessionId)}>
      {(() => {
        const key = (c.intent ?? 'other') as CampaignIntent;
        const { Icon } = LOOK[key] ?? LOOK.other;
        return (
          <span
            className={`cv-camp-tab${intentOn ? ' on' : ''}`}
            role="button"
            tabIndex={0}
            title={intentOn ? 'Show every intent' : `Show only ${intentLabel(key, kind)}`}
            onClick={(e) => {
              e.stopPropagation();
              onIntent(key);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              onIntent(key);
            }}
          >
            <Icon size={12} aria-hidden="true" />
            {intentLabel(key, kind)}
          </span>
        );
      })()}
      <span className="cv-camp-top">
        <span className={`cv-camp-status st-${c.state}`}>{STATES_BY_KIND[kind].find((x) => x.key === c.state)?.label ?? c.state}</span>
      </span>
      <b className="cv-camp-name">{c.name}</b>
      {c.ask && <span className="cv-camp-ask">“{c.ask}”</span>}
      {c.origin && (
        <span className="cv-camp-lineage">
          <Route size={12} aria-hidden="true" /> From the campaign {c.origin.fromName}
        </span>
      )}
      {!!c.convertedTo?.length && (
        <span className="cv-camp-lineage">
          <Route size={12} aria-hidden="true" /> Now a flow{c.convertedTo.length > 1 ? `: ${c.convertedTo.length} flows` : `: ${c.convertedTo[0].toName}`}
        </span>
      )}
      <span className={`cv-camp-stats cv-camp-when-row${c.schedule ? '' : ' unset'}`}>
        <Calendar size={13} aria-hidden="true" />
        {kind === 'flow'
          ? c.schedule
            ? `${c.state === 'active' ? 'Live since' : c.state === 'scheduled' ? 'Starts' : 'From'} ${day(c.schedule.startDate)}`
            : 'Start date not set'
          : c.schedule?.endDate
            ? `${day(c.schedule.startDate)} → ${day(c.schedule.endDate)}`
            : 'Dates not set'}
        {kind === 'flow' && (
          <span className="cv-camp-recur" title={`New customers join ${c.refresh ?? 'weekly'}`} aria-label={`New customers join ${c.refresh ?? 'weekly'}`}>
            <Repeat size={12} /> {c.refresh ?? 'weekly'}
          </span>
        )}
      </span>
      <span className="cv-camp-when">
        <MessageSquare size={12} /> Edited {ago(c.updatedAt)}
      </span>
    </button>
  );
}
