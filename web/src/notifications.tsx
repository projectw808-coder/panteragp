import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownLeft, ArrowUpRight, Bell, BellOff, CheckCheck, CircleCheck, Flag, ListTodo, Mail, MessageSquare, Percent, Plus, ShieldCheck,
} from 'lucide-react';
import { api } from './api.ts';
import { subscribe } from './feed.ts';

export type Notification = {
  id: number; kind: string; title: string; body: string | null;
  read_at: string | null; created_at: string;
};

export const when = (iso: string) => {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

export const ICON: Record<string, typeof Bell> = {
  'order.filled': CircleCheck, deposit: ArrowDownLeft, withdrawal: ArrowUpRight,
  kyc: ShieldCheck, interest: Percent, credit: Plus, message: Mail,
  // Staff kinds. The bell is the same component on both sides — one inbox, two audiences.
  'flag.raised': Flag, 'kyc.uploaded': ShieldCheck, 'ticket.activity': MessageSquare,
  'withdrawal.request': ArrowUpRight, 'task.assigned': ListTodo,
};

/** Money in and good news read green, money out and flags red; the rest stay ember. */
export const TONE: Record<string, string> = {
  'order.filled': 'is-up', deposit: 'is-up', interest: 'is-up', credit: 'is-up',
  withdrawal: 'is-down', 'withdrawal.request': 'is-down', 'flag.raised': 'is-down',
};

/** The bell in the header: unread count, and the list when opened. */
export function NotificationBell({ variant = 'plain' }: { variant?: 'plain' | 'top' }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  // Where to draw the panel, measured from the button when it opens.
  const [at, setAt] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const [tab, setTab] = useState<'all' | 'unread'>('all');

  const load = async () => {
    try {
      setItems(await api<Notification[]>('/notifications?limit=20'));
      setUnread((await api<{ unread: number }>('/notifications/unread-count')).unread);
    } catch { /* signed out or offline; the next tick will retry */ }
  };

  useEffect(() => { load(); }, []);

  // The socket only stays open while something is subscribed to it, and the bell is on
  // every page whereas the price feed is not. Subscribing with a handler that ignores
  // ticks is what keeps notifications arriving away from the charts.
  useEffect(() => subscribe(() => {}), []);
  useEffect(() => {
    const handler = (e: Event) => {
      const n = (e as CustomEvent<Notification>).detail;
      setItems((prev) => [n, ...prev].slice(0, 20));
      setUnread((u) => u + 1);
    };
    addEventListener('notification', handler);
    return () => removeEventListener('notification', handler);
  }, []);

  // Clicking anywhere else closes the panel.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || bell.current?.contains(target)) return;
      setOpen(false);
    };
    addEventListener('mousedown', away);
    return () => removeEventListener('mousedown', away);
  }, [open]);

  async function markRead(id: number) {
    await api(`/notifications/${id}/read`, { method: 'POST' });
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
  }

  async function markAll() {
    await api('/notifications/read-all', { method: 'POST' });
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnread(0);
  }

  /**
   * The panel is drawn into the body rather than next to the button, and placed from the
   * button's own position.
   *
   * It used to be an absolutely positioned child of the bell, which put it inside the nav
   * rail — a 224px column with overflow:hidden — so a 320px panel was clipped to nothing.
   * Now the bell lives in the top bar, so the panel drops down under it, its right edge
   * lined up with the button's and kept on screen; a bell low on the screen still opens
   * upward.
   */
  function place() {
    const r = bell.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(400, innerWidth - 16);
    const left = Math.min(Math.max(8, r.right - width), innerWidth - width - 8);
    setAt(r.top < innerHeight / 2
      ? { left, width, top: r.bottom + 10 }
      : { left, width, bottom: innerHeight - r.top + 10 });
  }

  function toggle() {
    // mousedown outside the panel has already closed it by the time this click lands, so
    // "open" is false here even when the panel was on screen a moment ago. Nothing to undo:
    // the close already happened and reopening on the same gesture would be wrong.
    if (open) return setOpen(false);
    place();
    setOpen(true);
    load();
  }

  // Keep it attached to the bell when the window changes size; Escape closes it.
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('resize', place); addEventListener('keydown', esc);
    return () => { removeEventListener('resize', place); removeEventListener('keydown', esc); };
  }, [open]);

  const shown = tab === 'unread' ? items.filter((n) => !n.read_at) : items;

  return (
    <div className="relative">
      <button ref={bell} onClick={toggle} aria-expanded={open} aria-haspopup="dialog"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        className={variant === 'top'
          ? `x-iconbtn x-bell focus-ring ${open ? 'is-open' : ''} ${unread ? 'has-new' : ''}`
          : 'relative text-mist transition-colors hover:text-vellum'}>
        <Bell size={variant === 'top' ? 17 : 16} strokeWidth={1.8} aria-hidden />
        {unread > 0 && <span className="x-bell-count">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && at && createPortal(
        <div ref={panel} role="dialog" aria-label="Notifications" className={`app-x x-notes ${at.top !== undefined ? 'is-down' : 'is-up'}`}
          style={{ left: at.left, width: at.width, top: at.top, bottom: at.bottom }}>
          <div className="x-notes-head">
            <span className="text-[15px] font-semibold">Notifications</span>
            {unread > 0 && <span className="x-badge">{unread} new</span>}
            {unread > 0 && <button type="button" onClick={markAll} className="x-btn-sm ml-auto inline-flex items-center gap-1.5"><CheckCheck size={14} aria-hidden />Mark all read</button>}
          </div>
          <div className="x-notes-tabs" role="tablist">
            {(['all', 'unread'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)}>
                {t === 'all' ? 'All' : `Unread${unread ? ` · ${unread}` : ''}`}
              </button>
            ))}
          </div>
          <ul className="x-notes-list">
            {shown.map((n) => {
              const Icon = ICON[n.kind] ?? Bell;
              return (
                <li key={n.id}>
                  <button type="button" className={`x-note ${n.read_at ? '' : 'is-new'}`} onClick={() => { if (!n.read_at) markRead(n.id); }}
                    title={n.read_at ? undefined : 'Mark as read'}>
                    <span className={`x-note-icon ${TONE[n.kind] ?? ''}`} aria-hidden><Icon size={16} strokeWidth={1.9} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-semibold leading-snug">{n.title}</span>
                      {n.body && <span className="x-note-body">{n.body}</span>}
                      <span className="mt-1 block text-[11.5px] text-mist">{when(n.created_at)}</span>
                    </span>
                    {!n.read_at && <i className="x-note-dot" aria-label="Unread" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {!shown.length && (
            <div className="grid place-items-center gap-2 px-6 py-10 text-center">
              <span className="x-drop-icon" aria-hidden><BellOff size={22} /></span>
              <p className="text-[14px] font-semibold">{tab === 'unread' ? 'You are all caught up' : 'Nothing yet'}</p>
              <p className="text-xs text-slate-ink">Fills, deposits, messages and document updates land here as they happen.</p>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
