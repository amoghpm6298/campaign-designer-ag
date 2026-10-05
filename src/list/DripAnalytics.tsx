// Per-campaign analytics — the annotated canvas itself is the funnel
// (see the UX-rebuild plan's Part 3), not a separate linear chart, since
// a branching campaign can't be represented honestly as one column.
import { useMemo } from 'react';
import type { DripCampaign } from '../data/graphTypes';
import { generateDripAnalytics } from '../data/dripAnalytics';
import { DripCanvas } from '../canvas/DripCanvas';

function fmt(n: number): string {
  return n.toLocaleString('en-IN');
}

export function DripAnalytics({ campaign }: { campaign: DripCampaign }) {
  const data = useMemo(() => generateDripAnalytics(campaign), [campaign]);
  const { totals, metrics } = data;

  return (
    <div>
      <div className="kpi-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ margin: 0, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--gray-500)', marginBottom: 6 }}>Entered</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmt(totals.entered)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 3 }}>{fmt(totals.control)} held back (Control)</div>
        </div>
        <div className="card" style={{ margin: 0, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--gray-500)', marginBottom: 6 }}>Reached Goal</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--success-text)' }}>{fmt(totals.reachedGoal)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 3 }}>across the whole sequence</div>
        </div>
        <div className="card" style={{ margin: 0, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--gray-500)', marginBottom: 6 }}>Conversion Rate</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--success-text)' }}>{(totals.conversionRate * 100).toFixed(1)}%</div>
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 3 }}>of entered, not of resolved</div>
        </div>
        <div className="card" style={{ margin: 0, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--gray-500)', marginBottom: 6 }}>Still In Sequence</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmt(totals.stillActive)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--gray-500)', marginTop: 3 }}>{campaign.status === 'KILLED' ? 'everyone force-exited' : 'waiting on a later step'}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, height: '65vh', border: '1px solid var(--gray-200)', borderRadius: 10, overflow: 'hidden' }}>
        <DripCanvas graph={campaign.root!} editable={false} metrics={metrics} />
      </div>
    </div>
  );
}
