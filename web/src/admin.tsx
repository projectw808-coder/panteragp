import { useCallback, useEffect, useState } from 'react';
import {
  Activity as ActivityIcon, ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Ban, ChartCandlestick, ChevronDown, CircleCheck, Coins, Flag,
  Inbox, Landmark, Layers, ListTodo, Lock, LogIn, MessageSquare, Plus, RefreshCw, Rocket, Settings2, ShieldCheck, StickyNote,
  TrendingUp, Users, Wallet, Workflow, X,
} from 'lucide-react';
import { alertBox, btn, field, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';

type Overview = {
  clients: { total: number; new_7d: number; dormant: number };
  pipeline: { stage: string; sort_order: number; clients: number }[];
  kyc: { pending_docs: number; clients_pending: number; clients_approved: number };
  flags: { open: number; by_severity: { severity: string; open: number }[] };
  tasks: { open: number; overdue: number };
  trading: {
    fills_today: number; volume_today: number; volume_7d: number; working_orders: number;
    open_positions: number; exposure: number; open_pnl: number;
  };
  cash: { pending_withdrawals: number; pending_amount: number; net_30d: number; balances: number };
  desk: { requests_pending: number; requests_amount: number; stakes_active: number; stakers: number };
  series: Day[];
};
type Day = { day: string; volume: number; fills: number; net_flow: number; new_clients: number };
type Activity = {
  id: number; at: string; kind: string; actor: string | null;
  summary: string; client_id: string; client_name: string;
};
type Config = {
  live_trading_enabled: boolean; demo_starting_balance: number;
  flag_rules: Record<string, number>; required_kyc_documents: string[]; accepted_uploads: string[];
  instruments: { symbol: string; display_name: string; tick_size: number; lot_size: number }[];
  pipeline_stages: { name: string; sort_order: number; is_terminal: boolean }[];
};

const n0 = (n: number) => Math.round(n).toLocaleString();
// Thresholds are not all whole numbers - a fraction like 0.8 must not round to 1.
const exact = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });
const n2 = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso: string) => new Date(iso).toLocaleString();

