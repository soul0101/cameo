import { useMemo } from 'react';
import { indexOf } from '@/data/catalog';
import { resolveWith, usePlacements } from '@/store/placements';
import { useProject } from '@/store/project';
import type { Audience, AudienceId, AudienceKind, Product } from '@/store/project';

/** "Used in n scenes" per product id: scenes where some box resolves to the product for some audience. */
export function useSceneUsage(): Record<string, number> {
  const boxes = usePlacements((s) => s.boxes);
  const assign = usePlacements((s) => s.assign);
  const audiences = useProject((s) => s.audiences);
  const products = useProject((s) => s.products);
  return useMemo(() => {
    const ix = indexOf(products);
    const scenes: Record<string, Set<string>> = {};
    for (const [momentId, list] of Object.entries(boxes)) {
      for (const b of list) {
        for (const a of audiences) {
          const p = resolveWith(assign[b.id], a.id, ix).product;
          if (p) (scenes[p.id] ??= new Set()).add(momentId);
        }
      }
    }
    return Object.fromEntries(Object.entries(scenes).map(([id, set]) => [id, set.size]));
  }, [boxes, assign, audiences, products]);
}

/**
 * The card's availability line: "All audiences", "Japan",
 * "Japan, Indonesia" or "Japan +2". `first` (the filtered audience) leads when listed. `kind` is the
 * kind of the first named audience (its icon leads the line); null = every audience.
 */
export function availabilityLine(availableIn: Product['availableIn'], audiences: Audience[], first?: AudienceId | null): { text: string; full: string; kind: AudienceKind | null; none: boolean } {
  if (availableIn === 'all') return { text: 'All audiences', full: 'All audiences', kind: null, none: false };
  const listed = audiences.filter((a) => availableIn.includes(a.id));
  if (!listed.length) return { text: 'No audience yet', full: 'Not available to any audience', kind: null, none: true };
  const lead = listed.find((a) => a.id === first);
  const ordered = lead ? [lead, ...listed.filter((a) => a !== lead)] : listed;
  const names = ordered.map((a) => a.name);
  const text = names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1}`;
  return { text, full: names.join(', '), kind: ordered[0].kind, none: false };
}
