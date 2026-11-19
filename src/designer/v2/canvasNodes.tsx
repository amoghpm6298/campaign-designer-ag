// The canvas cards, in the builder's own node style (dc-node-card + cat-*
// accents from src/canvas/dripCanvas.css). Read-only: the campaign changes
// through the chat, never by clicking a card. Clicking a message opens its
// preview.
import { createContext, useContext, useState } from 'react';
import { Handle, NodeToolbar, Position } from '@xyflow/react';
import { ChevronDown, ChevronRight, Pencil, Play, Sparkles } from 'lucide-react';
import type { CostReportView, FieldSampleView, Offer, SizingRun } from './api';
import { fillFields, parseFields } from './personalFields';
import { SpendSummary } from './CostPanel';
import { withOfferLine } from './smsText';
import type { BankLink } from '../LinksSection';
import { assembleSms, smsLength } from './smsText';
import { Icon } from '../../components/icons';
import { CHANNEL_LABEL, OUTCOME_LABEL, afterText, fmtTime, fmtWait, sendTitle, sendWhen, stepRationale, waitHours, type CNodeData, type CStep } from './canvasModel';

const CHANNEL_ICON: Record<string, string> = { WHATSAPP: 'whatsapp', SMS: 'sms', EMAIL: 'mail', RCS: 'rcs', PUSH: 'message' };

