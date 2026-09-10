import { useEffect, useRef, useState } from 'react';
import { alertBox, btn, card, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { useFeed } from './feed.ts';

/**
 * The auto trader: a switch, and a preview of what it would do underneath.
 *
 * The list below the switch is a demonstration, not a record. It is generated in the
 * browser from the live price feed and touches nothing — no order is placed, no balance
 * moves, and none of it reaches the account or the client's history. That is said plainly
 * on the panel rather than in a footnote, because a list of trades on a trading platform
 * will be read as trades unless it says otherwise.
 *
 * The switch itself is real and is stored against the client, so the desk can see who has
 * asked for it and it survives a reload.
 */

type Me = { auto_trader: boolean };
type Instrument = { symbol: string; display_name: string };

type Line = {
  id: number; symbol: string; side: 'buy' | 'sell'; qty: number;
  price: number; at: number; pnl: number;
};

const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = (t: number) => new Date(t).toLocaleTimeString();

export function AutoTraderView() {
  const me = useApi<Me>('/me/profile');
  const instruments = useApi<Instrument[]>('/instruments');
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const seq = useRef(0);
  const prices = useRef<Record<string, number>>({});

  // The switch reads from the account once, then follows what the person does with it.
  useEffect(() => { if (me.data && on === null) setOn(me.data.auto_trader); }, [me.data, on]);

  // Prices come from the same feed the charts use, so the preview moves with the market
  // rather than inventing numbers of its own.
  useFeed((ticks) => {
    for (const t of ticks) prices.current[t.symbol] = t.price;
  }, []);

  const symbols = (instruments.data ?? []).slice(0, 40).map((i) => i.symbol);

  useEffect(() => {
    if (!on || !symbols.length) return;
    const id = setInterval(() => {
      const symbol = symbols[Math.floor(Math.random() * symbols.length)]!;
      const price = prices.current[symbol];
      if (!price) return;
      const side: Line['side'] = Math.random() > 0.5 ? 'buy' : 'sell';
      setLines((prev) => [{
        id: ++seq.current,
        symbol, side,
        qty: Number((Math.random() * 2 + 0.1).toFixed(2)),
        price,
        at: Date.now(),
        // A spread of outcomes either side of nothing. It is a shape, not a forecast, and
        // it is not added up into a total anywhere — a running P&L on invented trades is
        // exactly the number somebody would mistake for their own.
        pnl: Number(((Math.random() - 0.45) * price * 0.004).toFixed(2)),
      }, ...prev].slice(0, 25));
    }, 2600);
    return () => clearInterval(id);
  }, [on, symbols.length]);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setError(null);
    try {
      await api('/me/auto-trader', { method: 'POST', body: JSON.stringify({ on: next }) });
      setOn(next);
      if (!next) setLines([]);
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageTitle>Auto trader</PageTitle>

      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center gap-4">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${on ? 'nav-live bg-up' : 'bg-slate-ink'}`} aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium">{on ? 'Running' : 'Stopped'}</p>
            <p className="text-xs text-slate-ink">
              {on
                ? 'The engine is watching the instruments below for its entries.'
                : 'Switch it on to see how it works.'}
            </p>
          </div>

          <button type="button" role="switch" aria-checked={!!on} aria-label="Auto trader"
            onClick={toggle} disabled={busy || on === null}
            className={`ml-auto h-9 w-16 shrink-0 rounded-full p-1 transition-colors disabled:opacity-50 ${
              on ? 'bg-ember' : 'bg-pebble dark:bg-white/15'}`}>
            <span className={`block h-7 w-7 rounded-full bg-vellum shadow transition-transform ${
              on ? 'translate-x-7' : ''}`} />
          </button>
          <span className="font-mono text-xs tracking-[0.16em] text-slate-ink uppercase">
            {busy ? '…' : on ? 'on' : 'off'}
          </span>
        </div>

        {error && <p role="alert" className={alertBox}>{error}</p>}
      </div>

      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="metric-label">Running trades</h2>
          <span className="rounded-full bg-ember/15 px-2.5 py-0.5 font-mono text-[11px] tracking-wide text-ember uppercase">
            preview
          </span>
          <span className="ml-auto font-mono text-[11px] text-slate-ink">
            {on ? `${lines.length} shown` : 'idle'}
          </span>
        </div>

        {/* Said here rather than in a footnote: a list of trades on a trading platform is
            read as trades unless it plainly says it is not. */}
        <p className="text-xs text-slate-ink">
          A demonstration of how the strategy behaves, drawn from live prices. Nothing here
          is placed, nothing is charged, and none of it reaches your balance, your positions
          or your history.
        </p>

        {!on ? (
          <p className="py-8 text-center text-sm text-slate-ink">Switch the auto trader on to watch it work.</p>
        ) : lines.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-ink">Waiting for the first setup…</p>
        ) : (
          <ul className="divide-y divide-pebble dark:divide-white/10">
            {lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className={`w-10 shrink-0 rounded-md px-1.5 py-0.5 text-center font-mono text-[10px] font-medium uppercase ${
                  l.side === 'buy' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                  {l.side}
                </span>
                <span className="font-medium">{l.symbol}</span>
                <span className="font-mono text-xs tabular-nums text-slate-ink">
                  {l.qty} @ {money(l.price)}
                </span>
                <span className={`ml-auto font-mono text-xs tabular-nums ${l.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                  {l.pnl >= 0 ? '+' : ''}{money(l.pnl)}
                </span>
                <span className="w-20 shrink-0 text-right font-mono text-[11px] text-slate-ink">{clock(l.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
