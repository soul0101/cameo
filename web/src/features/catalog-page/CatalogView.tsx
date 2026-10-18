import { useCallback, useState } from 'react';
import { RematchBanner } from '@/features/processing/Rematch';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowElbowDownRight, ArrowRight, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { CATEGORIES, useCatalog } from '@/data/catalog';
import type { CatalogProduct, CategoryId } from '@/data/catalog';
import { episode } from '@/data/episode';
import { ALL_AUDIENCES, AudienceBar } from '@/features/audiences/AudienceBar';
import { audienceCount, basisOf, useAudiences } from '@/features/audiences/model';
import { cx } from '@/lib/cx';
import { useProject } from '@/store/project';
import { sectionPath } from '@/shell/sections';
import { Button, EmptyState, Input, PageHeader, toast } from '@/ui';
import { PlaceSheet } from './PlaceSheet';
import { ProductCard } from './ProductCard';
import { ProductSheet } from './ProductSheet';
import { ProductViewer } from './ProductViewer';
import { availabilityLine, useSceneUsage } from './usage';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Catalog: header fact "24 products · 3 audiences"; "Who's watching" +
 * the AudienceBar with "All" first (filters the grid by availability, `basedOn` included, and
 * manages audiences; `?audience=` keeps it in the URL); search, category chips and "Add product";
 * one grid of product cards. ⋯ on a card: Edit, Place in scenes…, Remove. Primary: Continue to scenes.
 */
