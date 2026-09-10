import { useCallback, useEffect, useState } from 'react';
import { alertBox, btn, card, field, mono, PageTitle } from './App.tsx';
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

export function AdminView() {
  const overview = useApi<Overview>('/admin/overview');
  const activity = useApi<Activity[]>('/activity?limit=25');
  const config = useApi<Config>('/admin/config');
  const [at, setAt] = useState<number>(() => Date.now());

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

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Dashboard</PageTitle>
        <span className="flex items-center gap-2 font-mono text-[11px] text-slate-ink">
          <span className="nav-live inline-block h-1.5 w-1.5 rounded-full bg-up" aria-hidden />
          updated {new Date(at).toLocaleTimeString()}
        </span>
        <button onClick={refresh}
          className="ml-auto rounded-md border border-pebble px-3 py-1.5 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
          Refresh
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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

      <Metrics days={o?.series ?? []} />

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className={`${card} space-y-3`}>
          <h2 className="metric-label">Pipeline</h2>
          {o?.pipeline.map((p) => (
            <a key={p.stage} href={`#/clients`}
              className="flex items-center gap-3 rounded-md px-1 py-0.5 text-sm transition-colors hover:bg-bone dark:hover:bg-white/5">
              <span className="w-28 shrink-0 text-slate-ink">{p.stage}</span>
              <span className="h-2 rounded-md bg-ember"
                style={{ width: `${(Number(p.clients) / maxStage) * 100}%`, minWidth: Number(p.clients) ? 8 : 0 }} />
              <span className="ml-auto font-mono tabular-nums">{n0(Number(p.clients))}</span>
              <span className="w-10 text-right font-mono text-[11px] text-slate-ink">
                {total ? `${Math.round((Number(p.clients) / total) * 100)}%` : ''}
              </span>
            </a>
          ))}
        </div>

        <div className={`${card} space-y-3`}>
          <h2 className="metric-label">Trading &amp; funds</h2>
          <p className="text-xs text-slate-ink">
            Client balances are net of withdrawals already debited but not yet paid out.
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Row label="Volume today" value={o ? n0(o.trading.volume_today) : '—'} />
            <Row label="Volume 7d" value={o ? n0(o.trading.volume_7d) : '—'} />
            <Row label="Fills today" value={o ? n0(o.trading.fills_today) : '—'} />
            <Row label="Working orders" value={o ? n0(o.trading.working_orders) : '—'} />
            <Row label="Open positions" value={o ? n0(o.trading.open_positions) : '—'} />
            <Row label="Client exposure" value={o ? n0(o.trading.exposure) : '—'} />
            <Row label="Open P&L" value={o ? n2(o.trading.open_pnl) : '—'}
              className={o && o.trading.open_pnl < 0 ? 'text-down' : 'text-up'} />
            <Row label="Client balances" value={o ? n0(o.cash.balances) : '—'} />
            <Row label="Net flows 30d" value={o ? n0(o.cash.net_30d) : '—'} />
            <Row label="Withdrawals to pay" value={o ? `${n0(o.cash.pending_withdrawals)} (${n0(o.cash.pending_amount)})` : '—'}
              className={o && o.cash.pending_withdrawals > 0 ? 'font-medium text-obsidian dark:text-vellum' : ''} />
          </dl>
        </div>
      </div>

      <AddFunds />

      <div className={`${card} space-y-2`}>
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="metric-label">Everything happening, everywhere</h2>
          <span className="ml-auto font-mono text-[11px] text-slate-ink">
            {activity.data?.length ?? 0} most recent
          </span>
        </div>
        <ol className="divide-y divide-pebble dark:divide-white/10">
          {activity.data?.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className={`w-24 shrink-0 rounded-md px-1.5 py-0.5 text-center font-mono text-[10px] tracking-wide uppercase ${
                a.kind === 'flag'
                  ? 'bg-ember/15 text-ember'
                  : 'bg-bone text-slate-ink dark:bg-white/5 dark:text-mist'}`}>
                {pretty(a.kind)}
              </span>
              <a className="font-medium text-ember hover:underline" href={`#/clients/${a.client_id}`}>
                {a.client_name}
              </a>
              <span className="min-w-0 text-slate-ink dark:text-mist">{a.summary}</span>
              <span className={`ml-auto shrink-0 text-xs text-slate-ink ${mono}`} title={when(a.at)}>
                {ago(a.at)}
              </span>
            </li>
          ))}
        </ol>
        {activity.data?.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-ink">
            Nothing yet. Every credit, fill, upload and decision lands here as it happens.
          </p>
        )}
      </div>

      <div className={`${card} space-y-3`}>
        <h2 className="metric-label">System configuration</h2>
        <p className="text-xs text-slate-ink">
          Read-only. These are code constants, not settings — changing a threshold is a
          deploy, which is also what makes it auditable.
        </p>
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-ink">Execution</h3>
            <dl className="grid grid-cols-2 gap-y-1">
              <Row label="Live trading" value={c ? (c.live_trading_enabled ? 'ENABLED' : 'disabled') : '—'}
                className={c?.live_trading_enabled ? 'rounded-full bg-ember px-2 py-0.5 text-xs font-medium text-graphite' : 'text-slate-ink'} />
              <Row label="Demo balance" value={c ? n0(c.demo_starting_balance) : '—'} />
              <Row label="Instruments" value={c ? String(c.instruments.length) : '—'} />
              <Row label="Pipeline stages" value={c ? String(c.pipeline_stages.length) : '—'} />
            </dl>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-ink">Flag thresholds</h3>
            <dl className="grid grid-cols-2 gap-y-1">
              {Object.entries(c?.flag_rules ?? {}).map(([k, v]) => (
                <Row key={k} label={pretty(k)} value={exact(Number(v))} />
              ))}
            </dl>
          </div>
        </div>
        <p className="text-xs text-slate-ink">
          Required KYC: {c?.required_kyc_documents.map(pretty).join(', ') ?? '—'} ·
          Accepted uploads: {c?.accepted_uploads.join(', ') ?? '—'}
        </p>
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
function AddFunds() {
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
    <form onSubmit={submit} className={`${card} space-y-3`}>
      <div>
        <h2 className="metric-label">Add funds to a client</h2>
        <p className="mt-1 text-xs text-slate-ink">
          Accounts open with nothing in them. Crypto lands in the client's wallet, currencies
          in their cash account. Audited, and written to their timeline.
        </p>
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

/**
 * Fourteen days of the figures the tiles show as a single instant.
 *
 * Every number here is counted from the tables, not modelled: an empty desk draws
 * fourteen empty days rather than a plausible-looking line, which is the point — a
 * dashboard that always looks busy is one nobody checks.
 */
function Metrics({ days }: { days: Day[] }) {
  const total = (k: keyof Day) => days.reduce((n, d) => n + Number(d[k]), 0);
  return (
    <div className={`${card} space-y-4`}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="metric-label">Metrics · last 14 days</h2>
        <span className="ml-auto font-mono text-[11px] text-slate-ink">
          {days.length ? `${days[0].day} → ${days[days.length - 1].day}` : ''}
        </span>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <Graph label="Traded volume" days={days} pick={(d) => d.volume}
          total={n0(total('volume'))} unit="USD" />
        <Graph label="Net flows" days={days} pick={(d) => d.net_flow}
          total={n0(total('net_flow'))} unit="USD" signed />
        <Graph label="New clients" days={days} pick={(d) => d.new_clients}
          total={n0(total('new_clients'))} unit="accounts" />
      </div>
    </div>
  );
}

/**
 * A bar per day, scaled to the largest bar in its own series.
 *
 * Each graph carries its own scale because they are different units — sharing one would
 * flatten client counts into nothing next to volume. A signed series (money moving both
 * ways) is drawn from a middle baseline so a withdrawal-heavy day reads as down, not small.
 */
function Graph({ label, days, pick, total, unit, signed }: {
  label: string; days: Day[]; pick: (d: Day) => number; total: string; unit: string; signed?: boolean;
}) {
  const values = days.map(pick);
  const peak = Math.max(1, ...values.map(Math.abs));
  const W = 220, H = 56, gap = 3;
  const w = days.length ? (W - gap * (days.length - 1)) / days.length : 0;
  const base = signed ? H / 2 : H;

  return (
    <div>
      <p className="metric-label">{label}</p>
      <p className="mt-1 font-mono text-xl font-medium tabular-nums">{total}</p>
      <p className="font-mono text-[10px] text-slate-ink">{unit}</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img"
        aria-label={`${label}: ${total} ${unit} over ${days.length} days`}>
        <line x1="0" y1={base} x2={W} y2={base} strokeWidth="1"
          className="stroke-slate-ink/30" />
        {values.map((v, i) => {
          const h = (Math.abs(v) / peak) * (signed ? H / 2 : H);
          return (
            <rect key={i} className="bar" x={i * (w + gap)} width={w}
              y={v < 0 ? base : base - h} height={Math.max(h, v ? 1 : 0)}
              fill={signed && v < 0 ? 'var(--color-down)' : 'var(--color-ember)'}
              opacity={i === values.length - 1 ? 1 : 0.55}
              style={{ animationDelay: `${i * 22}ms` }}>
              <title>{`${days[i].day}: ${exact(v)}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

function Tile({ label, value, sub, href, alert }: {
  label: string; value: string; sub?: string; href: string; alert?: boolean;
}) {
  return (
    <a href={href}
      className={`${card} tile block transition-colors hover:bg-pebble dark:hover:bg-white/10 ${alert ? 'is-alert' : ''}`}>
      <span className="tile-corner" aria-hidden />
      <p className="metric-label">{label}</p>
      {/* Mono numerals at tile size: the stat should read as a terminal readout. */}
      <p className={`mt-2 font-mono text-[34px] font-medium leading-none tabular-nums ${alert ? 'text-ember' : ''}`}>{value}</p>
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
