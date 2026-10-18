import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProject } from '@/store/project';
import { useTheme } from '@/store/theme';
import { useUI } from '@/store/ui';
import { SECTIONS, sectionPath } from './sections';
import { useShell } from './store';

/** True when the current page uses this key itself (`data-page-keys="t"` on its root). */
const pageClaims = (key: string) => !!document.querySelector(`[data-page-keys~="${key}"]`);

const typing = (el: EventTarget | null) => !!(el as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');

/**
 * Global keys: `?` shortcuts, `[` sidebar, `t` theme (Shift+T on pages that claim `t`), `g` then a section key. Watch's own keys
 * (space, arrows, p, o, m, f) keep working: a `g` chord swallows only its second key.
 */
export function useGlobalShortcuts(projectId: string | null) {
  const navigate = useNavigate();
  useEffect(() => {
    let chord = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('[aria-modal="true"]') && e.key !== '?') return;
      const key = e.key.toLowerCase();
      if (chord && performance.now() - chord < 1200 && projectId) {
        chord = 0;
        const s = SECTIONS.find((x) => x.key === key);
        if (s) {
          e.preventDefault();
          e.stopPropagation();
          navigate(sectionPath(projectId, s.id));
        }
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        useShell.getState().set({ shortcuts: !useShell.getState().shortcuts });
      } else if (e.key === '[' && projectId) {
        e.preventDefault();
        useShell.getState().toggleCollapsed();
      } else if (key === 't' && !e.shiftKey !== pageClaims('t')) {
        // A page may claim `t` (Scenes: Scene · Table); the theme then moves to Shift+T there.
        const { resolved, setMode } = useTheme.getState();
        setMode(resolved === 'dark' ? 'light' : 'dark');
      } else if (key === 'g' && projectId) {
        chord = performance.now();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigate, projectId]);
}

/** Pages that share the global audience (Watch, Scenes' "On video") stay on one that exists. */
export function useMarketSync() {
  const audiences = useProject((s) => s.audiences);
  const market = useUI((s) => s.market);
  const setMarket = useUI((s) => s.setMarket);
  useEffect(() => {
    if (!audiences.some((a) => a.id === market) && audiences[0]) setMarket(audiences[0].id);
  }, [audiences, market, setMarket]);
}