/** How long ago, in the words somebody would use. The exact time is on the hover. */
function ago(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
const pretty = (s: string) => s.replace(/_/g, ' ');

// Only "high" is asking for someone's attention now, so only "high" gets the accent.
const SEVERITY: Record<string, string> = {
  high: 'rounded-full bg-ember px-2 py-0.5 text-xs font-medium text-graphite', medium: 'text-obsidian dark:text-vellum', low: 'text-slate-ink',
};

// What a line in the activity feed is about, so the feed can be read by shape before words.
const KIND_ICON: Record<string, typeof Users> = {
  'order.filled': CircleCheck, 'order.placed': ArrowRightLeft, 'order.cancelled': X, 'order.rejected': Ban,
  deposit: ArrowDownLeft, withdrawal: ArrowUpRight, credit: Plus, kyc: ShieldCheck, flag: Flag,
  ticket: MessageSquare, ipo: Rocket, stake: Coins, note: StickyNote, login: LogIn, stage: Workflow, security: Lock, pnl: TrendingUp,
};
const KIND_GROUP: Record<string, 'trading' | 'money' | 'compliance'> = {
  'order.filled': 'trading', 'order.placed': 'trading', 'order.cancelled': 'trading', 'order.rejected': 'trading', pnl: 'trading',
  deposit: 'money', withdrawal: 'money', credit: 'money', ipo: 'money', stake: 'money',
  kyc: 'compliance', flag: 'compliance', security: 'compliance',
};
const FEEDS = [['all', 'All'], ['trading', 'Trading'], ['money', 'Money'], ['compliance', 'Compliance'], ['other', 'CRM']] as const;

const SERIES = [
  { key: 'volume', label: 'Traded volume', short: 'Volume', unit: 'USD', money: true },
  { key: 'net_flow', label: 'Net flows', short: 'Net flows', unit: 'USD', money: true },
  { key: 'fills', label: 'Fills', short: 'Fills', unit: 'fills', money: false },
  { key: 'new_clients', label: 'New clients', short: 'New clients', unit: 'accounts', money: false },
] as const;

const usd0 = (n: number) => `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString()}`;
const usd2 = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}$${n2(Math.abs(n))}`;

export function AdminView() {
  const overview = useApi<Overview>('/admin/overview');
  const activity = useApi<Activity[]>('/activity?limit=40');
  const config = useApi<Config>('/admin/config');
  const [at, setAt] = useState<number>(() => Date.now());
  const [series, setSeries] = useState<(typeof SERIES)[number]['key']>('volume');
  const [feed, setFeed] = useState<(typeof FEEDS)[number][0]>('all');
  const [funding, setFunding] = useState(false);

  // Numbers move as the engine fills orders; a slow refresh keeps this honest without
  // making the dashboard a live terminal. The time it last happened is on screen, because
  // a figure with no age is one somebody trusts longer than they should.
  const refresh = useCallback(() => {
    overview.reload();
    activity.reload();
    setAt(Date.now());
  }, [overview.reload, activity.reload]);

  useEffect(() => {
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (overview.error) return <p role="alert" className={`${alertBox} `}>{overview.error}</p>;
  const o = overview.data;
  const c = config.data;
  const maxStage = Math.max(1, ...(o?.pipeline ?? []).map((p) => Number(p.clients)));
  const total = (o?.pipeline ?? []).reduce((n, p) => n + Number(p.clients), 0);
  const chosen = SERIES.find((s) => s.key === series)!;
  const days = o?.series ?? [];
  const sum = days.reduce((n, d) => n + Number(d[chosen.key]), 0);
  const items = (activity.data ?? []).filter((a) =>
    feed === 'all' || (feed === 'other' ? !KIND_GROUP[a.kind] : KIND_GROUP[a.kind] === feed));

  return (
    <div className="mx-auto max-w-[1440px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Dashboard</PageTitle>
        <span className="x-badge"><i className="nav-live mr-1.5 block size-1.5 rounded-full bg-up" aria-hidden />Live · updated {new Date(at).toLocaleTimeString()}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <a href="#/clients" className="x-btn-sm inline-flex items-center gap-1.5"><Users size={14} aria-hidden />Clients</a>
          <button type="button" onClick={() => setFunding((v) => !v)} className={`x-btn-sm inline-flex items-center gap-1.5 ${funding ? 'is-on' : ''}`}>
            <Plus size={14} aria-hidden />Add funds
          </button>
          <button type="button" onClick={refresh} className="x-btn-sm inline-flex items-center gap-1.5"><RefreshCw size={14} aria-hidden />Refresh</button>
        </div>
      </div>

      {funding && <AddFunds onClose={() => setFunding(false)} />}

      {/* The desk at a glance: fourteen days of one figure, and the book's money beside it. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="x-card x-holo tile p-5">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0">
              <p className="text-[13px] text-mist">{chosen.label} · last 14 days</p>
              <p className="mt-1 flex items-center gap-3 text-[34px] leading-none font-bold tracking-[-0.02em] tabular-nums">
                <span className="h-[28px] w-[3px] rounded bg-ember" aria-hidden />
                {o ? (chosen.money ? usd0(sum) : n0(sum)) : <span className="skeleton inline-block h-8 w-48" />}
              </p>
              <p className="mt-2 text-[12px] text-slate-ink">
                {days.length ? `${days[0]!.day} → ${days[days.length - 1]!.day}` : ''}
              </p>
            </div>
            <div role="tablist" aria-label="Series" className="x-tabs ml-auto">
              {SERIES.map((s) => (
                <button key={s.key} role="tab" aria-selected={series === s.key} className={series === s.key ? 'is-on' : ''}
                  onClick={() => setSeries(s.key)}>{s.short}</button>
              ))}
            </div>
          </div>
          <div className="mt-4"><DeskChart days={days} pick={(d) => Number(d[chosen.key])} money={chosen.money} label={chosen.label} /></div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <MoneyTile label="Client balances" Icon={Landmark} value={o ? usd0(o.cash.balances) : null} note="Net of withdrawals debited, not yet paid" />
          <MoneyTile label="Client exposure" Icon={Layers} value={o ? usd0(o.trading.exposure) : null}
            note={o ? `${n0(o.trading.open_positions)} open position${Number(o.trading.open_positions) === 1 ? '' : 's'}` : ''} />
          <MoneyTile label="Open P&L" Icon={ChartCandlestick} value={o ? usd2(o.trading.open_pnl) : null}
            tone={o ? (o.trading.open_pnl < 0 ? 'text-down' : o.trading.open_pnl > 0 ? 'text-up' : '') : ''} note="Clients' unrealised, at live prices" />
          <MoneyTile label="Withdrawals to pay" Icon={Wallet} value={o ? usd0(o.cash.pending_amount) : null}
            tone={o && o.cash.pending_withdrawals > 0 ? 'text-ember-ink' : ''}
            note={o ? `${n0(o.cash.pending_withdrawals)} waiting · net flows 30d ${usd0(o.cash.net_30d)}` : ''} href="#/requests" />
        </div>
      </div>

      {/* What is waiting on somebody. Each tile opens the queue it counts. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Tile label="Clients" value={o ? n0(o.clients.total) : '—'}
          sub={o ? `${n0(o.clients.new_7d)} new this week · ${n0(o.clients.dormant)} dormant` : ''}
          href="#/clients" />
        <Tile label="KYC waiting" value={o ? n0(o.kyc.pending_docs) : '—'}
          sub={o ? `${n0(o.kyc.clients_approved)} clients approved` : ''}
          href="#/compliance" alert={!!o && o.kyc.pending_docs > 0} />
        <Tile label="Open flags" value={o ? n0(o.flags.open) : '—'}
          sub={o?.flags.by_severity.map((s) => `${s.open} ${s.severity}`).join(' · ') || 'none'}
          href="#/compliance"
          alert={!!o?.flags.by_severity.some((s) => s.severity === 'high' && Number(s.open) > 0)} />
        <Tile label="Open tasks" value={o ? n0(o.tasks.open) : '—'}
          sub={o ? `${n0(o.tasks.overdue)} overdue` : ''} href="#/tasks"
          alert={!!o && o.tasks.overdue > 0} />
        {/* The two queues that did not exist when this page was written. Money waiting on
            a decision belongs on the screen the desk opens first. */}
        <Tile label="Withdrawal requests" value={o ? n0(o.desk.requests_pending) : '—'}
          sub={o ? `${n0(o.desk.requests_amount)} waiting` : ''} href="#/requests"
          alert={!!o && Number(o.desk.requests_pending) > 0} />
        <Tile label="Open stakes" value={o ? n0(o.desk.stakes_active) : '—'}
          sub={o ? `${n0(o.desk.stakers)} client${Number(o.desk.stakers) === 1 ? '' : 's'}` : ''}
          href="#/staking" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="x-card x-holo space-y-4 p-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="section-title">Pipeline</h2>
            <span className="text-xs text-slate-ink">{n0(total)} clients across {o?.pipeline.length ?? 0} stages</span>
          </div>
          <ul className="space-y-2.5">
            {o?.pipeline.map((p, i) => {
              const share = total ? Number(p.clients) / total : 0;
              return (
                <li key={p.stage}>
                  <a href="#/clients" className="x-stage focus-ring">
                    <span className="x-step !size-7 !text-[11px]" aria-hidden>{i + 1}</span>
                    <span className="w-28 shrink-0 truncate text-[13.5px] font-medium">{p.stage}</span>
                    <span className="x-stage-track"><span style={{ width: `${(Number(p.clients) / maxStage) * 100}%` }} /></span>
                    <span className="w-12 text-right text-[14px] font-semibold tabular-nums">{n0(Number(p.clients))}</span>
                    <span className="w-10 text-right text-[11.5px] text-mist tabular-nums">{Math.round(share * 100)}%</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="x-card space-y-4 p-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="section-title">Trading today</h2>
            <span className="text-xs text-slate-ink">Every client, manual and auto trader</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Mini label="Volume today" value={o ? usd0(o.trading.volume_today) : '—'} />
            <Mini label="Volume 7 days" value={o ? usd0(o.trading.volume_7d) : '—'} />
            <Mini label="Fills today" value={o ? n0(o.trading.fills_today) : '—'} />
            <Mini label="Working orders" value={o ? n0(o.trading.working_orders) : '—'} />
            <Mini label="Open positions" value={o ? n0(o.trading.open_positions) : '—'} />
            <Mini label="Net flows 30d" value={o ? usd0(o.cash.net_30d) : '—'}
              tone={o ? (o.cash.net_30d < 0 ? 'text-down' : 'text-up') : ''} />
          </div>
        </div>
      </div>

      <div className="x-card space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="section-title">Everything happening, everywhere</h2>
          <span className="text-xs text-slate-ink">{items.length} of the {activity.data?.length ?? 0} most recent</span>
          <div className="x-qgroups ml-auto w-full sm:w-auto" role="tablist">
            {FEEDS.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={feed === k} className={`!px-3 whitespace-nowrap ${feed === k ? 'is-on' : ''}`}
                onClick={() => setFeed(k)}>{label}</button>
            ))}
          </div>
        </div>
        <ol className="x-feed">
          {items.map((a) => {
            const Icon = KIND_ICON[a.kind] ?? ActivityIcon;
            const tone = a.kind === 'flag' || a.kind === 'order.rejected' ? 'is-down' : a.kind === 'deposit' || a.kind === 'credit' || a.kind === 'order.filled' ? 'is-up' : '';
            return (
              <li key={a.id}>
                <span className={`x-note-icon !size-8 ${tone}`} aria-hidden><Icon size={15} strokeWidth={1.9} /></span>
                <span className="min-w-0 flex-1">
                  <a className="font-semibold text-ember-ink hover:underline" href={`#/clients/${a.client_id}`}>{a.client_name}</a>
                  <span className="ml-2 text-slate-ink">{a.summary}</span>
                </span>
                <span className="x-badge is-muted hidden md:inline-flex">{pretty(a.kind)}</span>
                <span className="w-16 shrink-0 text-right text-xs text-mist" title={when(a.at)}>{ago(a.at)}</span>
              </li>
            );
          })}
        </ol>
        {activity.data && items.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-ink">
            {activity.data.length ? 'Nothing of this kind among the most recent.' : 'Nothing yet. Every credit, fill, upload and decision lands here as it happens.'}
          </p>
        )}
      </div>

      {/* Reference, not work: folded away until somebody needs it. */}
      <details className="x-card group p-5">
        <summary className="flex cursor-pointer list-none items-center gap-3">
          <span className="x-chip !size-8" aria-hidden><Settings2 size={16} /></span>
          <h2 className="section-title">System configuration</h2>
          <span className="text-xs text-slate-ink">Read-only · changing a threshold is a deploy, which is what makes it auditable</span>
          <ChevronDown size={16} className="ml-auto text-mist transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <h3 className="metric-label mb-2">Execution</h3>
            <dl className="grid grid-cols-2 gap-y-1.5">
              <Row label="Live trading" value={c ? (c.live_trading_enabled ? 'ENABLED' : 'disabled') : '—'}
                className={c?.live_trading_enabled ? 'text-ember-ink' : 'text-slate-ink'} />
              <Row label="Demo balance" value={c ? n0(c.demo_starting_balance) : '—'} />
              <Row label="Instruments" value={c ? String(c.instruments.length) : '—'} />
              <Row label="Pipeline stages" value={c ? String(c.pipeline_stages.length) : '—'} />
            </dl>
          </div>
          <div>
            <h3 className="metric-label mb-2">Flag thresholds</h3>
            <dl className="grid grid-cols-2 gap-y-1.5">
              {Object.entries(c?.flag_rules ?? {}).map(([k, v]) => (
                <Row key={k} label={pretty(k)} value={exact(Number(v))} />
              ))}
            </dl>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-ink">
          Required KYC: {c?.required_kyc_documents.map(pretty).join(', ') ?? '—'} ·
          Accepted uploads: {c?.accepted_uploads.join(', ') ?? '—'}
        </p>
      </details>
    </div>
  );
}

