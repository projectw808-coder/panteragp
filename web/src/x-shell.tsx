import { useEffect, useRef, useState } from 'react';
import {
  BarChart3, Bot, ChartCandlestick, ChartPie, Check, ChevronDown, Coins, FileText, Headset, Inbox, LayoutDashboard,
  LayoutGrid, ListTodo, LogOut, Mail, Moon, Plus, Rocket, Search, Settings, ShieldCheck, Sun, User, Users, Wallet, X,
} from 'lucide-react';
import { api, useApi } from './api.ts';
import { headline, unit, type Accounts } from './balance.tsx';
import { Coin } from './landing.tsx';
import { NotificationBell } from './notifications.tsx';

/**
 * The frame of the signed-in platform, to the October 2026 client-area plan: an icon rail
 * and a top bar carrying three live prices, the bell and who is signed in. Every price
 * here is the platform's own quote, the same feed the public page reads.
 */

export const NAV_ICONS: Record<string, typeof LayoutGrid> = {
  '#/admin': LayoutDashboard, '#/clients': Users, '#/tasks': ListTodo, '#/compliance': ShieldCheck,
  '#/requests': Inbox, '#/reports': BarChart3, '#/email': Mail,
  '#/overview': LayoutGrid, '#/charts': ChartCandlestick, '#/trade': Bot, '#/portfolios': ChartPie,
  '#/staking': Coins, '#/ipos': Rocket, '#/wallet': Wallet, '#/documents': FileText,
  '#/support': Headset, '#/settings': Settings, '#/profile': User,
};

type Quote = { symbol: string; price: number; change_pct: number; spark: number[] };
const fmt = (p: number) => p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: p < 10 ? 4 : 2 });

/** Live quotes, re-read every five seconds while the tab is visible. */
export function useQuotes() {
  const q = useApi<{ quotes: Quote[] }>('/public/ticker?platform=1');
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) q.reload(); }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return q.data?.quotes ?? [];
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'PG';

/** What sits on the price line until the user changes it. */
const DEFAULT_LINE = ['BTCUSD', 'ETHUSD', 'XAUUSD'];
const LINE_KEY = 'topbar.symbols';
const LINE_MAX = 12;

type Instrument = { symbol: string; display_name: string; asset_class: string | null };

function savedLine(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LINE_KEY) ?? 'null');
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.slice(0, LINE_MAX);
  } catch { /* private window or a bad value: fall back */ }
  return DEFAULT_LINE;
}

const FX = /^(EUR|GBP|AUD|NZD|USD|JPY|CHF|CAD)(EUR|GBP|AUD|NZD|USD|JPY|CHF|CAD)$/;

/** BTCUSD reads as BTC and EURUSD as EUR/USD; an ETF keeps its ticker. */
const short = (symbol: string) =>
  FX.test(symbol) ? `${symbol.slice(0, 3)}/${symbol.slice(3)}` : symbol.length > 3 && symbol.endsWith('USD') ? symbol.slice(0, -3) : symbol;

/**
 * The top bar's price line: the instruments this user picked, each with its day move, a
 * flash when the price ticks, and a way to add more or take one off. Kept in this browser.
 */
function PriceLine() {
  const [line, setLine] = useState<string[]>(savedLine);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});
  const [picking, setPicking] = useState(false);
  const last = useRef<Record<string, number>>({});
  const strip = useRef<HTMLUListElement>(null);

  // A wheel over the line scrolls it sideways when it holds more than fits.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const save = (next: string[]) => {
    setLine(next);
    try { localStorage.setItem(LINE_KEY, JSON.stringify(next)); } catch { /* private window */ }
  };

  useEffect(() => {
    if (!line.length) return;
    let gone = false;
    const read = async () => {
      if (document.hidden) return;
      try {
        const r = await api<{ quotes: Quote[] }>(`/ticker?symbols=${encodeURIComponent(line.join(','))}`);
        if (gone) return;
        const moved: Record<string, 'up' | 'down'> = {};
        for (const q of r.quotes) {
          const before = last.current[q.symbol];
          if (before !== undefined && q.price !== before) moved[q.symbol] = q.price > before ? 'up' : 'down';
          last.current[q.symbol] = q.price;
        }
        setQuotes(Object.fromEntries(r.quotes.map((q) => [q.symbol, q])));
        if (Object.keys(moved).length) {
          setFlash(moved);
          setTimeout(() => { if (!gone) setFlash({}); }, 900);
        }
      } catch { /* offline: keep the last prices */ }
    };
    read();
    const id = setInterval(read, 5000);
    return () => { gone = true; clearInterval(id); };
  }, [line]);

  return (
    <div className="x-pline">
      <ul ref={strip} className="x-quotes" aria-label="Live prices">
        {line.map((sym) => {
          const q = quotes[sym];
          const up = (q?.change_pct ?? 0) >= 0;
          return (
            <li key={sym} className={`x-qchip ${flash[sym] ? `is-${flash[sym]}` : ''}`}>
              <span className="x-qcoin" aria-hidden><Coin symbol={sym} /></span>
              <span className="x-qsym">{short(sym)}</span>
              {q
                ? <>
                    <span className="x-qpx">{FX.test(sym) ? '' : '$'}{fmt(q.price)}</span>
                    <span className={`x-qchg ${up ? 'is-up' : 'is-down'}`}>{up ? '▲' : '▼'} {Math.abs(q.change_pct).toFixed(2)}%</span>
                  </>
                : <span className="skeleton inline-block h-3 w-20" />}
              <button type="button" className="x-qdel" onClick={() => save(line.filter((s) => s !== sym))}
                aria-label={`Remove ${short(sym)} from the price line`} title="Remove">
                <X size={11} strokeWidth={2.6} aria-hidden />
              </button>
            </li>
          );
        })}
        {!line.length && <li className="text-[13px] text-mist">Add the prices you want to follow</li>}
      </ul>
      <div className="relative shrink-0">
        <button type="button" onClick={() => setPicking((o) => !o)} aria-expanded={picking} aria-haspopup="dialog"
          className="x-qadd focus-ring" title="Add or remove prices">
          <Plus size={15} strokeWidth={2.4} aria-hidden /><span className="sr-only">Add or remove prices</span>
        </button>
        {picking && <PricePicker line={line} onChange={save} onClose={() => setPicking(false)} />}
      </div>
    </div>
  );
}

