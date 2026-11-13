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
  /** Fixed height for the drawn shapes (diamonds, hexagons, pills). */
  height?: number;
}

const EVIDENCE: Record<string, string> = { measured: 'From data', manager: 'You said', hypothesis: 'Hypothesis' };

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const ordinal = (i: number) => ORDINAL[i] ?? `${i + 1}th`;

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
        <div className="cv-preview">
          <div className="cv-preview-text">
            {st.copy || st.describe}
            {st.cta && <b className="cv-preview-cta"> {st.cta} ›</b>}
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
        <span>Bucket {(data.bucketIndex ?? 0) + 1} · checked {ordinal(data.bucketIndex ?? 0)}</span>
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

/** A decision, drawn as a diamond so it reads as a question from far away. */
function Diamond({ data, color, fill, icon, kind, children }: { data: CdNodeData; color: string; fill: string; icon: string; kind: string; children: React.ReactNode }) {
  const w = data.width;
  const h = data.height ?? 110;
  return (
    <div className={`cv-shape${data.changed ? ' cv-shape-changed' : ''}`} style={{ width: w, height: h }}>
      <svg className="cv-shape-bg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <polygon points={`${w / 2},2 ${w - 2},${h / 2} ${w / 2},${h - 2} 2,${h / 2}`} fill={fill} stroke={data.changed ? '#027a48' : color} strokeWidth={data.changed ? 3 : 1.5} strokeLinejoin="round" />
      </svg>
      <div className="cv-shape-text" style={{ maxWidth: w * 0.56, color }}>
        <span className="cv-shape-kind">
          <Icon name={icon} />
          {kind}
        </span>
        {children}
      </div>
    </div>
  );
}

/** A split (experiment or holdout), drawn as a hexagon: it divides people, it doesn't ask a question. */
function Hexagon({ data, color, fill, icon, kind, children }: { data: CdNodeData; color: string; fill: string; icon: string; kind: string; children: React.ReactNode }) {
  const w = data.width;
  const h = data.height ?? 70;
  const c = h / 2.4;
  return (
    <div className={`cv-shape${data.changed ? ' cv-shape-changed' : ''}`} style={{ width: w, height: h }}>
      <svg className="cv-shape-bg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <polygon points={`${c},2 ${w - c},2 ${w - 2},${h / 2} ${w - c},${h - 2} ${c},${h - 2} 2,${h / 2}`} fill={fill} stroke={data.changed ? '#027a48' : color} strokeWidth={data.changed ? 3 : 1.5} strokeLinejoin="round" />
      </svg>
      <div className="cv-shape-text" style={{ maxWidth: w - 2 * c - 8, color }}>
        <span className="cv-shape-kind">
          <Icon name={icon} />
          {kind}
        </span>
        {children}
      </div>
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
          <div className="dc-node-meta">Each customer goes into the first bucket they match, left to right.</div>
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
        <Card cat="flow" icon="users" data={data} type="Everyone else · if no bucket matches">
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
        <Hexagon data={data} color="#6941c6" fill="#f6f1ff" icon="flask" kind="Holdout">
          <div className="cv-shape-label">{data.holdoutPct}% get no messages</div>
        </Hexagon>
      );
      break;
    case 'send':
      body = <SendCard data={data} />;
      break;
    case 'goalcheck':
      body = (
        <Diamond data={data} color="#4b4fb8" fill="#eef0fd" icon="targetCheck" kind="Goal check">
          <div className="cv-shape-label">{data.goalText ?? 'Reached the goal?'}</div>
          <div className="cv-shape-meta">Yes → exit</div>
        </Diamond>
      );
      break;
    case 'wait':
      body = (
        <div className={`cv-chip-node cv-wait${data.changed ? ' cv-shape-changed' : ''}`} style={{ width: data.width, height: data.height }}>
          <Icon name="clock" />
          <span>{fmtWait(waitHours(st))}</span>
        </div>
      );
      break;
    case 'waitForEvent':
      body = (
        <div className={`cv-chip-node cv-wait${data.changed ? ' cv-shape-changed' : ''}`} style={{ width: data.width, height: data.height }}>
          <Icon name="bolt" />
          <span>
            Until {(st as { eventType?: string }).eventType ?? 'the event'}
            {st.timeoutDays ? ` · up to ${st.timeoutDays} days` : ''}
          </span>
        </div>
      );
      break;
    case 'branch':
      body = (
        <Diamond data={data} color="#e0a020" fill="#fff8e6" icon="split3" kind="Branch">
          <div className="cv-shape-label">{st.label || 'What did they do with the last message?'}</div>
        </Diamond>
      );
      break;
    case 'experiment':
      body = (
        <Hexagon data={data} color="#6941c6" fill="#f6f1ff" icon="flask" kind="A/B test">
          <div className="cv-shape-label">{st.label || 'Which version works better?'}</div>
        </Hexagon>
      );
      break;
    case 'condition':
      body = (
        <Diamond data={data} color="#e0a020" fill="#fff8e6" icon="split2" kind="Condition">
          <div className="cv-shape-label">{st.label || 'Condition'}</div>
        </Diamond>
      );
      break;
    default:
      body = (
        <div className="cv-chip-node cv-end" style={{ width: data.width, height: data.height }} title={data.text || 'Journey ends'}>
          <Icon name="doorExit" />
          <span>{data.text || 'Journey ends'}</span>
        </div>
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
