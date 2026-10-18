import { isSample } from '@/features/samples/seed';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowsClockwise, CaretRight, DotsThree, Trash } from '@phosphor-icons/react';
import { clearEpisodeWorkspace, durationOf, openEpisode, posterOf, shotsOf, timecode } from '@/data/episode';
import { deleteEpisode, isUnreachable } from '@/services/api';
import type { EpisodeRecord } from '@/data/episode';
import { useProject } from '@/store/project';
import { Button, ConfirmDialog, Menu, Surface, Tag, toast } from '@/ui';

function relativeTime(ts: number | null, now = Date.now()): string {
  if (!ts) return 'Not opened yet';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}

/** Open an episode: processed ones go to Scenes from their cached detection; others go through processing. */
function useOpenEpisode() {
  const navigate = useNavigate();
  return (e: EpisodeRecord) => {
    if (e.detected) openEpisode(e.id);
    else navigate(`/p/${e.id}/processing?rerun=1`);
  };
}

/**
 * Open a project: one row per stored episode (poster = first keyframe,
 * name, duration, shots, when it was processed). Opening a processed episode goes straight to Scenes
 * from its cached detection; "Re-run detection" (row menu, confirmed) processes it again and replaces
 * the cache.
 */
export function ProjectsCard({ exclude = [] }: { exclude?: string[] }) {
  const navigate = useNavigate();
  const episodes = useProject((s) => s.episodes).filter((e) => !exclude.includes(e.id) && !isSample(e.id));
  const [rerun, setRerun] = useState<EpisodeRecord | null>(null);
  const [removing, setRemoving] = useState<EpisodeRecord | null>(null);
  const remove = (e: EpisodeRecord) => {
    // Off the list and out of this browser at once; the server copy is deleted in the background.
    useProject.getState().removeEpisode(e.id);
    clearEpisodeWorkspace(e.id);
    deleteEpisode(e.id).then(
      () => toast({ title: 'Video removed', description: e.name, tone: 'pass' }),
      (err: unknown) =>
        toast({ title: 'Removed from this browser', description: isUnreachable(err) ? 'The API did not answer, so its files stay on the server.' : 'The server could not delete its files.', tone: 'reject' }),
    );
  };
  // Most recently processed first.
  const list = [...episodes].sort((a, b) => (b.processedAt ?? 0) - (a.processedAt ?? 0));

  const open = useOpenEpisode();
  if (!list.length) return null;

  return (
    <Surface radius={20} className="flex min-h-0 flex-col p-2">
      <div className="flex items-baseline justify-between gap-3 px-3 pt-2 pb-2">
        <h2 className="text-14 font-semibold text-text">Your uploads</h2>
        <span className="text-12 text-text-3">Saved in this browser</span>
      </div>
      <div role="list" className="flex max-h-[188px] flex-col gap-0.5 overflow-y-auto">
        {list.map((e) => (
          <EpisodeRow key={e.id} episode={e} onOpen={() => open(e)} onRerun={() => setRerun(e)} onRemove={() => setRemoving(e)} />
        ))}
      </div>
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? 'this video'}?`}
        description="The video, its scenes, products in boxes, previews and viewer data are deleted. This cannot be undone."
        confirmLabel="Remove"
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const e = removing!;
          setRemoving(null);
          remove(e);
        }}
      />
      <ConfirmDialog
        open={!!rerun}
        title={`Re-run detection on ${rerun?.name ?? 'this episode'}?`}
        description="Gemini runs on Vertex AI again; you confirm the cost before it starts. Boxes, products in boxes and approvals for this episode start over."
        confirmLabel="Re-run detection"
        destructive={false}
        onCancel={() => setRerun(null)}
        onConfirm={() => {
          const id = rerun!.id;
          setRerun(null);
          navigate(`/p/${id}/processing?rerun=1`);
        }}
      />
    </Surface>
  );
}

function EpisodeRow({ episode: e, onOpen, onRerun, onRemove }: { episode: EpisodeRecord; onOpen: () => void; onRerun: () => void; onRemove: () => void }) {
  const poster = posterOf(e);
  const shots = shotsOf(e.detected, e.media).length;
  const duration = durationOf(e.detected);
  const facts = e.detected
    ? [timecode(duration), `${shots} ${shots === 1 ? 'shot' : 'shots'}`, `Processed ${relativeTime(e.processedAt).toLowerCase()}`]
    : ['Not processed yet'];
  return (
    <div role="listitem" className="group relative flex items-center rounded-[14px] transition-colors duration-200 ease-cameo hover:bg-surface-3/70">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-4 rounded-[14px] p-2 text-left max-sm:gap-3">
        <span className="relative aspect-video w-[72px] shrink-0 overflow-hidden rounded-[8px] bg-black shadow-[0_0_0_1px_var(--border)]">
          {poster && <img src={poster} alt="" className="h-full w-full object-cover object-[50%_30%] transition-transform duration-[280ms] ease-cameo group-hover:scale-[1.04]" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-14 font-medium text-text">{e.name}</span>
          <span className="mt-0.5 block truncate text-13 text-text-2">
            {e.detected ? (
              <>
                <span className="mono">{facts[0]}</span> · {facts.slice(1).join(' · ')}
              </>
            ) : (
              facts[0]
            )}
          </span>
          <span className="mt-1.5 flex gap-1.5"><Tag tone="muted">Upload</Tag></span>
        </span>
        <CaretRight size={16} aria-hidden className="shrink-0 text-text-3 transition-transform duration-200 ease-cameo group-hover:translate-x-0.5 group-hover:text-text-2" />
        <span className="sr-only">Open {e.name}</span>
      </button>
      <span className="shrink-0 pr-2">
        <Menu
          label={`${e.name} actions`}
          align="end"
          items={[
            { id: 'rerun', label: 'Re-run detection', icon: <ArrowsClockwise />, onSelect: onRerun },
            { id: 'remove', label: 'Remove video', icon: <Trash />, onSelect: onRemove },
          ]}
          trigger={(props) => <Button {...props} variant="ghost" size="sm" iconOnly icon={<DotsThree weight="bold" />} aria-label={`More for ${e.name}`} />}
        />
      </span>
    </div>
  );
}
