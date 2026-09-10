import { useState, type FormEvent } from 'react';
import { alertBox, btn, card, field, mono, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { BalancePanel } from './balance.tsx';

/**
 * The client's own record, as they see it.
 *
 * Two halves on purpose. The top is what the desk holds about them and they cannot change:
 * their tier, their verification status, the email they sign in with. The bottom is theirs
 * to correct. Showing both together answers the question people actually arrive with —
 * "what do you have on me?" — instead of only offering a form.
 */

type Profile = {
  id: string; email: string; name: string; phone: string | null; country: string | null;
  date_of_birth: string | null; address: string | null;
  tier: string; kyc_status: string; created_at: string;
  terms: { commission_bps: number; spread_bps: number };
};

export function ProfileView() {
  const me = useApi<Profile>('/me/profile');
  const p = me.data;

  if (me.error) return <p role="alert" className={alertBox}>{me.error}</p>;
  if (!p) return <p className="text-sm text-slate-ink">Loading…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle>Profile</PageTitle>

      <div className={`${card} space-y-3`}>
        <h2 className="metric-label">Balance</h2>
        <BalancePanel />
      </div>

      <div className={`${card} space-y-3`}>
        <h2 className="metric-label">Your account</h2>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Read label="Signed in as" value={p.email} accent />
          <Read label="Client since" value={new Date(p.created_at).toLocaleDateString()} />
          <Read label="Tier" value={p.tier} />
          <Read label="Verification" value={p.kyc_status} />
          <Read label="Commission" value={bps(p.terms?.commission_bps)} />
          <Read label="Spread" value={bps(p.terms?.spread_bps)} />
        </dl>
        <p className="text-xs text-slate-ink">
          Commission is charged on the size of each fill and the spread is built into the
          price you get. Both are shown on every trade in your history.
        </p>
        <p className="text-xs text-slate-ink">
          Your email is your login, so it is changed by the desk rather than here — open a
          support ticket and we will do it with you. Tier and verification are ours to set.
        </p>
      </div>

      <Details p={p} onSaved={me.reload} />

    </div>
  );
}

const bps = (n: number | undefined) =>
  n === undefined ? "—" : n === 0 ? "none" : `${Number((n / 100).toFixed(4))}% per trade`;

const Read = ({ label, value, accent }: { label: string; value: string; accent?: boolean }) => (
  <div>
    <dt className="metric-label">{label}</dt>
    <dd className={`mt-1 text-sm ${mono} ${accent ? 'text-ember' : 'text-obsidian dark:text-vellum'}`}>{value}</dd>
  </div>
);

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

      <div className="grid gap-3 sm:grid-cols-2">
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
      {done && <p role="status" className="font-mono text-xs text-slate-ink">Saved.</p>}
      <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button>
    </form>
  );
}

const Labelled = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="metric-label">{label}</span>
    <span className="mt-1 block">{children}</span>
  </label>
);
