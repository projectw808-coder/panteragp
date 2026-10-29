import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Clock, Coins, History, Lock, LockOpen, Sparkles, TrendingUp, Wallet } from 'lucide-react';
import { alertBox, btn, field, PageTitle } from './App.tsx';
import { Coin } from './landing.tsx';
import { api, useApi } from './api.ts';
import { useCountUp } from './count-up.ts';
import { StatTile } from './x-shell.tsx';
import type { Accounts } from './balance.tsx';

/**
 * Staking: locking crypto for a term and earning a yield in the same asset.
 *
 * The same panel serves both sides, the way the portfolio one does. A client passes no
 * clientId and acts on themselves; the desk passes one and acts on that client, which the
 * API makes them name on every write. One component rather than a staff copy — two
 * versions of a screen that moves somebody's crypto is two places for the rules to drift.
 *
 * Rates are not quoted to clients anywhere on this page: the projection on each stake is
 * the server's own figure for that stake, and the rate controls are the desk's alone.
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
  usd_value: number | null; projected_year: number; closed_at?: string | null;
};

const pct = (n: number) => `${Number((n * 100).toFixed(2))}%`;
const num = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 });
const day = (d: string | Date) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const term = (days: number) => (days === 0 ? 'Flexible' : `${days} days`);
const usd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const daysLeft = (s: Stake) => s.unlocks_at ? Math.max(0, Math.ceil((new Date(s.unlocks_at).getTime() - Date.now()) / 86_400_000)) : 0;
/** The asset's dollar price, where the stake could be priced at all. */
const priceOf = (s: Stake) => (s.usd_value !== null && Number(s.amount) > 0 ? Number(s.usd_value) / Number(s.amount) : null);

/** The asset's own mark: the platform's coin where it has one, a branded disc otherwise. */
function Token({ asset, size = 36 }: { asset: string; size?: number }) {
  const scale = size / 36;
  const own: Record<string, [string, string]> = { USDT: ['#26a17b', '₮'], USDC: ['#2775ca', '$'], DAI: ['#f5ac37', '◈'] };
  const mark = own[asset];
  return (
    <span className="sk-token" style={{ width: size, height: size }}>
      {mark
        ? <span className="grid h-full w-full place-items-center rounded-full font-bold text-white" style={{ background: mark[0], fontSize: 18 * scale }}>{mark[1]}</span>
        : <span style={{ transform: `scale(${scale})` }}><Coin symbol={`${asset}USD`} /></span>}
    </span>
  );
}

type On = { client_id?: string };

export function StakingPanel({ clientId, onChanged }: { clientId?: string; onChanged?: () => void } = {}) {
  const on: On = clientId ? { client_id: clientId } : {};
  const stakes = useApi<Stake[]>(clientId ? `/stakes?client_id=${clientId}` : '/stakes');
  const products = useApi<Product[]>('/staking-products');
  // What the client can stake from. Only on their own page: the desk acting on a client
  // sees the client's wallets in the record, and the API refuses an amount that is not there.
  const accounts = useApi<Accounts>(clientId ? null : '/accounts');
  const composer = useRef<HTMLDivElement>(null);

  const reload = () => { stakes.reload(); accounts.reload(); onChanged?.(); };
  const active = stakes.data?.filter((s) => s.status === 'active') ?? [];
  const closed = stakes.data?.filter((s) => s.status !== 'active') ?? [];
  const wallets = Object.fromEntries((accounts.data?.wallets ?? []).map((w) => [w.asset, Number(w.balance)]));

  const startStake = () => {
    composer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    composer.current?.querySelector<HTMLButtonElement>('[role=radio][aria-checked=true]')?.focus({ preventScroll: true });
  };

  return (
    <div className="stagger space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {clientId ? <h3 className="section-title">Staking</h3> : <PageTitle>Staking</PageTitle>}
        <span className="x-badge"><Sparkles size={13} className="mr-1.5" aria-hidden />Earnings credited daily</span>
        <button type="button" onClick={startStake} className={`${btn} ml-auto inline-flex items-center gap-2`}>
          <Coins size={16} aria-hidden />Start a stake
        </button>
      </div>

      <Totals stakes={active} loading={!stakes.data} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <section className="x-card x-holo space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="section-title">{clientId ? 'Their stakes' : 'Your stakes'}</h2>
              {!!active.length && <span className="x-badge is-muted">{active.length} active</span>}
            </div>
            {!stakes.data && <div className="skeleton h-32 rounded-lg" />}
            {stakes.data && !active.length && (
              <div className="grid place-items-center gap-2 py-10 text-center">
                <span className="x-drop-icon" aria-hidden><Coins size={24} /></span>
                <p className="text-[15px] font-semibold">{closed.length ? 'Nothing staked right now' : 'Nothing staked yet'}</p>
                <p className="max-w-sm text-xs text-slate-ink">
                  {clientId
                    ? 'Staking here does it on the client’s behalf, and is recorded that way.'
                    : 'Put crypto you are not trading to work. It earns every day, paid in the same asset.'}
                </p>
                <button type="button" className="x-btn-sm mt-2" onClick={startStake}>Start a stake</button>
              </div>
            )}
            <div className="grid gap-3">
              {active.map((s) => <StakeCard key={s.id} s={s} on={on} onDone={reload} />)}
            </div>
          </section>

          {!!closed.length && <Closed stakes={closed} />}
        </div>

        <div ref={composer} className="min-w-0 scroll-mt-24 xl:sticky xl:top-20 xl:self-start">
          {products.data && <NewStake products={products.data} on={on} wallets={clientId ? null : wallets} onDone={reload} />}
          {!products.data && <div className="x-card skeleton h-96" />}
        </div>
      </div>
    </div>
  );
}

