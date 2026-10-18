import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowsClockwise, Check, CircleNotch, Info, Play, WarningCircle } from '@phosphor-icons/react';
import { activeEpisodeId, timecode } from '@/data/episode';
import { audienceLabel } from '@/features/audiences/model';
import { useSectionNav } from '@/features/preview/nav';
import { useStills } from '@/features/preview/stills';
import { sceneById, useBoxSync } from '@/features/scenes/model';
import { apiConfig, clipUrl } from '@/services/api';
import type { RenderResolution, RenderView } from '@/services/api';
import { useApprovedVersions, versionId } from '@/store/placements';
import type { SceneVersion } from '@/store/placements';
import { cx } from '@/lib/cx';
import { Button, ConfirmDialog, EmptyState, StepTitle, Surface, Tag } from '@/ui';
import { renderSrc, renderVersion, renderVersions, stillIdOf, useRenders } from './renders';

/**
 * Render (Gemini Omni): every approved preview becomes a clip. Omni edits the shot's own video so its
 * products match the approved still, Gemini checks the result, and the clip is shown beside the original.
 * Clips render at 360p to keep costs low.
 */
export function RenderStep() {
  useBoxSync();
  const go = useSectionNav();
  const approved = useApprovedVersions();
  const stills = useStills((s) => s.stills);
  const renders = useRenders((s) => s.byVersion);
  // 360p only (cost).
  const resolution: RenderResolution = '360p';
  const [price, setPrice] = useState<Record<RenderResolution, number> | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    apiConfig().then((c) => setPrice(c.videoPricePerSecond), () => undefined);
  }, []);

  // Renderable: approved and with a still (Omni's reference). Grouped by scene, story order.
  const versions = useMemo(() => approved.filter((v) => stills[versionId(v)]), [approved, stills]);
  const groups = useMemo(() => {
    const m = new Map<string, SceneVersion[]>();
    for (const v of versions) m.set(v.sceneId, [...(m.get(v.sceneId) ?? []), v]);
    return [...m.entries()];
  }, [versions]);
  const current = (v: SceneVersion) => {
    const r = renders[versionId(v)];
    // Counts only when made at this resolution from the version's current still.
    return r && r.resolution === resolution && r.status !== 'failed' && r.stillId === stillIdOf(v) ? r : undefined;
  };
  const todo = versions.filter((v) => !current(v));
  const running = versions.filter((v) => renders[versionId(v)]?.status === 'running').length;
  const done = versions.filter((v) => current(v)?.status === 'done').length;
  const seconds = todo.reduce((n, v) => n + (sceneById[v.sceneId].to - sceneById[v.sceneId].from), 0);
  const estimate = price ? seconds * price[resolution] : null;

  if (!versions.length)
    return (
      <div className="flex flex-col pb-2">
        <StepTitle title="Render with Gemini Omni" fact="Nothing approved yet" className="pb-5" />
        <EmptyState
          title="Approve a preview first"
          body="Each approved preview still becomes a clip: Gemini Omni edits the shot so its products look exactly like the still."
          actions={
            <Button variant="primary" trailing={<ArrowRight />} onClick={() => go('previews')}>
              Go to Previews
            </Button>
          }
        />
      </div>
    );

  return (
    <div className="flex flex-col gap-4 pb-2">
      <StepTitle
        title="Render with Gemini Omni"
        fact={`${versions.length} approved ${versions.length === 1 ? 'version' : 'versions'} · ${done} rendered`}
        className="pb-1 max-md:[&>div:last-child]:w-full"
        actions={
          <>
            <Button variant={todo.length ? 'primary' : 'secondary'} icon={<Play weight="fill" />} loading={running > 0} disabled={!todo.length || running > 0} onClick={() => setConfirm(true)} className="max-md:h-11 max-md:w-full">
              {running ? `Rendering ${running}` : todo.length ? `Render all · ${todo.length}` : 'All rendered'}
            </Button>
            <Button variant={todo.length ? 'secondary' : 'primary'} trailing={<ArrowRight />} onClick={() => go('watch')} className="max-md:h-11 max-md:w-full">
              Continue to Watch
            </Button>
          </>
        }
      />
      <p className="flex items-center gap-2 text-13 text-text-3">
        <Info size={15} aria-hidden /> Clips render at 360p to keep costs low.
      </p>

      <ol className="flex flex-col gap-4" aria-label="Scenes">
        {groups.map(([sceneId, list]) => (
          <li key={sceneId}>
            <SceneCard sceneId={sceneId} versions={list} current={current} resolution={resolution} price={price?.[resolution] ?? null} />
          </li>
        ))}
      </ol>

      <ConfirmDialog
        open={confirm}
        title={`Render ${todo.length} ${todo.length === 1 ? 'clip' : 'clips'} at ${resolution}?`}
        description={`Gemini Omni edits ${Math.round(seconds)} s of video${estimate !== null ? `, about $${estimate.toFixed(2)}` : ''}. Clips already rendered are kept and never charged again.`}
        confirmLabel="Render"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void renderVersions(todo, resolution);
        }}
      />
    </div>
  );
}

function SceneCard({ sceneId, versions, current, resolution, price }: { sceneId: string; versions: SceneVersion[]; current: (v: SceneVersion) => RenderView | undefined; resolution: RenderResolution; price: number | null }) {
  const scene = sceneById[sceneId];
  const original = clipUrl(activeEpisodeId, scene.shot.id);
  return (
    <Surface radius={20} className="flex flex-col gap-4 p-4 max-md:p-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-16 font-semibold text-text">{scene.copy.name}</h3>
        <span className="text-13 text-text-3">
          Scene {scene.index + 1} · <span className="mono">{timecode(scene.from)}–{timecode(scene.to)}</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-4">
        <Clip src={original} label="Original" />
        {versions.map((v) => (
          <Version key={versionId(v)} version={v} render={current(v)} resolution={resolution} price={price} seconds={scene.to - scene.from} />
        ))}
      </div>
    </Surface>
  );
}

