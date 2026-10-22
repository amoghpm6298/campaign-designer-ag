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
    expect(logsView).toMatch(/useState<'resume' \| 'logs'>\('resume'\)/);
    expect(logsView).toMatch(/\{tab === 'resume' && \(/);
    expect(logsView).toMatch(/\{tab === 'logs' && current && \(/);
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
