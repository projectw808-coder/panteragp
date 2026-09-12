import { useEffect, useState, type FormEvent } from 'react';
import { api, token, useApi } from './api.ts';
import { AdminView } from './admin.tsx';
import { ChartsView } from './chart.tsx';
import { NotificationBell } from './notifications.tsx';
import { SupportPanel, SupportQueue } from './tickets.tsx';
import { PortfoliosPanel } from './portfolio.tsx';
import { StakingPanel } from './staking.tsx';
import { StakingAdmin } from './staking-admin.tsx';
import { PortfolioRequests } from './portfolio-requests.tsx';
import { BalanceBar } from './balance.tsx';
import { ProfileView } from './profile.tsx';
import { WalletView } from './wallet-connect.tsx';
import { TaskBoard } from './board.tsx';
import { ComplianceView, DocumentsPanel, ReportsView } from './compliance.tsx';
import { AutoTraderRunner, AutoTraderView } from './auto-trader.tsx';
import { OverviewView } from './overview.tsx';
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
        location.hash = '/overview';
      } else {
        const r = await api<{ token: string }>('/auth/login', {
          method: 'POST', body: JSON.stringify({ email, password, as }),
        });
        token.set(r.token);
        location.hash = as === 'client' ? '/overview' : '/clients';
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
    // auth-screen pins every theme-swapping ink to its dark value, because this ground
    // stays dark whichever way the theme is set.
    //
    // Two columns, not a card floating in the middle of a black page. A centred box is
    // what a form looks like when nobody decided what the screen was for; the platforms
    // this is measured against give the left half to who they are and the right half to
    // the one thing being asked. It also means the brand is doing the reassuring, so the
    // form can stay short.
    <div className="auth-screen grid h-full grid-cols-1 bg-obsidian lg:grid-cols-[1.05fr_1fr]">

      {/* ---------------------------------------------------------- the brand half */}
      <aside className="relative hidden overflow-hidden border-r border-white/10 bg-onyx p-12 lg:flex lg:flex-col lg:justify-between">
        {/* The same bar motif as the public hero, at a fraction of the contrast: this is a
            room the form sits in, not something to read. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2">
          <div className="absolute inset-0 bg-[radial-gradient(70%_120%_at_50%_100%,rgba(255,120,23,0.16),transparent_72%)]" />
          <div className="absolute inset-x-0 bottom-0 flex h-full items-end gap-1.5 px-8">
            {[24, 48, 34, 66, 44, 82, 56, 90, 60, 76, 40, 58].map((h, i) => (
              <div key={i} className="anim-grow flex-1 bg-[linear-gradient(to_top,rgba(255,120,23,0.28),transparent)]"
                style={{ height: `${h}%`, animationDelay: `${240 + i * 55}ms` }} />
            ))}
          </div>
        </div>

        <div className="relative">
          <button type="button" onClick={onBack}
            className="focus-ring rounded-full font-mono text-xs text-mist transition-colors hover:text-vellum">
            ← back
          </button>
          <p className="mt-10">
            <span className="font-display text-[30px] text-vellum">Pantera GP</span>
            <span className="font-mono text-sm text-ember-ink"> ///</span>
          </p>
          <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-mist">
            Rest an order at a price and close the tab. The engine prices every instrument
            continuously and fires your limits, stops and trailing exits the moment they
            trigger — server-side, with the record attached.
          </p>
        </div>

        {/* Three facts, not three adjectives. Each one is something the platform does. */}
        <dl className="relative grid gap-5">
          {[
            ['Server-side execution', 'Your levels are held and fired by the engine, not by an open tab.'],
            ['A record of everything', 'Every order, decision and document is written down and attributable.'],
            ['Segregated client records', 'Positions, portfolios and cash are held against your account alone.'],
          ].map(([term, detail]) => (
            <div key={term} className="flex gap-3">
              <span aria-hidden className="mt-1.5 h-px w-6 shrink-0 bg-ember" />
              <div>
                <dt className="text-sm font-medium text-vellum">{term}</dt>
                <dd className="mt-0.5 text-[13px] leading-relaxed text-mist">{detail}</dd>
              </div>
            </div>
          ))}
        </dl>
      </aside>

      {/* ----------------------------------------------------------- the form half */}
      <main className="grid place-items-center overflow-y-auto px-6 py-10">
        <form onSubmit={submit} className="stagger w-full max-w-[22rem] space-y-5">

          {/* The brand column is hidden below lg, so the small screen gets its own header
              rather than a form that begins with no explanation of where it is. */}
          <div className="lg:hidden">
            <button type="button" onClick={onBack}
              className="focus-ring rounded-full font-mono text-xs text-mist transition-colors hover:text-vellum">
              ← back
            </button>
            <p className="mt-6">
              <span className="font-display text-[26px] text-vellum">Pantera GP</span>
              <span className="font-mono text-sm text-ember-ink"> ///</span>
            </p>
          </div>

          <div>
            <h1 className="text-xl font-medium text-vellum">
              {registering ? 'Open an account' : 'Sign in to the desk'}
            </h1>
            <p className="mt-1.5 text-sm text-mist">
              {registering
                ? 'A trading account, opened in a minute. Verification comes after.'
                : 'Your positions, portfolios and record, exactly as you left them.'}
            </p>
          </div>

          {/* Staff and traders sign in to different places; an account you create is a trader.

              Set like the field labels it sits between, not like a button: this chooses which
              kind of account is signing in, so it labels the form rather than acting on it —
              and EMAIL and PASSWORD are two lines below in exactly this voice. */}
          {!registering && (
            <div className="flex gap-1 rounded-full bg-vellum/5 p-1">
              {(['staff', 'client'] as const).map((k) => (
                <button key={k} type="button" onClick={() => setAs(k)} aria-pressed={as === k}
                  className={`focus-ring flex-1 rounded-full px-3 py-1.5 font-mono text-[11px] tracking-[0.16em] uppercase transition-colors ${as === k
                    ? 'bg-ember font-medium text-graphite'
                    : 'text-mist hover:text-vellum'}`}>
                  {k === 'staff' ? 'Staff' : 'Trader'}
                </button>
              ))}
            </div>
          )}

          {/* Labels, not placeholders. A placeholder is gone the moment there is a value in
              the field, which leaves somebody checking a half-typed form with no idea which
              box is which — and leaves a screen reader with nothing at all. */}
          {registering && (
            <label className="block">
              <span className="metric-label mb-1.5 block">Full name</span>
              <input className={input} required maxLength={200} autoComplete="name"
                value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label className="block">
            <span className="metric-label mb-1.5 block">Email</span>
            <input className={input} type="email" required autoComplete="username"
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block">
            <span className="metric-label mb-1.5 block">Password</span>
            <input className={input} type="password" required
              // Only on the way in. On sign-in a length rule cannot help — the password is
              // whatever it already is — and can only block somebody with an older, shorter one.
              minLength={registering ? 8 : undefined}
              autoComplete={registering ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => setPassword(e.target.value)} />
            {registering && (
              <span className="mt-1.5 block font-mono text-[11px] text-mist">At least 8 characters.</span>
            )}
          </label>

          {/* Errors read as needs-attention, which is orange here rather than red. */}
          {error && <p role="alert" className="font-mono text-xs text-ember-ink">{error}</p>}

          <button className={`w-full ${btn}`} disabled={busy}>
            {busy ? (registering ? 'Creating…' : 'Signing in…') : (registering ? 'Create account' : 'Sign in')}
          </button>

          <p className="font-mono text-xs text-mist">
            {registering ? 'Already have an account? ' : 'No account yet? '}
            <button type="button" onClick={() => { setError(null); onMode(registering ? 'signin' : 'register'); }}
              className="focus-ring rounded-full text-ember-ink hover:underline">
              {registering ? 'Sign in' : 'Create account'}
            </button>
          </p>

          {/* What a person is actually weighing on this screen is whether to trust it. Said
              plainly and once, at the size of a footnote — a badge would be decoration. */}
          <p className="flex items-center gap-2 border-t border-white/10 pt-5 font-mono text-[11px] text-mist">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden
              className="shrink-0">
              <rect x="4" y="9" width="12" height="8" rx="1.5" />
              <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
            </svg>
            Encrypted in transit. Every action on your account is recorded.
          </p>
        </form>
      </main>
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
    ['#/staking', 'Staking', crm],
    ['#/requests', 'Requests', crm],
    // Support is the same route to two different things. For staff it is a queue they
    // work, so it sits among the work; for a client it is "get hold of us", which belongs
    // at the bottom with the rest of the account.
    ['#/support', 'Support', crm],
    ['#/reports', 'Reports', crm],
    ['#/overview', 'Overview', trading],
    ['#/charts', 'Charts', true],
    ['#/trade', 'Auto trader', trading],
    ['#/portfolios', 'Portfolios', trading],
    ['#/staking', 'Staking', trading],
    ['#/wallet', 'Connect wallet', trading],
    // Documents, support, settings: the account tail, after the things a client came here
    // to do. Staff keep their own Settings at the very end of their own rail.
    ['#/documents', 'Documents', trading],
    ['#/support', 'Support', trading],
    ['#/settings', 'Settings', trading],
    ['#/profile', 'Profile', trading],
    ['#/settings', 'Settings', crm],
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
            <span className="text-ember-ink">///</span>
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
              {/* A slot number, as on a console. Ordinal, not a keyboard shortcut — except
                  for the account, which is a person rather than a destination. */}
              <span className="nav-num">
                {href === '#/profile' ? <Person /> : String(i + 1).padStart(2, '0')}
              </span>
              <span className={`nav-label ${href === '#/profile' ? 'font-medium' : ''}`}>{label}</span>
              <span className="nav-tick" aria-hidden />
            </a>
          ))}
        </nav>

        <div className="relative z-10 mt-auto border-t border-white/10 px-5 py-4 text-mist">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] tracking-[0.16em] uppercase">{me?.role}</span>
            <NotificationBell />
            <button onClick={onLogout}
              className="ml-auto font-mono text-[10px] tracking-[0.16em] uppercase transition-colors hover:text-ember-ink">
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className={`flex min-h-0 flex-1 flex-col ${charts ? 'p-4' : 'overflow-auto p-6'}`}>
        {/* On every client screen, charts included. It used to be hidden there because the
            charts run full-bleed, which stopped mattering the moment charts became where a
            trader lands. */}
        {trading && <AutoTraderRunner />}
        {trading && <div className={charts ? 'shrink-0' : 'mx-auto max-w-6xl'}><BalanceBar /></div>}
        {charts ? <ChartsView dark={dark} />
          : hash === '/admin' ? (admin ? <AdminView /> : <Denied />)
          : hash === '/compliance' ? (compliance ? <ComplianceView role={me?.role} /> : <Denied />)
          : hash === '/reports' ? (crm ? <ReportsView /> : <Denied />)
          : hash === '/support' ? (crm ? <SupportQueue role={me?.role} /> : <div className="mx-auto max-w-3xl"><SupportPanel /></div>)
          : hash === '/portfolios' ? (trading
            ? <div className="mx-auto max-w-3xl space-y-4"><PageTitle>Portfolios</PageTitle><PortfoliosPanel /></div>
            : <Denied />)
          : hash === '/requests' ? (crm ? <PortfolioRequests /> : <Denied />)
          : hash === '/staking' ? (crm ? <StakingAdmin />
            : trading
              ? <div className="mx-auto max-w-3xl space-y-4"><PageTitle>Staking</PageTitle><StakingPanel /></div>
              : <Denied />)
          : hash === '/profile' ? (trading ? <ProfileView /> : <Denied />)
          : hash === '/wallet' ? (trading ? <WalletView /> : <Denied />)
          : hash === '/documents' ? (trading && me
            ? <div className="stagger mx-auto max-w-3xl space-y-4">
                <PageTitle>Documents</PageTitle>
                <DocumentsPanel clientId={me.sub} canUpload />
              </div>
            : <Denied />)
          : hash === '/overview' ? (trading ? <OverviewView /> : <Denied />)
          : hash === '/trade' ? (trading ? <AutoTraderView /> : <Denied />)
          // Settings is for everyone, so it has to be matched before the trader fallback.
          : hash === '/settings' ? <SettingsView me={me} dark={dark} setDark={setDark} />
          : !crm ? <OverviewView />
          : clientId ? <ClientWorkspace id={clientId} me={me} />
          : hash === '/tasks' ? <TaskBoard />
          : <ClientList />}
      </main>
    </div>
  );
}

const Denied = () => <p className="text-sm text-slate-ink">You do not have access to this page.</p>;

/** Head and shoulders, drawn rather than an emoji so it takes the rail's colour. */
const Person = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
  </svg>
);

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
// sheen: one specular pass across the fill on hover. It is on the primary action only —
// the whole effect of a gesture like this comes from it being rare.
export const btn = 'sheen focus-ring rounded-full bg-ember px-4 py-2 font-mono text-sm font-medium text-graphite hover:brightness-95 disabled:opacity-50';
// Secondary: bone fill, no colour. Same shape rules.
export const btnGhost = 'rounded-full border border-pebble bg-bone px-4 py-2 font-mono text-sm font-medium text-obsidian hover:bg-pebble disabled:opacity-50 dark:border-white/15 dark:bg-vellum/5 dark:text-vellum dark:hover:bg-vellum/10';

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