const GROUPS = [['all', 'All'], ['crypto', 'Crypto'], ['fx', 'Forex'], ['metals', 'Metals'], ['etf', 'ETFs']] as const;

/** Search every instrument on the platform and tick the ones to show on the line. */
function PricePicker({ line, onChange, onClose }: {
  line: string[]; onChange: (next: string[]) => void; onClose: () => void;
}) {
  const all = useApi<Instrument[]>('/instruments');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<(typeof GROUPS)[number][0]>('all');
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const off = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!box.current?.contains(t) && !t.closest('.x-qadd')) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('mousedown', off); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', esc); };
  }, [onClose]);

  const needle = q.trim().toLowerCase().replace('/', '');
  const rows = (all.data ?? []).filter((i) =>
    (group === 'all' || i.asset_class === group)
    && (!needle || i.symbol.toLowerCase().includes(needle) || i.display_name.toLowerCase().includes(needle)));
  // What is on the line comes first, in line order, so taking one off is always one click away.
  rows.sort((a, b) => {
    const ia = line.indexOf(a.symbol), ib = line.indexOf(b.symbol);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.symbol.localeCompare(b.symbol);
  });
  const full = line.length >= LINE_MAX;
  const toggle = (sym: string) => {
    if (line.includes(sym)) onChange(line.filter((s) => s !== sym));
    else if (!full) onChange([...line, sym]);
  };

  return (
    <div ref={box} role="dialog" aria-label="Choose prices for the top bar" className="x-qpick">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold">Price line</p>
          <p className="text-xs text-slate-ink">{line.length} of {LINE_MAX} shown · saved in this browser</p>
        </div>
        <button type="button" className="x-btn-sm" onClick={() => onChange(DEFAULT_LINE)}>Reset</button>
      </div>
      <label className="x-qsearch">
        <Search size={15} aria-hidden className="text-mist" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search BTC, gold, EUR/USD, SPY…"
          aria-label="Search instruments" />
      </label>
      <div className="x-qgroups" role="tablist">
        {GROUPS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={group === k} className={group === k ? 'is-on' : ''}
            onClick={() => setGroup(k)}>{label}</button>
        ))}
      </div>
      <ul className="x-qlist">
        {!all.data && <li className="px-2 py-3 text-xs text-slate-ink">Loading instruments…</li>}
        {rows.map((i) => {
          const on = line.includes(i.symbol);
          return (
            <li key={i.symbol}>
              <button type="button" onClick={() => toggle(i.symbol)} disabled={!on && full} aria-pressed={on}
                className={on ? 'is-on' : ''}>
                <span className="x-qcoin" aria-hidden><Coin symbol={i.symbol} /></span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block text-[13px] font-semibold">{short(i.symbol)}</span>
                  <span className="block truncate text-[11.5px] text-slate-ink">{i.display_name}</span>
                </span>
                <span className="x-qtick" aria-hidden>{on ? <Check size={13} strokeWidth={3} /> : <Plus size={13} strokeWidth={2.6} />}</span>
              </button>
            </li>
          );
        })}
        {all.data && !rows.length && <li className="px-2 py-3 text-xs text-slate-ink">Nothing matches “{q}”.</li>}
      </ul>
      {full && <p className="text-xs text-ember-ink">The line holds {LINE_MAX}. Take one off to add another.</p>}
    </div>
  );
}

