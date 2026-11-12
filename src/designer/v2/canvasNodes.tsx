// The canvas cards, in the builder's own node style (dc-node-card + cat-*
// accents from src/canvas/dripCanvas.css). Read-only: the campaign changes
// through the chat, never by clicking a card. Clicking a message opens its
// preview.
import { Handle, Position } from '@xyflow/react';
import { Icon } from '../../components/icons';
import { CHANNEL_LABEL, fmtWait, sendTitle, sendWhen, waitHours, type CNodeData, type CStep } from './canvasModel';

const CHANNEL_ICON: Record<string, string> = { WHATSAPP: 'whatsapp', SMS: 'sms', EMAIL: 'mail', RCS: 'rcs', PUSH: 'message' };

export interface CdNodeData extends CNodeData {
  /** "Did they activate?" — the campaign goal, for goal checks. */
  goalText?: string;
  width: number;
}

const EVIDENCE: Record<string, string> = { measured: 'From data', manager: 'You said', hypothesis: 'Hypothesis' };

function Changed({ on }: { on?: boolean }) {
  return on ? <span className="cv-changed-tag">Changed in chat</span> : null;
}

function Handles({ sideways }: { sideways?: boolean }) {
  return (
    <>
      <Handle type="target" position={Position.Top} className="cv-handle" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="cv-handle" isConnectable={false} />
      {sideways && (
        <>
          <Handle id="l" type="target" position={Position.Left} className="cv-handle" isConnectable={false} />
          <Handle id="r" type="source" position={Position.Right} className="cv-handle" isConnectable={false} />
        </>
      )}
    </>
  );
}

function Card({ cat, type, icon, children, data, extra, title }: { cat: string; type: React.ReactNode; icon: string; children?: React.ReactNode; data: CdNodeData; extra?: string; title?: string }) {
  return (
    <div className={`dc-node-card size-standard cat-${cat} cv-card${data.changed ? ' cv-is-changed' : ''}${extra ? ` ${extra}` : ''}`} style={{ width: data.width }} title={title}>
      <div className="dc-node-type">
        <Icon name={icon} />
        <span>{type}</span>
        <Changed on={data.changed} />
      </div>
      {children}
    </div>
  );
}

function SendCard({ data }: { data: CdNodeData }) {
  const st = data.step as CStep;
  const ch = (st.channelPreference ?? [])[0] ?? 'SMS';
  const fb = st.fallbackChannel;
  return (
    <Card cat="send" icon={CHANNEL_ICON[ch] ?? 'paperplane'} type={`Send · ${CHANNEL_LABEL[ch] ?? ch}`} data={data} extra="cv-clickable" title="Open the message preview">
      <div className="dc-node-label">{sendTitle({ ...st, name: st.name || st.label })}</div>
      {(st.copy || st.describe) && (
        <div className="cv-msg">
          <div className="cv-msg-text">
            {st.copy || st.describe}
            {st.cta && <b className="cv-msg-cta"> {st.cta} ›</b>}
          </div>
        </div>
      )}
      <div className="dc-node-send-row">
        <Icon name="clock" />
        <span>{sendWhen(st)}</span>
      </div>
      <div className="dc-node-send-row">
        <Icon name="file" />
        <span>Bank template id needed</span>
      </div>
      {fb && (
        <div className="dc-node-send-row dc-node-fallback-row">
          <span className="dc-node-fallback-arrow">↳</span>
          <Icon name={CHANNEL_ICON[fb] ?? 'sms'} />
          <span>{CHANNEL_LABEL[fb] ?? fb} if not delivered</span>
        </div>
      )}
    </Card>
  );
}

function BucketCard({ data }: { data: CdNodeData }) {
  const b = data.bucket!;
  // Execution (name, holdout, journey) comes from the campaign object; the
  // reasoning and size come from the context.
  const info = data.info ?? {};
  const evidence = info.evidence ?? 'hypothesis';
  const size =
    typeof info.size === 'number'
      ? `${info.size.toLocaleString('en-IN')} customers`
      : info.sizeError
        ? 'Not sized'
        : evidence === 'measured'
          ? 'Sizing…'
          : 'Size unknown (no data warehouse)';
  return (
    <div className={`dc-node-card size-standard cv-card cv-bucket ev-${evidence}`} style={{ width: data.width }}>
      <div className="dc-node-type">
        <Icon name="users" />
        <span>Bucket {(data.bucketIndex ?? 0) + 1} · who goes here</span>
        <span className={`cv-ev ${evidence}`}>{EVIDENCE[evidence]}</span>
      </div>
      <div className="dc-node-label cv-bucket-name">{b.name}</div>
      <div className="cv-bucket-meta">
        {size}
        {b.holdoutPct ? ` · ${b.holdoutPct}% held back to measure` : ''}
      </div>
      {info.behaviour && <p className="cv-bucket-p">{info.behaviour}</p>}
      {info.thesis && (
        <p className="cv-bucket-p">
          <b>Why they're stuck: </b>
          {info.thesis}
        </p>
      )}
      {!b.journey?.length && <div className="cv-bucket-pending">Journey not designed yet</div>}
    </div>
  );
}

