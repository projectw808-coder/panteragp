import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { alertBox, card, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { price, result, tone } from './format.ts';
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
    <div className="stagger mx-auto max-w-5xl space-y-4">
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

      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile i={0} label="Signals shown" icon="≡" value={String(lines.length)}
          note={on ? 'in this session' : 'engine is off'} />
        <Direction i={1} buys={buys} sells={lines.length - buys} />
        <Tile i={2} label="Last signal" icon="◷" value={last ? clock(last.at) : '—'}
          note={last ? ago(last.at) : 'nothing yet'} />
        <Tile i={3} label="Instrument" icon="◈" value={last?.symbol ?? '—'}
          note={last ? `${last.side} at ${price(last.price)}` : ''} />
      </div>

      <Activity lines={lines} on={!!on} />

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
                {/* Figures right, words left. Aligning a column of numbers on its right
                    edge is what lets the eye compare magnitudes down the column instead of
                    reading each one — the single thing that most separates a trading table
                    from a list of rows. */}
                <tr className="border-b border-pebble dark:border-white/10">
                  {([['Side', false], ['Instrument', false], ['Size', true],
                     ['Price', true], ['Result', true], ['Time', true]] as const).map(([h, num]) => (
                    <th key={h} className={`metric-label px-2 py-2 font-normal ${num ? 'text-right' : 'text-left'}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Each row animates once, when it mounts. React keys these by signal id, so
                    a refresh re-renders the existing rows without remounting them and only the
                    new arrival moves — which is the rule the rest of the app follows: motion on
                    arrival, never on refresh. */}
                {lines.map((l) => (
                  <tr key={l.id}
                    className="signal-in border-b border-pebble transition-colors last:border-0 hover:bg-ember/5 dark:border-white/10">
                    <td className="px-2 py-1.5">
                      <span className={`inline-block w-11 rounded-full px-1.5 py-0.5 text-center font-mono text-[10px] font-medium uppercase ${
                        l.side === 'buy' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                        {l.side}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-medium">{l.symbol}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-slate-ink">{l.qty}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{price(l.price)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${tone(l.pnl)}`}>
                      {result(l.pnl)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs text-slate-ink">{clock(l.at)}</td>
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

/** How long ago, in the plainest words that are still accurate. */
function ago(t: number): string {
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

/** One figure, framed the way the Overview frames its own. */
function Tile({ label, icon, value, note, i }: {
  label: string; icon: string; value: string; note?: string; i: number;
}) {
  return (
    <div className={`${card} tile lift grain enter`} style={{ '--i': i } as CSSProperties}>
      <span className="tile-corner" aria-hidden />
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-ember-ink" aria-hidden>{icon}</span>
        <span className="metric-label">{label}</span>
      </div>
      <p className="mt-2 truncate font-mono text-[22px] leading-none font-medium tabular-nums">{value}</p>
      {note && <p className="mt-2 truncate text-xs text-slate-ink">{note}</p>}
    </div>
  );
}

/**
 * Which way the strategy has been leaning, as a proportion rather than two numbers with a
 * slash between them. "15 / 25" makes you do the arithmetic; a bar has already done it.
 */
function Direction({ buys, sells, i }: { buys: number; sells: number; i: number }) {
  const total = buys + sells;
  const share = total ? (buys / total) * 100 : 50;
  return (
    <div className={`${card} tile lift grain enter`} style={{ '--i': i } as CSSProperties}>
      <span className="tile-corner" aria-hidden />
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-ember-ink" aria-hidden>⇄</span>
        <span className="metric-label">Direction</span>
      </div>
      <p className="mt-2 flex items-baseline gap-1.5 font-mono text-[22px] leading-none font-medium tabular-nums">
        <span className="text-up">{buys}</span>
        <span className="text-sm text-slate-ink">buy</span>
        <span className="ml-auto text-down">{sells}</span>
        <span className="text-sm text-slate-ink">sell</span>
      </p>
      <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-slate-ink/20" aria-hidden>
        <div className="bg-up transition-[width] duration-500 ease-out" style={{ width: `${share}%` }} />
        <div className="flex-1 bg-down" />
      </div>
      <p className="mt-2 text-xs text-slate-ink">
        {total === 0 ? 'nothing yet' : `${Math.round(share)}% long`}
      </p>
    </div>
  );
}

/**
 * What the engine has been doing, minute by minute — split by side.
 *
 * The first version of this charted signal rate alone, which was a chart of a constant: the
 * engine fires on a fixed interval, so every bar stood at the same height and the panel
 * showed a wall of orange that said nothing. Splitting each column into the buys and the
 * sells gives it something that actually varies, and makes the colour mean what it means
 * everywhere else on the page.
 *
 * Still a count of signals and never a running total of their results. Summing invented P&L
 * into a curve would draw the one figure here somebody could mistake for money they had
 * made — this panel is labelled a preview precisely so that never happens, and a chart is
 * far more persuasive than a label.
 */
function Activity({ lines, on }: { lines: Line[]; on: boolean }) {
  const buckets = useMemo(() => {
    const size = 8_000;
    const now = Date.now();
    const out = Array.from({ length: 22 }, () => ({ buy: 0, sell: 0 }));
    for (const l of lines) {
      const slot = out.length - 1 - Math.floor((now - l.at) / size);
      if (slot >= 0 && slot < out.length) out[slot]![l.side]++;
    }
    return out;
  }, [lines]);

  const peak = Math.max(1, ...buckets.map((b) => b.buy + b.sell));

  return (
    <div className={`${card} grain enter`} style={{ '--i': 4 } as CSSProperties}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="metric-label">Activity</h2>
        <span className="font-mono text-[11px] text-slate-ink">signals over the last three minutes</span>
        <span className="ml-auto flex items-center gap-3 font-mono text-[10px] tracking-wide uppercase">
          <span className="flex items-center gap-1.5 text-slate-ink">
            <span className="inline-block h-2 w-2 rounded-sm bg-up" aria-hidden /> buy
          </span>
          <span className="flex items-center gap-1.5 text-slate-ink">
            <span className="inline-block h-2 w-2 rounded-sm bg-down" aria-hidden /> sell
          </span>
        </span>
      </div>

      <div className="mt-3 flex h-16 items-end gap-[3px]" aria-hidden>
        {buckets.map((b, i) => {
          const total = b.buy + b.sell;
          return (
            <div key={i} className="flex flex-1 flex-col justify-end gap-[2px]"
              style={{ height: total ? `${Math.max(10, (total / peak) * 100)}%` : '3px' }}>
              {total === 0
                ? <div className="flex-1 rounded-sm bg-slate-ink/15" />
                : (
                  <>
                    {b.sell > 0 && <div className="rounded-sm bg-down" style={{ flexGrow: b.sell }} />}
                    {b.buy > 0 && <div className="rounded-sm bg-up" style={{ flexGrow: b.buy }} />}
                  </>
                )}
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-slate-ink">
        {on
          ? 'Counts of signals and which way they went — not a total of what they returned.'
          : 'The engine is off, so nothing is firing.'}
      </p>
    </div>
  );
}
