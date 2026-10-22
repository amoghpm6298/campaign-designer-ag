// Tenant registry — SERVER-side source of truth.
//
// The client sends only a tenantId. Every piece of tenant configuration is
// resolved here, so a browser cannot hand the agent a tenant's settings it
// should not have. This is an application-context mechanism, not
// authorization: there is no real auth in this prototype, and a production
// deployment must enforce access server-side before trusting any id.
//
// Every tenant below is SYNTHETIC. None is a real bank, and none of the
// values is a real policy, cost or mapping.
import type { Channel } from '../src/data/sharedConstants';

/**
 * Whether the bank's own communication template catalogue is reachable.
 *
 * This is the core of the missing-template behaviour. Templates live in the
 * BANK's ecosystem, not in Hyperface, so the honest default is that we cannot
 * see them — which is different from knowing none exists.
 */
export type TemplateLibraryAccess =
  /** No connection to the bank's catalogue. We cannot confirm or deny a template exists. */
  | 'unavailable'
  /** A seeded synthetic library, for demos only. Never a real bank catalogue. */
  | 'synthetic-demo';

export interface TenantConfig {
  tenantId: string;
  /** Maps to DripCampaign.issuer. Asserted by the platform, not derived. */
  issuer: string;
  displayName: string;
  /** Always true in this prototype. Shown in the UI. */
  synthetic: true;
  templateLibraryAccess: TemplateLibraryAccess;
  availableChannels: { channel: Channel; relativeCost: number; available: boolean }[];
  /** Which bank-context file supplies this tenant's curated knowledge. */
  bankContextFile: string;
}

const TENANTS: TenantConfig[] = [
  {
    tenantId: 'TEN-IBL',
    issuer: 'IndusInd Bank (IBL)',
    displayName: 'IndusInd Bank (IBL)',
    synthetic: true,
    // The realistic case: Hyperface cannot read the bank's template library.
    templateLibraryAccess: 'unavailable',
    availableChannels: [
      { channel: 'EMAIL', relativeCost: 1, available: true },
      { channel: 'SMS', relativeCost: 2, available: true },
      { channel: 'WHATSAPP', relativeCost: 3, available: true },
      { channel: 'RCS', relativeCost: 2, available: false },
    ],
    bankContextFile: '../agent-proto/context/bank-context.json',
  },
  {
    tenantId: 'TEN-YES',
    issuer: 'Yes Bank',
    displayName: 'Yes Bank',
    synthetic: true,
    templateLibraryAccess: 'unavailable',
    availableChannels: [
      { channel: 'SMS', relativeCost: 2, available: true },
      { channel: 'WHATSAPP', relativeCost: 3, available: true },
      { channel: 'EMAIL', relativeCost: 1, available: false },
      { channel: 'RCS', relativeCost: 2, available: false },
    ],
    bankContextFile: '../agent-proto/context/bank-context.json',
  },
  {
    // Kept so the template-matching capability can still be demonstrated.
    // Its library is seeded sample data, labelled as such everywhere.
    tenantId: 'TEN-DEMO',
    issuer: 'IndusInd Bank (IBL)',
    displayName: 'Demo tenant',
    synthetic: true,
    templateLibraryAccess: 'synthetic-demo',
    availableChannels: [
      { channel: 'EMAIL', relativeCost: 1, available: true },
      { channel: 'SMS', relativeCost: 2, available: true },
      { channel: 'WHATSAPP', relativeCost: 3, available: true },
      { channel: 'RCS', relativeCost: 2, available: false },
    ],
    bankContextFile: '../agent-proto/context/bank-context.json',
  },
];

export const DEFAULT_TENANT_ID = 'TEN-IBL';

export function listTenants(): { tenantId: string; displayName: string; issuer: string; synthetic: true; templateLibraryAccess: TemplateLibraryAccess }[] {
  return TENANTS.map((t) => ({
    tenantId: t.tenantId,
    displayName: t.displayName,
    issuer: t.issuer,
    synthetic: t.synthetic,
    templateLibraryAccess: t.templateLibraryAccess,
  }));
}

/**
 * Resolves a tenant id to its configuration. Returns null for an unknown id
 * rather than falling back to a default — silently substituting a tenant is
 * how one tenant's campaign ends up carrying another's issuer.
 */
export function resolveTenant(tenantId: string | undefined): TenantConfig | null {
  if (!tenantId) return null;
  return TENANTS.find((t) => t.tenantId === tenantId) ?? null;
}
