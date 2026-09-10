import { useEffect, useState, type FormEvent } from 'react';
import { api, token, useApi } from './api.ts';
import { AdminView } from './admin.tsx';
import { ChartsView } from './chart.tsx';
import { NotificationBell } from './notifications.tsx';
import { SupportPanel, SupportQueue } from './tickets.tsx';
import { PortfoliosPanel } from './portfolio.tsx';
import { BalanceBar } from './balance.tsx';
import { ProfileView } from './profile.tsx';
import { WalletView } from './wallet-connect.tsx';
import { TaskBoard } from './board.tsx';
import { ComplianceView, DocumentsPanel, ReportsView } from './compliance.tsx';
import { TradeView } from './trade.tsx';
import { ClientWorkspace } from './client-workspace.tsx';
import { ClientList } from './views.tsx';
import { SettingsView } from './settings.tsx';
import { Landing } from './landing.tsx';

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
  // What a visitor with no session sees: the public page first, the forms on request.
  const [gate, setGate] = useState<'landing' | 'signin' | 'register'>('landing');

  if (authed) {
    return <Shell dark={dark} setDark={setDark} onLogout={() => { token.clear(); setAuthed(false); setGate('landing'); }} />;
  }
  if (gate === 'landing') {
    return <Landing onSignIn={() => setGate('signin')} onRegister={() => setGate('register')} />;
  }
  return (
    <Login mode={gate} onDone={() => setAuthed(true)}
      onMode={(m) => setGate(m)} onBack={() => setGate('landing')} />
  );
}

