import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowClockwise, ArrowCounterClockwise, ArrowSquareOut, Eye, FilmSlate, Image as ImageIcon, LockKey, ShieldCheck, SignOut, UploadSimple, Users, Wallet } from '@phosphor-icons/react';
import { adminLimits, adminSummary, adminTestAlert, adminVisitor, ApiError, isUnreachable } from '@/services/api';
import type { OpsCount, OpsEvent, OpsLimits, OpsSummary, OpsVisitorDetail } from '@/services/api';
import { cx } from '@/lib/cx';
import { inUse, onBackInUse } from '@/lib/activity';
import { Button, ConfirmDialog, Field, LogoMark, Segmented, Sheet, Tag, toast } from '@/ui';

/**
 * `/admin`: the operator's view of the live deployment. Who visited and what they opened, what was generated and what
 * it cost, today's spend against the daily budget, and the controls to change the budget or reset allowances. Every
 * number comes from the server's own activity log (`GET /admin/summary`), behind the admin token.
 */
const TOKEN_KEY = 'cameo-admin-token';
type Period = '1' | '7' | '30' | '0';
const PERIODS: Array<{ value: Period; label: string }> = [
  { value: '1', label: 'Today' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '0', label: 'All' },
];

const usd = (n: number | undefined) => `$${(n ?? 0).toFixed(n && n < 0.1 ? 3 : 2)}`;
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const ago = (t: number) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const short = (id: string) => (id.startsWith('ip-') ? id : id.slice(0, 8));
const duration = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
const flag = (cc: string) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌐');
const countryName = (cc: string) => (/^[A-Z]{2}$/.test(cc) ? (regionNames?.of(cc) ?? cc) : 'Unknown');

const LABEL: Record<string, string> = {
  visit: 'Visited',
  upload: 'Uploaded a video',
  detect_done: 'Detection finished',
  detect_failed: 'Detection failed',
  match_done: 'Re-matched products',
  match_failed: 'Re-match failed',
  identify: 'Drew a box',
  prompt: 'Gemini wrote a prompt',
  preview: 'Preview still',
  render_start: 'Render started',
  render_done: 'Render finished',
  render_failed: 'Render failed',
  refused: 'Refused by a ceiling',
  alert: 'Alert emailed',
  admin: 'Operator changed limits',
};
const ACTION: Record<string, string> = {
  place_product: 'Placed a product',
  remove_product: 'Removed a product',
  draw_box: 'Drew a box',
  edit_prompt: 'Edited a prompt',
  approve: 'Approved a preview',
  add_product: 'Added a product to the catalog',
  add_audience: 'Added an audience',
  restore_sample: 'Restored a sample',
  viewer_shop_click: 'Clicked Shop in the player',
  viewer_product_view: 'Opened a product in the player',
  viewer_product_save: 'Saved a product',
  engaged: 'Time in view',
};
const STEP: Record<string, string> = {
  landed: 'Opened Cameo',
  sample: 'Opened a sample or uploaded',
  scenes: 'Reached Scenes',
  tried: 'Changed something',
  previews: 'Reached Previews',
  render: 'Reached Render',
  watch: 'Watched the result',
  generated: 'Generated an image or clip',
};
const labelOf = (e: OpsEvent) => (e.kind === 'action' ? (ACTION[String(e.action)] ?? String(e.action)) : (LABEL[e.kind] ?? e.kind));

