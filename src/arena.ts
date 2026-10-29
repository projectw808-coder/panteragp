// The Arena: achievements a client earns from how they use the account, and a monthly
// league in which they see their own standing among anonymous clients of a similar size.
//
// Two rules shape everything here. Nothing rewards trading more — no achievement counts
// trades or volume, and the league score is a return, not activity. And nothing in a
// league table identifies anybody: other clients appear under a generated alias, with
// percentages only, never a balance.

export const LEAGUES = ['bronze', 'silver', 'gold', 'platinum', 'diamond'] as const;
export type League = (typeof LEAGUES)[number];

/** The league a client starts in, by what the account holds. After that, results move them. */
export function leagueFor(equityUsd: number): League {
  if (equityUsd >= 500_000) return 'diamond';
  if (equityUsd >= 100_000) return 'platinum';
  if (equityUsd >= 25_000) return 'gold';
  if (equityUsd >= 5_000) return 'silver';
  return 'bronze';
}

const ANIMALS = ['Falcon', 'Orca', 'Lynx', 'Heron', 'Wolf', 'Panther', 'Hawk', 'Bison', 'Cobra', 'Fox', 'Raven', 'Tiger',
  'Marlin', 'Eagle', 'Jaguar', 'Otter', 'Puma', 'Stag', 'Viper', 'Kestrel', 'Badger', 'Condor', 'Mako', 'Ibex'] as const;

/** A generated alias — an animal and four digits. Uniqueness is the database's job. */
export function makeAlias(rand: () => number = Math.random): string {
  const animal = ANIMALS[Math.floor(rand() * ANIMALS.length)]!;
  return `${animal} ${String(Math.floor(rand() * 10_000)).padStart(4, '0')}`;
}

/** The month a date falls in, as YYYY-MM in UTC. */
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
export const monthStart = (key: string) => new Date(`${key}-01T00:00:00Z`);
export function nextMonth(key: string): string {
  const d = monthStart(key);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return monthKey(d);
}
export function prevMonth(key: string): string {
  const d = monthStart(key);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthKey(d);
}

/**
 * The league score: the month's return, less half of the worst single day's loss, in
 * hundredths of a percent. A steady +3% outscores a +3.5% that got there through a −4% day,
 * which is the point — the table should reward return earned with control, not a lucky
 * swing. Both inputs are fractions (0.03 is 3%).
 */
export function scoreOf(ret: number, worstDayLoss: number): number {
  return Math.round((ret - 0.5 * Math.max(0, worstDayLoss)) * 10_000);
}

/** How many move up and how many move down at month end, for a league of this size. */
export function movesFor(members: number): number {
  if (members >= 10) return 5;
  if (members >= 4) return Math.floor(members / 4);
  return 0;
}

export type Standing = { client_id: string; score: number; ret: number };

/**
 * Rank a league and decide who moves. Ties go to the higher return, then to the earlier
 * alias — any stable rule will do, so long as the same inputs always give the same table.
 */
export function rankLeague(league: League, rows: Standing[]) {
  const sorted = [...rows].sort((a, b) => b.score - a.score || b.ret - a.ret || a.client_id.localeCompare(b.client_id));
  const n = movesFor(sorted.length);
  const top = LEAGUES.indexOf(league) === LEAGUES.length - 1;
  const bottom = LEAGUES.indexOf(league) === 0;
  return sorted.map((r, i) => ({
    ...r,
    rank: i + 1,
    move: !top && i < n ? 'up' as const : !bottom && i >= sorted.length - n ? 'down' as const : 'stay' as const,
  }));
}

export const promote = (l: League): League => LEAGUES[Math.min(LEAGUES.length - 1, LEAGUES.indexOf(l) + 1)]!;
export const demote = (l: League): League => LEAGUES[Math.max(0, LEAGUES.indexOf(l) - 1)]!;

/** What the checks see about a client. Gathered in one place by the server. */
export type Facts = {
  kyc: string;
  profileFields: number;
  stakesEver: number;
  longestActiveStakeDays: number;
  potsEver: number;
  oldestFundedPotDays: number;
  iposEver: number;
  activeStake: boolean;
  fundedPot: boolean;
  activeIpo: boolean;
  autoTrader: boolean;
  walletsLinked: number;
  daysAsClient: number;
};

export type Achievement = {
  code: string; title: string; note: string; icon: string;
  /** A bonus in USD, credited once the desk approves it. Null for a badge on its own. */
  bonus: number | null;
  /** Earned now, and how far along when not. Absent for the league ones, awarded at month end. */
  check?: (f: Facts) => { done: boolean; have: number; need: number };
};

const step = (have: number, need: number) => ({ done: have >= need, have: Math.min(have, need), need });

/**
 * The catalogue. Every one is something about how the account is held — verified, spread
 * across products, kept for a length of time — and none counts trades, so none can be
 * earned by trading more.
 */
