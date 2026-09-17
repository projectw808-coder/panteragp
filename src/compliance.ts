// Flagging rules and report export. Pure functions — the routes in server.ts feed them
// rows and persist whatever comes back.

export type Severity = 'low' | 'medium' | 'high';
export type Flag = { rule: string; severity: Severity; details: Record<string, unknown> };

/** Thresholds live here so compliance can see every number in one place. */
export const RULES = {
  largeWithdrawal: 10_000,
  hugeWithdrawal: 50_000,
  /** A withdrawal this soon after a deposit, returning most of it, looks like layering. */
  rapidReturnHours: 24,
  rapidReturnFraction: 0.8,
  /** Daily volume this many times the client's own recent average is unusual for them. */
  volumeSpikeMultiple: 5,
  /** Below this, a spike is just a small account being a small account. */
  volumeSpikeFloor: 25_000,
  /** With no trading history, this much in one day is worth a look on its own. */
  noBaselineVolume: 250_000,
  /** A subscription this many times the client's own average is unusual for them. */
  subscriptionSpikeMultiple: 5,
  /** Below this, a large subscription is a funded account taking an allocation. */
  subscriptionSpikeFloor: 10_000,
  /** With nothing subscribed before, this much at once is worth a look on its own. */
  noBaselineSubscription: 100_000,
};

export function withdrawalFlags(w: {
  amount: number;
  kycStatus: string;
  /** Deposits already settled, most recent first. */
  recentDeposits: { amount: number; at: Date }[];
  at?: Date;
}): Flag[] {
  const flags: Flag[] = [];
  const amount = Math.abs(w.amount);
  const at = w.at ?? new Date();

  if (amount >= RULES.hugeWithdrawal) {
    flags.push({ rule: 'large_withdrawal', severity: 'high', details: { amount, threshold: RULES.hugeWithdrawal } });
  } else if (amount >= RULES.largeWithdrawal) {
    flags.push({ rule: 'large_withdrawal', severity: 'medium', details: { amount, threshold: RULES.largeWithdrawal } });
  }

  if (w.kycStatus !== 'approved') {
    flags.push({ rule: 'withdrawal_without_kyc', severity: 'high', details: { amount, kyc_status: w.kycStatus } });
  }

  const window = RULES.rapidReturnHours * 3600_000;
  const recent = w.recentDeposits.find((d) =>
    at.getTime() - d.at.getTime() <= window && amount >= d.amount * RULES.rapidReturnFraction);
  if (recent) {
    flags.push({
      rule: 'rapid_withdrawal_after_deposit', severity: 'high',
      details: { amount, deposit: recent.amount, deposit_at: recent.at.toISOString() },
    });
  }
  return flags;
}

/** `today` and `avgDaily` are notional traded value, not lot counts. */
export function volumeFlags(v: { today: number; avgDaily: number }): Flag[] {
  if (v.today < RULES.volumeSpikeFloor) return [];
  // No history to compare against: fall back to an absolute threshold, or a client who
  // trades heavily on day one would never be flagged at all.
  if (v.avgDaily <= 0) {
    return v.today >= RULES.noBaselineVolume
      ? [{ rule: 'volume_no_baseline', severity: 'medium', details: { today: v.today } }]
      : [];
  }
  if (v.today < v.avgDaily * RULES.volumeSpikeMultiple) return [];
  return [{
    rule: 'volume_spike', severity: v.today >= v.avgDaily * 10 ? 'high' : 'medium',
    details: { today: v.today, average_daily: v.avgDaily, multiple: Number((v.today / v.avgDaily).toFixed(2)) },
  }];
}

/**
 * Subscribing to an IPO offering, measured the same way a withdrawal is.
 *
 * Unverified investment money is the flag that matters here, and it is raised even though
 * the route refuses the subscription outright: an attempt is the thing compliance wants to
 * see, and a refusal nobody records is a refusal nobody can count.
 *
 * Size is judged against the client's own history rather than a flat number, the way
 * volumeFlags does it — 50,000 from an account that subscribes 50,000 every month is not
 * the same event as 50,000 from one that has never subscribed at all.
 */
export function subscriptionFlags(s: {
  amount: number;
  kycStatus: string;
  /** What this client has subscribed before, in the same currency, any status. */
  previous: { amount: number }[];
}): Flag[] {
  const flags: Flag[] = [];
  const amount = Math.abs(s.amount);

  if (s.kycStatus !== 'approved') {
    flags.push({
      rule: 'subscription_without_kyc', severity: 'high',
      details: { amount, kyc_status: s.kycStatus },
    });
  }

  if (amount < RULES.subscriptionSpikeFloor) return flags;

  const priced = s.previous.map((p) => Math.abs(Number(p.amount))).filter((n) => n > 0);
  if (!priced.length) {
    if (amount >= RULES.noBaselineSubscription) {
      flags.push({
        rule: 'subscription_no_baseline', severity: 'medium',
        details: { amount, threshold: RULES.noBaselineSubscription },
      });
    }
    return flags;
  }

  const average = priced.reduce((n, x) => n + x, 0) / priced.length;
  if (amount >= average * RULES.subscriptionSpikeMultiple) {
    flags.push({
      rule: 'subscription_spike',
      severity: amount >= average * 10 ? 'high' : 'medium',
      details: {
        amount, average_subscription: Number(average.toFixed(2)),
        multiple: Number((amount / average).toFixed(2)),
      },
    });
  }
  return flags;
}

// ------------------------------------------------------------------- export

/**
 * A cell starting with one of these is executed as a formula when the file is opened in
 * a spreadsheet. Client-supplied names and notes end up in these reports, so every such
 * cell is prefixed with an apostrophe.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  const safe = FORMULA_START.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** RFC 4180 CSV, with spreadsheet formula injection defused. */
export function toCSV(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  return [cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}
