import { useEffect, useRef } from 'react';
import { create } from 'zustand';

/** Open overlays, oldest first. Esc closes only the last one. */
const stack: symbol[] = [];

/** While `open`, this overlay is on the layer stack. Returns true from `isTop()` only when nothing opened after it. */
export function useLayer(open: boolean) {
  const id = useRef(Symbol('layer'));
  useEffect(() => {
    if (!open) return;
    const me = id.current;
    stack.push(me);
    return () => {
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
  return () => stack[stack.length - 1] === id.current;
}

/**
 * Where open sheets sit, so toasts never cover a sheet's footer: a desktop sheet reports the width
 * it takes from the right edge (px, margin included), a bottom sheet on phones reports -1.
 */
export const useSheetEdges = create<{ edges: Record<string, number>; set: (id: string, edge: number | null) => void }>()((set) => ({
  edges: {},
  set: (id, edge) =>
    set((s) => {
      const edges = { ...s.edges };
      if (edge === null) delete edges[id];
      else edges[id] = edge;
      return { edges };
    }),
}));
