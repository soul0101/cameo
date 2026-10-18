import { CheckCircle, CloudArrowUp, Crosshair, Eye, FilmStrip, Scan, Tag, WarningCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { cx } from '@/lib/cx';
import { Button } from '@/ui';
import type { StageId, StageView } from './store';
import { STAGE_ORDER } from './store';

interface StageDef {
  name: string;
  hint: string;
  icon: Icon;
  /** Typical duration (s), only used to shape the ring while a stage reports no progress. */
  typical: number;
  /** Share of the overall progress ring. */
  weight: number;
}

const STAGES: Record<StageId, StageDef> = {
  upload: { name: 'Upload', hint: 'Sending your video', icon: CloudArrowUp, typical: 6, weight: 0.25 },
  ingest: { name: 'Ingest', hint: 'Shots, proxy video, keyframes', icon: FilmStrip, typical: 2, weight: 0.1 },
  vision: { name: 'Find objects', hint: 'Cloud Vision on every keyframe', icon: Scan, typical: 3, weight: 0.05 },
  understand: { name: 'Understand scenes', hint: 'What happens in each shot', icon: Eye, typical: 6, weight: 0.3 },
  localise: { name: 'Find placement areas', hint: 'Surfaces where a product fits', icon: Crosshair, typical: 8, weight: 0.4 },
  match: { name: 'Match products', hint: 'Catalog picks for every area', icon: Tag, typical: 4, weight: 0.2 },
};

const n = (c: Record<string, number> | undefined, k: string) => c?.[k];
const plural = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;

/** The one-line status of a finished stage, from its counts. */
function doneText(id: StageId, s: StageView): string {
  const c = s.counts;
  switch (id) {
    case 'upload':
      return s.message || 'Sent';
    case 'ingest':
      return n(c, 'shots') != null ? plural(n(c, 'shots')!, 'shot') : s.message || 'Done';
    case 'vision':
      if (n(c, 'objects') == null) return s.message || 'Done';
      return n(c, 'visionFrames') != null ? `${plural(n(c, 'objects')!, 'object')} · ${plural(n(c, 'visionFrames')!, 'frame')}` : plural(n(c, 'objects')!, 'object');
    case 'understand': {
      if (n(c, 'scenes') == null) return s.message || 'Done';
      const parts = [plural(n(c, 'scenes')!, 'scene')];
      if (n(c, 'surfaces') != null) parts.push(plural(n(c, 'surfaces')!, 'surface'));
      if (n(c, 'skipped')) parts.push(`${n(c, 'skipped')} skipped`);
      return parts.join(' · ');
    }
    case 'localise':
      return n(c, 'areas') != null ? plural(n(c, 'areas')!, 'area') : s.message || 'Done';
    case 'match':
      if (n(c, 'suggestions') == null) return s.message || 'Done';
      return n(c, 'matchedBoxes') != null ? `${plural(n(c, 'suggestions')!, 'suggestion')} · ${plural(n(c, 'matchedBoxes')!, 'area')}` : plural(n(c, 'suggestions')!, 'suggestion');
  }
}

const formatElapsed = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

/** The stages to show: the upload once a file is being sent, Cloud Vision once the server reports it. */
export const visibleStages = (stages: Record<StageId, StageView>): StageId[] => STAGE_ORDER.filter((id) => (id !== 'vision' && id !== 'upload') || stages[id].status !== 'pending');

/** Overall progress 0..1 across the stages shown. */
export function overallProgress(stages: Record<StageId, StageView>, now: number): number {
  let total = 0;
  let weights = 0;
  for (const id of visibleStages(stages)) {
    const s = stages[id];
    const def = STAGES[id];
    let p = 0;
    if (s.status === 'done') p = 1;
    else if (s.status === 'running') {
      const el = s.startedAt ? (now - s.startedAt) / 1000 : 0;
      p = Math.min(0.95, s.progress ?? 1 - Math.exp(-el / def.typical));
    }
    total += p * def.weight;
    weights += def.weight;
  }
  return Math.min(1, weights ? total / weights : 0);
}

/** A determinate bar (the upload knows its bytes sent). */
function ProgressBar({ value }: { value: number }) {
  return (
    <span aria-hidden className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-surface-3">
      <span className="block h-full rounded-full bg-accent transition-[width] duration-200 ease-cameo" style={{ width: `${Math.round(Math.min(1, Math.max(0.02, value)) * 100)}%` }} />
    </span>
  );
}

function IndeterminateBar() {
  return (
    <span aria-hidden className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-surface-3">
      <span className="block h-full w-1/3 rounded-full bg-accent [animation:cameo-indeterminate_1.4s_var(--ease)_infinite] motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
    </span>
  );
}

export interface StageRowProps {
  id: StageId;
  stage: StageView;
  now: number;
  /** Cost card (a stage waiting at `needs_confirmation`). */
  confirm?: { cost?: number; calls?: number } | null;
  onConfirm: () => void;
  /** Second action on the cost card ("Cancel"). */
  onSkip?: () => void;
  skipLabel?: string;
  onRetry: () => void;
}

export function StageRow({ id, stage, now, confirm, onConfirm, onSkip, skipLabel = 'Cancel', onRetry }: StageRowProps) {
  const def = STAGES[id];
  const Ic = def.icon;
  const { status } = stage;
  const elapsed = stage.startedAt ? (status === 'done' && stage.seconds != null ? stage.seconds * 1000 : (stage.endedAt ?? now) - stage.startedAt) : null;
  const text =
    status === 'done' ? doneText(id, stage) : status === 'running' ? stage.message || 'Working' : status === 'failed' ? stage.message || 'Failed' : status === 'confirm' ? 'Waiting for your go-ahead' : def.hint;
  const cost = confirm?.cost != null ? `~$${confirm.cost.toFixed(2)}` : null;
  const calls = confirm?.calls != null ? `${confirm.calls} calls` : null;

  return (
    <li className={cx('rounded-[12px] px-3 py-3 transition-colors duration-200 ease-cameo', status === 'running' && 'bg-surface-2/70', status === 'confirm' && 'bg-surface-2/70')} aria-current={status === 'running' ? 'step' : undefined}>
      <div className="flex items-start gap-3">
        <span
          className={cx(
            'mt-px inline-flex size-7 shrink-0 items-center justify-center rounded-full',
            status === 'done' && 'bg-pass/12 text-pass',
            status === 'running' && 'bg-accent-soft text-accent',
            status === 'confirm' && 'bg-accent-soft text-accent',
            status === 'failed' && 'bg-reject/12 text-reject',
            status === 'pending' && 'bg-surface-3 text-text-3',
          )}
        >
          {status === 'done' ? <CheckCircle size={16} weight="fill" aria-hidden /> : status === 'failed' ? <WarningCircle size={16} weight="fill" aria-hidden /> : <Ic size={16} aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className={cx('text-14 font-medium', status === 'pending' ? 'text-text-2' : 'text-text')}>{def.name}</p>
            <span className="mono shrink-0 text-12 text-text-3" aria-label={elapsed != null ? `${formatElapsed(elapsed)} elapsed` : undefined}>
              {elapsed != null ? formatElapsed(elapsed) : ''}
            </span>
          </div>
          <p className={cx('mt-0.5 text-13 tabular', status === 'failed' ? 'text-reject' : status === 'done' ? 'text-text-2' : 'text-text-3')}>{text}</p>
          {status === 'running' && (id === 'upload' && stage.progress != null && stage.progress < 0.97 ? <ProgressBar value={stage.progress} /> : <IndeterminateBar />)}
          {status === 'failed' && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={onRetry}>
                Retry
              </Button>
            </div>
          )}
          {status === 'confirm' && (
            <div className="mt-3 rounded-[12px] border border-border bg-surface p-3">
              <p className="text-13 text-text-2">
                {id === 'match' ? 'Matching' : 'Detection'} runs on Vertex AI{cost || calls ? `: ${[cost, calls].filter(Boolean).join(' across ')}` : ''}. Nothing is sent until you confirm.
              </p>
              <div className="mt-3 flex flex-wrap gap-2 max-sm:flex-col">
                <Button variant="primary" size="sm" onClick={onConfirm} className="max-sm:h-11">
                  Run on Vertex AI{cost ? ` · ${cost}` : ''}
                  {confirm?.calls != null ? ` · ${confirm.calls} calls` : ''}
                </Button>
                {onSkip && (
                  <Button size="sm" onClick={onSkip} className="max-sm:h-11">
                    {skipLabel}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
