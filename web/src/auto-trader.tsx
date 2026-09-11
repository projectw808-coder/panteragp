import { useEffect, useState } from 'react';
import { alertBox, card, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { clear, getLines, isRunning, onLines, setSymbols, start, stop, type Line } from './auto-trader-store.ts';

/**
 * The auto trader: a switch, and what it is doing underneath.
 *
 * The switch is real and is stored against the client. The list is not: it is a
 * demonstration drawn from live prices that places nothing, charges nothing and reaches
 * neither the balance nor the history. That is stated on the panel beside a "preview"
 * chip rather than in a footnote, because a list of trades on a trading platform is read
 * as trades unless it plainly says otherwise — and for the same reason the lines are never
 * totalled into a P&L figure anywhere.
 *
 * The generating itself lives in auto-trader-store.ts so it carries on while the client is
 * on another page.
 */

type Profile = { auto_trader: boolean };
type Instrument = { symbol: string };

const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = (t: number) => new Date(t).toLocaleTimeString();

/**
 * Keeps the engine matched to the switch for the whole session, wherever the client is.
 * Mounted by the shell rather than by the page, so leaving the page does not stop it.
 */
export function AutoTraderRunner() {
  const me = useApi<Profile>('/me/profile');
  const instruments = useApi<Instrument[]>('/instruments');

  useEffect(() => {
    if (instruments.data) setSymbols(instruments.data.slice(0, 40).map((i) => i.symbol));
  }, [instruments.data]);

  useEffect(() => {
    if (!me.data || !instruments.data) return;
    if (me.data.auto_trader) start();
    else stop();
  }, [me.data?.auto_trader, instruments.data]);

  // Stopped when the session ends, so a signed-out tab is not still ticking.
  useEffect(() => stop, []);
  return null;
}

export function AutoTraderView() {
  const me = useApi<Profile>('/me/profile');
  const [on, setOn] = useState<boolean | null>(null);
  const [lines, setLines] = useState<Line[]>(getLines());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (me.data && on === null) setOn(me.data.auto_trader); }, [me.data, on]);
  useEffect(() => onLines(setLines), []);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setError(null);
    try {
      await api('/me/auto-trader', { method: 'POST', body: JSON.stringify({ on: next }) });
      setOn(next);
      if (next) start();
      else { stop(); clear(); }
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  const live = on && isRunning();
  const last = lines[0];
  const buys = lines.filter((l) => l.side === 'buy').length;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Auto trader</PageTitle>
        <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] tracking-wide uppercase ${
          on ? 'bg-up/15 text-up' : 'bg-bone text-slate-ink dark:bg-white/10'}`}>
          {on ? 'running' : 'stopped'}
        </span>
      </div>

      <div className={`${card} space-y-5`}>
        <div className="flex flex-wrap items-center gap-4">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${live ? 'nav-live bg-up' : 'bg-slate-ink'}`} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {on ? 'The engine is working' : 'The engine is idle'}
            </p>
            <p className="text-xs text-slate-ink">
              {on
                ? 'It keeps going while you are on other pages. Come back any time.'
                : 'Switch it on to watch the strategy work.'}
            </p>
          </div>

          <button type="button" role="switch" aria-checked={!!on} aria-label="Auto trader"
            onClick={toggle} disabled={busy || on === null}
            className={`h-9 w-16 shrink-0 rounded-full p-1 transition-colors disabled:opacity-50 ${
              on ? 'bg-ember' : 'bg-pebble dark:bg-white/15'}`}>
            <span className={`block h-7 w-7 rounded-full bg-vellum shadow transition-transform ${
              on ? 'translate-x-7' : ''}`} />
          </button>
          <span className="w-8 font-mono text-xs tracking-[0.16em] text-slate-ink uppercase">
            {busy ? '…' : on ? 'on' : 'off'}
          </span>
        </div>

        <dl className="flex flex-wrap items-center gap-x-10 gap-y-3 border-t border-pebble pt-4 dark:border-white/10">
          <div>
            <dt className="metric-label">Signals shown</dt>
            <dd className="font-mono text-xl leading-tight font-medium tabular-nums">{lines.length}</dd>
          </div>
          <div>
            <dt className="metric-label">Direction</dt>
            <dd className="font-mono text-xl leading-tight font-medium tabular-nums">
              <span className="text-up">{buys}</span>
              <span className="text-slate-ink"> / </span>
              <span className="text-down">{lines.length - buys}</span>
            </dd>
          </div>
          <div>
            <dt className="metric-label">Last signal</dt>
            <dd className="font-mono text-xl leading-tight font-medium tabular-nums">
              {last ? clock(last.at) : '—'}
            </dd>
          </div>
          <div>
            <dt className="metric-label">Instrument</dt>
            <dd className="font-mono text-xl leading-tight font-medium">{last?.symbol ?? '—'}</dd>
          </div>
        </dl>
      </div>

      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="metric-label">Signal log</h2>
          <span className="rounded-full bg-ember/15 px-2.5 py-0.5 font-mono text-[11px] tracking-wide text-ember-ink uppercase">
            preview
          </span>
          <p className="ml-auto max-w-md text-xs text-slate-ink">
            A demonstration of how the strategy behaves, drawn from live prices. Nothing is
            placed, nothing is charged, and none of it reaches your balance, your positions
            or your history.
          </p>
        </div>

        {!on ? (
          <p className="py-12 text-center text-sm text-slate-ink">
            Switch the auto trader on to watch it work.
          </p>
        ) : lines.length === 0 ? (
          <p className="py-12 text-center text-sm text-slate-ink">Waiting for the first setup…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-pebble text-left dark:border-white/10">
                  {['Side', 'Instrument', 'Size', 'Price', 'Result', 'Time'].map((h) => (
                    <th key={h} className="metric-label px-2 py-2 font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-b border-pebble last:border-0 dark:border-white/10">
                    <td className="px-2 py-1.5">
                      <span className={`inline-block w-11 rounded-md px-1.5 py-0.5 text-center font-mono text-[10px] font-medium uppercase ${
                        l.side === 'buy' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                        {l.side}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-medium">{l.symbol}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums text-slate-ink">{l.qty}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{money(l.price)}</td>
                    <td className={`px-2 py-1.5 font-mono tabular-nums ${l.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                      {l.pnl >= 0 ? '+' : ''}{money(l.pnl)}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-xs text-slate-ink">{clock(l.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error && <p role="alert" className={alertBox}>{error}</p>}
      </div>
    </div>
  );
}