/**
 * What the whole position comes to.
 *
 * Rewards are paid in the asset, so turning them into dollars needs the asset's price —
 * usd_value / amount, which exists only where the stake could be priced at all. One that
 * could not is named in the note rather than quietly dropped.
 */
function Totals({ stakes, loading }: { stakes: Stake[]; loading: boolean }) {
  const priced = stakes.filter((s) => priceOf(s) !== null);
  const unpriced = stakes.length - priced.length;
  const staked = priced.reduce((n, s) => n + Number(s.usd_value), 0);
  const earned = priced.reduce((n, s) => n + Number(s.rewards) * priceOf(s)!, 0);
  const perDay = priced.reduce((n, s) => n + (Number(s.projected_year) / 365) * priceOf(s)!, 0);
  const next = stakes.filter((s) => s.locked && s.unlocks_at)
    .sort((a, b) => new Date(a.unlocks_at!).getTime() - new Date(b.unlocks_at!).getTime())[0];

  const shownStaked = useCountUp(loading ? null : staked);
  const shownEarned = useCountUp(loading ? null : earned);
  const skel = <span className="skeleton inline-block h-5 w-28" />;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile label="Staked" Icon={Wallet} value={shownStaked === null ? skel : usd(shownStaked)}
        note={unpriced ? `${unpriced} not priced` : `Across ${stakes.length} stake${stakes.length === 1 ? '' : 's'}`} />
      <StatTile label="Earned so far" Icon={TrendingUp} tone="text-up" value={shownEarned === null ? skel : usd(shownEarned)}
        note="Paid in the asset you staked" />
      <StatTile label="Earning per day" Icon={Sparkles} value={loading ? skel : `≈ ${usd(perDay)}`}
        note="At today’s prices, credited daily" />
      <StatTile label="Next unlock" Icon={CalendarClock}
        value={loading ? skel : next ? `${daysLeft(next)} day${daysLeft(next) === 1 ? '' : 's'}` : 'None locked'}
        note={next ? `${next.product_name} · ${day(next.unlocks_at!)}` : 'Everything can be unstaked now'} />
    </div>
  );
}