export default function Admin() {
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [period, setPeriod] = useState<Period>('7');
  const [data, setData] = useState<OpsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openVisitor, setOpenVisitor] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Cameo · Operations';
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setData(await adminSummary(token, Number(period)));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
        setError(err.status === 404 ? 'The dashboard is off on this server (no admin token set).' : 'That token was not accepted.');
        setToken('');
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch {
          /* storage blocked */
        }
      } else setError(isUnreachable(err) ? 'The API did not answer.' : err instanceof Error ? err.message : 'Could not load');
    } finally {
      setLoading(false);
    }
  }, [token, period]);

  useEffect(() => {
    void load();
    const id = setInterval(() => inUse() && void load(), 30_000);
    const offBack = onBackInUse(() => void load());
    return () => {
      clearInterval(id);
      offBack();
    };
  }, [load]);

  if (!token) return <Gate error={error} onToken={(t) => {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* storage blocked: the token lasts for this page */
    }
    setError(null);
    setToken(t);
  }} />;

  const signOut = () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage blocked */
    }
    setToken('');
    setData(null);
  };

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-border bg-bg/85 px-8 backdrop-blur max-md:px-4">
        <Link to="/" className="flex items-center gap-2.5 text-16 font-semibold">
          <LogoMark size={22} title={null} />
          Cameo
        </Link>
        <span className="text-text-3">/</span>
        <span className="text-14 font-medium text-text-2">Operations</span>
        <span className="flex-1" />
        <span className="text-12 text-text-3 max-md:hidden">{data ? `Updated ${ago(data.generatedAt)}` : ''}</span>
        <Segmented label="Period" options={PERIODS} value={period} onChange={setPeriod} />
        <Button variant="ghost" iconOnly icon={<ArrowClockwise />} aria-label="Refresh" loading={loading} onClick={() => void load()} />
        <Button variant="ghost" iconOnly icon={<SignOut />} aria-label="Sign out" onClick={signOut} />
      </header>

      <main className="mx-auto flex max-w-[1280px] flex-col gap-5 px-8 py-6 max-md:px-4">
        {error && <p className="rounded-[12px] bg-reject/10 px-4 py-3 text-13 text-reject">{error}</p>}
        {!data ? (
          <p className="py-20 text-center text-14 text-text-3">Loading…</p>
        ) : (
          <>
            <Kpis data={data} />
            <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-5 max-lg:grid-cols-1">
              <ActivityChart data={data} />
              <Budget token={token} limits={data.limits} onChange={() => void load()} />
            </div>
            <div className="grid grid-cols-3 gap-5 max-xl:grid-cols-1">
              <Funnel data={data} />
              <Audience data={data} />
              <Actions data={data} />
            </div>
            <div className="grid grid-cols-2 gap-5 max-lg:grid-cols-1">
              <Samples data={data} />
              <Generation data={data} />
            </div>
            <Visitors data={data} onOpen={setOpenVisitor} />
            <Feed events={data.recent} />
            <CloudLinks links={data.console} />
            <p className="pb-4 text-12 text-text-3">
              The dashboard reads the activity kept on the running server; every event is also in Cloud Logging, which keeps the history across redeploys. Visitors are anonymous browser ids. A visitor's country comes from their browser's own time zone, never from their address; network addresses are stored only as salted hashes, for the per-network spending ceiling.
            </p>
            <VisitorSheet token={token} id={openVisitor} onClose={() => setOpenVisitor(null)} onChange={() => void load()} />
          </>
        )}
      </main>
    </div>
  );
}

/* ---------- Sign in ---------- */

function Gate({ error, onToken }: { error: string | null; onToken: (t: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 text-text">
      <form
        className="surface flex w-full max-w-[380px] flex-col gap-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onToken(value.trim());
        }}
      >
        <span className="inline-flex size-10 items-center justify-center rounded-[12px] bg-accent-soft text-accent">
          <LockKey size={20} weight="fill" aria-hidden />
        </span>
        <div>
          <h1 className="text-18 font-semibold">Cameo operations</h1>
          <p className="mt-1 text-13 text-text-2">Visitors, generations, spend and limits for this deployment. Enter the admin token set on the API.</p>
        </div>
        <Field label="Admin token" type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        {error && <p className="text-13 text-reject">{error}</p>}
        <Button variant="primary" type="submit" disabled={!value.trim()}>
          Open dashboard
        </Button>
      </form>
    </div>
  );
}

/* ---------- Headline numbers ---------- */

function Kpis({ data }: { data: OpsSummary }) {
  const t = data.totals;
  const views = data.samples.reduce((n, s) => n + s.views, 0);
  const passRate = t.renders ? Math.round((100 * (t.rendersPassed ?? 0)) / t.renders) : null;
  return (
    <section aria-label="Totals" className="grid grid-cols-6 gap-3 max-xl:grid-cols-3 max-sm:grid-cols-2">
      <Kpi
        icon={<Users />}
        label="Visitors"
        value={t.visitors ?? 0}
        sub={`${t.networks ?? 0} ${t.networks === 1 ? 'network' : 'networks'} · ${t.sessions ?? 0} sessions · ${t.visitors ? duration(Math.round((t.engagedSeconds ?? 0) / t.visitors)) : '0s'} each${t.automated ? ` · ${t.automated} automated not counted` : ''}`}
      />
      <Kpi icon={<Eye />} label="Sample views" value={views} sub={`${data.samples.filter((s) => s.views).length} of ${data.samples.length} samples opened`} />
      <Kpi icon={<UploadSimple />} label="Uploads" value={t.uploads ?? 0} sub={`${t.detections ?? 0} detections run`} />
      <Kpi icon={<ImageIcon />} label="Images generated" value={t.images ?? 0} sub={`${t.imagesCached ?? 0} served from cache`} />
      <Kpi icon={<FilmSlate />} label="Videos rendered" value={t.renders ?? 0} sub={passRate === null ? `${t.rendersStarted ?? 0} started` : `${passRate}% passed the check`} />
      <Kpi icon={<Wallet />} label="Spend" value={usd(t.spend)} sub={data.days ? `last ${data.days === 1 ? '24 h' : `${data.days} days`}` : 'since the log began'} accent />
    </section>
  );
}

