/** Timecode helpers. The master is 24 fps. */
export const FPS = 24;

const pad = (n: number) => String(n).padStart(2, '0');

/** 0:08 style (ruler ticks, compact labels). */
export function mmss(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
