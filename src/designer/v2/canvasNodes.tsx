// The canvas cards, in the builder's own node style (dc-node-card + cat-*
// accents from src/canvas/dripCanvas.css). Read-only: the campaign changes
// through the chat, never by clicking a card. Clicking a message opens its
// preview.
import { createContext, useContext } from 'react';
import { Handle, NodeToolbar, Position } from '@xyflow/react';
import { Pencil } from 'lucide-react';
import type { BankLink } from '../LinksSection';
import { assembleSms, smsLength } from './smsText';
import { Icon } from '../../components/icons';
import { CHANNEL_LABEL, fmtWait, sendTitle, sendWhen, waitHours, type CNodeData, type CStep } from './canvasModel';

const CHANNEL_ICON: Record<string, string> = { WHATSAPP: 'whatsapp', SMS: 'sms', EMAIL: 'mail', RCS: 'rcs', PUSH: 'message' };

export interface CdNodeData extends CNodeData {
  /** "Did they activate?" — the campaign goal, for goal checks. */
  goalText?: string;
  /** The issuer's name, for the sender line in message previews. */
  bankName?: string;
  /** The bank's link registry, to show where a message's link really goes. */
  links?: BankLink[];
  width: number;
  /** Fixed height for the drawn shapes (diamonds, hexagons, pills). */
  height?: number;
}

const EVIDENCE: Record<string, string> = { measured: 'From data', manager: 'You said', hypothesis: 'Hypothesis' };

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const ordinal = (i: number) => ORDINAL[i] ?? `${i + 1}th`;

const titleCase = (s: string) => s[0].toUpperCase() + s.slice(1);

function Changed({ on, knock }: { on?: boolean; knock?: boolean }) {
  return on ? <span className={`cv-changed-tag${knock ? ' knock' : ''}`}>{knock ? 'Changed as a result' : 'Changed'}</span> : null;
}

const CHANGE_STROKE = (d: CdNodeData) => (d.changeKind === 'knock' ? '#b54708' : '#027a48');

/** In at the top; out at the bottom, or at the left / right corner when a decision has several routes. */
function Handles(_: { sideways?: boolean }) {
  return (
    <>
      <Handle type="target" position={Position.Top} className="cv-handle" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="cv-handle" isConnectable={false} />
      <Handle id="sl" type="source" position={Position.Left} className="cv-handle" isConnectable={false} />
      <Handle id="sr" type="source" position={Position.Right} className="cv-handle" isConnectable={false} />
    </>
  );
}

function Card({ cat, type, icon, children, data, extra, title }: { cat: string; type: React.ReactNode; icon: string; children?: React.ReactNode; data: CdNodeData; extra?: string; title?: string }) {
  return (
    <div className={`dc-node-card size-standard cat-${cat} cv-card${data.changed ? ' cv-is-changed' : ''}${extra ? ` ${extra}` : ''}`} style={{ width: data.width }} title={title}>
      <div className="dc-node-type">
        <Icon name={icon} />
        <span>{type}</span>
        <Changed on={data.changed} knock={data.changeKind === 'knock'} />
      </div>
      {children}
    </div>
  );
}

/** "AD-INDBNK": the kind of sender id an Indian bank's SMS shows. */
const smsSender = (bank: string) => `AD-${bank.replace(/bank|ltd|limited|\(.*?\)/gi, '').replace(/[^a-z]/gi, '').toUpperCase().slice(0, 6).padEnd(4, 'X')}`;

