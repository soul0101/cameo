import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { UploadSimple } from '@phosphor-icons/react';
import { cx } from '@/lib/cx';
import { useFlow } from '@/store/flow';
import { setPendingFile } from '@/features/processing/pending';
import { Button, ConfirmDialog } from '@/ui';
import { MAX_UPLOAD_SECONDS, useLongUpload, videoDuration } from './limit';

/**
 * Hand a picked or dropped file to `/p/new/processing`, which uploads it and runs detection. A file
 * longer than the limit first asks whether to use its first `MAX_UPLOAD_SECONDS` (`LongUploadDialog`).
 */
export function useStartUpload() {
  const navigate = useNavigate();
  return async (f: File) => {
    const d = await videoDuration(f);
    if (d !== null && d > MAX_UPLOAD_SECONDS + 0.05) return useLongUpload.getState().ask(f, d);
    beginUpload(navigate, f, false);
  };
}

function beginUpload(navigate: ReturnType<typeof useNavigate>, f: File, trim: boolean) {
  setPendingFile(f, trim);
  useFlow.getState().setUploadName(f.name);
  navigate('/p/new/processing');
}

/** "Use the first 30 seconds?" for an upload over the length limit. Mounted once at the root. */
export function LongUploadDialog() {
  const navigate = useNavigate();
  const file = useLongUpload((s) => s.file);
  const duration = useLongUpload((s) => s.duration);
  const clear = useLongUpload((s) => s.clear);
  const mins = `${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}`;
  return (
    <ConfirmDialog
      open={!!file}
      title={`Use the first ${MAX_UPLOAD_SECONDS} seconds?`}
      description={
        <>
          This video is {mins} long. Cameo processes up to {MAX_UPLOAD_SECONDS} seconds of a video to keep each
          run quick and inexpensive. We&apos;ll use the first {MAX_UPLOAD_SECONDS} seconds of {file?.name ?? 'your video'}.
        </>
      }
      confirmLabel={`Use first ${MAX_UPLOAD_SECONDS} s`}
      cancelLabel="Cancel"
      onConfirm={() => {
        if (file) beginUpload(navigate, file, true);
        clear();
      }}
      onCancel={clear}
    />
  );
}

export function DropZone({ onFile, className }: { onFile: (f: File) => void; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };
  return (
    <div
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx(
        'flex min-h-[300px] flex-1 flex-col items-center justify-center gap-4 rounded-[16px] border-[1.5px] border-dashed px-6 py-10 text-center transition-[border-color,background-color] duration-200 ease-cameo max-md:min-h-[220px]',
        over ? 'border-accent bg-accent-soft' : 'border-text-3/40 bg-surface-2/40',
        className,
      )}
    >
      <span className={cx('inline-flex size-12 items-center justify-center rounded-[14px] border border-border bg-surface shadow-[var(--shadow)] transition-transform duration-200 ease-cameo', over ? '-translate-y-1 text-accent' : 'text-text')}>
        <UploadSimple size={24} aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-16 font-medium text-text">Drop a video here</p>
        <p className="text-13 text-text-3">MP4 or MOV · up to {MAX_UPLOAD_SECONDS} seconds · Gemini finds where a product fits</p>
      </div>
      <Button onClick={() => input.current?.click()} className="max-md:h-11">
        Browse files
      </Button>
      <input ref={input} type="file" accept="video/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
    </div>
  );
}
