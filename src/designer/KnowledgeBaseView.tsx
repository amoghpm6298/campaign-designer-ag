// Knowledge Base — document management.
//
// The page is about documents the product team gives the agent. The platform
// capabilities and bank context that also feed the agent are still used, but
// they are reference material, not something to edit field by field, so they
// sit in a collapsed section rather than dominating the page.
//
// A document is only ever marked ready when its text was actually read and
// stored. Formats we cannot read in the browser are refused at selection
// rather than accepted and quietly ignored.
import { useMemo, useRef, useState } from 'react';
import { saveKnowledge, SUPPORTED_DOC_TYPES, MAX_DOC_BYTES, isSupportedDoc } from './storage';
import type { Capabilities, KnowledgeBase, KnowledgeDocument, Tenant } from './types';
import './designer.css';

interface Props {
  knowledge: KnowledgeBase;
  capabilities: Capabilities | null;
  onChange: (kb: KnowledgeBase) => void;
  onReset: () => void;
  tenant?: Tenant | null;
}

const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function KnowledgeBaseView({ knowledge, capabilities, onChange, onReset, tenant }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<'shared' | 'tenant'>('shared');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [preview, setPreview] = useState<KnowledgeDocument | null>(null);
  const [showContext, setShowContext] = useState(false);

  const docs = knowledge.documents ?? [];
  const visible = useMemo(
    () => docs.filter((d) => d.scope === 'shared' || d.scope === tenant?.tenantId),
    [docs, tenant],
  );

  const persist = (documents: KnowledgeDocument[]) => {
    const next: KnowledgeBase = { ...knowledge, version: `${knowledge.version.split('+')[0]}+docs${documents.length}`, documents };
    saveKnowledge(next);
    onChange(next);
  };

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const problems: string[] = [];
    const added: KnowledgeDocument[] = [];

    for (const file of Array.from(files)) {
      const base = {
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: file.name,
        scope: scope === 'shared' ? ('shared' as const) : (tenant?.tenantId ?? 'shared'),
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString(),
      };

      if (!isSupportedDoc(file.name)) {
        // Refused outright. Accepting a PDF and claiming it was processed
        // would be the one thing this page must never do.
        problems.push(
          `${file.name} — this format cannot be read yet. Supported: ${SUPPORTED_DOC_TYPES.join(', ')}. PDF and Word parsing is not implemented.`,
        );
        continue;
      }
      if (file.size > MAX_DOC_BYTES) {
        problems.push(`${file.name} — too large (${fmtSize(file.size)}). The limit is ${fmtSize(MAX_DOC_BYTES)}.`);
        continue;
      }
      try {
        const text = await file.text();
        if (!text.trim()) {
          problems.push(`${file.name} — the file is empty, so there is nothing for the agent to read.`);
          added.push({ ...base, status: 'failed', error: 'Empty file' });
          continue;
        }
        added.push({ ...base, status: 'ready', text });
      } catch (e) {
        problems.push(`${file.name} — could not be read: ${(e as Error).message}`);
        added.push({ ...base, status: 'failed', error: (e as Error).message });
      }
    }

    try {
      persist([...added, ...docs]);
    } catch {
      problems.push('Could not save the documents in this browser. Storage may be full.');
    }
    setErrors(problems);
    setBusy(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  const readyCount = visible.filter((d) => d.status === 'ready').length;

  return (
    <div className="cd-page">
      <div className="cd-page-head">
        <div>
          <h1>Knowledge Base</h1>
          <p className="cd-lede">
            Upload documents the agent should use as context when it designs campaigns — brand guidelines, tone of
            voice, past campaign learnings, product rules.
          </p>
        </div>
        <button className="cd-btn pri" onClick={() => fileInput.current?.click()} disabled={busy}>
          {busy ? 'Uploading…' : 'Upload documents'}
        </button>
      </div>

      <div className="cd-upload-bar">
        <label>
          Applies to
          <select value={scope} onChange={(e) => setScope(e.target.value as 'shared' | 'tenant')}>
            <option value="shared">All tenants</option>
            <option value="tenant">{tenant?.displayName ?? 'Selected tenant'} only</option>
          </select>
        </label>
        <span className="cd-hint">
          {SUPPORTED_DOC_TYPES.join(', ')} up to {fmtSize(MAX_DOC_BYTES)}. PDF and Word are not supported yet.
        </span>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={SUPPORTED_DOC_TYPES.join(',')}
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {errors.length > 0 && (
        <div className="cd-alert bad" role="alert">
          <b>{errors.length} file(s) were not added</b>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {tenant && (
        <div className="cd-alert note">
          The bank context behind this prototype — channel costs, message limits, quiet hours and the events calendar —
          is <b>synthetic sample data</b>, not {tenant.issuer}&rsquo;s real configuration. Documents you upload are
          treated as team-supplied context, not as verified bank policy.
        </div>
      )}

      {visible.length === 0 ? (
        <div className="cd-empty-panel">
          <div className="cd-empty-title">No documents yet</div>
          <p>
            The agent currently works from the platform&rsquo;s own capabilities and the sample bank context. Upload a
            document to add your own guidance — it is sent with every campaign the agent designs for{' '}
            {scope === 'shared' ? 'all tenants' : tenant?.displayName ?? 'this tenant'}.
          </p>
          <button className="cd-btn pri" onClick={() => fileInput.current?.click()}>
            Upload documents
          </button>
        </div>
      ) : (
        <>
          <div className="cd-table-meta">
            {visible.length} document{visible.length > 1 ? 's' : ''} · {readyCount} available to the agent
          </div>
          <table className="cd-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Applies to</th>
                <th>Uploaded</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className="cd-doc-name">{d.filename}</div>
                    <div className="cd-doc-sub">{fmtSize(d.sizeBytes)}</div>
                  </td>
                  <td>{d.scope === 'shared' ? 'All tenants' : (tenant?.displayName ?? d.scope)}</td>
                  <td>{fmtDate(d.uploadedAt)}</td>
                  <td>
                    {d.status === 'ready' ? (
                      <span className="cd-pill ok">Available to agent</span>
                    ) : (
                      <span className="cd-pill bad" title={d.error}>
                        Not usable
                      </span>
                    )}
                  </td>
                  <td className="cd-row-actions">
                    <button className="cd-link" onClick={() => setPreview(d)} disabled={d.status !== 'ready'}>
                      Preview
                    </button>
                    <button className="cd-link danger" onClick={() => setConfirmDelete(d.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Reference only. The agent uses these; they are not things to edit
          one field at a time, so they stay out of the way by default. */}
      <button className="cd-disclosure" onClick={() => setShowContext((v) => !v)} aria-expanded={showContext}>
        {showContext ? '▾' : '▸'} What else the agent knows
      </button>
      {showContext && (
        <div className="cd-context">
          <p className="cd-lede">
            Read from the platform and the sample bank context. Shown so you can see what the agent already has — these
            are not settings to edit here.
          </p>
          <dl className="cd-deflist">
            <dt>Message steps it can use</dt>
            <dd>{capabilities?.nodeTypes.map((n) => n.label).join(' · ') ?? '—'}</dd>
            <dt>Channels</dt>
            <dd>{capabilities?.channels.join(' · ') ?? '—'}</dd>
            <dt>Events it can trigger on</dt>
            <dd>
              {capabilities
                ? Object.entries(capabilities.eventCategories)
                    .map(([c, evs]) => `${c} (${evs.length})`)
                    .join(' · ')
                : '—'}
            </dd>
            <dt>Bank context</dt>
            <dd>
              {knowledge.entries.length} sample values — channel costs, message limits, quiet hours, campaign
              principles. Synthetic, not {tenant?.issuer ?? 'the bank'}&rsquo;s real configuration.
            </dd>
            <dt>Message templates</dt>
            <dd>
              {tenant?.templateLibraryAccess === 'unavailable'
                ? 'Your bank’s template library is not reachable from Hyperface, so the agent proposes message copy and you supply the real template IDs.'
                : 'A sample demo library is in use. Not a real bank catalogue.'}
            </dd>
          </dl>
          <button className="cd-link" onClick={onReset}>
            Reset sample context to defaults
          </button>
        </div>
      )}

      {preview && (
        <div className="cd-modal-back" onClick={() => setPreview(null)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal-h">
              <b>{preview.filename}</b>
              <button className="cd-link" onClick={() => setPreview(null)}>
                Close
              </button>
            </div>
            <pre className="cd-modal-body">{preview.text?.slice(0, 20000)}</pre>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="cd-modal-back" onClick={() => setConfirmDelete(null)}>
          <div className="cd-modal small" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal-h">
              <b>Delete this document?</b>
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 14px' }}>
              {docs.find((d) => d.id === confirmDelete)?.filename} will be removed and the agent will stop using it.
              This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="cd-btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="cd-btn danger"
                onClick={() => {
                  persist(docs.filter((d) => d.id !== confirmDelete));
                  setConfirmDelete(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
