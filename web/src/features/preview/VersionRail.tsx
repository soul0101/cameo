import { ArrowsClockwise, Check } from '@phosphor-icons/react';
import { audienceLabel } from '@/features/audiences/model';
import { sceneById } from '@/features/scenes/model';
import { usePlacements, versionId } from '@/store/placements';
import type { SceneVersion } from '@/store/placements';
import { cx } from '@/lib/cx';
import { useChangedSinceApproval } from './changed';
import { useStill, useStills } from './stills';
/** "Not generated" · "Generating" · "Ready" · "Approved ✓" · "Changed since approval". */
function StatusText({ v, compact }: { v: SceneVersion; compact?: boolean }) {
  const approved = usePlacements((s) => !!s.approved[v.sceneId]?.[v.audienceId]);
  const changed = useChangedSinceApproval(v.sceneId, v.audienceId);
  const { still, stale, running } = useStill(v);
  if (running !== null) return <span className="text-13 font-medium text-accent">Generating</span>;
  if (approved)
    return (
      <span className="inline-flex items-center gap-1 text-13 font-medium text-pass">
        Approved <Check size={14} weight="bold" aria-hidden />
      </span>
    );
  if (changed)
    return (
      <span className="inline-flex items-center gap-1 text-13 text-text-2">
        <ArrowsClockwise size={14} aria-hidden /> {compact ? 'Changed' : 'Changed since approval'}
      </span>
    );
  if (still) return <span className="text-13 font-medium text-text">{stale ? 'Out of date' : 'Ready'}</span>;
  return <span className="text-13 text-text-3">Not generated</span>;
}

interface RailProps {
  versions: SceneVersion[];
  selected: string;
  onSelect: (v: SceneVersion) => void;
}

/** The included scenes in order, each with its versions (one per audience). */
function groupByScene(versions: SceneVersion[]): Array<{ sceneId: string; items: SceneVersion[] }> {
  const groups: Array<{ sceneId: string; items: SceneVersion[] }> = [];
  for (const v of versions) {
    const last = groups[groups.length - 1];
    if (last?.sceneId === v.sceneId) last.items.push(v);
    else groups.push({ sceneId: v.sceneId, items: [v] });
  }
  return groups;
}

/** One line for a scene across its audiences: "Generating", "2 of 3 ready", "1 of 3 approved", "All 3 approved". */
function SceneSummary({ items }: { items: SceneVersion[] }) {
  const approved = usePlacements((s) => items.filter((v) => s.approved[v.sceneId]?.[v.audienceId]).length);
  const ready = useStills((s) => items.filter((v) => s.stills[versionId(v)]).length);
  const generating = useStills((s) => items.some((v) => s.running[versionId(v)]));
  const n = items.length;
  if (generating) return <span className="text-12 font-medium text-accent">Generating</span>;
  if (approved === n)
    return (
      <span className="inline-flex items-center gap-1 text-12 font-medium text-pass">
        {n === 1 ? 'Approved' : `All ${n} approved`} <Check size={12} weight="bold" aria-hidden />
      </span>
    );
  if (approved) return <span className="text-12 text-text-2">{approved} of {n} approved</span>;
  if (ready) return <span className="text-12 text-text-2">{ready} of {n} ready</span>;
  return <span className="text-12 text-text-3">Not generated</span>;
}

/**
 * Desktop rail (280): one row per included scene (keyframe, name, audiences, a status line).
 * The audiences of the selected scene are the tabs above the stage. Mobile: a horizontal scene scroller.
 */
export function VersionRail({ versions, selected, onSelect }: RailProps) {
  const groups = groupByScene(versions);
  const selectedScene = versions.find((v) => versionId(v) === selected)?.sceneId;
  const audienceOf = versions.find((v) => versionId(v) === selected)?.audienceId;
  // Moving to another scene keeps the audience when it has one there.
  const pick = (items: SceneVersion[]) => onSelect(items.find((v) => v.audienceId === audienceOf) ?? items[0]);

  return (
    <>
      <nav aria-label="Scenes" className="surface sticky top-6 flex max-h-[calc(100dvh-48px)] flex-col overflow-hidden rounded-[20px] max-md:hidden">
        <header className="flex h-[49px] shrink-0 items-center border-b border-border px-4">
          <h3 className="text-14 font-semibold text-text">
            Scenes <span className="font-normal text-text-3">· {groups.length}</span>
          </h3>
        </header>
        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto p-2">
        {groups.map((g) => {
          const s = sceneById[g.sceneId];
          const active = g.sceneId === selectedScene;
          return (
            <button
              key={g.sceneId}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => pick(g.items)}
              className={cx(
                'flex w-full items-center gap-3 rounded-[12px] p-2 text-left transition-[background-color,box-shadow] duration-200 ease-cameo',
                active ? 'bg-surface-3 shadow-[inset_0_0_0_1px_var(--accent)]' : 'hover:bg-surface-3',
              )}
            >
              <img src={s.moment.keyframe} alt="" className="h-14 w-8 shrink-0 rounded-[8px] object-cover shadow-[0_0_0_1px_var(--border)]" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-1.5">
                  <span className={cx('truncate text-14', active ? 'font-semibold text-text' : 'font-medium text-text-2')}>{s.copy.name}</span>
                  <span className="shrink-0 text-12 text-text-3">Scene {s.index + 1}</span>
                </span>
                <span className="truncate text-12 text-text-3">{g.items.map((v) => audienceLabel(v.audienceId)).join(' · ')}</span>
                <SceneSummary items={g.items} />
              </span>
            </button>
          );
        })}
        </div>
      </nav>

      <ul aria-label="Scenes" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:hidden">
        {groups.map((g) => {
          const s = sceneById[g.sceneId];
          const active = g.sceneId === selectedScene;
          return (
            <li key={g.sceneId} className="shrink-0">
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => pick(g.items)}
                className={cx(
                  'flex h-14 items-center gap-2 rounded-[12px] border p-1.5 pr-3 text-left transition-[background-color,border-color] duration-200 ease-cameo',
                  active ? 'border-accent bg-accent-soft' : 'border-border bg-surface',
                )}
              >
                <img src={s.moment.keyframe} alt="" className="h-11 w-6 shrink-0 rounded-[7px] object-cover" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-13 font-medium text-text">{s.copy.name}</span>
                  <SceneSummary items={g.items} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The selected scene's audiences as tabs (sticky above the stage), each with its version's status. */
export function AudienceTabs({ items, selected, onSelect }: { items: SceneVersion[]; selected: string; onSelect: (v: SceneVersion) => void }) {
  return (
    <div role="tablist" aria-label="Audience" className="flex min-w-0 gap-1 overflow-x-auto rounded-[14px] bg-surface-2 p-1">
      {items.map((v) => {
        const id = versionId(v);
        const active = id === selected;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(v)}
            className={cx(
              'flex h-11 min-w-[148px] flex-1 flex-col items-start justify-center rounded-[10px] px-3 text-left transition-[background-color,box-shadow] duration-200 ease-cameo',
              active ? 'bg-surface shadow-[0_0_0_1px_var(--accent)]' : 'hover:bg-surface-3',
            )}
          >
            <span className={cx('text-13 leading-4', active ? 'font-semibold text-text' : 'font-medium text-text-2')}>{audienceLabel(v.audienceId)}</span>
            <span className="[&>span]:text-12 [&>span]:leading-4">
              <StatusText v={v} compact />
            </span>
          </button>
        );
      })}
    </div>
  );
}
