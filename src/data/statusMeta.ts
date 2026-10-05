// Ported from journeysnudgesemi/emi-conversions-prototype.html.
import type { DripCampaignStatus } from './graphTypes';

export const DRIP_STATUS_META: Record<DripCampaignStatus, { label: string; badge: string }> = {
  DRAFT: { label: 'Draft', badge: 'gray' },
  PENDING_REVIEW: { label: 'Pending Approval', badge: 'warning' },
  ACTIVE: { label: 'Active', badge: 'success' },
  SCHEDULED: { label: 'Scheduled', badge: 'info' },
  PAUSED: { label: 'Paused', badge: 'info' },
  KILLED: { label: 'Killed', badge: 'error' },
  CHANGES_REQUESTED: { label: 'Revision Required', badge: 'error' },
};