function StakeCard({ s, on, onDone }: { s: Stake; on: On; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [rate, setRate] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = priceOf(s);
  const perDay = Number(s.projected_year) / 365;

  async function unstake() {
    setBusy(true);
    setError(null);
    try {
      await api(`/stakes/${s.id}/unstake`, { method: 'POST', body: JSON.stringify({ ...on }) });
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); setConfirm(false); }
  }

  async function unlock() {
    setError(null);
    try {
      await api(`/stakes/${s.id}`, { method: 'PATCH', body: JSON.stringify({ ...on, unlock_now: true }) });
      onDone();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <article className={`sk-card ${s.locked ? 'is-locked' : ''}`}>
      <div className="flex items-start gap-3">
        <Token asset={s.asset} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{s.product_name}</p>
          <p className="text-xs text-slate-ink">Staked {day(s.staked_at)}</p>
        </div>
        <span className={`x-badge ${s.locked ? 'is-locked' : ''}`}>
          {s.locked ? <Lock size={12} className="mr-1" aria-hidden /> : <LockOpen size={12} className="mr-1" aria-hidden />}
          {s.locked ? 'Locked' : s.lock_days ? 'Unlocked' : 'Flexible'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini label="Staked" value={`${num(s.amount)} ${s.asset}`} sub={price !== null ? usd(Number(s.usd_value)) : undefined} lead />
        <Mini label="Earned" value={`${num(s.rewards)} ${s.asset}`} sub={price !== null ? usd(Number(s.rewards) * price) : undefined} tone="text-up" />
        <Mini label="Per day" value={`≈ ${num(Number(perDay.toPrecision(3)))}`} sub={s.asset} />
        <Mini label="Over a year" value={`≈ ${num(Number(Number(s.projected_year).toPrecision(4)))}`} sub={s.asset} />
      </div>

      <Track s={s} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {confirm ? (
          <>
            <span className="text-xs text-slate-ink">
              {num(Number(s.amount) + Number(s.rewards))} {s.asset} goes back to the {s.asset} wallet.
            </span>
            <button type="button" onClick={unstake} disabled={busy} className={`${btn} !py-1.5 text-xs`}>
              {busy ? 'Unstaking…' : 'Confirm unstake'}
            </button>
            <button type="button" onClick={() => setConfirm(false)} className="x-btn-sm">Keep it</button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirm(true)} disabled={s.locked}
            className="x-btn-sm inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            title={s.locked ? `Locked until ${day(s.unlocks_at!)}` : undefined}>
            <LockOpen size={13} aria-hidden />Unstake
          </button>
        )}
        {on.client_id && !confirm && (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {s.locked && <button type="button" onClick={unlock} className="x-btn-sm">Release lock</button>}
            <button type="button" onClick={() => { setRate((v) => !v); setError(null); }} className="x-btn-sm">
              {rate ? 'Close' : `Rate · ${pct(s.apy)}`}
            </button>
          </span>
        )}
      </div>

      {rate && on.client_id && (
        <SetRate s={s} on={on} onDone={() => { setRate(false); onDone(); }} onError={setError} />
      )}
      {error && <p role="alert" className={`${alertBox} mt-3`}>{error}</p>}
    </article>
  );
}

const Mini = ({ label, value, sub, tone = '', lead }: { label: string; value: string; sub?: string; tone?: string; lead?: boolean }) => (
  <div className={`x-mini-tile min-w-0 ${lead ? 'sk-lead' : ''}`}>
    <p className="text-[11.5px] text-mist">{label}</p>
    <p className={`mt-1 truncate text-[14px] font-semibold tabular-nums ${tone}`} title={value}>{value}</p>
    {sub && <p className="truncate text-[11px] text-slate-ink tabular-nums">{sub}</p>}
  </div>
);

/**
 * Where a stake is in its term: a track from the day it was staked to the day it unlocks,
 * filled to today. A flexible stake has no term, so it gets a plain line saying so rather
 * than a bar sitting at zero.
 */
function Track({ s }: { s: Stake }) {
  if (!s.unlocks_at || !s.lock_days) {
    return (
      <p className="mt-4 flex items-center gap-1.5 text-xs text-slate-ink">
        <Clock size={13} aria-hidden />No lock — unstake whenever you like.
      </p>
    );
  }
  const start = new Date(s.staked_at).getTime();
  const end = new Date(s.unlocks_at).getTime();
  const done = end > start ? Math.min(1, Math.max(0, (Date.now() - start) / (end - start))) : 1;
  const left = daysLeft(s);

  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between text-[11.5px] text-slate-ink">
        <span>{day(s.staked_at)}</span>
        <span className={s.locked ? 'font-semibold text-ember-ink' : 'font-semibold text-up'}>
          {s.locked ? `${left} day${left === 1 ? '' : 's'} left · ${Math.round(done * 100)}%` : 'Term complete'}
        </span>
        <span>{day(s.unlocks_at)}</span>
      </div>
      <div className="sk-track mt-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(done * 100)}
        aria-label={`${s.product_name}: ${Math.round(done * 100)}% of the term served`}>
        <span style={{ width: `${Math.max(2, done * 100)}%` }} />
      </div>
    </div>
  );
}

