import { useMemo } from 'react';
import { brands } from './brands';
import { momentById } from './scenes';
import type { Brand, Moment, Surface } from './types';
import { GLYPH, starterPhotoUrl } from './starterCatalog';
import { useProject } from '@/store/project';
import type { Audience, AudienceId, Product } from '@/store/project';

/**
 * The catalog: one product library in `useProject().products`,
 * each product available to every audience (`'all'`) or to some. The sample starts from brands.json
 * (`starterCatalog.ts`).
 *
 * Each product carries a `line`: local versions of one product share it (the starter catalog's
 * per-audience products share their brand id), so a box falls back to the local version in an
 * audience the default is not sold to. User products use their own id. The UI never shows lines.
 */

export { CATEGORIES } from './starterCatalog';
export type { CategoryId, GlyphId } from './starterCatalog';
import type { CategoryId, GlyphId } from './starterCatalog';

/** A product as screens read it: the stored product plus derived display and matching fields. */
export interface CatalogProduct extends Product {
  /** The cover (`images[0]`), or null for the generated brand tile. Read-only alias kept for screens that show one image. */
  packshot: string | null;
  /** Flow key (same as `line`). Kept under this name so flow readers stay unchanged. */
  brandId: string;
  /** Brand + name, e.g. "Brewno Masala Chai" (name alone when it already starts with the brand). */
  full: string;
  /** Sub-category for search ("Coffee", "Ride-hailing"), else the category. */
  kind: string;
  tile: { hue: number; glyph: GlyphId };
  affinity: string[];
  placementTypes: string[];
  exclusions: string[];
}

const brandByLine: Record<string, Brand> = Object.fromEntries(brands.map((b) => [b.id, b]));

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- Derived fields ---------- */

/** Category defaults for products without brands.json data: scene words and surfaces they suit. */
const CATEGORY_AFFINITY: Record<CategoryId, string[]> = {
  Beverage: ['cafe', 'morning', 'street', 'shop', 'home'],
  Snack: ['cafe', 'home', 'shop', 'travel'],
  Services: ['street', 'home', 'shop'],
  Electronics: ['home', 'street', 'cafe'],
  Fashion: ['street', 'cafe', 'shop', 'travel'],
};
const CATEGORY_TYPES: Record<CategoryId, string[]> = {
  Beverage: ['tabletop', 'held_item', 'shelf', 'fridge'],
  Snack: ['tabletop', 'held_item', 'shelf'],
  Services: ['poster', 'billboard', 'phone_screen', 'counter_sign'],
  Electronics: ['held_item', 'tabletop', 'poster'],
  Fashion: ['held_item', 'wardrobe', 'shoulder_bag'],
};
const GLYPH_FOR: Record<CategoryId, GlyphId> = { Beverage: 'soda', Snack: 'snack', Services: 'pay', Electronics: 'earbuds', Fashion: 'tote' };