function Kpi({ icon, label, value, sub, accent }: { icon: ReactNode; label: string; value: ReactNode; sub: string; accent?: boolean }) {
  return (
    <div className="surface flex flex-col gap-2 p-4">
      <span className={cx('flex items-center gap-1.5 text-12 font-medium [&_svg]:size-4', accent ? 'text-accent' : 'text-text-3')}>
        {icon}
        {label}
      </span>
      <span className="text-[28px] leading-none font-semibold tabular-nums">{value}</span>
      <span className="text-12 text-text-3">{sub}</span>
    </div>
  );
}

/* ---------- Activity over time ---------- */

function ActivityChart({ data }: { data: OpsSummary }) {
  const rows = data.series.map((r) => ({ ...r, label: data.hourly ? r.bucket.slice(11, 16) : r.bucket.slice(5) }));
  return (
    <section className="surface flex flex-col p-5" aria-label="Activity over time">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-16 font-semibold">Activity</h2>
        <ul className="flex gap-4 text-12 text-text-2">
          <Key className="bg-text-3/50">Page views</Key>
          <Key className="bg-accent">Images</Key>
          <Key className="bg-text">Renders</Key>
          <Key className="bg-pass" line>
            Spend
          </Key>
        </ul>
      </header>
      <p className="mt-0.5 text-13 text-text-2">{data.hourly ? 'Per hour (UTC)' : 'Per day (UTC)'}</p>
      <div className="mt-4 h-[260px]">
        {rows.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fill: 'var(--text-3)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="n" allowDecimals={false} tick={{ fill: 'var(--text-3)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="usd" orientation="right" tick={{ fill: 'var(--text-3)', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12 }}
                formatter={(v, name) => (name === 'Spend' ? usd(Number(v)) : String(v ?? 0))}
              />
              <Bar yAxisId="n" dataKey="visits" name="Page views" fill="var(--text-3)" fillOpacity={0.35} radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Bar yAxisId="n" dataKey="images" name="Images" fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Bar yAxisId="n" dataKey="renders" name="Renders" fill="var(--text)" radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Line yAxisId="usd" dataKey="spend" name="Spend" stroke="var(--pass)" strokeWidth={2} dot={false} type="monotone" connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <p className="flex h-full items-center justify-center text-13 text-text-3">No activity in this period yet.</p>
        )}
      </div>
    </section>
  );
}

function Key({ className, line, children }: { className: string; line?: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={cx(line ? 'h-0.5 w-3.5 rounded-full' : 'size-2.5 rounded-[3px]', className)} />
      {children}
    </li>
  );
}

/* ---------- Budget and limits ---------- */

