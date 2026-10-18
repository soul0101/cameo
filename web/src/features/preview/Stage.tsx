import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { timecode } from '@/data/episode';
import { ArrowCounterClockwise, ArrowRight, ArrowsClockwise, Check, Sparkle } from '@phosphor-icons/react';
import { audienceLabel } from '@/features/audiences/model';
import { sceneById } from '@/features/scenes/model';
import { usePlacements } from '@/store/placements';
import type { SceneVersion } from '@/store/placements';
import { cx } from '@/lib/cx';
import { Button, Segmented, Tag, toast, useToastLift } from '@/ui';
import { useChangedSinceApproval } from './changed';
import { BoxOverlay, Frame, FrameLabel, GenOverlay, WipeFrame } from './SceneFrame';
import { generateStill, useStill } from './stills';
import { episodeAspect } from '@/data/detected';
import { ShotPanel } from './ShotPanel';
import { useVersionItems } from './items';

/**
 * Frame height: fill the viewport below the header (title, stage bar, sticky actions). Vertical
 * episodes keep Before and After side by side, so each is also at most half the stage wide
 * (`cqw` = the stage's width); landscape ones stack, full width.
 */
const frameHeight = (aspect: number) =>
  aspect < 1 ? `max(200px, min(calc(100dvh - 318px), calc((100cqw - 24px) / 2 / ${aspect})))` : 'max(200px, calc(100dvh - 318px))';

type Mode = 'side' | 'compare';

/**
 * One scene version on Previews Before (the real keyframe with its boxes and
 * products) beside After (the still Nano Banana made from the edit prompt, or a Generate button),
 * Compare as a wipe once a still exists, and Approve for a generated still. The prompt panel at the
 * right is what generation sends; editing it marks the still out of date.
 */
export function Stage({
  version,
  onNext,
  tabs,
  focus,
  onFocus,
}: {
  version: SceneVersion;
  /** The scene's audiences (AudienceTabs), sticky above the frame. */
  tabs: ReactNode;
  /** The box clicked on the frame (its product row is highlighted in the panel). */
  focus: number | null;
  onFocus: (n: number | null) => void;
  /** Moves to the next unapproved version; absent when none is left. */
  onNext?: () => void;
}) {
  // The sticky action bar sits at the bottom: keep toasts above it.
  useToastLift(92);
  const { sceneId, audienceId } = version;
  const scene = sceneById[sceneId];
  const items = useVersionItems(sceneId, audienceId);
  const approved = usePlacements((s) => !!s.approved[sceneId]?.[audienceId]);
  const changed = useChangedSinceApproval(sceneId, audienceId);
  const { still, stale, running } = useStill(version);
  const [mode, setMode] = useState<Mode>('side');
  const busy = running !== null;
  const count = new Set(items.map((i) => i.product.id)).size;
  useEffect(() => {
    if (!still || busy) setMode('side');
  }, [still, busy]);
  const generate = () => void generateStill(version);
  const aspect = episodeAspect();

  const approve = () => {
    usePlacements.getState().setApproved(sceneId, audienceId, true);
    toast({ title: 'Approved', description: `${scene.copy.name} · ${audienceLabel(audienceId)}`, tone: 'pass' });
  };

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_380px] items-start gap-5 max-lg:grid-cols-1">
      <section aria-label={`${scene.copy.name}, ${audienceLabel(audienceId)}`} className="@container flex min-w-0 flex-col gap-3" style={{ ['--fh' as string]: frameHeight(aspect) }}>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="truncate text-20 font-semibold text-text">{scene.copy.name}</h2>
          <span className="text-13 text-text-3">
            Scene {scene.index + 1} · <span className="mono">{timecode(scene.from)}–{timecode(scene.to)}</span>
          </span>
          {changed && (
            <Tag tone="muted" icon={<ArrowsClockwise />} className="self-center">
              Changed since approval
            </Tag>
          )}
        </div>
        <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-3 bg-bg px-1 py-2">
          {tabs}
          <Segmented
            label="View"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'side', label: 'Side by side' },
              { value: 'compare', label: 'Compare', disabled: !still || busy, title: still ? undefined : 'Generate first' },
            ]}
          />
        </div>

        <div className={cx('flex justify-center gap-6 max-md:gap-3', aspect < 1 ? 'flex-nowrap' : 'flex-col items-center')}>
          {mode === 'compare' && still ? (
            <WipeFrame key={still.url} before={<img src={scene.moment.keyframe} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />} after={<img src={still.url} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />} />
          ) : (
            <>
              <Frame label={`Before: ${scene.copy.name}, keyframe with ${items.length} ${items.length === 1 ? 'box' : 'boxes'}`}>
                <img src={scene.moment.keyframe} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
                <BoxOverlay items={items} audience={audienceId} onPick={onFocus} />
                <FrameLabel>Before</FrameLabel>
              </Frame>
              <Frame label={`After: ${scene.copy.name}, ${audienceLabel(audienceId)}`}>
                {still ? (
                  <img src={still.url} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
                ) : (
                  <>
                    <img src={scene.moment.keyframe} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
                    <div aria-hidden className="absolute inset-0 bg-black/60" />
                  </>
                )}
                {busy && <GenOverlay since={running!} count={count} />}
                {!busy && !still && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
                    <Button variant="primary" size="lg" icon={<Sparkle />} disabled={!items.length} onClick={generate} className="max-md:h-9 max-md:px-3 max-md:text-13">
                      Generate preview
                    </Button>
                    <span className="text-12 text-white/70">Nano Banana · one image</span>
                  </div>
                )}
                {!busy && still && stale && (
                  <span className="absolute inset-x-0 bottom-4 mx-auto w-fit rounded-[8px] bg-black/70 px-2.5 py-1 text-13 text-white/90">Prompt or products changed · regenerate</span>
                )}
                <FrameLabel accent right>
                  After
                </FrameLabel>
              </Frame>
            </>
          )}
        </div>

        <div className="surface sticky bottom-3 z-10 mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-2 rounded-[16px] p-2 max-md:w-full max-md:[&>*]:flex-1">
          {approved ? (
            <>
              <span className="inline-flex h-9 items-center gap-1.5 px-2 text-14 font-semibold text-pass">
                <Check size={18} weight="bold" aria-hidden /> Approved
              </span>
              <Button variant="ghost" icon={<ArrowCounterClockwise />} onClick={() => usePlacements.getState().setApproved(sceneId, audienceId, false)}>
                Undo
              </Button>
            </>
          ) : (
            <Button variant="primary" icon={<Check />} disabled={!still || busy || stale} onClick={approve} title={still ? undefined : 'Generate a preview first'}>
              Approve
            </Button>
          )}
          {still && (
            <Button variant="ghost" icon={<ArrowsClockwise />} loading={busy} disabled={busy} onClick={generate}>
              Regenerate
            </Button>
          )}
          {onNext && (
            <Button variant={approved ? 'primary' : 'ghost'} trailing={<ArrowRight />} onClick={onNext} className={cx(approved && 'ml-2')}>
              Next version
            </Button>
          )}
        </div>
      </section>

      <div className="sticky top-6 min-w-0">
        <ShotPanel sceneId={sceneId} audience={audienceId} items={items} focusN={focus} />
      </div>
    </div>
  );
}
