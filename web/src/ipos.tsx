import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { alertBox, btn, card, field, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { useCountUp } from './count-up.ts';

/**
 * IPO offerings for the client: what is running, what is coming, what has finished.
 *
 * Built as a panel rather than a page so the client workspace can embed it for staff the
 * same way it embeds portfolios and staking — hence the `on` convention below.
 *
 * The one deliberate difference from those two: the ROI is shown. A portfolio or staking
 * rate is agreed with the desk and stays the desk's, which is why it was taken off those
 * screens. An offering's ROI is its public pitch and the thing a client is deciding on. A
 * per-client override is still private and appears only on the desk side.
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
  opens_at: string | null; closes_at: string | null; matures_at: string | null;
  status: string; group: Group; raised: number; remaining: number; progress: number | null;
  has_image: boolean; server_time: string;
  subscription: Subscription | null;
};

type On = { client_id?: string };

const pct = (n: number) => `${Number((n * 100).toFixed(2))}%`;
const num = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });
/** Money, to the minor unit. The database keeps eighteen decimals; a reader wants two. */
const fixed = (n: number) =>
  Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number, ccy: string) =>
  `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${ccy}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, {
  day: 'numeric', month: 'short', year: 'numeric',
});
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

  const refresh = () => { rows.reload(); onChanged?.(); };

  if (rows.error) return <p role="alert" className={alertBox}>{rows.error}</p>;

  return (
    <div className="stagger space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>IPO offerings</PageTitle>
        {!clientId && (
          <span className="text-xs text-slate-ink">
            subscribe with money you hold — ROI is credited daily and paid at maturity
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
                <span className="text-xs text-slate-ink">annual ROI, paid daily on what you put in</span>
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
                  <span className="text-xs text-slate-ink">
                    {groups.finished.length} closed out
                  </span>
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {groups.finished.map((i) => <Done key={i.id} ipo={i} />)}
                </div>
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
  return (
    <div className={`flex flex-wrap items-center gap-x-6 gap-y-2 ${
      first ? '' : 'mt-3 border-t border-pebble pt-3 dark:border-white/10'}`}>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{ipo.name}</span>
          <span className="rounded-full bg-ember/15 px-2 py-0.5 font-mono text-[10px] tracking-wide text-ember-ink uppercase">
            {ipo.status}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-slate-ink">
          {pct(ipo.roi_rate)} over {term(ipo.term_days)}
          {ipo.matures_at && ` · matures ${day(ipo.matures_at)}`}
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
  const shown = useCountUp(Number(ipo.roi_rate) * 100);

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

      <dl className="grid grid-cols-3 gap-2">
        <div>
          <dt className="metric-label">ROI</dt>
          <dd className="font-mono text-xl leading-none font-medium tabular-nums text-ember-ink">
            {shown === null ? '—' : `${Number(shown.toFixed(2))}%`}
          </dd>
        </div>
        <div>
          <dt className="metric-label">Term</dt>
          <dd className="font-mono text-sm leading-none font-medium tabular-nums">{ipo.term_days}d</dd>
        </div>
        <div>
          <dt className="metric-label">Min</dt>
          <dd className="font-mono text-sm leading-none font-medium tabular-nums">
            {num(ipo.min_subscription)}
          </dd>
        </div>
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
            {/* A cancellation is not a loss and is not coloured like one: nothing was
                earned and nothing was lost. */}
            <dd className={`font-mono text-sm font-medium tabular-nums ${cancelled ? 'text-slate-ink' : 'text-up'}`}>
              {cancelled ? '0.00' : `+${fixed(mine.accrued)}`}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-xs text-slate-ink">You had nothing in this one.</p>
      )}
      <p className="text-xs text-slate-ink">
        {cancelled
          ? 'Refunded at exactly the amount debited, never a figure recomputed from a rate.'
          : 'Principal and accrued ROI were paid to your balance.'}
      </p>
    </article>
  );
}

/** The offering's picture, or a mark in its place so a half-prepared one is not broken. */
function Picture({ ipo }: { ipo: Ipo }) {
  const [failed, setFailed] = useState(false);
  if (!ipo.has_image || failed) {
    return (
      <span className="grid aspect-video place-items-center overflow-hidden rounded-md border border-pebble bg-bone/60 text-ember-ink dark:border-white/10 dark:bg-white/5"
        aria-hidden>
        <svg width="48" height="48" viewBox="0 0 44 44" fill="none" stroke="currentColor"
          strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.55">
          <path d="M6 32V18M15 32V10M24 32v-9M33 32V14" />
          <path d="M4 36h36" opacity="0.4" />
        </svg>
      </span>
    );
  }
  return (
    <img className="aspect-video w-full rounded-md border border-pebble object-cover dark:border-white/10"
      src={`/api/ipos/${ipo.id}/image`} alt={ipo.name} loading="lazy"
      onError={() => setFailed(true)} />
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

