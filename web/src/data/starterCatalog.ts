import { brands } from './brands';
/** A starter photo (`brands.json` file name), shipped with the web app in `public/brands/`; every project's catalog uses the same files. */
export const starterPhotoUrl = (file: string) => `/brands/${file}?v=4`;
import type { Audience, Product } from '@/store/project';

/**
 * Starter catalog and audiences (no store imports, so `store/project` can seed from it):
 * three audiences and one product per brand per audience from `brands.json`. Nothing is gated on
 * these ids; the user can edit, remove or replace every one of them.
 */

export const STARTER_AUDIENCES: Audience[] = [
  { id: 'IN', name: 'India', kind: 'place' },
  { id: 'JP', name: 'Japan', kind: 'place' },
  { id: 'ID', name: 'Indonesia', kind: 'place' },
];

export type CategoryId = 'Beverage' | 'Snack' | 'Services' | 'Electronics' | 'Fashion';
export const CATEGORIES: readonly CategoryId[] = ['Beverage', 'Snack', 'Services', 'Electronics', 'Fashion'] as const;

/** Glyph keys for the generated packshot tile (rendered with Phosphor in ui/Packshot). */
export type GlyphId = 'coffee' | 'soda' | 'snack' | 'ride' | 'food' | 'travel' | 'pay' | 'earbuds' | 'tote' | 'shirt';

/* ---------- Sample seed (brands.json → one product per brand per sample market) ---------- */

const SHORT: Record<string, Record<string, string>> = {
  brewno: { IN: 'Masala Chai', JP: 'Matcha Latte', ID: 'Kopi Susu' },
  fizzup: { IN: 'Lemon-Lime Soda', JP: 'Yuzu Sparkling', ID: 'Lychee Soda' },
  munchbox: { IN: 'Masala Makhana', JP: 'Nori Rice Crackers', ID: 'Keripik Singkong' },
  plateful: { IN: 'Biryani delivery', JP: 'Ramen delivery', ID: 'Nasi goreng delivery' },
  wanderly: { IN: 'Goa getaways', JP: 'Okinawa trips', ID: 'Bali trips' },
  paysa: { IN: 'UPI wallet', JP: 'QR pay', ID: 'QRIS wallet' },
  tote: { IN: 'Floral Canvas Tote', JP: 'Botanical Canvas Tote', ID: 'Floral Tote Bag' },
  kora: { IN: 'Navy Crewneck', JP: 'Oatmeal Crewneck', ID: 'Forest Crewneck' },
  vela: { IN: 'Cropped Leather Jacket', JP: 'Cropped Leather Jacket', ID: 'Cropped Leather Jacket' },
};

export const GLYPH: Record<string, GlyphId> = {
  brewno: 'coffee', fizzup: 'soda', munchbox: 'snack',
  plateful: 'food', wanderly: 'travel', paysa: 'pay', tote: 'tote', kora: 'shirt', vela: 'shirt',
};

export function categoryOf(raw: string): CategoryId {
  const top = raw.split('/')[0];
  if (top === 'beverage') return 'Beverage';
  if (top === 'snack') return 'Snack';
  if (top === 'electronics') return 'Electronics';
  if (top === 'fashion') return 'Fashion';
  return 'Services';
}

/** Starter product id for a brand in a starter audience, e.g. `brewno-in`. */
const sampleProductId = (brandId: string, audienceId: string) => `${brandId}-${audienceId.toLowerCase()}`;

/** The starter products (one per brand per starter audience it sells to), each available in its own audience. `line` = brand id. */
export const STARTER_PRODUCTS: Product[] = brands.flatMap((b) =>
  STARTER_AUDIENCES.map((a) => a.id).flatMap((m) => {
    const raw = b.markets[m];
    if (!raw) return [];
    // Variant name without the label script or pack description: "Brewno Masala Chai cup, …" → "Masala Chai".
    const brand = raw.brand ?? b.name;
    const name = SHORT[b.id]?.[m] ?? raw.product.split(',')[0].replace(new RegExp(`^${brand}\\s+`), '').trim();
    // Local brands differ per market (Dhoop & Bean, Mameiro Coffee, Rimbara Kopi) but share the line, so they stay local versions of each other.
    return [{ id: sampleProductId(b.id, m), availableIn: [m], brand, name, category: categoryOf(b.category), url: raw.url, line: b.id, images: [raw.packshot, raw.screen, raw.logo].filter((x): x is string => !!x).map(starterPhotoUrl), description: raw.product }];
  }),
);

