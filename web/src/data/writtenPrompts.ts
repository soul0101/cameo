import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { scopedKey } from './episode';

/**
 * Edit prompts Gemini wrote for products the producer put in a box (Gemini's own picks come with their
 * prompts). Written when Previews opens, keyed by box and product, so later edits in Scenes cost nothing.
 */
interface WrittenPrompts {
  prompts: Record<string, string>;
  /** Being written now (not persisted). */
  pending: Record<string, true>;
}

export const writtenKey = (boxId: string, productId: string) => `${boxId}|${productId}`;

export const useWrittenPrompts = create<WrittenPrompts>()(
  persist(() => ({ prompts: {}, pending: {} }), { name: scopedKey('cameo-written-prompts'), version: 1, partialize: (s) => ({ prompts: s.prompts }) }),
);
