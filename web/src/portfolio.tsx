import { useState } from 'react';
import { btn, card, field, input } from './App.tsx';
import { api, useApi } from './api.ts';
import type { Currency } from './wallet.tsx';

type PortfolioType = {
  code: string; name: string; description: string;
  indicative_rate: number | null; sort_order: number;
};
type Portfolio = {
  id: string; type_code: string; type_name: string; name: string; currency: string;
  balance: number; target_amount: number | null; target_date: string | null;
  status: 'open' | 'closed'; indicative_rate: number | null;
  usd_value: number | null; progress: number | null; projected: number | null;
};

const money = (n: number, code: string) =>
  `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${code}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const day = (d: string) => new Date(d).toLocaleDateString();

/** A client's pots: open one, pay into it, take money back out. */
export function PortfoliosPanel() {
  const portfolios = useApi<Portfolio[]>('/portfolios');
  const types = useApi<PortfolioType[]>('/portfolio-types');
  const currencies = useApi<Currency[]>('/currencies');
  const [adding, setAdding] = useState(false);

  const open = portfolios.data?.filter((p) => p.status === 'open') ?? [];
  const closed = portfolios.data?.filter((p) => p.status === 'closed') ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-slate-500">Your portfolios</h3>
        <button className={btn} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New portfolio'}
        </button>
      </div>

      {adding && (
        <NewPortfolio types={types.data ?? []} currencies={currencies.data ?? []}
          onDone={() => { setAdding(false); portfolios.reload(); }} />
      )}

      {open.map((p) => <Pot key={p.id} p={p} onDone={portfolios.reload} />)}
      {!open.length && !adding && (
        <p className="text-sm text-slate-500">
          No portfolios yet. Open one to set money aside for a particular purpose.
        </p>
      )}

      {!!closed.length && (
        <details className="text-sm text-slate-500">
          <summary className="cursor-pointer">{closed.length} closed</summary>
          <ul className="mt-1 space-y-1">
            {closed.map((p) => <li key={p.id}>{p.name} — {p.type_name}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function Pot({ p, onDone }: { p: Portfolio; onDone: () => void }) {
  const [action, setAction] = useState<'contribute' | 'withdraw' | null>(null);
  const [amt, setAmt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function move(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/portfolios/${p.id}/${action}`, { method: 'POST', body: JSON.stringify({ amount: Number(amt) }) });
      setAmt(''); setAction(null);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  async function close() {
    setError(null);
    try {
      await api(`/portfolios/${p.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
      onDone();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{p.name}</span>
        <span className="text-xs text-slate-500">{p.type_name}</span>
        <span className="ml-auto tabular-nums">{money(p.balance, p.currency)}</span>
      </div>

      {p.progress !== null && (
        <div className="mt-2">
          <div className="h-1.5 w-full rounded bg-slate-100 dark:bg-slate-800">
            <div className="h-1.5 rounded bg-slate-900 dark:bg-slate-300" style={{ width: pct(p.progress) }} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {pct(p.progress)} of {money(p.target_amount!, p.currency)}
            {p.target_date && ` by ${day(p.target_date)}`}
          </p>
        </div>
      )}

      {p.projected !== null && (
        <p className="mt-1 text-xs text-slate-500">
          {/* Explicitly a projection: nothing in this system pays interest in. */}
          Projected {money(p.projected, p.currency)} by then at an indicative{' '}
          {pct(p.indicative_rate ?? 0)} a year — an illustration, not interest paid.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => { setAction(action === 'contribute' ? null : 'contribute'); setError(null); }}
          className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">pay in</button>
        <button onClick={() => { setAction(action === 'withdraw' ? null : 'withdraw'); setError(null); }}
          className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">take out</button>
        {Number(p.balance) === 0 && (
          <button onClick={close} className="ml-auto text-slate-500 hover:text-red-600">close</button>
        )}
      </div>

      {action && (
        <form onSubmit={move} className="mt-2 flex items-end gap-2">
          <input className={`${field} w-32`} type="number" step="any" min="0" required autoFocus
            placeholder={`Amount in ${p.currency}`} value={amt} onChange={(e) => setAmt(e.target.value)} />
          <button className={btn} disabled={busy}>
            {busy ? 'Moving…' : action === 'contribute' ? 'Pay in' : 'Take out'}
          </button>
        </form>
      )}
      {error && <p role="alert" className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}

function NewPortfolio({ types, currencies, onDone }: {
  types: PortfolioType[]; currencies: Currency[]; onDone: () => void;
}) {
  const [type, setType] = useState('retirement');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = types.find((t) => t.code === type);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/portfolios', {
        method: 'POST',
        body: JSON.stringify({
          type_code: type,
          name: f.get('name'),
          currency: f.get('currency'),
          ...(f.get('target_amount') ? { target_amount: Number(f.get('target_amount')) } : {}),
          ...(f.get('target_date') ? { target_date: f.get('target_date') } : {}),
        }),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-2`}>
      <select className={input} value={type} onChange={(e) => setType(e.target.value)}>
        {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
      </select>
      {chosen && <p className="text-xs text-slate-500">{chosen.description}</p>}
      <div className="flex flex-wrap gap-2">
        <input name="name" required maxLength={80} placeholder="Name it, e.g. Retirement 2055"
          className={`${field} flex-1`} />
        <select name="currency" className={`${field} w-28`} defaultValue="USD">
          {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="text-xs text-slate-500">Target amount (optional)
          <input name="target_amount" type="number" step="any" min="0" className={field} /></label>
        <label className="text-xs text-slate-500">Target date (optional)
          <input name="target_date" type="date" className={field} /></label>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button className={btn} disabled={busy}>{busy ? 'Opening…' : 'Open portfolio'}</button>
    </form>
  );
}

/** Read-only view of a client's pots, for the client record. */
export function ClientPortfolios({ clientId }: { clientId: string }) {
  const portfolios = useApi<Portfolio[]>(`/portfolios?client_id=${clientId}`);
  const rows = portfolios.data ?? [];
  if (!rows.length) return null;
  return (
    <div className={`${card} space-y-2`}>
      <h2 className="text-sm font-semibold">Portfolios</h2>
      {rows.map((p) => (
        <div key={p.id} className="flex flex-wrap items-baseline gap-2 text-sm">
          <span className="font-medium">{p.name}</span>
          <span className="text-xs text-slate-500">{p.type_name}</span>
          {p.status === 'closed' && <span className="text-xs text-slate-500">closed</span>}
          <span className="ml-auto tabular-nums">{money(p.balance, p.currency)}</span>
          {p.progress !== null && <span className="text-xs text-slate-500">{pct(p.progress)}</span>}
        </div>
      ))}
    </div>
  );
}
