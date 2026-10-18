import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AudienceId } from '@/store/project';
import { audienceList } from '@/features/audiences/model';
import { useFlow } from '@/store/flow';
import { usePlacements } from '@/store/placements';
import { useUI } from '@/store/ui';
import { sceneById, scenes } from './model';
import { pause, seek } from './player';
import { scopedKey } from '@/data/episode';

/** Page view: one scene on the stage, or every box of the episode in a table. */
export type ScenesView = 'scene' | 'table';

/**
 * Page-local state for Scenes: the scene under the playhead, the
 * selected box (its card in the Boxes panel; resizable when drawn), hover, drawing mode, and the version
 * whose products are tagged on the video. The clock itself lives in `player.ts`. Only the view
 * (Scene · Table) and the table's "Gaps only" are persisted (`cameo-scenes-ui`).
 */
interface ScenesUI {
  sceneId: string;
  /** The selected box (clicked on the video or its card), or null. */
  openBoxId: string | null;
  hoverBoxId: string | null;
  drawing: boolean;
  viewVersion: AudienceId;
  view: ScenesView;
  /** Table: only boxes with a gap. */
  gapsOnly: boolean;
  /** "More spots" is open: the scene's other detections show as pins on the frame. */
  moreOpen: boolean;

  /** The playhead crossed into another scene: swap the boxes, keep the open row only if it is in it. */
  follow: (sceneId: string) => void;
  /** User chose a scene (transport, keys): seek to its first frame. */
  goScene: (sceneId: string) => void;
  /** Select a box (or none with null). */
  openBox: (boxId: string | null) => void;
  toggleBox: (boxId: string) => void;
  hover: (boxId: string | null) => void;
  setDrawing: (on: boolean) => void;
  setViewVersion: (m: AudienceId) => void;
  setView: (view: ScenesView) => void;
  setGapsOnly: (on: boolean) => void;
  setMoreOpen: (on: boolean) => void;
}

/** A hair past the cut so the decoder shows this shot, not the last frame of the previous one. */
export const startOf = (sceneId: string) => (sceneById[sceneId]?.from ?? 0) + 0.05;

const inScene = (sceneId: string, boxId: string | null) => !!boxId && !!usePlacements.getState().boxes[sceneId]?.some((b) => b.id === boxId);

const initialScene = sceneById[useFlow.getState().selectedSceneId] ? useFlow.getState().selectedSceneId : (scenes[0]?.moment.id ?? '');

export const useScenesUI = create<ScenesUI>()(
  persist(
    (set, get) => ({
      sceneId: initialScene,
      openBoxId: null,
      hoverBoxId: null,
      drawing: false,
      viewVersion: (() => {
        const list = audienceList();
        const m = useUI.getState().market;
        return list.some((r) => r.id === m) ? m : (list[0]?.id ?? m);
      })(),
      view: 'scene',
      gapsOnly: false,
      moreOpen: false,

      follow: (sceneId) => {
        const s = get();
        if (s.sceneId === sceneId) return;
        const keep = inScene(sceneId, s.openBoxId);
        set({ sceneId, openBoxId: keep ? s.openBoxId : null, hoverBoxId: null, drawing: false });
        useFlow.getState().selectScene(sceneId);
      },
      goScene: (sceneId) => {
        get().follow(sceneId);
        seek(startOf(sceneId));
      },
      openBox: (openBoxId) => set((s) => (s.openBoxId === openBoxId ? s : { openBoxId })),
      toggleBox: (boxId) => get().openBox(get().openBoxId === boxId ? null : boxId),
      hover: (hoverBoxId) => set({ hoverBoxId }),
      setDrawing: (drawing) => {
        if (drawing) pause();
        set({ drawing });
      },
      setViewVersion: (viewVersion) => set({ viewVersion }),
      setView: (view) => {
        if (view === 'table') pause();
        set(view === 'table' ? { view, drawing: false, hoverBoxId: null } : { view });
      },
      setGapsOnly: (gapsOnly) => set({ gapsOnly }),
      setMoreOpen: (moreOpen) => set({ moreOpen }),
    }),
    { name: scopedKey('cameo-scenes-ui'), version: 1, partialize: (s) => ({ view: s.view, gapsOnly: s.gapsOnly }) },
  ),
);
