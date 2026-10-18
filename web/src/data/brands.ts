import raw from './brands.json';
import type { Brand } from './types';

/** Per-brand hue for the generated logo mark. Muted on purpose: amber stays the only loud colour. */
const HUES: Record<string, number> = {
  brewno: 24,
  fizzup: 178,
  munchbox: 4,
  plateful: 340,
  wanderly: 205,
  paysa: 255,
  tote: 32,
};

function logoMark(name: string, hue: number): string {
  const initial = name.charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="hsl(${hue} 42% 34%)"/><text x="20" y="27.5" text-anchor="middle" font-family="Inter Tight, system-ui, sans-serif" font-size="20" font-weight="600" fill="hsl(${hue} 60% 92%)">${initial}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface RawBrand {
  id: string;
  name: string;
  category: string;
  placement_types: string[];
  scene_affinity: string[];
  exclusions: string[];
  /** Starter audiences the brand sells to; a missing one = no product there (Daawat House is India only). */
  /** packshot / screen / logo: starter photo file names in `web/public/brands/`. */
  markets: Record<string, { product: string; url: string; brand?: string; packshot?: string; screen?: string; logo?: string }>;
}

export const brands: Brand[] = (raw.brands as RawBrand[]).map((b) => {
  const hue = HUES[b.id] ?? 30;
  return {
    id: b.id,
    name: b.name,
    category: b.category,
    placementTypes: b.placement_types,
    sceneAffinity: b.scene_affinity,
    exclusions: b.exclusions,
    markets: b.markets,
    hue,
    logo: logoMark(b.name, hue),
  };
});