/** The message drawn the way the customer sees it on that channel. */
function ChannelPreview({ channel, text, cta, bank, subject, time, link }: { channel: string; text: string; cta?: string; bank: string; subject?: string; time?: string; link?: BankLink }) {
  const clock = fmtClock(time);
  // No link: no button and no URL; the CTA wording, if any, stays part of the message.
  const button = link && cta ? cta : null;
  const body = !link && cta ? `${text} ${cta}.` : text;
  if (channel === 'WHATSAPP' || channel === 'RCS') {
    return (
      <div className={`cv-pv cv-pv-wa${channel === 'RCS' ? ' rcs' : ''}`}>
        <div className="cv-pv-wa-head">
          <span className="cv-pv-avatar">{bank.slice(0, 1)}</span>
          <span className="cv-pv-wa-name">
            {bank} <span className="cv-pv-tick" title="Verified business">✓</span>
          </span>
        </div>
        <div className="cv-pv-wa-body">
          <div className="cv-pv-wa-bubble">
            <span className="cv-pv-text">{body}</span>
            <span className="cv-pv-meta">{clock}</span>
          </div>
          {button && (
            <div className="cv-pv-wa-btn" title={`Opens ${link!.url}`}>
              ↗ {button}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (channel === 'EMAIL') {
    return (
      <div className="cv-pv cv-pv-mail">
        <div className="cv-pv-mail-from">
          <span className="cv-pv-avatar">{bank.slice(0, 1)}</span>
          <span>
            <b>{bank}</b>
            <span className="cv-pv-mail-to">to you · {clock}</span>
          </span>
        </div>
        {subject && <div className="cv-pv-mail-subject">{subject}</div>}
        <span className="cv-pv-text">{body}</span>
        {button && (
          <span className="cv-pv-mail-btn" title={`Opens ${link!.url}`}>
            {button}
          </span>
        )}
      </div>
    );
  }
  // SMS (and anything else): a plain text thread. SMS has no buttons: the link
  // is written out at the end, as the customer's phone will show it.
  const smsText = assembleSms(text, cta, link?.shortUrl);
  const { chars, parts } = smsLength(smsText);
  const urlAt = link?.shortUrl ? smsText.lastIndexOf(link.shortUrl) : -1;
  return (
    <div className="cv-pv cv-pv-sms">
      <div className="cv-pv-sms-head">
        <span className="cv-pv-sms-sender">{smsSender(bank)}</span>
        <span>Text message · {clock}</span>
      </div>
      <div className="cv-pv-sms-bubble">
        <span className="cv-pv-text">
          {urlAt >= 0 ? (
            <>
              {smsText.slice(0, urlAt)}
              <span className="cv-pv-link" title={`Opens ${link!.url}`}>
                {link!.shortUrl}
              </span>
            </>
          ) : (
            smsText
          )}
        </span>
      </div>
      <div className={`cv-pv-count${parts > 1 ? ' over' : ''}`}>
        {parts} SMS · {chars} chars{parts > 1 ? ' — over 160, sent as ' + parts + ' parts' : ''}
      </div>
    </div>
  );
}

const fmtClock = (t?: string) => {
  const [h, m] = (t || '11:00').split(':').map(Number);
  return `${(h % 12) || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

/** Where a message's link goes, from the registry; or why it can't be sent. */
function resolveCardLink(st: CStep, ch: string, links: BankLink[] | undefined): { link?: BankLink; broken?: string } {
  if (!st.link) return {};
  if (!links) return {};
  const l = links.find((x) => x.ref === st.link);
  if (!l) return { broken: `Unknown link "${st.link}"` };
  if (l.status === 'retired') return { broken: `Link retired: ${l.label}` };
  if ((ch === 'SMS' || st.fallbackChannel === 'SMS') && !l.shortUrl) return { broken: `No SMS short link for "${l.label}"`, link: l };
  return { link: l };
}

function SendCard({ data }: { data: CdNodeData }) {
  const st = data.step as CStep;
  const ch = (st.channelPreference ?? [])[0] ?? 'SMS';
  const linkState = resolveCardLink(st, ch, data.links);
  const fb = st.fallbackChannel;
  return (
    <Card cat="send" icon={CHANNEL_ICON[ch] ?? 'paperplane'} type={`Send · ${CHANNEL_LABEL[ch] ?? ch}`} data={data} extra="cv-clickable" title="Open the message preview">
      <div className="dc-node-label">{sendTitle({ ...st, name: st.name || st.label })}</div>
      {linkState.broken && <div className="cv-link-bad" title={linkState.broken}>⚠ {linkState.broken}</div>}
      {(st.copy || st.describe) && (
        <ChannelPreview channel={ch} text={st.copy || st.describe || ''} cta={st.cta} bank={data.bankName ?? 'Your bank'} subject={st.name || st.label} time={st.atTime} link={linkState.link} />
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

/** An SVG path for a polygon with rounded corners. */
function rounded(points: [number, number][], r: number): string {
  const n = points.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const [px, py] = points[(i - 1 + n) % n];
    const [cx, cy] = points[i];
    const [nx, ny] = points[(i + 1) % n];
    const toward = (ax: number, ay: number) => {
      const len = Math.hypot(ax - cx, ay - cy) || 1;
      const k = Math.min(r, len / 2) / len;
      return [cx + (ax - cx) * k, cy + (ay - cy) * k];
    };
    const [sx, sy] = toward(px, py);
    const [ex, ey] = toward(nx, ny);
    d += `${i === 0 ? 'M' : 'L'}${sx},${sy} Q${cx},${cy} ${ex},${ey} `;
  }
  return `${d}Z`;
}

/** A decision, drawn as a soft diamond so it reads as a question from far away. */
function Diamond({ data, color, fill, icon, kind, children }: { data: CdNodeData; color: string; fill: string; icon: string; kind: string; children: React.ReactNode }) {
  const w = data.width;
  const h = data.height ?? 110;
  return (
    <div className={`cv-shape${data.changed ? ' cv-shape-changed' : ''}`} style={{ width: w, height: h }}>
      <svg className="cv-shape-bg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <path d={rounded([[w / 2, 2], [w - 2, h / 2], [w / 2, h - 2], [2, h / 2]], 14)} fill={fill} stroke={data.changed ? CHANGE_STROKE(data) : `color-mix(in srgb, ${color} 45%, white)`} strokeWidth={data.changed ? 2.5 : 1.25} />
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
        <path d={rounded([[c, 2], [w - c, 2], [w - 2, h / 2], [w - c, h - 2], [c, h - 2], [2, h / 2]], 10)} fill={fill} stroke={data.changed ? CHANGE_STROKE(data) : `color-mix(in srgb, ${color} 45%, white)`} strokeWidth={data.changed ? 2.5 : 1.25} />
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

function CdNodeBody({ data }: { data: CdNodeData }) {
  const st = (data.step ?? {}) as CStep;
  let body: React.ReactNode;
  switch (data.kind) {
    case 'entry': {
      const c = data.campaign;
      const m = c?.membership;
      body = (
        <Card cat="entry" icon="users" data={data} type={<>Entry · who can join <span className="dc-node-start-tag">START</span></>}>
          <div className="dc-node-label">{c?.description || c?.name || 'Eligible customers'}</div>
          <div className="cv-entry-mode">
            <span className={`cv-mode-tag ${m?.type === 'open' ? 'rec' : m ? 'once' : 'none'}`}>{m ? (m.type === 'open' ? `Recurring · ${titleCase(m.refresh ?? 'weekly')}` : 'One-time') : 'One-time or recurring: not decided'}</span>
            {c?.goal && <span className="dc-node-meta">Success: {c.goal.eventType}</span>}
          </div>
          <div className="dc-node-meta">
            {m?.type === 'open'
              ? `New matching customers join every ${m.refresh === 'daily' ? 'day' : m.refresh === 'monthly' ? 'month' : 'week'}. Nobody re-enters while their journey is running.`
              : m
                ? 'The list is fixed at launch. Nobody new joins.'
                : ''}
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
        <Hexagon data={data} color="#7a52d1" fill="#f9f6ff" icon="flask" kind="Holdout">
          <div className="cv-shape-label">{data.holdoutPct}% get no messages</div>
        </Hexagon>
      );
      break;
    case 'send':
      body = <SendCard data={data} />;
      break;
    case 'goalcheck':
      body = (
        <Diamond data={data} color="#4b4fb8" fill="#f4f5fe" icon="targetCheck" kind="Goal check">
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
        <Diamond data={data} color="#c98a12" fill="#fffaf0" icon="split3" kind="Branch">
          <div className="cv-shape-label">{st.label || 'What did they do with the last message?'}</div>
        </Diamond>
      );
      break;
    case 'experiment':
      body = (
        <Hexagon data={data} color="#7a52d1" fill="#f9f6ff" icon="flask" kind="A/B test">
          <div className="cv-shape-label">{st.label || 'Which version works better?'}</div>
        </Hexagon>
      );
      break;
    case 'condition':
      body = (
        <Diamond data={data} color="#c98a12" fill="#fffaf0" icon="split2" kind="Condition">
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

/** What the canvas lends every box for point-and-edit. */
export interface EditApi {
  /** The canvas node being edited, if any. */
  editingId: string | null;
  /** Read-only (viewing an old version, or the agent is working). */
  locked: boolean;
  onEdit: (nodeId: string, data: CdNodeData) => void;
  renderPopover: (nodeId: string, data: CdNodeData) => React.ReactNode;
}
export const EditContext = createContext<EditApi | null>(null);

/** Every box: the drawn shape, an edit pencil on hover, and the edit popover beside it when focused. */
export function CdNode({ id, data }: { id: string; data: CdNodeData }) {
  const api = useContext(EditContext);
  const editing = api?.editingId === id;
  const dimmed = !!api?.editingId && !editing;
  const canEdit = !!data.focus && !api?.locked;
  return (
    <div className={`cv-node${editing ? ' cv-editing' : ''}${dimmed ? ' cv-dimmed' : ''}${data.changeKind === 'knock' ? ' cv-knock' : ''}`}>
      <CdNodeBody data={data} />
      {canEdit && !editing && (
        <button
          className="cv-pencil nodrag nopan"
          title="Change this"
          aria-label="Change this"
          onClick={(e) => {
            e.stopPropagation();
            api!.onEdit(id, data);
          }}
        >
          <Pencil size={12} />
        </button>
      )}
      {editing && <span className="cv-editing-tag">Editing</span>}
      {api && (
        <NodeToolbar isVisible={editing} position={Position.Right} offset={16} className="nodrag nopan nowheel">
          {editing ? api.renderPopover(id, data) : null}
        </NodeToolbar>
      )}
    </div>
  );
}

export const cdNodeTypes = { cd: CdNode };
