import { useCallback, useEffect, useRef, useState } from 'react';
import { FPS } from './timecode';

export interface VideoClock {
  /** Attach to the <video>. */
  ref: React.RefObject<HTMLVideoElement>;
  /** Seconds, rAF-smooth while playing. */
  time: number;
  playing: boolean;
  ready: boolean;
  duration: number;
  /** Seek (pauses by default). */
  seek: (t: number, pause?: boolean) => void;
  toggle: () => void;
  play: () => void;
  pause: () => void;
  /** Step ±n frames (pauses). */
  step: (frames: number) => void;
  /** When set, playback loops inside [from, to). */
  loop: { from: number; to: number } | null;
  setLoop: (range: { from: number; to: number } | null) => void;
}

/**
 * The viewer transport. One clock per viewer: owns a <video> ref, tracks time with rAF while
 * playing, and exposes seek / toggle / frame step / loop. Pair with <Transport clock={…} />.
 */
export function useVideoClock(duration: number): VideoClock {
  const ref = useRef<HTMLVideoElement>(null as unknown as HTMLVideoElement);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [loop, setLoop] = useState<{ from: number; to: number } | null>(null);
  const loopRef = useRef(loop);
  loopRef.current = loop;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let raf = 0;
    const loopTick = () => {
      const l = loopRef.current;
      if (l && v.currentTime >= l.to) v.currentTime = l.from;
      setTime(v.currentTime);
      raf = requestAnimationFrame(loopTick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loopTick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(raf);
      setTime(v.currentTime);
    };
    const onTime = () => setTime(v.currentTime);
    const onMeta = () => setReady(true);
    if (v.readyState >= 1) setReady(true);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onPause);
    v.addEventListener('seeked', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onPause);
      v.removeEventListener('seeked', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
    };
  }, []);

  const seek = useCallback(
    (t: number, pause = true) => {
      const v = ref.current;
      const clamped = Math.min(duration - 1 / FPS, Math.max(0, t));
      setTime(clamped);
      if (!v) return;
      if (pause && !v.paused) v.pause();
      try {
        v.currentTime = clamped;
      } catch {
        /* metadata not loaded yet: the time state still moves the playhead */
      }
    },
    [duration],
  );

  const play = useCallback(() => {
    const v = ref.current;
    if (!v) return;
    const l = loopRef.current;
    if (l && (v.currentTime < l.from || v.currentTime >= l.to)) v.currentTime = l.from;
    void v.play().catch(() => undefined);
  }, []);
  const pause = useCallback(() => ref.current?.pause(), []);
  const toggle = useCallback(() => (ref.current?.paused ? play() : pause()), [play, pause]);
  const step = useCallback((frames: number) => seek((ref.current?.currentTime ?? 0) + frames / FPS), [seek]);

  return { ref, time, playing, ready, duration, seek, toggle, play, pause, step, loop, setLoop };
}
