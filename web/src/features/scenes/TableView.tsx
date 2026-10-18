import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { CaretRight, CheckCircle, Prohibit, Sparkle } from '@phosphor-icons/react';
import { indexOf } from '@/data/catalog';
import type { CatalogIndex } from '@/data/catalog';
import { timecode } from '@/data/episode';
import { useDetected } from '@/data/detected';
import { AudienceIcon } from '@/features/audiences/AudienceBar';
import { useAudiences } from '@/features/audiences/model';
import { ProductPicker } from '@/features/audiences/ProductPicker';
import type { PickerTarget } from '@/features/audiences/ProductPicker';
import { useIsMobile } from '@/lib/hooks';
import { cx } from '@/lib/cx';
import { orderBoxes, resolveWith, usePlacements } from '@/store/placements';
import type { BoxAssignment, Resolved, SceneBox } from '@/store/placements';
import { useProject } from '@/store/project';
import type { Audience } from '@/store/project';
import { Packshot, Switch, Tag, toast } from '@/ui';

import { liveCopy, scenes, suggestedProducts } from './model';
import type { SceneEntry } from './model';
import { EmptyTile, isInherited, STATE_LABEL } from './resolved';
import { useScenesUI } from './state';

/**
 * Table view: every box of the episode at once. Rows are grouped under
 * scene headers (thumb, name, time; click → Scene view on that scene). Columns: Box (sticky) ·
 * Default (sticky) · one per audience (kind icon, name, "8 of 9" coverage). Cells read like the
 * Boxes panel: inherited muted, override full with an accent dot, gap amber with a suggestion,
 * nothing dashed. A roving-tabindex grid: arrows move, Enter opens the same ProductPicker anchored
 * to the cell, Delete / Backspace puts an override back on the default.
 */

type Row =
  | { kind: 'scene'; key: string; scene: SceneEntry; count: number }
  | { kind: 'box'; key: string; scene: SceneEntry; box: SceneBox; n: number }
  | { kind: 'muted'; key: string; scene: SceneEntry; tag: string; text: string };

const isGap = (a: BoxAssignment | undefined, audiences: Audience[], ix: CatalogIndex) => audiences.some((x) => resolveWith(a, x.id, ix).state === 'gap');

