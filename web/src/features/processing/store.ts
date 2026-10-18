import { create } from 'zustand';
import { isTrimmed } from './pending';
import { cancelJob, confirmJob, isUnreachable, startRerun, startUpload, subscribeJob } from '@/services/api';
import { projectPayload } from '@/services/payload';
import type { JobEvent, JobStageId, StartedJob } from '@/services/api';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'confirm';
export type RunPhase = 'idle' | 'starting' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface StageView {
  status: StageStatus;
  message: string;
  counts?: Record<string, number>;
  progress?: number;
  startedAt?: number;
  endedAt?: number;
  seconds?: number;
}

export interface LogLine {
  seq: number;
  stage: string;
  text: string;
}

/** The server's stages, after `upload` (the browser sending the file, shown only for a new upload). */
export type StageId = 'upload' | JobStageId;
export const STAGE_ORDER: StageId[] = ['upload', 'ingest', 'vision', 'understand', 'localise', 'match'];

export const blankStages = (): Record<StageId, StageView> => ({
  upload: { status: 'pending', message: '' },
  ingest: { status: 'pending', message: '' },
  vision: { status: 'pending', message: '' },
  understand: { status: 'pending', message: '' },
  localise: { status: 'pending', message: '' },
  match: { status: 'pending', message: '' },
});

interface RunState {
  phase: RunPhase;
  job: StartedJob | null;
  /** Re-running detection for this stored episode (no new upload). */
  rerunId: string | null;
  file: File | null;
  /** Object URL of the dropped file, so the left frame can play it before the proxy exists. */
  localUrl: string | null;
  /** The upload's name when the run was picked up again after a reload (the File itself is gone). */
  resumedName: string | null;
  stages: Record<StageId, StageView>;
  log: LogLine[];
  lastSeq: number;
  error: string | null;
  /** The API did not answer at all (shown as "Backend unreachable"). */
  unreachable: boolean;
  /** Set while stage "understand" waits for the user: estimated calls and cost. */
  needs: { calls?: number; cost?: number } | null;
  totals: { tokens?: number; cost?: number; calls?: number } | null;

  begin: (file: File | null) => void;
  /** After a reload mid-run: follow the upload's job again (the server replays its events). */
  resume: (run: SavedRun) => void;
  /** Re-run detection for a stored episode (confirm card again for an upload). */
  beginRerun: (episodeId: string) => void;
  confirm: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Cancel whatever runs and clear. */
  reset: () => void;
  retry: () => void;
}

/** The upload being processed, kept for this tab so a reload can pick the run up again. */
export interface SavedRun {
  jobId: string;
  episodeId: string;
  name: string;
}
const RUN_KEY = 'cameo-run';
export function savedRun(): SavedRun | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(RUN_KEY) ?? 'null') as SavedRun | null;
    return v && typeof v.jobId === 'string' && typeof v.episodeId === 'string' ? v : null;
  } catch {
    return null;
  }
}
const saveRun = (run: SavedRun | null) => {
  try {
    if (run) sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
    else sessionStorage.removeItem(RUN_KEY);
  } catch {
    /* storage blocked: a reload starts over */
  }
};

let unsubscribe: (() => void) | null = null;
let uploading: AbortController | null = null;
let token = 0;

