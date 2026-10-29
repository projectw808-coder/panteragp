import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Clock, Gift, Trophy, Users, X } from 'lucide-react';
import { alertBox, btn, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { StatTile } from './x-shell.tsx';

/**
 * The desk's side of the Arena: the bonuses waiting on a decision, and every league with
 * the real people behind the aliases. Paying a bonus is a credit, so it needs funds:credit;
 * the server refuses anyone else whatever this page shows.
 */

type Bonus = {
  id: number; client_id: string; name: string; code: string; title: string; period: string; earned_at: string;
  bonus: number; bonus_status: 'pending' | 'paid' | 'declined'; decided_at: string | null; note: string | null;
};
type Row = { client_id: string; name: string; alias: string; rank: number; score: number; ret: number; move: 'up' | 'down' | 'stay' };
type Overview = {
  month: string; ends_at: string;
  leagues: { league: string; profiles: number; ranked: number; rows: Row[] }[];
  bonuses: Bonus[];
};

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const pctOf = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(2)}%`;
const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function ArenaAdmin({ admin }: { admin: boolean }) {
  const ov = useApi<Overview>('/arena/overview');
  const [league, setLeague] = useState<string | null>(null);
  const [view, setView] = useState<'pending' | 'decided'>('pending');
  const d = ov.data;

  if (ov.error) return <p role="alert" className={alertBox}>{ov.error}</p>;

  const pending = d?.bonuses.filter((b) => b.bonus_status === 'pending') ?? [];
  const decided = d?.bonuses.filter((b) => b.bonus_status !== 'pending') ?? [];
  const paid = decided.filter((b) => b.bonus_status === 'paid').reduce((n, b) => n + b.bonus, 0);
  const ranked = d?.leagues.reduce((n, l) => n + l.ranked, 0) ?? 0;
  const profiles = d?.leagues.reduce((n, l) => n + l.profiles, 0) ?? 0;
  const busiest = d?.leagues.slice().sort((a, b) => b.ranked - a.ranked)[0]?.league;
  const shownLeague = league ?? busiest ?? 'bronze';
  const table = d?.leagues.find((l) => l.league === shownLeague);
  const skel = <span className="skeleton inline-block h-5 w-20" />;

  return (
    <div className="stagger mx-auto max-w-[1440px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Arena</PageTitle>
        {d && <span className="x-badge is-locked"><Trophy size={13} className="mr-1.5" aria-hidden />{d.month} closes {dateOf(d.ends_at)}</span>}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatTile label="Bonuses to decide" Icon={Gift} value={d ? pending.length : skel} tone={pending.length ? 'text-ember-ink' : ''}
          note={pending.length ? `$${pending.reduce((n, b) => n + b.bonus, 0)} requested` : 'Nothing waiting'} />
        <StatTile label="Paid in bonuses" Icon={Check} value={d ? `$${paid.toLocaleString('en-US')}` : skel} note={`${decided.filter((b) => b.bonus_status === 'paid').length} paid · ${decided.filter((b) => b.bonus_status === 'declined').length} declined`} />
        <StatTile label="Ranked this month" Icon={Users} value={d ? `${ranked} of ${profiles}` : skel} note="Clients with something earned to rank on" />
        <StatTile label="Month closes" Icon={Clock} value={d ? dateOf(d.ends_at) : skel} note="Moves and champions are written then" />
      </div>

      <section className="x-card x-holo space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="section-title">Achievement bonuses</h2>
          <div className="x-qgroups ml-auto" role="tablist">
            {([['pending', `To decide · ${pending.length}`], ['decided', `Decided · ${decided.length}`]] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)} className={`!px-3 whitespace-nowrap ${view === k ? 'is-on' : ''}`}>{l}</button>
            ))}
          </div>
        </div>
        {!admin && <p className="text-xs text-slate-ink">Paying a bonus credits the client, so only an admin can decide them.</p>}
        {!d && <div className="skeleton h-24 rounded-lg" />}
        {d && !(view === 'pending' ? pending : decided).length && (
          <p className="py-6 text-center text-sm text-slate-ink">{view === 'pending' ? 'No bonuses are waiting.' : 'Nothing decided yet.'}</p>
        )}
        <ul className="ar-bonuses">
          {(view === 'pending' ? pending : decided).map((b) => <BonusRow key={b.id} b={b} admin={admin} onDone={ov.reload} />)}
        </ul>
      </section>

      <section className="x-card x-holo space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="section-title">Leagues</h2>
          <div className="x-qgroups ml-auto overflow-x-auto" role="tablist">
            {(d?.leagues ?? []).map((l) => (
              <button key={l.league} type="button" role="tab" aria-selected={shownLeague === l.league} onClick={() => setLeague(l.league)}
                className={`!px-3 whitespace-nowrap ${shownLeague === l.league ? 'is-on' : ''}`}>{cap(l.league)} · {l.ranked}</button>
            ))}
          </div>
        </div>
        {table && !table.rows.length && <p className="py-6 text-center text-sm text-slate-ink">Nobody ranked in {cap(shownLeague)} yet ({table.profiles} in the league).</p>}
        {!!table?.rows.length && (
          <div className="table-card x-table overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="x-thead">
                <tr>{['#', 'Client', 'Alias', 'Return', 'Score', 'If it ended now'].map((h, i) => <th key={h} className={`px-3 py-2 ${i >= 3 ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.map((r) => (
                  <tr key={r.client_id} className="border-t border-white/5">
                    <td className="px-3 py-2 tabular-nums">{r.rank}</td>
                    <td className="px-3 py-2"><a href={`#/clients/${r.client_id}`} className="font-semibold hover:text-ember-ink hover:underline">{r.name}</a></td>
                    <td className="px-3 py-2 text-slate-ink">{r.alias}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${r.ret >= 0 ? 'text-up' : 'text-down'}`}>{pctOf(r.ret)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.score}</td>
                    <td className="px-3 py-2 text-right">
                      {r.move === 'up' ? <span className="x-badge"><ArrowUp size={12} className="mr-1" aria-hidden />Up</span>
                        : r.move === 'down' ? <span className="x-badge is-bad"><ArrowDown size={12} className="mr-1" aria-hidden />Down</span>
                        : <span className="x-badge is-muted">Stays</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function BonusRow({ b, admin, onDone }: { b: Bonus; admin: boolean; onDone: () => void }) {
  const [amount, setAmount] = useState(String(b.bonus));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(`/arena/bonuses/${b.id}/decide`, { method: 'POST', body: JSON.stringify({ approve, ...(approve ? { amount: Number(amount) } : {}) }) });
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <li>
      <span className="x-chip !h-9 !w-9" aria-hidden><Trophy size={16} /></span>
      <span className="min-w-0 flex-1">
        <a href={`#/clients/${b.client_id}`} className="block truncate text-[14px] font-semibold hover:text-ember-ink hover:underline">{b.name}</a>
        <span className="block text-xs text-slate-ink">{b.title}{b.period ? ` · ${b.period}` : ''} · earned {dateOf(b.earned_at)}</span>
        {error && <span role="alert" className="block text-xs text-down">{error}</span>}
      </span>
      {b.bonus_status === 'pending' ? (
        admin ? (
          <span className="flex items-center gap-2">
            <span className="sk-amount w-28">
              <input className="x-field w-full !h-9 !text-[14px]" type="number" min="1" step="1" value={amount} aria-label="Bonus in USD"
                onChange={(e) => setAmount(e.target.value)} />
              <span className="sk-amount-unit !text-[11px]">USD</span>
            </span>
            <button type="button" className={`${btn} !px-3 !py-1.5 text-xs`} disabled={busy || !(Number(amount) > 0)} onClick={() => decide(true)}>Pay</button>
            <button type="button" className="x-btn-sm inline-flex items-center gap-1 hover:!border-down hover:!text-down" disabled={busy} onClick={() => decide(false)}><X size={13} aria-hidden />Decline</button>
          </span>
        ) : <span className="x-badge is-locked">${b.bonus} pending</span>
      ) : (
        <span className={`x-badge ${b.bonus_status === 'paid' ? '' : 'is-muted'}`}>
          {b.bonus_status === 'paid' ? `$${b.bonus} paid` : 'Declined'}{b.decided_at ? ` · ${dateOf(b.decided_at)}` : ''}
        </span>
      )}
    </li>
  );
}
