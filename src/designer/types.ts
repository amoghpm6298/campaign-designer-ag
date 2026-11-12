// Client-side mirrors of the server contract. Hand-written rather than
// imported from server/ because those modules use node:fs and must never
// enter the browser bundle.

export type VerificationStatus = 'verified' | 'observation' | 'hypothesis' | 'invented' | 'authoritative';

export interface KnowledgeEntry {
  id: string;
  category: string;
  label: string;
  value: string;
  source: string;
  status: VerificationStatus;
  scope?: string;
  editedAt?: string;
}
/**
 * A document uploaded to give the agent context.
 *
 * `status` reflects what ACTUALLY happened, never the fact that a file was
 * chosen. Only a document whose text was successfully read and stored reaches
 * 'ready' — and only a 'ready' document is sent to the agent.
 */
export interface KnowledgeDocument {
  id: string;
  filename: string;
  /** Shared across tenants, or scoped to one tenant. */
  scope: 'shared' | string;
  sizeBytes: number;
  uploadedAt: string;
  status: 'ready' | 'failed';
  /** Present when status is 'failed'. */
  error?: string;
  /** The extracted text the agent reads. Absent when extraction failed. */
  text?: string;
}

export interface KnowledgeBase {
  version: string;
  entries: KnowledgeEntry[];
  documents?: KnowledgeDocument[];
}

export interface Capabilities {
  nodeTypes: { type: string; label: string; category: string }[];
  channels: string[];
  templates: { id: string; name: string; channelType: string; accountName: string }[];
  eventCategories: Record<string, string[]>;
  eligibilityAttributes: Record<string, string[]>;
  issuers: Record<string, string[]>;
  smartTagAttributes: string[];
  schemaContentHash: string;
  schemaArtefactVersion: string;
}

export interface Tenant {
  tenantId: string;
  displayName: string;
  issuer: string;
  synthetic: true;
  templateLibraryAccess: 'unavailable' | 'synthetic-demo';
  /** The tenant has a data warehouse: buckets are data-backed. */
  warehouseAccess?: boolean;
}
