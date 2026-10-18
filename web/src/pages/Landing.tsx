import { useEffect, useState } from 'react';
import { Moon, Sun } from '@phosphor-icons/react';
import { DropZone, useStartUpload } from '@/features/landing/NewProjectCard';
import { SampleGallery } from '@/features/landing/SampleGallery';
import { ProjectsCard } from '@/features/landing/ProjectsCard';
import { listSamples } from '@/services/api';
import { useHealth } from '@/services/health';
import { useProject } from '@/store/project';
import type { SampleSummary } from '@/services/api';
import { useTheme } from '@/store/theme';
import { useShell } from '@/shell/store';
import { Button, Kbd, LogoMark, Tooltip } from '@/ui';

/**
 * `/`: one screen, no scroll. Left: what Cameo is and an upload drop zone (and the visitor's own uploads,
 * when there are any). Right: the ready-made samples, each opening with its scenes, previews and rendered
 * clips already done. Hovering a sample plays its rendered clip.
 */
export default function Landing() {
  const resolved = useTheme((s) => s.resolved);
  const setMode = useTheme((s) => s.setMode);
  const setShell = useShell((s) => s.set);
  const startUpload = useStartUpload();
  const [samples, setSamples] = useState<SampleSummary[] | null>(null);
  // While the API sleeps or wakes the list stays loading (the banner says why); it loads once the API answers.
  const health = useHealth((s) => s.status);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    document.title = 'Cameo · personalized ads, inside the story';
  }, []);
  useEffect(() => {
    if (samples !== null || health === 'down') return;
    let live = true;
    listSamples().then((list) => {
      if (!live) return;
      setSamples(list);
      // Samples go by their own names, even in a browser where one began as an upload ("download (13)").
      const project = useProject.getState();
      for (const s of list) {
        const rec = project.episodes.find((e) => e.id === s.id);
        if (rec && rec.name !== s.name) project.saveEpisode({ ...rec, name: s.name });
      }
    }, () => {
      if (live) setTimeout(() => setAttempt((a) => a + 1), 4000);
    });
    return () => {
      live = false;
    };
  }, [samples, health, attempt]);
  return (
    <div className="vignette flex h-dvh flex-col overflow-hidden bg-fixed text-text max-lg:h-auto max-lg:min-h-dvh max-lg:overflow-visible">
      <header className="flex h-16 shrink-0 items-center gap-2 px-8 max-md:h-14 max-md:px-4">
        <span className="flex items-center gap-2.5 text-16 font-semibold tracking-[-0.01em]">
          <LogoMark size={22} title={null} />
          Cameo
        </span>
        <span className="flex-1" />
        <Tooltip content="Keyboard shortcuts" shortcut="?" side="bottom">
          <Button variant="ghost" size="sm" onClick={() => setShell({ shortcuts: true })} aria-label="Keyboard shortcuts" className="max-md:hidden">
            <Kbd className="h-5 min-w-5 text-11">?</Kbd>
          </Button>
        </Tooltip>
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
      <main id="main" className="mx-auto grid min-h-0 w-full max-w-[1280px] flex-1 grid-cols-[400px_minmax(0,1fr)] gap-10 px-8 pt-2 pb-8 max-lg:grid-cols-1 max-lg:gap-8 max-md:px-4">
        <section aria-label="Start" className="flex min-h-0 flex-col gap-5">
          <div>
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-12 font-medium text-text-2">
              <LogoMark size={14} title={null} />
              Built with Gemini on Google Cloud
            </span>
            <h1 className="mt-5 text-[44px] leading-[1.04] font-semibold tracking-[-0.035em] text-text max-md:text-[34px]">
              Personalized ads,
              <br />
              <span className="text-accent">inside the story.</span>
            </h1>
            <p className="mt-4 text-16 leading-relaxed text-text-2">
              Cameo places the right product for each audience into finished video: Gemini finds the spots, Nano Banana previews them and Gemini Omni edits the shot.
            </p>
          </div>
          <DropZone onFile={startUpload} className="min-h-[200px] flex-1 py-6 max-lg:min-h-[220px]" />
          {samples !== null && <ProjectsCard exclude={samples.map((s) => s.id)} />}
        </section>

        <section aria-labelledby="samples-title" className="flex min-h-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 lg:h-7">
            <h2 id="samples-title" className="text-18 font-semibold tracking-[-0.01em] text-text">
              Samples
            </h2>
            <span className="text-13 text-text-3">Each opens ready: scenes, previews and rendered clips</span>
          </div>
          <SampleGallery samples={samples} />
        </section>
      </main>
    </div>
  );
}
