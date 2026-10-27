import { useState, type FormEvent } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, BadgeCheck, Bell, BellOff, BriefcaseBusiness, Check, CircleDollarSign, Coins,
  Eye, EyeOff, Flag, Headset, KeyRound, Lock, MessageSquare, Moon, Percent, ShieldCheck, Sun, UserPlus, UserRound,
  type LucideIcon,
} from 'lucide-react';
import { StatTile } from './x-shell.tsx';
import { alertBox, btn, btnGhost, input, mono, PageTitle, tableCard, thead } from './App.tsx';
import { api, useApi } from './api.ts';
import { CopyButton } from './copy.tsx';
import { SiteContent } from './site-content.tsx';

type Me = { sub: string; kind: 'staff' | 'client'; role: string };
type Staff = { id: string; name: string; email: string; role: string; active: boolean };
type Pref = { kind: string; label: string; note: string; enabled: boolean; locked: boolean };

/**
 * Everything about your own account in one place, plus the account controls an admin
 * needs.
 *
 * Ordered by how often it is wanted rather than by how the code is arranged: what reaches
 * you, then how the place looks, then the account itself, then — for an admin — everybody
 * else's. Changing your own password always costs you the current one; setting somebody
 * else's is a separate, admin-only power (see password:reset in src/auth.ts).
 */
