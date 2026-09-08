import { useCallback, useEffect, useState } from 'react';
import { btn, card, field, input } from './App.tsx';
import { api, useApi } from './api.ts';
import { useFeed } from './feed.ts';
import { FundingPanel, KycPanel } from './compliance.tsx';
import { HoldingsPanel } from './wallet.tsx';
import { PortfoliosPanel } from './portfolio.tsx';
import { positionSize } from '../../src/trading.ts';

type Instrument = { symbol: string };
type Account = { id: string; mode: string; currency: string; balance: number; leverage: number; equity: number; unrealized: number };
type Order = {
  id: string; symbol: string; side: 'buy' | 'sell'; type: string; qty: number;
  limit_price: number | null; stop_price: number | null; status: string;
  parent_order_id: string | null; placed_at: string;
};
type Pos = { symbol: string; qty: number; avg_price: number; price: number; unrealized: number };
type Trade = { id: number; symbol: string; side: string; type: string; qty: number; price: number; filled_at: string };

const TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'] as const;
const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number) => `${n >= 0 ? '+' : ''}${money(n)}`;
const pnl = (n: number) => (n >= 0 ? 'text-green-600' : 'text-red-600');

export function TradeView() {
  const me = useApi<{ sub: string }>('/me').data;
  const instruments = useApi<Instrument[]>('/instruments');
  const account = useApi<Account>('/account');
  const positions = useApi<Pos[]>('/positions');
  const orders = useApi<Order[]>('/orders?open=true');
  const trades = useApi<Trade[]>('/trades');
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<'positions' | 'orders' | 'history' | 'funding' | 'holdings' | 'portfolios'>('positions');

  const refresh = useCallback(() => {
    account.reload(); positions.reload(); orders.reload(); trades.reload();
  }, [account.reload, positions.reload, orders.reload, trades.reload]);

  useFeed((ticks, _at) => {
    setPrices((p) => ({ ...p, ...Object.fromEntries(ticks.map((t) => [t.symbol, t.price])) }));
  }, []);

  // The engine fills orders between requests, so re-read when it says something happened.
  useEffect(() => {
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const a = account.data;
  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4">
      <div className={`${card} flex flex-wrap items-center gap-6 py-3 text-sm`}>
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
          PAPER / DEMO
        </span>
        <Stat label="Trading balance" value={a ? `${money(a.balance)} ${a.currency}` : '—'} />
        <Stat label="Equity" value={a ? money(a.equity) : '—'} />
        <Stat label="Open P&L" value={a ? signed(a.unrealized) : '—'} className={a ? pnl(a.unrealized) : ''} />
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-4 self-start">
          <Ticket instruments={instruments.data ?? []} balance={a?.balance ?? 0}
            leverage={a?.leverage ?? 1} prices={prices} onPlaced={refresh} />
          {me && <KycPanel clientId={me.sub} canUpload />}
        </div>

        <div className={`${card} flex min-h-0 flex-col gap-3`}>
          <div className="flex gap-1 text-xs">
            {(['positions', 'orders', 'history', 'funding', 'holdings', 'portfolios'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t}
                className={`rounded px-3 py-1 capitalize ${tab === t
                  ? 'bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900'
                  : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
                {t === 'orders' ? 'open orders' : t}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'positions' && <Positions rows={positions.data ?? []} prices={prices} />}
            {tab === 'orders' && <Orders rows={orders.data ?? []} onCancel={async (id) => {
              await api(`/orders/${id}`, { method: 'DELETE' });
              refresh();
            }} />}
            {tab === 'history' && <History rows={trades.data ?? []} />}
            {tab === 'funding' && <FundingPanel />}
            {tab === 'holdings' && <HoldingsPanel />}
            {tab === 'portfolios' && <PortfoliosPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

const Stat = ({ label, value, className = '' }: { label: string; value: string; className?: string }) => (
  <span>
    <span className="text-xs text-slate-500">{label} </span>
    <span className={`tabular-nums font-medium ${className}`}>{value}</span>
  </span>
);

// ------------------------------------------------------------------ ticket

function Ticket({ instruments, balance, leverage, prices, onPlaced }: {
  instruments: Instrument[]; balance: number; leverage: number;
  prices: Record<string, number>; onPlaced: () => void;
}) {
  const [symbol, setSymbol] = useState('EURUSD');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<(typeof TYPES)[number]>('market');
  const [qty, setQty] = useState('1000');
  const [limit, setLimit] = useState('');
  const [stop, setStop] = useState('');
  const [trail, setTrail] = useState('');
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [riskPct, setRiskPct] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const last = prices[symbol];
  const entry = type === 'limit' || type === 'stop_limit' ? Number(limit) || last : type === 'stop' ? Number(stop) || last : last;
  // Rounded down: a size that overshoots the margin cap by a fraction is no use.
  const suggested = entry && Number(sl)
    ? Math.floor(positionSize({ balance, riskPct: Number(riskPct), entry, stop: Number(sl), leverage }) * 100) / 100
    : 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const num = (v: string) => (v === '' ? undefined : Number(v));
    try {
      await api('/orders', {
        method: 'POST',
        body: JSON.stringify({
          symbol, side, type, qty: Number(qty),
          limit_price: num(limit), stop_price: num(stop), trail_amount: num(trail),
          take_profit: num(tp), stop_loss: num(sl),
        }),
      });
      onPlaced();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-3 self-start`}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">New order</h2>
        <span className="tabular-nums text-sm text-slate-500">{last ?? '—'}</span>
      </div>

      <select className={input} value={symbol} onChange={(e) => setSymbol(e.target.value)}>
        {instruments.map((i) => <option key={i.symbol}>{i.symbol}</option>)}
      </select>

      <div className="flex gap-1">
        {(['buy', 'sell'] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSide(s)} aria-pressed={side === s}
            className={`flex-1 rounded px-2 py-2 text-sm font-medium uppercase ${side === s
              ? s === 'buy' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
              : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
            {s}
          </button>
        ))}
      </div>

      <select className={input} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
        {TYPES.map((t) => <option key={t} value={t}>{t.replace('_', '-')}</option>)}
      </select>

      <Labelled label="Quantity">
        <input className={input} required type="number" step="any" min="0" value={qty}
          onChange={(e) => setQty(e.target.value)} />
      </Labelled>

      {(type === 'limit' || type === 'stop_limit') && (
        <Labelled label="Limit price">
          <input className={input} required type="number" step="any" min="0" value={limit}
            onChange={(e) => setLimit(e.target.value)} />
        </Labelled>
      )}
      {(type === 'stop' || type === 'stop_limit') && (
        <Labelled label="Stop price">
          <input className={input} required type="number" step="any" min="0" value={stop}
            onChange={(e) => setStop(e.target.value)} />
        </Labelled>
      )}
      {type === 'trailing_stop' && (
        <Labelled label="Trail amount">
          <input className={input} required type="number" step="any" min="0" value={trail}
            onChange={(e) => setTrail(e.target.value)} />
        </Labelled>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Labelled label="Take profit">
          <input className={input} type="number" step="any" min="0" value={tp}
            onChange={(e) => setTp(e.target.value)} />
        </Labelled>
        <Labelled label="Stop loss">
          <input className={input} type="number" step="any" min="0" value={sl}
            onChange={(e) => setSl(e.target.value)} />
        </Labelled>
      </div>

      <div className="rounded bg-slate-50 p-2 text-xs dark:bg-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-slate-500">Risk</span>
          <input className={`${field} w-16 py-1`} type="number" step="0.1" min="0" max="100"
            value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
          <span className="text-slate-500">% of balance</span>
        </div>
        <p className="mt-1 text-slate-500">
          {suggested > 0
            ? <>Size for this stop: <button type="button" className="font-medium underline"
                onClick={() => setQty(String(suggested))}>{suggested}</button> (capped at {leverage}× margin)</>
            : 'Enter a stop loss to size the position.'}
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button className={`${btn} w-full`} disabled={busy}>
        {busy ? 'Placing…' : `${side.toUpperCase()} ${symbol}`}
      </button>
    </form>
  );
}

const Labelled = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block text-xs text-slate-500">{label}{children}</label>
);

// ------------------------------------------------------------------ panels

const Th = ({ children }: { children?: React.ReactNode }) =>
  <th className="px-3 py-1.5 text-left font-medium text-slate-500">{children}</th>;
const Td = ({ children, className = '' }: { children: React.ReactNode; className?: string }) =>
  <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
const Empty = ({ children }: { children: React.ReactNode }) =>
  <p className="p-4 text-sm text-slate-500">{children}</p>;

function Positions({ rows, prices }: { rows: Pos[]; prices: Record<string, number> }) {
  if (!rows.length) return <Empty>No open positions.</Empty>;
  return (
    <table className="w-full text-sm">
      <thead><tr><Th>Symbol</Th><Th>Qty</Th><Th>Entry</Th><Th>Price</Th><Th>Open P&L</Th></tr></thead>
      <tbody>
        {rows.map((p) => {
          // Prefer the live tick over the price the request was answered with.
          const price = prices[p.symbol] ?? p.price;
          const open = (price - p.avg_price) * p.qty;
          return (
            <tr key={p.symbol} className="border-t border-slate-100 dark:border-slate-800">
              <Td className="font-medium">{p.symbol}</Td>
              <Td className={`tabular-nums ${p.qty > 0 ? 'text-green-600' : 'text-red-600'}`}>{p.qty}</Td>
              <Td className="tabular-nums">{p.avg_price}</Td>
              <Td className="tabular-nums">{price}</Td>
              <Td className={`tabular-nums ${pnl(open)}`}>{signed(open)}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Orders({ rows, onCancel }: { rows: Order[]; onCancel: (id: string) => void }) {
  if (!rows.length) return <Empty>No working orders.</Empty>;
  return (
    <table className="w-full text-sm">
      <thead><tr><Th>Symbol</Th><Th>Side</Th><Th>Type</Th><Th>Qty</Th><Th>Trigger</Th><Th></Th></tr></thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.id} className="border-t border-slate-100 dark:border-slate-800">
            <Td className="font-medium">{o.symbol}</Td>
            <Td className={o.side === 'buy' ? 'text-green-600' : 'text-red-600'}>{o.side}</Td>
            <Td>
              {o.type.replace('_', '-')}
              {o.parent_order_id && <span className="ml-1 text-xs text-slate-500">exit</span>}
            </Td>
            <Td className="tabular-nums">{o.qty}</Td>
            <Td className="tabular-nums">{o.limit_price ?? o.stop_price ?? '—'}</Td>
            <Td><button onClick={() => onCancel(o.id)}
              className="text-xs text-slate-500 hover:text-red-600">cancel</button></Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function History({ rows }: { rows: Trade[] }) {
  if (!rows.length) return <Empty>No trades yet.</Empty>;
  return (
    <table className="w-full text-sm">
      <thead><tr><Th>Filled</Th><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th><Th>Price</Th></tr></thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
            <Td className="text-slate-500">{new Date(t.filled_at).toLocaleString()}</Td>
            <Td className="font-medium">{t.symbol}</Td>
            <Td className={t.side === 'buy' ? 'text-green-600' : 'text-red-600'}>{t.side}</Td>
            <Td className="tabular-nums">{t.qty}</Td>
            <Td className="tabular-nums">{t.price}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
