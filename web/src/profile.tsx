import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Award, CalendarDays, Check, Circle, Clock, FileText, Globe, Hash, Headset, Mail, MapPin, Phone,
  Plus, ShieldCheck, User, Wallet, X,
} from 'lucide-react';
import { alertBox, btn, PageTitle } from './App.tsx';
import { api, token, useApi } from './api.ts';
import { held, headline, unit, type Accounts } from './balance.tsx';
import { CopyButton } from './copy.tsx';
import { StatTile } from './x-shell.tsx';

/**
 * The client's own record, as they see it.
 *
 * Who they are and how complete the record is first, then the four figures they come
 * back for, then the half that is theirs to correct beside what the desk holds and what
 * verification is still waiting on. The read-only half stays visible next to the form,
 * because the question people arrive with is "what do you have on me".
 */

type Profile = {
  id: string; account_number: string | null; email: string; name: string; phone: string | null; country: string | null;
  date_of_birth: string | null; address: string | null;
  tier: string; kyc_status: string; created_at: string;
  avatar_key: string | null;
};

type Doc = { id: number; kind: string; status: string };

/** Initials for the avatar. Two at most, letters and digits only. */
const initials = (name: string) =>
  name.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';

/**
 * The record's own fields, in the order the form asks for them.
 *
 * Only these five: tier, verification and the email are the desk's, and counting them
 * would make the ring say a client had work to do that they cannot do.
 */
const FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'date_of_birth', label: 'Date of birth' },
  { key: 'country', label: 'Country' },
  { key: 'address', label: 'Address' },
] as const;

const RING = 2 * Math.PI * 52;
const missing = (p: Profile) => FIELDS.filter((f) => !String(p[f.key] ?? '').trim());
const filled = (p: Profile) => FIELDS.length - missing(p).length;

const KYC: Record<string, { label: string; badge: string; tone: string }> = {
  approved: { label: 'Verified', badge: '', tone: 'text-up' },
  pending: { label: 'Pending', badge: 'is-locked', tone: 'text-ember-ink' },
  rejected: { label: 'Rejected', badge: 'is-bad', tone: 'text-down' },
  expired: { label: 'Expired', badge: 'is-bad', tone: 'text-down' },
  none: { label: 'Not started', badge: 'is-muted', tone: '' },
};
const kyc = (s: string) => KYC[s] ?? KYC.none!;

