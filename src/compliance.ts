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