function Budget({ token, limits, onChange }: { token: string; limits: OpsLimits | null; onChange: () => void }) {
  const [form, setForm] = useState({ budget: '', visitorCap: '', networkCap: '' });
  const [confirm, setConfirm] = useState<'spend' | 'all' | null>(null);
  useEffect(() => {
    if (limits) setForm({ budget: String(limits.budget), visitorCap: String(limits.visitorCap), networkCap: String(limits.networkCap) });
  }, [limits?.budget, limits?.visitorCap, limits?.networkCap]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!limits) return null;
  const pct = limits.budget ? Math.min(100, (100 * limits.spent) / limits.budget) : 0;
  const changed = form.budget !== String(limits.budget) || form.visitorCap !== String(limits.visitorCap) || form.networkCap !== String(limits.networkCap);
  const act = async (body: Parameters<typeof adminLimits>[1], done: string) => {
    try {
      await adminLimits(token, body);
      toast({ title: done, tone: 'pass' });
      onChange();
    } catch (err) {
      toast({ title: 'Not changed', description: err instanceof Error ? err.message : 'error', tone: 'reject' });
    }
  };
  const blocked = limits.blocked.visitors.length + limits.blocked.nets.length;
  return (
    <section className="surface flex flex-col gap-4 p-5" aria-label="Spending ceilings">
      <header className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-16 font-semibold">
          <ShieldCheck size={18} className="text-accent" aria-hidden /> Spending ceilings
        </h2>
        <span className="text-12 text-text-3">{limits.day} UTC</span>
      </header>
      <div>
        <p className="flex items-baseline gap-1.5">
          <span className="text-[28px] leading-none font-semibold tabular-nums">{usd(limits.spent)}</span>
          <span className="text-13 text-text-2">{limits.budget ? `of ${usd(limits.budget)} today` : 'today · no server limit'}</span>
        </p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Share of today's server budget spent">
          <div className={cx('h-full rounded-full transition-[width] duration-500', pct >= 90 ? 'bg-reject' : pct >= 60 ? 'bg-accent' : 'bg-pass')} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-12 text-text-3">
          Nothing is counted per request. A paid request is refused only when it would take a browser, its network or the server past its dollar ceiling for the day; an alert is emailed when that happens.
        </p>
        {blocked > 0 && (
          <p className="mt-2">
            <Tag tone="reject">
              {limits.blocked.visitors.length} {limits.blocked.visitors.length === 1 ? 'browser' : 'browsers'} · {limits.blocked.nets.length} {limits.blocked.nets.length === 1 ? 'network' : 'networks'} blocked today
            </Tag>
          </p>
        )}
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const n = (v: string) => Number(v);
          if ([form.budget, form.visitorCap, form.networkCap].every((v) => v.trim() !== '' && Number.isFinite(n(v)) && n(v) >= 0))
            void act({ budget: n(form.budget), visitorCap: n(form.visitorCap), networkCap: n(form.networkCap) }, 'Ceilings saved');
        }}
      >
        <div className="grid grid-cols-3 gap-2">
          <Field label="Server / day ($)" inputMode="decimal" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          <Field label="Per browser ($)" inputMode="decimal" value={form.visitorCap} onChange={(e) => setForm({ ...form, visitorCap: e.target.value })} />
          <Field label="Per network ($)" inputMode="decimal" value={form.networkCap} onChange={(e) => setForm({ ...form, networkCap: e.target.value })} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-12 text-text-3">0 = no ceiling</span>
          <Button type="submit" size="sm" variant="secondary" disabled={!changed}>
            Save ceilings
          </Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<ArrowCounterClockwise />} onClick={() => setConfirm('spend')}>
          Reset server spend
        </Button>
        <Button size="sm" variant="secondary" icon={<ArrowCounterClockwise />} onClick={() => setConfirm('all')}>
          Unblock everyone
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void adminTestAlert(token).then(
              () => toast({ title: 'Test alert sent', description: 'The email arrives within a few minutes.', tone: 'pass' }),
              (err: unknown) => toast({ title: 'Not sent', description: err instanceof Error ? err.message : 'error', tone: 'reject' }),
            )
          }
        >
          Send test alert
        </Button>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'spend' ? "Reset today's server spend?" : 'Unblock everyone?'}
        description={
          confirm === 'spend'
            ? "The server's spend for today goes back to $0, so its full daily budget is available again. Browsers and networks keep their own spend. Money already spent is not refunded by Google."
            : "Every browser's and network's spend for today goes back to $0, so anyone blocked can generate again."
        }
        confirmLabel={confirm === 'spend' ? 'Reset' : 'Unblock everyone'}
        destructive={false}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const which = confirm;
          setConfirm(null);
          void act(which === 'spend' ? { resetSpend: true } : { resetAll: true }, which === 'spend' ? "Today's server spend reset" : 'Everyone unblocked');
        }}
      />
    </section>
  );
}

/* ---------- Samples and generation ---------- */

