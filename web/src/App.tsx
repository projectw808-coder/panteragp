import { useEffect, useState, type FormEvent } from 'react';
import { api, token, useApi } from './api.ts';
import { AdminView } from './admin.tsx';
import { ChartsView } from './chart.tsx';
import { NotificationBell } from './notifications.tsx';
import { ComplianceView, ReportsView } from './compliance.tsx';
import { TradeView } from './trade.tsx';
import { ClientDetail, ClientList, TaskList } from './views.tsx';

type Me = { sub: string; kind: 'staff' | 'client'; role: string };

/** ponytail: hash routing, 4 flat routes. Swap in react-router when routes nest. */
function useHash() {
  const [hash, setHash] = useState(() => location.hash.slice(1) || '/clients');
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/clients');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function useDarkMode() {
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);
  return [dark, setDark] as const;
}

export function App() {
  const [authed, setAuthed] = useState(!!token.get());
  const [dark, setDark] = useDarkMode();
  return authed
    ? <Shell dark={dark} setDark={setDark} onLogout={() => { token.clear(); setAuthed(false); }} />
    : <Login onDone={() => setAuthed(true)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [as, setAs] = useState<'staff' | 'client'>('staff');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('/auth/login', {
        method: 'POST', body: JSON.stringify({ email, password, as }),
      });
      token.set(r.token);
      location.hash = as === 'client' ? '/charts' : '/clients';
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center bg-slate-100 dark:bg-slate-950">
      <form onSubmit={submit} className="w-80 space-y-3 rounded-lg bg-white p-6 shadow dark:bg-slate-900">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Sign in</h1>
        <div className="flex gap-1 text-sm">
          {(['staff', 'client'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setAs(k)} aria-pressed={as === k}
              className={`flex-1 rounded px-2 py-1 ${as === k
                ? 'bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
              {k === 'staff' ? 'Staff' : 'Trader'}
            </button>
          ))}
        </div>
        <input className={input} type="email" placeholder="Email" required autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className={input} type="password" placeholder="Password" required minLength={8}
          autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button className={btn} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function Shell({ dark, setDark, onLogout }: {
  dark: boolean; setDark: (v: boolean) => void; onLogout: () => void;
}) {
  const hash = useHash();
  const { data: me } = useApi<Me>('/me');
  const clientId = hash.match(/^\/clients\/([0-9a-f-]{36})$/)?.[1];
  const crm = me?.kind === 'staff';   // traders get the trading environment only
  const charts = hash === '/charts';
  const trading = me?.kind === 'client';   // only an account holder can place orders
  const compliance = me?.role === 'compliance' || me?.role === 'admin';
  const admin = me?.role === 'admin';

  return (
    <div className="flex h-full flex-col bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center gap-6 border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-900">
        <span className="font-semibold">{crm ? 'CRM' : 'Terminal'}</span>
        <nav className="flex gap-4 text-sm">
          {admin && <a href="#/admin" className={hash === '/admin' ? navOn : navOff}>Dashboard</a>}
          {crm && <a href="#/clients" className={hash.startsWith('/clients') ? navOn : navOff}>Clients</a>}
          {crm && <a href="#/tasks" className={hash === '/tasks' ? navOn : navOff}>My tasks</a>}
          {compliance && <a href="#/compliance" className={hash === '/compliance' ? navOn : navOff}>Compliance</a>}
          {crm && <a href="#/reports" className={hash === '/reports' ? navOn : navOff}>Reports</a>}
          <a href="#/charts" className={charts ? navOn : navOff}>Charts</a>
          {trading && <a href="#/trade" className={hash === '/trade' ? navOn : navOff}>Trade</a>}
        </nav>
        <span className="ml-auto text-sm text-slate-500">{me?.role}</span>
        {trading && <NotificationBell />}
        <button onClick={() => setDark(!dark)} aria-label="Toggle dark mode"
          className="text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">
          {dark ? '☀' : '☾'}
        </button>
        <button onClick={onLogout} className="text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">
          Sign out
        </button>
      </header>
      <main className={`min-h-0 flex-1 p-4 ${charts ? '' : 'overflow-auto p-6'}`}>
        {charts ? <ChartsView dark={dark} />
          : hash === '/admin' ? (admin ? <AdminView /> : <Denied />)
          : hash === '/compliance' ? (compliance ? <ComplianceView role={me?.role} /> : <Denied />)
          : hash === '/reports' ? (crm ? <ReportsView /> : <Denied />)
          : hash === '/trade' ? (trading ? <TradeView /> : <p className="text-sm text-slate-500">Trading is for account holders.</p>)
          : !crm ? <TradeView />
          : clientId ? <ClientDetail id={clientId} me={me} />
          : hash === '/tasks' ? <TaskList />
          : <ClientList />}
      </main>
    </div>
  );
}

const Denied = () => <p className="text-sm text-slate-500">You do not have access to this page.</p>;

const navOn = 'font-medium text-slate-900 dark:text-slate-100';
const navOff = 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100';
// `field` carries no width so a caller can size it; `input` is the full-width default.
// (A `w-32` next to `w-full` does not win — same specificity, and w-full is defined later.)
export const field = 'rounded border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-slate-400';
export const input = `w-full ${field}`;
export const btn = 'rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-slate-400';
export const card = 'rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900';
