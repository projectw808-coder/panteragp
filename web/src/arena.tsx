import { useEffect, useState } from 'react';
import {
  ArrowDown, ArrowUp, Award, BadgeCheck, CalendarDays, Coins, Gem, Info, Lock, PiggyBank, PieChart, Rocket, Shield,
  Trophy, User, Vault, Wallet, type LucideIcon,
} from 'lucide-react';
import { alertBox, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { StatTile } from './x-shell.tsx';

/**
 * The Arena, as the client sees it: a monthly league among anonymous clients of a
 * similar size, with their own row marked, and the achievements the account has earned.
 *
 * Nobody else on this page has a name or a balance — an alias and two percentages each.
 * The score is the month's return less half the worst day's loss, so the table rewards
 * return earned with control rather than the biggest swing.
 */

type Row = { rank: number; alias: string; score: number; ret: number; move: 'up' | 'down' | 'stay'; me: boolean };
type Earned = { period: string; at: string; bonus: number | null; status: 'none' | 'pending' | 'paid' | 'declined' };
type Ach = { code: string; title: string; note: string; icon: string; bonus: number | null; earned: Earned[]; have: number | null; need: number | null };
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

function useCountdown(to: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  if (!to) return '';
  const ms = Math.max(0, new Date(to).getTime() - now);
  const d = Math.floor(ms / 86_400_000), h = Math.floor((ms % 86_400_000) / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

export function ArenaView() {
  const arena = useApi<Arena>('/me/arena');
  const a = arena.data;
  const left = useCountdown(a?.ends_at);
  const [busy, setBusy] = useState(false);

  if (arena.error) return <p role="alert" className={alertBox}>{arena.error}</p>;

  const earned = a?.achievements.filter((x) => x.earned.length) ?? [];
  const pending = a?.achievements.flatMap((x) => x.earned).filter((e) => e.status === 'pending') ?? [];
  const pendingUsd = pending.reduce((n, e) => n + (e.bonus ?? 0), 0);
  const paidUsd = a?.achievements.flatMap((x) => x.earned).filter((e) => e.status === 'paid').reduce((n, e) => n + (e.bonus ?? 0), 0) ?? 0;
  const me = a?.me;
  const skel = <span className="skeleton inline-block h-5 w-24" />;

  async function setListed(listed: boolean) {
    setBusy(true);
    try { await api('/me/arena', { method: 'PUT', body: JSON.stringify({ listed }) }); arena.reload(); } finally { setBusy(false); }
  }

  return (
    <div className="stagger mx-auto max-w-[1300px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Arena</PageTitle>
        {a && <span className="x-badge is-locked"><Trophy size={13} className="mr-1.5" aria-hidden />{monthName(a.month)} league · ends in {left}</span>}
        {me && (
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-[13px] text-mist">
            Show me on the scoreboard
            <button type="button" role="switch" aria-checked={me.listed} disabled={busy} onClick={() => setListed(!me.listed)}
              className={`st-switch ${me.listed ? 'is-on' : ''}`}><span /></button>
          </label>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatTile label="Your league" Icon={Trophy} value={me ? <span className="ar-tone" style={{ '--tone': LEAGUE_TONE[me.league] } as React.CSSProperties}>{cap(me.league)}</span> : skel}
          note={me ? `${me.members} ranked this month` : ''} />
        <StatTile label="Your rank" Icon={Award}
          value={!me ? skel : me.rank ? `#${me.rank} of ${me.members}` : '—'}
          note={!me ? '' : !me.listed ? 'Hidden from the scoreboard' : me.rank === null ? 'Not ranked yet this month'
            : me.beat !== null ? `You beat ${Math.round(me.beat * 100)}% of your league` : 'The only one ranked so far'} />
        <StatTile label="Score" Icon={BadgeCheck} value={!me ? skel : me.score === null ? '—' : String(me.score)}
          tone={me?.score != null ? (me.score >= 0 ? 'text-up' : 'text-down') : ''}
          note={me?.ret != null ? `Return ${pctOf(me.ret)} this month` : 'Return less half the worst day'} />
        <StatTile label="Achievements" Icon={Gem} value={a ? `${earned.length} of ${a.achievements.length}` : skel}
          note={pendingUsd ? `$${pendingUsd} in bonuses with the desk` : paidUsd ? `$${paidUsd} in bonuses paid` : 'Earn badges and bonuses'} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <LeagueTable a={a} />
        <div className="min-w-0 space-y-4">
          <Ladder a={a} />
          <section className="x-card x-holo space-y-3 p-5">
            <div className="flex items-center gap-3">
              <span className="x-chip" aria-hidden><Info size={17} /></span>
              <h2 className="section-title">How the league works</h2>
            </div>
            <ul className="space-y-2.5 text-[13px] text-slate-ink">
              <li><b className="text-obsidian dark:text-vellum">Same-size rivals.</b> You start in the league your account size puts you in, and play clients of a similar size.</li>
              <li><b className="text-obsidian dark:text-vellum">Score.</b> Your month's return, less half of your worst day's loss, in hundredths of a percent. Steady beats lucky.</li>
              <li><b className="text-obsidian dark:text-vellum">Month end.</b> The top {me?.moves || 5} move up a league and the bottom {me?.moves || 5} move down. First place earns League champion.</li>
              <li><b className="text-obsidian dark:text-vellum">Anonymous.</b> Everyone appears under an alias with percentages only. Nobody sees a name or a balance, including yours.</li>
              <li><b className="text-obsidian dark:text-vellum">Deposits don't count.</b> Money paid in is part of what you are measured on, never part of the return.</li>
            </ul>
          </section>
        </div>
      </div>

      <section className="x-card x-holo space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="section-title">Achievements</h2>
          <span className="x-badge is-muted">{earned.length} of {a?.achievements.length ?? 0}</span>
          <span className="ml-auto text-xs text-slate-ink">Earned from how you hold your account, never from how much you trade. Bonuses are paid once the desk approves them.</span>
        </div>
        {!a && <div className="skeleton h-40 rounded-lg" />}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(a?.achievements ?? []).map((x) => <AchievementCard key={x.code} x={x} />)}
        </div>
      </section>
    </div>
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
    <section className="x-card x-holo min-w-0 space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-3">
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
              <div key={r.rank} role="rowgroup">
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
                {n > 0 && r.rank === n && r.move === 'up' && <div className="ar-line is-up">Top {n} move up</div>}
                {n > 0 && r.rank === rows.length - n && rows[r.rank]?.move === 'down' && <div className="ar-line is-down">Bottom {n} move down</div>}
              </div>
            );
          })}
        </div>
      )}
      {a.me && !a.me.listed && (
        <p className="text-xs text-slate-ink"><Lock size={12} className="mr-1 inline" aria-hidden />You are hidden from the scoreboard, so you are not ranked. Switch it on above to take part.</p>
      )}
    </section>
  );
}

