import {
  ArrowDownToLine, ArrowUpFromLine, CalendarClock, Clock, History as HistoryIcon, Inbox, PiggyBank, Plus, Star,
  TrendingUp, Wallet, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { alertBox, btn, field, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { useCountUp } from './count-up.ts';
import { PotArt } from './portfolio-art.tsx';
import { StatTile } from './x-shell.tsx';
import type { Accounts } from './balance.tsx';
import type { Currency } from './wallet.tsx';

type PortfolioType = {
  code: string; name: string; description: string;
  indicative_rate: number | null; sort_order: number;
};
type Portfolio = {
  id: string; type_code: string; type_name: string; name: string; currency: string;
  balance: number; target_date: string | null; featured: boolean;
  status: 'open' | 'closed'; indicative_rate: number | null; standard_rate: number | null;
  rate_override: number | null;
  usd_value: number | null; progress: number | null; projected: number | null;
  earned: number; requested: number; created_at?: string;
};
type Movement = {
  id: number; kind: 'contribution' | 'withdrawal' | 'interest'; amount: number;
  note: string | null; at: string;
};
type Request = {
  id: number; portfolio_name: string; currency: string; amount: number;
  status: string; note: string | null; decision_note: string | null; created_at: string;
};

const money = (n: number, code: string) =>
  `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${code}`;
// One decimal is enough for a progress bar and wrong for a rate: an agreed 7.25% shown as
// 7.2% is a smaller number than the one on the client's screen everywhere else. Up to two,
// with trailing zeros trimmed, so 3.5% does not become 3.50%.
const pct = (n: number) => `${Number((n * 100).toFixed(2))}%`;
const day = (d: string | Date) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const usd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** What one unit of the pot's currency is worth in dollars, where it can be priced. */
const rateOf = (p: Portfolio) => (p.usd_value !== null && Number(p.balance) > 0 ? Number(p.usd_value) / Number(p.balance) : null);
const until = (d: string) => {
  const days = Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return 'Reached';
  if (days < 60) return `${days} days`;
  const months = Math.round(days / 30.44);
  return months < 24 ? `${months} months` : `${Math.round(days / 365.25)} years`;
};

type On = { client_id?: string };

/**
 * A client's pots: open one, pay into it, ask for money back out.
 *
 * The same panel serves both sides. A client passes no clientId and acts on themselves;
 * staff pass one and act on that client, which the API makes them name on every write. One
 * component rather than a staff copy — two versions of a screen that moves money is two
 * places for the rules to drift apart.
 *
 * The return on a pot is agreed with the desk and is not quoted on the client's screen;
 * the projection on a pot with a target date is the server's figure for that pot.
 */
export function PortfoliosPanel({ clientId, onChanged }: { clientId?: string; onChanged?: () => void } = {}) {
  const on: On = clientId ? { client_id: clientId } : {};
  const portfolios = useApi<Portfolio[]>(clientId ? `/portfolios?client_id=${clientId}` : '/portfolios');
  const types = useApi<PortfolioType[]>('/portfolio-types');
  const currencies = useApi<Currency[]>('/currencies');
  // A client's own requests and balances; staff see the queue and the wallets elsewhere.
  const requests = useApi<Request[]>(clientId ? null : '/me/portfolio-requests');
  const accounts = useApi<Accounts>(clientId ? null : '/accounts');
  const composer = useRef<HTMLDivElement>(null);

  const reload = () => { portfolios.reload(); requests.reload(); accounts.reload(); onChanged?.(); };
  const open = portfolios.data?.filter((p) => p.status === 'open') ?? [];
  const closed = portfolios.data?.filter((p) => p.status === 'closed') ?? [];
  const balances: Record<string, number> | null = accounts.data
    ? Object.fromEntries([
      ...accounts.data.cash.map((c) => [c.currency, Number(c.balance)] as const),
      ...accounts.data.wallets.map((w) => [w.asset, Number(w.balance)] as const),
    ])
    : null;

  const openPot = () => {
    composer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    composer.current?.querySelector<HTMLButtonElement>('[role=radio][aria-checked=true]')?.focus({ preventScroll: true });
  };

  return (
    <div className="stagger space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {clientId ? <h3 className="section-title">Portfolios</h3> : <PageTitle>Portfolios</PageTitle>}
        <span className="x-badge"><TrendingUp size={13} className="mr-1.5" aria-hidden />Interest credited daily</span>
        <button type="button" onClick={openPot} className={`${btn} ml-auto inline-flex items-center gap-2`}>
          <Plus size={16} aria-hidden />Open a pot
        </button>
      </div>

      <Totals pots={open} requests={requests.data ?? []} loading={!portfolios.data} staff={!!clientId} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <section className="x-card x-holo space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="section-title">{clientId ? 'Their pots' : 'Your pots'}</h2>
              {!!open.length && <span className="x-badge is-muted">{open.length} open</span>}
              {!clientId && !!open.length && <span className="ml-auto text-xs text-slate-ink">Pay in any time; money comes out by request.</span>}
            </div>
            {!portfolios.data && <div className="skeleton h-32 rounded-lg" />}
            {portfolios.data && !open.length && (
              <div className="grid place-items-center gap-2 py-10 text-center">
                <span className="x-drop-icon" aria-hidden><PiggyBank size={24} /></span>
                <p className="text-[15px] font-semibold">{closed.length ? 'No open pots' : 'No pots yet'}</p>
                <p className="max-w-sm text-xs text-slate-ink">
                  {clientId
                    ? 'Opening one here does it on the client’s behalf, and is recorded that way.'
                    : 'Set money aside for a purpose — retirement, a home, a rainy day. It earns while it sits there.'}
                </p>
                <button type="button" className="x-btn-sm mt-2" onClick={openPot}>Open a pot</button>
              </div>
            )}
            <div className="grid gap-3">
              {open.map((p) => (
                <Pot key={p.id} p={p} on={on} onDone={reload}
                  available={balances ? balances[p.currency] ?? 0 : null} />
              ))}
            </div>
          </section>

          {!clientId && !!(requests.data ?? []).length && <Requests rows={requests.data!} />}
          {!!closed.length && <Closed pots={closed} />}
        </div>

        <div ref={composer} className="min-w-0 scroll-mt-24">
          {types.data && currencies.data
            ? <NewPortfolio types={types.data} currencies={currencies.data} on={on} balances={balances} onDone={reload} />
            : <div className="x-card skeleton h-96" />}
        </div>
      </div>
    </div>
  );
}

/** The figures across every open pot, in dollars so pots in different currencies add up. */
function Totals({ pots, requests, loading, staff }: { pots: Portfolio[]; requests: Request[]; loading: boolean; staff: boolean }) {
  const priced = pots.filter((p) => p.usd_value !== null);
  const total = priced.reduce((n, p) => n + Number(p.usd_value), 0);
  const earned = pots.reduce((n, p) => { const r = rateOf(p); return r === null ? n : n + Number(p.earned) * r; }, 0);
  const waiting = requests.filter((r) => r.status === 'pending');
  const featured = pots.find((p) => p.featured);
  const next = pots.filter((p) => p.target_date && new Date(p.target_date).getTime() > Date.now())
    .sort((a, b) => new Date(a.target_date!).getTime() - new Date(b.target_date!).getTime())[0];

  const shownTotal = useCountUp(loading ? null : total);
  const shownEarned = useCountUp(loading ? null : earned);
  const skel = <span className="skeleton inline-block h-5 w-28" />;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile label="Set aside" Icon={Wallet} tone="text-ember-ink" value={shownTotal === null ? skel : usd(shownTotal)}
        note={`In ${pots.length} pot${pots.length === 1 ? '' : 's'}${pots.length > priced.length ? ` · ${pots.length - priced.length} not priced` : ''}`} />
      <StatTile label="Interest earned" Icon={TrendingUp} tone="text-up" value={shownEarned === null ? skel : usd(shownEarned)}
        note="Credited daily into each pot" />
      {staff
        ? <StatTile label="On the balance strip" Icon={Star} value={featured ? featured.name : 'None'} note="The client’s own choice" />
        : <StatTile label="With the desk" Icon={Inbox} value={loading ? skel : waiting.length ? `${waiting.length} request${waiting.length === 1 ? '' : 's'}` : 'Nothing waiting'}
            tone={waiting.length ? 'text-ember-ink' : ''}
            note={waiting.length ? 'You will hear when each is decided' : 'Ask to take money out from any pot'} />}
      <StatTile label="Next target" Icon={CalendarClock} value={loading ? skel : next ? until(next.target_date!) : 'None set'}
        note={next ? `${next.name} · ${day(next.target_date!)}` : 'Give a pot a date to track it'} />
    </div>
  );
}

function Pot({ p, on, onDone, available }: { p: Portfolio; on: On; onDone: () => void; available: number | null }) {
  const [action, setAction] = useState<'contribute' | 'withdraw' | null>(null);
  const [panel, setPanel] = useState<'history' | 'rate' | null>(null);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [amt, setAmt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const r = rateOf(p);
  const asking = action === 'withdraw' && !on.client_id;
  // Paying in draws on the balance in the pot's currency; taking out, on the pot.
  const room = action === 'contribute' ? available : action === 'withdraw' ? Number(p.balance) - Number(p.requested) : null;
  const n = Number(amt);
  const over = !!amt && room !== null && n > room;

  function toggle(a: 'contribute' | 'withdraw') {
    setAction(action === a ? null : a); setAmt(''); setNote(''); setError(null); setSent(null);
  }

  async function move(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (asking) {
        // A client asks; the desk decides. Nothing moves here.
        await api(`/portfolios/${p.id}/requests`, {
          method: 'POST', body: JSON.stringify({ amount: n, note: note || undefined }),
        });
        setSent(`Asked for ${money(n, p.currency)}. The desk decides, and you will hear when it does.`);
      } else {
        await api(`/portfolios/${p.id}/${action}`, { method: 'POST', body: JSON.stringify({ ...on, amount: n }) });
        setSent(action === 'contribute' ? `Paid in ${money(n, p.currency)}.` : `Took out ${money(n, p.currency)}.`);
      }
      setAmt(''); setNote(''); setAction(null);
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
    <article className="pt-card">
      <PotLine p={p} />
      <div className="relative flex items-start gap-3">
        <span className="x-pot-icon !h-11 !w-11"><PotArt code={p.type_code} size={26} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{p.name}</p>
          <p className="text-xs text-slate-ink">{p.type_name}{p.created_at ? ` · opened ${day(p.created_at)}` : ''}</p>
        </div>
        {p.featured && <span className="x-badge is-locked"><Star size={12} className="mr-1" aria-hidden />On your balance</span>}
      </div>

      <div className="relative mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini label="Balance" value={money(p.balance, p.currency)} sub={r !== null && p.currency !== 'USD' ? usd(Number(p.usd_value)) : undefined} lead />
        <Mini label="Interest earned" value={`${Number(p.earned) > 0 ? '+' : ''}${money(p.earned, p.currency)}`} tone="text-up" />
        <Mini label="Target date" value={p.target_date ? day(p.target_date) : 'None set'} sub={p.target_date ? until(p.target_date) : undefined} />
        <Mini label="Projected" value={p.projected !== null ? money(p.projected, p.currency) : '—'}
          sub={p.projected !== null ? 'at the target date' : 'Needs a target date'} />
      </div>

      {p.target_date && p.created_at && <Track from={p.created_at} to={p.target_date} />}

      {/* Money already asked for, so a second request is made knowing about the first. */}
      {Number(p.requested) > 0 && (
        <p className="relative mt-3 flex items-center gap-2 rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-ember-ink">
          <Clock size={13} aria-hidden />{money(p.requested, p.currency)} is with the desk waiting on a decision.
        </p>
      )}

      <div className="relative mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => toggle('contribute')} className={`x-btn-sm inline-flex items-center gap-1.5 ${action === 'contribute' ? 'is-on' : ''}`}>
          <ArrowDownToLine size={13} aria-hidden />Pay in
        </button>
        <button type="button" onClick={() => toggle('withdraw')} className={`x-btn-sm inline-flex items-center gap-1.5 ${action === 'withdraw' ? 'is-on' : ''}`}>
          <ArrowUpFromLine size={13} aria-hidden />{on.client_id ? 'Take out' : 'Ask to withdraw'}
        </button>
        <FeatureToggle p={p} on={on} onDone={onDone} />
        <button type="button" onClick={() => setPanel(panel === 'history' ? null : 'history')} className={`x-btn-sm inline-flex items-center gap-1.5 ${panel === 'history' ? 'is-on' : ''}`}>
          <HistoryIcon size={13} aria-hidden />History
        </button>
        {on.client_id && (
          <button type="button" onClick={() => { setPanel(panel === 'rate' ? null : 'rate'); setError(null); }} className={`x-btn-sm ${panel === 'rate' ? 'is-on' : ''}`}>
            Return · {p.indicative_rate === null ? 'none' : pct(p.indicative_rate)}
          </button>
        )}
        {Number(p.balance) === 0 && (
          <button type="button" onClick={close} className="x-btn-sm ml-auto inline-flex items-center gap-1.5 hover:!border-down hover:text-down">
            <X size={13} aria-hidden />Close pot
          </button>
        )}
      </div>

      {action && (
        <form onSubmit={move} className="pt-move relative mt-3 space-y-3">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-semibold">{action === 'contribute' ? 'Pay in' : asking ? 'Ask to withdraw' : 'Take out'}</span>
            {room !== null && (
              <span className="text-slate-ink">
                {action === 'contribute' ? 'Available' : 'In the pot'}{' '}
                <span className="font-semibold tabular-nums text-obsidian dark:text-vellum">{money(Math.max(0, room), p.currency)}</span>
              </span>
            )}
          </div>
          <div className="sk-amount">
            <input className={`${field} w-full`} type="number" step="any" min="0" required autoFocus inputMode="decimal"
              placeholder="0" aria-label={`Amount in ${p.currency}`} value={amt} onChange={(e) => setAmt(e.target.value)} />
            <span className="sk-amount-unit">{p.currency}</span>
          </div>
          {room !== null && room > 0 && (
            <div className="grid grid-cols-4 gap-1.5">
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <button key={f} type="button" className="x-btn-sm !h-7 !px-0 text-[11.5px]"
                  onClick={() => setAmt(String(f === 1 ? room : Math.floor(room * f * 100) / 100))}>
                  {f === 1 ? 'Max' : `${f * 100}%`}
                </button>
              ))}
            </div>
          )}
          {asking && (
            <input className={`${field} w-full`} maxLength={400} placeholder="What it is for (optional)"
              value={note} onChange={(e) => setNote(e.target.value)} />
          )}
          {over && <p className="text-xs text-down">That is more than the {money(room!, p.currency)} {action === 'contribute' ? 'available' : 'in the pot'}.</p>}
          {action === 'contribute' && available === 0 && (
            <p className="text-xs text-slate-ink">You hold no {p.currency}. The desk funds your account — <a href="#/support" className="text-ember-ink hover:underline">ask in Support</a>.</p>
          )}
          {asking && <p className="text-xs text-slate-ink">Money comes out of a pot by request. The desk decides, and nothing moves until it does.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn} disabled={busy || !(n > 0) || over}>
              {busy ? 'Sending…' : !(n > 0) ? 'Enter an amount'
                : action === 'contribute' ? `Pay in ${money(n, p.currency)}`
                : asking ? `Ask for ${money(n, p.currency)}` : `Take out ${money(n, p.currency)}`}
            </button>
            <button type="button" onClick={() => setAction(null)} className="x-btn-sm">Cancel</button>
          </div>
        </form>
      )}
      {sent && <p role="status" className="relative mt-2 text-xs text-up">{sent}</p>}
      {panel === 'history' && <History p={p} />}
      {panel === 'rate' && on.client_id && (
        <SetRate p={p} on={on} onDone={() => { setPanel(null); onDone(); }} onError={setError} />
      )}
      {error && <p role="alert" className={`${alertBox} relative mt-2`}>{error}</p>}
    </article>
  );
}

