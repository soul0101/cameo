import { useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation, useOutlet, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { stepEnter } from '@/lib/motion';
import { useFlow } from '@/store/flow';
import { useProject } from '@/store/project';
import { activeEpisodeId, activeRecord, uploadRecord } from '@/data/episode';
import { fetchDetectedFile } from '@/data/detected';
import { fetchEpisodeInfo, getSample } from '@/services/api';
import { startTelemetry, view } from '@/services/telemetry';
import { useSampleSeed } from '@/features/samples/seed';
import { useRenderPolling } from '@/features/render/renders';
import { ApiBanner } from './ApiBanner';
import { LongUploadDialog } from '@/features/landing/NewProjectCard';
import { Breadcrumb, EmptyState, ScenesSkeleton, Toaster, Unreachable } from '@/ui';
import { useGlobalShortcuts, useMarketSync } from './effects';
import { MobileBar } from './MobileBar';
import { ShellOverlays } from './Overlays';
import { SidebarContent } from './Sidebar';
import { HOME_SECTION, sectionById, sectionFromPath, sectionPath } from './sections';
import type { SectionId } from './sections';
import { useShell } from './store';
import './shell.css';

/** Root: toasts, the shortcuts / settings / confirm overlays, global keys. Landing and projects render inside. */
export function RootLayout() {
  const { pathname } = useLocation();
  const projectId = pathname.match(/^\/p\/([^/]+)/)?.[1] ?? null;
  useGlobalShortcuts(projectId);
  useMarketSync();
  useEffect(() => startTelemetry(), []);
  useEffect(() => view(pathname, projectId), [pathname, projectId]);
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[80] focus:rounded-[10px] focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <ApiBanner />
      <LongUploadDialog />
      <Outlet />
      <ShellOverlays />
      <Toaster />
    </>
  );
}

/**
 * Project frame: the floating sidebar (232, or 64 collapsed) inset 12 px, and the
 * current section at max 1440 wide with 32 px gutters. ≤768: top app bar + sidebar sheet.
 * Section changes fade + slide 12 px. The catalog sheet is mounted once here.
 */
