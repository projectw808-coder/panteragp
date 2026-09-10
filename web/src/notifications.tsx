import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { subscribe } from './feed.ts';

type Notification = {
  id: number; kind: string; title: string; body: string | null;
  read_at: string | null; created_at: string;
};

const when = (iso: string) => {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

const ICON: Record<string, string> = {
  'order.filled': '✓', deposit: '↓', withdrawal: '↑',
  kyc: '🛡', interest: '%', credit: '+', message: '✉',
  // Staff kinds. The bell is the same component on both sides — one inbox, two audiences.
  'flag.raised': '⚑', 'kyc.uploaded': '🛡', 'ticket.activity': '✉',
  'withdrawal.request': '↑', 'task.assigned': '☑',
};

/** The bell in the header: unread count, and the list when opened. */
export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  // Where to draw the panel, measured from the button when it opens.
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);

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
   * It also opened downwards from a button that sits at the very bottom of the screen, so
   * even unclipped it would have been below the fold. Clicking the bell did work; there
   * was simply never anything to see.
   */
  function toggle() {
    // mousedown outside the panel has already closed it by the time this click lands, so
    // "open" is false here even when the panel was on screen a moment ago. Nothing to undo:
    // the close already happened and reopening on the same gesture would be wrong.
    if (open) return setOpen(false);
    const r = bell.current?.getBoundingClientRect();
    // Above the button and clear of the left edge; opening upward because the bell lives
    // at the bottom of the rail and there is no room underneath it.
    if (r) setAt({ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 10 });
    setOpen(true);
    load();
  }

  return (
    <div className="relative">
      <button ref={bell} onClick={toggle} aria-expanded={open}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        className="relative text-slate-ink transition-colors hover:text-vellum">
        {/* A drawn bell rather than a glyph: ☍ renders as a box or a hyphen in half the
            fonts this ships to, which reads as a broken button. */}
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M10 2.5a5 5 0 0 0-5 5v3l-1.5 2.5h13L15 10.5v-3a5 5 0 0 0-5-5Z" />
          <path d="M8 15.5a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-2 -right-2.5 rounded-full bg-ember px-1 text-[10px] leading-4 font-medium text-graphite">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && at && createPortal(
        <div ref={panel} style={{ left: at.left, bottom: at.bottom }}
          className="fixed z-50 w-80 rounded-lg border border-pebble bg-vellum shadow-lg dark:border-white/10 dark:bg-onyx">
          <div className="flex items-center justify-between border-b border-pebble px-3 py-2 dark:border-white/10">
            <span className="text-xs font-semibold">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs text-slate-ink hover:text-obsidian dark:hover:text-vellum">
                mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-auto">
            {items.map((n) => (
              <li key={n.id}
                className={`border-b border-pebble px-3 py-2 last:border-0 dark:border-white/10 ${
                  n.read_at ? '' : 'bg-bone dark:bg-white/5'}`}>
                <div className="flex items-baseline gap-2">
                  <span className="text-mist">{ICON[n.kind] ?? '•'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{n.title}</p>
                    {n.body && <p className="text-xs text-slate-ink">{n.body}</p>}
                    <p className="text-xs text-mist">{when(n.created_at)}</p>
                  </div>
                  {!n.read_at && (
                    <button onClick={() => markRead(n.id)}
                      className="text-xs text-mist hover:text-obsidian dark:hover:text-vellum">
                      read
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {!items.length && <p className="px-3 py-4 text-sm text-slate-ink">Nothing yet.</p>}
        </div>,
        document.body,
      )}
    </div>
  );
}