function Login({ mode, onDone, onMode, onBack }: {
  mode: 'signin' | 'register';
  onDone: () => void;
  onMode: (m: 'signin' | 'register') => void;
  onBack: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [as, setAs] = useState<'staff' | 'client'>('staff');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const registering = mode === 'register';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (registering) {
        // Registration signs you straight in — the password was just proven.
        const r = await api<{ token: string }>('/auth/register', {
          method: 'POST', body: JSON.stringify({ name, email, password }),
        });
        token.set(r.token);
        location.hash = '/charts';
      } else {
        const r = await api<{ token: string }>('/auth/login', {
          method: 'POST', body: JSON.stringify({ email, password, as }),
        });
        token.set(r.token);
        location.hash = as === 'client' ? '/charts' : '/clients';
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    // Sign-in is the one full-bleed dark surface in the app: it is chrome, not data.
    <div className="grid h-full place-items-center bg-obsidian">
      <form onSubmit={submit} className="w-80 space-y-3 rounded-xl bg-onyx p-6 [box-shadow:var(--shadow-inset-dark)]">
        <button type="button" onClick={onBack} className="font-mono text-xs text-mist hover:text-vellum">← back</button>
        <div>
          <span className="font-display text-2xl text-vellum">Pantera GP</span>
          <span className="text-ember"> ///</span>
        </div>

        {/* Staff and traders sign in to different places; an account you create is a trader. */}
        {!registering && (
          <div className="flex gap-1 text-sm">
            {(['staff', 'client'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setAs(k)} aria-pressed={as === k}
                className={`flex-1 rounded-md px-2 py-1 font-mono text-xs ${as === k
                  ? 'bg-ember text-graphite'
                  : 'bg-vellum/10 text-mist hover:text-vellum'}`}>
                {k === 'staff' ? 'Staff' : 'Trader'}
              </button>
            ))}
          </div>
        )}

        {registering && (
          <input className={input} placeholder="Full name" required maxLength={200}
            autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <input className={input} type="email" placeholder="Email" required autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className={input} type="password" placeholder="Password" required minLength={8}
          autoComplete={registering ? 'new-password' : 'current-password'}
          value={password} onChange={(e) => setPassword(e.target.value)} />
        {registering && <p className="font-mono text-[11px] text-mist">At least 8 characters.</p>}

        {/* Errors read as needs-attention, which is orange here rather than red. */}
        {error && <p role="alert" className="font-mono text-xs text-ember">{error}</p>}
        <button className={`w-full ${btn}`} disabled={busy}>
          {busy ? (registering ? 'Creating…' : 'Signing in…') : (registering ? 'Create account' : 'Sign in')}
        </button>

        <p className="pt-1 text-center font-mono text-xs text-mist">
          {registering ? 'Already have an account? ' : 'No account yet? '}
          <button type="button" onClick={() => { setError(null); onMode(registering ? 'signin' : 'register'); }}
            className="text-ember hover:underline">
            {registering ? 'Sign in' : 'Create account'}
          </button>
        </p>
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

  const nav: [string, string, boolean][] = [
    ['#/admin', 'Dashboard', !!admin],
    ['#/clients', 'Clients', crm],
    ['#/tasks', 'Tasks', crm],
    ['#/compliance', 'Compliance', !!compliance],
    // Support is the same route to two different things. For staff it is a queue they
    // work, so it sits among the work; for a client it is "get hold of us", which belongs
    // at the bottom with the rest of the account.
    ['#/support', 'Support', crm],
    ['#/reports', 'Reports', crm],
    ['#/charts', 'Charts', true],
    ['#/trade', 'Trade', trading],
    ['#/portfolios', 'Portfolios', trading],
    ['#/profile', 'Profile', trading],
    ['#/settings', 'Settings', true],
    ['#/support', 'Support', trading],
    ['#/documents', 'Documents', trading],
    ['#/wallet', 'Connect wallet', trading],
  ];
  const here = (href: string) => (href === '#/clients' ? hash.startsWith('/clients') : hash === href.slice(1));

  return (
    <div className="flex h-full bg-vellum text-obsidian dark:bg-obsidian dark:text-vellum">
      {/* The dark palette lives in the nav chrome, so tables and forms stay readable
          while the app keeps the same visual DNA as the marketing hero. */}
      {/* The dark palette lives in the nav chrome, so tables and forms stay readable
          while the app keeps the same visual DNA as the marketing hero. The rail reads
          as instrument panel rather than website menu: numbered slots, mono labels, a
          scanline wash, and an accent bar that slides between items. */}
      <aside className="nav-rail relative flex w-56 shrink-0 flex-col overflow-hidden bg-obsidian dark:bg-onyx">
        <div className="relative z-10 px-5 py-5">
          <div className="flex items-baseline gap-1">
            <span className="font-display text-lg text-vellum">Pantera GP</span>
            <span className="text-ember">///</span>
          </div>
          <p className="mt-1 flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-mist uppercase">
            <span className="nav-live inline-block h-1.5 w-1.5 rounded-full bg-ember" aria-hidden />
            {crm ? 'Client desk' : 'Terminal'}
          </p>
          <ThemeToggle dark={dark} setDark={setDark} />
        </div>

        <nav className="relative z-10 flex flex-col py-2 text-sm">
          {nav.filter(([, , show]) => show).map(([href, label], i) => (
            <a key={href} href={href} className={`nav-item ${here(href) ? navOn : navOff}`}>
              {/* A slot number, as on a console. Ordinal, not a keyboard shortcut. */}
              <span className="nav-num">{String(i + 1).padStart(2, '0')}</span>
              <span className="nav-label">{label}</span>
              <span className="nav-tick" aria-hidden />
            </a>
          ))}
        </nav>

        <div className="relative z-10 mt-auto flex items-center gap-3 border-t border-white/10 px-5 py-4 text-mist">
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase">{me?.role}</span>
          <NotificationBell />
          <button onClick={onLogout}
            className="ml-auto font-mono text-[10px] tracking-[0.16em] uppercase transition-colors hover:text-ember">
            Sign out
          </button>
        </div>
      </aside>
      <main className={`min-h-0 flex-1 ${charts ? 'p-4' : 'overflow-auto p-6'}`}>
        {/* Not on charts, which run full-bleed, and not on the profile, which shows the
            same figures in full — two totals fetched a second apart tick apart, and one
            screen disagreeing with itself is worse than one that says it once. */}
        {trading && !charts && hash !== '/profile' && (
          <div className="mx-auto max-w-6xl"><BalanceBar /></div>
        )}
        {charts ? <ChartsView dark={dark} />
          : hash === '/admin' ? (admin ? <AdminView /> : <Denied />)
          : hash === '/compliance' ? (compliance ? <ComplianceView role={me?.role} /> : <Denied />)
          : hash === '/reports' ? (crm ? <ReportsView /> : <Denied />)
          : hash === '/support' ? (crm ? <SupportQueue role={me?.role} /> : <div className="mx-auto max-w-3xl"><SupportPanel /></div>)
          : hash === '/portfolios' ? (trading ? <div className="mx-auto max-w-3xl"><PortfoliosPanel /></div> : <Denied />)
          : hash === '/profile' ? (trading ? <ProfileView /> : <Denied />)
          : hash === '/wallet' ? (trading ? <WalletView /> : <Denied />)
          : hash === '/documents' ? (trading && me
            ? <div className="mx-auto max-w-3xl space-y-4">
                <PageTitle>Documents</PageTitle>
                <DocumentsPanel clientId={me.sub} canUpload />
              </div>
            : <Denied />)
          : hash === '/trade' ? (trading ? <TradeView /> : <p className="text-sm text-slate-ink">Trading is for account holders.</p>)
          // Settings is for everyone, so it has to be matched before the trader fallback.
          : hash === '/settings' ? <SettingsView me={me} dark={dark} setDark={setDark} />
          : !crm ? <TradeView />
          : clientId ? <ClientWorkspace id={clientId} me={me} />
          : hash === '/tasks' ? <TaskBoard />
          : <ClientList />}
      </main>
    </div>
  );
}

const Denied = () => <p className="text-sm text-slate-ink">You do not have access to this page.</p>;

/**
 * Light / terminal switch, at the top of the nav where it is findable. Both surfaces are
 * the same design system — the tokens swap roles, nothing else changes.
 */
function ThemeToggle({ dark, setDark }: { dark: boolean; setDark: (v: boolean) => void }) {
  return (
    <div role="group" aria-label="Colour theme" className="mt-4 flex gap-1 rounded-full bg-white/10 p-0.5">
      {([['Light', false], ['Dark', true]] as const).map(([label, on]) => (
        <button key={label} type="button" onClick={() => setDark(on)} aria-pressed={dark === on}
          className={`flex-1 rounded-full px-2 py-1 font-mono text-[11px] transition-colors ${dark === on
            ? 'bg-ember text-graphite'
            : 'text-mist hover:text-vellum'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Pantera GP primitives ────────────────────────────────────────────────────────
// Defined once and consumed by every screen, so the system holds instead of drifting.
// Rules enforced here: 8px radius on controls, 12px on surfaces, never 0px; no drop
// shadows anywhere; ember orange only for primary actions, focus and needs-action.

// Active nav carries a thin orange left border rather than a filled orange block.
// The rail's treatment — slot numbers, sliding accent, tick, scanlines — lives in
// index.css under .nav-*, because it is presentation with no logic in it.
const navOn = 'is-active';
const navOff = '';

// `field` carries no width so a caller can size it; `input` is the full-width default.
// (A `w-32` next to `w-full` does not win — same specificity, and w-full is defined later.)
export const field = 'rounded-md border border-pebble bg-vellum px-3 py-2 text-sm text-obsidian outline-none placeholder:text-mist focus:border-ember focus:ring-1 focus:ring-ember dark:border-white/15 dark:bg-onyx dark:text-vellum';
export const input = `w-full ${field}`;

// Primary action: filled ember with black text, mono label — the spec's "act on this".
export const btn = 'rounded-md bg-ember px-4 py-2 font-mono text-sm font-medium text-graphite hover:brightness-95 disabled:opacity-50';
// Secondary: bone fill, no colour. Same shape rules.
export const btnGhost = 'rounded-md border border-pebble bg-bone px-4 py-2 font-mono text-sm font-medium text-obsidian hover:bg-pebble disabled:opacity-50 dark:border-white/15 dark:bg-vellum/5 dark:text-vellum dark:hover:bg-vellum/10';

// Panels of grouped metadata: bone on the white canvas, so the tonal step does the work
// a shadow would have done.
export const card = 'rounded-lg bg-bone p-4 dark:bg-onyx dark:[box-shadow:var(--shadow-inset-dark)]';
// Tables get their own container: vellum inside a pebble hairline, header row on bone.
export const tableCard = 'overflow-hidden rounded-lg border border-pebble bg-vellum dark:border-white/10 dark:bg-onyx';
export const thead = 'bg-bone text-left text-xs font-medium tracking-wide text-slate-ink dark:bg-vellum/5 dark:text-mist';

// Ember is a fill and a mark, never small text on a light surface: measured, it is 2.64:1
// on vellum and 2.22:1 on bone, so it fails even the 3:1 floor for large text and no
// amount of weight or size rescues it. Attention is carried by an ember edge with the
// words in obsidian (14.9:1), or by pillAction below, whose black-on-ember is 7.95:1.
export const alertBox = 'rounded-md border-l-2 border-ember bg-bone px-3 py-2 text-sm text-obsidian dark:bg-white/5 dark:text-vellum';

// Status chips: neutral by default. Orange is reserved for states needing action now, so
// it keeps meaning the same thing everywhere.
export const pill = 'inline-block rounded-full bg-pebble px-2 py-0.5 text-xs text-obsidian dark:bg-vellum/10 dark:text-vellum';
export const pillAction = 'inline-block rounded-full bg-ember px-2 py-0.5 text-xs font-medium text-graphite';
// IDs, timestamps, money and anything else that reads as a system readout.
export const mono = 'font-mono tabular-nums';

/**
 * Group instruments by asset class for a picker, in a fixed order rather than whatever
 * order the rows arrive in. Anything without a class — a row seeded before the column
 * existed, or one added by hand — falls into "Other" rather than disappearing.
 */
const CLASS_LABEL: Record<string, string> = {
  fx: 'Forex', metals: 'Metals', crypto: 'Crypto', etf: 'ETFs',
};
const CLASS_ORDER = ['crypto', 'fx', 'metals', 'etf', 'other'];

export function grouped<T extends { symbol: string; asset_class?: string | null }>(items: T[]): [string, T[]][] {
  const bins = new Map<string, T[]>();
  for (const item of items) {
    const key = item.asset_class && CLASS_LABEL[item.asset_class] ? item.asset_class : 'other';
    (bins.get(key) ?? bins.set(key, []).get(key)!).push(item);
  }
  return CLASS_ORDER
    .filter((k) => bins.get(k)?.length)
    .map((k) => [CLASS_LABEL[k] ?? 'Other', bins.get(k)!] as [string, T[]]);
}

/** Page title: the serif, at the one size outside marketing where it belongs. */
export const PageTitle = ({ children }: { children: React.ReactNode }) => (
  <h1 className="font-display text-[28px] leading-tight tracking-tight">{children}</h1>
);
