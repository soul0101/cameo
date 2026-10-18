import { create } from 'zustand';

/** Last known Player playhead (whole seconds), so Interest can draw it as a cursor. Session only. */
export const usePlayhead = create<{ t: number | null; set: (t: number) => void }>()((set) => ({
  t: null,
  set: (t) => set({ t }),
}));
