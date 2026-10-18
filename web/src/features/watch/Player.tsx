import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Info, ShoppingBag } from '@phosphor-icons/react';
import type { Episode, Placement } from '@/data/types';
import type { Audience, AudienceId } from '@/store/project';
import { useVideoClock } from '@/lib/useVideoClock';
import { useElementSize, useIsMobile } from '@/lib/hooks';
import { EASE } from '@/lib/motion';
import { cx } from '@/lib/cx';
import { track } from '@/store/events';
import { useSaved } from '@/store/saved';
import type { SavedItem } from '@/store/saved';
import { useUI } from '@/store/ui';
import { toast, useFocusTrap } from '@/ui';
import { episodeAspect } from '@/data/detected';
import { placedAt } from './audiences';
import { ControlBar } from './ControlBar';
import { ProductPanel } from './ProductPanel';
import type { PanelTab } from './ProductPanel';
import { productLabel } from './products';
import { usePlayhead } from './session';

const CHROME_MS = 2000;
const BANNER_MS = 6000;
const BANNER_AGAIN_MS = 3000;
const PANEL_W = 360;
const PANEL_INSET = 12;
const PANEL_MOTION = { duration: 0.24, ease: EASE };

/**
 * Player: the original episode in a dark floating frame with one control
 * bar that hides after 2 s, a disclosure banner on first play, a "Shop this scene" pill while a
 * placed product is on screen, and the products panel docked right (a bottom sheet on phones).
 *
 * `placed` are the products matched to detected boxes for the audience `market`
 * (features/watch/audiences). Nothing is rendered into the picture: products show beside it, timed to
 * the scene they were detected in. With no placements at all (Watch's "Watch the original") the
 * player is a plain player: no disclosure, no ticks, no products. Viewer events go to the API
 * through `track`.
 *
 * Sound: the episode has its own mute state (not the app's UI-sound preference). It starts muted
 * so nothing can autoplay with sound, and the first play from a user gesture (Play, Space, a click
 * on the picture) unmutes it unless the viewer already chose; if the browser still refuses audible
 * playback, it falls back to muted playback.
 */
