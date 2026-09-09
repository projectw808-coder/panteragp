import { useState } from 'react';
import { alertBox, btn, card, field, input } from './App.tsx';
import { api, useApi } from './api.ts';
import type { Currency } from './wallet.tsx';

type PortfolioType = {
  code: string; name: string; description: string;
  indicative_rate: number | null; sort_order: number;
};
type Portfolio = {
  id: string; type_code: string; type_name: string; name: string; currency: string;
  balance: number; target_amount: number | null; target_date: string | null;
  status: 'open' | 'closed'; indicative_rate: number | null; standard_rate: number | null;
  rate_override: number | null;
  usd_value: number | null; progress: number | null; projected: number | null;
};

const money = (n: number, code: string) =>
  `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${code}`;
// One decimal is enough for a progress bar and wrong for a rate: an agreed 7.25% shown as
// 7.2% is a smaller number than the one on the client's screen everywhere else. Up to two,
// with trailing zeros trimmed, so 3.5% does not become 3.50%.
const pct = (n: number) => `${Number((n * 100).toFixed(2))}%`;
const day = (d: string) => new Date(d).toLocaleDateString();

/**
 * A client's pots: open one, pay into it, take money back out.
 *
 * The same panel serves both sides. A client passes no clientId and acts on themselves;
 * staff pass one and act on that client, which the API requires them to name explicitly
 * on every write. One component rather than a staff copy: two versions of a screen that
 * moves money is two places for the rules to drift apart.
 */