/** Stable hue for a brand name (generated tiles for user brands). */
export const hueOf = (s: string) => [...s.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
/** "Brewno" + "Masala Chai" → "Brewno Masala Chai". Never repeats words: "Rimbara Kopi" + "Kopi Susu" → "Rimbara Kopi Susu", "Lumen" + "Lumen Buds" → "Lumen Buds". */
const fullName = (brand: string, name: string) => {
  const b = brand.trim();
  if (!b) return name;
  const bw = b.split(/\s+/);
  const nw = name.split(/\s+/);
  for (let k = Math.min(bw.length, nw.length); k > 0; k--) {
    if (bw.slice(-k).join(' ').toLowerCase() === nw.slice(0, k).join(' ').toLowerCase()) return [...bw, ...nw.slice(k)].join(' ');
  }
  return `${b} ${name}`;
};

const STARTER = /\/(?:assets\/)?brands\/([a-z0-9-]+\.(?:jpg|png))(?:\?v=\d+)?$/;
const rebaseStarter = (url: string) => {
  const m = STARTER.exec(url);
  return m ? starterPhotoUrl(m[1]) : url;
};

const derivedCache = new WeakMap<Product, CatalogProduct>();
/** Stored product → screen product (memoised per stored object). */
function derive(p: Product): CatalogProduct {
  const hit = derivedCache.get(p);
  if (hit) return hit;
  const b = brandByLine[p.line];
  const own = p.brand.trim().toLowerCase();
  // Sample lines carry a local brand per market (Mameiro Coffee in Japan for line `brewno`): any of them counts.
  const sameBrand = !!b && [b.name, ...Object.values(b.markets).map((m) => m.brand ?? '')].some((n) => n.toLowerCase() === own);
  // Photos: what the product has saved (a saved starter URL follows the current files), else, for a
  // starter product saved while it had none, its starter photos from brands.json.
  const market = sameBrand && Array.isArray(p.availableIn) ? b.markets[p.availableIn[0]] : undefined;
  const saved = (p.images ?? []).map(rebaseStarter);
  const images = saved.length ? saved : market ? [market.packshot, market.screen, market.logo].filter((x): x is string => !!x).map(starterPhotoUrl) : [];
  const out: CatalogProduct = {
    ...p,
    images,
    packshot: images[0] ?? null,
    // Starter products saved before descriptions existed take their look from brands.json.
    description: p.description ?? (sameBrand && Array.isArray(p.availableIn) ? b.markets[p.availableIn[0]]?.product : undefined),
    brandId: p.line,
    full: fullName(p.brand, p.name),
    kind: sameBrand ? titleCase(b.category.split('/')[1] ?? b.category.split('/')[0]) : p.category,
    tile: { hue: sameBrand ? b.hue : hueOf(p.brand || p.name), glyph: (sameBrand && GLYPH[b.id]) || GLYPH_FOR[p.category] || 'snack' },
    affinity: sameBrand ? b.sceneAffinity : CATEGORY_AFFINITY[p.category] ?? [],
    placementTypes: sameBrand ? b.placementTypes : CATEGORY_TYPES[p.category] ?? ['tabletop'],
    exclusions: sameBrand ? b.exclusions : ['grief'],
  };
  derivedCache.set(p, out);
  return out;
}

/* ---------- Lookups ---------- */

/* ---------- Availability with "Sees products from" ---------- */

const chainCache = new WeakMap<Audience[], Map<AudienceId, AudienceId[]>>();

/**
 * The audience and every audience it sees products from, nearest first: Variant B (based on India)
 * → ['a-variant-b', 'IN']. Follows `basedOn` recursively and stops at a cycle or an unknown id.
 * Memoised per audience list (the store replaces the array on every change).
 */
export function audienceChain(audienceId: AudienceId, audiences: Audience[] = useProject.getState().audiences): AudienceId[] {
  let memo = chainCache.get(audiences);
  if (!memo) chainCache.set(audiences, (memo = new Map()));
  const hit = memo.get(audienceId);
  if (hit) return hit;
  const chain: AudienceId[] = [audienceId];
  for (let cur = audiences.find((a) => a.id === audienceId)?.basedOn; cur && !chain.includes(cur); cur = audiences.find((a) => a.id === cur)?.basedOn) {
    if (!audiences.some((a) => a.id === cur)) break;
    chain.push(cur);
  }
  memo.set(audienceId, chain);
  return chain;
}

/**
 * True when the product is sold to this audience: `availableIn` is 'all', lists it, or lists an
 * audience it sees products from (`basedOn`, recursively). Reads the live audience list unless one
 * is given.
 */
export const isAvailable = (p: Pick<Product, 'availableIn'>, audienceId: AudienceId, audiences?: Audience[]): boolean =>
  p.availableIn === 'all' || audienceChain(audienceId, audiences).some((id) => (p.availableIn as AudienceId[]).includes(id));

const brandKey = (p: Pick<Product, 'brand'>) => p.brand.trim().toLowerCase();

/** A snapshot of the library with the lookups resolve needs. Rebuilt when the stored list changes. */
export interface CatalogIndex {
  products: CatalogProduct[];
  byId: Record<string, CatalogProduct>;
  /** line → products of that line (sample: one per market). */
  byLine: Record<string, CatalogProduct[]>;
  /** lower-cased brand name → products. */
  byBrand: Record<string, CatalogProduct[]>;
}

const indexCache = new WeakMap<Product[], CatalogIndex>();
/** Index over a stored product list (memoised per array). */
export function indexOf(stored: Product[]): CatalogIndex {
  const hit = indexCache.get(stored);
  if (hit) return hit;
  const products = stored.map(derive);
  const byId: Record<string, CatalogProduct> = {};
  const byLine: CatalogIndex['byLine'] = {};
  const byBrand: CatalogIndex['byBrand'] = {};
  for (const p of products) {
    byId[p.id] = p;
    (byLine[p.line] ??= []).push(p);
    (byBrand[brandKey(p)] ??= []).push(p);
  }
  const ix = { products, byId, byLine, byBrand };
  indexCache.set(stored, ix);
  return ix;
}

/** The live index (non-reactive). */
export const liveIndex = (): CatalogIndex => indexOf(useProject.getState().products);

/**
 * Same brand, available in the audience: the product a box falls back to there (`local` in
 * `resolve`). Prefers the same line (the sample's per-market products), then the same category.
 */
export function siblingWith(ix: CatalogIndex, p: CatalogProduct, audienceId: AudienceId): CatalogProduct | undefined {
  // Local versions first (same line: Dhoop & Bean → Mameiro Coffee → Rimbara Kopi), then the same brand.
  const fits = (x: CatalogProduct) => x.id !== p.id && isAvailable(x, audienceId);
  const sameLine = (ix.byLine[p.line] ?? []).filter(fits);
  const pool = (ix.byBrand[brandKey(p)] ?? []).filter(fits);
  return sameLine[0] ?? pool.find((x) => x.category === p.category) ?? pool[0];
}

/** Any product by product id, or by line: then the line's first product. */
export function getProduct(id: string | null | undefined): CatalogProduct | undefined {
  if (!id) return undefined;
  const ix = liveIndex();
  return ix.byId[id] ?? ix.byLine[id]?.[0];
}

/**
 * The product a line (or product id) shows in an audience: the product itself when available
 * there, else a product of the same line that is, else undefined.
 */
export function productInAudience(lineOrId: string | null | undefined, audienceId: AudienceId): CatalogProduct | undefined {
  if (!lineOrId) return undefined;
  const ix = liveIndex();
  const own = ix.byId[lineOrId];
  if (own && isAvailable(own, audienceId)) return own;
  return (ix.byLine[own?.line ?? lineOrId] ?? []).find((p) => isAvailable(p, audienceId));
}

/** Every brand name in the catalog, unique, sorted (Brand autocomplete). */
const brandNames = (products: CatalogProduct[]) => [...new Set(products.map((p) => p.brand.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/**
 * The live catalog for React: `allProducts`, `byId`, `brands` (names for autocomplete),
 * `availableIn(productId, audienceId)`, `productsFor(audienceId)` (available there, `basedOn` included) and
 * `siblingIn(productId, audienceId)` (same brand, available there, same category preferred).
 */
export function useCatalog() {
  const stored = useProject((s) => s.products);
  // Availability follows `basedOn`, so the lookups are rebuilt when the audience list changes too.
  const audiences = useProject((s) => s.audiences);
  return useMemo(() => {
    const ix = indexOf(stored);
    const forCache: Record<AudienceId, CatalogProduct[]> = {};
    return {
      allProducts: ix.products,
      byId: ix.byId,
      brands: brandNames(ix.products),
      availableIn: (productId: string, audienceId: AudienceId) => !!ix.byId[productId] && isAvailable(ix.byId[productId], audienceId, audiences),
      productsFor: (audienceId: AudienceId) => (forCache[audienceId] ??= ix.products.filter((p) => isAvailable(p, audienceId, audiences))),
      siblingIn: (productId: string, audienceId: AudienceId) => (ix.byId[productId] ? siblingWith(ix, ix.byId[productId], audienceId) : undefined),
    };
  }, [stored, audiences]);
}

/* ---------- Catalog "Place in scenes": scene affinity × placement types (a local rule, not a model) ---------- */

/** Moment tags → scene words (brands.json scene_affinity vocabulary). */
const TAG_TO_AFFINITY: Record<string, string> = {
  'café': 'cafe', morning: 'morning', street: 'street', dusk: 'street', home: 'home', night: 'night',
  doorway: 'home', shop: 'shop', counter: 'shop', payment: 'shop',
};

/** What each surface can physically carry (placement types). */
export const SURFACE_TYPES: Record<Surface, string[]> = {
  table: ['tabletop', 'held_item'],
  wall: ['poster', 'billboard'],
  street: ['billboard', 'street_sign', 'poster'],
  screen: ['laptop_screen', 'phone_screen'],
  hand: ['held_item', 'delivery_box'],
  counter: ['counter_sign', 'shelf', 'fridge', 'tabletop'],
  wardrobe: [],
};

function sceneWords(m: Moment): string[] {
  const words = new Set<string>();
  m.tags.forEach((t) => TAG_TO_AFFINITY[t] && words.add(TAG_TO_AFFINITY[t]));
  if (m.scene === 'Apartment') words.add('home');
  if (m.scene === 'Shop') words.add('shop');
  if (m.scene === 'Café') words.add('cafe');
  if (m.scene === 'Street') words.add('street');
  return [...words];
}

/** Scene words a product shares with a moment (0 = none, and `excluded` = the moment has a tag the product avoids). */
export function sceneAffinity(p: CatalogProduct, momentId: string): { words: number; excluded: boolean } {
  const m = momentById[momentId];
  if (!m) return { words: 0, excluded: false };
  const words = sceneWords(m);
  return { words: p.affinity.filter((a) => words.includes(a)).length, excluded: p.exclusions.some((x) => m.tags.includes(x)) };
}
