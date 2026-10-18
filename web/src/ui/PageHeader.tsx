import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CaretRight } from '@phosphor-icons/react';
import { cx } from '@/lib/cx';

export interface Crumb {
  label: string;
  to?: string;
}

/** Breadcrumb trail: 13 --text-2, last item is the current page. */
export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cx('flex min-w-0 items-center gap-1 text-13 text-text-2', className)}>
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <Fragment key={`${c.label}-${i}`}>
            {i > 0 && <CaretRight size={12} aria-hidden className="shrink-0 text-text-3" />}
            {c.to && !last ? (
              <Link to={c.to} className="truncate rounded-[4px] transition-colors duration-200 hover:text-text">
                {c.label}
              </Link>
            ) : (
              <span aria-current={last ? 'page' : undefined} className={cx('truncate', last && 'text-text')}>
                {c.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Page header: breadcrumb (Project › Section), title 24/600, one fact line, and the
 * page's primary action at the right with secondary actions to its left.
 */
export function PageHeader({
  crumbs,
  title,
  fact,
  primary,
  secondary,
  className,
}: {
  crumbs?: Crumb[];
  title: string;
  fact?: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('flex flex-col gap-3 pb-6 max-md:pb-5', className)}>
      {crumbs && <Breadcrumb items={crumbs} className="max-md:hidden" />}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-24 font-semibold tracking-[-0.015em] text-text">{title}</h1>
          {fact && <p className="mt-1 text-14 text-text-2">{fact}</p>}
        </div>
        {(primary || secondary) && (
          <div className="flex items-center gap-2 max-md:w-full max-md:[&>*]:h-11 max-md:[&>*:last-child]:flex-1">
            {secondary}
            {primary}
          </div>
        )}
      </div>
    </header>
  );
}
