import { useState, type FormEvent } from 'react';
import { Plus, Search, UserCheck, UserX, Users, Clock } from 'lucide-react';
import { alertBox, btn, card, field, input, mono, PageTitle, tableCard, thead } from './App.tsx';
import { api, useApi, type Stage, type Task } from './api.ts';
import { ClientRow } from './client-row.tsx';
import { CopyButton } from './copy.tsx';

const when = (iso: string) => new Date(iso).toLocaleString();
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString() ? `?${p}` : '';
};

// ------------------------------------------------------------- client list

const LIMIT = 200;

/**
 * Everybody on the desk, with the filters that actually get used.
 *
 * The list is capped, and says so when it is full rather than presenting a page as if it
 * were everything — a screen that quietly shows the first two hundred of a thousand is one
 * that gets a decision made on the wrong set. The count above the table is what is on
 * screen; the tiles are what is on the desk.
 */
export function ClientList() {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [kyc, setKyc] = useState('');
  const [owner, setOwner] = useState('');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Downloading a document needs kyc:review, so the row only offers it to those who have it.
  const { data: me } = useApi<{ role: string; sub: string }>('/me');
  const stages = useApi<Stage[]>('/pipeline-stages');
  const staff = useApi<{ id: string; name: string }[]>('/staff');
  const clients = useApi<Parameters<typeof ClientRow>[0]['c'][]>(
    `/clients${qs({ q, stage_id: stage, kyc_status: kyc, owner_staff_id: owner, limit: LIMIT })}`);

  const rows = clients.data ?? [];
  const capped = rows.length === LIMIT;
  const filtered = !!(q || stage || kyc || owner);

  // Counted over what came back rather than asked of the database: these describe the set
  // on screen, which is what somebody filtering wants to know about.
  const week = Date.now() - 7 * 86_400_000;
  const isNew = rows.filter((c) => +new Date(c.created_at) > week).length;
  const waiting = rows.filter((c) => c.kyc_status === 'pending').length;
  // Active: the client can sign in. Inactive: a record with no login yet.
  const active = rows.filter((c) => c.has_login).length;
  const inactive = rows.length - active;

  const clear = () => { setQ(''); setStage(''); setKyc(''); setOwner(''); };

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Clients</PageTitle>
        <button className={`${btn} ml-auto flex items-center gap-1.5`} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : <><Plus size={16} aria-hidden />Add Client</>}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {([
          [filtered ? 'Matching' : 'Total Clients', `${rows.length}${capped ? '+' : ''}`, Users, '', `${isNew} new this week`],
          ['Active', String(active), UserCheck, 'text-up', 'Can sign in'],
          ['Pending KYC', String(waiting), Clock, waiting ? 'text-ember-ink' : '', 'Awaiting verification'],
          ['Inactive', String(inactive), UserX, '', 'No login yet'],
        ] as const).map(([label, value, Icon, tone, note]) => (
          <div key={label} className="x-card tile lift p-4">
            <div className="flex items-center justify-between"><span className="text-[13px] text-mist">{label}</span><Icon size={16} className="text-mist" aria-hidden /></div>
            <p className={`mt-2 text-[26px] leading-none font-bold tabular-nums ${tone}`}>{value}</p>
            <p className="mt-2 text-xs text-slate-ink">{note}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="x-search min-w-56 flex-1">
          <Search size={15} aria-hidden className="text-mist" />
          <span className="sr-only">Search clients</span>
          <input placeholder="Search by name, email or account number…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <select className={`${field} w-36`} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages</option>
          {stages.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className={`${field} w-36`} value={kyc} onChange={(e) => setKyc(e.target.value)}>
          <option value="">Any verification</option>
          {['none', 'pending', 'approved', 'rejected', 'expired'].map((k) =>
            <option key={k} value={k}>{k}</option>)}
        </select>
        <select className={`${field} w-40`} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Any owner</option>
          {me?.sub && <option value={me.sub}>Mine</option>}
          {staff.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {filtered && (
          <button onClick={clear}
            className="rounded-full border border-pebble px-2.5 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
            Clear
          </button>
        )}
        {/* Whatever the filters have narrowed to, comma separated for a To: field. The
            list as shown, not the whole book — the filters are how somebody says who they
            meant, so copying past them would hand over addresses they did not ask for. */}
        {!!rows.length && (
          <CopyButton className="px-2.5 py-1 text-xs normal-case"
            text={rows.map((c) => c.email).join(', ')}
            label={`Copy ${rows.length} email${rows.length === 1 ? '' : 's'}`}
            done={`${rows.length} copied`}
            title="Copy the email addresses of everyone listed below" />
        )}
      </div>

      {adding && <NewClient onDone={() => { setAdding(false); clients.reload(); }} />}

      {clients.error && <p role="alert" className={alertBox}>{clients.error}</p>}

      <div className={`${tableCard} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>{['Client', 'Email', 'Stage', 'Status', 'Manager', 'Joined'].map((h) =>
              <th key={h} className="px-4 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <ClientRow key={c.id} c={c} open={openId === c.id}
                onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                onChanged={clients.reload}
                badge={(v) => <Badge value={v} />}
                canReviewKyc={me?.role === 'compliance' || me?.role === 'admin'}
                canResetPassword={me?.role === 'admin'}
                canMoveFunds={me?.role === 'admin'}
                canWrite={me?.role === 'sales' || me?.role === 'support' || me?.role === 'admin'}
                stages={stages.data ?? []} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-slate-ink">
            {filtered ? 'Nobody matches that.' : 'No clients yet.'}
          </p>
        )}
      </div>

      {capped && (
        <p className="px-1 text-xs text-slate-ink">
          Showing the first {LIMIT}, newest first. Narrow the search to see further back.
        </p>
      )}
    </div>
  );
}

function NewClient({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/clients', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries([...f.entries()].filter(([, v]) => v !== ''))),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-4`}>
      <div>
        <h2 className="section-title">New client</h2>
        <p className="mt-1 text-xs text-slate-ink">
          A name and an email is enough to start. Everything else can follow, and they can
          fill in their own details once they have a login.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="metric-label">Name</span>
          <input name="name" required maxLength={200} className={`${field} mt-1 w-full`} />
        </label>
        <label className="block">
          <span className="metric-label">Email</span>
          <input name="email" type="email" required className={`${field} mt-1 w-full`} />
        </label>
        <label className="block">
          <span className="metric-label">Phone</span>
          <input name="phone" maxLength={40} className={`${field} mt-1 w-full`} />
        </label>
        <label className="block">
          <span className="metric-label">Country</span>
          <input name="country" maxLength={2} minLength={2} placeholder="GB"
            className={`${field} mt-1 w-full uppercase`} />
        </label>
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      <div className="border-t border-pebble pt-4 dark:border-white/10">
        <button className={btn} disabled={busy}>{busy ? 'Creating…' : 'Create client'}</button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------- client detail

// ----------------------------------------------------------------- bits

// Verification, in the plan's chips: green verified, amber pending, red refused, grey otherwise.
const BADGE: Record<string, [string, string]> = {
  approved: ['', 'Verified'],
  pending: ['is-warn', 'Pending KYC'],
  rejected: ['is-bad', 'Rejected'],
  expired: ['is-warn', 'Expired'],
  none: ['is-muted', 'Not started'],
};
const Badge = ({ value }: { value: string }) => {
  const [cls, label] = BADGE[value] ?? ['is-muted', value];
  return <span className={`x-badge ${cls}`}>{label}</span>;
};