export function TableView() {
  const audiences = useAudiences();
  const boxesByScene = usePlacements((s) => s.boxes);
  const assign = usePlacements((s) => s.assign);
  const products = useProject((s) => s.products);
  const detected = useDetected();
  const gapsOnly = useScenesUI((s) => s.gapsOnly);
  const setGapsOnly = useScenesUI((s) => s.setGapsOnly);
  const mobile = useIsMobile();
  const ix = useMemo(() => indexOf(products), [products]);

  // Every box of the episode (skipped scenes excepted).
  const { rows, all } = useMemo(() => {
    const rows: Row[] = [];
    const all: SceneBox[] = [];
    for (const scene of scenes) {
      const id = scene.moment.id;
      const copy = liveCopy(id, detected);
      const boxes = boxesByScene[id] ?? [];
      if (copy.kind === 'blocked') {
        if (!gapsOnly) rows.push({ kind: 'muted', key: id, scene, tag: 'Skipped', text: copy.skipReason ?? 'Cameo doesn’t place products here' });
        continue;
      }
      const live = boxes;
      if (!live.length) {
        if (!gapsOnly) rows.push({ kind: 'muted', key: id, scene, tag: 'No boxes', text: 'Draw a box in Scene view' });
        continue;
      }
      all.push(...live);
      const shown = orderBoxes(boxes).map((b, i) => ({ b, n: i + 1 })).filter(({ b }) => (!gapsOnly || isGap(assign[b.id], audiences, ix)));
      if (!shown.length) continue;
      rows.push({ kind: 'scene', key: `s-${id}`, scene, count: shown.length });
      shown.forEach(({ b, n }) => rows.push({ kind: 'box', key: b.id, scene, box: b, n }));
    }
    return { rows, all };
  }, [boxesByScene, assign, audiences, ix, detected, gapsOnly]);

  const coverage = useMemo(
    () => Object.fromEntries(audiences.map((a) => [a.id, all.filter((b) => resolveWith(assign[b.id], a.id, ix).state !== 'gap').length])),
    [audiences, all, assign, ix],
  );
  const gapCells = audiences.reduce((n, a) => n + (all.length - coverage[a.id]), 0);
  const noDefault = all.filter((b) => !assign[b.id]?.default).length;
  const sceneCount = new Set(all.map((b) => b.momentId)).size;

  /* ---------- Roving focus ---------- */

  const cols = audiences.length + 2; // Box · Default · audiences
  const maxCol = (r: Row | undefined) => (r?.kind === 'box' ? cols - 1 : 0);
  const [pos, setPos] = useState<{ r: number; c: number }>({ r: 1, c: 1 });
  const cur = { r: Math.min(pos.r, rows.length - 1), c: Math.min(pos.c, maxCol(rows[Math.min(pos.r, rows.length - 1)])) };
  const gridRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const keyboard = useRef(false);

  useEffect(() => {
    if (!keyboard.current) return;
    keyboard.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${cur.r}:${cur.c}"]`)?.focus();
  }, [cur.r, cur.c]);

  const pickerAnchor = useRef<HTMLElement | null>(null);
  const [picker, setPicker] = useState<{ boxId: string; target: PickerTarget } | null>(null);
  const openPicker = (el: HTMLElement, boxId: string, target: PickerTarget) => {
    pickerAnchor.current = el;
    setPicker({ boxId, target });
  };

  const jumpTo = (scene: SceneEntry, boxId?: string) => {
    const ui = useScenesUI.getState();
    ui.setView('scene');
    ui.goScene(scene.moment.id);
    if (boxId) ui.openBox(boxId);
  };

  const activate = (r: number, c: number, el: HTMLElement) => {
    const row = rows[r];
    if (!row) return;
    if (row.kind !== 'box') return jumpTo(row.scene);
    if (c === 0) return jumpTo(row.scene, row.box.id);
    openPicker(el, row.box.id, c === 1 ? { kind: 'default' } : { kind: 'audience', audienceId: audiences[c - 2].id });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.cell) return;
    const move = (r: number, c: number) => {
      e.preventDefault();
      keyboard.current = true;
      const rr = Math.max(0, Math.min(rows.length - 1, r));
      setPos({ r: rr, c: Math.max(0, Math.min(maxCol(rows[rr]), c)) });
    };
    const { r, c } = cur;
    if (e.key === 'ArrowDown') move(r + 1, pos.c);
    else if (e.key === 'ArrowUp') move(r - 1, pos.c);
    else if (e.key === 'ArrowRight') move(r, c + 1);
    else if (e.key === 'ArrowLeft') move(r, c - 1);
    else if (e.key === 'Home') move(e.ctrlKey ? 0 : r, 0);
    else if (e.key === 'End') move(e.ctrlKey ? rows.length - 1 : r, cols - 1);
    else if (e.key === 'PageDown') move(r + 8, pos.c);
    else if (e.key === 'PageUp') move(r - 8, pos.c);
    else if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') {
      e.preventDefault();
      activate(r, c, e.target as HTMLElement);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const row = rows[r];
      if (row?.kind !== 'box' || c < 2) return;
      const a = audiences[c - 2];
      if (assign[row.box.id]?.overrides[a.id] === undefined) return;
      e.preventDefault();
      usePlacements.getState().clearOverride(row.box.id, a.id);
      toast({ title: `Box ${row.n} follows the default in ${a.name}` });
    }
  };

  const cellProps = (r: number, c: number) => ({
    'data-cell': `${r}:${c}`,
    tabIndex: cur.r === r && cur.c === c ? 0 : -1,
    onFocus: () => (cur.r !== r || cur.c !== c) && setPos({ r, c }),
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      setPos({ r, c });
      activate(r, c, e.currentTarget);
    },
  });

  const BOX_W = mobile ? 140 : 240;
  const DEF_W = mobile ? 156 : 200;
  const CELL_W = 140;
  const stickyDefault = !mobile;
  // The sticky columns get their edge only once the audience columns slide under them.
  const edge = stickyDefault && scrolled ? 'shadow-[1px_0_0_var(--border),8px_0_16px_-8px_rgba(0,0,0,.25)]' : '';

  return (
    <section aria-label="Every box in the episode" className="surface flex min-w-0 flex-col overflow-hidden rounded-[16px]!">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 pt-4 pb-4 max-md:px-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-14 font-semibold text-text">Every box in the episode</h2>
          <p className="text-13 text-text-3">
            {all.length} {all.length === 1 ? 'box' : 'boxes'} in {sceneCount} {sceneCount === 1 ? 'scene' : 'scenes'} ·{' '}
            {gapCells ? <span className="font-medium text-accent">{gapCells} {gapCells === 1 ? 'gap' : 'gaps'}</span> : 'no gaps'}
            {noDefault > 0 && ` · ${noDefault} without a default`}
          </p>
        </div>
        <label className="flex h-9 shrink-0 cursor-pointer items-center gap-2.5 text-13 font-medium text-text-2 max-md:h-11">
          Gaps only
          <Switch checked={gapsOnly} label="Gaps only" onChange={setGapsOnly} />
        </label>
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-label="Products per box and audience"
        aria-rowcount={rows.length + 1}
        aria-colcount={cols}
        onKeyDown={onKey}
        onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}
        className="relative overflow-auto overscroll-x-contain border-t border-border md:max-h-[calc(100dvh-260px)]"
      >
        <div className="w-max min-w-full">
          {/* Column headers */}
          <div role="rowgroup" className="sticky top-0 z-30">
            <div role="row" aria-rowindex={1} className="flex h-[52px] border-b border-border bg-surface">
              <div role="columnheader" style={{ width: BOX_W }} className="sticky left-0 z-10 flex shrink-0 items-center bg-surface pl-5 text-12 font-medium text-text-3 max-md:pl-4">
                Box
              </div>
              <div
                role="columnheader"
                style={{ width: DEF_W, left: stickyDefault ? BOX_W : undefined }}
                className={cx('flex shrink-0 items-center bg-surface px-3 text-12 font-medium text-text-3', stickyDefault && 'sticky z-10', edge)}
              >
                Default
              </div>
              {audiences.map((a) => {
                const ok = coverage[a.id] ?? 0;
                return (
                  <div key={a.id} role="columnheader" style={{ width: CELL_W }} className="flex shrink-0 flex-col justify-center px-3" title={a.name}>
                    <span className="flex min-w-0 items-center gap-1.5 text-13 font-medium text-text-2">
                      <AudienceIcon kind={a.kind} size={14} className="shrink-0 text-text-3" />
                      <span className="truncate">{a.name}</span>
                    </span>
                    <span className={cx('text-12', ok < all.length ? 'text-accent' : 'text-text-3')}>
                      {ok} of {all.length}
                    </span>
                  </div>
                );
              })}
              <div aria-hidden className="flex-1" />
            </div>
          </div>

          <div role="rowgroup">
            {rows.length === 0 && (
              <div role="row" className="flex">
                <div role="gridcell" aria-colspan={cols} className="sticky left-0 flex w-[min(100%,calc(100vw-48px))] items-center gap-3 px-5 py-10 text-13 text-text-2">
                  <CheckCircle size={20} weight="fill" className="shrink-0 text-pass" aria-hidden />
                  No gaps. Every audience has a product in every box.
                </div>
              </div>
            )}
            {rows.map((row, r) => {
              const rowIndex = r + 2;
              if (row.kind === 'scene')
                return (
                  <div key={row.key} role="row" aria-rowindex={rowIndex} className={cx('flex h-12 items-end', r > 0 && 'mt-2')}>
                    <div
                      role="gridcell"
                      aria-colspan={cols}
                      aria-label={`Scene ${row.scene.index + 1}, ${row.scene.copy.name}, ${timecode(row.scene.from)} to ${timecode(row.scene.to)}. Open in Scene view`}
                      {...cellProps(r, 0)}
                      className="group/scene sticky left-0 mx-2 flex h-10 cursor-pointer items-center gap-2.5 rounded-[10px] px-3 outline-offset-[-2px] transition-colors duration-200 ease-cameo hover:bg-surface-2 max-md:mx-1"
                    >
                      <SceneThumb scene={row.scene} />
                      <span className="text-13 font-semibold whitespace-nowrap text-text">{row.scene.copy.name}</span>
                      <span className="mono text-12 whitespace-nowrap text-text-3">
                        {timecode(row.scene.from)}–{timecode(row.scene.to)}
                      </span>
                      <CaretRight size={14} className="shrink-0 text-text-3 opacity-0 transition-opacity duration-200 ease-cameo group-hover/scene:opacity-100 group-focus-visible/scene:opacity-100" aria-hidden />
                    </div>
                  </div>
                );
              if (row.kind === 'muted')
                return (
                  <div key={row.key} role="row" aria-rowindex={rowIndex} className={cx('flex h-12 items-center', r > 0 && 'mt-2')}>
                    <div
                      role="gridcell"
                      aria-colspan={cols}
                      aria-label={`Scene ${row.scene.index + 1}, ${row.scene.copy.name}: ${row.tag}. ${row.text}`}
                      {...cellProps(r, 0)}
                      className="group/scene sticky left-0 mx-2 flex h-10 cursor-pointer items-center gap-2.5 rounded-[10px] px-3 outline-offset-[-2px] transition-colors duration-200 ease-cameo hover:bg-surface-2 max-md:mx-1"
                    >
                      <SceneThumb scene={row.scene} muted />
                      <span className="text-13 font-medium whitespace-nowrap text-text-2">{row.scene.copy.name}</span>
                      <span className="mono text-12 whitespace-nowrap text-text-3">
                        {timecode(row.scene.from)}–{timecode(row.scene.to)}
                      </span>
                      <Tag tone="muted" icon={row.tag === 'Skipped' ? <Prohibit /> : row.tag === 'Concept' ? <Sparkle /> : undefined}>
                        {row.tag}
                      </Tag>
                      <span className="max-w-[360px] truncate text-13 text-text-3 max-md:hidden">{row.text}</span>
                    </div>
                  </div>
                );
              const a = assign[row.box.id];
              const def = a?.default ? ix.byId[a.default] : undefined;
              const used = (boxesByScene[row.box.momentId] ?? []).filter((b) => b.id !== row.box.id).map((b) => assign[b.id]?.default ?? '').filter(Boolean);
              return (
                <div key={row.key} role="row" aria-rowindex={rowIndex} className="group/row flex h-[52px]">
                  <div
                    role="rowheader"
                    style={{ width: BOX_W }}
                    aria-label={`Box ${row.n}, ${row.box.label}. Open in Scene view`}
                    {...cellProps(r, 0)}
                    className={cx(mobile && scrolled && 'shadow-[1px_0_0_var(--border),8px_0_16px_-8px_rgba(0,0,0,.25)]', "sticky left-0 z-10 flex shrink-0 cursor-pointer items-center gap-2.5 bg-surface pr-2 pl-5 outline-offset-[-2px] transition-colors duration-200 ease-cameo group-hover/row:bg-surface-2 max-md:pl-4")}
                  >
                    <span aria-hidden className="mono inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-surface-3 text-12 font-semibold text-text-2">
                      {row.n}
                    </span>
                    <span className="min-w-0 truncate text-13 font-medium text-text">{row.box.label}</span>
                  </div>
                  <div
                    role="gridcell"
                    style={{ width: DEF_W, left: stickyDefault ? BOX_W : undefined }}
                    aria-label={`Box ${row.n} default: ${def ? def.full : 'none'}. Change`}
                    aria-haspopup="dialog"
                    {...cellProps(r, 1)}
                    className={cx(
                      'group/cell flex shrink-0 cursor-pointer items-center bg-surface px-1.5 outline-none transition-colors duration-200 ease-cameo group-hover/row:bg-surface-2',
                      stickyDefault && 'sticky z-10', edge,
                    )}
                  >
                    <CellBody className="group-hover/cell:bg-surface-3">
                      {def ? (
                        <>
                          <Packshot productId={def.id} size={24} />
                          <span className="min-w-0 truncate text-13 font-medium text-text">{mobile ? def.name : def.full}</span>
                        </>
                      ) : (
                        <span className="inline-flex h-8 min-w-0 flex-1 items-center rounded-[8px] border border-dashed border-border-strong px-2 text-12 text-text-3">
                          <span className="truncate">Choose product</span>
                        </span>
                      )}
                    </CellBody>
                  </div>
                  {audiences.map((au, i) => (
                    <AudienceCell
                      key={au.id}
                      resolved={resolveWith(a, au.id, ix)}
                      audience={au}
                      n={row.n}
                      width={CELL_W}
                      suggestion={() => suggestedProducts(row.box, 1, au.id, used)[0]?.name}
                      {...cellProps(r, i + 2)}
                    />
                  ))}
                  <div aria-hidden className="flex-1 transition-colors duration-200 ease-cameo group-hover/row:bg-surface-2" />
                </div>
              );
            })}
            <div aria-hidden className="h-3" />
          </div>
        </div>
      </div>

      {picker && <ProductPicker open onClose={() => setPicker(null)} anchor={pickerAnchor} boxId={picker.boxId} target={picker.target} />}
    </section>
  );
}

