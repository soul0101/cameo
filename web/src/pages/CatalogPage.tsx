/** Catalog page: the implementation lives in features/catalog-page (audiences, products, sheets). */
import CatalogView from '@/features/catalog-page/CatalogView';
import { CatalogSkeleton, Loadable } from '@/ui';

export default function CatalogPage() {
  return (
    <Loadable ready skeleton={<CatalogSkeleton />}>
      <CatalogView />
    </Loadable>
  );
}
