import { useEffect, useState, type CSSProperties } from 'react';
import {
  ArrowDown, ArrowUp, Award, BadgeCheck, CalendarDays, ChevronRight, Coins, Crown, Eye, EyeOff, Flame, Gem, Info, Lock,
  PiggyBank, PieChart, Rocket, Shield, ShieldAlert, ShieldCheck, Sparkles, Target, Trophy, User, Vault, Wallet, type LucideIcon,
} from 'lucide-react';
import { alertBox, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { useCountUp } from './count-up.ts';
import { LiveOffers } from './offers.tsx';

/**
 * The Arena, as the client sees it: a monthly league among anonymous clients of a
 * similar size, with their own row marked, and the achievements the account has earned.
 *
 * Laid out like a game's season screen — the client's own card first (league crest, rank,
 * which zone they are in and how far from the next one), the podium, the next achievement
 * within reach — but every figure on it is the same honest one: nobody else has a name or a
 * balance, and the score is the month's return less half the worst day's loss.
 */

type Row = { rank: number; alias: string; score: number; ret: number; move: 'up' | 'down' | 'stay'; me: boolean };
type Earned = { period: string; at: string; bonus: number | null; status: 'none' | 'pending' | 'paid' | 'declined' };
type Ach = {
  code: string; title: string; note: string; icon: string; bonus: number | null; share: number;
  earned: Earned[]; have: number | null; need: number | null;
};
type Arena = {
  month: string; ends_at: string; leagues: string[];
  me: { alias: string; league: string; listed: boolean; rank: number | null; score: number | null; ret: number | null;
    members: number; moves: number; beat: number | null } | null;
  table: Row[];
  achievements: Ach[];
  last: { month: string; league: string; rank: number; members: number; score: number; ret: number; move: string } | null;
};

export const ACH_ICON: Record<string, LucideIcon> = {
  shield: Shield, user: User, coins: Coins, gem: Gem, piggy: PiggyBank, vault: Vault, rocket: Rocket, pie: PieChart,
  wallet: Wallet, calendar: CalendarDays, 'arrow-up': ArrowUp, trophy: Trophy,
};
const LEAGUE_TONE: Record<string, string> = {
  bronze: '#c0743a', silver: '#a9b4c2', gold: '#f5c542', platinum: '#7fd1d8', diamond: '#9db4ff',
};
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const pctOf = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(2)}%`;
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const tone = (league: string | undefined) => ({ '--tone': LEAGUE_TONE[league ?? 'gold'] }) as CSSProperties;

/** Rarity by how many members hold it: the plain-language label a game would put on it. */
function rarity(share: number) {
  if (share === 0) return { label: 'Unclaimed', cls: 'is-common' };
  if (share <= 0.05) return { label: 'Legendary', cls: 'is-legendary' };
  if (share <= 0.15) return { label: 'Epic', cls: 'is-epic' };
  if (share <= 0.4) return { label: 'Rare', cls: 'is-rare' };
  return { label: 'Common', cls: 'is-common' };
}

function useClock(to: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const ms = to ? Math.max(0, new Date(to).getTime() - now) : 0;
  return {
    d: Math.floor(ms / 86_400_000), h: Math.floor((ms % 86_400_000) / 3_600_000),
    m: Math.floor((ms % 3_600_000) / 60_000), s: Math.floor((ms % 60_000) / 1000),
  };
}

/**
 * Where the client stands against the lines: in the promotion zone, safe, or in the
 * relegation zone — and how many points to the next line, worked from the scores in the
 * table they can already see.
 */
function zoneOf(a: Arena) {
  const me = a.me;
  const rows = a.table;
  const n = me?.moves ?? 0;
  if (!me?.rank || !n) return null;
  const promoLast = rows[n - 1];
  const safeLast = rows[rows.length - n - 1];
  const myRow = rows[me.rank - 1]!;
  if (myRow.move === 'up') {
    const chaser = rows[n];
    return { zone: 'up' as const, label: 'Promotion zone', note: chaser ? `${myRow.score - chaser.score} points clear of #${n + 1}` : 'Holding a promotion place' };
  }
  if (myRow.move === 'down') {
    return { zone: 'down' as const, label: 'Relegation zone', note: safeLast ? `${safeLast.score - myRow.score + 1} points to safety` : 'Climb to stay up' };
  }
  return { zone: 'safe' as const, label: 'Safe', note: promoLast ? `${promoLast.score - myRow.score + 1} points to the promotion zone` : 'Holding your league' };
}

