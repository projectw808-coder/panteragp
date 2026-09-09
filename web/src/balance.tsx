import { useEffect } from 'react';
import { useApi } from './api.ts';

/**
 * What the client has, wherever they are in the app.
 *
 * One chip per currency they actually hold and the USD total on the right — the same shape
 * and the same sum the staff see on the client record, so the two sides never disagree
 * about what somebody has. Cash, crypto wallets and savings pots are three tables but one
 * balance sheet: a currency held in two of them is one chip, not two that look like a bug.
 *
 * A currency with no price source is named rather than dropped, because a total that
 * quietly leaves something out is worse than one that says what it could not value.
 */

type Held = { balance: number; usd_value: number | null };
export type Accounts = {
  cash: (Held & { id: string; currency: string; mode: string; leverage: number })[];
  wallets: (Held & { id: string; asset: string; address: string })[];
  portfolios: (Held & { id: string; name: string; currency: string })[];
  total_usd: number;
  unpriced: string[];
};

const usd = (n: number) =>
  '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amount = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });

export function held(a: Accounts) {
  const by = new Map<string, number>();
  const add = (code: string, n: number) => by.set(code, (by.get(code) ?? 0) + Number(n));
  for (const x of a.cash) add(x.currency, x.balance);
  for (const x of a.wallets) add(x.asset, x.balance);
  for (const x of a.portfolios) add(x.currency, x.balance);
  return [...by].filter(([, n]) => n !== 0).sort((x, y) => x[0].localeCompare(y[0]));
}

/**
 * The strip across the top of the client's app. Polls rather than listening: the engine
 * fills orders and the desk credits accounts between requests, and a balance that only
 * updates when you happen to reload is a balance nobody trusts.
 */
export function BalanceBar() {
  const accounts = useApi<Accounts>('/accounts');
  // The engine fills orders and the desk credits accounts between requests, so a balance
  // that only moves when you happen to reload is a balance nobody trusts. Same cadence as
  // the dashboard, for the same reason: current enough to believe, not a live ticker.
  const { reload } = accounts;
  useEffect(() => {
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [reload]);

  const a = accounts.data;
  if (!a) return null;
  const rows = held(a);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-pebble bg-bone px-4 py-2.5 dark:border-white/10 dark:bg-white/5">
      <span className="metric-label">Balance</span>
      {rows.length === 0
        ? <span className="text-sm text-slate-ink">Nothing yet.</span>
        : rows.map(([code, n]) => (
          <span key={code} className="flex items-baseline gap-1.5">
            <span className="font-mono text-[10px] tracking-[0.12em] text-slate-ink uppercase">{code}</span>
            <span className="font-mono text-sm font-medium tabular-nums">{amount(n)}</span>
          </span>
        ))}
      <span className="ml-auto flex items-baseline gap-2">
        <span className="font-mono text-[10px] tracking-[0.12em] text-slate-ink uppercase">Total</span>
        <span className="font-mono text-base font-medium tabular-nums text-ember">{usd(a.total_usd)}</span>
      </span>
    </div>
  );
}

/** The same figures with room to breathe, for the profile page. */
export function BalancePanel() {
  const accounts = useApi<Accounts>('/accounts');
  const a = accounts.data;
  if (!a) return null;
  const rows = held(a);

  return (
    <>
      <dl className="flex flex-wrap items-center gap-x-8 gap-y-3">
        {rows.length === 0
          ? <div className="text-sm text-slate-ink">No balances yet. The desk funds your account.</div>
          : rows.map(([code, n]) => (
            <div key={code}>
              <dt className="metric-label">{code}</dt>
              <dd className="font-mono text-sm font-medium tabular-nums">{amount(n)}</dd>
            </div>
          ))}
        <div className="ml-auto text-right">
          <dt className="metric-label">Total</dt>
          <dd className="font-mono text-xl font-medium tabular-nums text-ember">{usd(a.total_usd)}</dd>
        </div>
      </dl>
      {!!a.unpriced.length && (
        <p className="text-xs text-slate-ink">
          Total excludes {a.unpriced.join(', ')} — no price source for it.
        </p>
      )}
    </>
  );
}
