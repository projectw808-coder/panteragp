import { useEffect, useState } from 'react';
import { alertBox, card } from './App.tsx';
import { api, useApi } from './api.ts';

/**
 * A client's auto trader, seen from the desk.
 *
 * Read-only for anyone who can read the CRM: what the bot holds, what it has made, and
 * its log. For an admin it is also the hand on it — the switch, and the target win rate the
 * engine steers toward. The target is the desk's number and the client's page never
 * carries it, which is why it lives here and not on theirs.
 */

type Dash = {
  on: boolean; since: string | null; halted_until: string | null;
  account: { balance: number; currency: string };
  strategies: { id: string; name: string; state: string; allocation: number; realised: number; open: number }[];
  kpis: { equity: number; allocated: number; realised: number; unrealised: number; win_rate: number | null; wins: number; losses: number; closed: number; open: number; today_net: number };
  positions: { id: string; symbol: string; side: string; qty: number; entry: number; mark: number; unrealised: number; strategy: string | null }[];
  log: { id: number; at: string; level: string; message: string }[];
  desk: { target_win_rate: number; default: number; custom: boolean; record_since: string | null };
};

const money = (n: number, sign = false) => {
  const v = Math.abs(n) < 0.005 ? 0 : n;
  return (sign && v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const tone = (n: number) => (n >= 0.005 ? 'text-up' : n <= -0.005 ? 'text-down' : '');
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function ClientAutoTrader({ clientId, admin }: { clientId: string; admin: boolean }) {
  const dash = useApi<Dash>(`/clients/${clientId}/auto-trader`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => { const t = setInterval(() => dash.reload(), 10_000); return () => clearInterval(t); }, [clientId]);

  const d = dash.data;
  const patch = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { await api(`/clients/${clientId}/auto-trader`, { method: 'PATCH', body: JSON.stringify(body) }); dash.reload(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  if (!d) return null;
  const k = d.kpis;
  const actual = k.win_rate === null ? null : Math.round(k.win_rate * 100);
  const goal = Math.round(d.desk.target_win_rate * 100);
  const dflt = Math.round(d.desk.default * 100);

  return (
    <div className={`${card} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Auto trader</h2>
        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${d.on ? 'chip-up text-up' : 'bg-bone text-slate-ink dark:bg-white/10'}`}>
          {d.on ? 'running' : 'off'}
        </span>
        {admin && (
          <span className="ml-auto flex gap-2">
            <button type="button" disabled={busy}
              onClick={() => { if (window.confirm('Start this client\'s record again from now? Every trade stays in the book and on the balance; the win rate and the curve count from here, and a daily halt is lifted.')) patch({ reset_record: true }); }}
              className="rounded-full border border-pebble px-3 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
              Reset record
            </button>
            <button type="button" disabled={busy} onClick={() => patch({ on: !d.on })}
              className="rounded-full border border-pebble px-3 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
              {d.on ? 'Switch off' : 'Switch on'}
            </button>
          </span>
        )}
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div><span className="metric-label block">Bot equity</span><span className="font-mono">{money(k.equity)}</span></div>
        <div><span className="metric-label block">Realised</span><span className={`font-mono ${tone(k.realised)}`}>{money(k.realised, true)}</span></div>
        <div><span className="metric-label block">Open</span><span className="font-mono">{k.open} · <span className={tone(k.unrealised)}>{money(k.unrealised, true)}</span></span></div>
        <div><span className="metric-label block">Win rate{d.desk.record_since ? ` · since ${new Date(d.desk.record_since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}</span><span className="font-mono">{actual === null ? '—' : `${actual}%`} <span className="text-slate-ink">· {k.wins}/{k.closed}</span></span></div>
      </div>

      {/* The desk's number. Shown as what the engine is steering toward against what the
          record actually is, so the gap is visible rather than assumed closed. */}
      {admin && (
        <div className="flex flex-wrap items-center gap-2 border-t border-pebble pt-3 text-xs dark:border-white/10">
          <span className="metric-label">Target win rate</span>
          {target === null ? (
            <>
              <span className="font-mono">{goal}%{d.desk.custom ? ' · set for this client' : ' · the default'}</span>
              {actual !== null && (
                <span className={`font-mono ${actual >= goal ? 'text-up' : 'text-ember-ink'}`}>· actual {actual}%</span>
              )}
              <button type="button" className="ml-auto text-ember-ink" onClick={() => setTarget(String(goal))}>Change</button>
              {d.desk.custom && <button type="button" className="text-slate-ink" disabled={busy} onClick={() => patch({ target_win_rate: null })}>Back to the {dflt}% default</button>}
            </>
          ) : (
            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); patch({ target_win_rate: Number(target) / 100 }).then(() => setTarget(null)); }}>
              <input value={target} onChange={(e) => setTarget(e.target.value)} type="number" min="0" max="100" step="1" aria-label="Target win rate, percent"
                className="w-20 rounded border border-pebble bg-transparent px-2 py-1 font-mono dark:border-white/15" />
              <span className="text-slate-ink">%</span>
              <button className="rounded-full bg-ember px-3 py-1 font-mono text-[11px] text-graphite" disabled={busy}>Save</button>
              <button type="button" className="text-slate-ink" onClick={() => setTarget(null)}>Cancel</button>
            </form>
          )}
          <p className="basis-full text-[11px] leading-relaxed text-slate-ink">
            Every client's bot is steered to {dflt}% unless a rate is set here for them. Below target, the engine banks any trade that clears its fees and holds losers for the
            price to come back; above it, a loss is taken only if the record stays above target afterwards. Never shown to the client.
          </p>
        </div>
      )}

      {!!d.positions.length && (
        <div className="space-y-1 border-t border-pebble pt-3 dark:border-white/10">
          <span className="metric-label block">Holding</span>
          {d.positions.map((p) => (
            <p key={p.id} className="flex gap-2 font-mono text-[11px]">
              <span className="w-16 font-medium">{p.symbol}</span>
              <span className={`w-12 uppercase ${p.side === 'long' ? 'text-up' : 'text-down'}`}>{p.side}</span>
              <span className="text-slate-ink">{p.qty} @ {p.entry}</span>
              <span className={`ml-auto ${tone(p.unrealised)}`}>{money(p.unrealised, true)}</span>
            </p>
          ))}
        </div>
      )}

      {!!d.log.length && (
        <div className="space-y-1 border-t border-pebble pt-3 dark:border-white/10">
          <span className="metric-label block">Recent</span>
          {d.log.slice(0, 6).map((l) => (
            <p key={l.id} className="flex gap-2 font-mono text-[11px]">
              <span className="shrink-0 text-slate-ink">{clock(l.at)}</span>
              <span className={l.level === 'win' ? 'text-up' : l.level === 'loss' ? 'text-down' : l.level === 'warn' ? 'text-ember-ink' : 'text-slate-ink'}>{l.message}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
