import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise } from '@phosphor-icons/react';
import { activeEpisodeId } from '@/data/episode';
import { fetchDetectedFile } from '@/data/detected';
import { cancelJob, confirmJob, isUnreachable, startMatch, subscribeJob } from '@/services/api';
import type { JobEvent } from '@/services/api';
import { payloadSignature, projectPayload } from '@/services/payload';
import { useProject } from '@/store/project';
import { Button, Sheet, Surface, Unreachable } from '@/ui';
import { cx } from '@/lib/cx';
import { StageRow } from './StageList';
import { blankStages } from './store';
import type { StageView } from './store';

type Phase = 'idle' | 'starting' | 'running' | 'saving' | 'failed' | 'unreachable';

/** True when the catalog or audiences differ from what the active episode's stage 3 matched against. */
function useMatchStale(): boolean {
  const products = useProject((s) => s.products);
  const audiences = useProject((s) => s.audiences);
  const rec = useProject((s) => s.episodes.find((e) => e.id === activeEpisodeId));
  return useMemo(() => {
    if (!rec?.detected) return false;
    return rec.matchedWith !== undefined && rec.matchedWith !== payloadSignature(projectPayload(products, audiences));
  }, [rec, products, audiences]);
}

/**
 * "Re-match products": when the catalog or audiences changed since stage 3 ran, offer to run it
 * again (`POST /episodes/{id}/match`). The job asks first with its calls and cost; on confirm it
 * runs, and its detected.json (`?match=<id>`) replaces the cached one. The page then reloads so
 * every module reads the new suggestions. Boxes keep the products already chosen.
 */
export function RematchBanner({ className }: { className?: string }) {
  const stale = useMatchStale();
  const [open, setOpen] = useState(false);
  if (!stale && !open) return null;
  return (
    <>
      {stale && (
        <Surface radius={16} className={cx('flex flex-wrap items-center gap-3 px-4 py-3', className)}>
          <ArrowsClockwise size={18} className="shrink-0 text-accent" aria-hidden />
          <p className="min-w-0 flex-1 text-13 text-text-2">Your catalog or audiences changed since Gemini matched products. Suggestions still reflect the old list.</p>
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            Re-match products
          </Button>
        </Surface>
      )}
      <RematchSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function RematchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [stage, setStage] = useState<StageView>(blankStages().match);
  const [needs, setNeeds] = useState<{ calls?: number; cost?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const job = useRef<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const sig = useRef('');

  const finish = async (matchId: string) => {
    setPhase('saving');
    try {
      const d = await fetchDetectedFile(activeEpisodeId, matchId);
      if (!d) throw new Error('The match finished but its results could not be loaded.');
      useProject.getState().setEpisodeDetected(activeEpisodeId, d, { matchId, matchedWith: sig.current });
      window.location.reload();
    } catch (err) {
      setPhase(isUnreachable(err) ? 'unreachable' : 'failed');
      setError(err instanceof Error ? err.message : 'Could not load the new matches.');
    }
  };

  const onEvent = (e: JobEvent) => {
    if (e.stage === 'match') {
      if (e.state === 'needs_confirmation') {
        setNeeds({ calls: e.calls, cost: e.cost });
        setStage((s) => ({ ...s, status: 'confirm', message: e.message }));
      } else if (e.state === 'running' || e.state === 'progress') setStage((s) => ({ ...s, status: 'running', message: e.message, startedAt: s.startedAt ?? Date.now() }));
      else if (e.state === 'done') setStage((s) => ({ ...s, status: 'done', message: e.message, counts: e.counts, seconds: e.seconds, endedAt: Date.now() }));
      else if (e.state === 'failed') setStage((s) => ({ ...s, status: 'failed', message: e.message }));
    } else if (e.stage === 'job') {
      if (e.state === 'complete') void finish(e.matchId ?? '');
      else if (e.state === 'failed') {
        setPhase('failed');
        setError(e.message || 'Matching failed');
      } else if (e.state === 'cancelled') setPhase('idle');
    }
  };

  const start = async () => {
    stop.current?.();
    setPhase('starting');
    setError(null);
    setNeeds(null);
    setStage(blankStages().match);
    const payload = projectPayload();
    sig.current = payloadSignature(payload);
    try {
      const j = await startMatch(activeEpisodeId, payload);
      job.current = j.jobId;
      setPhase('running');
      stop.current = subscribeJob(j.jobId, onEvent, () => {
        setPhase('failed');
        setError('Lost connection to the server');
      });
    } catch (err) {
      setPhase(isUnreachable(err) ? 'unreachable' : 'failed');
      setError(err instanceof Error ? (/\(409\)/.test(err.message) ? 'Run detection on this episode first.' : err.message) : 'Could not start matching');
    }
  };

  const confirm = async () => {
    if (!job.current) return;
    setNeeds(null);
    setStage((s) => ({ ...s, status: 'running', startedAt: Date.now() }));
    try {
      await confirmJob(job.current);
    } catch (err) {
      setPhase(isUnreachable(err) ? 'unreachable' : 'failed');
      setError(err instanceof Error ? err.message : 'Could not start matching');
    }
  };

  const close = () => {
    stop.current?.();
    stop.current = null;
    if (job.current && phase === 'running' && stage.status !== 'done') void cancelJob(job.current);
    job.current = null;
    setPhase('idle');
    onClose();
  };

  // Start when opened; tick the elapsed time while running.
  useEffect(() => {
    if (open && phase === 'idle') void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (stage.status !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [stage.status]);
  useEffect(() => () => stop.current?.(), []);

  return (
    <Sheet open={open} onClose={close} title="Re-match products" description="Gemini matches your current catalog and audiences to every placement area again. Your chosen products stay." width={460}>
      <div className="flex flex-col gap-3 px-3 pt-1 pb-5">
        {phase === 'unreachable' ? (
          <Unreachable what="matching" onRetry={start} className="py-10! shadow-none" />
        ) : (
          <>
            <ol aria-label="Matching">
              <StageRow id="match" stage={phase === 'starting' ? { ...stage, status: 'running', message: 'Starting' } : stage} now={now} confirm={needs} onConfirm={() => void confirm()} onSkip={close} skipLabel="Cancel" onRetry={() => void start()} />
            </ol>
            {phase === 'saving' && <p className="px-3 text-13 text-text-2">Loading the new matches…</p>}
            {phase === 'failed' && error && (
              <div className="flex flex-wrap items-center gap-2 px-3">
                <p className="text-13 text-reject">{error}</p>
                {stage.status !== 'failed' && (
                  <Button size="sm" onClick={() => void start()}>
                    Retry
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
