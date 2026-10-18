import { useEffect } from 'react';
import { create } from 'zustand';
import { checkHealth, setUnreachableReporter, setWakeReporter } from './api';
import { inUse, onBackInUse } from '@/lib/activity';

/**
 * Is the API answering? `GET /health` on load, every 15 s while up and every 5 s while down, but only while the page
 * is in use (lib/activity), so a forgotten tab lets the server sleep; again on focus, when the page is used again, or
 * when the network returns. Any request that gets no answer marks it down at
 * once. Pages keep showing what this browser saved; actions that need the API report an unreachable server themselves.
 */
type ApiStatus = 'unknown' | 'up' | 'down';

interface HealthState {
  status: ApiStatus;
  checking: boolean;
  /** The server is starting after a quiet spell (services/api: a request waiting with no recent answer). */
  waking: boolean;
  check: () => Promise<boolean>;
}

export const useHealth = create<HealthState>()((set, get) => ({
  status: 'unknown',
  checking: false,
  waking: false,
  check: async () => {
    if (get().checking) return get().status === 'up';
    set({ checking: true });
    const ok = await checkHealth();
    set({ status: ok ? 'up' : 'down', checking: false });
    return ok;
  },
}));

setWakeReporter((waking) => useHealth.setState({ waking }));

setUnreachableReporter(() => {
  if (useHealth.getState().status !== 'down') useHealth.setState({ status: 'down' });
});

/** Mount once (root layout): keeps `useHealth` current. */
export function useHealthPolling() {
  const status = useHealth((s) => s.status);
  useEffect(() => {
    const check = () => void useHealth.getState().check();
    if (useHealth.getState().status === 'unknown') check();
    const id = setInterval(() => inUse() && check(), status === 'down' ? 5000 : 15000);
    const offBack = onBackInUse(check);
    const onVisible = () => document.visibilityState === 'visible' && check();
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      offBack();
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status]);
}
