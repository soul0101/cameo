import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  cycle: () => void;
}

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const systemTheme = (): ResolvedTheme => (media?.matches ? 'dark' : 'light');
const resolve = (mode: ThemeMode): ResolvedTheme => (mode === 'system' ? systemTheme() : mode);

/** Writes the attributes tokens.css keys off. No data-theme = follow system. */
function apply(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  root.dataset.resolvedTheme = resolve(mode);
}

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      // Light by default; dark (or following the system) is the visitor's choice.
      mode: 'light',
      resolved: 'light',
      setMode: (mode) => {
        apply(mode);
        set({ mode, resolved: resolve(mode) });
      },
      cycle: () => {
        const order: ThemeMode[] = ['system', 'light', 'dark'];
        get().setMode(order[(order.indexOf(get().mode) + 1) % order.length]);
      },
    }),
    {
      name: 'cameo-theme',
      version: 1,
      partialize: (s) => ({ mode: s.mode }),
      // Computed while the saved choice loads (during create, before `useTheme` exists): the button and the page agree.
      merge: (saved, current) => {
        const mode = (saved as Partial<ThemeState> | undefined)?.mode ?? current.mode;
        return { ...current, mode, resolved: resolve(mode) };
      },
    },
  ),
);

if (typeof window !== 'undefined') {
  apply(useTheme.getState().mode);
  media?.addEventListener('change', () => {
    const { mode } = useTheme.getState();
    if (mode === 'system') {
      apply(mode);
      useTheme.setState({ resolved: systemTheme() });
    }
  });
}
