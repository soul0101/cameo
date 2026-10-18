import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { activeEpisodeId, activeRecord, withMedia } from '@/data/episode';
import type { EpisodeRecord } from '@/data/episode';
import type { DetectedFile } from '@/data/detected';
import { STARTER_AUDIENCES, STARTER_PRODUCTS } from '@/data/starterCatalog';
import type { CategoryId } from '@/data/starterCatalog';

/**
 * Project state: the open project, its
 * audiences (one flat list; every audience in it is in the episode, there is no on/off toggle) and
 * one product library for the episode. A product is available to every audience or to some.
 * Persisted as `cameo-project`. Box assignments live in `usePlacements`.
 */

export type { EpisodeRecord };

/** Audience id: any string (the starter audiences use `IN`, `JP`, `ID`; added ones get `a-…`). */
export type AudienceId = string;

/** What an audience is cut along. It only sets the icon and the name placeholder. */
export type AudienceKind = 'place' | 'platform' | 'segment' | 'sponsor' | 'test' | 'custom';

/** Who sees a version of the episode. */
export interface Audience {
  id: AudienceId;
  name: string;
  kind: AudienceKind;
  /** Optional one line: "Who sees it". */
  note?: string;
  /**
   * This audience also sees every product available in `basedOn` (recursively). Absent = its own
   * products only.
   */
  basedOn?: AudienceId;
}

/** A product in the episode's library. Never a price. */
export interface Product {
  id: string;
  /** Brand name, shared across products as a plain string. */
  brand: string;
  name: string;
  category: CategoryId;
  url: string;
  /**
   * Ordered image URLs or data URLs (uploads, downscaled to ≤ 1200 px
   * JPEG). `images[0]` is the cover; at most 8. Empty = generated brand tile.
   * Screens read the cover through `CatalogProduct.packshot` / `ui/Packshot`.
   */
  images: string[];
  /** `'all'` (the default for new products) or the audiences it is sold to. */
  availableIn: 'all' | AudienceId[];
  /**
   * Local versions of one product share a line (the starter catalog's per-audience products share
   * their brand id), so a box falls back to the local version. User products use their own id. Never shown.
   */
  line: string;
  /** How the product looks, in words (pack, colours, label text): used in Gemini's match and Nano Banana's edit prompts. */
  description?: string;
}

/* ---------- Store ---------- */

interface ProjectState {
  projectId: string;
  /** Display name (sidebar switcher, breadcrumbs). Defaults to the episode title. */
  name: string;
  /** Every audience of the episode, in display order. Never empty. */
  audiences: Audience[];
  /** True once the user pressed Catalog's "Continue to scenes". No longer gates anything. */
  versionsConfirmed: boolean;
  products: Product[];
  /** Starter product ids this browser has been given (see the top-up below the store). */
  starterGiven?: string[];
  lastOpened: number | null;
  /**
   * Every episode in this browser, with its media URLs and its cached detection output
   * (`detected`, null until processed).
   */
  episodes: EpisodeRecord[];
  /** The episode the last page load worked on (boot picks the URL's episode first). */
  activeEpisodeId: string;

  /** Add or replace an episode record. */
  saveEpisode: (rec: EpisodeRecord) => void;
  /** Cache an episode's detection output (replaces any previous one) and what it was matched against. */
  setEpisodeDetected: (id: string, detected: DetectedFile, match?: { matchId: string; matchedWith: string }) => void;
  /** Forget an episode. */
  removeEpisode: (id: string) => void;

  confirmVersions: () => void;
  /** Add an audience; it inherits every box default at once. Returns the new audience. */
  addAudience: (a: { name: string; kind: Audience['kind']; note?: string; basedOn?: AudienceId }) => Audience;
  /** Patch name / kind / note / basedOn (`basedOn: undefined` clears it; a cycle is refused). */
  updateAudience: (id: AudienceId, patch: Partial<Omit<Audience, 'id'>>) => void;
  renameAudience: (id: AudienceId, name: string) => void;
  /**
   * Remove an audience (at least one stays): drops its id from every product's `availableIn` and
   * re-points audiences based on it to its own `basedOn` (or none).
   * Box overrides for it are dropped by the placements store, which follows this list.
   */
  removeAudience: (id: AudienceId) => void;
  addProduct: (p: Omit<Product, 'id' | 'line'>) => Product;
  updateProduct: (id: string, patch: Partial<Omit<Product, 'id' | 'line'>>) => void;
  removeProduct: (id: string) => void;
  /** Put a removed product back (toast Undo). */
  restoreProduct: (p: Product, index?: number) => void;
  rename: (name: string) => void;
  touch: () => void;
  reset: () => void;
}

const initial = {
  projectId: activeEpisodeId,
  name: activeRecord.name,
  episodes: [] as EpisodeRecord[],
  activeEpisodeId,
  audiences: STARTER_AUDIENCES,
  versionsConfirmed: false,
  products: STARTER_PRODUCTS,
  /** Starter product ids this browser has been given (so a removed one stays removed, and new ones still arrive). */
  starterGiven: STARTER_PRODUCTS.map((p) => p.id),
  lastOpened: null as number | null,
};

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'audience';
/** True when making `id` based on `basedOn` would loop back to `id`. */
const wouldCycle = (audiences: Audience[], id: AudienceId, basedOn: AudienceId | undefined) => {
  const seen = new Set<AudienceId>();
  for (let cur = basedOn; cur; cur = audiences.find((a) => a.id === cur)?.basedOn) {
    if (cur === id || seen.has(cur)) return true;
    seen.add(cur);
  }
  return false;
};

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const MAX_IMAGES = 8;