export function ArenaView() {
  const arena = useApi<Arena>('/me/arena');
  const a = arena.data;
  const [busy, setBusy] = useState(false);

  if (arena.error) return <p role="alert" className={alertBox}>{arena.error}</p>;

  async function setListed(listed: boolean) {
    setBusy(true);
    try { await api('/me/arena', { method: 'PUT', body: JSON.stringify({ listed }) }); arena.reload(); } finally { setBusy(false); }
  }

  return (
    <div className="stagger mx-auto max-w-[1300px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Arena</PageTitle>
        {a && <span className="x-badge is-locked"><Flame size={13} className="mr-1.5" aria-hidden />Season {monthName(a.month)}</span>}
        {a?.me && (
          <button type="button" disabled={busy} onClick={() => setListed(!a.me!.listed)}
            className="x-btn-sm ml-auto inline-flex items-center gap-1.5" aria-pressed={a.me.listed}>
            {a.me.listed ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
            {a.me.listed ? 'On the scoreboard' : 'Hidden from the scoreboard'}
          </button>
        )}
      </div>

      <Hero a={a} />

      <LiveOffers />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Podium a={a} />
        <NextGoal a={a} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <LeagueTable a={a} />
        <div className="min-w-0 space-y-4">
          <Ladder a={a} />
          <HowItWorks moves={a?.me?.moves || 5} />
        </div>
      </div>

      <Trophies a={a} />
    </div>
  );
}

/** The client's own card: crest, alias, rank, zone, and the season clock. */
function Hero({ a }: { a: Arena | undefined | null }) {
  const clock = useClock(a?.ends_at);
  const rank = useCountUp(a?.me?.rank ?? null);
  if (!a) return <div className="x-card skeleton h-56" />;
  const me = a.me;
  const z = zoneOf(a);
  const earned = a.achievements.filter((x) => x.earned.length).length;
  const pos = me?.rank && me.members > 1 ? (me.rank - 1) / (me.members - 1) : null;
  const n = me?.moves ?? 0;

  return (
    <section className="ar-hero" style={tone(me?.league)}>
      <div className="ar-hero-grid">
        <div className="ar-crest" aria-hidden>
          <svg viewBox="0 0 120 136">
            <defs>
              <linearGradient id="crest-fill" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--tone)" stopOpacity="0.95" />
                <stop offset="1" stopColor="var(--tone)" stopOpacity="0.35" />
              </linearGradient>
            </defs>
            <path d="M60 4 L112 22 V66 C112 100 88 122 60 132 C32 122 8 100 8 66 V22 Z" fill="url(#crest-fill)" stroke="var(--tone)" strokeWidth="2.5" />
            <path d="M60 16 L100 30 V66 C100 93 82 110 60 119 C38 110 20 93 20 66 V30 Z" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" />
          </svg>
          <span className="ar-crest-icon"><Trophy size={40} strokeWidth={1.8} /></span>
          <span className="ar-crest-name">{me ? cap(me.league) : '—'}</span>
        </div>

        <div className="min-w-0 space-y-2">
          <p className="text-[12.5px] text-mist">Playing as</p>
          <p className="truncate text-[26px] leading-none font-extrabold tracking-tight">{me?.alias ?? '—'}</p>
          <p className="text-[13px] text-slate-ink">{me ? `${cap(me.league)} league · ${me.members} ranked · ${earned} of ${a.achievements.length} badges` : ''}</p>
          {z && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className={`ar-zone is-${z.zone}`}>
                {z.zone === 'up' ? <ArrowUp size={13} aria-hidden /> : z.zone === 'down' ? <ShieldAlert size={13} aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
                {z.label}
              </span>
              <span className="text-[12.5px] text-slate-ink">{z.note}</span>
            </div>
          )}
          {me && !me.listed && <p className="text-[12.5px] text-slate-ink"><Lock size={12} className="mr-1 inline" aria-hidden />Hidden from the scoreboard, so not ranked this month.</p>}
        </div>

        <div className="ar-rankbox">
          <span className="text-[12px] text-mist">Rank</span>
          <span className="ar-rank-big">{me?.rank && rank !== null ? `#${Math.round(rank)}` : '—'}</span>
          <span className="text-[12px] text-slate-ink">{me?.rank ? `of ${me.members}` : 'not ranked yet'}</span>
          {me?.score != null && (
            <span className={`mt-1 text-[13px] font-semibold tabular-nums ${me.score >= 0 ? 'text-up' : 'text-down'}`}>
              {me.score} pts · {pctOf(me.ret ?? 0)}
            </span>
          )}
        </div>

        <div className="ar-clock" aria-label={`Season ends in ${clock.d} days ${clock.h} hours`}>
          <span className="text-[12px] text-mist">Season ends in</span>
          <div className="flex gap-1.5">
            {([[clock.d, 'days'], [clock.h, 'hrs'], [clock.m, 'min'], [clock.s, 'sec']] as const).map(([v, l]) => (
              <span key={l} className="ar-clock-cell"><b>{String(v).padStart(2, '0')}</b><i>{l}</i></span>
            ))}
          </div>
        </div>
      </div>

      {pos !== null && n > 0 && (
        <div className="ar-meter" aria-label="Your position in the league">
          <div className="ar-meter-track">
            <span className="is-up" style={{ width: `${(n / me!.members) * 100}%` }} />
            <span className="is-safe" style={{ width: `${((me!.members - 2 * n) / me!.members) * 100}%` }} />
            <span className="is-down" style={{ width: `${(n / me!.members) * 100}%` }} />
            <i className="ar-meter-you" style={{ left: `${((me!.rank! - 0.5) / me!.members) * 100}%` }}><span>You</span></i>
          </div>
          <div className="flex justify-between text-[11px] text-slate-ink"><span>#1 · promotion</span><span>safe</span><span>relegation · #{me!.members}</span></div>
        </div>
      )}
    </section>
  );
}

