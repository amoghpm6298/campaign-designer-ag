// Every chat is resumable. Starting a new one destroys nothing.
//
// THE DEFECT. There was one session slot in localStorage, and "Start over"
// called `clearSession()` on it — a single unconfirmed click in the top-right
// that wiped the conversation with no history and no undo. There was no list
// of past chats and no way back into one. Run logs looked like a history and
// are not: a `RunLog` is one TURN, carrying a transcript fragment and no
// brief, no session state and no pending blueprint, so a five-turn
// conversation was five unrelated rows that could be read and never resumed.
//
// THE SECOND DEFECT, found while building the first. `saveSession` has always
// persisted `lastResponse` — the whole `DesignerResponse`, which carries
// `phase`, `brief`, `session`, `pendingBlueprint` and `pendingStrategy`. The
// mount restore read back four fields and ignored the rest. So a plain RELOAD
// mid-conversation dropped the brief and the confirm gate while the data sat
// in storage untouched. Resume is mostly a matter of reading what was always
// being written.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// A localStorage stand-in. The store is the unit under test and it is the
// only thing here that touches the browser.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const {
  listSessions,
  loadSession,
  loadSessionById,
  saveSession,
  deleteSession,
  MAX_SESSIONS,
  appendRunLog,
  loadRunLogs,
  pruneRunLogs,
  MAX_LOG_CHATS,
} = await import('../../src/designer/storage');