const Mini = ({ label, value, sub, tone = '', lead }: { label: string; value: string; sub?: string; tone?: string; lead?: boolean }) => (
  <div className={`x-mini-tile min-w-0 ${lead ? 'sk-lead' : ''}`}>
    <p className="text-[11.5px] text-mist">{label}</p>
    <p className={`mt-1 truncate text-[14px] font-semibold tabular-nums ${tone}`} title={value}>{value}</p>
    {sub && <p className="truncate text-[11px] text-slate-ink">{sub}</p>}
  </div>
);

/** How far a pot is from the day it was opened to its target date. */
function Track({ from, to }: { from: string; to: string }) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const done = end > start ? Math.min(1, Math.max(0, (Date.now() - start) / (end - start))) : 1;
  return (
    <div className="relative mt-4">
      <div className="flex items-baseline justify-between text-[11.5px] text-slate-ink">
        <span>Opened {day(from)}</span>
        <span className="font-semibold text-ember-ink">{done >= 1 ? 'Target reached' : `${until(to)} to go`}</span>
        <span>{day(to)}</span>
      </div>
      <div className="sk-track mt-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(done * 100)}
        aria-label="Time towards the target date">
        <span style={{ width: `${Math.max(2, done * 100)}%` }} />
      </div>
    </div>
  );
}