export default function CatalogView() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { allProducts, productsFor, brands } = useCatalog();
  const audiences = useAudiences();
  const usage = useSceneUsage();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryId | 'All'>('All');
  const [sheet, setSheet] = useState<{ open: boolean; product: CatalogProduct | null }>({ open: false, product: null });
  const [placing, setPlacing] = useState<{ open: boolean; product: CatalogProduct | null }>({ open: false, product: null });
  const closeSheet = useCallback(() => setSheet((s) => ({ ...s, open: false })), []);
  const closePlace = useCallback(() => setPlacing((s) => ({ ...s, open: false })), []);
  const [viewing, setViewing] = useState<{ open: boolean; product: CatalogProduct | null; index: number }>({ open: false, product: null, index: 0 });
  const closeViewer = useCallback(() => setViewing((s) => ({ ...s, open: false })), []);
  const editFromViewer = () => {
    setViewing((v) => ({ ...v, open: false }));
    setSheet({ open: true, product: viewing.product });
  };

  const wanted = params.get('audience');
  const audience = audiences.find((a) => a.id === wanted) ?? null;
  const basis = basisOf(audience, audiences);
  const filter = audience?.id ?? ALL_AUDIENCES;
  const select = (id: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (id === ALL_AUDIENCES) next.delete('audience');
        else next.set('audience', id);
        return next;
      },
      { replace: true },
    );

  const shown = audience ? productsFor(audience.id) : allProducts;
  const q = query.trim().toLowerCase();
  const items = shown
    .filter((p) => category === 'All' || p.category === category)
    .filter((p) => !q || [p.brand, p.name, p.kind, p.category].some((s) => s.toLowerCase().includes(q)));
  const filtered = !!q || category !== 'All';

  const removeProduct = (p: CatalogProduct) => {
    const s = useProject.getState();
    const index = s.products.findIndex((x) => x.id === p.id);
    const stored = s.products[index];
    s.removeProduct(p.id);
    toast({ title: `Removed ${p.name}`, action: { label: 'Undo', onClick: () => stored && useProject.getState().restoreProduct(stored, index) } });
  };

  const add = () => setSheet({ open: true, product: null });
  const clear = () => (setQuery(''), setCategory('All'));

  const proceed = () => {
    useProject.getState().confirmVersions();
    navigate(sectionPath(projectId, 'scenes'));
  };

  const empty = () => {
    if (allProducts.length === 0)
      return (
        <EmptyState
          title="No products yet"
          body="Add the products you want to place in the episode."
          actions={
            <Button variant="primary" icon={<Plus />} onClick={add}>
              Add product
            </Button>
          }
        />
      );
    if (audience && shown.length === 0)
      return (
        <EmptyState
          title={`Nothing available in ${audience.name} yet`}
          body={`Add a product for ${audience.name}, or let it see another audience’s products from its ⋯ menu.`}
          actions={
            <>
              <Button variant="ghost" onClick={() => select(ALL_AUDIENCES)}>
                Show all products
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={add}>
                Add for {audience.name}
              </Button>
            </>
          }
        />
      );
    return (
      <EmptyState
        title={q ? `No products match “${query.trim()}”` : `No ${category.toLowerCase()} products${audience ? ` in ${audience.name}` : ''}`}
        body={audience ? `${plural(shown.length, 'product')} available in ${audience.name}.` : `${plural(shown.length, 'product')} in the catalog.`}
        actions={
          <>
            <Button variant="ghost" onClick={clear}>
              Clear filters
            </Button>
            <Button icon={<Plus />} onClick={add}>
              Add product
            </Button>
          </>
        }
      />
    );
  };

  return (
    <div className="flex flex-col">
      <PageHeader
        crumbs={[{ label: episode.title, to: sectionPath(projectId, 'scenes') }, { label: 'Catalog' }]}
        title="Catalog"
        fact={`${plural(allProducts.length, 'product')} · ${audienceCount(audiences.length)}`}
        primary={
          <Button variant="primary" trailing={<ArrowRight />} onClick={proceed}>
            Continue to scenes
          </Button>
        }
      />

      <RematchBanner className="mb-4" />

      <div className="flex min-w-0 items-center gap-3 max-md:flex-col max-md:items-start max-md:gap-1.5">
        <span className="shrink-0 text-13 font-medium text-text-3">Who’s watching</span>
        <AudienceBar label="Who’s watching" includeAll manage value={filter} onChange={select} className="max-w-full min-w-0 max-md:-mx-1" />
      </div>

      <section aria-label="Products" className="flex flex-col pt-6">
        <div className="flex flex-wrap items-center gap-3 pb-3">
          <Input
            icon={<MagnifyingGlass />}
            placeholder="Search products"
            aria-label="Search products"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))}
            className="w-[240px] max-md:h-11 max-md:w-full"
          />
          <div role="radiogroup" aria-label="Category" className="no-scrollbar flex gap-1.5 overflow-x-auto max-md:-mx-4 max-md:w-[calc(100%+32px)] max-md:px-4">
            {(['All', ...CATEGORIES.filter((c) => allProducts.some((p) => p.category === c))] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                onClick={() => setCategory(c)}
                className={cx(
                  'h-8 shrink-0 rounded-[10px] border px-3 text-13 font-medium transition-[background-color,color,border-color] duration-200 ease-cameo max-md:h-11',
                  category === c ? 'border-transparent bg-text text-surface' : 'border-border bg-surface-2/60 text-text-2 hover:bg-surface-3 hover:text-text',
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <Button icon={<Plus />} onClick={add} className="md:ml-auto max-md:h-11 max-md:w-full">
            Add product
          </Button>
        </div>

        <p className="flex min-h-5 items-center gap-1.5 pb-4 text-13 text-text-3" aria-live="polite">
          {items.length === 0 ? null : audience ? (
            <>
              {plural(items.length, 'product')} available in {audience.name}
              {basis && (
                <span className="inline-flex items-center gap-1">
                  <ArrowElbowDownRight size={14} aria-hidden className="ml-1" />
                  includes {basis.name}’s
                </span>
              )}
            </>
          ) : filtered ? (
            `${plural(items.length, 'product')} of ${allProducts.length}`
          ) : null}
        </p>

        {items.length === 0 ? (
          empty()
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label={audience ? `Products available for ${audience.name}` : 'All products'}>
            {items.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                usedIn={usage[p.id] ?? 0}
                availability={availabilityLine(p.availableIn, audiences, audience?.id)}
                onOpen={(index) => setViewing({ open: true, product: p, index })}
                onEdit={() => setSheet({ open: true, product: p })}
                onPlace={() => setPlacing({ open: true, product: p })}
                onRemove={() => removeProduct(p)}
              />
            ))}
          </div>
        )}
      </section>

      <ProductSheet open={sheet.open} audience={audience} product={sheet.product} brands={brands} onClose={closeSheet} />
      <ProductViewer open={viewing.open} product={viewing.product} start={viewing.index} onClose={closeViewer} onEdit={editFromViewer} />
      <PlaceSheet open={placing.open} product={placing.product} audienceId={audience?.id ?? null} onClose={closePlace} />
    </div>
  );
}