const stopUpload = () => {
  uploading?.abort();
  uploading = null;
};

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
const timeLeft = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))} s left` : `${Math.round(s / 60)} min left`);

const fresh = (): Pick<RunState, 'phase' | 'job' | 'stages' | 'log' | 'lastSeq' | 'error' | 'unreachable' | 'needs' | 'totals'> => ({
  phase: 'idle',
  job: null,
  stages: blankStages(),
  log: [],
  lastSeq: 0,
  error: null,
  unreachable: false,
  needs: null,
  totals: null,
});

const FRAME: Record<string, string> = { start: 'start frame', mid: 'middle frame', end: 'end frame' };
const STAGE_NAME: Record<string, string> = { '1': 'Scene understanding', '2': 'Placement areas', '3': 'Product match' };

/**
 * Pipeline call labels in human words: `stage2:C10_end` → "Scene 10 · end frame", `C03_mid` →
 * "Scene 3 · middle frame", `stage3:episode` → "Whole episode", a bare `stage1` → "Scene understanding".
 */
function humanLabel(text: string): string {
  return text
    .replace(/\bstage3:episode\b/g, 'Whole episode')
    .replace(/\b(?:stage\d:)?C(\d+)(?:_(start|mid|end))?\b/g, (_, n: string, pos?: string) => `Scene ${Number(n)}${pos ? ` · ${FRAME[pos]}` : ''}`)
    .replace(/\bstage(\d)(?::[\w-]+)?\b/g, (m, d: string) => STAGE_NAME[d] ?? m);
}

function lineFor(e: JobEvent): string {
  let t = humanLabel(e.message);
  if (e.tokens && !/token/.test(t)) t += ` · ${e.tokens.toLocaleString('en-US')} tokens`;
  if (e.seconds && !/ s\b/.test(t)) t += ` · ${e.seconds.toFixed(1)} s`;
  return t;
}

export const useRun = create<RunState>()((set, get) => {
  const apply = (e: JobEvent) =>
    set((s) => {
      if (e.seq <= s.lastSeq) return s; // history replay on reconnect
      const now = Date.now();
      const next: Partial<RunState> = { lastSeq: e.seq };
      const stages = { ...s.stages };
      if (e.stage !== 'job') {
        const cur = stages[e.stage] ?? { status: 'pending', message: '' };
        if (e.state === 'running') stages[e.stage] = { ...cur, status: 'running', message: e.message, startedAt: cur.startedAt ?? now };
        else if (e.state === 'progress') stages[e.stage] = { ...cur, status: 'running', message: e.message, progress: e.progress ?? cur.progress, startedAt: cur.startedAt ?? now };
        else if (e.state === 'done') stages[e.stage] = { ...cur, status: 'done', message: e.message, counts: e.counts ?? cur.counts, seconds: e.seconds, endedAt: now, startedAt: cur.startedAt ?? now, progress: 1 };
        else if (e.state === 'failed') stages[e.stage] = { ...cur, status: 'failed', message: e.message, endedAt: now };
        else if (e.state === 'needs_confirmation') {
          stages[e.stage] = { ...cur, status: 'confirm', message: e.message };
          next.needs = { calls: e.calls, cost: e.cost };
        }
        if (e.state === 'running' || e.state === 'progress') next.needs = null;
        next.stages = stages;
        if (e.state === 'failed') next.error = e.message;
      } else if (e.state === 'complete') {
        next.phase = 'complete';
        next.totals = { tokens: e.tokens, cost: e.cost, calls: e.calls };
        next.needs = null;
      } else if (e.state === 'failed') {
        next.phase = 'failed';
        next.error = e.message || s.error;
      } else if (e.state === 'cancelled') next.phase = 'cancelled';
      const text = lineFor(e);
      next.log = e.state === 'progress' && s.log.at(-1)?.stage === e.stage ? [...s.log.slice(0, -1), { seq: e.seq, stage: e.stage, text }] : [...s.log, { seq: e.seq, stage: e.stage, text }].slice(-12);
      if (e.state === 'needs_confirmation') next.phase = 'running';
      return next as RunState;
    });

  const launch = async (file: File | null, rerunId: string | null = null) => {
    const my = ++token;
    unsubscribe?.();
    unsubscribe = null;
    const prevUrl = get().localUrl;
    const reuse = !!file && get().file === file && !!prevUrl;
    if (prevUrl && !reuse) URL.revokeObjectURL(prevUrl);
    set({ ...fresh(), phase: 'starting', file, rerunId, localUrl: !file ? null : reuse ? prevUrl : URL.createObjectURL(file) });
    try {
      const job = await (rerunId ? startRerun(rerunId) : file ? upload(file, my) : Promise.reject(new Error('No video to process')));
      if (my !== token) {
        void cancelJob(job.jobId);
        return;
      }
      set({ job, phase: 'running' });
      if (file) saveRun({ ...job, name: file.name.replace(/\.[^.]+$/, '') });
      unsubscribe = subscribeJob(job.jobId, apply, () => {
        if (my === token && get().phase === 'running') set({ phase: 'failed', error: 'Lost connection to the processing server' });
      });
    } catch (err) {
      if (my !== token) return;
      const message = err instanceof Error ? err.message : 'Could not start processing';
      const unreachable = isUnreachable(err);
      const up = get().stages.upload;
      set({ phase: 'failed', unreachable, error: message, stages: up.status === 'running' && !unreachable ? { ...get().stages, upload: { ...up, status: 'failed', message, endedAt: Date.now() } } : get().stages });
    } finally {
      if (my === token) uploading = null;
    }
  };

  /** Send the file, showing bytes sent and time left on the upload row; then the server prepares it. */
  const upload = async (file: File, my: number) => {
    stopUpload();
    const ctl = (uploading = new AbortController());
    const t0 = Date.now();
    const show = (patch: Partial<StageView>) => my === token && set((s) => ({ stages: { ...s.stages, upload: { ...s.stages.upload, startedAt: s.stages.upload.startedAt ?? t0, ...patch } } }));
    show({ status: 'running', message: `Sending ${mb(file.size)}`, progress: 0 });
    const onProgress = (sent: number, total: number) => {
      if (sent >= total) return show({ message: 'Preparing your video', progress: 0.97 });
      const secs = (Date.now() - t0) / 1000;
      const left = secs > 1.5 && sent > 0 ? ` · ${timeLeft(((total - sent) / sent) * secs)}` : '';
      show({ message: `${mb(sent)} of ${mb(total)}${left}`, progress: 0.97 * (sent / total) });
    };
    const job = await startUpload(file, isTrimmed(file), { onProgress, signal: ctl.signal });
    show({ status: 'done', message: mb(file.size), progress: 1, endedAt: Date.now(), seconds: (Date.now() - t0) / 1000 });
    return job;
  };

  return {
    ...fresh(),
    rerunId: null,
    file: null,
    localUrl: null,
    resumedName: null,

    begin: (file) => {
      if (get().phase !== 'idle' || !file) return;
      void launch(file);
    },

    resume: (saved) => {
      if (get().phase !== 'idle') return;
      const my = ++token;
      set({ ...fresh(), phase: 'running', job: { jobId: saved.jobId, episodeId: saved.episodeId }, file: null, localUrl: null, rerunId: null, resumedName: saved.name });
      unsubscribe = subscribeJob(saved.jobId, apply, () => {
        if (my === token && get().phase === 'running') set({ phase: 'failed', error: 'Lost connection to the processing server' });
      });
    },

    beginRerun: (episodeId) => {
      if (get().phase !== 'idle') return;
      void launch(null, episodeId);
    },

    confirm: async () => {
      const job = get().job;
      if (!job) return;
      set((s) => ({ stages: Object.fromEntries(Object.entries(s.stages).map(([id, v]) => [id, v.status === 'confirm' ? { ...v, status: 'running' } : v])) as RunState['stages'], needs: null }));
      try {
        await confirmJob(job.jobId, projectPayload());
      } catch (err) {
        set({ phase: 'failed', unreachable: isUnreachable(err), error: err instanceof Error ? err.message : 'Could not start detection' });
      }
    },

    cancel: async () => {
      const job = get().job;
      token++;
      stopUpload();
      saveRun(null);
      unsubscribe?.();
      unsubscribe = null;
      if (job && !['complete', 'cancelled'].includes(get().phase)) await cancelJob(job.jobId);
      set({ ...fresh(), phase: 'cancelled' });
    },

    reset: () => {
      const job = get().job;
      const phase = get().phase;
      token++;
      stopUpload();
      saveRun(null);
      unsubscribe?.();
      unsubscribe = null;
      if (job && (phase === 'running' || phase === 'starting')) void cancelJob(job.jobId);
      const url = get().localUrl;
      if (url) URL.revokeObjectURL(url);
      set({ ...fresh(), file: null, localUrl: null, rerunId: null, resumedName: null });
    },

    retry: () => {
      const { file, rerunId } = get();
      const job = get().job;
      if (job) void cancelJob(job.jobId);
      void launch(file, rerunId);
    },

  };
});
