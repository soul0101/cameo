import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Shell UI state. `collapsed` is persisted (`cameo-shell`); sheets are not. */
interface ShellState {
  collapsed: boolean;
  mobileNav: boolean;
  shortcuts: boolean;
  settings: boolean;
  confirmReset: boolean;
  rename: boolean;
  toggleCollapsed: () => void;
  set: (p: Partial<Pick<ShellState, 'mobileNav' | 'shortcuts' | 'settings' | 'confirmReset' | 'rename'>>) => void;
}

export const useShell = create<ShellState>()(
  persist(
    (set) => ({
      collapsed: false,
      mobileNav: false,
      shortcuts: false,
      settings: false,
      confirmReset: false,
      rename: false,
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      set: (p) => set(p),
    }),
    { name: 'cameo-shell', partialize: (s) => ({ collapsed: s.collapsed }) },
  ),
);
