import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Viewer's "Saved for later" list in Watch. One entry per product, remembering the placement it
 * was saved from so the row can seek. Persisted in localStorage; storage failures fall back to memory.
 */
export interface SavedItem {
  productId: string;
  /** Placement the product was saved from. */
  placementId: string;
  at: number;
}

interface SavedState {
  items: SavedItem[];
  isSaved: (productId: string) => boolean;
  save: (productId: string, placementId: string) => void;
  remove: (productId: string) => void;
}

const memory = new Map<string, string>();
const safeStorage = {
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return memory.get(k) ?? null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      memory.set(k, v);
    }
  },
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      memory.delete(k);
    }
  },
};

export const useSaved = create<SavedState>()(
  persist(
    (set, get) => ({
      items: [],
      isSaved: (productId) => get().items.some((i) => i.productId === productId),
      save: (productId, placementId) =>
        set((s) => (s.items.some((i) => i.productId === productId) ? s : { items: [{ productId, placementId, at: Date.now() }, ...s.items] })),
      remove: (productId) => set((s) => ({ items: s.items.filter((i) => i.productId !== productId) })),
    }),
    {
      name: 'cameo.saved',
      version: 2,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ items: s.items }),
    },
  ),
);
