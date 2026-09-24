import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { alertBox, btn, card, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { price } from './format.ts';

/**
 * The auto trader, for real.
 *
 * Everything on this page is read from the book. The bot's orders are orders: they fill,
 * move the position and realise onto the balance like the client's own, marked with the
 * strategy that decided them and the reason it gave. So a number here is money that moved,
 * not a demonstration — which is why there is no "preview" chip any more, and why the page
 * says plainly what it costs to be wrong: risk per trade, a daily loss budget with how much
 * of it is spent, and a kill switch that closes everything.
 */

type Strategy = {
  id: string; kind: 'trend' | 'mean_reversion' | 'grid'; name: string; symbols: string[];
  allocation: number; state: 'running' | 'paused'; about: string;
  open: number; realised: number; closed: number; win_rate: number | null;
};
type Position = {
  id: string; symbol: string; side: 'long' | 'short'; qty: number; entry: number; mark: number;
  stop_loss: number | null; take_profit: number | null; unrealised: number;
  strategy: string | null; opened_at: string; reason: string | null;
};
type Closed = {
  id: string; symbol: string; side: 'long' | 'short'; qty: number; entry: number; exit: number;
  net: number; r: number | null; fees: number; strategy: string | null; exit_reason: string;
  opened_at: string; closed_at: string;
};
type Log = { id: number; at: string; level: 'info' | 'trade' | 'win' | 'loss' | 'warn'; message: string };
type Dash = {
  on: boolean; since: string | null; halted_until: string | null;
  settings: { risk_per_trade: number; max_daily_loss: number; max_open_positions: number; max_leverage: number };
  account: { balance: number; currency: string };
  strategies: Strategy[];
  kpis: {
    equity: number; allocated: number; realised: number; unrealised: number; return_pct: number | null;
    today_net: number; today_trades: number; today_fees: number;
    wins: number; losses: number; closed: number; win_rate: number | null; profit_factor: number | null;
    avg_win_r: number | null; avg_loss_r: number | null; max_drawdown: number; drawdown_at: string | null;
    open: number; daily_loss_used: number;
  };
  curve: { at: string; equity: number }[];
  positions: Position[];
  closed: Closed[];
  log: Log[];
};

// Anything that rounds to zero is shown as zero, unsigned: "−$0.00" is a loss of nothing
// wearing the colour of a loss.
const money = (n: number, sign = false) => {
  const v = Math.abs(n) < 0.005 ? 0 : n;
  return (sign && v > 0 ? '+' : v < 0 ? '−' : '')
    + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const pct = (n: number | null, digits = 1) => (n === null ? '—' : `${(n * 100).toFixed(digits)}%`);
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const toneOf = (n: number) => (n >= 0.005 ? 'text-up' : n <= -0.005 ? 'text-down' : '');

export function AutoTraderView() {
  const dash = useApi<Dash>('/me/auto-trader');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // The book moves on its own; the page follows it every few seconds.
  useEffect(() => { const t = setInterval(() => dash.reload(), 5000); return () => clearInterval(t); }, []);

  const d = dash.data;
  const run = async (what: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await what(); dash.reload(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (!d) return <p className="text-sm text-slate-ink">Loading…</p>;
  const k = d.kpis;
  const halted = d.halted_until !== null && new Date(d.halted_until) >= new Date(new Date().toDateString());

  return (
    <div className="stagger mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Auto trader</PageTitle>
        <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] tracking-wide uppercase ${
          d.on ? 'chip-up text-up' : 'bg-bone text-slate-ink dark:bg-white/10'}`}>
          {d.on ? (halted ? 'halted' : 'running') : 'stopped'}
        </span>
        <span className="ml-auto" />
        <button type="button" role="switch" aria-checked={d.on} aria-label="Auto trader" disabled={busy}
          onClick={() => run(() => api('/me/auto-trader', { method: 'POST', body: JSON.stringify({ on: !d.on }) }))}
          className={`h-8 w-14 shrink-0 rounded-full p-1 transition-colors disabled:opacity-50 ${d.on ? 'bg-ember' : 'bg-pebble dark:bg-white/15'}`}>
          <span className={`block h-6 w-6 rounded-full bg-vellum shadow transition-transform ${d.on ? 'translate-x-6' : ''}`} />
        </button>
        <span className="w-8 font-mono text-xs tracking-[0.16em] text-slate-ink uppercase">{busy ? '…' : d.on ? 'on' : 'off'}</span>
        <button type="button" disabled={busy || (!d.on && k.open === 0)}
          className="rounded-full border border-down/60 px-3 py-1.5 font-mono text-[11px] text-down transition-colors hover:bg-down/10 disabled:opacity-40"
          onClick={() => {
            if (!window.confirm(`Close ${k.open} open bot position${k.open === 1 ? '' : 's'} at market and stop the auto trader?`)) return;
            run(() => api('/me/auto-trader/kill', { method: 'POST' }));
          }}>
          Stop and close all
        </button>
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      {halted && (
        <p className={alertBox}>
          The daily loss budget was spent, so the bot closed everything and will not open anything new until tomorrow.
          Existing stops and targets still apply.
        </p>
      )}
      {d.on && !(d.account.balance > 0) && (
        <p className={alertBox}>The account has no balance, so the bot has nothing to trade with. Fund it and the strategies will start.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile i={0} label="Bot equity" value={money(k.equity)} note={k.return_pct === null ? 'nothing allocated' : `${k.return_pct >= 0 ? '+' : ''}${pct(k.return_pct, 2)} since start`} />
        <Tile i={1} label="Today" value={money(k.today_net, true)} tone={toneOf(k.today_net)} note={`${k.today_trades} closed · fees ${money(k.today_fees)}`} />
        <Tile i={2} label="Win rate" value={pct(k.win_rate, 0)} note={`${k.wins} of ${k.closed} closed`} />
        <Tile i={3} label="Profit factor" value={k.profit_factor === null ? '—' : k.profit_factor.toFixed(2)}
          note={k.avg_win_r === null && k.avg_loss_r === null ? 'no closed trades yet' : `avg win ${k.avg_win_r?.toFixed(1) ?? '—'}R · avg loss ${k.avg_loss_r?.toFixed(1) ?? '—'}R`} />
        <Tile i={4} label="Max drawdown" value={k.max_drawdown ? `−${pct(k.max_drawdown)}` : '0%'} tone={k.max_drawdown ? 'text-down' : ''} note={k.drawdown_at ? `${day(k.drawdown_at)}` : 'no drawdown yet'} />
        <Tile i={5} label="Open" value={String(k.open)} note={`${money(k.unrealised, true)} unrealised`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,520px)_1fr]">
        <div className={`${card} space-y-1`}>
          <div className="flex items-center gap-3 pb-1">
            <h2 className="section-title">Strategies</h2>
            <span className="ml-auto text-xs text-slate-ink">Allocation is what each one may deploy, at up to {d.settings.max_leverage}× leverage.</span>
          </div>
          {d.strategies.map((s) => <StrategyRow key={s.id} s={s} busy={busy} onChange={run} />)}
        </div>

        <div className={`${card} space-y-2`}>
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="section-title">Bot equity{d.since ? ` · since ${day(d.since)}` : ''}</h2>
            <span className="ml-auto font-mono text-[11px] text-slate-ink">{money(k.allocated)} → {money(k.equity)}</span>
          </div>
          <Curve points={d.curve} />
          <p className="text-xs text-slate-ink">Realised plus unrealised, after commissions. Every point is a trade that closed.</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4 min-w-0">
          <div className={`${card} space-y-2`}>
            <div className="flex items-center gap-3">
              <h2 className="section-title">Open bot positions · {k.open}</h2>
              <span className={`ml-auto font-mono text-[11px] ${toneOf(k.unrealised)}`}>{money(k.unrealised, true)} unrealised</span>
            </div>
            {d.positions.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-ink">{d.on ? 'Nothing open. The strategies are watching for a setup.' : 'Nothing open.'}</p>
            ) : (
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="border-b border-pebble dark:border-white/10">
                  {(['Instrument', 'Side', 'Size', 'Entry', 'Mark', 'Stop / target', 'P&L', 'Strategy', 'Opened'] as const).map((h, i) => (
                    <th key={h} className={`metric-label px-2 py-2 font-normal ${i >= 2 && i <= 6 ? 'text-right' : 'text-left'}`}>{h}</th>))}
                </tr></thead>
                <tbody>{d.positions.map((p) => (
                  <tr key={p.id} className="border-b border-pebble last:border-0 hover:bg-ember/5 dark:border-white/10">
                    <td className="px-2 py-1.5 font-medium">{p.symbol}</td>
                    <td className="px-2 py-1.5"><Side side={p.side} /></td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{p.qty}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-slate-ink">{price(p.entry)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{price(p.mark)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs tabular-nums text-slate-ink">{p.stop_loss === null ? '—' : price(p.stop_loss)} / {p.take_profit === null ? '—' : price(p.take_profit)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${toneOf(p.unrealised)}`}>{money(p.unrealised, true)}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-ink">{p.strategy ?? '—'}</td>
                    <td className="px-2 py-1.5 font-mono text-xs text-slate-ink">{clock(p.opened_at)}</td>
                  </tr>))}
                </tbody>
              </table></div>
            )}
          </div>

          <div className={`${card} space-y-2`}>
            <div className="flex items-center gap-3">
              <h2 className="section-title">Closed trades</h2>
              <span className="ml-auto font-mono text-[11px] text-slate-ink">{k.closed} all time · {money(k.realised, true)} realised</span>
            </div>
            {d.closed.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-ink">No trade has closed yet.</p>
            ) : (
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="border-b border-pebble dark:border-white/10">
                  {(['Closed', 'Instrument', 'Side', 'Size', 'Entry → exit', 'P&L', 'R', 'Strategy', 'Exit'] as const).map((h, i) => (
                    <th key={h} className={`metric-label px-2 py-2 font-normal ${i >= 3 && i <= 6 ? 'text-right' : 'text-left'}`}>{h}</th>))}
                </tr></thead>
                <tbody>{d.closed.map((t) => (
                  <tr key={t.id} className="border-b border-pebble last:border-0 hover:bg-ember/5 dark:border-white/10">
                    <td className="px-2 py-1.5 font-mono text-xs text-slate-ink">{day(t.closed_at)} {clock(t.closed_at)}</td>
                    <td className="px-2 py-1.5 font-medium">{t.symbol}</td>
                    <td className="px-2 py-1.5"><Side side={t.side} /></td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{t.qty}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs tabular-nums text-slate-ink">{price(t.entry)} → {price(t.exit)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${toneOf(t.net)}`}>{money(t.net, true)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono text-xs tabular-nums ${t.r === null ? 'text-slate-ink' : toneOf(t.r)}`}>{t.r === null ? '—' : `${t.r >= 0 ? '+' : ''}${t.r.toFixed(1)}R`}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-ink">{t.strategy ?? '—'}</td>
                    <td className={`px-2 py-1.5 text-xs ${t.exit_reason === 'Stop loss' || t.exit_reason === 'Daily loss limit' ? 'text-down' : 'text-slate-ink'}`}>{t.exit_reason}</td>
                  </tr>))}
                </tbody>
              </table></div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className={`${card} space-y-3`}>
            <div className="flex items-center gap-3">
              <h2 className="section-title">Risk controls</h2>
              <button type="button" className="ml-auto text-xs text-ember-ink" onClick={() => setEditing(!editing)}>{editing ? 'Cancel' : 'Edit'}</button>
            </div>
            {editing ? (
              <SettingsForm s={d.settings} busy={busy} onDone={() => setEditing(false)} onSave={run} />
            ) : (
              <div className="space-y-2.5 text-xs">
                <Row l="Risk per trade" v={`${d.settings.risk_per_trade}% of bot equity`} />
                <Row l="Max daily loss" v={`${d.settings.max_daily_loss}% · used ${pct(k.daily_loss_used, 0)}`} bar={k.daily_loss_used} />
                <Row l="Max open positions" v={`${d.settings.max_open_positions} · ${k.open} open`} bar={k.open / d.settings.max_open_positions} />
                <Row l="Max leverage" v={`${d.settings.max_leverage}×`} />
                <Row l="Re-entry cooldown" v="10 min per instrument" />
                <Row l="Kill switch" v="Closes all, cancels all, stops" />
              </div>
            )}
          </div>

          <div className={`${card} space-y-1.5`}>
            <div className="flex items-center gap-3">
              <h2 className="section-title">Engine log</h2>
              <span className={`ml-auto h-2 w-2 rounded-full ${d.on && !halted ? 'nav-live bg-up' : 'bg-slate-ink'}`} aria-hidden />
              {d.on && (
                <button type="button" className="text-xs text-ember-ink" disabled={busy}
                  onClick={() => run(() => api('/me/auto-trader/tick', { method: 'POST' }))}>Evaluate now</button>
              )}
            </div>
            {d.log.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-ink">Nothing yet.</p>
            ) : d.log.map((l) => (
              <p key={l.id} className="flex gap-2 font-mono text-[11px] leading-relaxed">
                <span className="shrink-0 text-slate-ink">{clock(l.at)}</span>
                <span className={l.level === 'win' ? 'text-up' : l.level === 'loss' ? 'text-down' : l.level === 'warn' ? 'text-ember-ink' : l.level === 'trade' ? '' : 'text-slate-ink'}>{l.message}</span>
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Side({ side }: { side: 'long' | 'short' }) {
  return (
    <span className={`inline-block w-12 rounded-full px-1.5 py-0.5 text-center font-mono text-[10px] font-medium uppercase ${
      side === 'long' ? 'chip-up text-up' : 'chip-down text-down'}`}>{side}</span>
  );
}

function Row({ l, v, bar }: { l: string; v: string; bar?: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3"><span className="text-slate-ink">{l}</span><span className="font-mono">{v}</span></div>
      {bar !== undefined && (
        <div className="h-1 overflow-hidden rounded-full bg-slate-ink/20" aria-hidden>
          <div className="h-full bg-ember transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, bar * 100))}%` }} />
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, note, tone = '', i }: { label: string; value: string; note: string; tone?: string; i: number }) {
  return (
    <div className={`${card} tile lift grain enter`} style={{ '--i': i } as CSSProperties}>
      <span className="tile-corner" aria-hidden />
      <span className="metric-label">{label}</span>
      <p className={`mt-2 truncate font-mono text-[22px] leading-none font-medium tabular-nums ${tone}`}>{value}</p>
      <p className="mt-2 truncate text-xs text-slate-ink">{note}</p>
    </div>
  );
}

/** One strategy: what it trades, what it may spend, and how it has done. Pause, resume, re-allocate. */
function StrategyRow({ s, busy, onChange }: { s: Strategy; busy: boolean; onChange: (what: () => Promise<unknown>) => Promise<void> }) {
  const [alloc, setAlloc] = useState<string | null>(null);
  const patch = (body: Record<string, unknown>) => onChange(() => api(`/me/auto-trader/strategies/${s.id}`, { method: 'PATCH', body: JSON.stringify(body) }));
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-pebble py-2.5 first:border-0 dark:border-white/10">
      <span className={`h-2 w-2 shrink-0 rounded-full ${s.state === 'running' ? 'bg-up' : 'bg-slate-ink'}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" title={s.about}>{s.name}</p>
        <p className="font-mono text-[10px] text-slate-ink">{s.symbols.join(' · ')}</p>
      </div>
      <div className="text-right"><span className="metric-label block">Alloc</span>
        {alloc === null ? (
          <button type="button" className="font-mono text-xs underline decoration-dotted" onClick={() => setAlloc(String(s.allocation))}>{money(s.allocation)}</button>
        ) : (
          <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); patch({ allocation: Number(alloc) }).then(() => setAlloc(null)); }}>
            <input value={alloc} onChange={(e) => setAlloc(e.target.value)} inputMode="decimal" className="w-24 rounded border border-pebble bg-transparent px-1 font-mono text-xs dark:border-white/15" aria-label={`Allocation for ${s.name}`} />
            <button className="font-mono text-[10px] text-ember-ink" disabled={busy}>Save</button>
          </form>
        )}
      </div>
      <div className="text-right"><span className="metric-label block">P&amp;L</span><span className={`font-mono text-xs ${toneOf(s.realised)}`}>{money(s.realised, true)}</span></div>
      <div className="text-right"><span className="metric-label block">Win</span><span className="font-mono text-xs">{pct(s.win_rate, 0)}</span></div>
      <div className="text-right"><span className="metric-label block">Open</span><span className="font-mono text-xs">{s.open}</span></div>
      <button type="button" disabled={busy}
        className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase ${s.state === 'running' ? 'chip-up text-up' : 'bg-bone text-slate-ink dark:bg-white/10'}`}
        onClick={() => patch({ state: s.state === 'running' ? 'paused' : 'running' })}>
        {s.state === 'running' ? 'running' : 'paused'}
      </button>
    </div>
  );
}

function SettingsForm({ s, busy, onSave, onDone }: {
  s: Dash['settings']; busy: boolean; onDone: () => void; onSave: (what: () => Promise<unknown>) => Promise<void>;
}) {
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      risk_per_trade: Number(f.get('risk_per_trade')), max_daily_loss: Number(f.get('max_daily_loss')),
      max_open_positions: Number(f.get('max_open_positions')), max_leverage: Number(f.get('max_leverage')),
    };
    await onSave(() => api('/me/auto-trader/settings', { method: 'PATCH', body: JSON.stringify(body) }));
    onDone();
  }
  const field = 'w-full rounded border border-pebble bg-transparent px-2 py-1 font-mono text-xs dark:border-white/15';
  return (
    <form onSubmit={submit} className="space-y-2 text-xs">
      <label className="block"><span className="metric-label mb-1 block">Risk per trade · % of bot equity</span><input name="risk_per_trade" type="number" step="0.1" min="0.1" max="5" defaultValue={s.risk_per_trade} className={field} /></label>
      <label className="block"><span className="metric-label mb-1 block">Max daily loss · %</span><input name="max_daily_loss" type="number" step="0.5" min="0.5" max="20" defaultValue={s.max_daily_loss} className={field} /></label>
      <label className="block"><span className="metric-label mb-1 block">Max open positions</span><input name="max_open_positions" type="number" step="1" min="1" max="20" defaultValue={s.max_open_positions} className={field} /></label>
      <label className="block"><span className="metric-label mb-1 block">Max leverage · ×</span><input name="max_leverage" type="number" step="1" min="1" max="50" defaultValue={s.max_leverage} className={field} /></label>
      <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}

/** The equity curve, one point per closed trade, with the worst run shaded. */
function Curve({ points }: { points: { at: string; equity: number }[] }) {
  const W = 600, H = 150;
  if (points.length < 2) {
    return <div className="flex h-[150px] items-center justify-center text-xs text-slate-ink">The curve starts with the first closed trade.</div>;
  }
  const xs = points.map((p) => new Date(p.at).getTime());
  const ys = points.map((p) => p.equity);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys);
  const X = (t: number) => (x1 === x0 ? 0 : ((t - x0) / (x1 - x0)) * W);
  const Y = (v: number) => (hi === lo ? H / 2 : H - ((v - lo) / (hi - lo)) * (H - 16) - 8);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]!).toFixed(1)} ${Y(p.equity).toFixed(1)}`).join(' ');
  // The deepest drawdown: from the running peak to the trough after it.
  let peak = 0, worst = 0, from = 0, to = 0, runFrom = 0;
  ys.forEach((v, i) => { if (v > ys[peak]!) { peak = i; runFrom = i; } const dd = ys[peak]! - v; if (dd > worst) { worst = dd; from = runFrom; to = i; } });
  const last = points[points.length - 1]!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[150px] w-full" aria-label="Bot equity over time">
      {worst > 0 && <rect x={X(xs[from]!)} y="0" width={Math.max(2, X(xs[to]!) - X(xs[from]!))} height={H} className="fill-down/10" />}
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="stroke-slate-ink/15" />)}
      <path d={d} fill="none" className="stroke-ember" strokeWidth="1.6" />
      <circle cx={X(xs[xs.length - 1]!)} cy={Y(last.equity)} r="3.5" className="fill-ember" />
    </svg>
  );
}