const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** Takes the reader to a field of the form and puts the cursor in it. */
function goTo(key: string) {
  const el = document.querySelector<HTMLInputElement>(`#profile-details [name="${key}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus({ preventScroll: true });
}

export function ProfileView() {
  const me = useApi<Profile>('/me/profile');
  const p = me.data;

  if (me.error) return <p role="alert" className={alertBox}>{me.error}</p>;
  if (!p) {
    return (
      <div className="mx-auto max-w-[1300px] space-y-4">
        <PageTitle>Profile</PageTitle>
        <div className="skeleton h-40 rounded-xl" />
      </div>
    );
  }

  const v = kyc(p.kyc_status);

  return (
    <div className="stagger mx-auto max-w-[1300px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Profile</PageTitle>
        <span className={`x-badge ${v.badge}`}><ShieldCheck size={13} className="mr-1.5" aria-hidden />{v.label}</span>
        <a href="#/support" className="x-btn-sm ml-auto inline-flex items-center gap-2">
          <Headset size={15} aria-hidden />Ask the desk
        </a>
      </div>

      <Hero p={p} onChanged={me.reload} />
      <Figures p={p} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Details p={p} onSaved={me.reload} />
        <div className="space-y-4">
          <Verification p={p} />
          <Held p={p} />
        </div>
      </div>
    </div>
  );
}

/** Photo, name and the identifiers people copy, with how complete the record is beside them. */
function Hero({ p, onChanged }: { p: Profile; onChanged: () => void }) {
  const gaps = missing(p);
  const n = filled(p);

  return (
    <div className="x-card x-holo grid gap-6 p-5 sm:p-6 md:grid-cols-[minmax(0,1fr)_320px] md:items-center">
      <div className="flex min-w-0 flex-wrap items-center gap-5">
        <Avatar p={p} onChanged={onChanged} />
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[26px] leading-tight font-bold tracking-tight">{p.name}</h2>
            <span className="x-badge is-muted capitalize">{p.tier}</span>
          </div>
          <dl className="space-y-1.5 text-[13px]">
            {p.account_number && (
              <div className="flex items-center gap-2">
                <dt className="flex w-20 shrink-0 items-center gap-1.5 text-mist"><Hash size={13} aria-hidden />Account</dt>
                <dd className="font-mono tabular-nums">{p.account_number}</dd>
                <CopyButton text={p.account_number} />
              </div>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <dt className="flex w-20 shrink-0 items-center gap-1.5 text-mist"><Mail size={13} aria-hidden />Email</dt>
              <dd className="truncate text-ember-ink">{p.email}</dd>
              <CopyButton text={p.email} />
            </div>
            <div className="flex items-center gap-2">
              <dt className="flex w-20 shrink-0 items-center gap-1.5 text-mist"><CalendarDays size={13} aria-hidden />Since</dt>
              <dd>{longDate(p.created_at)}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="x-mini-tile space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-mist">Your details</span>
          <span className={`text-[15px] font-semibold tabular-nums ${gaps.length ? '' : 'text-up'}`}>{n} of {FIELDS.length}</span>
        </div>
        <div className="x-meter"><span style={{ width: `${(n / FIELDS.length) * 100}%` }} /></div>
        {gaps.length ? (
          <>
            <p className="text-xs text-slate-ink">Still to add — they need to match your identification.</p>
            <div className="flex flex-wrap gap-1.5">
              {gaps.map((f) => (
                <button key={f.key} type="button" onClick={() => goTo(f.key)} className="pf-gap">
                  <Plus size={12} aria-hidden />{f.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-up"><Check size={14} aria-hidden />Everything is on file.</p>
        )}
      </div>
    </div>
  );
}

/** The four figures people open this page for, in the platform's stat tiles. */
function Figures({ p }: { p: Profile }) {
  const acc = useApi<Accounts>('/accounts');
  const a = acc.data;
  const v = kyc(p.kyc_status);
  const native = a ? unit(a).code !== null : false;
  const total = a ? headline(a) : null;
  const equity = a && total ? (!native && a.equity_usd !== undefined ? Number(a.equity_usd) : total.value) : null;
  const rows = a ? held(a) : [];
  const days = Math.max(0, Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86_400_000));

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile label="Equity" Icon={Wallet} tone="text-ember-ink"
        value={equity !== null && total ? total.format(equity) : <span className="skeleton inline-block h-5 w-28" />}
        note={rows.length
          ? rows.slice(0, 3).map(([code, n]) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: Math.abs(Number(n)) >= 1000 ? 2 : 6 })} ${code}`).join(' · ')
          : 'No balances yet — the desk funds your account'} />
      <StatTile label="Tier" Icon={Award} value={<span className="capitalize">{p.tier}</span>}
        note="Sets your commission and what the desk can agree" />
      <StatTile label="Verification" Icon={ShieldCheck} value={v.label} tone={v.tone}
        note={p.kyc_status === 'approved' ? 'Both required documents accepted' : 'See what is still needed, below'} />
      <StatTile label="Client for" Icon={CalendarDays} value={`${days} day${days === 1 ? '' : 's'}`}
        note={`Since ${longDate(p.created_at)}`} />
    </div>
  );
}

const DOC_LABEL: Record<string, string> = { id_front: 'Photo ID', proof_of_address: 'Proof of address' };

/**
 * What verification is waiting on, as the sequence it is: details, the two documents,
 * then the desk's decision. Each step says whether it is done, waiting, or yours to do.
 */
