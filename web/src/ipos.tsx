import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CalendarClock, CheckCircle2, Clock, FileText, Layers, Rocket, ShieldCheck, Timer, TrendingUp, Wallet } from 'lucide-react';
import { alertBox, btn, field, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { useCountUp } from './count-up.ts';
import { StatTile } from './x-shell.tsx';
import type { Accounts } from './balance.tsx';
import { IpoMark, markTint } from './ipo-art.tsx';
import { useAuthedImage } from './authed-image.ts';

/**
 * IPO offerings for the client: what is running, what is coming, what has finished.
 *
 * Built as a panel rather than a page so the client workspace can embed it for staff the
 * same way it embeds portfolios and staking — hence the `on` convention below.
 *
 * The rate is not on this page. It was, on the argument that an offering's ROI is its public
 * pitch rather than an agreed rate like a portfolio's or a stake's — the desk decided
 * otherwise, so it now sits with those two. What a client sees is the term, what they hold,
 * what it has earned and when it matures.
 *
 * Finished offerings are the exception and still print a rate, because there it is a record
 * of what was actually paid rather than an offer being made.
 */

type Group = 'running' | 'incoming' | 'finished' | 'hidden';

type Subscription = {
  id: string; amount: number; accrued: number; currency: string;
  status: 'active' | 'refunded' | 'settled'; created_at: string;
};

type Ipo = {
  id: string; slug: string; name: string; summary: string; description: string | null;
  asset: string; currency: string; target_amount: number; min_subscription: number;
  max_subscription: number | null; roi_rate: number; term_days: number;
  valuation: string | null;
  // The return over the whole term as a fraction of what goes in, computed by the server
  // with the same function that credits it.
  estimated_return_pct: number;
  opens_at: string | null; closes_at: string | null; matures_at: string | null;
  status: string; group: Group; raised: number; remaining: number; progress: number | null;
  // image_key changes on every upload, which is what makes the picture refetch.
  has_image: boolean; image_key: string | null; server_time: string;
  subscription: Subscription | null;
};

type On = { client_id?: string };

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const num = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });
/** Money, to the minor unit. The database keeps eighteen decimals; a reader wants two. */
const fixed = (n: number) =>
  Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number, ccy: string) =>
  `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${ccy}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, {
  day: 'numeric', month: 'short', year: 'numeric',
});
/**
 * Which day of the term a running offering is on.
 *
 * Counted from the close, because that is the day the money started working and the day the
 * accrual runs from — not from whenever the client happened to subscribe. Clamped into the
 * term at both ends so a settlement running late reads "180 of 180" rather than "183 of 180".
 */
function dayOfTerm(closesAt: string | null, termDays: number, clock: number): number | null {
  if (!closesAt) return null;
  const elapsed = Math.floor((clock - new Date(closesAt).getTime()) / 86400000);
  return Math.min(Math.max(elapsed, 0), termDays);
}

const term = (days: number) => (days >= 365 && days % 365 === 0
  ? `${days / 365} year${days === 365 ? '' : 's'}` : `${days} days`);

/**
 * One ticker for the whole page, against the server's clock.
 *
 * Time is the server's, not the browser's: a client with a skewed clock must not see an
 * offering as open when it is not. The offset is measured once from the timestamp the API
 * sends and every countdown is rendered against the corrected clock. The server re-checks
 * the window on subscribe regardless — the timer is a display, never an authorisation.
 *
 * One interval rather than one per card: a dozen setIntervals in a dozen components is how
 * a list of offerings becomes a warm laptop.
 */
function useServerClock(serverTime: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const skew = useRef(0);

  useEffect(() => {
    if (serverTime) skew.current = new Date(serverTime).getTime() - Date.now();
  }, [serverTime]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return now + skew.current;
}

const pad = (n: number) => String(n).padStart(2, '0');
function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  return (d > 0 ? `${d}d ` : '') + `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function IposPanel({ clientId, onChanged }: { clientId?: string; onChanged?: () => void } = {}) {
  const on: On = clientId ? { client_id: clientId } : {};
  const rows = useApi<Ipo[]>(`/ipos${clientId ? `?client_id=${clientId}` : ''}`);
  // The client's own balances and verification, so the form can say what is available and
  // whether a subscription will be accepted before anybody presses the button.
  const accounts = useApi<Accounts>(clientId ? null : '/accounts');
  const profile = useApi<{ kyc_status: string }>(clientId ? null : '/me/profile');
  const list = rows.data ?? [];
  const clock = useServerClock(list[0]?.server_time);
  const verified = clientId ? true : profile.data ? profile.data.kyc_status === 'approved' : true;
  const cash = Object.fromEntries((accounts.data?.cash ?? []).map((c) => [c.currency, Number(c.balance)]));

  const groups = useMemo(() => ({
    open: list.filter((i) => i.group === 'incoming' && i.status === 'open'),
    upcoming: list.filter((i) => i.group === 'incoming' && i.status !== 'open'),
    running: list.filter((i) => i.group === 'running'),
    finished: list.filter((i) => i.group === 'finished'),
  }), [list]);
  const held = list.filter((i) => i.subscription?.status === 'active');
  // A column beside the offerings, only when there is something to put in it.
  const side = !verified || !!held.length;

  // When a countdown reaches zero the page re-reads rather than assuming: an offering whose
  // window just closed should show the state the server agrees to, not one invented here.
  const boundary = useMemo(() => Math.min(...list.flatMap((i) => {
    const t = i.status === 'upcoming' ? i.opens_at : i.status === 'open' ? i.closes_at : i.matures_at;
    const ms = t ? new Date(t).getTime() : Infinity;
    return ms > clock ? [ms] : [];
  }), Infinity), [list, clock]);
  useEffect(() => {
    if (!Number.isFinite(boundary)) return;
    const id = setTimeout(() => rows.reload(), Math.max(0, boundary - clock) + 500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  /**
   * What the finished group is worth saying in one line.
   *
   * The money figure only appears when the client actually had something in these, and it
   * counts settled positions only — a cancelled offering refunded exactly what it took, so
   * folding it in would report nothing as if it were something.
   */
  const closedOut = useMemo(() => {
    const settled = groups.finished.filter((i) => i.subscription?.status === 'settled');
    const earned = settled.reduce((t, i) => t + Number(i.subscription!.accrued), 0);
    const ccy = settled[0]?.subscription!.currency;
    const matured = `${settled.length || groups.finished.length} ${settled.length ? 'matured' : 'closed out'}`;
    return settled.length && earned > 0
      ? `${matured} · +${fixed(earned)} ${ccy} returned above capital`
      : matured;
  }, [groups.finished]);

  const refresh = () => { rows.reload(); accounts.reload(); onChanged?.(); };
  const TABS = [
    ['open', 'Open now', groups.open.length], ['upcoming', 'Upcoming', groups.upcoming.length],
    ['running', 'Running', groups.running.length], ['finished', 'Finished', groups.finished.length],
  ] as const;
  const [picked, setTab] = useState<(typeof TABS)[number][0] | null>(null);
  const tab = picked ?? (TABS.find(([, , n]) => n > 0)?.[0] ?? 'open');

  if (rows.error) return <p role="alert" className={alertBox}>{rows.error}</p>;

  return (
    <div className="stagger space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {clientId ? <h3 className="section-title">IPO Offerings</h3> : <PageTitle>IPO Offerings</PageTitle>}
        {/* Live means the page is ticking against the server's clock, not that any one
            offering is open — the per-card status says that. */}
        <span className="x-badge"><i className="nav-live mr-1.5 block size-1.5 rounded-full bg-up" aria-hidden />Live</span>
        {!clientId && <span className="ml-auto text-xs text-slate-ink">Earnings are credited daily and paid at maturity</span>}
      </div>

      <Totals list={list} held={held} clock={clock} loading={!rows.data} />

      <div className={side ? 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]' : ''}>
      <div className="min-w-0">
      {!rows.data ? (
        <div className="skeleton h-64 rounded-xl" />
      ) : !list.length ? (
        <div className="x-card x-holo grid place-items-center gap-2 py-12 text-center">
          <span className="x-drop-icon" aria-hidden><Rocket size={24} /></span>
          <p className="text-[15px] font-semibold">Nothing on the shelf yet</p>
          <p className="max-w-sm text-xs text-slate-ink">The desk publishes offerings here. New ones appear as Upcoming first.</p>
        </div>
      ) : (
        <section className="x-card x-holo space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="section-title">Offerings</h2>
            <div role="tablist" aria-label="Offerings" className="x-segs ip-tabs w-full sm:ml-auto sm:w-auto">
              {TABS.map(([key, label, n]) => (
                <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={tab === key ? 'is-on' : ''}>
                  {label}{n ? <span className="ml-1.5 opacity-70">{n}</span> : null}
                </button>
              ))}
            </div>
          </div>

          {(tab === 'open' || tab === 'upcoming') && (groups[tab].length ? (
            <div className={`grid gap-4 md:grid-cols-2 ${side ? '2xl:grid-cols-3' : 'xl:grid-cols-3'}`}>
              {groups[tab].map((i) => (
                <Offer key={i.id} ipo={i} on={on} clock={clock} onDone={refresh} staff={!!clientId}
                  available={clientId ? null : cash[i.currency] ?? 0} verified={verified} />
              ))}
            </div>
          ) : (
            <Empty Icon={tab === 'open' ? Rocket : CalendarClock}
              title={tab === 'open' ? 'Nothing taking subscriptions right now' : 'Nothing upcoming right now'}
              note={tab === 'open' ? 'Offerings open here when their window starts. Upcoming ones are listed next door.' : 'New offerings appear here first.'} />
          ))}

          {tab === 'running' && (groups.running.length ? (
            <div className={`grid gap-4 md:grid-cols-2 ${side ? '2xl:grid-cols-3' : 'xl:grid-cols-3'}`}>
              {groups.running.map((i) => <RunningCard key={i.id} ipo={i} clock={clock} />)}
            </div>
          ) : <Empty Icon={Timer} title="Nothing running right now" note="An offering runs its term once its book closes." />)}

          {tab === 'finished' && (groups.finished.length ? (
            <>
              <p className="text-xs text-slate-ink">{closedOut}</p>
              <div className={`grid gap-4 md:grid-cols-2 ${side ? '2xl:grid-cols-3' : 'xl:grid-cols-3'}`}>
                {groups.finished.map((i) => <Done key={i.id} ipo={i} />)}
              </div>
              <p className="text-xs text-slate-ink">
                The return shown is the offering's ROI accrued over its term, not a movement
                in the company's share price.
              </p>
            </>
          ) : <Empty Icon={CheckCircle2} title="Nothing has finished yet" note="Matured and withdrawn offerings are kept here as a record." />)}
        </section>
      )}
      </div>

      {side && (
        <aside className="min-w-0 space-y-4">
          {!verified && (
            <div className="x-card x-holo space-y-3 p-4">
              <div className="flex items-center gap-3">
                <span className="x-chip" aria-hidden><ShieldCheck size={18} /></span>
                <p className="text-[14px] font-semibold">Verify to subscribe</p>
              </div>
              <p className="text-xs text-slate-ink">Subscriptions are open to verified accounts. Send your identity documents and the desk will review them.</p>
              <a href="#/documents" className={`${btn} inline-flex w-full items-center justify-center gap-2`}><FileText size={15} aria-hidden />Go to Documents</a>
            </div>
          )}
          {!!held.length && <Positions held={held} clock={clock} />}
        </aside>
      )}
      </div>
    </div>
  );
}

const Empty = ({ Icon, title, note }: { Icon: typeof Rocket; title: string; note: string }) => (
  <div className="grid place-items-center gap-2 py-10 text-center">
    <span className="x-drop-icon" aria-hidden><Icon size={24} /></span>
    <p className="text-[15px] font-semibold">{title}</p>
    <p className="max-w-sm text-xs text-slate-ink">{note}</p>
  </div>
);

/** When an offering pays out: its maturity date, or close plus term where none is set yet. */
const maturesOf = (i: Ipo) => i.matures_at ? new Date(i.matures_at)
  : i.closes_at ? new Date(new Date(i.closes_at).getTime() + i.term_days * 86_400_000) : null;

/**
 * The client's money across offerings, and the next thing that happens on the shelf.
 * Amounts are summed per currency; offerings are priced in one currency in practice, and
 * where they are not the tile says how many currencies it is counting rather than adding
 * dollars to euros.
 */
function Totals({ list, held, clock, loading }: { list: Ipo[]; held: Ipo[]; clock: number; loading: boolean }) {
  const ccys = [...new Set(held.map((i) => i.subscription!.currency))];
  const one = ccys.length <= 1 ? ccys[0] ?? 'USD' : null;
  const invested = held.reduce((n, i) => n + Number(i.subscription!.amount), 0);
  const earned = held.reduce((n, i) => n + Number(i.subscription!.accrued), 0);
  const inBook = held.filter((i) => i.group === 'incoming').length;
  const events = list.flatMap((i) => {
    const e: [number, string, string][] = [];
    if (i.status === 'upcoming' && i.opens_at) e.push([new Date(i.opens_at).getTime(), `${i.name} opens`, i.opens_at]);
    if (i.status === 'open' && i.closes_at) e.push([new Date(i.closes_at).getTime(), `${i.name} closes`, i.closes_at]);
    if (i.subscription?.status === 'active' && i.matures_at) e.push([new Date(i.matures_at).getTime(), `${i.name} matures`, i.matures_at]);
    return e;
  }).filter(([t]) => t > clock).sort((a, b) => a[0] - b[0]);
  const next = events[0];
  const shownInvested = useCountUp(loading ? null : invested);
  const skel = <span className="skeleton inline-block h-5 w-28" />;

  return (
    <div className="ip-tiles grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatTile label="Invested" Icon={Wallet} tone="text-ember-ink"
        value={shownInvested === null ? skel : one ? money(shownInvested, one) : `${ccys.length} currencies`}
        note={held.length ? `In ${held.length} offering${held.length === 1 ? '' : 's'}` : 'Nothing subscribed yet'} />
      <StatTile label="Earned so far" Icon={TrendingUp} tone="text-up"
        value={loading ? skel : one ? `+${fixed(earned)} ${one}` : '—'} note="Credited daily, paid at maturity" />
      <StatTile label="Your positions" Icon={Layers} value={loading ? skel : `${held.length}`}
        note={held.length ? `${held.length - inBook} running · ${inBook} in an open book` : 'Subscribe while a book is open'} />
      <StatTile label="Next on the shelf" Icon={Timer}
        value={loading ? skel : next ? <span aria-live="off" className="tabular-nums">{countdown(next[0] - clock)}</span> : 'Nothing scheduled'}
        note={next ? `${next[1]} · ${day(next[2])}` : 'Dates are set by the desk'} />
    </div>
  );
}

/** What the client holds: one compact row each, with the next thing that happens to it. */
function Positions({ held, clock }: { held: Ipo[]; clock: number }) {
  return (
    <section className="x-card x-holo space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="section-title">Your positions</h2>
        <span className="x-badge is-muted ml-auto">{held.length}</span>
      </div>
      <ul className="ip-pos">
        {held.map((i) => {
          const s = i.subscription!;
          const inBook = i.group === 'incoming';
          const at = inBook ? i.closes_at : i.matures_at;
          const elapsed = dayOfTerm(i.closes_at, i.term_days, clock);
          const share = inBook ? 0 : elapsed === null ? 0 : elapsed / i.term_days;
          return (
            <li key={i.id}>
              <div className="flex items-center gap-2.5">
                <span className="ip-thumb !h-8 !w-12" style={markTint(i.asset) ? ({ '--mark': markTint(i.asset) } as React.CSSProperties) : undefined}>
                  <IpoMark asset={i.asset} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{i.name}</span>
                  <span className="block text-[11.5px] text-slate-ink tabular-nums">
                    {money(s.amount, s.currency)} · <span className="text-up">+{fixed(s.accrued)}</span>
                  </span>
                </span>
                <span className={`x-badge ${inBook ? 'is-locked' : ''}`}>{inBook ? 'Book open' : 'Running'}</span>
              </div>
              <div className="mt-2 flex items-baseline justify-between text-[11px] text-slate-ink">
                <span>{inBook ? 'Book closes in' : `Day ${elapsed ?? 0} of ${i.term_days}`}</span>
                <span aria-live="off" className="font-semibold tabular-nums text-ember-ink">
                  {at ? (inBook ? countdown(new Date(at).getTime() - clock) : `Matures ${day(at)}`) : '—'}
                </span>
              </div>
              {!inBook && <div className="sk-track mt-1 !h-1.5"><span style={{ width: `${Math.max(2, share * 100)}%` }} /></div>}
              <p className="mt-1.5 text-[11px] text-slate-ink">
                ≈ {money(Number(s.amount) * (1 + Number(i.estimated_return_pct)), s.currency)} back at maturity
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const Mini = ({ label, value, sub, tone = '', lead }: { label: string; value: string; sub?: string; tone?: string; lead?: boolean }) => (
  <div className={`x-mini-tile min-w-0 ${lead ? 'sk-lead' : ''}`}>
    <p className="text-[11.5px] text-mist">{label}</p>
    <p className={`mt-1 truncate text-[14px] font-semibold tabular-nums ${tone}`} title={value}>{value}</p>
    {sub && <p className="truncate text-[11px] text-slate-ink">{sub}</p>}
  </div>
);

/** How much of the book is taken: raised against target. */
function Raised({ ipo, opening }: { ipo: Ipo; opening: boolean }) {
  const share = opening ? 0 : Math.round((ipo.progress ?? 0) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11.5px]">
        <span className="text-slate-ink">{opening ? 'Target' : `${share}% raised`}</span>
        <span className="tabular-nums text-slate-ink">
          {opening ? money(ipo.target_amount, ipo.currency) : `${num(ipo.raised)} / ${money(ipo.target_amount, ipo.currency)}`}
        </span>
      </div>
      <div className="sk-track mt-1.5 !h-1.5" role="img" aria-label={opening ? 'Not yet open' : `${share}% of target raised`}>
        <span style={{ width: `${Math.max(opening ? 0 : 2, share)}%` }} />
      </div>
    </div>
  );
}

/**
 * The figures an offering is decided on, in one row. Estimated return leads: it is the
 * return over this offering's own term rather than a yearly rate, said with the term beside
 * it so nobody reads a 180-day figure as a year's.
 */
const Facts = ({ ipo }: { ipo: Ipo }) => (
  <dl className="ip-facts">
    <div>
      <dt>Est. return</dt>
      <dd className="!text-[19px] text-ember-ink">+{(ipo.estimated_return_pct * 100).toFixed(2)}%</dd>
    </div>
    <div><dt>Term</dt><dd>{term(ipo.term_days)}</dd></div>
    <div><dt>Minimum</dt><dd>{money(ipo.min_subscription, ipo.currency)}</dd></div>
  </dl>
);

/** The picture with the offering's name, status and valuation laid over it. */
function Hero({ ipo, badge }: { ipo: Ipo; badge: React.ReactNode }) {
  return (
    <div className="ip-hero">
      <Picture ipo={ipo} />
      <div className="ip-hero-top">
        {badge}
        {ipo.valuation && <span className="ip-chip">Valued {ipo.valuation}</span>}
      </div>
      <div className="ip-hero-foot">
        <h3 className="truncate text-[17px] font-bold text-white">{ipo.name}</h3>
        <p className="text-[11.5px] font-semibold tracking-wide text-[#ffb066]">{ipo.asset}</p>
      </div>
    </div>
  );
}

/** An offering taking subscriptions, or about to. */
function Offer({ ipo, on, clock, onDone, staff, available, verified }: {
  ipo: Ipo; on: On; clock: number; onDone: () => void; staff: boolean; available: number | null; verified: boolean;
}) {
  const [open, setOpen] = useState(false);
  const opening = ipo.status === 'upcoming';
  const target = opening ? ipo.opens_at : ipo.closes_at;
  const left = target ? new Date(target).getTime() - clock : null;

  return (
    <article className="ip-card">
      <Hero ipo={ipo} badge={opening
        ? <span className="x-badge is-muted">Upcoming</span>
        : <span className="x-badge"><i className="nav-live mr-1.5 block size-1.5 rounded-full bg-up" aria-hidden />Open</span>} />
      <div className="space-y-3.5 p-4">
        <p className="line-clamp-2 text-xs text-slate-ink" title={ipo.summary}>{ipo.summary}</p>
        <Facts ipo={ipo} />
        <Raised ipo={ipo} opening={opening} />

        {ipo.subscription && (
          <p className="flex items-center gap-1.5 text-xs text-up">
            <CheckCircle2 size={13} aria-hidden />You have {money(ipo.subscription.amount, ipo.subscription.currency)} in this offering.
          </p>
        )}

        {open && !opening ? (
          <Subscribe ipo={ipo} on={on} available={available} onCancel={() => setOpen(false)} onDone={() => { setOpen(false); onDone(); }} />
        ) : (
          <div className="ip-foot">
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-[11px] text-mist"><Timer size={12} aria-hidden />{opening ? 'Opens in' : 'Closes in'}</span>
              <span aria-live="off" className="block truncate text-[14px] font-semibold tabular-nums text-ember-ink">
                {left === null ? (opening ? 'To be announced' : '—') : left <= 0 ? 'Refreshing…' : countdown(left)}
              </span>
            </span>
            {/* Upcoming says when rather than showing a button that cannot work. */}
            {opening ? (
              <span className="text-right text-[11.5px] text-slate-ink">{ipo.opens_at ? `Opens ${day(ipo.opens_at)}` : 'Nothing is taken until it opens'}</span>
            ) : (
              <button className={`${btn} shrink-0`} onClick={() => setOpen(true)} disabled={!verified}
                title={verified ? undefined : 'Verify your account first'}>
                {staff ? 'Subscribe for client' : ipo.subscription ? 'Add more' : 'Subscribe'}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/** An offering working its term: the book is closed, so it is shown, not offered. */
function RunningCard({ ipo, clock }: { ipo: Ipo; clock: number }) {
  const elapsed = dayOfTerm(ipo.closes_at, ipo.term_days, clock);
  const left = ipo.matures_at ? new Date(ipo.matures_at).getTime() - clock : null;
  return (
    <article className="ip-card">
      <Hero ipo={ipo} badge={<span className="x-badge is-locked">Running</span>} />
      <div className="space-y-3.5 p-4">
        <p className="line-clamp-2 text-xs text-slate-ink" title={ipo.summary}>{ipo.summary}</p>
        <Facts ipo={ipo} />
        {elapsed !== null && (
          <div>
            <div className="flex items-baseline justify-between text-[11.5px] text-slate-ink">
              <span>Day {elapsed} of {ipo.term_days}</span>
              <span aria-live="off" className="font-semibold tabular-nums text-ember-ink">
                {left === null ? '' : left <= 0 ? 'Settling…' : `Matures in ${countdown(left)}`}
              </span>
            </div>
            <div className="sk-track mt-1.5 !h-1.5"><span style={{ width: `${Math.max(2, (elapsed / ipo.term_days) * 100)}%` }} /></div>
          </div>
        )}
        <p className="text-xs text-slate-ink">
          {ipo.subscription
            ? <>You have {money(ipo.subscription.amount, ipo.subscription.currency)} in this one.</>
            : <>The book closed{ipo.closes_at ? ` on ${day(ipo.closes_at)}` : ''}. It pays out at maturity.</>}
        </p>
      </div>
    </article>
  );
}

/** A settled or cancelled offering: a record, and quieter for it. */
function Done({ ipo }: { ipo: Ipo }) {
  const mine = ipo.subscription;
  const cancelled = ipo.status === 'cancelled';
  return (
    <article className="sk-card space-y-3">
      <div className="flex items-start gap-3">
        <span className="ip-thumb" style={markTint(ipo.asset) ? ({ '--mark': markTint(ipo.asset) } as React.CSSProperties) : undefined}>
          <IpoMark asset={ipo.asset} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-semibold">{ipo.name}</h3>
          <p className="text-[11.5px] text-slate-ink">
            {pct(ipo.roi_rate)} over {term(ipo.term_days)}
            {ipo.matures_at && ` · ${cancelled ? 'withdrawn' : 'matured'} ${day(ipo.matures_at)}`}
          </p>
        </div>
        <span className={`x-badge ${cancelled ? 'is-muted' : ''}`}>{cancelled ? 'Withdrawn' : 'Matured'}</span>
      </div>
      <p className="line-clamp-2 text-xs text-slate-ink">{ipo.summary}</p>
      {mine ? (
        <div className="grid grid-cols-3 gap-2">
          <Mini label="Subscribed" value={fixed(mine.amount)} />
          <Mini label={cancelled ? 'Refunded' : 'Returned'} value={fixed(cancelled ? mine.amount : Number(mine.amount) + Number(mine.accrued))} />
          {/* A cancellation is not a loss and is not coloured like one. */}
          <Mini label="Return" value={cancelled ? '0.00%' : `+${((Number(mine.accrued) / Number(mine.amount)) * 100).toFixed(2)}%`}
            tone={cancelled ? '' : 'text-up'} />
        </div>
      ) : (
        <p className="text-xs text-slate-ink">You had nothing in this one. Subscribers were paid principal and accrued ROI{cancelled ? ' back in full' : ' at maturity'}.</p>
      )}
    </article>
  );
}

/** The offering's picture, or a mark in its place so a half-prepared one is not broken. */
/**
 * The offering's uploaded picture, or its drawn mark when there is none.
 *
 * Falling back on an error as well as on has_image matters more than it looks: a picture
 * uploaded before pictures moved into the database may have gone with the container it was
 * written to, and a card that degrades to its mark is better than one with a broken image
 * in it. Nothing here tells the client which of the two they are looking at.
 */
function Picture({ ipo }: { ipo: Ipo }) {
  // Fetched with the token rather than pointed at by an <img src>, which cannot carry one.
  const { src } = useAuthedImage(
    ipo.has_image ? `/api/ipos/${ipo.id}/image?v=${ipo.image_key}` : null, ipo.image_key);
  const tint = markTint(ipo.asset);
  return (
    // The frame's wash takes the offering's own colour, so a card is found by its colour
    // before anybody reads its name. An uploaded picture covers the wash entirely.
    <span className="shot block" style={tint ? ({ '--mark': tint } as React.CSSProperties) : undefined}>
      {src ? <img src={src} alt={ipo.name} /> : <IpoMark asset={ipo.asset} />}
    </span>
  );
}

/**
 * Subscribing. The ceiling offered is the smallest of what is held, what is left in the book
 * and the offering's maximum; the server re-checks every one of them, and the window, so
 * this form's beliefs are a convenience and never an authorisation.
 */
function Subscribe({ ipo, on, available, onCancel, onDone }: {
  ipo: Ipo; on: On; available: number | null; onCancel: () => void; onDone: () => void;
}) {
  const [amount, setAmount] = useState(String(ipo.min_subscription || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ceiling = Math.min(
    available ?? Infinity, Number(ipo.remaining), ipo.max_subscription ?? Infinity);
  const n = Number(amount);
  const tooSmall = !!amount && n < Number(ipo.min_subscription);
  const tooBig = !!amount && Number.isFinite(ceiling) && n > ceiling;
  const mat = maturesOf(ipo);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/ipos/${ipo.id}/subscribe`, {
        method: 'POST', body: JSON.stringify({ ...on, amount: n }),
      });
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="pt-move space-y-3">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold">Amount</span>
        {available !== null && (
          <span className="text-slate-ink">Available <span className="font-semibold tabular-nums text-obsidian dark:text-vellum">{money(available, ipo.currency)}</span></span>
        )}
      </div>
      <div className="sk-amount">
        <input className={`${field} w-full`} type="number" step="any" required autoFocus inputMode="decimal"
          aria-label={`Amount in ${ipo.currency}`}
          min={ipo.min_subscription || undefined} max={ipo.max_subscription ?? undefined}
          value={amount} onChange={(e) => setAmount(e.target.value)} />
        <span className="sk-amount-unit">{ipo.currency}</span>
      </div>
      {Number.isFinite(ceiling) && ceiling > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {([['Min', Number(ipo.min_subscription)], ['25%', ceiling * 0.25], ['50%', ceiling * 0.5], ['Max', ceiling]] as const).map(([label, v]) => (
            <button key={label} type="button" className="x-btn-sm !h-7 !px-0 text-[11.5px]" disabled={v < Number(ipo.min_subscription) || v > ceiling}
              onClick={() => setAmount(String(Math.floor(v * 100) / 100))}>{label}</button>
          ))}
        </div>
      )}
      {tooSmall && <p className="text-xs text-down">The minimum is {money(ipo.min_subscription, ipo.currency)}.</p>}
      {tooBig && <p className="text-xs text-down">The most you can put in here is {money(ceiling, ipo.currency)}.</p>}
      {available === 0 && (
        <p className="text-xs text-slate-ink">You hold no {ipo.currency}. <a href="#/wallet" className="text-ember-ink hover:underline">Open your wallet</a> to add some.</p>
      )}
      {n > 0 && !tooSmall && !tooBig && (
        <div className="sk-summary">
          <p>
            <b className="tabular-nums">{money(n, ipo.currency)}</b> is taken from your {ipo.currency} balance now.
            {mat && <> At maturity on <b>{day(mat.toISOString())}</b> you receive about <b className="tabular-nums">{money(n * (1 + Number(ipo.estimated_return_pct)), ipo.currency)}</b>.</>}
          </p>
          <p className="mt-1 text-[11.5px] text-slate-ink">{num(ipo.remaining)} {ipo.currency} left in this offering{ipo.max_subscription !== null ? ` · maximum ${num(ipo.max_subscription)}` : ''}.</p>
        </div>
      )}
      {error && <p role="alert" className={alertBox}>{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button className={`${btn} flex-1`} disabled={busy || !(n > 0) || tooSmall || tooBig}>
          {busy ? 'Subscribing…' : n > 0 ? `Subscribe ${money(n, ipo.currency)}` : 'Enter an amount'}
        </button>
        <button type="button" className="x-btn-sm !h-auto" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
