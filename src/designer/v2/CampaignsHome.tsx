// The Campaigns page: every campaign for this bank as a card, and the way to
// start a new one. Opening a card loads its campaign and its chat from the
// server, exactly as it was left.
import { useEffect, useState } from 'react';
import { Layers, MessageSquare, Plus, RefreshCw, Send } from 'lucide-react';
import { apiUrl } from '../api';
import type { KnowledgeBase, Tenant } from '../types';
import { DesignerV2, loadChat, type Stored } from './DesignerV2';
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
}

const ago = (iso: string) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

export function CampaignsHome({ tenant, onOpen, onCreate }: { tenant: Tenant; onOpen: (id: string) => void; onCreate: () => void }) {
  const [list, setList] = useState<CampaignSummary[] | null>(null);
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
      <header className="cv-home-head">
        <div>
          <h1>Campaigns</h1>
          <p>
            {tenant.displayName}
            {list ? ` · ${list.length} campaign${list.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <button className="cv-btn primary" onClick={onCreate}>
          <Plus size={15} /> Create new campaign
        </button>
      </header>

      {list === null ? (
        <div className="cv-home-empty">Loading campaigns…</div>
      ) : list.length === 0 ? (
        <div className="cv-home-empty">
          <b>No campaigns yet</b>
          <p>Describe what you want customers to do, and the agent asks a few questions, then builds the campaign.</p>
          <button className="cv-btn primary" onClick={onCreate}>
            <Plus size={15} /> Create your first campaign
          </button>
        </div>
      ) : (
        <div className="cv-grid">
          <button className="cv-card-new" onClick={onCreate}>
            <Plus size={22} />
            <b>Create new campaign</b>
            <span>Start from a goal, in a sentence</span>
          </button>
          {list.map((c) => (
            <button key={c.sessionId} className="cv-camp" onClick={() => onOpen(c.sessionId)}>
              <span className="cv-camp-top">
                <span className={`cv-camp-status ${c.built ? 'built' : 'draft'}`}>{c.built ? 'Built' : 'Draft'}</span>
                {c.membership && <span className="cv-camp-mode">{c.membership === 'recurring' ? `Recurring · ${c.refresh}` : 'One-time'}</span>}
              </span>
              <b className="cv-camp-name">{c.name}</b>
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