/** The rate this one stake pays, as agreed with this one client. Desk only. */
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
    <form className="mt-3 space-y-2 rounded-lg border border-ember/40 p-3"
      onSubmit={(e) => { e.preventDefault(); save(value === '' ? null : Number(value) / 100); }}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-ink">
          Rate
          <span className="mt-1 flex items-center gap-1">
            <input className={`${field} w-24`} type="number" step="0.01" min="0" max="100" autoFocus
              placeholder={asPercent(s.product_apy)}
              value={value} onChange={(e) => setValue(e.target.value)} />
            <span className="text-xs">% a year</span>
          </span>
        </label>
        <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Set rate'}</button>
        {s.apy_override !== null && (
          <button type="button" disabled={busy} onClick={() => save(null)} className="x-btn-sm">Back to standard</button>
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
 * Starting a stake, in the order the decision is made: which asset, for how long, how much.
 *
 * The term is what the choice turns on, so each option says what it costs — the date the
 * stake unlocks — rather than a rate. The amount offers the wallet's balance where it is
 * known, and the button names exactly what will happen.
 */
function NewStake({ products, on, wallets, onDone }: {
  products: Product[]; on: On; wallets: Record<string, number> | null; onDone: () => void;
}) {
  const assets = useMemo(() => {
    const seen = [...new Set(products.map((p) => p.asset))];
    // What the client holds first, so the first thing offered is something they can stake.
    return wallets ? seen.sort((a, b) => Number((wallets[b] ?? 0) > 0) - Number((wallets[a] ?? 0) > 0)) : seen;
  }, [products, wallets]);
  const [asset, setAsset] = useState(assets[0] ?? '');
  const terms = products.filter((p) => p.asset === asset).sort((a, b) => a.lock_days - b.lock_days);
  const [code, setCode] = useState('');
  const chosen = terms.find((p) => p.code === code) ?? terms[0];
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => { if (!assets.includes(asset) && assets[0]) setAsset(assets[0]); }, [assets, asset]);

  const available = wallets ? wallets[asset] ?? 0 : null;
  const n = Number(amount);
  const tooSmall = !!amount && chosen && n < Number(chosen.min_amount);
  const tooBig = !!amount && available !== null && n > available;
  const unlocks = chosen && chosen.lock_days ? new Date(Date.now() + chosen.lock_days * 86_400_000) : null;

  function pick(a: string) { setAsset(a); setCode(''); setAmount(''); setError(null); setDone(null); }
  function share(f: number) {
    if (available === null) return;
    const v = f === 1 ? available : Math.floor(available * f * 1e8) / 1e8;
    setAmount(String(v));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api('/stakes', { method: 'POST', body: JSON.stringify({ ...on, product_code: chosen.code, amount: n }) });
      setDone(`${num(n)} ${chosen.asset} staked in ${chosen.name}.`);
      setAmount('');
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="x-card x-holo space-y-5 p-5">
      <div>
        <h2 className="section-title">Start a stake</h2>
        <p className="mt-1 text-xs text-slate-ink">
          {on.client_id
            ? 'Staked from the client’s wallet on their behalf, and recorded that way. It goes back, with what it earned, when unstaked.'
            : 'It comes out of your wallet and goes back into it, with what it earned, when you unstake.'}
        </p>
      </div>

      <Step n={1} label="Asset">
        <div role="radiogroup" aria-label="Asset" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {assets.map((a) => {
            const isOn = a === asset;
            const held = wallets ? wallets[a] ?? 0 : null;
            return (
              <button key={a} type="button" role="radio" aria-checked={isOn} onClick={() => pick(a)}
                className={`sk-opt ${isOn ? 'is-on' : ''}`}>
                <Token asset={a} size={28} />
                <span className="min-w-0 text-left">
                  <span className="block text-[13px] font-semibold">{a}</span>
                  {held !== null && <span className="block truncate text-[11px] text-slate-ink tabular-nums">{held > 0 ? num(held) : 'None held'}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </Step>

      <Step n={2} label="Term">
        <div role="radiogroup" aria-label="Term" className="grid grid-cols-2 gap-2">
          {terms.map((p) => {
            const isOn = p.code === chosen?.code;
            const until = p.lock_days ? new Date(Date.now() + p.lock_days * 86_400_000) : null;
            return (
              <button key={p.code} type="button" role="radio" aria-checked={isOn} onClick={() => { setCode(p.code); setError(null); }}
                className={`sk-opt is-term ${isOn ? 'is-on' : ''}`}>
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold">{term(p.lock_days)}</span>
                  {p.lock_days ? <Lock size={13} className="text-mist" aria-hidden /> : <LockOpen size={13} className="text-up" aria-hidden />}
                </span>
                <span className="block text-left text-[11px] text-slate-ink">{until ? `Unlocks ${day(until)}` : 'Unstake any time'}</span>
              </button>
            );
          })}
        </div>
      </Step>

      <Step n={3} label="Amount" aside={available !== null && <span className="text-[11.5px] text-slate-ink">Available <span className="font-semibold text-obsidian dark:text-vellum tabular-nums">{num(available)} {asset}</span></span>}>
        <div className="sk-amount">
          <input className={`${field} w-full`} type="number" step="any" min="0" required inputMode="decimal"
            placeholder={chosen ? `From ${num(chosen.min_amount)}` : '0'} aria-label={`Amount in ${asset}`}
            value={amount} onChange={(e) => { setAmount(e.target.value); setDone(null); }} />
          <span className="sk-amount-unit">{asset}</span>
        </div>
        {available !== null && available > 0 && (
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <button key={f} type="button" onClick={() => share(f)} className="x-btn-sm !h-7 !px-0 text-[11.5px]">{f === 1 ? 'Max' : `${f * 100}%`}</button>
            ))}
          </div>
        )}
        {tooSmall && <p className="mt-2 text-xs text-down">The minimum for this term is {num(chosen!.min_amount)} {asset}.</p>}
        {tooBig && <p className="mt-2 text-xs text-down">That is more than the {num(available!)} {asset} in your wallet.</p>}
        {available === 0 && (
          <p className="mt-2 text-xs text-slate-ink">
            You hold no {asset}. <a href="#/wallet" className="text-ember-ink hover:underline">Open your wallet</a> to add some.
          </p>
        )}
      </Step>

      {chosen && (
        <div className="sk-summary">
          <p>
            {n > 0 ? <b className="tabular-nums">{num(n)} {asset}</b> : <>Your {asset}</>}
            {chosen.lock_days
              ? <> is locked for {chosen.lock_days} days and unlocks on <b>{day(unlocks!)}</b>.</>
              : <> stays flexible — you can unstake it whenever you like.</>}
            {' '}Earnings are credited daily, in {asset}.
          </p>
          {chosen.lock_days > 0 && <p className="mt-1 text-[11.5px] text-slate-ink">It cannot be taken back before that date.</p>}
        </div>
      )}

      {error && <p role="alert" className={alertBox}>{error}</p>}
      {done && <p role="status" className="text-xs text-up">{done}</p>}
      <button className={`${btn} w-full`} disabled={busy || !chosen || !(n > 0) || !!tooSmall || !!tooBig}>
        {busy ? 'Staking…' : n > 0 ? `Stake ${num(n)} ${asset}` : 'Enter an amount'}
      </button>
    </form>
  );
}

const Step = ({ n, label, aside, children }: { n: number; label: string; aside?: React.ReactNode; children: React.ReactNode }) => (
  <fieldset>
    <legend className="mb-2 flex w-full items-center gap-2">
      <span className="sk-step">{n}</span>
      <span className="text-[13px] font-semibold">{label}</span>
      {aside && <span className="ml-auto">{aside}</span>}
    </legend>
    {children}
  </fieldset>
);

/**
 * Stakes that have ended, newest first, as a record rather than a footnote. Closing pays
 * the stake and its earnings back into the wallet and zeroes the row, so what is left to
 * show is when it ran and on what term — the wallet history holds the amounts.
 */
function Closed({ stakes }: { stakes: Stake[] }) {
  const [open, setOpen] = useState(false);
  const rows = [...stakes].sort((a, b) => new Date(b.closed_at ?? b.staked_at).getTime() - new Date(a.closed_at ?? a.staked_at).getTime());
  const shown = open ? rows : rows.slice(0, 3);
  return (
    <section className="x-card x-holo space-y-3 p-5">
      <div className="flex items-center gap-3">
        <span className="x-chip" aria-hidden><History size={17} /></span>
        <h2 className="section-title">Closed stakes</h2>
        <span className="x-badge is-muted ml-auto">{stakes.length}</span>
      </div>
      <div className="table-card x-table overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="x-thead">
            <tr>{['Product', 'Term', 'Staked', 'Closed'].map((h) => <th key={h} className="px-4 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id} className="border-t border-white/5">
                <td className="px-4 py-2.5"><span className="flex items-center gap-2"><Token asset={s.asset} size={22} />{s.product_name}</span></td>
                <td className="px-4 py-2.5 text-slate-ink">{term(s.lock_days)}</td>
                <td className="px-4 py-2.5 text-slate-ink">{day(s.staked_at)}</td>
                <td className="px-4 py-2.5">{s.closed_at ? day(s.closed_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 3 && (
        <button type="button" className="x-btn-sm" onClick={() => setOpen((v) => !v)}>{open ? 'Show fewer' : `Show all ${rows.length}`}</button>
      )}
    </section>
  );
}