export interface CdNodeData extends CNodeData {
  /** "Did they activate?" — the campaign goal, for goal checks. */
  goalText?: string;
  /** The issuer's name, for the sender line in message previews. */
  bankName?: string;
  /** The bank's link registry, to show where a message's link really goes. */
  links?: BankLink[];
  /** The bank's incentive menu, to show the exact offer line the system adds to a message. */
  offers?: Offer[];
  /** Personal fields usable in messages, with sample values, for previews. */
  fields?: FieldSampleView[];
  /** The bank's delivery setting: undelivered WhatsApp goes again by SMS. */
  smsFallback?: boolean;
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
/** Personal fields in a preview: each {{field}} shown as a chip with a sample customer's value. */
function WithFields({ text, fields }: { text: string; fields?: FieldSampleView[] }) {
  const refs = parseFields(text);
  if (!refs.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let last = 0;
  refs.forEach((r, i) => {
    if (r.index > last) out.push(text.slice(last, r.index));
    const f = fields?.find((x) => x.key === r.key);
    const shown = f?.sample || r.fallback || r.key;
    out.push(
      <span key={i} className="cv-pv-field" title={`${f?.label ?? r.key}: filled in per customer${r.fallback ? ` · if unknown: "${r.fallback}"` : ''}${f?.sample ? ` · example: ${f.sample}` : ''}`}>
        {shown}
      </span>,
    );
    last = r.index + r.raw.length;
  });
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Text with the system's offer line marked, so a reviewer sees which words came from the incentive menu, not the AI. */
function Marked({ text, offerLine, fields }: { text: string; offerLine?: string; fields?: FieldSampleView[] }) {
  const at = offerLine ? text.indexOf(offerLine) : -1;
  if (at < 0) return <WithFields text={text} fields={fields} />;
  return (
    <>
      <WithFields text={text.slice(0, at)} fields={fields} />
      <span className="cv-pv-offer" title="Added by the system from the bank's incentive menu: exact terms, never written by the AI">
        {offerLine}
      </span>
      <WithFields text={text.slice(at + offerLine!.length)} fields={fields} />
    </>
  );
}

function ChannelPreview({ channel, text, cta, bank, subject, time, link, offerLine, fields }: { channel: string; text: string; cta?: string; bank: string; subject?: string; time?: string; link?: BankLink; offerLine?: string; fields?: FieldSampleView[] }) {
  const clock = fmtClock(time);
  // No link: no button and no URL; the CTA wording, if any, stays part of the message.
  const button = link && cta ? cta : null;
  // The offer line goes in after the copy, exactly as the menu has it (like a link).
  const withOffer = withOfferLine(text, offerLine);
  const body = !link && cta ? `${withOffer} ${cta}.` : withOffer;
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
            <span className="cv-pv-text"><Marked text={body} offerLine={offerLine} fields={fields} /></span>
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
        <span className="cv-pv-text"><Marked text={body} offerLine={offerLine} fields={fields} /></span>
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
  const smsText = assembleSms(text, cta, link?.shortUrl, offerLine);
  // Counted as a typical customer's SMS (fields filled with sample values); the checks use the longest.
  const { chars, parts } = smsLength(fillFields(smsText, (r) => fields?.find((x) => x.key === r.key)?.sample));
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
              <Marked text={smsText.slice(0, urlAt)} offerLine={offerLine} fields={fields} />
              <span className="cv-pv-link" title={`Opens ${link!.url}`}>
                {link!.shortUrl}
              </span>
            </>
          ) : (
            <Marked text={smsText} offerLine={offerLine} fields={fields} />
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
function resolveCardLink(st: CStep, ch: string, links: BankLink[] | undefined, fallback?: string): { link?: BankLink; broken?: string } {
  if (!st.link) return {};
  if (!links) return {};
  const l = links.find((x) => x.ref === st.link);
  if (!l) return { broken: `Unknown link "${st.link}"` };
  if (l.status === 'retired') return { broken: `Link retired: ${l.label}` };
  if ((ch === 'SMS' || fallback === 'SMS') && !l.shortUrl) return { broken: `No SMS short link for "${l.label}"`, link: l };
  return { link: l };
}

/** Whether a step has any reasoning to show. */
export function hasRationale(st: CStep | undefined): boolean {
  // An A/B test always shows it: one that doesn't say what it tests is worth seeing too.
  return !!st && (st.kind === 'experiment' || !!st.splitIdea || !!(stepRationale(st) || st.hypothesis?.trim() || st.successMetric?.trim()));
}

/** The designer's reasoning for a step: its AI rationale; for an experiment, what it tests and how the winner is judged. */
export function RationaleBody({ st }: { st: CStep }) {
  const why = stepRationale(st);
  return (
    <div className="cv-why-body">
      {st.kind === 'experiment' && (
        <>
          <div className="cv-why-row">
            <span>Testing</span>
            <p>{st.hypothesis?.trim() || <i>Not stated yet</i>}</p>
          </div>
          <div className="cv-why-row">
            <span>Winner judged by</span>
            <p>{st.successMetric?.trim() || <i>Not stated yet</i>}</p>
          </div>
          {!!st.arms?.length && (
            <div className="cv-why-row">
              <span>Arms</span>
              <p>{st.arms.map((a) => `${a.label ?? 'Arm'} ${a.pct ?? 0}%`).join(' · ')}</p>
            </div>
          )}
        </>
      )}
      {why && <p className="cv-why-text">{why}</p>}
      {st.splitIdea?.hypothesis && (
        <div className="cv-why-row">
          <span>Split idea</span>
          <p>
            {st.splitIdea.hypothesis}
            {st.splitIdea.result ? <><br /><b>{st.splitIdea.status === 'split' ? 'Split: ' : st.splitIdea.status === 'not split' ? 'Not split: ' : ''}</b>{st.splitIdea.result}</> : <><br /><i>Being tested…</i></>}
          </p>
        </div>
      )}
      {st.kind === 'experiment' && !st.hypothesis?.trim() && !st.successMetric?.trim() && <p className="cv-why-hint">The designer hasn't written these for this test. Ask it in the chat to add them.</p>}
    </div>
  );
}

/** Inside a card: a collapsed "AI rationale" toggle. */
function RationaleToggle({ st }: { st: CStep }) {
  const [open, setOpen] = useState(false);
  if (!hasRationale(st)) return null;
  return (
    <>
      <button
        type="button"
        className="cv-bucket-why cv-step-why nodrag nopan"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} AI rationale
      </button>
      {open && <RationaleBody st={st} />}
    </>
  );
}

/** Beside a drawn shape (wait, test, branch, condition): an "AI rationale" pill that opens a panel next to it. */
function RationalePill({ st }: { st: CStep }) {
  const [open, setOpen] = useState(false);
  const api = useContext(EditContext);
  if (!hasRationale(st)) return null;
  return (
    <>
      <button
        type="button"
        className={`cv-why-link nodrag nopan${open ? ' on' : ''}`}
        title="Why the designer put this here"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} AI rationale
      </button>
      <NodeToolbar isVisible={open && !api?.editingId} position={Position.Right} offset={12} className="nodrag nopan nowheel">
        <div className="cv-why-panel" onClick={(e) => e.stopPropagation()}>
          <header>
            <b>
              <Sparkles size={12} /> AI rationale
            </b>
            <button className="cv-icon-btn" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </header>
          <RationaleBody st={st} />
        </div>
      </NodeToolbar>
    </>
  );
}

function SendCard({ data }: { data: CdNodeData }) {
  const st = data.step as CStep;
  const ch = (st.channelPreference ?? [])[0] ?? 'SMS';
  const fb = st.fallbackChannel;
  // Delivery fallback is the bank's setting; a card only mentions one that is an exception to it.
  const policyFb = data.smsFallback !== false && (ch === 'WHATSAPP' || ch === 'RCS') ? 'SMS' : undefined;
  const exception = !!fb && fb !== policyFb;
  const linkState = resolveCardLink(st, ch, data.links, fb ?? policyFb);
  const offer = st.incentive ? data.offers?.find((o) => o.id === st.incentive) : undefined;
  return (
    <Card cat="send" icon={CHANNEL_ICON[ch] ?? 'paperplane'} type={`Send · ${CHANNEL_LABEL[ch] ?? ch}`} data={data} extra="cv-clickable" title="Open the message preview">
      <div className="dc-node-label">{sendTitle({ ...st, name: st.name || st.label })}</div>
      {linkState.broken && <div className="cv-link-bad" title={linkState.broken}>⚠ {linkState.broken}</div>}
      {st.incentive && (offer ? (
        <OfferBadge label={offer.label} terms={offer.terms} stepId={st.id} />
      ) : (
        <div className="cv-link-bad">⚠ Unknown offer "{st.incentive}"</div>
      ))}
      {(st.copy || st.describe) && (
        <ChannelPreview channel={ch} text={st.copy || st.describe || ''} cta={st.cta} bank={data.bankName ?? 'Your bank'} subject={st.name || st.label} time={st.atTime} link={linkState.link} offerLine={offer?.offerLine} fields={data.fields} />
      )}
      {/* Timing only when it says something the flow doesn't: a send time or a delay of its own. */}
      {!!(st.atTime || st.delayDays) && (
        <div className="dc-node-send-row">
          <Icon name="clock" />
          <span>{st.delayDays ? sendWhen(st, data.path) : `At ${fmtTime(st.atTime)}`}</span>
        </div>
      )}
      {exception && fb && (
        <div className="dc-node-send-row dc-node-fallback-row">
          <span className="dc-node-fallback-arrow">↳</span>
          <Icon name={CHANNEL_ICON[fb] ?? 'sms'} />
          <span>{CHANNEL_LABEL[fb] ?? fb} if not delivered</span>
        </div>
      )}
      {st.splitIdea?.hypothesis && (
        <div className={`cv-split-chip ${st.splitIdea.status === 'not split' ? 'no' : st.splitIdea.status === 'split' ? 'yes' : 'wait'}`} title={`${st.splitIdea.hypothesis}${st.splitIdea.result ? `\n\n${st.splitIdea.result}` : ''}`}>
          💡 Split idea · {st.splitIdea.status === 'not split' ? 'tested: not split' : st.splitIdea.status === 'split' ? 'split' : 'testing…'}
        </div>
      )}
      <RationaleToggle st={st} />
    </Card>
  );
}

function BucketCard({ data }: { data: CdNodeData }) {
  const b = data.bucket!;
  // Execution (name, holdout, journey) comes from the campaign object; the
  // reasoning and size come from the context.
  const info = data.info ?? {};
  const [why, setWhy] = useState(false);
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
      {/* Who is in it first, then how many, then why (on demand). */}
      {info.behaviour && <p className="cv-bucket-who">{info.behaviour}</p>}
      <div className="cv-bucket-meta">
        {size}
        {b.holdoutPct ? ` · ${b.holdoutPct}% held back to measure` : ''}
      </div>
      <SpendLine bucketId={b.id} />
      {info.rationale && (
        <>
          <button
            type="button"
            className="cv-bucket-why nodrag nopan"
            aria-expanded={why}
            onClick={(e) => {
              e.stopPropagation();
              setWhy((v) => !v);
            }}
          >
            {why ? <ChevronDown size={13} /> : <ChevronRight size={13} />} AI rationale
          </button>
          {why && <p className="cv-bucket-p">{info.rationale}</p>}
        </>
      )}
      {info.sql && <BucketSql bucketId={b.id} sql={info.sql} />}
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
function Diamond({ data, color, fill, icon, kind, children, aside }: { data: CdNodeData; color: string; fill: string; icon: string; kind: string; children: React.ReactNode; aside?: React.ReactNode }) {
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
      {aside}
    </div>
  );
}

/** A split (experiment or holdout), drawn as a hexagon: it divides people, it doesn't ask a question. */
function Hexagon({ data, color, fill, icon, kind, children, aside }: { data: CdNodeData; color: string; fill: string; icon: string; kind: string; children: React.ReactNode; aside?: React.ReactNode }) {
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
      {aside}
    </div>
  );
}

/** "20 Nov 2026" from "2026-11-20". */
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

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
          <SpendLine />
          <div className={`cv-entry-dates${c?.schedule ? '' : ' unset'}`}>{c?.schedule ? `Runs ${fmtDay(c.schedule.startDate)} → ${fmtDay(c.schedule.endDate)}` : 'Campaign dates: not set'}</div>
          <div className="dc-node-meta">
            {m?.type === 'open'
              ? `New matching customers join every ${m.refresh === 'daily' ? 'day' : m.refresh === 'monthly' ? 'month' : 'week'}. Nobody re-enters while their journey is running.`
              : m
                ? 'The list is fixed at launch. Nobody new joins.'
                : ''}
          </div>
          <div className="dc-node-meta">Each customer goes into the first bucket they match, left to right.</div>
          {m?.type === 'open' && (
            <div className="cv-after">
              <span className="cv-after-h">After the journey</span>
              {(['no_response', 'not_reachable', 'declined', 'converted'] as const).map((k) => (
                <span key={k} className={`cv-after-row out-${k}`}>
                  <i />
                  {OUTCOME_LABEL[k]}: {afterText(c, k).replace('what happens next: ', '')}
                </span>
              ))}
              <span className={`cv-after-stop${c?.maxAttempts ? '' : ' unset'}`}>
                {c?.maxAttempts
                  ? `Stops after ${c.maxAttempts} time${c.maxAttempts === 1 ? '' : 's'} through: then everyone leaves for good.`
                  : 'Stopping rule not set: a customer could go through again and again.'}
              </span>
            </div>
          )}
          <div className="dc-node-meta cv-optout">STOP or unsubscribe: leaves every campaign, never messaged again.</div>
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
          <p className="cv-bucket-p">{ee ? (ee.approach === 'journey' ? 'Get their own journey' : 'Get no messages. Checked against the buckets again at every refresh') : 'Not decided yet'}{data.why ? `: ${data.why}` : ''}</p>
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
          <div className="cv-shape-label">{data.holdoutPct}% held back</div>
          <div className="cv-shape-meta">Never messaged by this campaign</div>
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
        <div className={`cv-chip-node cv-wait cv-wait-box${data.changed ? ' cv-shape-changed' : ''}`} style={{ width: data.width }}>
          <div className="cv-wait-row">
            <Icon name="clock" />
            <span>{fmtWait(waitHours(st))}</span>
          </div>
          <RationaleToggle st={st} />
        </div>
      );
      break;
    case 'waitForEvent':
      body = (
        <div className={`cv-chip-node cv-wait cv-wait-box${data.changed ? ' cv-shape-changed' : ''}`} style={{ width: data.width }}>
          <div className="cv-wait-row">
            <Icon name="bolt" />
            <span>
              Until {(st as { eventType?: string }).eventType ?? 'the event'}
              {st.timeoutDays ? ` · up to ${st.timeoutDays} days` : ''}
            </span>
          </div>
          <RationaleToggle st={st} />
        </div>
      );
      break;
    case 'branch':
      body = (
        <Diamond data={data} color="#c98a12" fill="#fffaf0" icon="split3" kind={st.signal ? 'Switch' : 'Branch'}>
          <div className="cv-shape-label">{st.label || (st.signal ? `By ${st.signal.replace(/_/g, ' ')}` : 'What did they do with the last message?')}</div>
          {st.signal && <span className="cv-proposed" title="Routing on this signal is designed and checked, but the engine can't run it yet.">proposed</span>}
          <RationalePill st={st} />
        </Diamond>
      );
      break;
    case 'experiment':
      body = (
        <Hexagon data={data} color="#7a52d1" fill="#f9f6ff" icon="flask" kind="A/B test">
          <div className="cv-shape-label">{st.label || 'Which version works better?'}</div>
          <RationalePill st={st} />
        </Hexagon>
      );
      break;
    case 'condition':
      body = (
        <Diamond data={data} color="#c98a12" fill="#fffaf0" icon="split2" kind="Condition">
          <div className="cv-shape-label">{st.label || 'Condition'}</div>
          <RationalePill st={st} />
        </Diamond>
      );
      break;
    default:
      body = (
        <div
          className={`cv-chip-node cv-end out-${data.outcome ?? 'undecided'}`}
          style={{ width: data.width, height: data.height }}
          title={data.outcome === 'undecided' ? 'The agent has not decided how customers leave here yet.' : `${data.text}${data.after ? ` · ${data.after}` : ''}`}
        >
          <Icon name="doorExit" />
          <span className="cv-end-txt">
            <b>{data.outcome && data.outcome !== 'undecided' ? OUTCOME_LABEL[data.outcome] ?? data.outcome : 'Ending not decided'}</b>
            {data.after ? <span className="cv-end-next"> · {data.after}</span> : null}
          </span>
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
/** The campaign's potential spend on offers, and how to open its working. */
export const CostContext = createContext<{ report: CostReportView | null; open: (bucketId?: string) => void } | null>(null);

const inrS = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);

/** The offer on a message: its name, and on demand who qualifies and what it may cost (from the cost calculator). */
function OfferBadge({ label, terms, stepId }: { label: string; terms: string; stepId?: string }) {
  const [open, setOpen] = useState(false);
  const cost = useContext(CostContext);
  const line = stepId ? cost?.report?.lines.find((l) => l.stepId === stepId) : undefined;
  const per = cost?.report?.mode === 'perThousand';
  return (
    <div className="cv-offer">
      <span className="cv-offer-badge" title={terms}>
        🎁 Offer: {label}
      </span>
      <button
        type="button"
        className="cv-offer-more nodrag nopan"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {open ? 'Hide details' : 'Details'}
      </button>
      {open && (
        <div className="cv-offer-details" onClick={(e) => e.stopPropagation()}>
          <div>
            <i>Terms</i> {terms}
          </div>
          {line ? (
            <>
              <div>
                <i>Who qualifies</i>{' '}
                {per
                  ? 'not counted (no data access)'
                  : line.qualified != null && line.customers
                    ? `${line.qualified.toLocaleString('en-IN')} of ${line.customers.toLocaleString('en-IN')} (${Math.round((100 * line.qualified) / line.customers)}%)`
                    : 'not counted yet'}
              </div>
              <div>
                <i>May cost{per ? ' (per 1,000)' : ''}</i> as expected {inrS(line.expected)} · max {inrS(line.max)}
              </div>
              {line.engineOnly.length > 0 && (
                <div>
                  <i>Also checked by the engine</i> {line.engineOnly.join(' ')}
                </div>
              )}
            </>
          ) : (
            <div className="cv-muted">The cost appears once the campaign is built.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** A potential-spend line that opens the working when tapped. Shown only when the campaign has offers. */
function SpendLine({ bucketId }: { bucketId?: string }) {
  const cost = useContext(CostContext);
  const r = cost?.report;
  if (!r || r.mode === 'none') return null;
  const t = bucketId ? r.buckets.find((b) => b.bucketId === bucketId) : r.total;
  if (!t) return null;
  return (
    <button
      type="button"
      className="cv-spendline nodrag nopan"
      title="See the working behind these numbers"
      onClick={(e) => {
        e.stopPropagation();
        cost!.open(bucketId);
      }}
    >
      <span className="cv-spendline-h">Potential spend on offers{r.mode === 'perThousand' ? ' · per 1,000 customers' : ''}</span>
      <SpendSummary under={t.under} expected={t.expected} max={t.max} compact />
      {!bucketId && r.budgetCap != null && <span className="cv-spendline-cap">Budget cap ₹{r.budgetCap.toLocaleString('en-IN')}</span>}
    </button>
  );
}
/** Runs a bucket's saved sizing query again; null where it can't (view-only links). */
export const SizingContext = createContext<((bucketId: string) => Promise<SizingRun>) | null>(null);

/** The SQL that sized a bucket, and a button to run it again now. */
function BucketSql({ bucketId, sql }: { bucketId: string; sql: string }) {
  const run = useContext(SizingContext);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SizingRun | null>(null);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      <button type="button" className="cv-bucket-why nodrag nopan" aria-expanded={open} onClick={(e) => (stop(e), setOpen((v) => !v))}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} SQL query
      </button>
      {open && (
        <div className="cv-sql nodrag nopan nowheel" onClick={stop}>
          <pre className="cv-sql-code">{sql.trim()}</pre>
          {run && (
            <button
              type="button"
              className="cv-sql-run"
              disabled={busy}
              onClick={async (e) => {
                stop(e);
                setBusy(true);
                setRes(await run(bucketId));
                setBusy(false);
              }}
            >
              <Play size={11} strokeWidth={2.5} /> {busy ? 'Running…' : res ? 'Run again' : 'Run SQL'}
            </button>
          )}
          {res && !res.ok && <div className="cv-sql-err">{res.error}</div>}
          {res?.ok && (
            <div className="cv-sql-res">
              <div className="cv-sql-count">
                <b>{(res.size ?? 0).toLocaleString('en-IN')} customers</b> now
                {typeof res.savedSize === 'number' && (res.savedSize === res.size ? ' · matches the saved size' : ` · saved size was ${res.savedSize.toLocaleString('en-IN')}`)}
                {` · ${res.ms} ms`}
                {res.dataAsOf ? ` · data up to ${res.dataAsOf}` : ''}
              </div>
              {!!res.rows?.length && (
                <div className="cv-sql-table">
                  <table>
                    <thead>
                      <tr>{res.columns!.map((c) => <th key={c}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {res.rows.map((r, i) => (
                        <tr key={i}>{res.columns!.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="cv-sql-note">First {res.rows.length} of {(res.size ?? 0).toLocaleString('en-IN')}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

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
          <Pencil size={12} strokeWidth={2.5} /> Edit
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