function Verification({ p }: { p: Profile }) {
  const docs = useApi<Doc[]>(`/clients/${p.id}/kyc`);
  const rows = docs.data ?? [];
  const docState = (k: string) => {
    const sent = rows.filter((d) => d.kind === k);
    return (sent.find((d) => d.status === 'approved') ?? sent.find((d) => d.status === 'pending') ?? sent[0])?.status ?? 'missing';
  };

  const detailsDone = !missing(p).length;
  const steps: { label: string; state: 'done' | 'wait' | 'todo' | 'bad'; note: string; href?: string }[] = [
    { label: 'Your details', state: detailsDone ? 'done' : 'todo', note: detailsDone ? 'All five on file' : `${filled(p)} of ${FIELDS.length} on file` },
    ...(['id_front', 'proof_of_address'] as const).map((k) => {
      const s = docState(k);
      return {
        label: DOC_LABEL[k]!, href: '#/documents',
        state: s === 'approved' ? 'done' as const : s === 'pending' ? 'wait' as const : s === 'rejected' ? 'bad' as const : 'todo' as const,
        note: s === 'approved' ? 'Accepted' : s === 'pending' ? 'With the desk for review' : s === 'rejected' ? 'Not accepted — send a new one' : 'Not sent yet',
      };
    }),
    {
      label: 'Desk decision',
      state: p.kyc_status === 'approved' ? 'done' : p.kyc_status === 'rejected' || p.kyc_status === 'expired' ? 'bad' : 'wait',
      note: p.kyc_status === 'approved' ? 'Your account is verified' : p.kyc_status === 'rejected' ? 'Not approved — the desk will tell you why'
        : p.kyc_status === 'expired' ? 'Expired — send current documents' : 'Made once both documents are in',
    },
  ];
  const done = steps.filter((s) => s.state === 'done').length;

  return (
    <div className="x-card x-holo space-y-4 p-5">
      <div className="flex items-center gap-3">
        <h2 className="section-title">Verification</h2>
        <span className={`x-badge ml-auto ${done === steps.length ? '' : 'is-locked'}`}>{done} of {steps.length} done</span>
      </div>
      <ol className="pf-steps">
        {steps.map((s) => {
          const Icon = s.state === 'done' ? Check : s.state === 'wait' ? Clock : s.state === 'bad' ? X : Circle;
          const body = (
            <>
              <span className={`pf-step-dot is-${s.state}`}><Icon size={13} strokeWidth={2.4} aria-hidden /></span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-semibold">{s.label}</span>
                <span className="block text-xs text-slate-ink">{s.note}</span>
              </span>
            </>
          );
          return (
            <li key={s.label}>
              {s.href && s.state !== 'done'
                ? <a href={s.href} className="pf-step is-link">{body}<FileText size={15} className="ml-auto text-mist" aria-hidden /></a>
                : <div className="pf-step">{body}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The half the desk holds — shown as the record it is, with the way to change it. */
function Held({ p }: { p: Profile }) {
  return (
    <div className="x-card x-holo space-y-3 p-5">
      <div>
        <h2 className="section-title">Held by the desk</h2>
        <p className="mt-1 text-xs text-slate-ink">These are ours to set. Raise a ticket and we will change them with you.</p>
      </div>
      <dl className="pf-rows text-[13px]">
        {p.account_number && <Row label="Account number" value={<span className="font-mono tabular-nums">{p.account_number}</span>} note="Quote it on calls and transfers" />}
        <Row label="Sign-in email" value={<span className="break-all">{p.email}</span>} note="Changed with us, not here" />
        <Row label="Tier" value={<span className="capitalize">{p.tier}</span>} note="Sets your commission" />
      </dl>
      <a href="#/support" className="x-btn-sm inline-flex items-center gap-2"><Headset size={14} aria-hidden />Raise a ticket</a>
    </div>
  );
}

const Row = ({ label, value, note }: { label: string; value: React.ReactNode; note: string }) => (
  <div className="flex items-start justify-between gap-4 py-2.5">
    <div>
      <dt className="text-mist">{label}</dt>
      <p className="text-[11.5px] text-slate-ink">{note}</p>
    </div>
    <dd className="text-right font-medium">{value}</dd>
  </div>
);

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
      {/* The ring counts how much of the record is on file. */}
      <span className="relative block h-[112px] w-[112px] p-2">
        <svg viewBox="0 0 112 112" className="absolute inset-0 h-[112px] w-[112px]" aria-hidden>
          <circle cx="56" cy="56" r="52" fill="none" strokeWidth="3" className="stroke-white/10" />
          <circle className="ring-draw pf-ring" cx="56" cy="56" r="52" fill="none" strokeWidth="3"
            stroke="url(#pf-ring)" strokeLinecap="round" transform="rotate(-90 56 56)"
            strokeDasharray={RING} strokeDashoffset={RING * (1 - filled(p) / FIELDS.length)}
            style={{ '--len': RING } as React.CSSProperties} />
          <defs>
            <linearGradient id="pf-ring" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ffb066" /><stop offset="1" stopColor="#ff7518" />
            </linearGradient>
          </defs>
        </svg>
        <label className="group relative block h-24 w-24 cursor-pointer" title="Change your photo">
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          {src ? (
            <img src={src} alt="" className="h-24 w-24 rounded-full object-cover" />
          ) : (
            <span aria-hidden className="pf-initials grid h-24 w-24 place-items-center rounded-full text-[30px] font-bold">
              {initials(p.name)}
            </span>
          )}
          <span className="absolute inset-0 grid place-items-center rounded-full bg-black/60 text-[11px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {busy ? '…' : src ? 'Change photo' : 'Add photo'}
          </span>
        </label>
      </span>
      {src && !busy && (
        <button type="button" onClick={remove} className="mx-auto mt-1 block text-[11px] text-slate-ink hover:text-down">
          Remove photo
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
  const [dirty, setDirty] = useState(false);

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
      setDirty(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id="profile-details" onSubmit={submit} onChange={() => { setDirty(true); setDone(false); }}
      className="x-card x-holo space-y-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h2 className="section-title">Personal details</h2>
          <p className="mt-1 max-w-xl text-xs text-slate-ink">
            Keep these matching your identification — a mismatch is the usual reason a
            verification stalls. Leave a box empty to remove what is in it.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Labelled label="Full name" Icon={User}>
          <input name="name" required maxLength={200} defaultValue={p.name} className="x-field pf-input w-full" />
        </Labelled>
        <Labelled label="Phone" Icon={Phone}>
          <input name="phone" type="tel" maxLength={40} defaultValue={p.phone ?? ''} placeholder="+44 20 7946 0100"
            className="x-field pf-input w-full" />
        </Labelled>
        <Labelled label="Date of birth" Icon={CalendarDays}>
          <input name="date_of_birth" type="date" defaultValue={p.date_of_birth?.slice(0, 10) ?? ''}
            className="x-field pf-input w-full" />
        </Labelled>
        <Labelled label="Country" hint="Two-letter code" Icon={Globe}>
          <input name="country" maxLength={2} defaultValue={p.country ?? ''} placeholder="GB"
            className="x-field pf-input w-full uppercase" />
        </Labelled>
        <div className="sm:col-span-2">
          <Labelled label="Address" Icon={MapPin}>
            <input name="address" maxLength={400} defaultValue={p.address ?? ''}
              placeholder="Street, city, postcode" className="x-field pf-input w-full" />
          </Labelled>
        </div>
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      <div className="flex flex-wrap items-center gap-3 pf-foot pt-4">
        <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button>
        {done && <span role="status" className="flex items-center gap-1.5 text-xs text-up"><Check size={14} aria-hidden />Saved</span>}
        {dirty && !done && <span className="text-xs text-slate-ink">Unsaved changes</span>}
      </div>
    </form>
  );
}

const Labelled = ({ label, hint, Icon, children }: { label: string; hint?: string; Icon: typeof User; children: React.ReactNode }) => (
  <label className="block">
    <span className="flex items-baseline justify-between text-[12.5px] text-mist">
      {label}{hint && <span className="text-[11px] text-slate-ink">{hint}</span>}
    </span>
    <span className="pf-field mt-1.5 block">
      <Icon size={15} className="pf-field-icon" aria-hidden />
      {children}
    </span>
  </label>
);