/** The top three, on a podium. */
function Podium({ a }: { a: Arena | undefined | null }) {
  if (!a) return <div className="x-card skeleton h-64" />;
  const top = a.table.slice(0, 3);
  const order = [top[1], top[0], top[2]];
  return (
    <section className="x-card x-holo space-y-3 p-5">
      <div className="flex items-center gap-2">
        <Crown size={17} className="text-[#f5c542]" aria-hidden />
        <h2 className="section-title">Leaders this month</h2>
      </div>
      {!top.length ? (
        <p className="py-10 text-center text-sm text-slate-ink">The podium fills as the month goes.</p>
      ) : (
        <div className="ar-podium">
          {order.map((r, i) => r ? (
            <div key={r.rank} className={`ar-step is-${r.rank} ${r.me ? 'is-me' : ''}`} style={{ '--i': i } as CSSProperties}>
              <span className={`ar-medal is-${r.rank} !h-8 !w-8 !text-[14px]`}>{r.rank}</span>
              <span className="mt-2 max-w-full truncate px-1 text-[13px] font-bold">{r.me ? 'You' : r.alias}</span>
              <span className={`text-[12px] tabular-nums ${r.ret >= 0 ? 'text-up' : 'text-down'}`}>{pctOf(r.ret)}</span>
              <span className="ar-step-block"><b>{r.score}</b><i>pts</i></span>
            </div>
          ) : <div key={`empty-${i}`} />)}
        </div>
      )}
    </section>
  );
}