function Samples({ data }: { data: OpsSummary }) {
  const max = Math.max(1, ...data.samples.map((s) => s.views));
  return (
    <section className="surface p-5" aria-label="Samples">
      <h2 className="text-16 font-semibold">Samples</h2>
      <p className="mt-0.5 text-13 text-text-2">Page views inside each sample, and how many visitors opened it</p>
      {data.samples.length ? (
        <ul className="mt-4 flex flex-col gap-3">
          {data.samples.map((s) => (
            <li key={s.id} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between text-13">
                <span className="font-medium">{s.name}</span>
                <span className="text-text-2 tabular-nums">
                  {s.views} views · {s.visitors} {s.visitors === 1 ? 'visitor' : 'visitors'}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-accent" style={{ width: `${(100 * s.views) / max}%` }} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-13 text-text-3">No sample opened in this period.</p>
      )}
    </section>
  );
}

function Generation({ data }: { data: OpsSummary }) {
  const t = data.totals;
  const rows: Array<[string, number | undefined, string?]> = [
    ['Detections run', t.detections, 'Cloud Vision + Gemini on an upload'],
    ['Product re-matches', t.match_done],
    ['Boxes drawn and identified', t.identify, 'Cloud Vision snap + Gemini'],
    ['Edit prompts written', t.prompt, 'Gemini'],
    ['Preview stills', t.images, 'Nano Banana'],
    ['Previews from cache', t.imagesCached, 'no cost'],
    ['Renders started', t.rendersStarted, 'Gemini Omni'],
    ['Renders finished', t.renders],
    ['Renders that failed', t.rendersFailed],
    ['Requests refused by a ceiling', t.refused],
    ['Alerts emailed', t.alerts],
  ];
  return (
    <section className="surface p-5" aria-label="Generation">
      <h2 className="text-16 font-semibold">Generation</h2>
      <p className="mt-0.5 text-13 text-text-2">Every model step in this period</p>
      <dl className="mt-3 divide-y divide-border">
        {rows.map(([label, n, note]) => (
          <div key={label} className="flex items-baseline gap-3 py-2 text-13">
            <dt className="flex-1">
              {label}
              {note && <span className="ml-2 text-12 text-text-3">{note}</span>}
            </dt>
            <dd className="font-medium tabular-nums">{n ?? 0}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ---------- Journey, audience, actions ---------- */

function Funnel({ data }: { data: OpsSummary }) {
  const top = Math.max(1, data.funnel[0]?.visitors ?? 0);
  return (
    <section className="surface p-5" aria-label="Visitor journey">
      <h2 className="text-16 font-semibold">Journey</h2>
      <p className="mt-0.5 text-13 text-text-2">How far visitors got, out of everyone who opened Cameo</p>
      <ol className="mt-4 flex flex-col gap-2.5">
        {data.funnel.map((f) => (
          <li key={f.step}>
            <div className="flex items-baseline justify-between text-13">
              <span>{STEP[f.step] ?? f.step}</span>
              <span className="text-text-2 tabular-nums">
                {f.visitors} <span className="text-text-3">· {Math.round((100 * f.visitors) / top)}%</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent" style={{ width: `${(100 * f.visitors) / top}%` }} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Audience({ data }: { data: OpsSummary }) {
  const a = data.audience;
  return (
    <section className="surface flex flex-col gap-4 p-5" aria-label="Where visitors come from">
      <div>
        <h2 className="text-16 font-semibold">Visitors</h2>
        <p className="mt-0.5 text-13 text-text-2">Country from each browser's time zone; device, browser and the site they came from</p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {a.countries.map((c) => (
          <li key={c.name} className="flex items-center gap-2 text-13">
            <span aria-hidden>{flag(c.name)}</span>
            <span className="flex-1">{countryName(c.name)}</span>
            <span className="text-text-2 tabular-nums">{c.visitors}</span>
          </li>
        ))}
        {!a.countries.length && <li className="text-13 text-text-3">No visitors yet.</li>}
      </ul>
      <Chips title="Devices" items={a.devices} />
      <Chips title="Browsers" items={a.browsers} />
      <Chips title="Systems" items={a.os} />
      <Chips title="Came from" items={a.referrers} empty="Direct visits only" />
    </section>
  );
}

function Chips({ title, items, empty }: { title: string; items: OpsCount[]; empty?: string }) {
  return (
    <div>
      <p className="text-12 font-medium text-text-2">{title}</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {items.map((x) => (
          <li key={x.name}>
            <Tag tone="muted">
              {x.name} · {x.visitors}
            </Tag>
          </li>
        ))}
        {!items.length && <li className="text-12 text-text-3">{empty ?? '—'}</li>}
      </ul>
    </div>
  );
}

function Actions({ data }: { data: OpsSummary }) {
  const max = Math.max(1, ...data.actions.map((a) => a.count));
  return (
    <section className="surface p-5" aria-label="What visitors did">
      <h2 className="text-16 font-semibold">What they did</h2>
      <p className="mt-0.5 text-13 text-text-2">Changes made in the app and actions in the player</p>
      <ul className="mt-4 flex flex-col gap-2.5">
        {data.actions.map((a) => (
          <li key={a.action}>
            <div className="flex items-baseline justify-between text-13">
              <span>{ACTION[a.action] ?? a.action}</span>
              <span className="text-text-2 tabular-nums">{a.count}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-text" style={{ width: `${(100 * a.count) / max}%` }} />
            </div>
          </li>
        ))}
        {!data.actions.length && <li className="text-13 text-text-3">No changes made yet in this period.</li>}
      </ul>
    </section>
  );
}

/* ---------- Visitors ---------- */

function Visitors({ data, onOpen }: { data: OpsSummary; onOpen: (id: string) => void }) {
  const counts = data.limits?.visitors ?? {};
  const [showBots, setShowBots] = useState(false);
  const bots = data.visitors.filter((v) => v.automated).length;
  const list = showBots ? data.visitors : data.visitors.filter((v) => !v.automated);
  return (
    <section className="surface overflow-hidden" aria-label="Visitor list">
      <header className="flex items-baseline justify-between p-5 pb-3">
        <div>
          <h2 className="text-16 font-semibold">Each visitor</h2>
          <p className="mt-0.5 text-13 text-text-2">One row per browser, most recent first. Open a row for the full timeline and to unblock it.</p>
        </div>
        <span className="flex items-center gap-3 text-12 text-text-3">
          {bots > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={showBots} onChange={(e) => setShowBots(e.target.checked)} className="accent-[var(--accent)]" />
              Show automated ({bots})
            </label>
          )}
          {list.length} shown
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-13">
          <thead className="text-left text-12 text-text-3">
            <tr className="border-y border-border">
              {['Visitor', 'Last seen', 'Time in app', 'Samples opened', 'Changes', 'Uploads', 'Images', 'Renders', 'Spend', 'Spent today'].map((h) => (
                <th key={h} className="px-4 py-2 font-medium first:pl-5">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.map((v) => {
              const today = counts[v.visitor] ?? 0;
              const isBlocked = data.limits?.blocked.visitors.includes(v.visitor) || (!!v.net && !!data.limits?.blocked.nets.includes(v.net));
              return (
                <tr key={v.visitor} className="cursor-pointer align-top transition-colors hover:bg-surface-2" onClick={() => onOpen(v.visitor)}>
                  <td className="px-4 py-2.5 pl-5">
                    <button type="button" className="text-left" onClick={() => onOpen(v.visitor)} aria-label={`Open visitor ${short(v.visitor)}`}>
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden>{flag(v.country)}</span>
                        <span className="mono">{short(v.visitor)}</span>
                        {v.automated && <Tag className="ml-1">automated</Tag>}
                      </span>
                      <span className="block text-12 text-text-3">{[countryName(v.country), v.device, v.browser].filter((x) => x && x !== 'Unknown').join(' · ')}</span>
                    </button>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-text-2">{ago(v.last)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{duration(v.seconds)}</td>
                  <td className="px-4 py-2.5 text-text-2">{v.samples.join(', ') || '—'}</td>
                  <td className="px-4 py-2.5 tabular-nums">{v.actions}</td>
                  <td className="px-4 py-2.5 tabular-nums">{v.uploads}</td>
                  <td className="px-4 py-2.5 tabular-nums">{v.images}</td>
                  <td className="px-4 py-2.5 tabular-nums">{v.renders}</td>
                  <td className="px-4 py-2.5 tabular-nums">{usd(v.spend)}</td>
                  <td className="px-4 py-2.5 text-12 text-text-2">
                    <span className="tabular-nums">
                      {usd(today)}
                      {data.limits?.visitorCap ? ` / ${usd(data.limits.visitorCap)}` : ''}
                    </span>
                    {isBlocked && (
                      <Tag tone="reject" className="ml-1.5">
                        blocked
                      </Tag>
                    )}
                    {v.refused > 0 && !isBlocked && (
                      <Tag tone="reject" className="ml-1.5">
                        {v.refused} refused
                      </Tag>
                    )}
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={10} className="px-5 py-8 text-center text-text-3">
                  No visitors in this period yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function VisitorSheet({ token, id, onClose, onChange }: { token: string; id: string | null; onClose: () => void; onChange: () => void }) {
  const [d, setD] = useState<OpsVisitorDetail | null>(null);
  const [confirm, setConfirm] = useState<'browser' | 'network' | null>(null);
  const load = useCallback(() => {
    if (!id) return;
    adminVisitor(token, id).then(setD, () => setD(null));
  }, [token, id]);
  useEffect(() => {
    setD(null);
    load();
  }, [load]);
  const p = d?.profile;
  const unblock = async (what: 'browser' | 'network') => {
    if (!p) return;
    try {
      await adminLimits(token, what === 'browser' ? { resetVisitor: p.visitor } : { resetNetwork: p.net ?? '' });
      toast({ title: what === 'browser' ? 'Browser unblocked' : 'Network unblocked', description: `Today's ${what} spend is back to $0`, tone: 'pass' });
      load();
      onChange();
    } catch (err) {
      toast({ title: 'Not changed', description: err instanceof Error ? err.message : 'error', tone: 'reject' });
    }
  };
  return (
    <Sheet open={!!id} onClose={onClose} title={p ? `${flag(p.country)} Visitor ${short(p.visitor)}` : 'Visitor'} description={p ? `${countryName(p.country)} · first seen ${when(p.first)}` : undefined} width={520}>
      {!d ? (
        <p className="p-5 text-13 text-text-3">Loading…</p>
      ) : (
        <div className="flex flex-col gap-5 p-5">
          {p && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-13">
              {(
                [
                  ['Last seen', ago(p.last)],
                  ['Time in app', duration(p.seconds)],
                  ['Sessions', String(p.sessions)],
                  ['Page views', String(p.visits)],
                  ['Device', [p.device, p.os].filter(Boolean).join(' · ') || '—'],
                  ['Browser', p.browser || '—'],
                  ['Language', p.language || '—'],
                  ['Time zone', p.timezone || '—'],
                  ['Came from', p.referrer || (p.utmSource ? `campaign ${p.utmSource}` : 'Direct')],
                  ['Spend', usd(p.spend)],
                  ['Sections', p.sections.join(', ') || '—'],
                  ['Samples', p.samples.join(', ') || '—'],
                ] as Array<[string, string]>
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-12 text-text-3">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <section className="flex flex-col gap-3 rounded-[14px] bg-surface-2 p-4">
            <h3 className="text-14 font-semibold">Spend today</h3>
            <CapRow label="This browser" spent={d.spentToday} cap={d.visitorCap} blocked={d.blocked} onUnblock={() => setConfirm('browser')} />
            {p?.net && <CapRow label="Its network" spent={d.networkSpentToday} cap={d.networkCap} blocked={d.networkBlocked} onUnblock={() => setConfirm('network')} />}
          </section>
          <section>
            <h3 className="text-14 font-semibold">Timeline</h3>
            <ol className="mt-2 divide-y divide-border">
              {d.timeline.map((e, i) => (
                <li key={`${e.t}-${i}`} className="flex items-baseline gap-3 py-2 text-13">
                  <time className="w-[104px] shrink-0 text-12 text-text-3 tabular-nums">{when(e.t)}</time>
                  <span className="min-w-0 flex-1">
                    <span className={cx('font-medium', PROBLEMS.has(e.kind) && 'text-reject')}>{labelOf(e)}</span>
                    <span className="block truncate text-12 text-text-2">{detail(e)}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{e.cost ? usd(e.cost) : ''}</span>
                </li>
              ))}
            </ol>
          </section>
          <ConfirmDialog
            open={confirm !== null}
            title={confirm === 'network' ? 'Unblock this network?' : 'Unblock this browser?'}
            description={`Today's ${confirm ?? 'browser'} spend goes back to $0, so it can generate again. The server's daily budget still applies.`}
            confirmLabel="Unblock"
            destructive={false}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const which = confirm;
              setConfirm(null);
              if (which) void unblock(which);
            }}
          />
        </div>
      )}
    </Sheet>
  );
}

function CapRow({ label, spent, cap, blocked, onUnblock }: { label: string; spent: number; cap: number; blocked: boolean; onUnblock: () => void }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-13">
        <span className="flex items-center gap-1.5">
          {label}
          {blocked && <Tag tone="reject">blocked</Tag>}
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums">
            {usd(spent)} {cap ? `of ${usd(cap)}` : '· no ceiling'}
          </span>
          <Button size="sm" variant={blocked ? 'secondary' : 'ghost'} onClick={onUnblock} disabled={!spent}>
            Unblock
          </Button>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className={cx('h-full rounded-full', blocked ? 'bg-reject' : 'bg-accent')} style={{ width: `${cap ? Math.min(100, (100 * spent) / cap) : 0}%` }} />
      </div>
    </div>
  );
}

function CloudLinks({ links }: { links: OpsSummary['console'] }) {
  const items = (
    [
      ['logs', 'Every event in Cloud Logging'],
      ['service', 'Cloud Run: requests, latency, memory'],
      ['vertex', 'Vertex AI'],
      ['billing', 'Billing: actual spend'],
    ] as const
  ).filter(([k]) => links[k]);
  if (!items.length) return null;
  return (
    <section className="surface flex flex-wrap items-center gap-2 p-4" aria-label="Google Cloud">
      <span className="mr-2 text-13 font-medium">Open in Google Cloud</span>
      {items.map(([k, label]) => (
        <a key={k} href={links[k]} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-border px-3 text-13 text-text-2 transition-colors hover:bg-surface-2 hover:text-text">
          {label} <ArrowSquareOut size={13} aria-hidden />
        </a>
      ))}
    </section>
  );
}

/* ---------- Recent activity ---------- */

type FeedFilter = 'all' | 'gen' | 'did' | 'visits' | 'problems';
const GEN = new Set(['upload', 'detect_done', 'match_done', 'identify', 'prompt', 'preview', 'render_start', 'render_done']);
const PROBLEMS = new Set(['refused', 'alert', 'render_failed', 'detect_failed', 'match_failed']);

function Feed({ events }: { events: OpsEvent[] }) {
  const [filter, setFilter] = useState<FeedFilter>('gen');
  const shown = useMemo(
    () =>
      events
        .filter((e) => !(e.kind === 'action' && e.action === 'engaged'))
        .filter((e) => (filter === 'all' ? true : filter === 'gen' ? GEN.has(e.kind) : filter === 'did' ? e.kind === 'action' : filter === 'visits' ? e.kind === 'visit' : PROBLEMS.has(e.kind)))
        .slice(0, 150),
    [events, filter],
  );
  return (
    <section className="surface overflow-hidden" aria-label="Recent activity">
      <header className="flex flex-wrap items-center justify-between gap-3 p-5 pb-3">
        <h2 className="text-16 font-semibold">Recent activity</h2>
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'gen', label: 'Generation' },
            { value: 'did', label: 'Changes' },
            { value: 'visits', label: 'Visits' },
            { value: 'problems', label: 'Problems' },
            { value: 'all', label: 'All' },
          ]}
        />
      </header>
      <ol className="divide-y divide-border border-t border-border">
        {shown.map((e, i) => (
          <li key={`${e.t}-${i}`} className="flex items-baseline gap-4 px-5 py-2.5 text-13">
            <time className="w-[118px] shrink-0 text-12 text-text-3 tabular-nums">{when(e.t)}</time>
            <span className={cx('w-[200px] shrink-0 font-medium', PROBLEMS.has(e.kind) && 'text-reject')}>{labelOf(e)}</span>
            <span className="min-w-0 flex-1 truncate text-text-2">{detail(e)}</span>
            <span className="mono shrink-0 text-12 text-text-3">{short(String(e.kind === 'render_done' || e.kind === 'render_failed' ? (e.owner ?? e.visitor) : e.visitor))}</span>
            <span className="w-[64px] shrink-0 text-right tabular-nums">{e.cost ? usd(e.cost) : ''}</span>
          </li>
        ))}
        {!shown.length && <li className="px-5 py-8 text-center text-13 text-text-3">Nothing here in this period.</li>}
      </ol>
    </section>
  );
}

function detail(e: OpsEvent): string {
  const ep = e.episodeName ?? (e.episode ? `upload ${String(e.episode).slice(3, 11)}` : '');
  const bits: string[] = [];
  if (e.kind === 'visit') bits.push(String(e.path ?? ''), e.sample ? 'sample' : '', e.entry && e.country ? `${flag(String(e.country))} ${countryName(String(e.country))}` : '');
  else if (e.kind === 'action') bits.push(ep, e.product ? String(e.product) : '', e.for ? `for ${e.for}` : '', e.audience ? String(e.audience) : '', e.seconds ? duration(Number(e.seconds)) : '');
  else if (ep) bits.push(ep);
  if (e.kind === 'upload') bits.push(`${e.seconds}s`, e.trimmed ? 'trimmed' : '', `${e.mb} MB`);
  if (e.kind === 'preview') bits.push(e.cached ? 'from cache' : `${e.seconds}s`, e.audience ? `audience ${e.audience}` : '');
  if (e.kind === 'render_start') bits.push(`shot ${e.shot}`, e.attempt && Number(e.attempt) > 1 ? `take ${e.attempt}` : '');
  if (e.kind === 'render_done') bits.push(`${e.seconds}s`, e.passed === true ? 'check passed' : e.passed === false ? 'needs review' : '');
  if (e.kind === 'identify') bits.push(String(e.label ?? ''));
  if (e.kind === 'prompt') bits.push(String(e.product ?? ''));
  if (e.kind === 'detect_done') bits.push(`${e.areas ?? 0} spots · ${e.calls ?? 0} calls`);
  if (e.kind === 'refused') bits.push(String(e.what ?? ''), String(e.reason ?? ''));
  if (e.kind === 'alert') bits.push(String(e.message ?? ''));
  if (e.kind.endsWith('failed')) bits.push(String(e.error ?? ''));
  return bits.filter(Boolean).join(' · ');
}
