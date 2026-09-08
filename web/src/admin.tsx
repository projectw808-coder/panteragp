import { useEffect } from 'react';
import { card } from './App.tsx';
import { useApi } from './api.ts';

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
};
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
const pretty = (s: string) => s.replace(/_/g, ' ');

const SEVERITY: Record<string, string> = {
  high: 'text-red-600', medium: 'text-amber-600', low: 'text-slate-500',
};

export function AdminView() {
  const overview = useApi<Overview>('/admin/overview');
  const activity = useApi<Activity[]>('/activity?limit=25');
  const config = useApi<Config>('/admin/config');

  // Numbers move as the engine fills orders; a slow refresh keeps this honest without
  // making the dashboard a live terminal.
  useEffect(() => {
    const id = setInterval(() => { overview.reload(); activity.reload(); }, 15_000);
    return () => clearInterval(id);
  }, [overview.reload, activity.reload]);

  if (overview.error) return <p role="alert" className="text-sm text-red-600">{overview.error}</p>;
  const o = overview.data;
  const c = config.data;
  const maxStage = Math.max(1, ...(o?.pipeline ?? []).map((p) => Number(p.clients)));

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className={`${card} space-y-3`}>
          <h2 className="text-sm font-semibold">Pipeline</h2>
          {o?.pipeline.map((p) => (
            <div key={p.stage} className="flex items-center gap-3 text-sm">
              <span className="w-28 shrink-0 text-slate-500">{p.stage}</span>
              <span className="h-2 rounded bg-slate-900 dark:bg-slate-300"
                style={{ width: `${(Number(p.clients) / maxStage) * 100}%`, minWidth: Number(p.clients) ? 8 : 0 }} />
              <span className="tabular-nums">{p.clients}</span>
            </div>
          ))}
        </div>

        <div className={`${card} space-y-3`}>
          <h2 className="text-sm font-semibold">Trading &amp; funds</h2>
          <p className="text-xs text-slate-500">
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
              className={o && o.trading.open_pnl < 0 ? 'text-red-600' : 'text-green-600'} />
            <Row label="Client balances" value={o ? n0(o.cash.balances) : '—'} />
            <Row label="Net flows 30d" value={o ? n0(o.cash.net_30d) : '—'} />
            <Row label="Withdrawals to pay" value={o ? `${n0(o.cash.pending_withdrawals)} (${n0(o.cash.pending_amount)})` : '—'}
              className={o && o.cash.pending_withdrawals > 0 ? 'text-amber-600' : ''} />
          </dl>
        </div>
      </div>

      <div className={`${card} space-y-2`}>
        <h2 className="text-sm font-semibold">Everything happening, everywhere</h2>
        <ol className="divide-y divide-slate-100 dark:divide-slate-800">
          {activity.data?.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-2 py-1.5 text-sm">
              <span className={`w-28 shrink-0 text-xs ${a.kind === 'flag' ? 'text-red-600' : 'text-slate-500'}`}>
                {pretty(a.kind)}
              </span>
              <a className="font-medium hover:underline" href={`#/clients/${a.client_id}`}>{a.client_name}</a>
              <span className="text-slate-600 dark:text-slate-300">{a.summary}</span>
              <span className="ml-auto text-xs text-slate-500">{when(a.at)}</span>
            </li>
          ))}
        </ol>
        {activity.data?.length === 0 && <p className="text-sm text-slate-500">Nothing yet.</p>}
      </div>

      <div className={`${card} space-y-3`}>
        <h2 className="text-sm font-semibold">System configuration</h2>
        <p className="text-xs text-slate-500">
          Read-only. These are code constants, not settings — changing a threshold is a
          deploy, which is also what makes it auditable.
        </p>
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500">Execution</h3>
            <dl className="grid grid-cols-2 gap-y-1">
              <Row label="Live trading" value={c ? (c.live_trading_enabled ? 'ENABLED' : 'disabled') : '—'}
                className={c?.live_trading_enabled ? 'font-semibold text-red-600' : 'text-green-600'} />
              <Row label="Demo balance" value={c ? n0(c.demo_starting_balance) : '—'} />
              <Row label="Instruments" value={c ? String(c.instruments.length) : '—'} />
              <Row label="Pipeline stages" value={c ? String(c.pipeline_stages.length) : '—'} />
            </dl>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500">Flag thresholds</h3>
            <dl className="grid grid-cols-2 gap-y-1">
              {Object.entries(c?.flag_rules ?? {}).map(([k, v]) => (
                <Row key={k} label={pretty(k)} value={exact(Number(v))} />
              ))}
            </dl>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Required KYC: {c?.required_kyc_documents.map(pretty).join(', ') ?? '—'} ·
          Accepted uploads: {c?.accepted_uploads.join(', ') ?? '—'}
        </p>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, href, alert }: {
  label: string; value: string; sub?: string; href: string; alert?: boolean;
}) {
  return (
    <a href={href} className={`${card} block transition-colors hover:border-slate-400 dark:hover:border-slate-600`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${alert ? 'text-amber-600' : ''}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </a>
  );
}

const Row = ({ label, value, className = '' }: { label: string; value: string; className?: string }) => (
  <>
    <dt className="text-slate-500">{label}</dt>
    <dd className={`text-right tabular-nums ${className}`}>{value}</dd>
  </>
);