/** The achievement closest to being earned, and what it pays. */
function NextGoal({ a }: { a: Arena | undefined | null }) {
  if (!a) return <div className="x-card skeleton h-64" />;
  const open = a.achievements
    .filter((x) => !x.earned.length && x.have !== null && x.need)
    .sort((x, y) => (y.have! / y.need!) - (x.have! / x.need!) || (y.bonus ?? 0) - (x.bonus ?? 0));
  const next = open[0];
  const pendingUsd = a.achievements.flatMap((x) => x.earned).filter((e) => e.status === 'pending').reduce((n, e) => n + (e.bonus ?? 0), 0);
  const paidUsd = a.achievements.flatMap((x) => x.earned).filter((e) => e.status === 'paid').reduce((n, e) => n + (e.bonus ?? 0), 0);
  const Icon = next ? ACH_ICON[next.icon] ?? Award : Sparkles;
  return (
    <section className="x-card x-holo flex flex-col gap-4 p-5">
      <div className="flex items-center gap-2">
        <Target size={17} className="text-ember-ink" aria-hidden />
        <h2 className="section-title">Next goal</h2>
      </div>
      {next ? (
        <div className="flex items-center gap-4">
          <span className="ar-badge is-goal" aria-hidden><Icon size={26} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-bold">{next.title}</p>
            <p className="text-xs text-slate-ink">{next.note}</p>
            <div className="mt-2 flex justify-between text-[11.5px]"><span className="tabular-nums text-slate-ink">{next.have} of {next.need}</span>
              {next.bonus && <span className="font-semibold text-ember-ink">${next.bonus} bonus</span>}</div>
            <div className="x-meter mt-1"><span style={{ width: `${Math.max(4, (next.have! / next.need!) * 100)}%` }} /></div>
          </div>
        </div>
      ) : <p className="text-sm text-slate-ink">Every achievement you can work towards is earned. The league ones come at month end.</p>}
      <div className="mt-auto grid grid-cols-2 gap-2">
        <div className="x-mini-tile"><p className="text-[11.5px] text-mist">Bonuses paid</p><p className="mt-1 text-[16px] font-bold text-up tabular-nums">${paidUsd}</p></div>
        <div className="x-mini-tile"><p className="text-[11.5px] text-mist">With the desk</p><p className="mt-1 text-[16px] font-bold text-ember-ink tabular-nums">${pendingUsd}</p></div>
      </div>
    </section>
  );
}

/**
 * The month's table. A long league shows its top, the client's own neighbourhood and its
 * foot; the lines mark who moves up and who moves down if the month ended now.
 */