export function PortfoliosPanel({ clientId }: { clientId?: string } = {}) {
  const on = clientId ? { client_id: clientId } : {};
  const portfolios = useApi<Portfolio[]>(clientId ? `/portfolios?client_id=${clientId}` : '/portfolios');
  const types = useApi<PortfolioType[]>('/portfolio-types');
  const currencies = useApi<Currency[]>('/currencies');
  const [adding, setAdding] = useState(false);

  const open = portfolios.data?.filter((p) => p.status === 'open') ?? [];
  const closed = portfolios.data?.filter((p) => p.status === 'closed') ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="metric-label">{clientId ? 'Portfolios' : 'Your portfolios'}</h3>
        <button className={btn} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New portfolio'}
        </button>
      </div>

      {adding && (
        <NewPortfolio types={types.data ?? []} currencies={currencies.data ?? []} on={on}
          onDone={() => { setAdding(false); portfolios.reload(); }} />
      )}

      {open.map((p) => <Pot key={p.id} p={p} on={on} onDone={portfolios.reload} />)}
      {!open.length && !adding && (
        <p className="text-sm text-slate-ink">
          {clientId
            ? 'No portfolios yet. Opening one here does it on the client’s behalf, and is recorded that way.'
            : 'No portfolios yet. Open one to set money aside for a particular purpose.'}
        </p>
      )}

      {!!closed.length && (
        <details className="text-sm text-slate-ink">
          <summary className="cursor-pointer">{closed.length} closed</summary>
          <ul className="mt-1 space-y-1">
            {closed.map((p) => <li key={p.id}>{p.name} — {p.type_name}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

type On = { client_id?: string };

function Pot({ p, on, onDone }: { p: Portfolio; on: On; onDone: () => void }) {
  const [action, setAction] = useState<'contribute' | 'withdraw' | null>(null);
  const [rate, setRate] = useState(false);
  const [amt, setAmt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function move(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/portfolios/${p.id}/${action}`, { method: 'POST', body: JSON.stringify({ ...on, amount: Number(amt) }) });
      setAmt(''); setAction(null);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  async function close() {
    setError(null);
    try {
      await api(`/portfolios/${p.id}`, { method: 'PATCH', body: JSON.stringify({ ...on, status: 'closed' }) });
      onDone();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="rounded-md border border-pebble p-3 dark:border-white/10">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{p.name}</span>
        <span className="text-xs text-slate-ink">{p.type_name}</span>
        <span className="ml-auto tabular-nums">{money(p.balance, p.currency)}</span>
      </div>

      {p.progress !== null && (
        <div className="mt-2">
          <div className="h-1.5 w-full rounded-md bg-bone dark:bg-white/10">
            <div className="h-1.5 rounded-md bg-ember" style={{ width: pct(p.progress) }} />
          </div>
          <p className="mt-1 text-xs text-slate-ink">
            {pct(p.progress)} of {money(p.target_amount!, p.currency)}
            {p.target_date && ` by ${day(p.target_date)}`}
          </p>
        </div>
      )}

      {p.projected !== null && (
        <p className="mt-1 text-xs text-slate-ink">
          {/* Interest is genuinely credited daily at this rate, so the projection is a
              forecast of the accrual rather than a decorative illustration. */}
          Earning {pct(p.indicative_rate ?? 0)} a year{p.rate_override !== null && ' (agreed with the desk)'}, credited daily —
          projected {money(p.projected, p.currency)} by then if left untouched.
        </p>
      )}
      {p.projected === null && p.indicative_rate !== null && (
        <p className="mt-1 text-xs text-slate-ink">
          Earning {pct(p.indicative_rate)} a year{p.rate_override !== null && ' (agreed with the desk)'}, credited daily.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => { setAction(action === 'contribute' ? null : 'contribute'); setError(null); }}
          className="text-slate-ink hover:text-obsidian dark:hover:text-vellum">pay in</button>
        <button onClick={() => { setAction(action === 'withdraw' ? null : 'withdraw'); setError(null); }}
          className="text-slate-ink hover:text-obsidian dark:hover:text-vellum">take out</button>
        {on.client_id && (
          <button onClick={() => { setRate((v) => !v); setError(null); }}
            className="text-ember hover:underline">set rate</button>
        )}
        {Number(p.balance) === 0 && (
          <button onClick={close} className="ml-auto text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">close</button>
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
      {rate && on.client_id && (
        <SetRate p={p} on={on} onDone={() => { setRate(false); onDone(); }} onError={setError} />
      )}
      {error && <p role="alert" className={`${alertBox} mt-1 `}>{error}</p>}
    </div>
  );
}

/**
 * The rate this one pot earns, as agreed with this one client.
 *
 * Entered as a percentage because that is how it is agreed and how it is shown; stored as
 * a fraction, converted once, here. Clearing it puts the pot back on the product's rate
 * rather than on nothing — a blank box meaning "earns zero" would be a quiet way to stop
 * paying somebody.
 */
function SetRate({ p, on, onDone, onError }: {
  p: Portfolio; on: On; onDone: () => void; onError: (m: string | null) => void;
}) {
  const asPercent = (n: number | null) => (n === null ? '' : String(Number((n * 100).toFixed(4))));
  const [value, setValue] = useState(asPercent(p.rate_override));
  const [busy, setBusy] = useState(false);

  async function save(next: number | null) {
    setBusy(true);
    onError(null);
    try {
      await api(`/portfolios/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...on, rate_override: next }),
      });
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form className="mt-2 space-y-2 rounded-md border border-ember/40 p-2"
      onSubmit={(e) => { e.preventDefault(); save(value === '' ? null : Number(value) / 100); }}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-ink">
          Rate
          <span className="mt-1 flex items-center gap-1">
            <input className={`${field} w-24`} type="number" step="0.01" min="0" max="100" autoFocus
              placeholder={asPercent(p.standard_rate) || '0'}
              value={value} onChange={(e) => setValue(e.target.value)} />
            <span className="font-mono text-xs">% a year</span>
          </span>
        </label>
        <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Set rate'}</button>
        {p.rate_override !== null && (
          <button type="button" disabled={busy} onClick={() => save(null)}
            className="font-mono text-xs text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">
            back to standard
          </button>
        )}
      </div>
      <p className="text-xs text-slate-ink">
        {p.rate_override === null
          ? `On the standard ${p.standard_rate === null ? 'rate' : pct(p.standard_rate)} for this product.`
          : `Agreed rate. The standard for this product is ${p.standard_rate === null ? 'nothing' : pct(p.standard_rate)}.`}
        {' '}Credited daily, and the client is told when it changes.
      </p>
    </form>
  );
}

function NewPortfolio({ types, currencies, on, onDone }: {
  types: PortfolioType[]; currencies: Currency[]; on: On; onDone: () => void;
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
          ...on,
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
      {chosen && <p className="text-xs text-slate-ink">{chosen.description}</p>}
      <div className="flex flex-wrap gap-2">
        <input name="name" required maxLength={80} placeholder="Name it, e.g. Retirement 2055"
          className={`${field} flex-1`} />
        <select name="currency" className={`${field} w-28`} defaultValue="USD">
          {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="text-xs text-slate-ink">Target amount (optional)
          <input name="target_amount" type="number" step="any" min="0" className={field} /></label>
        <label className="text-xs text-slate-ink">Target date (optional)
          <input name="target_date" type="date" className={field} /></label>
      </div>
      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
      <button className={btn} disabled={busy}>{busy ? 'Opening…' : 'Open portfolio'}</button>
    </form>
  );
}
