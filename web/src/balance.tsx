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
type Cash = { kind: string; amount: number; status: string };
type Account = { balance: number; equity: number; unrealized: number; currency: string };

export type Accounts = {
  cash: (Held & { id: string; currency: string; mode: string; leverage: number })[];
  wallets: (Held & { id: string; asset: string; address: string })[];
  portfolios: (Held & { id: string; name: string; currency: string; featured: boolean })[];
  stakes: (Held & { id: string; name: string; currency: string })[];
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
  for (const x of a.stakes ?? []) add(x.currency, x.balance);
  return [...by].filter(([, n]) => n !== 0).sort((x, y) => x[0].localeCompare(y[0]));
}

/**
 * The strip across the top of the client's app. Polls rather than listening: the engine
 * fills orders and the desk credits accounts between requests, and a balance that only
 * updates when you happen to reload is a balance nobody trusts.
 */
/** The pot the client asked to keep an eye on, if they have picked one. */
const featured = (a: Accounts) => a.portfolios.find((p) => p.featured) ?? null;

/** What is locked in staking, per asset, for the strip's own line. */
function staked(a: Accounts) {
  const by = new Map<string, number>();
  for (const s of a.stakes ?? []) by.set(s.currency, (by.get(s.currency) ?? 0) + Number(s.balance));
  return [...by].filter(([, n]) => n !== 0).sort((x, y) => x[0].localeCompare(y[0]));
}

export function BalanceBar() {
  const accounts = useApi<Accounts>('/accounts');
  const account = useApi<Account>('/account');
  const cash = useApi<Cash[]>('/cash');
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
  const deposits = (cash.data ?? [])
    .filter((t) => t.kind === 'deposit' && (t.status === 'approved' || t.status === 'settled'))
    .reduce((n, t) => n + Number(t.amount), 0);
  const open = Number(account.data?.unrealized ?? 0);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-pebble bg-bone px-4 py-2.5 dark:border-white/10 dark:bg-white/5">
      <span className="metric-label">Balance</span>
      {rows.length === 0
        ? <span className="text-sm text-slate-ink">Nothing yet.</span>
        : rows.map(([code, n]) => (
          <span key={code} className="flex items-baseline gap-1.5">
            <span className="bal-label">{code}</span>
            <span className="bal-value">{amount(n)}</span>
          </span>
        ))}
      {!!staked(a).length && (
        <span className="flex items-baseline gap-1.5">
          <span className="bal-label">Staked</span>
          <span className="bal-value text-up">
            {staked(a).map(([code, n]) => `${amount(n)} ${code}`).join(' · ')}
          </span>
        </span>
      )}

      {featured(a) && (
        <span className="flex items-baseline gap-1.5">
          <span className="max-w-40 truncate bal-label">
            {featured(a)!.name}
          </span>
          <span className="bal-value">
            {amount(featured(a)!.balance)} {featured(a)!.currency}
          </span>
        </span>
      )}

      {/* Deposits come from settled cash in rather than from the balance: the balance has
          trading in it, and somebody who paid in 10,000 and is down 2,000 has still paid
          in 10,000. */}
      <span className="ml-auto flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <span className="flex items-baseline gap-1.5">
          <span className="bal-label">Deposits</span>
          <span className="bal-value">{usd(deposits)}</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="bal-label">Open P&amp;L</span>
          <span className={`bal-value ${
            open < 0 ? 'text-down' : 'text-up'}`}>
            {open >= 0 ? '+' : ''}{usd(open)}
          </span>
        </span>
        <span className="flex items-baseline gap-2">
          <span className="bal-label">Total</span>
          <span className="bal-value bal-total">{usd(a.total_usd)}</span>
        </span>
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
              <dd className="bal-value">{amount(n)}</dd>
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
