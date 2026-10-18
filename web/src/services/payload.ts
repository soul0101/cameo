import { useProject } from '@/store/project';
import type { Audience, Product } from '@/store/project';
import type { ApiAudience, ApiProduct, ProjectPayload } from './api';

/** The browser's catalog and audiences in the contract's shapes (no images, no prices). */
export function projectPayload(products: Product[] = useProject.getState().products, audiences: Audience[] = useProject.getState().audiences): ProjectPayload {
  const catalog: ApiProduct[] = products.map((p) => ({ id: p.id, brand: p.brand, name: p.name, category: p.category, url: p.url, availableIn: p.availableIn, ...(p.description ? { description: p.description } : {}) }));
  const list: ApiAudience[] = audiences.map((a) => ({ id: a.id, name: a.name, kind: a.kind, ...(a.basedOn ? { basedOn: a.basedOn } : {}) }));
  return { catalog, audiences: list };
}

/** A stable signature of what matching depends on: change it and the stored matches are out of date. */
export function payloadSignature(p: ProjectPayload = projectPayload()): string {
  const products = [...p.catalog].sort((a, b) => a.id.localeCompare(b.id)).map((x) => [x.id, x.brand, x.name, x.category, x.availableIn]);
  const audiences = [...p.audiences].sort((a, b) => a.id.localeCompare(b.id)).map((x) => [x.id, x.name, x.kind, x.basedOn ?? '']);
  return JSON.stringify([products, audiences]);
}
