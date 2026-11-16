// After a deploy, a tab that stays open keeps running the old app against the
// new server, and a campaign written by the new agent can look broken in it.
// This asks the server for its version on load, then every minute and when
// the tab comes back into view; when it changes, it offers a reload.
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiUrl } from '../designer/api';

const fetchVersion = async (): Promise<string | null> => {
  try {
    const r = await fetch(apiUrl('/api/version'), { cache: 'no-store' });
    return r.ok ? ((await r.json()) as { version?: string }).version ?? null : null;
  } catch {
    return null;
  }
};

export function ReloadPrompt() {
  const first = useRef<string | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let live = true;
    const check = async () => {
      const v = await fetchVersion();
      if (!live || !v) return;
      if (first.current === null) first.current = v;
      else if (v !== first.current) setStale(true);
    };
    void check();
    const t = setInterval(check, 60_000);
    const onVisible = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  if (!stale) return null;
  return (
    <div className="reload-prompt" role="alert">
      <RefreshCw size={15} />
      <span>A new version of the app is available.</span>
      <button onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
