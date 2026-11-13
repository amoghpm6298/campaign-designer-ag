// How an SMS is put together when it is sent: the copy, then the CTA and a
// colon, then the short link written out (SMS cannot hide a link behind
// text). Shared by the canvas preview and the engine contract, so what you
// see is what goes out.
export function assembleSms(copy: string, cta: string | undefined, shortUrl: string | undefined): string {
  let text = (copy ?? '').trim().replace(/[\s:–—-]+$/, '');
  const action = (cta ?? '').trim().replace(/[\s:.›>]+$/, '');
  // The CTA is added only when the copy does not already say it.
  const said = !action || text.toLowerCase().includes(action.toLowerCase());
  if (!shortUrl) return said ? text : `${text}${/[.!?]$/.test(text) ? '' : '.'} ${action}.`;
  if (!said) text = `${text}${/[.!?]$/.test(text) ? '' : '.'} ${action}`;
  return `${text}: ${shortUrl}`;
}

/** Characters and SMS parts (160 for one, 153 per part when split). */
export function smsLength(text: string): { chars: number; parts: number } {
  const chars = text.length;
  return { chars, parts: chars <= 160 ? 1 : Math.ceil(chars / 153) };
}