export const ACHIEVEMENTS: Achievement[] = [
  { code: 'verified', title: 'Verified', note: 'Both identity documents accepted by the desk.', icon: 'shield', bonus: 25,
    check: (f) => step(f.kyc === 'approved' ? 1 : 0, 1) },
  { code: 'profile_complete', title: 'All about you', note: 'Every detail on your profile filled in.', icon: 'user', bonus: null,
    check: (f) => step(f.profileFields, 5) },
  { code: 'first_stake', title: 'First stake', note: 'Put crypto to work in staking.', icon: 'coins', bonus: null,
    check: (f) => step(f.stakesEver, 1) },
  { code: 'diamond_hands', title: 'Diamond hands', note: 'Keep one stake running for 90 days.', icon: 'gem', bonus: 25,
    check: (f) => step(f.longestActiveStakeDays, 90) },
  { code: 'first_pot', title: 'First pot', note: 'Open a portfolio for something in particular.', icon: 'piggy', bonus: null,
    check: (f) => step(f.potsEver, 1) },
  { code: 'saver', title: 'Saver', note: 'Keep money in a pot for 180 days.', icon: 'vault', bonus: 20,
    check: (f) => step(f.oldestFundedPotDays, 180) },
  { code: 'first_ipo', title: 'First IPO', note: 'Subscribe to an offering.', icon: 'rocket', bonus: null,
    check: (f) => step(f.iposEver, 1) },
  { code: 'diversified', title: 'Diversified', note: 'Hold a stake, a funded pot and an IPO, with the Auto Trader on.', icon: 'pie', bonus: 50,
    check: (f) => step([f.activeStake, f.fundedPot, f.activeIpo, f.autoTrader].filter(Boolean).length, 4) },
  { code: 'wallet_linked', title: 'Keys in hand', note: 'Link a wallet you own.', icon: 'wallet', bonus: null,
    check: (f) => step(f.walletsLinked, 1) },
  { code: 'loyal_year', title: 'One year with us', note: 'A full year as a client.', icon: 'calendar', bonus: 100,
    check: (f) => step(f.daysAsClient, 365) },
  { code: 'promoted', title: 'Promoted', note: 'Finish a month in the top of your league and move up.', icon: 'arrow-up', bonus: null },
  { code: 'league_champion', title: 'League champion', note: 'Finish a month first in your league.', icon: 'trophy', bonus: 100 },
];

export const achievement = (code: string) => ACHIEVEMENTS.find((a) => a.code === code);

// ------------------------------------------------------------------ offers
//
// Time-limited bonuses the desk switches on: a deposit bonus, a bonus for using a product,
// a multiplier on achievement bonuses, a prize pool for the top of each league, or an
// announcement with no money in it. Each qualifying event becomes a grant, paid by the desk
// or automatically, as the offer says.

export const OFFER_KINDS = ['deposit_bonus', 'product_bonus', 'achievement_multiplier', 'league_prize', 'announcement'] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];
export type OfferRule = {
  min?: number; percent?: number; fixed?: number; cap?: number; first_only?: boolean;
  product?: 'stake' | 'pot' | 'ipo'; multiplier?: number; prizes?: number[]; min_members?: number;
};

/** What one qualifying amount (in USD) earns under a rule. Zero when it does not qualify. */
export function offerAmount(rule: OfferRule, usd: number): number {
  if (!(usd > 0) || usd < (rule.min ?? 0)) return 0;
  const raw = rule.percent ? usd * rule.percent / 100 : rule.fixed ?? 0;
  const capped = rule.cap ? Math.min(rule.cap, raw) : raw;
  return Math.round(capped * 100) / 100;
}

const usdText = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const PRODUCT: Record<string, string> = { stake: 'stake', pot: 'payment into a portfolio', ipo: 'IPO subscription' };

/** The offer's terms in one plain sentence, the same on the client's pop-up and the desk's list. */
export function offerTerms(kind: OfferKind, rule: OfferRule): string {
  const earn = rule.percent ? `${rule.percent}%${rule.cap ? ` (up to ${usdText(rule.cap)})` : ''}` : usdText(rule.fixed ?? 0);
  switch (kind) {
    case 'deposit_bonus':
      return `Each ${rule.first_only ? 'first ' : ''}deposit of ${usdText(rule.min ?? 0)} or more earns a ${earn} bonus${rule.percent ? ' of the deposit' : ''}.`;
    case 'product_bonus':
      return `Each ${PRODUCT[rule.product ?? 'ipo']} of ${usdText(rule.min ?? 0)} or more earns a ${earn} bonus.`;
    case 'achievement_multiplier':
      return `Achievement bonuses earned during the offer are worth ×${rule.multiplier ?? 2}.`;
    case 'league_prize': {
      const p = rule.prizes ?? [];
      return `At month end the top ${p.length} of every league win ${p.map(usdText).join(' / ')}.`;
    }
    default:
      return '';
  }
}