export const useProject = create<ProjectState>()(
  persist(
    (set, get) => ({
      ...initial,
      saveEpisode: (rec) =>
        set((s) => ({ episodes: s.episodes.some((e) => e.id === rec.id) ? s.episodes.map((e) => (e.id === rec.id ? rec : e)) : [...s.episodes, rec] })),
      setEpisodeDetected: (id, detected, match) =>
        set((s) => ({ episodes: s.episodes.map((e) => (e.id === id ? { ...e, detected, processedAt: Date.now(), ...(match ?? {}) } : e)) })),
      removeEpisode: (id) => set((s) => ({ episodes: s.episodes.filter((e) => e.id !== id) })),
      confirmVersions: () => set({ versionsConfirmed: true }),
      addAudience: ({ name, kind, note, basedOn }) => {
        const s = get();
        const taken = new Set(s.audiences.map((x) => x.id));
        let id = `a-${slug(name)}`;
        for (let i = 2; taken.has(id); i++) id = `a-${slug(name)}-${i}`;
        const base = basedOn && taken.has(basedOn) ? basedOn : undefined;
        const audience: Audience = { id, name: name.trim() || 'Audience', kind, ...(note?.trim() ? { note: note.trim() } : {}), ...(base ? { basedOn: base } : {}) };
        set({ audiences: [...s.audiences, audience] });
        return audience;
      },
      updateAudience: (id, patch) =>
        set((s) => ({
          audiences: s.audiences.map((a) => {
            if (a.id !== id) return a;
            const next = { ...a, ...patch, name: (patch.name ?? a.name).trim() || a.name };
            if (!next.note?.trim()) delete next.note;
            if ('basedOn' in patch) {
              const ok = !!patch.basedOn && s.audiences.some((x) => x.id === patch.basedOn) && !wouldCycle(s.audiences, id, patch.basedOn);
              if (ok) next.basedOn = patch.basedOn;
              else if (!patch.basedOn) delete next.basedOn;
              else next.basedOn = a.basedOn;
            }
            if (!next.basedOn) delete next.basedOn;
            return next;
          }),
        })),
      renameAudience: (id, name) => get().updateAudience(id, { name }),
      removeAudience: (id) =>
        set((s) => {
          const gone = s.audiences.find((a) => a.id === id);
          if (!gone || s.audiences.length <= 1) return s;
          // Audiences based on the removed one now see what it saw (its own basedOn), or their own products.
          const audiences = s.audiences
            .filter((a) => a.id !== id)
            .map((a) => {
              if (a.basedOn !== id) return a;
              const next = { ...a };
              if (gone.basedOn && gone.basedOn !== a.id) next.basedOn = gone.basedOn;
              else delete next.basedOn;
              return next;
            });
          const products = s.products.map((p) => (p.availableIn !== 'all' && p.availableIn.includes(id) ? { ...p, availableIn: p.availableIn.filter((x) => x !== id) } : p));
          return { audiences, products };
        }),
      addProduct: (p) => {
        const id = uid('p');
        const product: Product = { ...p, id, line: id };
        set((s) => ({ products: [product, ...s.products] }));
        return product;
      },
      updateProduct: (id, patch) => set((s) => ({ products: s.products.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
      removeProduct: (id) => set((s) => ({ products: s.products.filter((p) => p.id !== id) })),
      restoreProduct: (p, index = 0) =>
        set((s) => {
          if (s.products.some((x) => x.id === p.id)) return s;
          const products = [...s.products];
          products.splice(Math.min(index, products.length), 0, p);
          return { products };
        }),
      rename: (name) =>
        set((s) => {
          const next = name.trim() || activeRecord.name;
          return { name: next, episodes: s.episodes.map((e) => (e.id === activeEpisodeId ? { ...e, name: next } : e)) };
        }),
      touch: () => set({ lastOpened: Date.now() }),
      reset: () => set({ audiences: STARTER_AUDIENCES, versionsConfirmed: false, products: STARTER_PRODUCTS, starterGiven: STARTER_PRODUCTS.map((p) => p.id) }),
    }),
    {
      name: 'cameo-project',
      version: 10,
      partialize: (s) => ({
        projectId: s.projectId,
        name: s.name,
        episodes: s.episodes,
        activeEpisodeId: s.activeEpisodeId,
        audiences: s.audiences,
        versionsConfirmed: s.versionsConfirmed,
        products: s.products,
        starterGiven: s.starterGiven,
        lastOpened: s.lastOpened,
      }),
    },
  ),
);

// Starter products added since this browser saved its catalog (a new sample brand) arrive on their own;
// ones it has had before and removed stay removed. Saves from before `starterGiven` count what they hold as seen.
{
  const s = useProject.getState();
  // What this browser actually saved (the store's own default would claim every starter product was seen).
  let saved: string[] | undefined;
  try {
    saved = (JSON.parse(localStorage.getItem('cameo-project') ?? 'null') as { state?: { starterGiven?: string[] } } | null)?.state?.starterGiven;
  } catch {
    /* storage blocked: a fresh catalog already has every starter product */
  }
  const seen = new Set(saved ?? s.products.map((p) => p.id));
  const fresh = STARTER_PRODUCTS.filter((p) => !seen.has(p.id) && !s.products.some((x) => x.id === p.id));
  if (fresh.length || !saved) useProject.setState({ products: [...s.products, ...fresh], starterGiven: [...new Set([...seen, ...STARTER_PRODUCTS.map((p) => p.id)])] });
}

// The page load's episode: remember it, and show its name (the project name is the episode's).
// Media URLs follow the current API.
{
  const s = useProject.getState();
  const episodes = s.episodes.filter((e) => e?.id && e.media).map(withMedia);
  const rec = episodes.find((e) => e.id === activeEpisodeId);
  useProject.setState({ episodes, activeEpisodeId, projectId: activeEpisodeId, name: rec?.name ?? activeRecord.name });
}
