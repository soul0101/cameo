import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AudienceId } from './project';

interface UIState {
  /** The audience pages that share one (Watch, Scenes' "On video") start on. Any audience id. */
  market: AudienceId;
  setMarket: (m: AudienceId) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      market: '' as AudienceId,
      setMarket: (market) => set({ market }),
    }),
    { name: 'cameo-ui' },
  ),
);