export function SettingsView({ me, dark, setDark }: {
  me: Me | null; dark: boolean; setDark: (v: boolean) => void;
}) {
  const admin = me?.role === 'admin';
  const staff = me?.kind === 'staff';
  // Fetched here rather than in the panel so the header tile and the panel read one answer.
  const prefs = useApi<Pref[]>('/me/notification-prefs');
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const value = (p: Pref) => local[p.kind] ?? p.enabled;
  const list = prefs.data ?? [];
  const on = list.filter(value).length;

  return (
    <div className="stagger mx-auto max-w-[1300px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Settings</PageTitle>
        <span className="x-badge"><ShieldCheck size={13} className="mr-1.5" aria-hidden />Signed in securely</span>
        {!staff && (
          <a href="#/profile" className="x-btn-sm ml-auto inline-flex items-center gap-2">
            <UserRound size={15} aria-hidden />Your profile
          </a>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Notifications" Icon={on ? Bell : BellOff}
          value={prefs.data ? `${on} of ${list.length} on` : <span className="skeleton inline-block h-5 w-24" />}
          note={on === list.length ? 'Everything reaches your bell' : 'Switched-off ones are never sent'}>
          {prefs.data && <div className="x-meter mt-3"><span style={{ width: `${list.length ? (on / list.length) * 100 : 0}%` }} /></div>}
        </StatTile>
        <StatTile label="Theme" Icon={dark ? Moon : Sun} note="Kept on this device">
          <div role="group" aria-label="Colour theme" className="st-theme mt-3">
            {([['Light', false, Sun], ['Dark', true, Moon]] as const).map(([label, isDark, Icon]) => (
              <button key={label} type="button" onClick={() => setDark(isDark)} aria-pressed={dark === isDark}
                className={`st-theme-opt ${isDark ? 'is-dark' : 'is-light'} ${dark === isDark ? 'is-on' : ''}`}>
                <span className="st-theme-swatch" aria-hidden><i /><i /></span>
                <Icon size={13} aria-hidden />{label}
              </button>
            ))}
          </div>
        </StatTile>
        <StatTile label="Password" Icon={KeyRound} value="Protected" tone="text-up"
          note={<a href="#change-password" onClick={(e) => { e.preventDefault(); focusPassword(); }} className="text-ember-ink hover:underline">Change it below</a>} />
        <StatTile label="Signed in as" Icon={staff ? BadgeCheck : UserRound}
          value={<span className="capitalize">{staff ? me?.role ?? 'Staff' : 'Account holder'}</span>}
          note="Every session runs over TLS and is recorded" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Notifications prefs={prefs.data ?? undefined} value={value} setLocal={setLocal} />
        <div className="space-y-4">
          <ChangePassword />
          <Section title="Session" Icon={Lock}
            note="What this browser is signed in as. Useful when something is refused and it is not obvious why.">
            <dl className="st-rows">
              <div>
                <dt>Account id</dt>
                <dd className="flex min-w-0 items-center justify-end gap-2">
                  <span className={`truncate text-xs ${mono}`}>{me?.sub ?? '—'}</span>
                  {me?.sub && <CopyButton text={me.sub} />}
                </dd>
              </div>
              <div><dt>Account type</dt><dd>{staff ? 'Staff' : 'Client'}</dd></div>
              <div><dt>Role</dt><dd className="capitalize">{me?.role ?? '—'}</dd></div>
              <div><dt>Connection</dt><dd className="flex items-center justify-end gap-1.5 text-up"><Lock size={13} aria-hidden />Encrypted</dd></div>
            </dl>
          </Section>
        </div>
      </div>

      {admin && <StaffAccounts meId={me?.sub} />}
      {admin && <SiteContent />}
    </div>
  );
}

function focusPassword() {
  const el = document.querySelector<HTMLInputElement>('#change-password input');
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.focus({ preventScroll: true });
}

// --------------------------------------------------------------- notifications

/** An icon per kind, so a long list of switches can be scanned rather than read. */
const KIND_ICON: Record<string, LucideIcon> = {
  'order.filled': Check, credit: CircleDollarSign, deposit: ArrowDownToLine, withdrawal: ArrowUpFromLine,
  interest: Percent, stake: Coins, 'portfolio.request': BriefcaseBusiness, kyc: BadgeCheck, ticket: Headset,
  message: MessageSquare, security: ShieldCheck, 'flag.raised': Flag, 'kyc.uploaded': BadgeCheck,
  'ticket.activity': Headset, 'withdrawal.request': ArrowUpFromLine, 'task.assigned': Check, 'client.registered': UserPlus,
};

/**
 * Which notifications you want. The same panel on both sides — the API answers with the
 * kinds that apply to whoever is asking, so this component never has to know whether it is
 * showing a trader's fills or a compliance officer's flags.
 *
 * Saved on the toggle rather than behind a Save button: there is nothing to get half-right,
 * and a preferences page you can leave without saving is a preferences page that lies. The
 * switch moves at once and rolls back if the write fails. "All on" and "All off" send every
 * movable kind in one write, and leave the locked ones alone.
 */
function Notifications({ prefs, value, setLocal }: {
  prefs: Pref[] | undefined; value: (p: Pref) => boolean;
  setLocal: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const list = prefs ?? [];
  const off = list.filter((p) => !value(p)).length;

  async function save(change: Record<string, boolean>) {
    const before = Object.fromEntries(Object.keys(change).map((k) => [k, value(list.find((p) => p.kind === k)!)]));
    setLocal((v) => ({ ...v, ...change }));
    setError(null);
    try {
      await api('/me/notification-prefs', { method: 'PUT', body: JSON.stringify(change) });
    } catch (err) {
      setLocal((v) => ({ ...v, ...before }));
      setError((err as Error).message);
    }
  }
  const all = (to: boolean) => save(Object.fromEntries(list.filter((p) => !p.locked && value(p) !== to).map((p) => [p.kind, to])));

  return (
    <Section title="Notifications" Icon={Bell}
      note="What reaches your bell. Switching one off stops it being written at all, so it will not turn up later — it simply never happens."
      aside={prefs && (
        <div className="flex items-center gap-2">
          {off > 0 && <span className="x-badge is-locked">{off} off</span>}
          <div className="x-tabs" role="group" aria-label="Switch all notifications">
            <button type="button" onClick={() => all(true)} disabled={off === 0}>All on</button>
            <button type="button" onClick={() => all(false)} disabled={list.every((p) => p.locked || !value(p))}>All off</button>
          </div>
        </div>
      )}>
      {!prefs ? <div className="skeleton h-40 rounded-lg" /> : (
        <div className="grid gap-2.5 md:grid-cols-2">
          {prefs.map((p) => {
            const Icon = KIND_ICON[p.kind] ?? Bell;
            const isOn = value(p);
            return (
              <label key={p.kind} className={`x-switch-tile st-pref ${isOn ? 'is-on' : ''} ${p.locked ? 'is-locked' : 'cursor-pointer'}`}>
                <span className="st-pref-icon" aria-hidden><Icon size={15} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    {p.label}{p.locked && <Lock size={12} className="text-mist" aria-label="Always on" />}
                  </span>
                  <span className="block text-xs text-slate-ink">{p.note}</span>
                </span>
                <Switch on={isOn} locked={p.locked} label={p.label} onChange={() => save({ [p.kind]: !isOn })} />
              </label>
            );
          })}
        </div>
      )}
      {error && <p role="alert" className={alertBox}>{error}</p>}
    </Section>
  );
}

/**
 * A locked switch is drawn on and disabled rather than hidden: somebody looking for the
 * setting should find it and see why it is not theirs to move, not wonder whether the
 * notification exists at all.
 */
function Switch({ on, locked, label, onChange }: {
  on: boolean; locked: boolean; label: string; onChange: () => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label}
      disabled={locked} onClick={onChange} title={locked ? 'Security notices cannot be switched off' : undefined}
      className={`st-switch ${on ? 'is-on' : ''}`}>
      <span />
    </button>
  );
}

// ------------------------------------------------------------------ own password

/** A rough strength reading: length and variety. It guides; the server's rule is the minimum. */
function strength(pw: string) {
  if (!pw) return { score: 0, label: '' };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const score = pw.length < 8 ? 1 : Math.min(4, (pw.length >= 12 ? 2 : 1) + (kinds >= 3 ? 2 : kinds >= 2 ? 1 : 0));
  return { score, label: ['', 'Too short', 'Fair', 'Good', 'Strong'][score]! };
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const s = strength(next);
  const mismatch = !!confirm && confirm !== next;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    // Caught here as well as by the server, so a typo costs a keystroke, not a round trip.
    if (next !== confirm) return setError('The two new passwords do not match.');
    setBusy(true);
    try {
      await api('/me/password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      setCurrent(''); setNext(''); setConfirm('');
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';
  return (
    <Section title="Password" Icon={KeyRound} note="At least 8 characters. Your current password is required."
      aside={
        <button type="button" onClick={() => setShow((v) => !v)} className="x-btn-sm inline-flex items-center gap-1.5"
          aria-pressed={show}>
          {show ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}{show ? 'Hide' : 'Show'}
        </button>
      }>
      <form id="change-password" onSubmit={submit} className="space-y-3">
        <PwField label="Current password">
          <input className={`${input} st-input`} type={type} required autoComplete="current-password"
            value={current} onChange={(e) => setCurrent(e.target.value)} />
        </PwField>
        <PwField label="New password" aside={s.label && <span className={`st-strength-label is-${s.score}`}>{s.label}</span>}>
          <input className={`${input} st-input`} type={type} required minLength={8} autoComplete="new-password"
            value={next} onChange={(e) => setNext(e.target.value)} />
        </PwField>
        <div className="st-strength" aria-hidden>
          {[1, 2, 3, 4].map((i) => <span key={i} className={i <= s.score ? `is-${s.score}` : ''} />)}
        </div>
        <PwField label="Repeat new password"
          aside={confirm && (mismatch
            ? <span className="text-[11px] text-down">Does not match</span>
            : <span className="flex items-center gap-1 text-[11px] text-up"><Check size={12} aria-hidden />Matches</span>)}>
          <input className={`${input} st-input ${mismatch ? '!border-down' : ''}`} type={type} required minLength={8}
            autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </PwField>
        {error && <p role="alert" className={alertBox}>{error}</p>}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button className={btn} disabled={busy || mismatch}>{busy ? 'Changing…' : 'Change password'}</button>
          {done && <span role="status" className="flex items-center gap-1.5 text-xs text-up"><Check size={14} aria-hidden />Password changed</span>}
        </div>
      </form>
    </Section>
  );
}

const PwField = ({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) => (
  <label className="block">
    <span className="flex items-baseline justify-between gap-2 text-[12.5px] text-mist">{label}{aside}</span>
    <span className="st-field mt-1.5 block">
      <Lock size={14} className="st-field-icon" aria-hidden />
      {children}
    </span>
  </label>
);

// ------------------------------------------------------------------ staff admin

function StaffAccounts({ meId }: { meId?: string }) {
  const staff = useApi<Staff[]>('/staff?include_inactive=true');
  const [resetting, setResetting] = useState<string | null>(null);
  const [showOff, setShowOff] = useState(false);
  const [q, setQ] = useState('');

  const all = staff.data ?? [];
  const active = all.filter((x) => x.active).length;
  const term = q.trim().toLowerCase();
  // Switched-off accounts are hidden by default and the list is searchable: a desk with
  // three hundred colleagues, most of them former ones, is a list nobody scrolls.
  const rows = all
    .filter((x) => (showOff || x.active))
    .filter((x) => !term || x.name.toLowerCase().includes(term) || x.email.toLowerCase().includes(term));

  return (
    <Section title="Staff accounts" Icon={UserRound} aside={<span className="x-badge">{active} active</span>}
      note="Setting someone's password hands over their account, so it is admin-only and audited. You cannot reset your own here — use Password above, with your current one.">
      <div className="flex flex-wrap items-center gap-3">
        <input className={`${input} max-w-xs flex-1`} placeholder="Search name or email"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-xs text-slate-ink">
          <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />
          Include switched off
        </label>
        <span className="ml-auto font-mono text-xs text-slate-ink">
          {rows.length} of {all.length}
        </span>
      </div>

      <div className={`${tableCard} max-h-96 overflow-auto`}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>{['Name', 'Email', 'Role', 'Status', ''].map((h) =>
              <th key={h} className="px-4 py-2">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}
                className={`border-t border-pebble dark:border-white/10 ${s.active ? '' : 'opacity-60'}`}>
                <td className="px-4 py-2 font-medium">
                  {s.name}
                  {s.id === meId && <span className="ml-2 text-xs text-slate-ink">you</span>}
                </td>
                <td className={`px-4 py-2 text-xs text-slate-ink ${mono}`}>{s.email}</td>
                <td className="px-4 py-2 text-xs capitalize">{s.role}</td>
                <td className="px-4 py-2">
                  <span className={`x-badge ${s.active ? '' : 'is-muted'}`}>{s.active ? 'Active' : 'Off'}</span>
                </td>
                <td className="px-4 py-2 text-right">
                  {s.id !== meId && (
                    <button
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${resetting === s.id
                        ? 'border-ember text-ember-ink'
                        : 'border-pebble text-slate-ink hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum'}`}
                      onClick={() => setResetting(resetting === s.id ? null : s.id)}>
                      {resetting === s.id ? 'Close' : 'Reset password'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-4 py-6 text-sm text-slate-ink">
            {all.length === 0 ? 'No staff accounts yet.' : 'Nobody matches that.'}
          </p>
        )}
      </div>
      {resetting && (
        <ResetPassword path={`/staff/${resetting}/password`} who={staff.data?.find((s) => s.id === resetting)?.name ?? ''}
          onDone={() => setResetting(null)} />
      )}
    </Section>
  );
}

/**
 * Setting somebody else's password. Shared by the staff list here and the client
 * workspace, so the wording and the rules stay identical in both places.
 */
export function ResetPassword({ path, who, onDone }: { path: string; who: string; onDone: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api(path, { method: 'POST', body: JSON.stringify({ new_password: value }) });
      setValue('');
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded-lg border border-pebble p-3 dark:border-white/10">
      <p className="text-xs text-slate-ink">
        New password for <span className="font-medium text-obsidian dark:text-vellum">{who}</span>.
        Tell them out of band, and have them change it.
      </p>
      <div className="flex flex-wrap gap-2">
        <input className={`${input} max-w-xs`} type="text" placeholder="New password" required minLength={8}
          autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className={btn} disabled={busy}>{busy ? 'Setting…' : 'Set password'}</button>
        <button type="button" className={btnGhost} onClick={onDone}>Close</button>
      </div>
      {error && <p role="alert" className={`${alertBox} font-mono text-xs`}>{error}</p>}
      {done && <p role="status" className="font-mono text-xs text-slate-ink">Password set. They were notified.</p>}
    </form>
  );
}

// ------------------------------------------------------------------ bits

const Section = ({ title, note, Icon, aside, children }: {
  title: string; note?: string; Icon?: LucideIcon; aside?: React.ReactNode; children: React.ReactNode;
}) => (
  <section className="x-card x-holo space-y-4 p-5">
    <div className="flex flex-wrap items-start gap-3">
      {Icon && <span className="x-chip" aria-hidden><Icon size={17} strokeWidth={1.9} /></span>}
      <div className="min-w-0 flex-1">
        <h2 className="section-title">{title}</h2>
        {note && <p className="mt-1.5 max-w-2xl text-xs text-slate-ink">{note}</p>}
      </div>
      {aside && <div className="ml-auto">{aside}</div>}
    </div>
    {children}
  </section>
);