export function CdNode({ data }: { data: CdNodeData }) {
  const st = (data.step ?? {}) as CStep;
  let body: React.ReactNode;
  switch (data.kind) {
    case 'entry': {
      const c = data.campaign;
      const m = c?.membership;
      body = (
        <Card cat="entry" icon="users" data={data} type={<>Entry · who can join <span className="dc-node-start-tag">START</span></>}>
          <div className="dc-node-label">{c?.description || c?.name || 'Eligible customers'}</div>
          <div className="dc-node-meta">
            {m ? (m.type === 'open' ? `New matching customers join ${m.refresh ?? 'weekly'}` : 'Buckets fixed at launch') : 'Membership not decided yet'}
            {c?.goal ? ` · Success: ${c.goal.eventType}` : ''}
          </div>
        </Card>
      );
      break;
    }
    case 'bucket':
      return (
        <>
          <Handles sideways />
          <BucketCard data={data} />
        </>
      );
    case 'everyone': {
      const ee = data.campaign?.everyoneElse;
      body = (
        <Card cat="flow" icon="users" data={data} type="Everyone else">
          <div className="dc-node-label">Customers who match no bucket</div>
          <p className="cv-bucket-p">{ee ? (ee.approach === 'journey' ? 'Get their own journey' : 'Get no messages') : 'Not decided yet'}{data.why ? `: ${data.why}` : ''}</p>
        </Card>
      );
      return (
        <>
          <Handles sideways />
          {body}
        </>
      );
    }
    case 'holdout':
      body = (
        <Card cat="experiment" icon="flask" data={data} type="Holdout">
          <div className="dc-node-label">{data.holdoutPct}% get no messages</div>
          <div className="dc-node-meta">So this bucket's journey can be measured against doing nothing</div>
        </Card>
      );
      break;
    case 'send':
      body = <SendCard data={data} />;
      break;
    case 'goalcheck':
      body = (
        <Card cat="goalcheck" icon="targetCheck" data={data} type="Goal check">
          <div className="dc-node-label">{data.goalText ?? 'Reached the goal?'} → exits as goal reached</div>
        </Card>
      );
      break;
    case 'wait':
      body = (
        <Card cat="flow" icon="clock" data={data} type="Wait">
          <div className="dc-node-label">{fmtWait(waitHours(st))}</div>
        </Card>
      );
      break;
    case 'waitForEvent':
      body = (
        <Card cat="flow" icon="bolt" data={data} type="Wait for event">
          <div className="dc-node-label">Until {(st as { eventType?: string }).eventType ?? 'the event'}</div>
          {st.timeoutDays ? <div className="dc-node-meta">Up to {st.timeoutDays} days</div> : null}
        </Card>
      );
      break;
    case 'branch':
      body = (
        <Card cat="split" icon="split3" data={data} type="Branch">
          <div className="dc-node-label">{st.label || 'What did they do with the last message?'}</div>
          <div className="dc-node-meta">{(st.paths ?? []).map((p) => p.label).join(' · ')} · anything else</div>
        </Card>
      );
      break;
    case 'experiment':
      body = (
        <Card cat="experiment" icon="flask" data={data} type="Experiment · A/B test">
          <div className="dc-node-label">{st.label || 'Which version works better?'}</div>
          <div className="dc-node-meta">Split at random: {(st.arms ?? []).map((a) => `${a.label} ${a.pct ?? ''}%`).join(' vs ')}</div>
        </Card>
      );
      break;
    case 'condition':
      body = (
        <Card cat="split" icon="split2" data={data} type="Condition">
          <div className="dc-node-label">{st.label || 'Condition'}</div>
        </Card>
      );
      break;
    default:
      body = (
        <Card cat="exit" icon="doorExit" data={data} type="Exit">
          <div className="dc-node-label">{data.text || 'Journey ends'}</div>
        </Card>
      );
  }
  return (
    <>
      <Handles />
      {body}
    </>
  );
}

export const cdNodeTypes = { cd: CdNode };
