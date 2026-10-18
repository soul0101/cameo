import { useNavigate, useParams } from 'react-router-dom';
import type { Counts } from '@/services/api';
import { getProduct } from '@/data/catalog';
import { mmss } from '@/lib/timecode';
import { cx } from '@/lib/cx';
import { Packshot } from '@/ui';
import { int } from './data';

interface Props {
  rows: Array<Counts & { productId: string }>;
  /** Start of each product's first placement (a row seeks the Player there). */
  seek: Record<string, number>;
}

const NUM = 'px-3 text-right text-14 tabular-nums whitespace-nowrap';
const HEAD = 'h-10 px-3 text-12 font-medium text-text-3 whitespace-nowrap';

/** Per product, across all audiences: impressions · shop clicks · views · saves. A row opens the Player at the product's first placement. */
export function PlacementTable({ rows, seek }: Props) {
  const navigate = useNavigate();
  const { projectId = '' } = useParams();
  const sorted = [...rows].sort((a, b) => b.impressions - a.impressions || b.shop_clicks - a.shop_clicks);
  return (
    <section aria-label="Products" className="surface overflow-hidden">
      <header className="flex items-center gap-3 px-6 pt-5 pb-3 max-md:px-4">
        <h2 className="text-16 font-semibold text-text">Products</h2>
        <span className="text-13 text-text-3">All audiences</span>
      </header>
      {sorted.length === 0 ? (
        <p className="px-6 pb-5 text-13 text-text-2 max-md:px-4">No product activity recorded yet.</p>
      ) : (
        <div className="overflow-x-auto px-3 pb-3 max-md:px-1">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th scope="col" className={cx(HEAD, 'text-left')}>
                  Product
                </th>
                <th scope="col" className={cx(HEAD, 'text-right max-md:hidden')}>Impressions</th>
                <th scope="col" className={cx(HEAD, 'text-right')}>Shop clicks</th>
                <th scope="col" className={cx(HEAD, 'text-right max-md:hidden')}>Views</th>
                <th scope="col" className={cx(HEAD, 'text-right')}>Saves</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const product = getProduct(r.productId);
                const name = product?.full ?? r.productId;
                const at = seek[r.productId];
                const open = () => at != null && navigate(`/p/${projectId}/watch?t=${at}`);
                return (
                  <tr
                    key={r.productId}
                    {...(at != null && {
                      tabIndex: 0,
                      onClick: open,
                      onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && open(),
                      'aria-label': `${name} at ${mmss(at)}, open in the player`,
                    })}
                    className={cx(
                      'h-11 border-t border-border transition-colors duration-200 ease-cameo focus-visible:outline-offset-[-2px]',
                      at != null && 'cursor-pointer hover:bg-surface-2',
                    )}
                  >
                    <td className="rounded-l-[10px] px-3">
                      <div className="flex min-w-0 items-center gap-3">
                        {product && <Packshot productId={product.id} size={32} />}
                        <span className="block min-w-0 truncate text-14 font-medium text-text">{name}</span>
                        {at != null && <span className="mono shrink-0 text-12 text-text-3 max-md:hidden">{mmss(at)}</span>}
                      </div>
                    </td>
                    <td className={cx(NUM, 'text-text-2 max-md:hidden')}>{int(r.impressions)}</td>
                    <td className={cx(NUM, 'text-text')}>{int(r.shop_clicks)}</td>
                    <td className={cx(NUM, 'text-text-2 max-md:hidden')}>{int(r.product_views)}</td>
                    <td className={cx(NUM, 'rounded-r-[10px] font-medium text-text')}>{int(r.product_saves)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