/** One audience's clip: the render when done, else its keyframe with the status and the action. */
function Version({ version: v, render: r, resolution, price, seconds }: { version: SceneVersion; render?: RenderView; resolution: RenderResolution; price: number | null; seconds: number }) {
  const any = useRenders((s) => s.byVersion[versionId(v)]);
  const src = renderSrc(r);
  const label = audienceLabel(v.audienceId);
  const start = () => void renderVersion(v, resolution);
  const can = !!stillIdOf(v);
  return (
    <div className="flex flex-col gap-2">
      {src ? (
        <Clip src={src} label={label} accent />
      ) : (
        <Placeholder version={v} label={label} running={r?.status === 'running'} stage={r?.stage} since={r?.startedAt} />
      )}
      {/* w-0 min-w-full: the status line takes the clip's width and never widens the tile. */}
      <div className="flex min-h-9 w-0 min-w-full flex-wrap items-center gap-x-2 gap-y-1.5">
        <Status render={r} failed={any?.status === 'failed' && any.resolution === resolution ? any : undefined} />
        <span className="flex-1" />
        {r?.status === 'done' && r.verify?.pass === false && (
          <Button size="sm" variant="secondary" icon={<ArrowsClockwise />} onClick={() => void renderVersion(v, resolution, (r.attempt ?? 1) + 1)}>
            Try again
          </Button>
        )}
        {!r && (
          <Button size="sm" variant="secondary" icon={any?.status === 'failed' ? <ArrowsClockwise /> : <Play weight="fill" />} disabled={!can} onClick={start}>
            {any?.status === 'failed' ? 'Retry' : `Render${price !== null ? ` · $${(price * seconds).toFixed(2)}` : ''}`}
          </Button>
        )}
      </div>
    </div>
  );
}

function Status({ render: r, failed }: { render?: RenderView; failed?: RenderView }) {
  if (failed)
    return (
      <span className="flex min-w-0 items-start gap-1.5 text-13 leading-[18px] text-reject" title={failed.error}>
        <WarningCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
        <span className="line-clamp-3">{failed.error ?? 'Failed'}</span>
      </span>
    );
  if (!r) return <span className="text-13 text-text-3">Not rendered</span>;
  if (r.status === 'running')
    return (
      <span className="flex items-center gap-1.5 text-13 font-medium text-accent">
        <CircleNotch size={14} className="motion-safe:animate-spin" aria-hidden /> {r.stage === 'verifying' ? 'Checking with Gemini' : 'Rendering with Omni'}
      </span>
    );
  const v = r.verify;
  if (v?.pass === false)
    return (
      <Tag tone="muted" icon={<WarningCircle />} className="min-w-0 max-w-full">
        <span className="truncate" title={v.note}>Needs review · {v.note}</span>
      </Tag>
    );
  return (
    <span className="flex items-center gap-1.5 text-13 font-medium text-pass" title={v?.note}>
      <Check size={14} weight="bold" aria-hidden /> {v?.pass ? 'Verified' : 'Ready'}
      {r.continuity && <span className="font-normal text-text-3">· matched to the scene</span>}
    </span>
  );
}

/** Height of a clip tile: vertical episodes stay readable side by side; landscape ones are wider. */
const TILE = 'h-[360px] max-md:h-[260px]';

function Clip({ src, label, accent }: { src: string; label: string; accent?: boolean }) {
  return (
    <figure className={cx('relative max-w-full overflow-hidden rounded-[14px] bg-black shadow-[0_0_0_1px_var(--border)]', TILE)}>
      <video src={src} autoPlay muted loop playsInline className="h-full w-auto max-w-full object-contain" />
      <figcaption className={cx('pointer-events-none absolute top-2 left-2 rounded-[8px] bg-black/65 px-2 py-1 text-12 font-medium', accent ? 'text-accent' : 'text-white/85')}>{label}</figcaption>
    </figure>
  );
}

function Placeholder({ version: v, label, running, stage, since }: { version: SceneVersion; label: string; running: boolean; stage?: string; since?: number }) {
  const still = useStills((s) => s.stills[versionId(v)]?.url);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const secs = since ? Math.max(0, Math.round(now / 1000 - since)) : 0;
  return (
    <figure className={cx('relative max-w-full overflow-hidden rounded-[14px] bg-black shadow-[0_0_0_1px_var(--border)]', TILE)}>
      {still && <img src={still} alt="" className={cx('h-full w-auto max-w-full object-contain', running ? 'opacity-40' : 'opacity-70')} />}
      <figcaption className="pointer-events-none absolute top-2 left-2 rounded-[8px] bg-black/65 px-2 py-1 text-12 font-medium text-white/85">{label}</figcaption>
      {running && (
        <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white">
          <div aria-hidden className="shimmer absolute inset-0 opacity-60" />
          <span className="relative text-[28px] leading-none font-semibold tabular-nums">{secs}s</span>
          <span className="relative text-13 text-white/80">{stage === 'verifying' ? 'Gemini is checking the clip' : 'Gemini Omni is editing the shot'}</span>
          <span className="relative text-12 text-white/60">Usually one to two minutes</span>
        </div>
      )}
    </figure>
  );
}
