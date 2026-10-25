import { useEffect, useRef, useState } from 'react';
import {
  BarChart3, Bot, ChartCandlestick, ChartPie, ChevronDown, Coins, FileText, Headset, Inbox, LayoutDashboard,
  LayoutGrid, ListTodo, LogOut, Mail, Moon, Rocket, Settings, ShieldCheck, Sun, User, Users, Wallet,
} from 'lucide-react';
import { useApi } from './api.ts';
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
const NAMES: Record<string, string> = { BTCUSD: 'BTC', ETHUSD: 'ETH', XAUUSD: 'XAU' };
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

export function XTopBar({ name, client, dark, setDark, onLogout }: {
  name: string; client: boolean; dark: boolean; setDark: (v: boolean) => void; onLogout: () => void;
}) {
  const quotes = useQuotes().filter((q) => NAMES[q.symbol]);
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
      <ul className="x-quotes" aria-label="Live prices">
        {quotes.map((q) => (
          <li key={q.symbol}>
            <span className="x-qsym">{NAMES[q.symbol]}</span>
            <span className="x-qpx">${fmt(q.price)}</span>
            <span className={q.change_pct >= 0 ? 'text-up' : 'text-down'}>{q.change_pct >= 0 ? '+' : ''}{q.change_pct.toFixed(2)}%</span>
          </li>
        ))}
        {!quotes.length && <li><span className="skeleton inline-block h-3 w-56" /></li>}
      </ul>
      <div className="ml-auto flex items-center gap-2">
        <span className="x-iconbtn"><NotificationBell /></span>
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
