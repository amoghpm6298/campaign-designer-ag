/**
 * Dates and times, in IST.
 *
 * WHY A SHARED MODULE. Four files formatted times independently with bare
 * `toLocaleString()` / `toLocaleTimeString()` and no time zone, so every
 * reading followed whatever the viewer's machine was set to. For a product
 * used by teams in India that is wrong twice over: a campaign manager in
 * Mumbai and a colleague abroad reading the same run log would see different
 * times for the same event, and neither would know which was which.
 *
 * Asia/Kolkata, stated. Not "local" and not UTC.
 */
const IST = 'Asia/Kolkata';

/** 14:32 */
export const fmtTime = (iso: string | number | Date) =>
  new Date(iso).toLocaleTimeString('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false });

/** 21 Oct */
export const fmtDay = (iso: string | number | Date) =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short' });

/** 21 Oct 2026 */
export const fmtDate = (iso: string | number | Date) =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' });

/**
 * 21 Oct 2026, 14:32 IST
 *
 * The zone is written out. A bare time on a shared record invites the reader
 * to assume it is theirs, and in a team that spans offices it usually is not.
 */
export const fmtStamp = (iso: string | number | Date) =>
  `${fmtDate(iso)}, ${fmtTime(iso)} IST`;
