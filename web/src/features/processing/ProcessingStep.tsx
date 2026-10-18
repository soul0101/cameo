import { cx } from '@/lib/cx';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Check, Clock, Moon, Sun } from '@phosphor-icons/react';
import { openEpisode, posterOf } from '@/data/episode';
import { useMediaQuery } from '@/lib/hooks';
import { EASE } from '@/lib/motion';
import { isUnreachable, mediaUrl } from '@/services/api';
import { useFlow } from '@/store/flow';
import { useProject } from '@/store/project';
import { useTheme } from '@/store/theme';
import { Button, LogoMark, ProgressRing, Surface, Tooltip, Unreachable, toast } from '@/ui';
import { storeProcessedEpisode } from './finish';
import { hasPendingFile, takePendingFile } from './pending';
import { StageRow, overallProgress, visibleStages } from './StageList';
import { STAGE_ORDER, savedRun, useRun } from './store';

const AUTO_OPEN_MS = 1500;
let teardown: ReturnType<typeof setTimeout> | undefined;

/** Route id for a fresh upload (the API assigns the episode id once the file is in). */
const NEW_UPLOAD_ID = 'new';

/**
 * `/p/:projectId/processing`: the real pipeline with a stage list and a quiet log. `new` uploads the
 * file dropped on Landing; a stored episode with `?rerun=1` re-runs its detection (the cost card
 * again). When the API does not answer, a calm "Backend unreachable" state offers a retry.
 */
export function ProcessingStep() {
  const { projectId = '' } = useParams();
  const [params] = useSearchParams();
  const rerun = params.has('rerun');
  const known = useProject((s) => s.episodes.some((e) => e.id === projectId));
  const running = useRun((s) => s.phase !== 'idle');
  const ok = (projectId === NEW_UPLOAD_ID && (hasPendingFile() || running || !!savedRun())) || (rerun && known);
  if (!ok) return <Navigate to="/" replace />;
  return <Processing projectId={projectId} rerun={rerun} />;
}