export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const { pathname } = useLocation();
  const outlet = useOutlet();
  const collapsed = useShell((s) => s.collapsed);
  const current = sectionFromPath(pathname);
  const opened = useFlow((s) => s.sampleOpened);
  const name = useProject((s) => s.name);
  const known = useProject((s) => s.episodes.some((e) => e.id === projectId));
  const [gate, retryGate] = useEpisodeGate(projectId, episodeGate(projectId, known));

  // An episode opened for the first time: its boxes from the detection, no products yet.
  useLayoutEffect(() => {
    if (gate === 'ready' && !opened) useFlow.getState().openSample();
  }, [gate, opened]);
  // A sample opened for the first time in this browser arrives with its products, stills and clips.
  useSampleSeed(gate === 'ready');
  // Running renders are followed on every page, so a render queue never stalls off the Render page.
  useRenderPolling();

  useEffect(() => {
    useProject.getState().touch();
  }, [projectId]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [current]);

  useEffect(() => {
    document.title = current ? `${sectionById[current].label} · ${name} · Cameo` : `${name} · Cameo`;
  }, [current, name]);

  if (gate === 'unknown') return <Navigate to="/" replace />;
  if (gate === 'unprocessed') return <Navigate to={`/p/${projectId}/processing?rerun=1`} replace />;
  if (gate !== 'ready') return <GateSkeleton gate={gate} onRetry={retryGate} />;
  if (!opened) return null;

  return (
    <div className="vignette min-h-dvh bg-fixed text-text" style={{ ['--sb' as string]: collapsed ? '64px' : '232px' }}>
      <aside aria-label="Sidebar" className="surface shell-sidebar fixed top-3 bottom-3 left-3 z-40 overflow-hidden max-md:hidden">
        <SidebarContent projectId={projectId} current={current} collapsed={collapsed} />
      </aside>
      <MobileBar projectId={projectId} current={current} />
      <main id="main" className="shell-main flex min-h-dvh flex-col pt-6 pr-8 pb-6 max-lg:pr-5 max-md:min-h-[calc(100dvh-56px)] max-md:px-4 max-md:pt-4">
        <div className="mx-auto flex w-full max-w-[1440px] min-h-0 flex-1 flex-col">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={current ?? pathname} className="flex min-h-0 flex-1 flex-col" {...stepEnter}>
              {outlet}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

/**
 * Which episode a `/p/:id` page may show. One episode is active per page load (`data/episode`);
 * - `ready`: the URL's episode is the active one and its detection is cached;
 * - `switch`: another stored episode: reload so every module rebuilds from it;
 * - `unreachable`: that fetch got no answer from the API (retry);
 * - `restore`: an episode this browser has never seen (a shared link, a fresh browser): ask the API
 *   (`GET /episodes/{id}`, then its detected.json), store it like a new upload (the catalog and
 *   audiences stay this browser's own, the starter ones in a fresh browser), reload;
 * - `unprocessed`: an upload without detection: process it; `unknown`: the API does not know it either.
 */
type Gate = 'ready' | 'switch' | 'restore' | 'failed' | 'unreachable' | 'unprocessed' | 'unknown';

function episodeGate(projectId: string, known: boolean): Gate {
  if (!known) return 'restore';
  if (projectId !== activeEpisodeId) return 'switch';
  return activeRecord.detected ? 'ready' : 'unprocessed';
}

function useEpisodeGate(projectId: string, gate: Gate): [Gate, () => void] {
  const [failed, setFailed] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [gone, setGone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (gate === 'ready') return clearReloadMark();
    if (gate === 'switch') {
      // Once per episode: if the reload did not make it active (storage blocked), stop and say so.
      if (reloadMarked(projectId)) setFailed(true);
      else reloadFor(projectId);
      return;
    }
    if (gate !== 'restore') return;
    let live = true;
    setUnreachable(false);
    // Not answering, busy or failing: a retry, never a redirect or "no detection".
    const fail = () => live && setUnreachable(true);
    fetchEpisodeInfo(projectId)
      .then(async (info) => {
        if (!live) return;
        if (!info) return setGone(true);
        const detected = info.hasDetected ? await fetchDetectedFile(projectId, '') : null;
        if (!live) return;
        const name = info.sample ? await getSample(projectId).then((m) => m.name, () => 'Sample') : 'Uploaded episode';
        useProject.getState().saveEpisode(uploadRecord(projectId, name, detected));
        if (reloadMarked(projectId)) setFailed(true);
        else reloadFor(projectId);
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [gate, projectId, attempt]);
  const retry = () => setAttempt((a) => a + 1);
  return [unreachable ? 'unreachable' : gone ? 'unknown' : failed ? 'failed' : gate, retry];
}

const MARK = 'cameo-episode-reload';
const reloadMarked = (id: string) => {
  try {
    return sessionStorage.getItem(MARK) === id;
  } catch {
    return false;
  }
};
const reloadFor = (id: string) => {
  try {
    sessionStorage.setItem(MARK, id);
  } catch {
    /* ignore */
  }
  window.location.reload();
};
const clearReloadMark = () => {
  try {
    sessionStorage.removeItem(MARK);
  } catch {
    /* ignore */
  }
};

function GateSkeleton({ gate, onRetry }: { gate: Gate; onRetry: () => void }) {
  return (
    <div className="vignette min-h-dvh bg-fixed px-8 pt-6 text-text max-md:px-4" aria-busy={gate === 'switch' || gate === 'restore'}>
      {gate === 'unreachable' ? (
        <Unreachable what="this episode" onRetry={onRetry} className="mx-auto max-w-[720px]" />
      ) : gate === 'failed' ? (
        <EmptyState className="mx-auto max-w-[720px]" title="No detection for this episode" body="The API answered, but this episode has no detection output yet. Process it again from Projects." />
      ) : (
        <ScenesSkeleton />
      )}
    </div>
  );
}

/** Old or removed section paths (Overview, Versions) redirect to a section, keeping the query. */
function SectionRedirect({ to }: { to: SectionId }) {
  const { projectId = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/p/${projectId}/${to}${search}`} replace />;
}

/** The project root opens on Scenes. */
export function ProjectIndex() {
  return <SectionRedirect to={HOME_SECTION} />;
}

/**
 * Wraps a step page that renders its own title (Scenes, Previews, Watch): adds only the
 * breadcrumb above it, so the page is never double-titled.
 */
export function CrumbFrame({ id, children }: { id: SectionId; children: ReactNode }) {
  const { projectId = '' } = useParams();
  const name = useProject((s) => s.name);
  return (
    <>
      <Breadcrumb className="shrink-0 pb-3 max-md:hidden" items={[{ label: name, to: sectionPath(projectId, HOME_SECTION) }, { label: sectionById[id].label }]} />
      {children}
    </>
  );
}
