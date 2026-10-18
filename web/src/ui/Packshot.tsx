import { AirplaneTilt, Coffee, Cookie, Drop, ForkKnife, Headphones, QrCode, Taxi, Tote, TShirt } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { getProduct, productInAudience } from '@/data/catalog';
import type { GlyphId } from '@/data/catalog';
import { cx } from '@/lib/cx';

const GLYPHS: Record<GlyphId, Icon> = {
  coffee: Coffee, soda: Drop, snack: Cookie, ride: Taxi, food: ForkKnife, travel: AirplaneTilt, pay: QrCode, earbuds: Headphones, tote: Tote, shirt: TShirt,
};

/**
 * Packshot tile: the product's cover (`images[0]`) on a white plate, object-contain, else the generated stand-in. Brand hue square, the category glyph in a light
 * tint of the hue, inner top highlight. 24 px in chips, 48 in panels, 64 in catalog cards.
 * Brand hue appears only here.
 */
export function Packshot({ productId, audience, size = 24, className }: { productId: string; audience?: string; size?: number; className?: string }) {
  const p = (audience ? productInAudience(productId, audience) : undefined) ?? getProduct(productId);
  if (!p) return null;
  const radius = size >= 48 ? 12 : size >= 32 ? 8 : 6;
  if (p.packshot)
    return (
      <img
        src={p.packshot}
        alt={p.brand}
        draggable={false}
        style={{ width: size, height: size, borderRadius: radius, padding: Math.round(size * 0.06), filter: 'var(--plate-filter)' }}
        className={cx('shrink-0 bg-white object-contain shadow-[0_0_0_1px_var(--border)]', className)}
      />
    );
  const Glyph = GLYPHS[p.tile.glyph];
  const { hue } = p.tile;
  return (
    <span
      role="img"
      aria-label={p.brand}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `hsl(${hue} 36% 26%)`,
        color: `hsl(${hue} 70% 86%)`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.14), inset 0 0 0 1px rgba(255,255,255,.06)',
      }}
      className={cx('inline-flex shrink-0 items-center justify-center select-none', className)}
    >
      <Glyph size={Math.round(size * 0.56)} weight={size >= 48 ? 'light' : 'regular'} aria-hidden />
    </span>
  );
}
