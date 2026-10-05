import { useState } from 'react';
import { Icon, Chevron } from './icons';
import './sidebar.css';

// Ported from journeysnudgesemi/emi-conversions-prototype.html's NAV
// array + renderNav(). The real prototype has no URL-based routing at
// all (it's all in-page JS state, switchPage()) — this app's sidebar
// needs real deep links, so the prototype itself was given a small
// ?page=<name> deep-link entry point (see initDeepLink() there) that
// jumps straight to a specific nav page on load. Every item below that
// carries a real `page` key in the original NAV links to
// `/?page=<page>`; items with no `page` in the real NAV (Home, Issuers,
// Atlas Console, etc.) are inert there too — not a gap specific to this
// build, matched here on purpose rather than inventing a link.
type NavItem = { type: 'item'; icon: string; label: string; page?: string; tag?: string; ext?: boolean };
type NavSubItem = { label: string; page?: string; tag?: string };
type NavSubmenu = { type: 'submenu'; icon: string; label: string; open?: boolean; children: NavSubItem[] };
type NavHeading = { type: 'heading'; label: string };
type NavEntry = NavItem | NavSubmenu | NavHeading;

const NAV: NavEntry[] = [
  { type: 'item', icon: 'home', label: 'Home' },
  { type: 'item', icon: 'building', label: 'Issuers' },
  { type: 'item', icon: 'users', label: 'Clients' },
  { type: 'heading', label: 'Insights Center' },
  { type: 'submenu', icon: 'chart', label: 'Analytics', children: [{ label: 'OnboardIQ Analytics' }, { label: 'Offer Analytics' }, { label: 'EMI Analytics', page: 'analytics', tag: 'NEW' }] },
  { type: 'item', icon: 'search', label: 'HyperQuery' },
  { type: 'heading', label: 'Product Setup' },
  { type: 'submenu', icon: 'sliders', label: 'Program Management', children: [{ label: 'Programs' }, { label: 'Themes' }, { label: 'Playground' }] },
  { type: 'submenu', icon: 'wrench', label: 'Program Tools', children: [{ label: 'Authorization Rule' }, { label: 'Program Simulator' }, { label: 'Transaction Enrichment' }] },
  { type: 'item', icon: 'compass', label: 'OnboardIQ Journeys' },
  { type: 'heading', label: 'Portfolio-growth' },
  { type: 'submenu', icon: 'gift', label: 'Offers', children: [{ label: 'Manage Offers' }, { label: 'Offer plans' }, { label: 'Voucher Inventory' }, { label: 'Spend Analytics' }] },
  { type: 'submenu', icon: 'workflow', label: 'Journeys', children: [{ label: 'Batch Creation', page: 'jb-list' }, { label: 'A/B Experimentation', page: 'ab-list' }] },
  {
    type: 'submenu',
    icon: 'message',
    label: 'Communication Hub',
    open: true,
    children: [
      { label: 'Nudges', page: 'nudges-list' },
      { label: 'Comms. Templates', page: 'comms-list' },
      { label: 'DNC', page: 'dnc' },
      { label: 'Drip Campaigns', page: 'drip-list', tag: 'NEW' },
    ],
  },
  { type: 'heading', label: 'Operations' },
  { type: 'submenu', icon: 'idcard', label: 'OnboardIQ', children: [{ label: 'Applications' }, { label: 'Operations' }] },
  { type: 'item', icon: 'file', label: 'Reports' },
  { type: 'item', icon: 'user', label: 'Customers' },
  { type: 'item', icon: 'wallet', label: 'Budgeting' },
  { type: 'item', icon: 'repeat', label: 'Transactions' },
  { type: 'item', icon: 'award', label: 'Manual Reward Posting' },
  { type: 'item', icon: 'card', label: 'EMI Conversions', page: 'emi', tag: 'NEW' },
  { type: 'item', icon: 'external', label: 'Atlas Console', ext: true },
  { type: 'heading', label: 'Support Tools' },
  { type: 'item', icon: 'tag', label: 'Smart Tag' },
  { type: 'item', icon: 'database', label: 'Query Templates' },
  { type: 'item', icon: 'landmark', label: 'Funding Account' },
  { type: 'item', icon: 'sigma', label: 'Aggregate Definitions' },
  { type: 'item', icon: 'list', label: 'Lists' },
  { type: 'item', icon: 'calc', label: 'Custom Variables' },
];

function goTo(page?: string) {
  if (!page) return;
  window.location.href = `/?page=${page}`;
}

export function Sidebar() {
  const [openSubmenus, setOpenSubmenus] = useState<Set<string>>(new Set(['Communication Hub']));

  function toggleSub(label: string) {
    setOpenSubmenus((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <div id="sidebar">
      <div className="sb-header">
        <div className="sb-logo">HF</div>
      </div>
      <div className="sb-nav">
        {NAV.map((n, i) => {
          if (n.type === 'heading') return <div className="sb-heading" key={i}>{n.label}</div>;
          if (n.type === 'item') {
            return (
              <div className="sb-item" key={i} onClick={() => goTo(n.page)} style={{ cursor: n.page ? 'pointer' : 'default' }}>
                <span className="sb-icon"><Icon name={n.icon} /></span>
                {n.label}
                {n.tag && <span className="sb-new-tag">{n.tag}</span>}
                {n.ext && <span className="sb-ext"><Icon name="external" /></span>}
              </div>
            );
          }
          const isOpen = openSubmenus.has(n.label);
          return (
            <div key={i}>
              <div className={`sb-item ${isOpen ? 'open' : ''}`} onClick={() => toggleSub(n.label)}>
                <span className="sb-icon"><Icon name={n.icon} /></span>
                {n.label}
                <span className="sb-chev"><Chevron /></span>
              </div>
              <div className={`sb-sub ${isOpen ? 'open' : ''}`}>
                {n.children.map((c, j) => {
                  const isDrip = c.label === 'Drip Campaigns';
                  return (
                    <div
                      key={j}
                      className={`sb-sub-item ${isDrip ? 'active' : ''}`}
                      onClick={isDrip ? undefined : () => goTo(c.page)}
                      style={{ cursor: isDrip ? 'default' : c.page ? 'pointer' : 'default' }}
                    >
                      {c.label}
                      {c.tag && <span className="sb-new-tag">{c.tag}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