const designer = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');
const logsView = readFileSync(new URL('../../src/designer/RunLogsView.tsx', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../../src/designer-app/DesignerShell.tsx', import.meta.url), 'utf8');

const chat = (id: string, text = 'Get new cardholders activated') => ({
  sessionId: id,
  tenantId: 'TEN-IBL',
  messages: [{ role: 'user' as const, content: text }],
  discoveryRounds: 1,
  campaign: null,
  lastResponse: {
    phase: 'awaiting-confirmation',
    brief: { objective: text },
    session: { state: 'AWAITING_CONFIRMATION' },
    pendingBlueprint: { campaignName: 'A plan', steps: [{ kind: 'send' }] },
    strategy: { summary: 'A plan' },
    graph: null,
  },
});

beforeEach(() => store.clear());

describe('starting a new chat does not destroy the old one', () => {
  it('keeps every chat, not just the open one', () => {
    saveSession(chat('s-1', 'EMI conversion'));
    saveSession(chat('s-2', 'Card activation'));
    expect(listSessions().map((s) => s.sessionId).sort()).toEqual(['s-1', 's-2']);
  });

  it('lists the most recently touched first', async () => {
    saveSession(chat('s-1'));
    await new Promise((r) => setTimeout(r, 5));
    saveSession(chat('s-2'));
    expect(listSessions()[0].sessionId).toBe('s-2');
    // And touching the older one brings it back to the top.
    await new Promise((r) => setTimeout(r, 5));
    saveSession(chat('s-1'));
    expect(listSessions()[0].sessionId).toBe('s-1');
  });

  it('opens the chat you were last in when none is named', () => {
    saveSession(chat('s-1'));
    saveSession(chat('s-2'));
    expect(loadSession()?.sessionId).toBe('s-2');
  });

  it('opens a named chat exactly', () => {
    saveSession(chat('s-1', 'EMI conversion'));
    saveSession(chat('s-2', 'Card activation'));
    expect(loadSessionById('s-1')?.messages[0].content).toBe('EMI conversion');
    expect(loadSessionById('nope')).toBeNull();
  });

  it('deletes only what was asked for', () => {
    saveSession(chat('s-1'));
    saveSession(chat('s-2'));
    deleteSession('s-1');
    expect(listSessions().map((s) => s.sessionId)).toEqual(['s-2']);
  });
});

describe('the store cannot grow without bound', () => {
  it('keeps the most recent and drops the oldest', async () => {
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
      saveSession(chat(`s-${String(i).padStart(3, '0')}`));
      await new Promise((r) => setTimeout(r, 1));
    }
    const ids = listSessions().map((s) => s.sessionId);
    expect(ids).toHaveLength(MAX_SESSIONS);
    expect(ids[0]).toBe(`s-${String(MAX_SESSIONS + 4).padStart(3, '0')}`);
    expect(ids).not.toContain('s-000');
  });

  it('does not keep chats nobody spoke in', () => {
    // An empty session is written on every mount. Listed, they would fill the
    // page with blank rows for apps that were opened and closed.
    saveSession({ ...chat('s-1'), messages: [] });
    saveSession(chat('s-2'));
    expect(listSessions().map((s) => s.sessionId)).toEqual(['s-2']);
  });

  it('keeps the CURRENT chat even before its first message', () => {
    // Otherwise the chat you are typing into vanishes from under you.
    saveSession({ ...chat('s-1'), messages: [] });
    expect(listSessions().map((s) => s.sessionId)).toEqual(['s-1']);
  });
});

describe('the upgrade does not lose the chat you are in', () => {
  it('carries the old single slot into the store', () => {
    // Anyone mid-conversation when this ships keeps that conversation. An
    // upgrade that loses the chat it was built to preserve would be a poor
    // advertisement for it.
    store.set('dc-agent-session-v1', JSON.stringify(chat('s-legacy', 'An older chat')));
    expect(listSessions().map((s) => s.sessionId)).toEqual(['s-legacy']);
    expect(loadSessionById('s-legacy')?.messages[0].content).toBe('An older chat');
  });

  it('removes the old key once it has been carried across', () => {
    store.set('dc-agent-session-v1', JSON.stringify(chat('s-legacy')));
    listSessions();
    expect(store.has('dc-agent-session-v1')).toBe(false);
  });

  it('does not overwrite a chat already in the store', () => {
    saveSession(chat('s-1', 'The real one'));
    store.set('dc-agent-session-v1', JSON.stringify(chat('s-1', 'A stale copy')));
    expect(loadSessionById('s-1')?.messages[0].content).toBe('The real one');
  });

  it('survives corrupt storage rather than failing the page load', () => {
    store.set('dc-agent-sessions-v1', '{ not json');
    expect(listSessions()).toEqual([]);
  });
});

describe('resuming restores the whole conversation, not four fields of it', () => {
  // `stateFrom` is the one path mount and resume share, so the two cannot
  // restore different amounts of a chat.
  it('reads phase, brief, session and the pending blueprint back out', () => {
    for (const field of [
      "phase: (r?.phase ?? 'understanding') as Phase",
      'brief: r?.brief ?? null',
      'session: r?.session ?? null',
      'pendingBlueprint: r?.pendingBlueprint ?? null',
      'pendingStrategy: r?.strategy ?? null',
    ]) {
      expect(designer, field).toContain(field);
    }
  });

  it('uses that one path for both the first mount and a resume', () => {
    expect(designer).toMatch(/useRef\(stateFrom\(openId \? loadSessionById\(openId\) : loadSession\(\)\)\)/);
    expect(designer).toMatch(/open\(loadSessionById\(openId\)\)/);
  });

  it('starts a new chat without clearing anything', () => {
    // The whole point. `clearSession` is gone from this file, and the new
    // chat is a new id rather than a wipe.
    // Asserted on the CODE: the comment above `startNew` names the call it
    // replaced, which is the record of why this exists.
    const code = designer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/clearSession/);
    expect(designer).toMatch(/const startNew = \(\) => \{/);
    expect(designer).toContain("const id = `s-${Date.now()}`;");
  });
});

describe('the Chats page lists conversations and can continue one', () => {
  it('groups turns into chats rather than listing every turn', () => {
    expect(logsView).toMatch(/for \(const l of logs\) by\.set\(l\.sessionId/);
  });

  it('lists a chat that has no run log yet', () => {
    // A chat whose first turn errored has a session and no log. It still
    // belongs on the list; it is the one most likely to be returned to.
    expect(logsView).toMatch(/for \(const s of stored\) if \(!by\.has\(s\.sessionId\)\) by\.set\(s\.sessionId, \[\]\)/);
  });

  it('only offers to continue a chat that can actually be continued', () => {
    // An old run log carries a transcript and no session state. Offering
    // Continue on it would open an empty designer and look like data loss.
    expect(logsView).toMatch(/disabled=\{!session\?\.canResume \|\| !onResume\}/);
    expect(logsView).toMatch(/only its log remains/);
  });

  it('splits the conversation from the logs into two tabs', () => {
    expect(logsView).toMatch(/useState<'resume' \| 'logs' \| 'journey'>\('resume'\)/);
    expect(logsView).toMatch(/\{tab === 'resume' && \(/);
    expect(logsView).toMatch(/\{tab === 'logs' && current && \(/);
    // A third tab since 2026-10-22, and only when the chat built something.
    expect(logsView).toMatch(/\{tab === 'journey' && built && \(/);
    // And the Logs tab says so when there is no run to show, rather than
    // rendering an empty frame.
    expect(logsView).toMatch(/No run has completed in this chat yet/);
  });

  it('can delete a chat', () => {
    expect(logsView).toMatch(/deleteSession\(session\.sessionId\)/);
  });
});

describe('the shell owns which chat is open', () => {
  it('passes it to the one designer component, remounting on change', () => {
    // One designer surface, two ways in. A second chat UI inside the list
    // page would drift from this one within a release.
    expect(shell).toMatch(/key=\{openChat \?\? 'current'\}/);
    expect(shell).toMatch(/sessionId=\{openChat\}/);
  });

  it('resuming is a navigation, so it lands you in the designer', () => {
    expect(shell).toMatch(/onResume=\{\(id\) => \{\s*setOpenChat\(id\);\s*setPage\('designer'\);/);
  });
});

describe('the list is a table, and a chat opens full width', () => {
  // The split pane was the Run Logs layout, from when a row was one TURN. At
  // thirteen chats it was a wall of cards with every title truncated, taking a
  // third of the width from the thing you opened it to read.
  it('renders rows as a table, not a column of cards', () => {
    expect(logsView).toMatch(/<table className="cd-table">/);
    expect(logsView).toMatch(/<th>Campaign<\/th>/);
    expect(logsView).not.toMatch(/className="cd-loglist"/);
  });

  it('lands on the list rather than opening something you did not pick', () => {
    // It used to fall back to `sessions[0]`, so the page always opened
    // mid-conversation in whatever was newest.
    expect(logsView).toMatch(/const session = sel \? sessions\.find\(\(g\) => g\.sessionId === sel\) \?\? null : null;/);
  });

  it('shows the table OR a chat, never both, with a way back', () => {
    expect(logsView).toMatch(/\{!session && \(\s*<table/);
    expect(logsView).toMatch(/← All chats/);
  });
});

describe('a run log is end to end, not a transcript with events beside it', () => {
  // "Is everything printed in logs? Seems like some info is incomplete." It
  // was. Measured on a real turn: the log dropped `strategy` (9.6 KB — the
  // plan) and `brief` (10.2 KB — converters, barriers, dimensions), so it
  // could show that a proposal happened and never what was proposed.
  it('stores what the agent worked out', () => {
    for (const field of ['brief: res.brief', 'strategy: res.strategy', 'blueprint: res.pendingBlueprint ?? res.blueprint']) {
      expect(designer, field).toContain(field);
    }
  });

  it('keeps the raw provider error, by the standing rule', () => {
    expect(designer).toMatch(/errorDetail: \(res as \{ errorDetail\?: string \}\)\.errorDetail/);
  });

  it('pays for it by not storing the streaming transport', () => {
    // 132 of that turn's 158 events were text deltas — half the bytes — and
    // they are already reassembled into `reply`. The log is SMALLER than it
    // was and complete.
    expect(designer).toMatch(/\.filter\(\(e\) => e\.type !== 'model\.text\.delta'\)/);
  });

  it('reads them back as findings and a plan, not as a JSON dump', () => {
    expect(logsView).toMatch(/function RunSummary/);
    expect(logsView).toMatch(/What the agent worked out/);
    for (const label of ['Who converts today', 'What is stopping the rest', 'Lines of enquiry', 'The plan', 'Approaches weighed', 'What it checked']) {
      expect(logsView, label).toContain(label);
    }
  });

  it('never prints a label with nothing under it', () => {
    // Same rule as the architecture renderer: a bare caption reads as a
    // question put to the user about something that was never recorded.
    expect(logsView).toMatch(/const Fact = \(\{ label, children \}[\s\S]*?children \?/);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-22 — "why are logs not coming up in chats section" and "how will we
// show when a graph is built"
//
// Three separate faults behind one page, and only the first is a bug in the
// ordinary sense.
// ---------------------------------------------------------------------------

describe('a chat lists the log of every turn, not only the last', () => {
  it('lets a turn be picked, and defaults to the newest', () => {
    // THE GAP. `current` was `turns[turns.length - 1]` and the Logs tab
    // rendered only that, so a five-turn conversation had four turns of
    // events no screen could reach. The Conversation tab has always listed
    // every turn — this is the same record from the other side.
    expect(logsView).toMatch(/const \[turnSel, setTurnSel\] = useState<string \| null>\(null\);/);
    expect(logsView).toMatch(/const newest = session\?\.turns\[session\.turns\.length - 1\] \?\? null;/);
    expect(logsView).toMatch(
      /const current = \(turnSel \? session\?\.turns\.find\(\(t\) => t\.runId === turnSel\) : null\) \?\? newest;/,
    );
    expect(logsView).toMatch(/className="cd-turnpicker"/);
  });

  it('offers the picker only when there is more than one turn', () => {
    // One turn needs no chooser, and a row of tabs with a single tab in it
    // reads as a control that does nothing.
    expect(logsView).toMatch(/\{tab === 'logs' && session\.turns\.length > 1 && \(/);
  });

  it('forgets the picked turn when a different chat is opened', () => {
    // Otherwise the runId belongs to a chat you are no longer looking at,
    // `find` misses, and it silently falls back to the newest — which looks
    // like the picker being ignored.
    expect(logsView).toMatch(/setSel\(g\.sessionId\); setTab\('resume'\); setTurnSel\(null\);/);
  });
});

describe('a chat shows the journey it built', () => {
  it('renders the real canvas, read-only, from the stored snapshot', () => {
    // `campaignSnapshot` is the campaign as it stood and `DripCampaign.root`
    // is the graph, so nothing new has to be stored for this.
    //
    // READ-ONLY, deliberately. This is a record of what was built; editing a
    // past chat's canvas from a log page would change a campaign with no
    // conversation around it. Continue the chat to change it.
    expect(logsView).toMatch(/import \{ DripCanvas \} from '\.\.\/canvas\/DripCanvas';/);
    expect(logsView).toMatch(/<DripCanvas graph=\{built\.root!\} editable=\{false\} goal=\{built\.goal \?\? null\} \/>/);
  });

  it('reads the snapshot from the newest turn that HAS one', () => {
    // A chat usually continues after the build, and those later turns carry
    // no snapshot — so taking the newest turn's would show nothing on a chat
    // that plainly built a journey.
    expect(logsView).toMatch(/for \(const t of \[\.\.\.\(session\?\.turns \?\? \[\]\)\]\.reverse\(\)\) \{/);
    expect(logsView).toMatch(/if \(t\.campaignSnapshot\?\.root\?\.rootId\) return t\.campaignSnapshot;/);
  });

  it('shows no Journey tab when nothing was built', () => {
    // A tab that opens onto "no journey was built" is a worse answer than the
    // tab's absence, and most chats never reach a build.
    const tabs = logsView.slice(logsView.indexOf('className="cd-subtabs"'), logsView.indexOf('THE BUILT JOURNEY'));
    expect(tabs).toMatch(/\{built && \(/);
  });
});

describe('the empty state counts chats, not run logs', () => {
  it('does not claim there are no chats while rows exist', () => {
    // It was gated on `!logs.length`, so clearing the logs — or any chat that
    // exists in storage with no completed run — showed "No chats yet" over a
    // table that was about to render.
    expect(logsView).toMatch(/if \(!sessions\.length\) \{/);
    expect(logsView).not.toMatch(/if \(!logs\.length\) \{/);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-22 — "why are logs not coming up in chats section"
//
// Reproduced in a browser with sixteen chats of five turns each. Run logs were
// capped at 60 TURNS globally (`slice(0, 60)`) while sessions are capped at 40
// CHATS. A turn budget divided by turns-per-chat IS a chat budget, so the logs
// covered only the newest twelve chats: four chats listed, opened, and showed
// an empty Logs tab reading "No run has completed in this chat yet" about five
// runs that had all completed. The transcript went with them, because the
// Conversation tab was built from the logs too.
// ---------------------------------------------------------------------------

const runLog = (sessionId: string, n: number) => ({
  runId: `${sessionId}-r${n}`,
  sessionId,
  startedAt: new Date(2026, 9, 22, 10, n).toISOString(),
  status: 'discovery' as const,
  title: `turn ${n}`,
  model: 'claude-opus-5',
  events: [],
});

describe('run logs are evicted by chat, not by turn', () => {
  beforeEach(() => store.clear());

  it('keeps whole chats, newest first', () => {
    // Newest-first, five turns each, more chats than the budget.
    const logs = [];
    for (let c = 1; c <= MAX_LOG_CHATS + 4; c++) {
      for (let t = 5; t >= 1; t--) logs.push(runLog(`s-${String(c).padStart(2, '0')}`, t));
    }
    const kept = pruneRunLogs(logs);
    const chats = new Set(kept.map((l) => l.sessionId));
    expect(chats.size).toBe(MAX_LOG_CHATS);
    // EVERY kept chat keeps ALL of its turns. A half-logged conversation is a
    // worse record than an absent one: nothing says which turns are missing.
    for (const id of chats) expect(kept.filter((l) => l.sessionId === id)).toHaveLength(5);
    // And the chats that went are the oldest ones.
    expect(chats.has('s-01')).toBe(true);
    expect(chats.has(`s-${String(MAX_LOG_CHATS + 4).padStart(2, '0')}`)).toBe(false);
  });

  it('never splits one chat across the boundary', () => {
    // The old `slice(0, 60)` cut mid-chat, so the chat ON the boundary kept
    // some turns and lost others — the state that is hardest to read.
    const logs = [];
    for (let c = 1; c <= MAX_LOG_CHATS + 2; c++) {
      for (let t = 7; t >= 1; t--) logs.push(runLog(`s-${c}`, t));
    }
    const kept = pruneRunLogs(logs);
    const counts = new Set([...new Set(kept.map((l) => l.sessionId))].map((id) => kept.filter((l) => l.sessionId === id).length));
    expect(counts).toEqual(new Set([7]));
  });

  it('writes the newest turn even when the quota is full', () => {
    // `write` used to swallow a quota failure and return void, so once the
    // store filled the app carried on as though it had saved and every log
    // from then on was silently discarded. It reports now, and the caller
    // drops the oldest chat and tries again.
    for (let c = 1; c <= 4; c++) appendRunLog(runLog(`s-${c}`, 1));
    const realSet = localStorage.setItem;
    let refusals = 0;
    (localStorage as unknown as { setItem: (k: string, v: string) => void }).setItem = (k, v) => {
      // Refuse anything carrying more than two chats, then accept.
      if (k === 'dc-agent-runlogs-v1' && new Set(JSON.parse(v).map((l: { sessionId: string }) => l.sessionId)).size > 2) {
        refusals++;
        throw new Error('QuotaExceededError');
      }
      realSet.call(localStorage, k, v);
    };
    appendRunLog(runLog('s-5', 1));
    (localStorage as unknown as { setItem: unknown }).setItem = realSet;
    expect(refusals).toBeGreaterThan(0);
    const after = loadRunLogs();
    expect(after[0].sessionId, 'the turn that just happened must survive').toBe('s-5');
    expect(new Set(after.map((l) => l.sessionId)).size).toBeLessThanOrEqual(2);
  });
});

describe('a chat whose logs were evicted still reads as a conversation', () => {
  it('falls back to the session own messages for the transcript', () => {
    // They sat in the session store, unread, while the page said the chat had
    // no completed turn.
    expect(logsView).toMatch(/const said = new Map\(stored\.map\(\(s\) => \[s\.sessionId, s\.messages \?\? \[\]\]\)\);/);
    expect(logsView).toMatch(/\{!session\.turns\.length && session\.messages\.length > 0 && \(/);
    expect(logsView).toMatch(/The detailed logs for this chat have been discarded to save space\./);
  });

  it('tells the two empty states apart', () => {
    // "No run has completed in this chat yet" about five completed runs is
    // how a working chat came to look broken.
    expect(logsView).toMatch(/session\.messages\.length\s*\n?\s*\? 'The detailed logs for this chat have been discarded/);
    expect(logsView).toMatch(/: 'No run has completed in this chat yet/);
  });
});

describe('a stored response missing a field cannot take the page down', () => {
  it('guards the arrays it reads off the last response', () => {
    // `last?.sendProposals.length` — the chain stopped at `last`, so a stored
    // response without the field crashed the WHOLE designer with "Cannot read
    // properties of undefined". Found by seeding a session by hand; every live
    // response carries the field, which is exactly why it went unnoticed. The
    // type says required and the restore path reads localStorage.
    expect(designer).toMatch(/last\?\.sendProposals\?\.length/);
    expect(designer).toMatch(/last\?\.questions\?\.length/);
    // No remaining short chain anywhere in the file, comments included — the
    // comment explaining this fix deliberately does not quote the broken form,
    // because a source-text assertion that reads its own documentation is not
    // checking the code.
    expect(designer).not.toMatch(/last\?\.[a-zA-Z]+\.length/);
  });
});