function SceneThumb({ scene, muted }: { scene: SceneEntry; muted?: boolean }) {
  return (
    <span aria-hidden className={cx('relative size-8 shrink-0 overflow-hidden rounded-[8px] bg-black shadow-[0_0_0_1px_var(--border)]', muted && 'opacity-50 grayscale')}>
      <img src={scene.moment.keyframe} alt="" draggable={false} className="size-full object-cover" />
    </span>
  );
}

/** The inner, rounded hover/active area of a cell (the cell itself keeps the row's background). */
function CellBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'relative flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] px-1.5 transition-[background-color,box-shadow] duration-200 ease-cameo group-focus-visible/cell:shadow-[inset_0_0_0_2px_var(--accent)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

function AudienceCell({
  resolved,
  audience,
  n,
  width,
  suggestion,
  ...rest
}: {
  resolved: Resolved;
  audience: Audience;
  n: number;
  width: number;
  suggestion: () => string | undefined;
  'data-cell': string;
  tabIndex: number;
  onFocus: () => void;
  onClick: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const { product, state } = resolved;
  const hint = state === 'gap' ? suggestion() : undefined;
  const label = `Box ${n} in ${audience.name}: ${product ? product.full : 'nothing'} (${STATE_LABEL[state]}${hint ? `, try ${hint}` : ''}). ${state === 'override' ? 'Delete to use the default. ' : ''}Change`;
  return (
    <div
      role="gridcell"
      aria-label={label}
      aria-haspopup="dialog"
      title={state === 'local' && product ? `${product.brand}’s product for ${audience.name}` : undefined}
      style={{ width }}
      {...rest}
      className="group/cell flex shrink-0 cursor-pointer items-center px-1.5 outline-none transition-colors duration-200 ease-cameo group-hover/row:bg-surface-2"
    >
      <CellBody
        className={cx(
          'group-hover/cell:bg-surface-3',
          state === 'gap' && 'bg-accent-soft group-hover/cell:bg-[color-mix(in_oklab,var(--accent)_22%,transparent)]',
          state === 'none' && 'border border-dashed border-border-strong',
        )}
      >
        {product ? (
          <>
            <Packshot productId={product.id} size={24} />
            <span className={cx('min-w-0 truncate text-13', isInherited(state) ? 'text-text-2' : 'font-medium text-text')}>{product.name}</span>
            {state === 'override' && <span aria-hidden className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent" />}
          </>
        ) : state === 'gap' ? (
          <>
            <EmptyTile state="gap" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-12 font-medium text-accent">Gap</span>
              <span className="truncate text-12 text-text-3">{hint ? `Try ${hint}` : 'None available'}</span>
            </span>
          </>
        ) : (
          <span className="truncate pl-0.5 text-12 text-text-3">Not placed</span>
        )}
      </CellBody>
    </div>
  );
}
