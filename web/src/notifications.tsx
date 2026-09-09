import { useEffect, useRef, useState } from 'react';
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
};

/** The bell in the header: unread count, and the list when opened. */
export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

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
      if (!box.current?.contains(e.target as Node)) setOpen(false);
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

  return (
    <div ref={box} className="relative">
      <button onClick={() => { setOpen((v) => !v); if (!open) load(); }}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        className="relative text-sm text-slate-ink hover:text-obsidian dark:hover:text-vellum">
        ☍
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-2 rounded-full bg-ember px-1 text-[10px] font-medium text-graphite">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-pebble bg-vellum dark:border-white/10 dark:bg-onyx">
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
        </div>
      )}
    </div>
  );
}
