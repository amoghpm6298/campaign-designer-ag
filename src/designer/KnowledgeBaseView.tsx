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
import { fmtDate } from './time';
import { groupKnowledge, docsForAgent } from '../data/knowledgeShape';
import { useMemo, useRef, useState } from 'react';
import { SUPPORTED_DOC_TYPES, MAX_DOC_BYTES, isSupportedDoc } from './storage';
import {
  addEntry,
  changeCount,
  isUserAdded,
  removeEntry,
  revertEntry,
  seedValue,
  setDocuments,
  setEntryValue,
  type KnowledgeOverrides,
} from './knowledgeStore';
import type { Capabilities, KnowledgeBase, KnowledgeDocument, Tenant } from './types';
import './designer.css';

interface Props {
  /** The seed with the user's changes already applied. What the agent reads. */
  knowledge: KnowledgeBase;
  /** The untouched seed, so an edited entry can show what it said before. */
  seed: KnowledgeBase | null;
  overrides: KnowledgeOverrides;
  capabilities: Capabilities | null;
  onOverrides: (o: KnowledgeOverrides) => void;
  onReset: () => void;
  tenant?: Tenant | null;
}

const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
// Dates come from the shared IST formatter, not from the viewer's machine.

export function KnowledgeBaseView({ knowledge, seed, overrides, capabilities, onOverrides, onReset, tenant }: Props) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');

  /**
   * Every category the seed knows, whether or not it currently has entries.
   *
   * THE DEAD END THIS FIXES: `groupKnowledge` only emits a category that HAS
   * entries, and "Add" lived inside a group header. So removing the last entry
   * in a category made that category unreachable — no header, no Add — and a
   * brand-new category could never be created at all. Emptying a section was
   * a one-way door.
   */
  const allCategories = useMemo(
    () => [...new Set([...(seed?.entries ?? []).map((e) => e.category), ...knowledge.entries.map((e) => e.category)])].sort(),
    [seed, knowledge],
  );

  const startAdd = (category: string) => {
    setAdding(category || 'new');
    setNewCategory(category);
    setNewLabel('');
    setNewValue('');
  };
  const AddForm = () => (
    <div className="cd-kb-add">
      <label className="cd-kb-addrow">
        <span>Section</span>
        <input
          value={newCategory}
          list="hf-kb-categories"
          placeholder="Pick one, or type a new section"
          onChange={(e) => setNewCategory(e.target.value)}
        />
      </label>
      <datalist id="hf-kb-categories">
        {allCategories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <input value={newLabel} autoFocus placeholder="What is it called?" onChange={(e) => setNewLabel(e.target.value)} />
      <textarea
        value={newValue}
        rows={2}
        placeholder="What should the agent know?"
        onChange={(e) => setNewValue(e.target.value)}
      />
      <div className="cd-know-actions">
        <button
          className="cd-btn pri sm"
          disabled={!newCategory.trim() || !newLabel.trim() || !newValue.trim()}
          onClick={commitAdd}
        >
          Add
        </button>
        <button className="cd-link" onClick={() => setAdding(null)}>
          Cancel
        </button>
      </div>
    </div>
  );

  const commitAdd = () => {
    if (!newCategory.trim() || !newLabel.trim() || !newValue.trim()) return;
    onOverrides(addEntry(overrides, { category: newCategory.trim(), label: newLabel.trim(), value: newValue.trim() }));
    setAdding(null);
  };
  const fileInput = useRef<HTMLInputElement>(null);

  // EDITING, which the data model always supported and the screen never did.
  // `editedAt` exists on every entry and the prompt renders [USER-EDITED] when
  // it is set — but nothing could set it, so the tag was unreachable and the
  // context was read-only in practice. A campaign manager who spots a wrong
  // channel cost or a stale quiet-hours window should be able to correct it
  // here rather than file a ticket.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const saveEntry = (id: string) => {
    onOverrides(setEntryValue(overrides, id, draft.trim()));
    setEditing(null);
  };
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [preview, setPreview] = useState<KnowledgeDocument | null>(null);

  const docs = knowledge.documents ?? [];
  const visible = useMemo(
    () => docs.filter((d) => d.scope === 'shared' || d.scope === tenant?.tenantId),
    [docs, tenant],
  );

  const persist = (documents: KnowledgeDocument[]) => onOverrides(setDocuments(overrides, documents));

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const problems: string[] = [];
    const added: KnowledgeDocument[] = [];

    for (const file of Array.from(files)) {
      const base = {
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: file.name,
        // Always shared. A per-upload scope was offered for a while and
        // removed: it put a second, contradictory tenant control next to the
        // global one, and it asked the user to decide something they have no
        // reason to care about at the moment of uploading a brand guideline.
        // The FIELD stays on the record because documents saved before this
        // may carry a tenant id, and the list below still honours those.
        scope: 'shared' as const,
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
      problems.push('The documents could not be saved. Browser storage may be full.');
    }
    setErrors(problems);
    setBusy(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <div className="cd-page">
      <div className="cd-page-head">
        <div>
          <h1>Knowledge Base</h1>
          <p className="cd-lede">
            Everything the agent designs with. Correct anything that is wrong, and add your own material.
          </p>
        </div>
        {/* No action here. The page header introduces the page; each section
            carries its own primary action, so uploading lives with Your
            documents and adding lives with What the agent knows. One action
            per section, in the same place every time. */}
      </div>

      <>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={SUPPORTED_DOC_TYPES.join(',')}
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </>

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

      {/* The synthetic-data notice lived here. Removed along with the rest of
          the prototype disclaimers: the product should read as the product,
          and the provenance of the demo data is said out loud in the room. */}

      {/* WHAT THE AGENT KNOWS, as the page rather than as a footnote.
          The 36 context entries were behind a collapsed disclosure at the
          bottom while "No documents yet" held the whole screen — so a page
          called Knowledge Base announced it had none, sitting on top of
          everything the agent actually reads on every turn. */}
      {/* WHAT YOU CHANGED, first and short.
          Thirty-five entries shown as equal cards served nobody: the content
          is wildly uneven, several entries are instructions to the agent
          rather than facts a person scans, and nobody reads a reference
          section on arrival. What a user actually wants on this page is
          their own changes — few, high-value, and the only part that can be
          wrong because of something they did. */}
      {changeCount(overrides) > 0 && (
        <section className="hf-section">
          <div className="cd-kb-headrow">
            <h2 className="hf-h2">Your changes</h2>
            <button className="cd-link" onClick={onReset}>
              Undo all {changeCount(overrides)}
            </button>
          </div>
          <div className="hf-table-wrap">
            <table className="hf-table">
              <tbody>
                {knowledge.entries
                  .filter((e) => e.editedAt)
                  .map((e) => {
                    const was = isUserAdded(overrides, e.id) ? null : seed && seedValue(seed, e.id);
                    return (
                      <tr key={e.id}>
                        <td className="key">
                          {e.label}
                          <div className="cd-doc-sub">{e.category}</div>
                        </td>
                        <td>
                          {e.value}
                          {was && was !== e.value && <div className="cd-was">was: {was}</div>}
                        </td>
                        <td className="cd-row-actions">
                          {!isUserAdded(overrides, e.id) && (
                            <button className="cd-link" onClick={() => onOverrides(revertEntry(overrides, e.id))}>
                              Undo
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                {overrides.hidden.map((id) => (
                  <tr key={id} className="cd-removed">
                    <td className="key">{seed ? (seed.entries.find((e) => e.id === id)?.label ?? id) : id}</td>
                    <td>Removed</td>
                    <td className="cd-row-actions">
                      <button className="cd-link" onClick={() => onOverrides(revertEntry(overrides, id))}>
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="hf-section">
        {/* Heading left, the section's ONE primary action right — the same
            shape as the page header above it, rather than a third placement
            invented for this screen. The filter is not an action and does not
            belong in this row; it sits with the content it filters. */}
        <div className="cd-section-head">
          <div>
            <h2 className="hf-h2">What the agent knows</h2>
            <p className="cd-lede">
              {knowledge.entries.length} things go to the agent with every campaign it designs. Read from your platform
              and your bank context, and yours to correct.
            </p>
          </div>
          <button className="cd-btn" onClick={() => startAdd('')}>
            Add entry
          </button>
        </div>

        <div className="cd-kb-toolbar">
          <input
            className="cd-kb-filter"
            type="search"
            value={query}
            placeholder="Filter what the agent knows"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter what the agent knows"
          />
          {query.trim() && (
            <span className="cd-kb-count">
              {
                knowledge.entries.filter((e) =>
                  `${e.label} ${e.value} ${e.category}`.toLowerCase().includes(query.trim().toLowerCase()),
                ).length
              }{' '}
              of {knowledge.entries.length}
            </span>
          )}
        </div>

        {adding && <AddForm />}

        {groupKnowledge(
          knowledge.entries.filter(
            (e) =>
              !query.trim() ||
              `${e.label} ${e.value} ${e.category}`.toLowerCase().includes(query.trim().toLowerCase()),
          ),
        ).map(({ category, entries }) => (
          <div className="cd-kbgroup" key={category}>
            <div className="cd-kb-grouphead">
              <span className="cd-work-cap">{category}</span>
              <span className="cd-know-n">{entries.length}</span>
            </div>

            <div className="hf-table-wrap">
              <table className="hf-table">
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="cd-know-row">
                      <td className="key">
                        {e.label}
                        {e.editedAt && <span className="cd-know-tag edited">yours</span>}
                      </td>
                      <td>
                        {editing === e.id ? (
                          <>
                            <textarea
                              className="cd-know-input"
                              value={draft}
                              autoFocus
                              rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 70)))}
                              onChange={(ev) => setDraft(ev.target.value)}
                              onKeyDown={(ev) => {
                                if (ev.key === 'Escape') setEditing(null);
                                if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) saveEntry(e.id);
                              }}
                            />
                            <div className="cd-know-actions">
                              <button className="cd-btn pri sm" onClick={() => saveEntry(e.id)} disabled={!draft.trim()}>
                                Save
                              </button>
                              <button className="cd-link" onClick={() => setEditing(null)}>
                                Cancel
                              </button>
                            </div>
                          </>
                        ) : (
                          <span className="cd-kb-value">{e.value}</span>
                        )}
                      </td>
                      <td className="cd-row-actions">
                        {editing !== e.id && (
                          <>
                            <button
                              className="cd-link"
                              onClick={() => {
                                setEditing(e.id);
                                setDraft(e.value);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="cd-link danger"
                              onClick={() => onOverrides(removeEntry(overrides, e.id))}
                              title={isUserAdded(overrides, e.id) ? 'Delete' : 'Remove. You can restore it.'}
                            >
                              {isUserAdded(overrides, e.id) ? 'Delete' : 'Remove'}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        <div className="cd-know-foot">
          <span>
            {capabilities?.channels.length ?? 0} channels · {capabilities?.nodeTypes.length ?? 0} step types ·{' '}
            {tenant?.templateLibraryAccess === 'unavailable'
              ? 'template library not connected'
              : 'template library connected'}
          </span>
        </div>
      </section>

      {/* Your own material, second. It is the thing you can change, which is
          why it keeps the upload button, but it is not what the page is. */}
      <section className="hf-section">
        <div className="cd-section-head">
          <div>
            <h2 className="hf-h2">Your documents</h2>
          </div>
          {visible.length > 0 && (
            <button className="cd-btn" onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? 'Uploading…' : 'Upload documents'}
            </button>
          )}
        </div>
        {visible.length === 0 ? (
          <div className="cd-doc-empty">
            <p>
              Nothing added yet. Upload brand guidelines, tone of voice, product rules or what you learned from past
              campaigns, and the agent will use them alongside everything above.
            </p>
            <div className="cd-upload-choice">
              <button className="cd-btn pri" onClick={() => fileInput.current?.click()}>
                Upload documents
              </button>
              <p className="cd-upload-hint">
                {SUPPORTED_DOC_TYPES.join(', ')} up to {fmtSize(MAX_DOC_BYTES)}. PDF and Word are not supported yet.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="cd-table-meta">
              {visible.length} document{visible.length > 1 ? 's' : ''} ·{' '}
              {docsForAgent(knowledge.documents, tenant?.tenantId).length} going to the agent
            </div>
            <div className="hf-table-wrap">
              <table className="hf-table">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Uploaded</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((d) => (
                    <tr key={d.id}>
                      <td className="key">
                        <div className="cd-doc-name">{d.filename}</div>
                        <div className="cd-doc-sub">{fmtSize(d.sizeBytes)}</div>
                      </td>
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
            </div>
          </>
        )}
      </section>

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
