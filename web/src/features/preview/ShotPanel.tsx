import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise, ArrowsClockwise, FloppyDisk, Sparkle } from '@phosphor-icons/react';
import { usePlacements, useScenePrompt } from '@/store/placements';
import type { SceneItem } from '@/store/placements';
import type { AudienceId } from '@/store/project';
import type { CatalogProduct } from '@/data/catalog';
import { audienceLabel } from '@/features/audiences/model';
import { openProduct } from '@/ui/ProductModal';
import { Button, Packshot, Tag } from '@/ui';
import { cx } from '@/lib/cx';
import { BoxBadge } from './SceneFrame';
import { generateStill, useStill } from './stills';
import { useVersionWriting } from './writePrompts';

/**
 * The right panel of Previews: what this version would send to generation. The products in the shot
 * (compact, numbered like the outlines; a box clicked on the frame is highlighted), then the
 * composed edit prompt, editable, with where each box's part came from (Gemini or the plain template).
 */
export function ShotPanel({
  sceneId,
  audience,
  items,
  focusN,
}: {
  sceneId: string;
  audience: AudienceId;
  items: SceneItem[];
  /** The box clicked on the frame; its product row is highlighted. */
  focusN: number | null;
}) {
  const { text, base, edited } = useScenePrompt(sceneId, audience);
  const templated = items.filter((i) => i.promptSource === 'template').map((i) => i.n);
  const writing = useVersionWriting({ sceneId, audienceId: audience });
  const [draft, setDraft] = useState(text);
  const focused = useRef<HTMLLIElement>(null);
  useEffect(() => {
    setDraft(text);
  }, [text]);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusN]);

  const cards: Array<{ product: CatalogProduct; ns: number[] }> = [];
  for (const it of items) {
    const hit = cards.find((c) => c.product.id === it.product.id);
    if (hit) hit.ns.push(it.n);
    else cards.push({ product: it.product, ns: [it.n] });
  }

  const dirty = draft.trim() !== text.trim();
  const { still, running } = useStill({ sceneId, audienceId: audience });
  const busy = running !== null;
  const save = () => {
    const v = draft.trim();
    const st = usePlacements.getState();
    if (!v || v === base) st.resetScenePrompt(sceneId, audience);
    else st.setScenePrompt(sceneId, audience, v);
  };

  return (
    <aside aria-label="Prompt and products" className="surface flex max-h-[calc(100dvh-24px)] flex-col overflow-hidden rounded-[20px]">
      <header className="flex h-[49px] shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <h3 className="min-w-0 flex-1 truncate text-14 font-semibold text-text">
          Prompt <span className="font-normal text-text-3">· {audienceLabel(audience)}</span>
        </h3>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <section aria-label="In this shot" className="flex flex-col gap-2">
          <h4 className="text-12 font-medium text-text-3">
            In this shot · {cards.length} {cards.length === 1 ? 'product' : 'products'}
          </h4>
          <ul className="-mx-2 flex flex-col gap-1">
            {cards.map(({ product: p, ns }) => {
              const hot = focusN !== null && ns.includes(focusN);
              return (
                <li
                  key={p.id}
                  ref={hot ? focused : undefined}
                  className={cx(
                    'flex items-center gap-3 rounded-[12px] p-2 transition-[background-color,box-shadow] duration-200 ease-cameo',
                    hot && 'bg-surface-3 shadow-[inset_0_0_0_1px_var(--accent)]',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => openProduct(p.id)}
                    aria-label={`View ${p.full}`}
                    title="View product"
                    className="shrink-0 rounded-[10px] transition-transform duration-200 ease-cameo hover:-translate-y-0.5"
                  >
                    <Packshot productId={p.id} audience={audience} size={40} />
                  </button>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-14 font-medium text-text">
                      <span className="sr-only">Box {ns.join(' and ')}: </span>
                      {p.name}
                    </span>
                    <span className="truncate text-12 text-text-2">{p.brand}</span>
                  </span>
                  <span aria-hidden className="flex shrink-0 gap-1">
                    {ns.map((n) => (
                      <BoxBadge key={n} n={n} className="size-6 text-12" />
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Edit prompt" className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h4 className="flex-1 text-12 font-medium text-text-3">Edit prompt · composed from the boxes</h4>
            {edited ? (
              <Tag tone="accent">Edited</Tag>
            ) : (
              !templated.length &&
              items.length > 0 && (
                <Tag tone="muted" icon={<Sparkle />}>
                  Written by Gemini
                </Tag>
              )
            )}
          </div>
          {!edited && writing && (
            <p className="flex items-center gap-1.5 text-12 text-accent">
              <Sparkle size={12} aria-hidden className="motion-safe:animate-pulse" /> Gemini is writing the prompt for the products you picked…
            </p>
          )}
          {!edited && !writing && templated.length > 0 && (
            <p className="text-12 text-text-3">
              {templated.length === items.length ? 'Gemini wrote no prompt for these products; a plain template stands in.' : `Box ${templated.join(', ')}: Gemini wrote no prompt for that product, so a plain template stands in.`} Edit it before
              approving.
            </p>
          )}
          <textarea
            value={draft}
            rows={10}
            aria-label="Edit prompt"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
            className="w-full resize-y rounded-[12px] border border-border-strong bg-surface-2 p-3 text-13 leading-relaxed text-text outline-none focus:border-accent"
          />
          <div className="flex items-center gap-1">
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(text)}>
                Discard
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<ArrowCounterClockwise />}
              disabled={!edited && !dirty}
              className="ml-auto"
              onClick={() => {
                usePlacements.getState().resetScenePrompt(sceneId, audience);
                setDraft(base);
              }}
            >
              Reset
            </Button>
          </div>
        </section>
      </div>

      <footer className="shrink-0 border-t border-border p-3">
        <div className="flex gap-2">
          <Button variant="secondary" icon={<FloppyDisk />} disabled={!dirty || !draft.trim()} onClick={save} className="flex-1">
            Save
          </Button>
          <Button
            variant="primary"
            icon={still ? <ArrowsClockwise /> : <Sparkle />}
            loading={busy}
            disabled={busy || !items.length || !draft.trim()}
            onClick={() => {
              if (dirty) save();
              void generateStill({ sceneId, audienceId: audience });
            }}
            className="flex-[2]"
          >
            {busy ? 'Generating' : dirty ? (still ? 'Save & regenerate' : 'Save & generate') : still ? 'Regenerate' : 'Generate'}
          </Button>
        </div>
      </footer>
    </aside>
  );
}
