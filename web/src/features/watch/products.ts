import { getProduct } from '@/data/catalog';
import type { Placement } from '@/data/types';

export interface ProductLabel {
  /** The product shown (catalog id; '' when it was removed from the catalog). */
  id: string;
  brand: string;
  name: string;
  full: string;
  /** Brand product page (products never show a price). */
  url: string;
}

/** Shop copy for a placed product. */
export function productLabel(p: Placement): ProductLabel {
  const product = getProduct(p.productId);
  if (!product) return { id: '', brand: '', name: p.object, full: p.object, url: '' };
  return { id: product.id, brand: product.brand, name: product.name, full: product.full, url: product.url };
}
