import { create } from 'zustand';

/**
 * Longest upload processed, in seconds, so a run stays fast and cheap. The API enforces the same
 * number (`CAMEO_MAX_SECONDS`).
 */
export const MAX_UPLOAD_SECONDS = 10;

/** A file over the limit, waiting for the user to accept its first `MAX_UPLOAD_SECONDS` (or cancel). */
interface LimitState {
  file: File | null;
  duration: number;
  ask: (file: File, duration: number) => void;
  clear: () => void;
}
export const useLongUpload = create<LimitState>()((set) => ({
  file: null,
  duration: 0,
  ask: (file, duration) => set({ file, duration }),
  clear: () => set({ file: null, duration: 0 }),
}));

/** The file's length in seconds, read from its metadata in the browser; null when the browser cannot read it. */
export function videoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (d: number | null) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}
