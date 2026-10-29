import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Clock, Gift, Megaphone, Percent, Rocket, Trophy, X, type LucideIcon } from 'lucide-react';
import { api, useApi } from './api.ts';

/**
 * Offers from the desk, as the client meets them: a pop-up the first time a live offer is
 * seen (once, then never again), and a list on the Arena page with what each has paid them.
 * The pop-up says the terms in one sentence and where to go to take part; it never asks for
 * anything itself.
 */

export type Offer = {
  id: number; kind: string; title: string; body: string; terms: string; ends_at: string | null; product: string | null;
  popup: boolean; grants: { amount: number; status: 'pending' | 'paid' | 'declined'; at: string }[];
};

export const OFFER_ICON: Record<string, LucideIcon> = {
  deposit_bonus: Gift, product_bonus: Rocket, achievement_multiplier: Percent, league_prize: Trophy, announcement: Megaphone,
};

/** Where taking part happens, for each kind of offer. */
export function offerAction(o: { kind: string; product: string | null }): [string, string] | null {
  if (o.kind === 'deposit_bonus') return ['#/support', 'Arrange a deposit'];
  if (o.kind === 'product_bonus') return o.product === 'stake' ? ['#/staking', 'Start a stake'] : o.product === 'pot' ? ['#/portfolios', 'Pay into a pot'] : ['#/ipos', 'See the offerings'];
  if (o.kind === 'achievement_multiplier' || o.kind === 'league_prize') return ['#/arena', 'Go to the Arena'];
  return null;
}

export function timeLeft(to: string | null) {
  if (!to) return 'No end date';
  const ms = new Date(to).getTime() - Date.now();
  if (ms <= 0) return 'Ending now';
  const d = Math.floor(ms / 86_400_000), h = Math.floor((ms % 86_400_000) / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return d ? `${d}d ${h}h left` : h ? `${h}h ${m}m left` : `${m}m left`;
}

/** The pop-up: the first live offer this client has not seen yet. Shown once per offer. */
export function OfferPopup() {
  const offers = useApi<Offer[]>('/me/offers');
  const [gone, setGone] = useState<number[]>([]);
  const next = (offers.data ?? []).find((o) => o.popup && !gone.includes(o.id));
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (next) close.current?.focus(); }, [next?.id]);
  useEffect(() => {
    if (!next) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!next) return null;
  const Icon = OFFER_ICON[next.kind] ?? Gift;
  const action = offerAction(next);

  function dismiss() {
    if (!next) return;
    setGone((g) => [...g, next.id]);
    api(`/me/offers/${next.id}/seen`, { method: 'POST' }).catch(() => {});
  }

  return createPortal(
    <div className="of-scrim" onClick={dismiss}>
      <div role="dialog" aria-modal="true" aria-labelledby="offer-title" className="of-pop" onClick={(e) => e.stopPropagation()}>
        <button ref={close} type="button" onClick={dismiss} className="of-close" aria-label="Close"><X size={16} /></button>
        <div className="of-burst" aria-hidden><Icon size={34} strokeWidth={1.8} /></div>
        <p className="of-kicker">{next.kind === 'announcement' ? 'From the desk' : 'Limited-time offer'}</p>
        <h2 id="offer-title" className="text-center text-[22px] leading-tight font-extrabold">{next.title}</h2>
        {next.body && <p className="mt-2 text-center text-[14px] text-slate-ink">{next.body}</p>}
        {next.terms && <p className="of-terms">{next.terms}</p>}
        <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-mist"><Clock size={13} aria-hidden />{timeLeft(next.ends_at)}</p>
        <div className="mt-5 flex flex-col gap-2">
          {action && (
            <a href={action[0]} onClick={dismiss} className="sheen inline-flex items-center justify-center gap-2 rounded-full bg-ember px-5 py-2.5 text-[14px] font-bold text-graphite hover:brightness-95">
              {action[1]}<ArrowRight size={16} aria-hidden />
            </a>
          )}
          <button type="button" onClick={dismiss} className="text-[13px] text-slate-ink hover:text-obsidian dark:hover:text-vellum">Got it</button>
        </div>
        {next.kind !== 'announcement' && <p className="mt-3 text-center text-[11px] text-mist">Bonuses are credited once the desk confirms them.</p>}
      </div>
    </div>,
    document.body,
  );
}

/** The live offers, on the Arena page, with what each has paid this client so far. */
export function LiveOffers() {
  const offers = useApi<Offer[]>('/me/offers');
  const list = offers.data ?? [];
  if (!list.length) return null;
  return (
    <section className="x-card x-holo space-y-3 p-5">
      <div className="flex items-center gap-2">
        <Gift size={17} className="text-ember-ink" aria-hidden />
        <h2 className="section-title">Live offers</h2>
        <span className="x-badge"><i className="nav-live mr-1.5 block size-1.5 rounded-full bg-up" aria-hidden />{list.length} running</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map((o) => {
          const Icon = OFFER_ICON[o.kind] ?? Gift;
          const action = offerAction(o);
          const paid = o.grants.filter((g) => g.status === 'paid').reduce((n, g) => n + g.amount, 0);
          const pending = o.grants.filter((g) => g.status === 'pending').reduce((n, g) => n + g.amount, 0);
          return (
            <article key={o.id} className="of-card">
              <div className="flex items-start gap-3">
                <span className="of-card-icon" aria-hidden><Icon size={20} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-bold">{o.title}</p>
                  <p className="flex items-center gap-1 text-[11.5px] text-ember-ink"><Clock size={12} aria-hidden />{timeLeft(o.ends_at)}</p>
                </div>
              </div>
              {o.body && <p className="mt-2 text-[12.5px] text-slate-ink">{o.body}</p>}
              {o.terms && <p className="mt-2 text-[12.5px] font-semibold">{o.terms}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {paid > 0 && <span className="x-badge">${paid} paid to you</span>}
                {pending > 0 && <span className="x-badge is-locked">${pending} with the desk</span>}
                {action && <a href={action[0]} className="x-btn-sm ml-auto inline-flex items-center gap-1">{action[1]}<ArrowRight size={13} aria-hidden /></a>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
