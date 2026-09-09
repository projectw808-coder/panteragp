import { useState, type FormEvent } from 'react';
import { alertBox, btn, btnGhost, card, input, mono, tableCard, thead } from './App.tsx';
import { api, useApi } from './api.ts';

type Me = { sub: string; kind: 'staff' | 'client'; role: string };
type Staff = { id: string; name: string; email: string; role: string; active: boolean };

/**
 * Everything about your own account in one place, plus the account controls an admin
 * needs. Changing your own password always costs you the current one; setting someone
 * else's is a separate, admin-only power (see password:reset in src/auth.ts).
 */
export function SettingsView({ me, dark, setDark }: {
  me: Me | null; dark: boolean; setDark: (v: boolean) => void;
}) {
  const admin = me?.role === 'admin';
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="font-display text-[28px] leading-none tracking-tight">Settings</h1>

      <Section title="Appearance" note="Both themes are the same design system with the surface roles swapped.">
        <Field label="Theme">
          <div role="group" aria-label="Colour theme" className="flex gap-1 rounded-full bg-bone p-0.5 dark:bg-white/10">
            {([['Light', false], ['Dark', true]] as const).map(([label, on]) => (
              <button key={label} type="button" onClick={() => setDark(on)} aria-pressed={dark === on}
                className={`rounded-full px-4 py-1 font-mono text-xs transition-colors ${dark === on
                  ? 'bg-ember text-graphite'
                  : 'text-slate-ink hover:text-obsidian dark:text-mist dark:hover:text-vellum'}`}>
                {label}
              </button>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="Account">
        <Field label="Signed in as"><span className={`text-xs ${mono}`}>{me?.sub ?? '—'}</span></Field>
        <Field label="Kind"><span className={`text-xs ${mono}`}>{me?.kind ?? '—'}</span></Field>
        <Field label="Role"><span className={`text-xs ${mono}`}>{me?.role ?? '—'}</span></Field>
      </Section>

      <Notifications />

      <ChangePassword />

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
    <Section title="Notifications"
      note="What reaches your bell. Switching one off stops it being written at all — it will not appear later.">
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

  return (
    <Section title="Staff accounts"
      note="Setting someone's password hands over their account, so it is admin-only and audited. You cannot reset your own here — use Password above, with your current one.">
      <div className={`${tableCard} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>{['Name', 'Email', 'Role', 'Status', ''].map((h) =>
              <th key={h} className="px-4 py-2">{h}</th>)}</tr>
          </thead>
          <tbody>
            {staff.data?.map((s) => (
              <tr key={s.id} className="border-t border-pebble dark:border-white/10">
                <td className="px-4 py-2 font-medium">{s.name}</td>
                <td className={`px-4 py-2 text-xs text-slate-ink ${mono}`}>{s.email}</td>
                <td className={`px-4 py-2 text-xs ${mono}`}>{s.role}</td>
                <td className="px-4 py-2 text-xs">
                  {s.active
                    ? <span className="text-slate-ink">active</span>
                    : <span className="rounded-full bg-bone px-2 py-0.5 text-slate-ink dark:bg-white/5 dark:text-mist">off</span>}
                </td>
                <td className="px-4 py-2 text-right">
                  {s.id === meId
                    ? <span className="text-xs text-mist">you</span>
                    : <button className="text-xs text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum"
                        onClick={() => setResetting(resetting === s.id ? null : s.id)}>
                        reset password
                      </button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
  <section className={`${card} space-y-3`}>
    <div>
      <h2 className="text-sm font-medium">{title}</h2>
      {note && <p className="mt-1 text-xs text-slate-ink">{note}</p>}
    </div>
    {children}
  </section>
);

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-wrap items-center gap-3">
    <span className="w-32 shrink-0 text-xs text-slate-ink">{label}</span>
    {children}
  </div>
);
