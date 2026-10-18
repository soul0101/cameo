import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { seedScenes } from '@/features/scenes/model';
import { usePlacements } from './placements';
import { scopedKey } from '@/data/episode';

/**
 * Project working state: whether the episode was opened, the upload's name and the selected scene.
 * What goes into each scene lives only in `usePlacements` (boxes + default/overrides, read through
 * `resolve`). Every section is always reachable (no gating). Persisted per episode (`cameo-flow`).
 */

interface FlowState {
  /** True once the episode was opened after processing (its boxes were seeded). */
  sampleOpened: boolean;
  /** Name of the uploaded file. */
  uploadName: string | null;
  selectedSceneId: string;

  selectScene: (momentId: string) => void;
  setUploadName: (name: string | null) => void;
  /** Start over: the episode stays open, every box, assignment and approval is cleared and reseeded. */
  reset: () => void;
  /** First open of a processed episode: give its boxes Gemini's picks (only when no box has a product yet). */
  openSample: () => void;
}

const initial = {
  sampleOpened: false,
  uploadName: null,
  selectedSceneId: '',
};

export const useFlow = create<FlowState>()(
  persist(
    (set) => ({
      ...initial,

      selectScene: (selectedSceneId) => set({ selectedSceneId }),
      setUploadName: (uploadName) => set({ uploadName }),

      reset: () => {
        set({ ...initial, sampleOpened: true });
        usePlacements.getState().reset();
        seedScenes();
      },

      openSample: () => set({ sampleOpened: true }),
    }),
    {
      name: scopedKey('cameo-flow'),
      version: 2,
      partialize: (s) => ({ sampleOpened: s.sampleOpened, uploadName: s.uploadName, selectedSceneId: s.selectedSceneId }),
    },
  ),
);