function LeagueTable({ a }: { a: Arena | undefined | null }) {
  if (!a) return <div className="x-card skeleton h-96" />;
  const rows = a.table;
  const n = a.me?.moves ?? 0;
  const mine = rows.find((r) => r.me);
  const keep = new Set<number>();
  if (rows.length <= 16) rows.forEach((r) => keep.add(r.rank));
  else {
    // The top, the client's neighbourhood and the foot — including the rows either side of
    // each moving line, so the lines themselves are never hidden by the gap.
    for (let i = 1; i <= Math.max(8, n + 1); i++) keep.add(i);
    if (mine) for (let i = mine.rank - 2; i <= mine.rank + 2; i++) keep.add(i);
    for (let i = rows.length - Math.max(2, n); i <= rows.length; i++) keep.add(i);
  }
  const shown = rows.filter((r) => keep.has(r.rank));

  return (
    <section className="x-card x-holo min-w-0 space-y-3 p-5" style={tone(a.me?.league)}>
      <div className="flex flex-wrap items-center gap-3">
        <Trophy size={17} className="ar-tone" aria-hidden />
        <h2 className="section-title">{a.me ? `${cap(a.me.league)} league` : 'League'}</h2>
        <span className="text-xs text-slate-ink">{monthName(a.month)} · {rows.length} ranked</span>
        {a.me && <span className="ml-auto text-xs text-slate-ink">You are <b className="text-ember-ink">{a.me.alias}</b></span>}
      </div>

      {!rows.length ? (
        <div className="grid place-items-center gap-2 py-10 text-center">
          <span className="x-drop-icon" aria-hidden><Trophy size={24} /></span>
          <p className="text-[15px] font-semibold">The table fills as the month goes</p>
          <p className="max-w-sm text-xs text-slate-ink">Clients are ranked once their account has earned something this month.</p>
        </div>
      ) : (
        <div className="ar-table" role="table" aria-label="League table">
          <div className="ar-row ar-head" role="row">
            <span role="columnheader">#</span><span role="columnheader">Trader</span>
            <span role="columnheader" className="text-right">Return</span><span role="columnheader" className="text-right">Score</span>
          </div>
          {shown.map((r, i) => {
            const prev = shown[i - 1];
            return (
              <div key={r.rank} role="rowgroup" className="ar-enter" style={{ '--i': Math.min(i, 14) } as CSSProperties}>
                {prev && r.rank - prev.rank > 1 && <div className="ar-gap" aria-hidden>···</div>}
                <div role="row" className={`ar-row ${r.me ? 'is-me' : ''} ${r.move === 'up' ? 'is-up' : r.move === 'down' ? 'is-down' : ''}`}>
                  <span className="ar-rank">{r.rank <= 3 ? <Medal rank={r.rank} /> : r.rank}</span>
                  <span className="min-w-0 truncate font-semibold">
                    {r.me ? <>You <span className="font-normal text-slate-ink">· {r.alias}</span></> : r.alias}
                  </span>
                  <span className={`text-right tabular-nums ${r.ret >= 0 ? 'text-up' : 'text-down'}`}>{pctOf(r.ret)}</span>
                  <span className="text-right font-semibold tabular-nums">
                    {r.score}
                    {r.move === 'up' && <ArrowUp size={12} className="ml-1 inline text-up" aria-label="moving up" />}
                    {r.move === 'down' && <ArrowDown size={12} className="ml-1 inline text-down" aria-label="moving down" />}
                  </span>
                </div>
                {n > 0 && r.rank === n && r.move === 'up' && <div className="ar-line is-up">Promotion zone · top {n} move up</div>}
                {n > 0 && r.rank === rows.length - n && rows[r.rank]?.move === 'down' && <div className="ar-line is-down">Relegation zone · bottom {n} move down</div>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const Medal = ({ rank }: { rank: number }) => (
  <span className={`ar-medal is-${rank}`} aria-label={`Place ${rank}`}>{rank}</span>
);

/** The five leagues as a climb, with the client's own marked, and how last month ended. */
function Ladder({ a }: { a: Arena | undefined | null }) {
  if (!a) return <div className="x-card skeleton h-40" />;
  const at = a.me ? a.leagues.indexOf(a.me.league) : -1;
  return (
    <section className="x-card x-holo space-y-4 p-5">
      <h2 className="section-title">The climb</h2>
      <ol className="ar-ladder">
        {a.leagues.map((l, i) => (
          <li key={l} className={i === at ? 'is-on' : i < at ? 'is-past' : ''} style={tone(l)}>
            {i === at && <span className="ar-ladder-you">You</span>}
            <Trophy size={i === at ? 22 : 16} aria-hidden />
            <span>{cap(l)}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-slate-ink">
        {a.last
          ? <>Last season ({monthName(a.last.month)}) you finished <b className="text-obsidian dark:text-vellum">#{a.last.rank} of {a.last.members}</b> in {cap(a.last.league)}
              {a.last.move === 'up' ? ' and moved up.' : a.last.move === 'down' ? ' and moved down.' : ' and stayed.'}</>
          : 'Your first season. Results are written on the first of next month.'}
      </p>
    </section>
  );
}

function HowItWorks({ moves }: { moves: number }) {
  return (
    <details className="x-card x-holo group p-5">
      <summary className="flex cursor-pointer list-none items-center gap-3">
        <span className="x-chip" aria-hidden><Info size={17} /></span>
        <h2 className="section-title">How the league works</h2>
        <ChevronRight size={16} className="ml-auto text-mist transition-transform group-open:rotate-90" aria-hidden />
      </summary>
      <ul className="mt-4 space-y-2.5 text-[13px] text-slate-ink">
        <li><b className="text-obsidian dark:text-vellum">Same-size rivals.</b> You start in the league your account size puts you in, and play clients of a similar size.</li>
        <li><b className="text-obsidian dark:text-vellum">Score.</b> Your month's return, less half of your worst day's loss, in hundredths of a percent. Steady beats lucky.</li>
        <li><b className="text-obsidian dark:text-vellum">Season end.</b> The top {moves} move up a league and the bottom {moves} move down. First place earns League champion.</li>
        <li><b className="text-obsidian dark:text-vellum">Anonymous.</b> Everyone appears under an alias with percentages only. Nobody sees a name or a balance, including yours.</li>
        <li><b className="text-obsidian dark:text-vellum">Deposits don't count.</b> Money paid in is part of what you are measured on, never part of the return.</li>
      </ul>
    </details>
  );
}

/** The trophy cabinet: every achievement as a medal, with how rare it is. */
function Trophies({ a }: { a: Arena | undefined | null }) {
  const earned = a?.achievements.filter((x) => x.earned.length) ?? [];
  return (
    <section className="x-card x-holo space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Gem size={17} className="text-ember-ink" aria-hidden />
        <h2 className="section-title">Trophy cabinet</h2>
        <span className="x-badge is-muted">{earned.length} of {a?.achievements.length ?? 0}</span>
        <span className="ml-auto text-xs text-slate-ink">Earned from how you hold your account, never from how much you trade.</span>
      </div>
      {a && (
        <div className="x-meter"><span style={{ width: `${(earned.length / a.achievements.length) * 100}%` }} /></div>
      )}
      {!a && <div className="skeleton h-40 rounded-lg" />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {(a?.achievements ?? []).map((x, i) => <Trophy3 key={x.code} x={x} i={i} />)}
      </div>
    </section>
  );
}

function Trophy3({ x, i }: { x: Ach; i: number }) {
  const Icon = ACH_ICON[x.icon] ?? Award;
  const got = x.earned[x.earned.length - 1];
  const times = x.earned.length;
  const r = rarity(x.share);
  const progress = x.have !== null && x.need ? x.have / x.need : null;
  return (
    <article className={`ar-ach ${got ? 'is-earned' : ''}`} style={{ '--i': i } as CSSProperties} title={x.note}>
      <span className={`ar-rarity ${r.cls}`}>{r.label}</span>
      <span className={`ar-badge ${got ? 'is-earned' : ''}`} aria-hidden>
        <Icon size={26} />
        {!got && <Lock size={12} className="ar-badge-lock" />}
        {times > 1 && <span className="ar-badge-times">×{times}</span>}
      </span>
      <p className="mt-2 text-center text-[13.5px] font-bold">{x.title}</p>
      <p className="text-center text-[11.5px] leading-snug text-slate-ink">{x.note}</p>
      <div className="mt-auto w-full pt-2">
        {got ? (
          <div className="flex flex-wrap justify-center gap-1">
            <span className="x-badge"><BadgeCheck size={12} className="mr-1" aria-hidden />{new Date(got.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
            {got.bonus !== null && (
              <span className={`x-badge ${got.status === 'paid' ? '' : got.status === 'pending' ? 'is-locked' : 'is-muted'}`}>
                {got.status === 'paid' ? `$${got.bonus} paid` : got.status === 'pending' ? `$${got.bonus} pending` : 'Not awarded'}
              </span>
            )}
          </div>
        ) : progress !== null ? (
          <>
            <div className="flex justify-between text-[11px] text-slate-ink"><span className="tabular-nums">{x.have}/{x.need}</span>{x.bonus && <span className="font-semibold text-ember-ink">${x.bonus}</span>}</div>
            <div className="x-meter mt-1"><span style={{ width: `${Math.max(3, progress * 100)}%` }} /></div>
          </>
        ) : (
          <p className="text-center text-[11px] text-slate-ink">At season end{x.bonus ? ` · $${x.bonus}` : ''}</p>
        )}
        <p className="mt-1.5 text-center text-[10.5px] text-mist">{x.share > 0 ? `Held by ${Math.max(1, Math.round(x.share * 100))}% of players` : 'Nobody has this yet'}</p>
      </div>
    </article>
  );
}
