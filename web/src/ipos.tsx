import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { alertBox, btn, card, field, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
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
  const list = rows.data ?? [];
  const clock = useServerClock(list[0]?.server_time);

  const groups = useMemo(() => ({
    running: list.filter((i) => i.group === 'running'),
    incoming: list.filter((i) => i.group === 'incoming'),
    finished: list.filter((i) => i.group === 'finished'),
  }), [list]);

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
   * folding it in would report nothing as if it were something. With no positions at all it
   * falls back to a count, because "0.00 returned above capital" reads as a loss.
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

  const refresh = () => { rows.reload(); onChanged?.(); };

  if (rows.error) return <p role="alert" className={alertBox}>{rows.error}</p>;

  return (
    <div className="stagger space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>IPO offerings</PageTitle>
        {/* Live means the page is ticking against the server's clock, not that any one
            offering is open — the per-card status says that. */}
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-ink/10 px-2.5 py-0.5 font-mono text-[10px] tracking-[0.14em] uppercase dark:bg-white/10">
          <i className="block size-1.5 rounded-full bg-up" aria-hidden />Live
        </span>
        {!clientId && (
          <span className="text-xs text-slate-ink">
            subscribe with money you hold — earnings are credited daily and paid at maturity
          </span>
        )}
      </div>

      {!rows.data ? (
        <p className="text-sm text-slate-ink">Loading…</p>
      ) : !list.length ? (
        <p className={`${card} py-10 text-center text-sm text-slate-ink`}>
          Nothing on the shelf yet. The desk publishes offerings here.
        </p>
      ) : (
        <>
          {/* Running leads: money already working is not history, and the brief is explicit
              that active must not be filed under finished. */}
          {!!groups.running.length && (
            <section className="space-y-2">
              <span className="section-title">Running</span>
              <div className={`${card} tile grain relative`}>
                <span className="tile-corner" aria-hidden />
                {groups.running.map((i, n) => (
                  <Running key={i.id} ipo={i} clock={clock} first={n === 0} />
                ))}
              </div>
            </section>
          )}

          {!!groups.incoming.length && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="section-title">Incoming</span>
                <span className="text-xs text-slate-ink">earnings are credited daily and paid at maturity</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {groups.incoming.map((i) => (
                  <Offer key={i.id} ipo={i} on={on} clock={clock} onDone={refresh} staff={!!clientId} />
                ))}
              </div>
            </section>
          )}

          {!!groups.finished.length && (
            <section>
              <details open className="border-t border-pebble pt-3 dark:border-white/10">
                <summary className="flex cursor-pointer flex-wrap items-center gap-3">
                  <span className="section-title">Finished projects</span>
                  <span className="text-xs text-slate-ink">{closedOut}</span>
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {groups.finished.map((i) => <Done key={i.id} ipo={i} />)}
                </div>
                {/* Where the company facts come from, and — more to the point — what the
                    return on these cards is and is not. Somebody reading a finished deal is
                    the most likely person to assume it tracked the share price. */}
                <p className="mt-3 text-xs text-slate-ink">
                  Company facts, dates and prices are drawn from public reporting on the 2026
                  IPO calendar. Allocations, ROI rates and terms are this desk's own, and the
                  return shown is the ROI accrued over the term rather than any movement in
                  the share price. Balances here are simulated and nothing on this page is a
                  securities offering or a transferable instrument.
                </p>
              </details>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** A position the client holds in an offering that is running. */
function Running({ ipo, clock, first }: { ipo: Ipo; clock: number; first: boolean }) {
  const mine = ipo.subscription;
  const left = ipo.matures_at ? new Date(ipo.matures_at).getTime() - clock : null;
  const elapsed = dayOfTerm(ipo.closes_at, ipo.term_days, clock);
  const [open, setOpen] = useState(false);
  const panel = `running-${ipo.id}`;

  return (
    <div className={first ? '' : 'mt-3 border-t border-pebble pt-3 dark:border-white/10'}>
      {/* A real button, not a div with an onClick: the row is reachable by Tab and opens on
          Enter or Space for free, which a div never does however it is styled. The whole row
          is the target rather than a small chevron — the thing being clicked is the offering,
          and a 14px hit area on a touch screen is not one. */}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={panel}
        className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 rounded-lg text-left transition-colors hover:bg-slate-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember dark:hover:bg-white/5">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{ipo.name}</span>
          <span className="rounded-full bg-ember/15 px-2 py-0.5 font-mono text-[10px] tracking-wide text-ember-ink uppercase">
            {ipo.status}
          </span>
        </span>
        {/* The rate is off the client page by decision of the desk: what a client holds,
            what it has earned and when it matures are theirs to see; the rate behind it is
            the desk's, the way a portfolio's and a stake's already were. The term stays,
            because it says when the money comes back. */}
        <span className="mt-0.5 block text-xs text-slate-ink">
          Over {term(ipo.term_days)}
          {ipo.closes_at && `, from the ${day(ipo.closes_at)} listing`}
          {elapsed !== null && `. Day ${elapsed} of ${ipo.term_days}`}
          {ipo.matures_at && ` — matures ${day(ipo.matures_at)}`}
        </span>
      </span>
      {mine ? (
        <>
          <span className="text-right">
            <span className="metric-label block">Subscribed</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums">
              {money(mine.amount, mine.currency)}
            </span>
          </span>
          <span className="text-right">
            <span className="metric-label block">Earned</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums text-up">
              +{fixed(mine.accrued)}
            </span>
          </span>
        </>
      ) : (
        <span className="text-xs text-slate-ink">You have nothing in this one.</span>
      )}
      <span className="text-right">
        <span className="metric-label block">Matures in</span>
        {/* aria-live off: a value changing every second must not be announced every second. */}
        <span aria-live="off" className="block font-mono text-xs tabular-nums text-ember-ink">
          {left === null ? '—' : left <= 0 ? 'settling…' : countdown(left)}
        </span>
      </span>
      <span aria-hidden className={`font-mono text-ember-ink transition-transform duration-200 ${
        open ? 'rotate-90' : ''}`}>›</span>
      </button>

      {/* Unfolded, a running offering reads like it did on the shelf: the same picture, the
          same summary, the same facts. What is different is that it is no longer an offer —
          the book is closed and the bar is what was raised, not what is still to be. */}
      {open && (
        <div id={panel} className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,240px)_1fr]">
          <Picture ipo={ipo} />
          <div className="space-y-3">
            <p className="text-xs text-slate-ink">{ipo.summary}</p>
            {ipo.description && <p className="text-xs text-slate-ink">{ipo.description}</p>}

            <div className="flex items-baseline gap-2">
              <span className="metric-label">Est. return</span>
              <span className="font-mono text-lg leading-none font-medium tabular-nums text-ember-ink">
                +{(ipo.estimated_return_pct * 100).toFixed(2)}%
              </span>
              <span className="text-xs text-slate-ink">over {term(ipo.term_days)}</span>
            </div>

            <dl className={`grid gap-2 ${ipo.valuation ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <div>
                <dt className="metric-label">Term</dt>
                <dd className="font-mono text-sm leading-none font-medium tabular-nums">{ipo.term_days}d</dd>
              </div>
              {/* The same three facts the shelf shows, and no more: the listing date and the
                  day of the term are already in the line above, and repeating them two
                  centimetres apart is noise rather than emphasis. */}
              <div>
                <dt className="metric-label">Min</dt>
                <dd className="font-mono text-sm leading-none font-medium tabular-nums">
                  {num(ipo.min_subscription)}
                </dd>
              </div>
              {ipo.valuation && (
                <div>
                  <dt className="metric-label">Valuation</dt>
                  <dd className="font-mono text-sm leading-none font-medium tabular-nums">{ipo.valuation}</dd>
                </div>
              )}
            </dl>

            <div>
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-ink">Raised</span>
                <span className="font-mono tabular-nums">
                  {num(ipo.raised)} / {money(ipo.target_amount, ipo.currency)}
                </span>
              </div>
              <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-slate-ink/20"
                role="img" aria-label={`${Math.round((ipo.progress ?? 0) * 100)}% of target raised`}>
                <span className="bar-x block h-[3px] rounded-full bg-ember"
                  style={{ width: `${Math.round((ipo.progress ?? 0) * 100)}%` }} />
              </div>
            </div>

            {/* The term is closed, so there is nothing to subscribe to and no button that
                could do anything. Saying why is better than an absence somebody reads as a
                bug, or a disabled control they keep pressing. */}
            <p className="text-xs text-slate-ink">
              The book closed on {ipo.closes_at ? day(ipo.closes_at) : 'listing'}. This one is
              working its term — nothing more can be put in, and it pays out at maturity.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** An offering taking subscriptions, or about to. */
function Offer({ ipo, on, clock, onDone, staff }: {
  ipo: Ipo; on: On; clock: number; onDone: () => void; staff: boolean;
}) {
  const [open, setOpen] = useState(false);
  const opening = ipo.status === 'upcoming';
  const target = opening ? ipo.opens_at : ipo.closes_at;
  const left = target ? new Date(target).getTime() - clock : null;

  return (
    <article className={`${card} tile lift grain relative space-y-2.5`}>
      <span className="tile-corner" aria-hidden />
      <Picture ipo={ipo} />

      <div className="flex items-center justify-between">
        <span className="rounded-md bg-ember/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-ember-ink">
          {ipo.asset}
        </span>
        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${
          ipo.status === 'open'
            ? 'bg-ember/15 text-ember-ink'
            : 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'}`}>
          {ipo.status}
        </span>
      </div>

      <h3 className="text-sm font-medium">{ipo.name}</h3>
      <p className="text-xs text-slate-ink">{ipo.summary}</p>

      {/* No ROI here: the rate is the desk's, and only a finished offering shows what it
          actually returned. The term leads instead, in the size the rate had — a card still
          needs one figure to read from across the page, and "how long is my money in" is the
          honest candidate once the rate has gone. */}
      {/* Estimated return leads, because it is the thing being decided on. It is the return
          over this offering's own term rather than a yearly rate — 7.25% a year across 180
          days is 3.52%, and printing the annual figure beside a 180-day term is how somebody
          ends up expecting twice what they get. "Estimated" because the desk can change the
          rate on a live offering, not because the arithmetic is uncertain. */}
      {/* On its own line rather than squeezed into the fact grid: "Est. return" does not fit
          a quarter of a card at this tracking, and the figure is the one being decided on
          anyway. Saying "over 180 days" beside it is the whole point — the number is this
          term's, not a year's. */}
      <div className="flex items-baseline gap-2">
        <span className="metric-label">Est. return</span>
        <span className="font-mono text-xl leading-none font-medium tabular-nums text-ember-ink">
          +{(ipo.estimated_return_pct * 100).toFixed(2)}%
        </span>
        <span className="text-xs text-slate-ink">over {term(ipo.term_days)}</span>
      </div>

      <dl className={`grid gap-2 ${ipo.valuation ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <div>
          <dt className="metric-label">Term</dt>
          <dd className="font-mono text-sm leading-none font-medium tabular-nums">
            {ipo.term_days}d
          </dd>
        </div>
        <div>
          <dt className="metric-label">Min</dt>
          <dd className="font-mono text-sm leading-none font-medium tabular-nums">
            {num(ipo.min_subscription)}
          </dd>
        </div>
        {/* The valuation the deal is talked about at. Absent on an offering the desk has not
            given one, and the grid closes up rather than leaving a labelled hole. */}
        {ipo.valuation && (
          <div>
            <dt className="metric-label">Valuation</dt>
            <dd className="font-mono text-sm leading-none font-medium tabular-nums">{ipo.valuation}</dd>
          </div>
        )}
      </dl>

      <div>
        <div className="flex justify-between text-[11px]">
          <span className="text-slate-ink">{opening ? 'Target' : 'Raised'}</span>
          <span className="font-mono tabular-nums">
            {opening
              ? money(ipo.target_amount, ipo.currency)
              : `${num(ipo.raised)} / ${money(ipo.target_amount, ipo.currency)}`}
          </span>
        </div>
        <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-slate-ink/20"
          role="img" aria-label={ipo.progress === null ? 'not yet open'
            : `${Math.round(ipo.progress * 100)}% of target raised`}>
          <span className="bar-x block h-[3px] rounded-full bg-ember"
            style={{ width: `${opening ? 0 : Math.round((ipo.progress ?? 0) * 100)}%` }} />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="metric-label">{opening ? 'Opens in' : 'Closes in'}</span>
        <span aria-live="off" className="font-mono text-xs tabular-nums text-ember-ink">
          {left === null ? '—' : left <= 0 ? 'refreshing…' : countdown(left)}
        </span>
      </div>

      {ipo.subscription && (
        <p className="text-xs text-slate-ink">
          You have {money(ipo.subscription.amount, ipo.subscription.currency)} in this offering.
        </p>
      )}

      {/* Upcoming shows the action disabled with a reason rather than nothing at all: an
          absent button reads as a broken card. */}
      {opening ? (
        <p className="text-xs text-slate-ink">
          Opens {ipo.opens_at && day(ipo.opens_at)}. Nothing is taken until then.
        </p>
      ) : open ? (
        <Subscribe ipo={ipo} on={on} onDone={() => { setOpen(false); onDone(); }} />
      ) : (
        <button className={`${btn} w-full`} onClick={() => setOpen(true)}>
          {staff ? 'Subscribe for this client' : 'Subscribe'}
        </button>
      )}
    </article>
  );
}

/** A settled or cancelled offering: a record, and quieter for it. */
function Done({ ipo }: { ipo: Ipo }) {
  const mine = ipo.subscription;
  const cancelled = ipo.status === 'cancelled';
  return (
    <article className={`${card} space-y-2.5`}>
      <div className="flex items-center justify-between">
        <span className="rounded-md bg-ember/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-ember-ink">
          {ipo.asset}
        </span>
        <span className="rounded-full bg-bone px-2 py-0.5 font-mono text-[10px] tracking-wide text-slate-ink uppercase dark:bg-white/10 dark:text-mist">
          {ipo.status}
        </span>
      </div>
      <h3 className="text-sm font-medium">{ipo.name}</h3>
      {/* The company, not just the terms: a settled deal is a record of what it was, and the
          summary is the only thing on the card that says what the business does. */}
      <p className="text-xs text-slate-ink">{ipo.summary}</p>
      <p className="text-xs text-slate-ink">
        {pct(ipo.roi_rate)} over {term(ipo.term_days)}
        {ipo.matures_at && ` · ${cancelled ? 'withdrawn' : 'matured'} ${day(ipo.matures_at)}`}
      </p>
      {mine ? (
        <dl className="grid grid-cols-3 gap-2">
          <div>
            <dt className="metric-label">Subscribed</dt>
            <dd className="font-mono text-sm font-medium tabular-nums">{fixed(mine.amount)}</dd>
          </div>
          <div>
            <dt className="metric-label">{cancelled ? 'Refunded' : 'Returned'}</dt>
            <dd className="font-mono text-sm font-medium tabular-nums">
              {fixed(cancelled ? mine.amount : Number(mine.amount) + Number(mine.accrued))}
            </dd>
          </div>
          <div>
            <dt className="metric-label">Return</dt>
            {/* As a percentage of what went in, which is the figure that compares across two
                deals of different sizes — 21.71 on 2,500 and 20.09 on 1,000 are not ranked
                the way the amounts suggest.
                A cancellation is not a loss and is not coloured like one: nothing was
                earned and nothing was lost. */}
            <dd className={`font-mono text-sm font-medium tabular-nums ${cancelled ? 'text-slate-ink' : 'text-up'}`}>
              {cancelled ? '0.00%' : `+${((Number(mine.accrued) / Number(mine.amount)) * 100).toFixed(2)}%`}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-xs text-slate-ink">You had nothing in this one.</p>
      )}
      <p className="text-xs text-slate-ink">
        {!mine
          ? 'Subscribers were paid principal and accrued ROI when it matured.'
          : cancelled
            ? 'Refunded at exactly the amount debited, never a figure recomputed from a rate.'
            : 'Principal and accrued ROI were paid to your balance.'}
      </p>
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

/** Labels, not placeholders. The server re-checks everything this form believes. */
function Subscribe({ ipo, on, onDone }: { ipo: Ipo; on: On; onDone: () => void }) {
  const [amount, setAmount] = useState(String(ipo.min_subscription || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/ipos/${ipo.id}/subscribe`, {
        method: 'POST', body: JSON.stringify({ ...on, amount: Number(amount) }),
      });
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-2 border-t border-pebble pt-2.5 dark:border-white/10">
      <label className="block">
        <span className="metric-label">Amount in {ipo.currency}</span>
        <input className={`${field} mt-1 w-full`} type="number" step="any" required
          min={ipo.min_subscription || undefined}
          max={ipo.max_subscription ?? undefined}
          value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <p className="text-xs text-slate-ink">
        {num(ipo.remaining)} {ipo.currency} left in this offering.
        {ipo.max_subscription !== null && ` Maximum ${num(ipo.max_subscription)}.`}
      </p>
      {error && <p role="alert" className={alertBox}>{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button className={btn} disabled={busy}>{busy ? 'Subscribing…' : 'Confirm'}</button>
        <button type="button" className="rounded-full border border-pebble px-3 py-1.5 text-sm text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
          onClick={onDone}>Cancel</button>
      </div>
      <p className="text-xs text-slate-ink">
        Taken from your {ipo.currency} balance now, not at close. Simulated balances — nothing
        here is a securities offering.
      </p>
    </form>
  );
}