function MoneyTile({ label, Icon, value, note, tone = '', href }: {
  label: string; Icon: typeof Users; value: string | null; note?: string; tone?: string; href?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-3">
        <span className="x-chip"><Icon size={18} strokeWidth={1.9} aria-hidden /></span>
        <span className="text-[13px] text-mist">{label}</span>
      </div>
      {value === null
        ? <span className="skeleton mt-4 block h-6 w-32" />
        : <p className={`mt-4 truncate text-[22px] leading-none font-bold tabular-nums ${tone}`}>{value}</p>}
      {note && <p className="mt-2 text-xs text-slate-ink">{note}</p>}
    </>
  );
  return href
    ? <a href={href} className="x-card x-holo tile lift flex flex-col p-4">{body}</a>
    : <div className="x-card x-holo tile flex flex-col p-4">{body}</div>;
}

const Mini = ({ label, value, tone = '' }: { label: string; value: string; tone?: string }) => (
  <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3.5 py-3">
    <p className="text-[12px] text-mist">{label}</p>
    <p className={`mt-1.5 truncate text-[17px] font-semibold tabular-nums ${tone}`}>{value}</p>
  </div>
);

/**
 * Fourteen days of one desk figure as an area, the same drawing as the client's earnings.
 *
 * Every number is counted from the tables, not modelled: an empty desk draws fourteen
 * empty days rather than a plausible-looking line, which is the point — a dashboard that
 * always looks busy is one nobody checks. Money moving both ways draws from zero, so a
 * withdrawal-heavy day reads as down.
 */