function Processing({ projectId, rerun }: { projectId: string; rerun: boolean }) {
  const navigate = useNavigate();
  const run = useRun();
  const { phase, job, stages, log, file, localUrl, needs, error, totals, unreachable } = run;
  const resolved = useTheme((s) => s.resolved);
  const setMode = useTheme((s) => s.setMode);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [now, setNow] = useState(() => Date.now());
  const [hover, setHover] = useState(false);
  const [remaining, setRemaining] = useState(AUTO_OPEN_MS);
  // The episode's own shape, read from the video itself (9:16 until it loads).
  const [aspect, setAspect] = useState(9 / 16);

  // Start once. The teardown is deferred a tick so React StrictMode's remount keeps the same run.
  useEffect(() => {
    clearTimeout(teardown);
    const s = useRun.getState();
    if (s.phase === 'idle') {
      if (rerun) s.beginRerun(projectId);
      else if (hasPendingFile()) s.begin(takePendingFile());
      else {
        const saved = savedRun();
        if (saved) s.resume(saved);
      }
    }
    document.title = 'Processing · Cameo';
    return () => {
      teardown = setTimeout(() => useRun.getState().reset(), 0);
    };
  }, []);

  const active = phase === 'starting' || phase === 'running';
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [active]);

  // Completion: cache this episode's detection on its record, toast, then (after the countdown) open Scenes.
  const finished = useRef<string | null>(null);
  const [stored, setStored] = useState<{ id: string; poster: string } | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const episodeName = useProject((s) => s.episodes.find((e) => e.id === (job?.episodeId ?? projectId))?.name);
  const name = file?.name.replace(/\.[^.]+$/, '') ?? run.resumedName ?? episodeName ?? 'Your episode';
  useEffect(() => {
    const key = `${job?.jobId}:${loadAttempt}`;
    if (phase !== 'complete' || !job || finished.current === key) return;
    finished.current = key;
    setStoreError(null);
    const c = stages.understand.counts;
    void storeProcessedEpisode(job.episodeId, name, rerun).then(
      (rec) => {
        if (!rec) return setStoreError('Detection finished but its results could not be loaded. Retry.');
        if (file) useFlow.getState().setUploadName(file.name);
        setStored({ id: rec.id, poster: posterOf(rec) });
        toast({ tone: 'pass', title: 'Your scenes are ready', description: c?.scenes != null ? `${c.scenes} ${c.scenes === 1 ? 'scene' : 'scenes'} found` : undefined });
        setRemaining(AUTO_OPEN_MS);
      },
      (err: unknown) =>
        setStoreError(isUnreachable(err) ? 'Detection finished, but the API stopped answering before its results loaded. Retry.' : 'Detection finished but its results could not be loaded. Retry.'),
    );
  }, [phase, job, file, stages, name, rerun, loadAttempt]);

  const openScenes = () => stored && openEpisode(stored.id);
  useEffect(() => {
    if (phase !== 'complete' || !stored || hover) return;
    if (remaining <= 0) {
      openScenes();
      return;
    }
    const id = setTimeout(() => setRemaining((r) => r - 100), 100);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stored, hover, remaining]);

  const cancel = async () => {
    await run.cancel();
    navigate('/');
  };

  const progress = phase === 'complete' ? 1 : overallProgress(stages, now);
  const confirming = STAGE_ORDER.some((id) => stages[id].status === 'confirm');
  // Gemini's calls usually answer in seconds, but one can take a minute or more: say so while detection runs.
  const detecting = phase === 'running' && !confirming && (['vision', 'understand', 'localise', 'match'] as const).some((id) => stages[id].status === 'running');
  const title =
    phase === 'complete' ? 'Your scenes are ready' : phase === 'failed' ? 'Processing stopped' : phase === 'cancelled' ? 'Cancelled' : confirming ? 'Ready to run detection' : stages.upload.status === 'running' ? 'Uploading your video' : phase === 'starting' ? 'Starting' : 'Finding your scenes';
  // once ingest has written the 360p proxy, play the API's copy (the episode's own media URL)
  const videoSrc = job && (stages.ingest.status === 'done' || !localUrl) ? mediaUrl(job.episodeId, 'proxy') : (localUrl ?? undefined);
  const done = phase === 'complete';
  const lines = log.slice(-6);

  return (
    <div
      className="vignette flex min-h-dvh flex-col bg-fixed text-text"
    >
      <header className="flex h-16 shrink-0 items-center gap-2 px-8 max-md:h-14 max-md:px-4">
        <span className="flex items-center gap-2.5 text-16 font-semibold tracking-[-0.01em]">
          <LogoMark size={22} title={null} />
          Cameo
        </span>
        <span className="flex-1" />
        <Tooltip content={resolved === 'dark' ? 'Light theme' : 'Dark theme'} side="bottom">
          <Button
            variant="ghost"
            iconOnly
            icon={resolved === 'dark' ? <Sun /> : <Moon />}
            aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
            className="max-md:size-11"
          />
        </Tooltip>
      </header>

      <main id="main" className="flex flex-1 items-center justify-center px-8 pt-2 pb-12 max-md:items-start max-md:px-4 max-md:pb-8">
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.26, ease: EASE }}
          // Hovering pauses the countdown only when the pointer arrives after the run finished: the
          // pointer that just pressed "Run detection" (uploads) sits over this card and must not hold it.
          onPointerEnter={(e) => e.pointerType === 'mouse' && done && setHover(true)}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(false)}
          className="grid w-full max-w-[1040px] grid-cols-[auto_minmax(0,1fr)] items-center gap-8 max-md:grid-cols-1 max-md:gap-5"
        >
          {/* Left: the episode, muted and looping, with the overall progress ring. */}
          <Surface
            radius={20}
            className={cx('mx-auto overflow-hidden bg-black! p-0', aspect < 1 ? 'max-md:w-[min(200px,52vw)]' : 'max-md:w-full')}
            style={{ width: `min(${aspect < 1 ? 340 : 520}px, calc((100dvh - 180px) * ${aspect}))` }}
          >
            <div className="relative w-full" style={{ aspectRatio: aspect }}>
              {videoSrc && (
                <video
                  key={videoSrc}
                  src={videoSrc}
                  poster={stored?.poster || undefined}
                  muted
                  loop
                  playsInline
                  autoPlay={!reduced}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
                  }}
                  aria-label="Your episode, playing muted"
                  className="absolute inset-0 size-full object-cover"
                />
              )}
              <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/70 to-transparent pt-16 pb-4 max-md:pb-3">
                <span className="inline-flex rounded-full bg-black/55 p-1.5 backdrop-blur-md">
                  <ProgressRing value={progress} size={52} stroke={3} label="Overall progress" tone={done ? 'pass' : 'accent'}>
                    {done ? <Check size={16} weight="bold" className="text-pass" aria-hidden /> : <span className="mono text-11 text-white">{Math.round(progress * 100)}%</span>}
                  </ProgressRing>
                </span>
              </div>
            </div>
          </Surface>

          {/* Right: stages, log, actions. */}
          <Surface radius={20} className="flex min-w-0 flex-col p-2">
            <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
              <div className="min-w-0">
                <h1 className="text-20 font-semibold tracking-[-0.01em] text-text" aria-live="polite">
                  {title}
                </h1>
                <p className="truncate text-13 text-text-2">{name}</p>
              </div>
            </div>

            {detecting && (
              <div role="status" className="mx-3 mb-2 flex items-start gap-2.5 rounded-[12px] bg-accent-soft px-3.5 py-2.5 text-13 leading-snug text-text">
                <Clock size={16} weight="bold" aria-hidden className="mt-px shrink-0 text-accent" />
                <span>This can take a few minutes while Gemini studies every shot of your video. Keep this page open.</span>
              </div>
            )}

            <ol className="flex flex-col gap-0.5 px-1" aria-label="Processing stages">
              {visibleStages(stages).map((id) => (
                <StageRow
                  key={id}
                  id={id}
                  stage={stages[id]}
                  now={now}
                  confirm={stages[id].status === 'confirm' ? needs : null}
                  onConfirm={() => void run.confirm()}
                  onSkip={() => void cancel()}
                  onRetry={run.retry}
                />
              ))}
            </ol>

            {phase === 'failed' && unreachable && <Unreachable what="processing" onRetry={run.retry} className="mx-2 mt-2 py-8! shadow-none" />}
            {phase === 'failed' && error && !unreachable && !STAGE_ORDER.some((id) => stages[id].status === 'failed') && (
              <div className="mx-4 mt-2 flex flex-wrap items-center gap-2">
                <p className="text-13 text-reject">{error}</p>
                <Button size="sm" onClick={run.retry}>
                  Retry
                </Button>
              </div>
            )}

            {done && storeError && (
              <div className="mx-4 mt-2 flex flex-wrap items-center gap-2">
                <p className="text-13 text-reject">{storeError}</p>
                {/* loads the finished results again; detection is not run (or paid for) twice */}
                <Button size="sm" onClick={() => setLoadAttempt((a) => a + 1)}>
                  Retry
                </Button>
              </div>
            )}
            {done && totals?.cost != null && (
              <p className="mx-4 mt-2 text-13 text-text-2">
                Detection on Vertex AI · {totals.calls ?? 0} calls · ${totals.cost.toFixed(2)}
              </p>
            )}

            <ul className="mono mx-4 mt-4 min-h-[6lh] list-none text-12 leading-[1.6] text-text-3" aria-label="Activity log">
              {lines.map((l, i) => (
                <li key={l.seq} className="truncate" style={{ opacity: 0.5 + (0.5 * (i + 1)) / lines.length }}>
                  {l.text}
                </li>
              ))}
            </ul>

            <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 max-sm:flex-col-reverse max-sm:items-stretch">
              {done && stored ? (
                <span className="mono text-12 text-text-3 max-sm:text-center" aria-hidden={hover}>
                  {hover ? 'Paused' : `Opening in ${(Math.max(0, remaining) / 1000).toFixed(1)} s`}
                </span>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2 max-sm:flex-col-reverse max-sm:items-stretch">
                {!done && (
                  <Button variant="ghost" onClick={() => void cancel()} className="max-md:h-11">
                    {phase === 'failed' || phase === 'cancelled' ? 'Back' : 'Cancel'}
                  </Button>
                )}
                {done && (
                  <Button variant="primary" trailing={<ArrowRight />} onClick={openScenes} disabled={!stored} className="max-md:h-11">
                    Open scenes
                  </Button>
                )}
              </div>
            </div>
          </Surface>
        </motion.div>
      </main>
    </div>
  );
}
