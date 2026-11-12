// localStorage persistence for the Knowledge Base documents rules and the
// selected tenant. Chat sessions live with the agent UI (v2/DesignerV2.tsx).

const TENANT_KEY = 'dc-agent-tenant-v1';

/**
 * Formats whose text can actually be extracted in the browser. Anything else
 * is rejected at selection rather than accepted and silently not read — a
 * document the agent cannot read must never look like one it can.
 */
export const SUPPORTED_DOC_TYPES = ['.md', '.txt', '.csv', '.json'] as const;
/** localStorage is the only store here, so a document has to fit in it. */
export const MAX_DOC_BYTES = 400_000;

export function isSupportedDoc(filename: string): boolean {
  return SUPPORTED_DOC_TYPES.some((ext) => filename.toLowerCase().endsWith(ext));
}

/** Survives reloads so the tenant selection is sticky. */
export const loadTenantId = (): string | null => {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
};
export const saveTenantId = (id: string): void => {
  try {
    localStorage.setItem(TENANT_KEY, id);
  } catch {
    /* ignore */
  }
};