export function XTopBar({ name, client, dark, setDark, onLogout }: {
  name: string; client: boolean; dark: boolean; setDark: (v: boolean) => void; onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', off); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="x-topbar">
      <PriceLine />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {client && <BalanceChip />}
        <NotificationBell variant="top" />
        <div ref={menu} className="relative">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
            className="focus-ring x-user">
            <span className="x-avatar" aria-hidden>{initials(name)}</span>
            <span className="hidden max-w-40 truncate sm:inline">{name}</span>
            <ChevronDown size={15} aria-hidden className="text-mist" />
          </button>
          {open && (
            <div role="menu" className="x-menu">
              {client && <a role="menuitem" href="#/profile" onClick={() => setOpen(false)}><User size={15} aria-hidden />Profile</a>}
              <a role="menuitem" href="#/settings" onClick={() => setOpen(false)}><Settings size={15} aria-hidden />Settings</a>
              <button role="menuitem" type="button" onClick={() => setDark(!dark)}>{dark ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}{dark ? 'Light theme' : 'Dark theme'}</button>
              <button role="menuitem" type="button" onClick={onLogout} className="text-down"><LogOut size={15} aria-hidden />Sign out</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The client's balance, highlighted in the top bar on every page: the same total the old
 * balance strip led with, and beside it the pot they chose to show on their balance.
 */
function BalanceChip() {
  const acc = useApi<Accounts>('/accounts');
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) acc.reload(); }, 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const a = acc.data;
  if (!a) return <span className="x-balance-chip"><span className="x-bal-label">Balance</span><span className="skeleton inline-block h-4 w-24" /></span>;
  const total = headline(a);
  // The same equity the overview leads with: holdings plus open P&L. With one non-dollar
  // currency the holding is shown as itself, as everywhere else.
  const native = unit(a).code !== null;
  const value = !native && a.equity_usd !== undefined ? Number(a.equity_usd) : total.value;
  const pot = a.portfolios.find((p) => p.featured);
  return (
    <>
      {pot && (
        <a href="#/portfolios" className="x-pot-chip hidden xl:flex" title="The pot you show on your balance">
          <span className="x-bal-label">{pot.name}</span>
          <span className="tabular-nums">{Number(pot.balance).toLocaleString('en-US', { maximumFractionDigits: 2 })} {pot.currency}</span>
        </a>
      )}
      <a href="#/overview" className="x-balance-chip"
        title={a.book && !native ? `Holdings ${total.format(a.book.holdings_usd)} · open P&L ${total.format(a.book.open_pnl)}` : 'Your total balance'}>
        <span className="x-bal-label">Equity</span>
        <span className="x-bal-value">{total.format(value)}</span>
      </a>
    </>
  );
}

/** A coin, a price, its move and a small line: the mini cards on the overview. */
export function QuoteCard({ q, name }: { q: Quote; name: string }) {
  const up = q.change_pct >= 0;
  const vals = q.spark;
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * 80).toFixed(1)},${(26 - ((v - lo) / span) * 22).toFixed(1)}`).join(' ');
  return (
    <div className="x-card tile lift flex items-center gap-3 px-4 py-3">
      <Coin symbol={q.symbol} />
      <div className="min-w-0">
        <p className="text-[13px] text-mist">{name}</p>
        <p className="text-[16px] font-semibold tabular-nums">${fmt(q.price)}</p>
      </div>
      <div className="ml-auto flex flex-col items-end gap-1">
        {vals.length > 1 && (
          <svg width="80" height="28" viewBox="0 0 80 28" aria-hidden>
            <path d={d} fill="none" stroke={up ? 'var(--color-up)' : 'var(--color-down)'} strokeWidth="1.6" className="lp-draw-x" pathLength={1} />
          </svg>
        )}
        <span className={`text-[12px] tabular-nums ${up ? 'text-up' : 'text-down'}`}>{up ? '+' : ''}{q.change_pct.toFixed(2)}%</span>
      </div>
    </div>
  );
}

/** The client area's stat tile — an ember icon chip, the label, the figure, a note — for any page's header row. */
export function StatTile({ label, value, note, Icon, tone = '', children }: {
  label: string; value?: React.ReactNode; note?: React.ReactNode; Icon: typeof User; tone?: string; children?: React.ReactNode;
}) {
  return (
    <div className="x-card x-holo tile lift flex flex-col p-4">
      <div className="flex items-center gap-3">
        <span className="x-chip"><Icon size={18} strokeWidth={1.9} aria-hidden /></span>
        <span className="text-[13px] text-mist">{label}</span>
      </div>
      {value !== undefined && <p className={`mt-3 truncate text-[22px] leading-none font-bold tabular-nums ${tone}`}>{value}</p>}
      {children}
      {note && <p className="mt-2 text-xs text-slate-ink">{note}</p>}
    </div>
  );
}