export function Player({ episode, placed, market, audiences, autoStart = false }: { episode: Episode; placed: Placement[]; market: AudienceId; audiences: Audience[]; autoStart?: boolean }) {
  const mobile = useIsMobile();
  const reduce = useReducedMotion();
  const [params] = useSearchParams();
  const clock = useVideoClock(episode.duration);
  const sheetRef = useRef<HTMLElement>(null);
  const [stageRef, stage] = useElementSize<HTMLElement>();

  const setMarket = useUI((s) => s.setMarket);
  const hasPlacements = placed.length > 0;
  const setPlayhead = usePlayhead((s) => s.set);
  const saved = useSaved((s) => s.items);

  const [panel, setPanel] = useState(false);
  const [tab, setTab] = useState<PanelTab>('scene');
  const [chrome, setChrome] = useState(true);
  const [banner, setBanner] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const [muted, setMuted] = useState(true);
  const soundChosen = useRef(false);

  const t = clock.time;
  // Loading state until the picture can play.
  const [canPlay, setCanPlay] = useState(false);
  const at = useRef<{ src: string; t: number; playing: boolean } | null>(null);
  const live = placedAt(placed, t);
  const liveKey = live.map((p) => p.id).join(',');

  // Latest values for timers and listeners.
  const now = useRef({ t, live, market, panel, tab });
  now.current = { t, live, market, panel, tab };
  const evt = useCallback((type: Parameters<typeof track>[0], p?: Placement) => track(type, now.current.t, now.current.market, p), []);

  // ---- start position (?t=) -------------------------------------------------
  const startAt = Number(params.get('t')) || 0;
  useEffect(() => {
    if (startAt > 0) clock.seek(startAt);
  }, [startAt, clock.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Interest draws the Player's playhead as a cursor.
  const second = Math.floor(t);
  useEffect(() => setPlayhead(second), [second, setPlayhead]);

  useEffect(() => {
    if (clock.ref.current) clock.ref.current.muted = muted;
  }, [muted, clock.ref]);

  /** Play / pause from a user gesture: the first play turns the sound on (unless the viewer chose). */
  const togglePlay = useCallback(() => {
    const v = clock.ref.current;
    if (!v) return;
    if (!v.paused && !v.ended) return v.pause();
    if (!soundChosen.current) {
      soundChosen.current = true;
      v.muted = false;
      setMuted(false);
    }
    v.play().catch((err: unknown) => {
      // Autoplay policy refused audible playback: play muted instead (the mute button shows it).
      if ((err as DOMException)?.name !== 'NotAllowedError' || v.muted) return;
      v.muted = true;
      setMuted(true);
      void v.play().catch(() => undefined);
    });
  }, [clock.ref]);
  // Opened by a click ("Watch the original"): start right away, still inside that gesture's activation.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    togglePlay();
  }, [autoStart, togglePlay]);
  const toggleSound = useCallback(() => {
    soundChosen.current = true;
    setMuted((m) => !m);
  }, []);

  // ---- impressions: a placement live for ≥1 s of playback -------------
  const entered = useRef<Record<string, number>>({});
  const impressed = useRef<Set<string>>(new Set());
  const prevT = useRef(t);
  useEffect(() => {
    const jumped = Math.abs(t - prevT.current) > 0.5;
    prevT.current = t;
    const ids = new Set(live.map((p) => p.id));
    for (const id of Object.keys(entered.current)) {
      if (!ids.has(id)) {
        delete entered.current[id];
        impressed.current.delete(id);
      }
    }
    for (const p of live) {
      if (entered.current[p.id] == null || jumped) entered.current[p.id] = t;
      else if (!impressed.current.has(p.id) && t - entered.current[p.id] >= 1) {
        impressed.current.add(p.id);
        evt('impression', p);
      }
    }
  }, [t, liveKey, evt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- control bar: hides 2 s after the last pointer move; stays while paused --
  const chromeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const poke = useCallback(() => {
    setChrome(true);
    clearTimeout(chromeTimer.current);
    chromeTimer.current = setTimeout(() => setChrome(false), CHROME_MS);
  }, []);

  // ---- disclosure banner: on first play for 6 s; once more, briefly, when a placement next appears ----
  const bannerTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const bannerSeen = useRef({ first: false, again: false });
  const showBanner = useCallback(
    (ms: number) => {
      setBanner(true);
      clearTimeout(bannerTimer.current);
      bannerTimer.current = setTimeout(() => setBanner(false), ms);
    },
    [],
  );
  useEffect(() => {
    if (!clock.playing || bannerSeen.current.first || !hasPlacements) return;
    bannerSeen.current.first = true;
    showBanner(BANNER_MS);
  }, [clock.playing, showBanner, hasPlacements]);
  const prevLive = useRef(liveKey);
  useEffect(() => {
    const before = new Set(prevLive.current.split(',').filter(Boolean));
    prevLive.current = liveKey;
    const arrived = live.some((p) => !before.has(p.id));
    const seen = bannerSeen.current;
    if (!arrived || !seen.first || seen.again || banner || !clock.playing) return;
    seen.again = true;
    showBanner(BANNER_AGAIN_MS);
  }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      clearTimeout(chromeTimer.current);
      clearTimeout(bannerTimer.current);
    },
    [],
  );

  // ---- actions --------------------------------------------------------------
  const openPanel = useCallback((next: PanelTab) => {
    setTab(next);
    setPanel(true);
  }, []);
  const closePanel = useCallback(() => setPanel(false), []);

  const shop = useCallback(() => {
    const { panel: open, tab: current, live: l } = now.current;
    if (open && current === 'scene') return setPanel(false);
    if (l.length) evt('shop_click', l[0]);
    openPanel('scene');
  }, [evt, openPanel]);

  const togglePanel = useCallback(() => {
    if (now.current.panel) setPanel(false);
    else openPanel(now.current.live.length ? 'scene' : 'all');
  }, [openPanel]);

  const seeProducts = () => {
    setBanner(false);
    openPanel(now.current.live.length ? 'scene' : 'all');
  };

  const save = useCallback(
    (p: Placement) => {
      useSaved.getState().save(p.productId, p.id);
      evt('product_save', p);
      toast({
        title: 'Saved for later',
        description: productLabel(p).full,
        action: { label: 'Undo', onClick: () => useSaved.getState().remove(p.productId) },
      });
    },
    [evt],
  );
  const unsave = useCallback((item: SavedItem) => {
    useSaved.getState().remove(item.productId);
    toast({ title: 'Removed from saved', action: { label: 'Undo', onClick: () => useSaved.getState().save(item.productId, item.placementId) } });
  }, []);
  const toggleSave = useCallback(
    (p: Placement) => {
      const item = useSaved.getState().items.find((i) => i.productId === p.productId);
      if (item) unsave(item);
      else save(p);
    },
    [save, unsave],
  );
  const saveFirstInScene = useCallback(() => {
    const p = now.current.live[0];
    if (!p) return toast({ title: 'Nothing placed in this moment' });
    if (useSaved.getState().isSaved(p.productId)) return toast({ title: 'Already saved', description: productLabel(p).full });
    save(p);
  }, [save]);

  const onView = (p: Placement) => evt('product_view', p);
  const seekKeep = useCallback((to: number) => clock.seek(to, false), [clock]);
  const onJump = (p: Placement) => seekKeep(p.tIn + 0.05);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.().catch(() => undefined);
  }, [stageRef]);
  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  // Phones: the sheet is modal (focus trapped, returned on close; Esc closes).
  useFocusTrap(sheetRef, panel && mobile, closePanel);

  // ---- keyboard: space · ←/→ 5 s · s · p · b · m · f · Esc ----------------------
  const keys = useRef({ clock, togglePlay, hasPlacements, shop, togglePanel, saveFirstInScene, toggleSound, toggleFullscreen, poke });
  keys.current = { clock, togglePlay, hasPlacements, shop, togglePanel, saveFirstInScene, toggleSound, toggleFullscreen, poke };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [role="menu"], [role="dialog"][aria-modal="true"], [contenteditable="true"]')) return;
      const inWidget = !!el?.closest('[role="radio"], [role="slider"], [role="tab"]');
      const k = keys.current;
      switch (e.key) {
        case ' ':
          if (inWidget || el?.closest('button, a')) return;
          e.preventDefault();
          k.togglePlay();
          k.poke();
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (inWidget) return;
          e.preventDefault();
          k.clock.seek(k.clock.time + (e.key === 'ArrowRight' ? 5 : -5), false);
          k.poke();
          break;
        case 's':
        case 'S':
          if (k.hasPlacements) k.shop();
          break;
        case 'p':
        case 'P':
          if (k.hasPlacements) k.togglePanel();
          break;
        case 'b':
        case 'B':
          if (k.hasPlacements) k.saveFirstInScene();
          break;
        case 'm':
        case 'M':
          k.toggleSound();
          break;
        case 'f':
        case 'F':
          k.toggleFullscreen();
          break;
        case 'Escape':
          if (now.current.panel && !document.fullscreenElement) setPanel(false);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- layout: the panel docks right and the picture area shrinks beside it -------
  const W = stage.width;
  const H = stage.height;
  const docked = panel && !mobile;
  const areaW = Math.max(0, W - (docked ? PANEL_W + PANEL_INSET : 0));
  const top = mobile ? 12 : 24;
  const bottom = mobile ? 72 : 84;
  const aspect = episodeAspect();
  const vw = Math.max(0, Math.floor(Math.min(areaW - (mobile ? 24 : 48), (H - top - bottom) * aspect)));
  const vh = Math.floor(vw / aspect);
  const vTop = top + Math.max(0, Math.floor((H - top - bottom - vh) / 2));
  const vLeft = Math.floor((areaW - vw) / 2);

  const showChrome = chrome || !clock.playing;
  const ticks = [...new Set(placed.map((p) => p.tIn))];
  const pill = live.length > 0 && !panel;
  const slide = 'transition-[left,top,width,height] duration-[240ms] ease-cameo motion-reduce:transition-none';

  const panelContent = (
    <ProductPanel
      tab={tab}
      onTab={setTab}
      live={live}
      current={live}
      all={placed}
      saved={saved}
      onView={onView}
      onToggleSave={toggleSave}
      onRemove={unsave}
      onJump={onJump}
      onClose={closePanel}
    />
  );

  return (
    <section
      ref={stageRef}
      aria-label="Player"
      onPointerMove={poke}
      onPointerDown={poke}
      className={cx(
        'relative isolate min-h-0 flex-1 overflow-hidden bg-[#0c0c0f] text-white',
        fullscreen ? 'rounded-none' : 'rounded-[20px] border border-white/6 shadow-[0_8px_32px_rgba(0,0,0,.35),inset_0_1px_0_rgba(255,255,255,.04)]',
        mobile ? 'min-h-[600px]' : 'min-h-[480px]',
        !showChrome && !panel && 'cursor-none',
      )}
    >
      {/* Picture area: everything left of the docked panel. */}
      <div className={cx('absolute inset-y-0 left-0', slide)} style={{ width: areaW }}>
        {/* Picture: the original episode. */}
        <div
          className={cx('absolute overflow-hidden rounded-[14px] bg-black shadow-[0_0_0_1px_rgba(255,255,255,.06),0_24px_60px_-16px_rgba(0,0,0,.7)]', slide)}
          style={{ left: vLeft, top: vTop, width: vw, height: vh, visibility: vw > 0 ? 'visible' : 'hidden' }}
        >
          <video
            ref={clock.ref}
            src={episode.media}
            poster={episode.poster}
            preload="auto"
            playsInline
            muted={muted}
            onLoadStart={() => setCanPlay(false)}
            onCanPlay={() => setCanPlay(true)}
            // The source changes when the audience's cut (rendered shots in) arrives or the audience changes:
            // carry on from the same moment, playing if it was playing.
            onTimeUpdate={(e) => (at.current = { src: e.currentTarget.currentSrc, t: e.currentTarget.currentTime, playing: !e.currentTarget.paused })}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              const was = at.current;
              if (!was || was.src === v.currentSrc || was.t <= 0) return;
              v.currentTime = Math.min(was.t, Math.max(0, v.duration - 0.1));
              if (was.playing) void v.play().catch(() => undefined);
            }}
            aria-label={`${episode.title}, original`}
            onClick={(e) => {
              if ((e.nativeEvent as PointerEvent).pointerType !== 'touch') togglePlay();
            }}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div
            aria-hidden={canPlay}
            className={cx(
              'pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 transition-opacity duration-300 ease-cameo',
              canPlay ? 'opacity-0' : 'opacity-100',
            )}
          >
            <span role={canPlay ? undefined : 'status'} className="flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-12 font-medium text-white/85 backdrop-blur-md">
              <span className="size-3.5 rounded-full border-2 border-white/25 border-t-white motion-safe:animate-spin" />
              Loading episode
            </span>
          </div>
          {/* Shop this scene: present only while a placed product is on screen. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              shop();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            tabIndex={pill ? 0 : -1}
            aria-hidden={!pill}
            aria-keyshortcuts="S"
            aria-label="Shop this scene"
            className={cx(
              'absolute right-3 bottom-3 inline-flex h-9 items-center gap-2 rounded-full border border-white/12 bg-[#141418]/70 pr-3.5 pl-3 text-13 font-medium text-white backdrop-blur-[20px]',
              'shadow-[0_8px_24px_rgba(0,0,0,.35)] transition-[opacity,background-color] duration-300 ease-cameo hover:bg-[#1c1c22]/85 motion-reduce:transition-none max-md:h-11',
              pill ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            <ShoppingBag size={18} aria-hidden />
            Shop this scene
          </button>
        </div>

        {/* Disclosure banner: a slim translucent strip at the top of the frame. */}
        <AnimatePresence>
          {banner && (
            <motion.div
              key="banner"
              role="status"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
              onPointerDown={(e) => e.stopPropagation()}
              className="absolute top-3 left-1/2 z-20 flex w-max max-w-[calc(100%-24px)] items-center gap-2.5 rounded-[12px] border border-white/10 bg-[#141418]/72 py-2 pr-1.5 pl-3 text-13 text-white/90 shadow-[0_8px_24px_rgba(0,0,0,.35)] backdrop-blur-[20px]"
              style={{ x: '-50%' }}
            >
              <Info size={16} aria-hidden className="shrink-0 text-white/60" />
              <span className="min-w-0">Sponsored products in this video · shown beside the original picture</span>
              <button
                type="button"
                onClick={seeProducts}
                className="h-7 shrink-0 rounded-[8px] px-2 text-13 font-medium text-white transition-colors duration-200 ease-cameo hover:bg-white/10 max-md:h-11"
              >
                See products
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <ControlBar
          visible={showChrome}
          time={t}
          duration={clock.duration}
          playing={clock.playing}
          muted={muted}
          fullscreen={fullscreen}
          panelOpen={panel}
          market={market}
          audiences={audiences}
          ticks={ticks}
          plain={!hasPlacements}
          compact={mobile || areaW < 640}
          onToggle={togglePlay}
          onSeek={seekKeep}
          onMute={toggleSound}
          onFullscreen={toggleFullscreen}
          onPanel={togglePanel}
          onMarket={setMarket}
          onFocus={poke}
        />
      </div>

      {/* Desktop: the products panel docked right; playback continues. */}
      <AnimatePresence>
        {docked && (
          <motion.aside
            key="panel"
            aria-label="Products"
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
            transition={reduce ? { duration: 0 } : PANEL_MOTION}
            onPointerMove={(e) => e.stopPropagation()}
            className="surface-translucent absolute z-30 overflow-hidden rounded-[16px]! bg-[color-mix(in_srgb,var(--surface)_92%,transparent)]!"
            style={{ top: PANEL_INSET, right: PANEL_INSET, bottom: PANEL_INSET, width: PANEL_W }}
          >
            {panelContent}
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Phone: a bottom sheet; the video keeps playing above it. */}
      {mobile &&
        createPortal(
          <AnimatePresence>
            {panel && (
              <motion.div
                key="scrim"
                aria-hidden
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={PANEL_MOTION}
                onClick={closePanel}
                className="fixed inset-0 z-40 bg-black/30"
              />
            )}
            {panel && (
              <motion.aside
                key="sheet"
                ref={sheetRef}
                role="dialog"
                aria-modal="true"
                aria-label="Products"
                initial={reduce ? { opacity: 0 } : { y: '100%' }}
                animate={reduce ? { opacity: 1 } : { y: 0 }}
                exit={reduce ? { opacity: 0 } : { y: '100%' }}
                transition={reduce ? { duration: 0 } : PANEL_MOTION}
                className="surface-translucent fixed inset-x-2 bottom-2 z-50 flex max-h-[min(72dvh,580px)] min-h-[300px] flex-col bg-[color-mix(in_srgb,var(--surface)_94%,transparent)]! overflow-hidden rounded-[20px]! pb-[env(safe-area-inset-bottom)]"
              >
                <span aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong" />
                <div className="min-h-0 flex-1">{panelContent}</div>
              </motion.aside>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </section>
  );
}