function DeskChart({ days, pick, money, label }: { days: Day[]; pick: (d: Day) => number; money: boolean; label: string }) {
  const W = 720, H = 170;
  const [hover, setHover] = useState<number | null>(null);
  if (days.length < 2) return <p className="py-12 text-center text-sm text-slate-ink">Not enough history yet.</p>;
  const values = days.map(pick);
  const top = Math.max(...values, 0), bottom = Math.min(...values, 0), span = top - bottom || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => 8 + (H - 16) - ((v - bottom) / span) * (H - 16);
  let line = `M 0 ${y(values[0]!)}`;
  for (let i = 1; i < values.length; i++) {
    const mid = (x(i - 1) + x(i)) / 2;
    line += ` C ${mid} ${y(values[i - 1]!)}, ${mid} ${y(values[i]!)}, ${x(i)} ${y(values[i]!)}`;
  }
  const area = `${line} L ${W} ${y(bottom)} L 0 ${y(bottom)} Z`;
  const fmt = (v: number) => (money ? usd0(v) : n0(v));
  const h = hover ?? values.length - 1;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" role="img"
        aria-label={`${label} over ${days.length} days`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(values.length - 1, Math.round(((e.clientX - r.left) / r.width) * (values.length - 1)))));
        }}>
        <defs>
          <linearGradient id="desk-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-ember)" stopOpacity="0.38" />
            <stop offset="100%" stopColor="var(--color-ember)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="rgba(255,255,255,0.05)" />)}
        {bottom < 0 && <line x1="0" y1={y(0)} x2={W} y2={y(0)} className="stroke-slate-ink/40" strokeDasharray="3 4" />}
        <path d={area} fill="url(#desk-area)" />
        <path d={line} fill="none" stroke="var(--color-ember)" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
        <line x1={x(h)} x2={x(h)} y1="0" y2={H} stroke="rgba(255,117,24,0.35)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        <circle cx={x(h)} cy={y(values[h]!)} r="4.5" fill="var(--color-ember)" stroke="#080d10" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="pointer-events-none absolute top-0 rounded-md border border-white/10 bg-onyx/95 px-2.5 py-1.5 text-[12px] shadow-lg"
        style={{ left: `clamp(0px, calc(${(h / (values.length - 1)) * 100}% - 60px), calc(100% - 130px))` }}>
        <span className="block text-mist">{new Date(days[h]!.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        <span className={`block font-semibold tabular-nums ${values[h]! < 0 ? 'text-down' : ''}`}>{fmt(values[h]!)}</span>
      </div>
      <div className="mt-2 flex justify-between text-[11.5px] text-mist">
        {[0, Math.floor(days.length / 2), days.length - 1].map((i) => (
          <span key={i}>{new Date(days[i]!.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * Credit any client from the dashboard, without opening their record first.
 *
 * The same two audited routes the client workspace uses: fiat goes to the currency
 * account, crypto to the wallet. Accounts open empty by design, so this is how a client
 * comes to have anything at all — which is why it is admin-only and lands on their
 * timeline, not a quiet balance edit.
 */
function AddFunds({ onClose }: { onClose?: () => void }) {
  const clients = useApi<{ id: string; name: string; email: string }[]>('/clients?limit=200');
  const currencies = useApi<{ code: string; name: string; kind: 'fiat' | 'crypto' }[]>('/currencies');
  const [clientId, setClientId] = useState('');
  const [code, setCode] = useState('USD');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const chosen = currencies.data?.find((c) => c.code === code);
  const fiat = currencies.data?.filter((c) => c.kind === 'fiat') ?? [];
  const crypto = currencies.data?.filter((c) => c.kind === 'crypto') ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    if (!clientId) return setError('choose a client');
    setBusy(true);
    try {
      // Crypto goes to the wallet, fiat to the currency account. Same button, right route.
      const path = chosen?.kind === 'crypto'
        ? `/clients/${clientId}/wallet-credit`
        : `/clients/${clientId}/credit`;
      const body = chosen?.kind === 'crypto'
        ? { asset: code, amount: Number(amount) }
        : { currency: code, amount: Number(amount), note: note || undefined };
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      const who = clients.data?.find((c) => c.id === clientId)?.name ?? 'client';
      setDone(`Credited ${amount} ${code} to ${who}`);
      setAmount('');
      setNote('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="x-card x-holo space-y-3 p-5">
      <div className="flex items-start gap-3">
        <span className="x-chip" aria-hidden><Plus size={18} /></span>
        <div className="min-w-0 flex-1">
        <h2 className="section-title">Add funds to a client</h2>
        <p className="mt-1 text-xs text-slate-ink">
          Accounts open with nothing in them. Crypto lands in the client's wallet, currencies
          in their cash account. Audited, and written to their timeline.
        </p>
        </div>
        {onClose && <button type="button" onClick={onClose} className="x-btn-sm" aria-label="Close">Close</button>}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-ink">
          Client
          <select className={`${field} mt-1 block w-64`} value={clientId}
            onChange={(e) => setClientId(e.target.value)}>
            <option value="">Choose a client…</option>
            {clients.data?.map((c) => (
              <option key={c.id} value={c.id}>{c.name} — {c.email}</option>
            ))}
          </select>
        </label>

        <label className="text-xs text-slate-ink">
          Currency
          <select className={`${field} mt-1 block w-52`} value={code}
            onChange={(e) => setCode(e.target.value)}>
            <optgroup label="Crypto">
              {crypto.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
            </optgroup>
            <optgroup label="Currencies">
              {fiat.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
            </optgroup>
          </select>
        </label>

        <label className="text-xs text-slate-ink">
          Amount
          <input className={`${field} mt-1 block w-36`} type="number" step="any" min="0" required
            placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>

        {chosen?.kind !== 'crypto' && (
          <label className="text-xs text-slate-ink">
            Reason
            <input className={`${field} mt-1 block w-56`} placeholder="Appears on the timeline"
              value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        )}

        <button className={btn} disabled={busy}>{busy ? 'Crediting…' : 'Add funds'}</button>
      </div>

      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
      {done && (
        <p role="status" className="font-mono text-xs text-slate-ink">
          {done} · <a className="hover:underline" href={`#/clients/${clientId}`}>open the client</a>
        </p>
      )}
    </form>
  );
}

// The client area's tile: an ember icon chip, the label, the figure, a note.
const TILE_ICON: Record<string, typeof Users> = {
  Clients: Users, 'KYC waiting': ShieldCheck, 'Open flags': Flag, 'Open tasks': ListTodo,
  'Withdrawal requests': Inbox, 'Open stakes': Coins,
};
function Tile({ label, value, sub, href, alert }: {
  label: string; value: string; sub?: string; href: string; alert?: boolean;
}) {
  const Icon = TILE_ICON[label] ?? Users;
  return (
    <a href={href} className={`x-card tile lift block p-4 ${alert ? 'is-alert' : ''}`}>
      <div className="flex items-center gap-3">
        <span className="x-chip"><Icon size={18} strokeWidth={1.9} aria-hidden /></span>
        <span className="text-[13px] text-mist">{label}</span>
      </div>
      <p className={`mt-3 text-[28px] font-bold leading-none tabular-nums ${alert ? 'text-ember-ink' : ''}`}>{value}</p>
      {sub && <p className="mt-2 text-xs text-slate-ink">{sub}</p>}
    </a>
  );
}

const Row = ({ label, value, className = '' }: { label: string; value: string; className?: string }) => (
  <>
    <dt className="text-slate-ink">{label}</dt>
    <dd className={`text-right font-mono tabular-nums ${className}`}>{value}</dd>
  </>
);
