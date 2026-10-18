import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Placement } from '@/data/types';
import { mmss } from '@/lib/timecode';
import { productLabel } from './products';
import { END, int, skippedMoments } from './data';
import type { Point } from './data';

/** Ticks every 8 s up to the episode's end. */
const TICKS = Array.from({ length: Math.floor(END / 8) + 1 }, (_, i) => i * 8);
const axisTick = { fill: 'var(--text-3)', fontSize: 12, fontFamily: 'var(--font-mono)' };
/** Placements drawn on a second band row: a later one that shares its span with another (P9 with P8). */
const secondRow = (list: Placement[]) => new Set(list.filter((p, i) => list.slice(0, i).some((q) => q.tIn === p.tIn)).map((p) => p.id));

interface Props {
  data: Point[];
  playhead: number | null;
  /** Every placement (the bands), across audiences. */
  placements: Placement[];
}

/** Viewer activity over the episode: placement bands, skipped scenes, impressions and shop clicks per second (all audiences). */
export function TimelineChart({ data, playhead, placements }: Props) {
  const SECOND_ROW = secondRow(placements);
  const max = Math.max(1, ...data.map((d) => Math.max(d.impressions, d.shopClicks)));
  const top = Math.max(4, Math.ceil((max * 1.25) / 4) * 4);
  const strip = top * 0.03;
  // Draw in once; later session updates do not re-animate.
  const [animate, setAnimate] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setAnimate(false), 600);
    return () => clearTimeout(id);
  }, []);

  return (
    <section aria-label="Interest over the episode" className="surface p-6 max-md:p-4">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className="text-16 font-semibold text-text">Activity over the episode</h2>
          <p className="mt-0.5 text-13 text-text-2">Impressions and shop clicks per second across all audiences, with each placement's time on screen</p>
        </div>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-12 text-text-2" aria-label="Legend">
          <Key swatch={<span className="h-0.5 w-3.5 rounded-full bg-text" />}>Impressions</Key>
          <Key swatch={<span className="h-0.5 w-3.5 rounded-full bg-accent" />}>Shop clicks</Key>
          <Key swatch={<span className="h-1 w-3.5 rounded-full bg-accent/60" />}>Placement</Key>
          {skippedMoments.length > 0 && <Key swatch={<span className="h-2.5 w-3.5 rounded-[3px] bg-reject/15" />}>Skipped scene</Key>}
        </ul>
      </header>
      <div
        className="mt-5 h-[280px] w-full max-md:h-[220px]"
        role="img"
        aria-label={`Impressions and shop clicks per second over the ${END} second episode, with placement spans${skippedMoments.length ? ' and skipped scenes' : ''} marked.`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 14, bottom: 0, left: 0 }}>
            <CartesianGrid yAxisId="i" vertical={false} stroke="var(--border)" strokeWidth={1} />
            {skippedMoments.map((m) => (
              <ReferenceArea key={m.id} yAxisId="i" x1={m.tIn} x2={m.tOut} fill="var(--reject)" fillOpacity={0.08} strokeOpacity={0} />
            ))}
            {placements.map((p) => (
              <ReferenceArea
                key={p.id}
                yAxisId="i"
                x1={p.tIn + 0.3}
                x2={p.tOut - 0.3}
                y1={SECOND_ROW.has(p.id) ? strip * 1.7 : 0}
                y2={SECOND_ROW.has(p.id) ? strip * 2.7 : strip}
                fill="var(--accent)"
                fillOpacity={0.85}
                strokeOpacity={0}
                radius={2}
              />
            ))}
            {playhead != null && <ReferenceLine yAxisId="i" x={playhead} stroke="var(--text-3)" strokeWidth={1} strokeDasharray="3 3" />}
            <XAxis
              dataKey="t"
              type="number"
              domain={[0, END]}
              ticks={TICKS}
              tickFormatter={mmss}
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              height={24}
            />
            <YAxis yAxisId="i" interval={0} domain={[0, top]} tick={axisTick} tickLine={false} axisLine={false} width={44} ticks={[0, top / 4, top / 2, (top * 3) / 4, top]} tickFormatter={int} />
            <Tooltip
              cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
              content={<Tip placements={placements} />}
              isAnimationActive={false}
            />
            <Line
              yAxisId="i"
              type="monotone"
              dataKey="impressions"
              stroke="var(--text)"
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 3.5, fill: 'var(--surface)', stroke: 'var(--text)', strokeWidth: 1.75 }}
              isAnimationActive={animate}
              animationDuration={500}
            />
            <Line
              yAxisId="i"
              type="monotone"
              dataKey="shopClicks"
              stroke="var(--accent)"
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 3.5, fill: 'var(--surface)', stroke: 'var(--accent)', strokeWidth: 1.75 }}
              isAnimationActive={animate}
              animationDuration={500}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function Key({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden className="flex w-3.5 items-center justify-center">
        {swatch}
      </span>
      {children}
    </li>
  );
}

function Tip({ active, payload, label, placements }: { active?: boolean; payload?: Array<{ payload: Point }>; label?: number; placements: Placement[] }) {
  if (!active || !payload?.length || label == null) return null;
  const d = payload[0].payload;
  const live = placements.filter((p) => label >= p.tIn && label < p.tOut);
  const skipped = skippedMoments.some((m) => label >= m.tIn && label < m.tOut);
  return (
    <div className="surface min-w-48 rounded-[12px]! px-3 py-2.5 text-13">
      <p className="mono text-12 text-text-3">{mmss(label)}</p>
      <p className="mt-1 flex items-baseline justify-between gap-4 text-text-2">
        Impressions
        <span className="font-medium text-text tabular-nums">{int(d.impressions)}</span>
      </p>
      <p className="mt-1 flex items-baseline justify-between gap-4 text-text-2">
        Shop clicks
        <span className="font-medium text-text tabular-nums">{int(d.shopClicks)}</span>
      </p>
      {skipped ? (
        <p className="mt-1 text-12 text-reject">Skipped scene</p>
      ) : (
        live.map((p) => (
          <p key={p.id} className="mt-1 truncate text-12 text-text-2">
            {productLabel(p).full}
          </p>
        ))
      )}
    </div>
  );
}
