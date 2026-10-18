/**
 * Is someone using the page? True while the tab is visible and there was a pointer, key, scroll or touch in the last
 * few minutes. Background polling checks this, so an open but forgotten tab stops calling the API and the server can
 * sleep (it scales to zero); the next interaction wakes everything again.
 */
const IDLE_MS = 5 * 60_000;
let last = Date.now();
const wakers = new Set<() => void>();

const touch = () => {
  const wasIdle = !inUse();
  last = Date.now();
  if (wasIdle) wakers.forEach((w) => w());
};

if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const) window.addEventListener(ev, touch, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && touch());
}

export function inUse(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && Date.now() - last < IDLE_MS;
}

/** Called when the page comes back into use after being idle or hidden. Returns an unsubscribe. */
export function onBackInUse(fn: () => void): () => void {
  wakers.add(fn);
  return () => {
    wakers.delete(fn);
  };
}
