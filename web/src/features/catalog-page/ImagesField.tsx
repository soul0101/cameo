import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { ImageSquare, Plus, Star, X } from '@phosphor-icons/react';
import { compressImage, ImageError, isImageFile } from '@/lib/images';
import { cx } from '@/lib/cx';
import { MAX_IMAGES } from '@/store/project';
import { makeCover } from './ProductViewer';
import { Plate, wellClass } from './media';

const move = (xs: string[], from: number, to: number) => {
  const next = [...xs];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
};

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Product sheet "Images" field: 88 px thumbs, the first tagged "Cover"; each thumb on
 * hover/focus offers Make cover and Remove. Reorder by dragging, or focus a thumb and Alt+←/→
 * (announced). A dashed "Add images" tile takes several files (click, drop anywhere on the field,
 * or paste while the sheet is open); files are compressed client-side with a shimmer while they
 * work; non-images and the 8-image cap error inline. Empty: one wide drop zone.
 */
export function ImagesField({ images, onChange, active }: { images: string[]; onChange: (next: string[]) => void; active: boolean }) {
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const latest = useRef(images);
  latest.current = images;
  const ids = { label: useId(), hint: useId(), err: useId() };

  useEffect(() => {
    if (!active) {
      setError('');
      setPending(0);
      setAnnounce('');
    }
  }, [active]);

  const add = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_IMAGES - latest.current.length - pending;
    const imgs = files.filter(isImageFile);
    const notImages = files.length - imgs.length;
    if (room <= 0) {
      setError(`That’s the limit: ${MAX_IMAGES} images per product. Remove one to add another.`);
      return;
    }
    const take = imgs.slice(0, room);
    const msgs: string[] = [];
    if (notImages) msgs.push(notImages === 1 ? `${files.find((f) => !isImageFile(f))?.name ?? 'That file'} isn’t an image. Use PNG or JPG.` : `${notImages} files aren’t images. Use PNG or JPG.`);
    if (imgs.length > take.length) msgs.push(`Added ${take.length}; a product holds up to ${MAX_IMAGES} images.`);
    setError(msgs.join(' '));
    if (!take.length) return;
    setPending((n) => n + take.length);
    const results = await Promise.allSettled(take.map((f) => compressImage(f)));
    setPending((n) => Math.max(0, n - take.length));
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason instanceof ImageError ? r.reason.message : 'Couldn’t read an image'] : []));
    if (failed.length) setError((e) => [e, ...failed].filter(Boolean).join('. '));
    if (ok.length) {
      const next = [...latest.current, ...ok].slice(0, MAX_IMAGES);
      onChange(next);
      setAnnounce(`Added ${ok.length} image${ok.length === 1 ? '' : 's'}. ${next.length} of ${MAX_IMAGES}.`);
    }
  };

  // Paste works anywhere in the open sheet when the clipboard holds image files.
  useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter(isImageFile);
      if (!files.length) return;
      e.preventDefault();
      void add(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pending]);

  const focusThumb = (i: number) => requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-thumb="${i}"]`)?.focus());

  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= images.length || from === to) return;
    onChange(move(images, from, to));
    setAnnounce(`Moved image to position ${to + 1} of ${images.length}${to === 0 ? ', now the cover' : ''}.`);
    focusThumb(to);
  };
  const remove = (i: number) => {
    const next = images.filter((_, k) => k !== i);
    onChange(next);
    setError('');
    setAnnounce(`Removed image ${i + 1}.${i === 0 && next.length ? ' The next image is the cover.' : ''} ${next.length} left.`);
    if (next.length) focusThumb(Math.min(i, next.length - 1));
  };
  const cover = (i: number) => {
    onChange(makeCover(images, i));
    setAnnounce(`Image ${i + 1} is now the cover.`);
    focusThumb(0);
  };

  const onThumbKey = (e: KeyboardEvent, i: number) => {
    if (e.altKey && e.key === 'ArrowLeft') (e.preventDefault(), reorder(i, i - 1));
    else if (e.altKey && e.key === 'ArrowRight') (e.preventDefault(), reorder(i, i + 1));
    else if (e.key === 'ArrowLeft') (e.preventDefault(), focusThumb(Math.max(0, i - 1)));
    else if (e.key === 'ArrowRight') (e.preventDefault(), focusThumb(Math.min(images.length - 1, i + 1)));
    else if (e.key === 'Delete' || e.key === 'Backspace') (e.preventDefault(), remove(i));
  };

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setOver(false);
      void add(Array.from(e.dataTransfer.files));
    },
  };

  const full = images.length + pending >= MAX_IMAGES;
  const browse = () => file.current?.click();

  return (
    <div className="flex flex-col gap-1.5" {...dropProps}>
      <div className="flex items-baseline gap-2">
        <span id={ids.label} className="text-13 font-medium text-text-2">
          Images <span className="font-normal text-text-3">· optional</span>
        </span>
        <span className="flex-1" />
        {images.length > 0 && (
          <span className="text-12 text-text-3 tabular-nums">
            {images.length} of {MAX_IMAGES}
          </span>
        )}
      </div>

      {images.length === 0 && pending === 0 ? (
        <button
          type="button"
          onClick={browse}
          aria-describedby={cx(ids.hint, error && ids.err)}
          className={cx(
            'flex h-[120px] flex-col items-center justify-center gap-2 rounded-[12px] border-[1.5px] border-dashed px-4 text-center transition-colors duration-200 ease-cameo',
            over ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface-2/40 hover:border-text-3 hover:bg-surface-2/70',
          )}
        >
          <ImageSquare size={22} className={over ? 'text-accent' : 'text-text-3'} aria-hidden />
          <span className="text-13 text-text">
            Drop product images, or <span className="font-medium text-accent">browse</span>
          </span>
          <span id={ids.hint} className="text-12 text-text-3">
            PNG or JPG · the first is the cover
          </span>
        </button>
      ) : (
        <div
          ref={grid}
          role="list"
          aria-labelledby={ids.label}
          aria-describedby={ids.hint}
          className={cx('-m-1 flex flex-wrap gap-2 rounded-[14px] p-1 transition-colors duration-200 ease-cameo', over && 'bg-accent-soft outline-[1.5px] outline-accent outline-dashed')}
        >
          {images.map((src, i) => (
            <div
              key={src.slice(-48) + i}
              role="listitem"
              draggable
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(i));
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDragTo(i);
              }}
              onDrop={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                e.stopPropagation();
                reorder(dragFrom, i);
                setDragFrom(null);
                setDragTo(null);
              }}
              onDragEnd={() => (setDragFrom(null), setDragTo(null))}
              className={cx(
                'group/thumb relative size-[88px] shrink-0 transition-[opacity,transform] duration-200 ease-cameo',
                dragFrom === i && 'opacity-40',
                dragTo === i && dragFrom !== null && dragFrom !== i && 'scale-[1.04]',
              )}
            >
              <button
                type="button"
                data-thumb={i}
                onKeyDown={(e) => onThumbKey(e, i)}
                aria-label={`Image ${i + 1} of ${images.length}${i === 0 ? ', cover' : ''}`}
                aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Delete"
                className={cx(wellClass, 'size-full cursor-grab rounded-[12px] active:cursor-grabbing', dragTo === i && dragFrom !== null && dragFrom !== i && 'ring-[1.5px] ring-accent')}
              >
                <Plate src={src} alt="" fill={0.86} radius={5} />
              </button>
              {i === 0 && (
                <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex h-[18px] items-center gap-1 rounded-[6px] bg-black/60 px-1.5 text-11 font-medium text-white backdrop-blur-sm">
                  <Star size={10} weight="fill" className="text-accent" aria-hidden />
                  Cover
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove image ${i + 1}`}
                className="absolute -top-1.5 -right-1.5 inline-flex size-[22px] items-center justify-center rounded-full bg-surface text-text-2 opacity-0 shadow-[0_2px_8px_rgba(0,0,0,.2),0_0_0_1px_var(--border-strong)] transition-[opacity,color] duration-200 ease-cameo group-focus-within/thumb:opacity-100 group-hover/thumb:opacity-100 hover:text-reject max-md:opacity-100"
              >
                <X size={12} weight="bold" />
              </button>
              {i > 0 && (
                <button
                  type="button"
                  onClick={() => cover(i)}
                  aria-label={`Make image ${i + 1} the cover`}
                  className="absolute inset-x-1.5 bottom-1.5 inline-flex h-[22px] items-center justify-center gap-1 rounded-[7px] bg-black/65 text-11 font-medium text-white opacity-0 backdrop-blur-sm transition-opacity duration-200 ease-cameo group-focus-within/thumb:opacity-100 group-hover/thumb:opacity-100 hover:bg-black/80"
                >
                  Make cover
                </button>
              )}
            </div>
          ))}
          {Array.from({ length: pending }, (_, k) => (
            <div key={`pending-${k}`} role="listitem" aria-label="Preparing image" className="shimmer size-[88px] shrink-0 rounded-[12px] bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]" />
          ))}
          {!full && (
            <div role="listitem" className="size-[88px] shrink-0">
              <button
                type="button"
                onClick={browse}
                className="flex size-full flex-col items-center justify-center gap-1 rounded-[12px] border-[1.5px] border-dashed border-border-strong text-12 font-medium text-text-2 transition-colors duration-200 ease-cameo hover:border-text-3 hover:bg-surface-2/60 hover:text-text"
              >
                <Plus size={18} aria-hidden />
                Add images
              </button>
            </div>
          )}
        </div>
      )}

      {images.length > 0 && (
        <p id={ids.hint} className="text-12 text-text-3">
          Drag to reorder, or Alt + ← / → on a focused image.
        </p>
      )}
      {error && (
        <p id={ids.err} role="alert" className="text-12 text-reject">
          {error}
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          void add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </div>
  );
}
