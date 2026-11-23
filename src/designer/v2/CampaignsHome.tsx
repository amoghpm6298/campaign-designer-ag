// The Campaigns page: every campaign for this bank as a card, and the way to
// start a new one. Opening a card loads its campaign and its chat from the
// server, exactly as it was left.
import { useEffect, useState } from 'react';
import { Layers, MessageSquare, Plus, RefreshCw, Send } from 'lucide-react';
import { apiUrl } from '../api';
import type { KnowledgeBase, Tenant } from '../types';
import { DesignerV2, loadChat, type Stored } from './DesignerV2';
import { IntentModal } from './IntentModal';
import type { IntentChoice } from './intent';
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
  schedule?: { startDate: string; endDate: string } | null;
  state: CampaignState;
}

export type CampaignState = 'draft' | 'ready' | 'scheduled' | 'active' | 'ended';
export const STATES: { key: CampaignState; label: string; hint: string }[] = [
  { key: 'draft', label: 'Draft', hint: 'Being designed' },
  { key: 'ready', label: 'Ready', hint: 'Designed, not submitted' },
  { key: 'scheduled', label: 'Scheduled', hint: 'Submitted, before its start date' },
  { key: 'active', label: 'Active', hint: 'Submitted, between its dates' },
  { key: 'ended', label: 'Ended', hint: 'Submitted, after its end date' },
];
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

export function CampaignsHome({ tenant, onOpen, onCreate }: { tenant: Tenant; onOpen: (id: string) => void; onCreate: (choice: IntentChoice) => void }) {
  // "Create new campaign" first asks what the campaign is for.
  const [choosing, setChoosing] = useState(false);
  const [list, setList] = useState<CampaignSummary[] | null>(null);
  const [filter, setFilter] = useState<CampaignState | 'all'>('all');
  useEffect(() => {
    let live = true;
    setList(null);
    fetch(apiUrl(`/api/campaigns?tenantId=${encodeURIComponent(tenant.tenantId)}`))
      .then((r) => r.json())
      .then((d: { campaigns?: CampaignSummary[] }) => live && setList(d.campaigns ?? []))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [tenant.tenantId]);

  return (
    <div className="cv-home">
      {choosing && (
        <IntentModal
          tenantId={tenant.tenantId}
          onClose={() => setChoosing(false)}
          onPick={(c) => {
            setChoosing(false);
            onCreate(c);
          }}
        />
      )}
      <header className="cv-home-head">
        <div>
          <h1>Campaigns</h1>
          <p>
            {tenant.displayName}
            {list ? ` · ${list.length} campaign${list.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <button className="cv-btn primary" onClick={() => setChoosing(true)}>
          <Plus size={15} /> Create new campaign
        </button>
      </header>

      {list === null ? (
        <div className="cv-home-empty">Loading campaigns…</div>
      ) : list.length === 0 ? (
        <div className="cv-home-empty">
          <b>No campaigns yet</b>
          <p>Describe what you want customers to do, and the agent asks a few questions, then builds the campaign.</p>
          <button className="cv-btn primary" onClick={() => setChoosing(true)}>
            <Plus size={15} /> Create your first campaign
          </button>
        </div>
      ) : (
        <>
        <div className="cv-states" role="tablist">
          <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            All <span>{list.length}</span>
          </button>
          {STATES.map((s) => (
            <button key={s.key} role="tab" title={s.hint} aria-selected={filter === s.key} className={`st-${s.key}${filter === s.key ? ' on' : ''}`} onClick={() => setFilter(s.key)}>
              {s.label} <span>{list.filter((c) => c.state === s.key).length}</span>
            </button>
          ))}
        </div>
        <div className="cv-grid">
          <button className="cv-card-new" onClick={() => setChoosing(true)}>
            <Plus size={22} />
            <b>Create new campaign</b>
            <span>Start from a goal, in a sentence</span>
          </button>
          {list.filter((c) => filter === 'all' || c.state === filter).map((c) => (
            <button key={c.sessionId} className="cv-camp" onClick={() => onOpen(c.sessionId)}>
              <span className="cv-camp-top">
                <span className={`cv-camp-status st-${c.state}`}>{STATES.find((x) => x.key === c.state)?.label ?? c.state}</span>
                {c.membership && <span className="cv-camp-mode">{c.membership === 'recurring' ? `Recurring · ${c.refresh}` : 'One-time'}</span>}
              </span>
              <b className="cv-camp-name">{c.name}</b>
              <span className={`cv-camp-dates${c.schedule ? '' : ' unset'}`}>{c.schedule ? `${day(c.schedule.startDate)} → ${day(c.schedule.endDate)}` : 'Dates not set'}</span>
              {c.ask && <span className="cv-camp-ask">“{c.ask}”</span>}
              <span className="cv-camp-stats">
                <span>
                  <Layers size={13} /> {c.buckets} bucket{c.buckets === 1 ? '' : 's'}
                </span>
                <span>
                  <Send size={13} /> {c.messages} message{c.messages === 1 ? '' : 's'}
                </span>
                {c.version > 0 && (
                  <span>
                    <RefreshCw size={13} /> v{c.version}
                  </span>
                )}
              </span>
              <span className="cv-camp-when">
                <MessageSquare size={12} /> Edited {ago(c.updatedAt)}
              </span>
            </button>
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
  if (initial === undefined) return <div className="cv-home-empty">Opening the campaign…</div>;
  return <DesignerV2 key={sessionId} knowledge={knowledge} tenant={tenant} sessionId={sessionId} initial={initial} onBack={onBack} />;
}