/**
 * Which pot the client wants on the balance strip at the top of every page. One at a time,
 * and theirs to choose — the desk has no business deciding which of somebody's goals they
 * want to look at.
 */
function FeatureToggle({ p, on, onDone }: { p: Portfolio; on: On; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if (on.client_id) return null;   // staff act on the client, not on their preferences
  return (
    <button type="button" disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/portfolios/${p.id}/feature`, {
            method: 'POST', body: JSON.stringify({ featured: !p.featured }),
          });
          onDone();
        } finally { setBusy(false); }
      }}
      className={`x-btn-sm inline-flex items-center gap-1.5 ${p.featured ? 'is-on' : ''}`}>
      <Star size={13} aria-hidden fill={p.featured ? 'currentColor' : 'none'} />
      {p.featured ? 'On your balance' : 'Show on balance'}
    </button>
  );
}

/** What has gone in, come out and been paid, once somebody asks to see it. */
function History({ p }: { p: Portfolio }) {
  const rows = useApi<Movement[]>(`/portfolios/${p.id}/transactions`);
  const list = rows.data ?? [];

  if (!rows.data) return <div className="skeleton relative mt-3 h-16 rounded-lg" />;
  if (!list.length) return <p className="relative mt-3 text-xs text-slate-ink">Nothing has moved yet.</p>;

  return (
    <ul className="pt-history relative mt-3">
      {list.slice(0, 20).map((m) => {
        const Icon = m.kind === 'contribution' ? ArrowDownToLine : m.kind === 'withdrawal' ? ArrowUpFromLine : TrendingUp;
        return (
          <li key={m.id}>
            <span className={`pt-history-icon is-${m.kind}`} aria-hidden><Icon size={13} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{m.kind === 'contribution' ? 'Paid in' : m.kind === 'withdrawal' ? 'Taken out' : 'Interest'}</span>
              {m.note && <span className="block truncate text-[11.5px] text-slate-ink">{m.note}</span>}
            </span>
            <span className="text-right">
              <span className={`block text-[13px] font-semibold tabular-nums ${Number(m.amount) < 0 ? 'text-down' : 'text-up'}`}>
                {Number(m.amount) > 0 ? '+' : ''}{money(m.amount, p.currency)}
              </span>
              <span className="block text-[11px] text-slate-ink">{day(m.at)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The client's withdrawal requests, newest first, each with where it stands. */
function Requests({ rows }: { rows: Request[] }) {
  const STATUS: Record<string, [string, string]> = {
    pending: ['With the desk', 'is-locked'], approved: ['Approved', ''], declined: ['Declined', 'is-bad'],
  };
  return (
    <section className="x-card x-holo space-y-3 p-5">
      <div className="flex items-center gap-3">
        <span className="x-chip" aria-hidden><Inbox size={17} /></span>
        <h2 className="section-title">Your requests</h2>
        <span className="ml-auto text-xs text-slate-ink">Money out of a pot, as asked</span>
      </div>
      <ul className="pt-rows">
        {rows.slice(0, 8).map((r) => {
          const [label, badge] = STATUS[r.status] ?? [r.status, 'is-muted'];
          return (
            <li key={r.id}>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold tabular-nums">{money(r.amount, r.currency)} <span className="font-normal text-slate-ink">from {r.portfolio_name}</span></p>
                <p className="truncate text-[11.5px] text-slate-ink">{day(r.created_at)}{r.note ? ` · ${r.note}` : ''}</p>
                {r.decision_note && <p className="mt-0.5 text-[11.5px] text-slate-ink">Desk: {r.decision_note}</p>}
              </div>
              <span className={`x-badge ${badge}`}>{label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Pots that have been closed, as a record. */
function Closed({ pots }: { pots: Portfolio[] }) {
  return (
    <section className="x-card x-holo space-y-3 p-5">
      <div className="flex items-center gap-3">
        <span className="x-chip" aria-hidden><HistoryIcon size={17} /></span>
        <h2 className="section-title">Closed pots</h2>
        <span className="x-badge is-muted ml-auto">{pots.length}</span>
      </div>
      <ul className="pt-rows">
        {pots.map((p) => (
          <li key={p.id}>
            <span className="x-pot-icon !h-8 !w-8 !rounded-lg"><PotArt code={p.type_code} size={18} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{p.name}</span>
              <span className="block text-[11.5px] text-slate-ink">{p.type_name}{p.created_at ? ` · opened ${day(p.created_at)}` : ''}</span>
            </span>
            {Number(p.earned) > 0 && <span className="text-[12px] tabular-nums text-up">+{money(p.earned, p.currency)} earned</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The pot's balance over time, from its own movements, as a faint ember line along the foot
 * of the card. Nothing drawn here is projected: each step is a payment in, out or interest.
 */
function PotLine({ p }: { p: Portfolio }) {
  const rows = useApi<Movement[]>(`/portfolios/${p.id}/transactions`).data;
  const pts = useMemo(() => {
    if (!rows || rows.length < 1) return null;
    const ordered = [...rows].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    let run = 0;
    const vals = [0, ...ordered.map((m) => (run += Number(m.amount)))];
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    return vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * 300).toFixed(1)},${(58 - ((v - lo) / span) * 50).toFixed(1)}`).join(' ');
  }, [rows]);
  if (!pts) return null;
  return (
    <svg viewBox="0 0 300 60" preserveAspectRatio="none" className="pt-spark pointer-events-none absolute top-2 right-0 h-[52px] w-[42%]" aria-hidden>
      <defs><linearGradient id={`pot-${p.id}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff7a12" stopOpacity="0.3" /><stop offset="1" stopColor="#ff7a12" stopOpacity="0" /></linearGradient></defs>
      <path d={`${pts} L300,60 L0,60 Z`} fill={`url(#pot-${p.id})`} />
      <path d={pts} fill="none" stroke="#ff7a12" strokeWidth="1.8" vectorEffect="non-scaling-stroke" className="lp-draw-x" pathLength={1} />
    </svg>
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

/**
 * Opening a pot, in the order the decision is made: what it is for, what to call it and
 * in which currency, when it is for, and — optionally — a first payment in.
 *
 * The purposes are ordered by the desk's indicative rate, which is its own sense of which
 * pot leads, without showing the number: the return on a pot is agreed with the desk.
 * Opening and the first payment are two writes; if the payment is refused the pot stays
 * open and the reason is shown, so nothing is half-done without saying so.
 */
function NewPortfolio({ types, currencies, on, balances, onDone }: {
  types: PortfolioType[]; currencies: Currency[]; on: On; balances: Record<string, number> | null; onDone: () => void;
}) {
  const order = useMemo(() => [...types].sort((a, b) => Number(b.indicative_rate ?? 0) - Number(a.indicative_rate ?? 0)), [types]);
  const [type, setType] = useState(order[0]?.code ?? '');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [target, setTarget] = useState('');
  const [first, setFirst] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const chosen = types.find((t) => t.code === type);
  const listed = [...currencies].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'fiat' ? -1 : 1));
  const available = balances ? balances[currency] ?? 0 : null;
  const pay = Number(first);
  const over = !!first && available !== null && pay > available;

  useEffect(() => { if (!types.find((t) => t.code === type) && order[0]) setType(order[0].code); }, [types, type, order]);

  const inYears = (y: number) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + y);
    return d.toISOString().slice(0, 10);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const pot = await api<{ id: string }>('/portfolios', {
        method: 'POST',
        body: JSON.stringify({ ...on, type_code: type, name: name.trim(), currency, ...(target ? { target_date: target } : {}) }),
      });
      if (pay > 0) {
        try {
          await api(`/portfolios/${pot.id}/contribute`, { method: 'POST', body: JSON.stringify({ ...on, amount: pay }) });
        } catch (err) {
          setError(`${name.trim()} is open, but the first payment was refused: ${(err as Error).message}`);
          setName(''); setTarget(''); setFirst('');
          onDone();
          return;
        }
      }
      setDone(`${name.trim()} is open${pay > 0 ? ` with ${money(pay, currency)} paid in` : ''}.`);
      setName(''); setTarget(''); setFirst('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="x-card x-holo space-y-5 p-5">
      <div>
        <h2 className="section-title">Open a pot</h2>
        <p className="mt-1 text-xs text-slate-ink">
          {on.client_id
            ? 'Opened on the client’s behalf, and recorded that way.'
            : 'Set money aside for something in particular. Its return is agreed with the desk.'}
        </p>
      </div>

      <Step n={1} label="What it is for">
        <div role="radiogroup" aria-label="Kind of pot" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {order.map((t) => {
            const isOn = t.code === type;
            return (
              <button key={t.code} type="button" role="radio" aria-checked={isOn} onClick={() => { setType(t.code); setDone(null); }}
                className={`sk-opt pt-purpose ${isOn ? 'is-on' : ''}`}>
                <span className={isOn ? 'text-ember-ink' : 'text-mist'}><PotArt code={t.code} size={28} /></span>
                <span className="text-[12px] leading-tight font-semibold">{t.name}</span>
              </button>
            );
          })}
        </div>
        {chosen?.description && <p className="mt-2 text-xs text-slate-ink">{chosen.description}</p>}
      </Step>

      <Step n={2} label="Name and currency">
        <div className="flex gap-2">
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-label="Name"
            placeholder={chosen ? `e.g. ${chosen.code === 'retirement' ? 'Retirement 2055' : chosen.name}` : 'Name it'}
            className={`${field} h-10 min-w-0 flex-1`} />
          <select value={currency} onChange={(e) => { setCurrency(e.target.value); setFirst(''); }} aria-label="Currency"
            className={`${field} h-10 w-28`}>
            {listed.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select>
        </div>
      </Step>

      <Step n={3} label="Target date" aside={<span className="text-[11.5px] text-slate-ink">Optional</span>}>
        <div className="flex flex-wrap gap-2">
          <input type="date" value={target} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setTarget(e.target.value)}
            aria-label="Target date" className={`${field} h-9 min-w-0 flex-1`} />
          {[1, 5, 10].map((y) => (
            <button key={y} type="button" onClick={() => setTarget(inYears(y))}
              className={`x-btn-sm !h-9 ${target === inYears(y) ? 'is-on' : ''}`}>{y} yr</button>
          ))}
          {target && <button type="button" onClick={() => setTarget('')} className="x-btn-sm !h-9" aria-label="Clear the date"><X size={13} aria-hidden /></button>}
        </div>
      </Step>

      <Step n={4} label="First payment" aside={available !== null
        ? <span className="text-[11.5px] text-slate-ink">Available <span className="font-semibold tabular-nums text-obsidian dark:text-vellum">{money(available, currency)}</span></span>
        : <span className="text-[11.5px] text-slate-ink">Optional</span>}>
        <div className="sk-amount">
          <input className={`${field} w-full`} type="number" step="any" min="0" inputMode="decimal" placeholder="0 — or pay in later"
            aria-label={`First payment in ${currency}`} value={first} onChange={(e) => setFirst(e.target.value)} />
          <span className="sk-amount-unit">{currency}</span>
        </div>
        {available !== null && available > 0 && (
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {[0.1, 0.25, 0.5, 1].map((f) => (
              <button key={f} type="button" className="x-btn-sm !h-7 !px-0 text-[11.5px]"
                onClick={() => setFirst(String(f === 1 ? available : Math.floor(available * f * 100) / 100))}>
                {f === 1 ? 'Max' : `${f * 100}%`}
              </button>
            ))}
          </div>
        )}
        {over && <p className="mt-2 text-xs text-down">That is more than the {money(available!, currency)} available.</p>}
      </Step>

      {chosen && (
        <div className="sk-summary">
          <p>
            <b>{name.trim() || chosen.name}</b>, a {chosen.name.toLowerCase()} in {currency}
            {target ? <>, aimed at <b>{day(target)}</b></> : ', with no target date'}
            {pay > 0 ? <>, starting with <b className="tabular-nums">{money(pay, currency)}</b>.</> : '.'}
          </p>
          <p className="mt-1 text-[11.5px] text-slate-ink">Interest is credited daily. Pay in whenever you like; money comes out by request.</p>
        </div>
      )}

      {error && <p role="alert" className={alertBox}>{error}</p>}
      {done && <p role="status" className="text-xs text-up">{done}</p>}
      <button className={`${btn} w-full`} disabled={busy || !chosen || !name.trim() || over}>
        {busy ? 'Opening…' : name.trim() ? `Open ${name.trim()}` : 'Name your pot'}
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