const Medal = ({ rank }: { rank: number }) => (
  <span className={`ar-medal is-${rank}`} aria-label={`Place ${rank}`}>{rank}</span>
);

/** The five leagues, with the client's own marked, and how last month ended for them. */
function Ladder({ a }: { a: Arena | undefined | null }) {
  if (!a) return <div className="x-card skeleton h-40" />;
  const at = a.me ? a.leagues.indexOf(a.me.league) : -1;
  return (
    <section className="x-card x-holo space-y-4 p-5">
      <h2 className="section-title">Leagues</h2>
      <ol className="ar-ladder">
        {a.leagues.map((l, i) => (
          <li key={l} className={i === at ? 'is-on' : i < at ? 'is-past' : ''} style={{ '--tone': LEAGUE_TONE[l] } as React.CSSProperties}>
            <Trophy size={16} aria-hidden />
            <span>{cap(l)}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-slate-ink">
        {a.last
          ? <>Last month ({monthName(a.last.month)}) you finished <b className="text-obsidian dark:text-vellum">#{a.last.rank} of {a.last.members}</b> in {cap(a.last.league)}
              {a.last.move === 'up' ? ' and moved up.' : a.last.move === 'down' ? ' and moved down.' : ' and stayed.'}</>
          : 'Your first month in the Arena. Results are written on the first of next month.'}
      </p>
    </section>
  );
}

function AchievementCard({ x }: { x: Ach }) {
  const Icon = ACH_ICON[x.icon] ?? Award;
  const got = x.earned[x.earned.length - 1];
  const times = x.earned.length;
  const progress = x.have !== null && x.need ? x.have / x.need : null;
  return (
    <article className={`ar-ach ${got ? 'is-earned' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="ar-ach-icon" aria-hidden><Icon size={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold">{x.title}{times > 1 && <span className="ml-1 text-xs text-ember-ink">×{times}</span>}</p>
          <p className="text-xs text-slate-ink">{x.note}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {got ? (
          <>
            <span className="x-badge"><BadgeCheck size={12} className="mr-1" aria-hidden />Earned {new Date(got.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
            {got.bonus !== null && (
              <span className={`x-badge ${got.status === 'paid' ? '' : got.status === 'pending' ? 'is-locked' : 'is-muted'}`}>
                {got.status === 'paid' ? `$${got.bonus} paid` : got.status === 'pending' ? `$${got.bonus} with the desk` : 'Bonus not awarded'}
              </span>
            )}
          </>
        ) : (
          <>
            {progress !== null && (
              <div className="w-full">
                <div className="flex justify-between text-[11px] text-slate-ink"><span>{x.have} of {x.need}</span>{x.bonus && <span className="text-ember-ink">${x.bonus} bonus</span>}</div>
                <div className="x-meter mt-1"><span style={{ width: `${Math.max(3, progress * 100)}%` }} /></div>
              </div>
            )}
            {progress === null && (
              <span className="text-[11.5px] text-slate-ink">Awarded at month end{x.bonus ? ` · $${x.bonus} bonus` : ''}</span>
            )}
          </>
        )}
      </div>
    </article>
  );
}
