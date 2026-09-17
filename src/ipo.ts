// IPO offerings: the parts that are arithmetic rather than plumbing.
//
// Pure on purpose. The lifecycle, the cap and the settlement rounding are the three places
// this feature can be wrong about money or about what a client is allowed to do, and all
// three are testable here without a database or a server — see test/ipo.test.ts.

import { floorTo, round8 } from './trading.ts';

export type Status =
  | 'draft' | 'upcoming' | 'open' | 'closed' | 'active' | 'completed' | 'cancelled';

/**
 * The states the desk sets by hand, which no clock may overrule.
 *
 * `draft` is unpublished, `cancelled` is withdrawn, `closed` is the desk holding the book
 * while it settles allocation, and `completed` is a settlement — early or at maturity.
 * Everything else is a consequence of the dates and is computed, because a status that
 * changes only when somebody clicks is wrong every weekend.
 */
const DECIDED: ReadonlySet<string> = new Set(['draft', 'cancelled', 'closed', 'completed']);

export type Timestamps = {
  status: string;
  opens_at: Date | string | null;
  closes_at: Date | string | null;
  matures_at: Date | string | null;
};

/**
 * What an offering actually is right now.
 *
 * An offering missing any of its three dates cannot be on a timeline at all, so it reads as
 * a draft however it is stored — that is the state a half-prepared offering is in, and it
 * keeps it off the client's page without the desk having to remember to hide it.
 */
export function effectiveStatus(o: Timestamps, now: Date = new Date()): Status {
  if (DECIDED.has(o.status)) return o.status as Status;
  if (!o.opens_at || !o.closes_at || !o.matures_at) return 'draft';

  const t = now.getTime();
  const opens = new Date(o.opens_at).getTime();
  const closes = new Date(o.closes_at).getTime();
  const matures = new Date(o.matures_at).getTime();

  // Boundaries are inclusive at the start of a state: at exactly opens_at it is open, and
  // at exactly closes_at the window is done. A deal that is "open" for the instant its
  // close falls on is a deal that takes money it said it would not.
  if (t < opens) return 'upcoming';
  if (t < closes) return 'open';
  if (t < matures) return 'active';
  return 'completed';
}

/** Which of the client page's three groups a status belongs to. */
export function group(status: Status): 'running' | 'incoming' | 'finished' | 'hidden' {
  switch (status) {
    case 'upcoming': case 'open': return 'incoming';
    // A closed offering has the client's money in it and is about to start paying, so it
    // sits with running rather than with history. The brief is explicit that active must
    // not be filed under finished; closed has the same claim on the reader's attention.
    case 'active': case 'closed': return 'running';
    case 'completed': case 'cancelled': return 'finished';
    default: return 'hidden';
  }
}

export type Refusal =
  | { ok: false; reason: 'below-min'; min: number }
  | { ok: false; reason: 'above-max'; max: number }
  | { ok: false; reason: 'over-cap'; available: number };

/**
 * Whether a subscription fits: the offering's own limits first, then the shared cap.
 *
 * The cap is what two clients race for, so the refusal names what is actually left rather
 * than failing generically — somebody told "only 12,400 remains" can subscribe for 12,400,
 * and somebody told "that did not work" tries the same number again.
 *
 * An exact fill is allowed. Refusing the amount that lands precisely on the target would
 * leave every book a penny short of full.
 */
export function allocation(a: {
  target: number; raised: number; amount: number;
  min: number; max: number | null;
}): { ok: true; available: number } | Refusal {
  const available = round8(a.target - a.raised);
  if (a.amount < a.min) return { ok: false, reason: 'below-min', min: a.min };
  if (a.max !== null && a.amount > a.max) return { ok: false, reason: 'above-max', max: a.max };
  if (a.amount > available) return { ok: false, reason: 'over-cap', available: Math.max(0, available) };
  return { ok: true, available };
}

/**
 * What maturity pays out, and what rounding kept.
 *
 * Floored to the currency's minor unit and the remainder reported rather than hidden, the
 * same way the converter does it: rounding up across many settlements is money created
 * from nothing, and dust nobody names is dust nobody notices going missing.
 */
export function settlement(s: { amount: number; accrued: number; decimals: number }):
  { paid: number; dust: number } {
  const exact = round8(s.amount + s.accrued);
  const paid = floorTo(exact, s.decimals);
  return { paid, dust: round8(exact - paid) };
}

/**
 * The days an offering should accrue for, given when it was subscribed and when it matures.
 *
 * Accrual stops at maturity: a settlement run days late pays the term, not the delay. The
 * floor at zero matters for a subscription taken on the day the offering matured.
 */
export function accruableDays(a: {
  lastAccruedOn: Date | string;
  maturesAt: Date | string | null;
  today?: Date;
}): number {
  const day = 86_400_000;
  const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = startOfDay(a.today ?? new Date());
  const from = startOfDay(new Date(a.lastAccruedOn));
  const cap = a.maturesAt ? startOfDay(new Date(a.maturesAt)) : today;
  const until = Math.min(today, cap);
  return Math.max(0, Math.round((until - from) / day));
}
