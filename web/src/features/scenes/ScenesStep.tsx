import { useEffect, useMemo } from 'react';
import { RematchBanner } from '@/features/processing/Rematch';
import { ArrowRight, Prohibit, Rows, Table } from '@phosphor-icons/react';
import { timecode } from '@/data/episode';
import { useSectionNav } from '@/features/preview/nav';
import { useProject } from '@/store/project';
import { audienceCount, useAudiences } from '@/features/audiences/model';
import { useIncludedScenes, usePlacements, useScenesWithProducts, orderBoxes } from '@/store/placements';
import { Button, EmptyState, Segmented, StepTitle, Switch, Tag } from '@/ui';
import { detectedCounts, useDetected } from '@/data/detected';
import { BoxPanel } from './BoxPanel';
import { Frame } from './Frame';
import { liveCopy, sceneAt, sceneById, scenes, useBoxSync, useLiveCopy, splitSpots } from './model';
import { getTime, onTime, pause, seek, toggle } from './player';
import { startOf, useScenesUI } from './state';
import { Timeline } from './Timeline';
import { TableView } from './TableView';
import type { ScenesView } from './state';

const typing = (el: EventTarget | null) => !!(el as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');

/**
 * Scenes: a stage (the video large, the Boxes panel at its right)
 * and a timeline strip under it. The timeline is the scene list: playing or scrubbing across a cut
 * swaps the boxes on the video and the rows in the panel. ≤1024 the panel sits under the video;
 * ≤768 everything stacks and the strip scrolls sideways.
 */
export function ScenesStep() {
  useBoxSync();
  const go = useSectionNav();
  const catalogEmpty = useProject((s) => s.products.length === 0);
  const withProducts = useScenesWithProducts().length;
  const boxes = usePlacements((s) => s.boxes);
  const assign = usePlacements((s) => s.assign);
  const viewVersion = useScenesUI((s) => s.viewVersion);
  const view = useScenesUI((s) => s.view);
  const audiences = useAudiences();
  const enabled = useMemo(() => audiences.map((r) => r.id), [audiences]);
  const includedCount = useIncludedScenes().length;
  const detected = useDetected();

  // Open on the first scene's first frame (as Previews opens on its first version); the clock drives the scene from then on.
  useEffect(() => {
    const first = scenes[0]?.moment.id;
    if (first) useScenesUI.getState().follow(first);
    seek(startOf(useScenesUI.getState().sceneId));
    const off = onTime((t) => useScenesUI.getState().follow(sceneAt(t).moment.id));
    return () => {
      off();
      pause();
      useScenesUI.setState({ drawing: false, hoverBoxId: null });
    };
  }, []);

  // Keep the "On video" audience on one that exists.
  useEffect(() => {
    if (!enabled.includes(viewVersion)) useScenesUI.getState().setViewVersion(enabled[0]);
  }, [enabled, viewVersion]);

  // Keys: space play/pause, ←/→ scene, Shift+←/→ 1 s, a add box, Esc cancels drawing or deselects the box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('[aria-modal="true"], [role="alertdialog"]')) return;
      const ui = useScenesUI.getState();
      if (e.key.toLowerCase() === 't' && !e.shiftKey) {
        e.preventDefault();
        ui.setView(ui.view === 'table' ? 'scene' : 'table');
        return;
      }
      // The table has its own keys (arrows, Enter, Delete).
      if (ui.view === 'table') return;
      const target = e.target as HTMLElement | null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (target?.closest?.('[role="radiogroup"]')) return;
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) seek(getTime() + dir);
        else {
          const i = sceneById[ui.sceneId].index;
          const next = scenes[Math.min(scenes.length - 1, Math.max(0, i + dir))];
          if (next.index !== i) ui.goScene(next.moment.id);
        }
      } else if (e.key === ' ') {
        if (target?.closest?.('button, a, [role="radio"]')) return;
        e.preventDefault();
        toggle();
      } else if (e.key.toLowerCase() === 'a' && !e.shiftKey) {
        if (liveCopy(ui.sceneId).kind === 'placeable') {
          e.preventDefault();
          ui.setDrawing(true);
        }
      } else if (e.key === 'Escape') {
        if (ui.drawing) {
          e.preventDefault();
          ui.setDrawing(false);
        } else if (ui.openBoxId) ui.openBox(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Spots: the boxes each scene shows (its best few, plus any with a product or drawn by hand).
  const all = Object.values(boxes).flatMap((list) => splitSpots(orderBoxes(list), assign).main);
  const placed = all.filter((b) => assign[b.id]?.default || Object.keys(assign[b.id]?.overrides ?? {}).length).length;
  const counts = detected ? detectedCounts(detected) : null;
  const fact = (
    <>
      {`${scenes.length} ${scenes.length === 1 ? 'scene' : 'scenes'} · ${all.length} ${all.length === 1 ? 'spot' : 'spots'} · ${placed} placed · ${audienceCount(enabled.length)}`}
      {counts && (
        <span className="mt-0.5 block text-13 text-text-3">
          {counts.surfaces} surfaces · {counts.boxes} boxes · detected by Gemini on {detected!.platform || 'Vertex AI'}
        </span>
      )}
    </>
  );

  const viewSwitch = (
    <Segmented<ScenesView>
      label="View"
      value={view}
      onChange={(v) => useScenesUI.getState().setView(v)}
      options={[
        { value: 'scene', label: <><Rows aria-hidden /> Scene</>, title: 'One scene at a time (T)' },
        { value: 'table', label: <><Table aria-hidden /> Table</>, title: 'Every box in the episode (T)' },
      ]}
      className="max-md:h-11 max-md:[&>button]:flex-1"
    />
  );

  const primary = (
    <Button
      variant="primary"
      disabled={includedCount === 0 || !withProducts}
      trailing={<ArrowRight />}
      onClick={() => go('previews')}
      className="max-md:h-11 max-md:w-full"
    >
      Create previews · {includedCount} {includedCount === 1 ? 'scene' : 'scenes'}
    </Button>
  );

  return (
    <div className="flex flex-col" data-page-keys="t">
      <StepTitle title="Add products to your scenes" fact={fact} actions={
          catalogEmpty ? undefined : (
            <>
              {viewSwitch}
              {primary}
            </>
          )
        } className="shrink-0 pb-4 max-md:[&>div:last-child]:w-full max-md:[&>div:last-child]:flex-col max-md:[&>div:last-child]:items-stretch" />
      <RematchBanner className="mb-4 shrink-0" />

      {catalogEmpty ? (
        <EmptyState
          title="No products in your catalog yet"
          body="Add the products you want to place. Then come back to put them in scenes."
          actions={
            <Button variant="primary" trailing={<ArrowRight />} onClick={() => go('catalog')}>
              Go to Catalog
            </Button>
          }
        />
      ) : view === 'table' ? (
        <TableView />
      ) : (
        <>

      {/* Desktop: the stage takes the height left under the title and above the timeline strip (about 100vh - 338 px); the video fills it. */}
      <section aria-label="Stage" className="surface rounded-[20px]! p-4 max-md:p-3 min-[1026px]:h-[max(520px,calc(100vh-338px))]">
        <div className="grid grid-cols-[minmax(0,1fr)_400px] gap-5 max-[1279px]:grid-cols-[minmax(0,1fr)_360px] max-[1025px]:grid-cols-1 max-md:gap-5 min-[1026px]:h-full">
          <div className="relative flex min-h-0 min-w-0 flex-col gap-2">
            <SceneLine />
            <Frame className="p-2 max-[1025px]:h-[min(60vh,640px)] max-md:h-[max(420px,64dvh)] min-[1026px]:min-h-0 min-[1026px]:flex-1" />
          </div>
          <div className="relative min-h-0 min-[1026px]:min-h-[380px]">
            <BoxPanel className="min-[1026px]:absolute min-[1026px]:inset-0" />
          </div>
        </div>
      </section>

      <Timeline className="mt-4 max-md:mt-5" />
        </>
      )}
    </div>
  );
}

/** "Scene 10 of 10 · Shop counter · 1:12–1:20" */
function SceneLine() {
  const sceneId = useScenesUI((s) => s.sceneId);
  const s = sceneById[sceneId];
  const copy = useLiveCopy(sceneId);
  const hasProducts = useScenesWithProducts().includes(sceneId);
  const included = usePlacements((st) => st.include[sceneId] !== false);
  return (
    // Desktop: laid over the stage's letterbox gutters (scene info top-left, Include top-right) so the video gets the full height.
    <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-2 px-1 text-13 min-[1026px]:pointer-events-none min-[1026px]:absolute min-[1026px]:inset-x-4 min-[1026px]:top-4 min-[1026px]:z-[2] min-[1026px]:items-start min-[1026px]:px-0 min-[1026px]:[&>*]:pointer-events-auto">
      <div className="flex min-w-0 flex-wrap items-center gap-2 min-[1026px]:max-w-[calc(50%_-_(100vh_-_386px)_*_0.28125_-_12px)] min-[1026px]:flex-col min-[1026px]:items-start">
        <p className="min-w-0 truncate text-text-3 min-[1026px]:flex min-[1026px]:max-w-full min-[1026px]:flex-col min-[1026px]:gap-0.5 min-[1026px]:whitespace-normal" aria-live="polite">
          <span>
            Scene {s.index + 1} of {scenes.length}
            <span className="min-[1026px]:hidden"> · </span>
          </span>
          <span className="font-medium text-text min-[1026px]:truncate min-[1026px]:text-14">{s.copy.name}</span>
          <span className="min-[1026px]:hidden"> · </span>
          <span className="mono">
            {timecode(s.from)}–{timecode(s.to)}
          </span>
        </p>
        {copy.kind === 'blocked' && (
          <Tag tone="muted" icon={<Prohibit />}>
            Skipped
          </Tag>
        )}
      </div>
      {hasProducts && (
        <label className="ml-auto flex shrink-0 items-center gap-2 text-13 font-medium text-text-2">
          Include
          <Switch checked={included} label="Include" onChange={(on) => usePlacements.getState().setInclude(sceneId, on)} />
        </label>
      )}
    </div>
  );
}
