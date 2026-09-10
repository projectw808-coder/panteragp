import { useState, type FormEvent } from 'react';
import { alertBox, btn, btnGhost, card, input, mono, PageTitle, tableCard, thead } from './App.tsx';
import { api, useApi } from './api.ts';

type Me = { sub: string; kind: 'staff' | 'client'; role: string };
type Staff = { id: string; name: string; email: string; role: string; active: boolean };

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

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle>Settings</PageTitle>

      <div className={`${card} flex flex-wrap items-center gap-x-10 gap-y-3`}>
        <div>
          <p className="metric-label">Signed in as</p>
          <p className="text-sm font-medium">{staff ? 'Staff' : 'Account holder'}</p>
        </div>
        <div>
          <p className="metric-label">Role</p>
          <p className="text-sm font-medium capitalize">{me?.role ?? '—'}</p>
        </div>
        <div>
          <p className="metric-label">Theme</p>
          {/* The one control that belongs in a header: it changes the thing you are
              looking at while you look at it. */}
          <div role="group" aria-label="Colour theme"
            className="mt-0.5 flex gap-1 rounded-full bg-bone p-0.5 dark:bg-white/10">
            {([['Light', false], ['Dark', true]] as const).map(([label, on]) => (
              <button key={label} type="button" onClick={() => setDark(on)} aria-pressed={dark === on}
                className={`rounded-full px-3 py-0.5 font-mono text-[11px] transition-colors ${dark === on
                  ? 'bg-ember text-graphite'
                  : 'text-slate-ink hover:text-obsidian dark:text-mist dark:hover:text-vellum'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="ml-auto max-w-xs text-xs text-slate-ink">
          Both themes are the same design system with the surface roles swapped, not a
          second look. Your choice is kept on this device.
        </p>
      </div>

      <Notifications />

      <ChangePassword />

      <Section title="Session"
        note="What this browser is signed in as. Useful when something is refused and it is not obvious why.">
        <Field label="Account id">
          <span className={`text-xs break-all text-slate-ink ${mono}`}>{me?.sub ?? '—'}</span>
        </Field>
        <Field label="Kind"><span className={`text-xs ${mono}`}>{me?.kind ?? '—'}</span></Field>
        <Field label="Role"><span className={`text-xs ${mono}`}>{me?.role ?? '—'}</span></Field>
      </Section>

      {admin && <StaffAccounts meId={me?.sub} />}
    </div>
  );
}

// --------------------------------------------------------------- notifications

type Pref = { kind: string; label: string; note: string; enabled: boolean; locked: boolean };

/**
 * Which notifications you want. The same panel on both sides — the API answers with the
 * kinds that apply to whoever is asking, so this component never has to know whether it is
 * showing a trader's fills or a compliance officer's flags.
 *
 * Saved on the toggle rather than behind a Save button: there is nothing to get half-right,
 * and a preferences page you can leave without saving is a preferences page that lies. The
 * switch moves at once and rolls back if the write fails.
 */
function Notifications() {
  const prefs = useApi<Pref[]>('/me/notification-prefs');
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const value = (p: Pref) => local[p.kind] ?? p.enabled;
  const off = (prefs.data ?? []).filter((p) => !value(p)).length;

  async function toggle(p: Pref) {
    const next = !value(p);
    setLocal((v) => ({ ...v, [p.kind]: next }));
    setError(null);
    try {
      await api('/me/notification-prefs', { method: 'PUT', body: JSON.stringify({ [p.kind]: next }) });
    } catch (err) {
      setLocal((v) => ({ ...v, [p.kind]: !next }));
      setError((err as Error).message);
    }
  }

  return (
    <Section title={`Notifications${off ? ` · ${off} off` : ''}`}
      note="What reaches your bell. Switching one off stops it being written at all, so it will not turn up later — it simply never happens.">
      {!prefs.data ? <p className="text-sm text-slate-ink">Loading…</p> : prefs.data.map((p) => (
        <div key={p.kind} className="flex items-start gap-4 border-t border-pebble py-2 first:border-0 dark:border-white/10">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{p.label}</p>
            <p className="text-xs text-slate-ink">{p.note}</p>
          </div>
          <Switch on={value(p)} locked={p.locked} label={p.label} onChange={() => toggle(p)} />
        </div>
      ))}
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
      className={`mt-1 h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${on ? 'bg-ember' : 'bg-pebble dark:bg-white/15'} ${locked ? 'cursor-not-allowed opacity-60' : ''}`}>
      <span className={`block h-5 w-5 rounded-full bg-vellum shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  );
}

// ------------------------------------------------------------------ own password

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    // Caught here as well as by the server, so a typo costs a keystroke, not a round trip.
    if (next !== confirm) return setError('the two new passwords do not match');
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

  return (
    <Section title="Password" note="At least 8 characters. Your current password is required.">
      <form onSubmit={submit} className="space-y-2">
        <input className={input} type="password" placeholder="Current password" required
          autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className={input} type="password" placeholder="New password" required minLength={8}
          autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <input className={input} type="password" placeholder="Repeat new password" required minLength={8}
          autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && <p role="alert" className={`${alertBox} font-mono text-xs`}>{error}</p>}
        {done && <p role="status" className="font-mono text-xs text-slate-ink">Password changed.</p>}
        <button className={btn} disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button>
      </form>
    </Section>
  );
}

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
    <Section title={`Staff accounts · ${active} active`}
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
                  <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] tracking-wide uppercase ${
                    s.active ? 'bg-up/15 text-up' : 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'}`}>
                    {s.active ? 'active' : 'off'}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  {s.id !== meId && (
                    <button
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${resetting === s.id
                        ? 'border-ember text-ember'
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

const Section = ({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) => (
  <section className={`${card} space-y-4`}>
    <div>
      <h2 className="metric-label">{title}</h2>
      {note && <p className="mt-1.5 max-w-2xl text-xs text-slate-ink">{note}</p>}
    </div>
    {children}
  </section>
);

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-wrap items-center gap-3 border-t border-pebble py-2 first:border-0 first:pt-0 dark:border-white/10">
    <span className="metric-label w-32 shrink-0">{label}</span>
    {children}
  </div>
);
