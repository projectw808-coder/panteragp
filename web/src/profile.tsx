import { useEffect, useRef, useState, type FormEvent } from 'react';
import { alertBox, btn, card, field, mono, PageTitle } from './App.tsx';
import { api, token, useApi } from './api.ts';
import { BalancePanel } from './balance.tsx';

/**
 * The client's own record, as they see it.
 *
 * Three parts, in the order somebody actually wants them: who they are, what the desk
 * holds about them that they cannot change, and the half that is theirs to correct.
 * Putting the read-only half first is deliberate — the question people arrive with is
 * "what do you have on me", and answering it before offering a form is the difference
 * between a record and a data-entry screen.
 */

type Profile = {
  id: string; email: string; name: string; phone: string | null; country: string | null;
  date_of_birth: string | null; address: string | null;
  tier: string; kyc_status: string; created_at: string;
  avatar_key: string | null;
};

/** Initials for the avatar. Two at most; a long name should not fill the circle. */
const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';

const VERIFICATION: Record<string, string> = {
  approved: 'chip-up text-up',
  pending: 'bg-ember/15 text-ember-ink',
  rejected: 'chip-down text-down',
  expired: 'chip-down text-down',
  none: 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist',
};

export function ProfileView() {
  const me = useApi<Profile>('/me/profile');
  const p = me.data;

  if (me.error) return <p role="alert" className={alertBox}>{me.error}</p>;
  if (!p) return <p className="text-sm text-slate-ink">Loading…</p>;

  return (
    <div className="stagger mx-auto max-w-3xl space-y-4">
      <PageTitle>Profile</PageTitle>

      <div className={`${card} flex flex-wrap items-center gap-5`}>
        <Avatar p={p} onChanged={me.reload} />
        <div className="min-w-0">
          <h2 className="font-display text-[22px] leading-tight tracking-tight">{p.name}</h2>
          <p className={`text-sm text-ember-ink ${mono}`}>{p.email}</p>
          <p className={`text-xs text-slate-ink ${mono}`}>
            Client since {new Date(p.created_at).toLocaleDateString()}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-bone px-2.5 py-0.5 font-mono text-[11px] tracking-wide uppercase dark:bg-white/10">
            {p.tier}
          </span>
          <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] tracking-wide uppercase ${
            VERIFICATION[p.kyc_status] ?? VERIFICATION.none}`}>
            {p.kyc_status === 'none' ? 'unverified' : p.kyc_status}
          </span>
        </div>
      </div>

      <div className={`${card} space-y-3`}>
        <h2 className="metric-label">Balance</h2>
        <BalancePanel />
      </div>

      <Details p={p} onSaved={me.reload} />

      <p className="px-1 text-xs text-slate-ink">
        Your email is the login, so it is changed by the desk rather than here — open a
        support ticket and we will do it with you. Tier and verification are ours to set.
      </p>
    </div>
  );
}

/**
 * The photo, and changing it.
 *
 * Fetched with the bearer token and handed to the page as a blob: the file sits behind
 * auth, so a plain src would arrive without one and draw a broken image. The URL carries
 * the stored key, so replacing the photo changes the URL and the browser cannot serve the
 * old one from cache.
 */
function Avatar({ p, onChanged }: { p: Profile; onChanged: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!p.avatar_key) { setSrc(null); return; }
    let url: string | null = null;
    let dropped = false;
    fetch(`/api/clients/${p.id}/avatar`, { headers: { authorization: `Bearer ${token.get()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('could not load the photo'))))
      .then((b) => {
        if (dropped) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => setSrc(null));
    // Revoked on the way out, or every change leaks the one before it.
    return () => { dropped = true; if (url) URL.revokeObjectURL(url); };
  }, [p.id, p.avatar_key]);

  async function upload(chosen: File) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('file', chosen);
    const res = await fetch('/api/me/avatar', {
      method: 'POST', headers: { authorization: `Bearer ${token.get()}` }, body: form,
    });
    setBusy(false);
    if (file.current) file.current.value = '';
    if (!res.ok) return setError((await res.json().catch(() => null))?.error ?? 'Upload failed');
    onChanged();
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api('/me/avatar', { method: 'DELETE' });
      onChanged();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="shrink-0">
      <label className="group relative block h-20 w-20 cursor-pointer" title="Change your photo">
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
        {src ? (
          <img src={src} alt="" className="h-20 w-20 rounded-full object-cover" />
        ) : (
          <span aria-hidden
            className="grid h-20 w-20 place-items-center rounded-full bg-ember/15 font-display text-2xl text-ember-ink">
            {initials(p.name)}
          </span>
        )}
        <span className="absolute inset-0 grid place-items-center rounded-full bg-graphite/60 font-mono text-[10px] tracking-wide text-vellum uppercase opacity-0 transition-opacity group-hover:opacity-100">
          {busy ? '…' : src ? 'change' : 'add photo'}
        </span>
      </label>
      {src && !busy && (
        <button type="button" onClick={remove}
          className="mt-1.5 block w-20 text-center font-mono text-[10px] tracking-wide text-slate-ink uppercase hover:text-down">
          remove
        </button>
      )}
      {error && <p role="alert" className="mt-1 max-w-40 text-xs text-down">{error}</p>}
    </div>
  );
}

/** The half they own. Blank means remove it — every field here is allowed to be nothing. */
function Details({ p, onSaved }: { p: Profile; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setDone(false);
    setBusy(true);
    try {
      // Name is required; the rest are cleared by emptying the box.
      const body = Object.fromEntries([...f.entries()]
        .map(([k, v]) => [k, v === '' ? (k === 'name' ? undefined : null) : v])
        .filter(([, v]) => v !== undefined));
      await api('/me/profile', { method: 'PATCH', body: JSON.stringify(body) });
      setDone(true);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-4`}>
      <div>
        <h2 className="metric-label">Personal details</h2>
        <p className="mt-1 text-xs text-slate-ink">
          Keep these matching your identification — a mismatch is the usual reason a
          verification stalls. Leave a box empty to remove what is in it.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Labelled label="Full name">
          <input name="name" required maxLength={200} defaultValue={p.name} className={field} />
        </Labelled>
        <Labelled label="Phone">
          <input name="phone" maxLength={40} defaultValue={p.phone ?? ''} placeholder="+44 20 7946 0100"
            className={field} />
        </Labelled>
        <Labelled label="Date of birth">
          <input name="date_of_birth" type="date" defaultValue={p.date_of_birth?.slice(0, 10) ?? ''}
            className={field} />
        </Labelled>
        <Labelled label="Country">
          <input name="country" maxLength={2} defaultValue={p.country ?? ''} placeholder="GB"
            className={`${field} uppercase`} />
        </Labelled>
        <div className="sm:col-span-2">
          <Labelled label="Address">
            <input name="address" maxLength={400} defaultValue={p.address ?? ''}
              placeholder="Street, city, postcode" className={field} />
          </Labelled>
        </div>
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      <div className="flex flex-wrap items-center gap-3 border-t border-pebble pt-4 dark:border-white/10">
        <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button>
        {done && <span role="status" className="font-mono text-xs text-up">Saved.</span>}
      </div>
    </form>
  );
}

const Labelled = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="metric-label">{label}</span>
    <span className="mt-1 block">{children}</span>
  </label>
);
