import { useState } from 'react';
import { alertBox, btn, card, field } from './App.tsx';
import { api, useApi } from './api.ts';

/**
 * Staking: locking crypto for a term and earning a yield in the same asset.
 *
 * The same panel serves both sides, the way the portfolio one does. A client passes no
 * clientId and acts on themselves; the desk passes one and acts on that client, which the
 * API makes them name on every write. One component rather than a staff copy — two
 * versions of a screen that moves somebody's crypto is two places for the rules to drift.
 */

type Product = {
  code: string; name: string; asset: string; description: string;
  apy: number; lock_days: number; min_amount: number;
};
type Stake = {
  id: string; product_code: string; product_name: string; description: string;
  asset: string; amount: number; rewards: number; apy: number; product_apy: number;
  apy_override: number | null; status: string; staked_at: string;
  unlocks_at: string | null; lock_days: number; locked: boolean;
  usd_value: number | null; projected_year: number;
};

const pct = (n: number) => `${Number((n * 100).toFixed(2))}%`;
const num = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });
const day = (d: string) => new Date(d).toLocaleDateString();
const term = (days: number) => (days === 0 ? 'Flexible' : `${days} days`);

type On = { client_id?: string };

export function StakingPanel({ clientId, onChanged }: { clientId?: string; onChanged?: () => void } = {}) {
  const on: On = clientId ? { client_id: clientId } : {};
  const stakes = useApi<Stake[]>(clientId ? `/stakes?client_id=${clientId}` : '/stakes');
  const products = useApi<Product[]>('/staking-products');
  const [adding, setAdding] = useState(false);

  const reload = () => { stakes.reload(); onChanged?.(); };
  const active = stakes.data?.filter((s) => s.status === 'active') ?? [];
  const closed = stakes.data?.filter((s) => s.status !== 'active') ?? [];

  return (
    <div className="stagger space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="metric-label">{clientId ? 'Staking' : 'Your staking'}</h3>
        <button className={`${btn} ml-auto`} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Stake crypto'}
        </button>
      </div>

      {adding && (
        <NewStake products={products.data ?? []} on={on}
          onDone={() => { setAdding(false); reload(); }} />
      )}

      {active.map((s) => <StakeCard key={s.id} s={s} on={on} onDone={reload} />)}
      {!active.length && !adding && (
        <p className="text-sm text-slate-ink">
          {clientId
            ? 'Nothing staked. Staking here does it on the client’s behalf, and is recorded that way.'
            : 'Nothing staked yet. Put crypto you are not trading to work and it earns daily.'}
        </p>
      )}

      {!!closed.length && (
        <details className="text-sm text-slate-ink">
          <summary className="cursor-pointer">{closed.length} closed</summary>
          <ul className="mt-1 space-y-1">
            {closed.map((s) => (
              <li key={s.id}>{s.product_name} — staked {day(s.staked_at)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function StakeCard({ s, on, onDone }: { s: Stake; on: On; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [rate, setRate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unstake() {
    setBusy(true);
    setError(null);
    try {
      await api(`/stakes/${s.id}/unstake`, { method: 'POST', body: JSON.stringify({ ...on }) });
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function unlock() {
    setError(null);
    try {
      await api(`/stakes/${s.id}`, { method: 'PATCH', body: JSON.stringify({ ...on, unlock_now: true }) });
      onDone();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="rounded-lg border border-pebble bg-bone/50 p-4 dark:border-white/10 dark:bg-white/5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-ember/15 font-mono text-xs font-medium text-ember-ink">
          {s.asset}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{s.product_name}</span>
          <span className="block text-xs text-slate-ink">
            {term(s.lock_days)}
            {s.unlocks_at && ` · ${s.locked ? 'unlocks' : 'unlocked'} ${day(s.unlocks_at)}`}
          </span>
        </span>

        <span className="ml-auto flex items-center gap-6">
          <span className="text-right">
            <span className="metric-label block">Rate</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums text-ember-ink">
              {pct(s.apy)}
            </span>
            {s.apy_override !== null && (
              <span className="block font-mono text-[10px] tracking-wide text-slate-ink uppercase">agreed</span>
            )}
          </span>
          <span className="text-right">
            <span className="metric-label block">Staked</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums">
              {num(s.amount)} {s.asset}
            </span>
          </span>
        </span>
      </div>

      <p className="mt-2 text-xs text-slate-ink">
        Earned so far <span className="font-mono text-up">{num(s.rewards)} {s.asset}</span>
        {' · '}a year at this rate pays about {num(s.projected_year)} {s.asset}, credited daily.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button onClick={unstake} disabled={busy || s.locked}
          className="rounded-md border border-pebble px-2.5 py-1 text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:text-vellum"
          title={s.locked ? 'Locked until its date' : undefined}>
          {busy ? 'Unstaking…' : 'Unstake'}
        </button>
        {s.locked && !on.client_id && (
          <span className="text-slate-ink">Locked until {day(s.unlocks_at!)}.</span>
        )}
        {on.client_id && (
          <>
            {s.locked && (
              <button onClick={unlock}
                className="rounded-md border border-pebble px-2.5 py-1 text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
                Release lock
              </button>
            )}
            <button onClick={() => { setRate((v) => !v); setError(null); }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${rate
                ? 'border border-ember text-ember-ink hover:bg-ember/10'
                : 'bg-ember text-graphite hover:brightness-110'}`}>
              {rate ? 'Close' : 'Change rate'}
            </button>
          </>
        )}
      </div>

      {rate && on.client_id && (
        <SetRate s={s} on={on} onDone={() => { setRate(false); onDone(); }} onError={setError} />
      )}
      {error && <p role="alert" className={`${alertBox} mt-2`}>{error}</p>}
    </div>
  );
}

/** The rate this one stake pays, as agreed with this one client. */
function SetRate({ s, on, onDone, onError }: {
  s: Stake; on: On; onDone: () => void; onError: (m: string | null) => void;
}) {
  const asPercent = (n: number | null) => (n === null ? '' : String(Number((n * 100).toFixed(4))));
  const [value, setValue] = useState(asPercent(s.apy_override));
  const [busy, setBusy] = useState(false);

  async function save(next: number | null) {
    setBusy(true);
    onError(null);
    try {
      await api(`/stakes/${s.id}`, {
        method: 'PATCH', body: JSON.stringify({ ...on, apy_override: next }),
      });
      onDone();
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form className="mt-3 space-y-2 rounded-md border border-ember/40 p-3"
      onSubmit={(e) => { e.preventDefault(); save(value === '' ? null : Number(value) / 100); }}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-ink">
          Rate
          <span className="mt-1 flex items-center gap-1">
            <input className={`${field} w-24`} type="number" step="0.01" min="0" max="100" autoFocus
              placeholder={asPercent(s.product_apy)}
              value={value} onChange={(e) => setValue(e.target.value)} />
            <span className="font-mono text-xs">% a year</span>
          </span>
        </label>
        <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Set rate'}</button>
        {s.apy_override !== null && (
          <button type="button" disabled={busy} onClick={() => save(null)}
            className="font-mono text-xs text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">
            back to standard
          </button>
        )}
      </div>
      <p className="text-xs text-slate-ink">
        {s.apy_override === null
          ? `On the standard ${pct(s.product_apy)} for this product.`
          : `Agreed rate. The standard for this product is ${pct(s.product_apy)}.`}
        {' '}Credited daily, and the client is told when it changes.
      </p>
    </form>
  );
}

/**
 * Picking a product and an amount.
 *
 * The rate leads on each card because it is what the choice turns on, and the lock sits
 * next to it because it is what the rate costs — showing one without the other would be
 * selling the yield and hiding the term.
 */
function NewStake({ products, on, onDone }: { products: Product[]; on: On; onDone: () => void }) {
  const [code, setCode] = useState(products[0]?.code ?? '');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = products.find((p) => p.code === code);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/stakes', {
        method: 'POST',
        body: JSON.stringify({ ...on, product_code: code, amount: Number(amount) }),
      });
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-4`}>
      <div>
        <h3 className="metric-label">Choose a product</h3>
        <div role="radiogroup" aria-label="Staking product"
          className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {products.map((p) => {
            const active = p.code === code;
            return (
              <label key={p.code}
                className={`flex aspect-square cursor-pointer flex-col justify-between rounded-lg border p-3 transition-colors ${active
                  ? 'border-ember bg-ember/10'
                  : 'border-pebble hover:border-ember/50 dark:border-white/10'}`}>
                <input type="radio" name="product" value={p.code} checked={active} className="sr-only"
                  onChange={() => setCode(p.code)} />
                <span className="flex items-center justify-between">
                  <span className="rounded-md bg-ember/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-ember-ink">
                    {p.asset}
                  </span>
                  <span className="font-mono text-[10px] tracking-wide text-slate-ink uppercase">
                    {term(p.lock_days)}
                  </span>
                </span>
                <span>
                  <span className="block font-mono text-2xl leading-none font-medium tabular-nums text-ember-ink">
                    {pct(p.apy)}
                  </span>
                  <span className="metric-label mt-0.5 block">a year</span>
                </span>
                <span className="text-xs leading-tight font-medium text-obsidian dark:text-vellum">
                  {p.name}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {chosen && (
        <p className="text-xs text-slate-ink">
          {chosen.description}
          {chosen.lock_days > 0 && ` Locked for ${chosen.lock_days} days — it cannot be taken back before then.`}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-ink">
          Amount
          <span className="mt-1 flex items-center gap-1">
            <input className={`${field} w-40`} type="number" step="any" min="0" required
              placeholder={chosen ? String(chosen.min_amount) : '0'}
              value={amount} onChange={(e) => setAmount(e.target.value)} />
            <span className="font-mono text-xs">{chosen?.asset}</span>
          </span>
        </label>
        <button className={btn} disabled={busy || !chosen}>{busy ? 'Staking…' : 'Stake'}</button>
      </div>
      {chosen && (
        <p className="text-xs text-slate-ink">
          Minimum {num(chosen.min_amount)} {chosen.asset}. Comes out of the {chosen.asset} wallet
          and goes back into it when unstaked, with what it earned.
        </p>
      )}
      {error && <p role="alert" className={alertBox}>{error}</p>}
    </form>
  );
}
