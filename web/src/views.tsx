import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Clock, Download, Plus, Search, UserCheck, UserX, Users, UsersRound } from 'lucide-react';
import { alertBox, btn, card, field, input, mono, PageTitle, tableCard, thead } from './App.tsx';
import { api, token, useApi, type Stage, type Task } from './api.ts';
import { ClientRow } from './client-row.tsx';
import { CopyButton } from './copy.tsx';

const when = (iso: string) => new Date(iso).toLocaleString();
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString() ? `?${p}` : '';
};

// ------------------------------------------------------------- client list


type ListRow = Parameters<typeof ClientRow>[0]['c'] & { total_count?: number; assets_usd?: number; assets_unpriced?: boolean };
type Summary = {
  total: number; active: number; inactive: number; pending_kyc: number; verified: number; unassigned: number; new_week: number;
  team: { id: string; name: string; role: string; clients: number; pending_kyc: number; new_week: number; no_login: number }[];
};
type View = 'all' | 'mine' | 'unassigned' | 'pending' | 'nologin' | 'new';
type Sort = 'joined' | 'name' | 'stage' | 'status' | 'manager';
type Saved = { view: View; stage: string; kyc: string; owner: string; sort: Sort; dir: 'asc' | 'desc'; size: number; compact: boolean; team: boolean };
const SAVED_KEY = 'crm.clients.view';
const DEFAULTS: Saved = { view: 'all', stage: '', kyc: '', owner: '', sort: 'joined', dir: 'desc', size: 50, compact: false, team: true };
const loadSaved = (): Saved => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SAVED_KEY) ?? '{}') }; } catch { return DEFAULTS; }
};
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

/**
 * The client book, built for a desk of any size.
 *
 * Saved views a manager works from (mine, the unassigned queue, verification waiting, no
 * login, this week's arrivals), the team's spread of the book beside it, every column
 * sortable, true paging with the true total, and bulk hand-offs and stage moves for the
 * rows ticked. Each person's view, filters and sort are remembered on their own device.
 */
export function ClientList() {
  const [saved, setSaved] = useState<Saved>(loadSaved);
  const set = (patch: Partial<Saved>) => setSaved((s) => {
    const next = { ...s, ...patch };
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(next)); } catch { /* private window */ }
    return next;
  });
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); setPicked(new Set()); }, [saved.view, saved.stage, saved.kyc, saved.owner, saved.sort, saved.dir, saved.size, query]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: me } = useApi<{ role: string; sub: string }>('/me');
  const stages = useApi<Stage[]>('/pipeline-stages');
  const staff = useApi<{ id: string; name: string }[]>('/staff');
  const summary = useApi<Summary>('/clients/summary');

  const view = saved.view;
  const params = {
    q: query, stage_id: saved.stage, kyc_status: view === 'pending' ? 'pending' : saved.kyc,
    owner_staff_id: view === 'mine' ? me?.sub : saved.owner,
    unassigned: view === 'unassigned' ? '1' : undefined,
    has_login: view === 'nologin' ? 'false' : undefined,
    new_days: view === 'new' ? 7 : undefined,
    sort: saved.sort, dir: saved.dir, limit: saved.size, offset: page * saved.size, with_value: '1',
  };
  const clients = useApi<ListRow[]>(view === 'mine' && !me ? null : `/clients${qs(params)}`);
  const rows = clients.data ?? [];
  const total = rows[0]?.total_count ?? 0;
  const pages = Math.max(1, Math.ceil(total / saved.size));
  const filtered = !!(query || saved.stage || saved.kyc || saved.owner);
  const admin = me?.role === 'admin';
  const canWrite = me?.role === 'sales' || me?.role === 'support' || me?.role === 'admin';
  const s = summary.data;
  const mine = s?.team.find((t) => t.id === me?.sub)?.clients;

  const reload = () => { clients.reload(); summary.reload(); };
  const clear = () => { setQ(''); set({ stage: '', kyc: '', owner: '' }); };
  const sortBy = (col: Sort) => set(saved.sort === col ? { dir: saved.dir === 'asc' ? 'desc' : 'asc' } : { sort: col, dir: col === 'joined' ? 'desc' : 'asc' });
  const allOnPage = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const togglePage = () => setPicked((p) => {
    const next = new Set(p);
    if (allOnPage) rows.forEach((r) => next.delete(r.id)); else rows.forEach((r) => next.add(r.id));
    return next;
  });
  const pick = (id: string, on: boolean) => setPicked((p) => { const next = new Set(p); if (on) next.add(id); else next.delete(id); return next; });

  async function bulk(change: { owner_staff_id?: string | null; stage_id?: number }, what: string) {
    setBusy(true); setNotice(null);
    try {
      const r = await api<{ updated: number }>('/clients/bulk', { method: 'POST', body: JSON.stringify({ ids: [...picked], ...change }) });
      setNotice(`${r.updated} client${r.updated === 1 ? '' : 's'} ${what}.`);
      setPicked(new Set());
      reload();
    } catch (err) { setNotice((err as Error).message); } finally { setBusy(false); }
  }
  async function exportCsv() {
    const r = await fetch(`/api/clients/export.csv${qs({ ...params, limit: undefined, offset: undefined, with_value: undefined })}`, { headers: { authorization: `Bearer ${token.get()}` } });
    if (!r.ok) { setNotice('Export failed.'); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const VIEWS: [View, string, number | undefined][] = [
    ['all', 'All clients', s?.total], ['mine', 'My clients', mine], ['unassigned', 'Unassigned', s?.unassigned],
    ['pending', 'Pending KYC', s?.pending_kyc], ['nologin', 'No login', s?.inactive], ['new', 'New this week', s?.new_week],
  ];
  const head = (label: string, col?: Sort, cls = '') => (
    <th className={`px-3 py-2.5 text-left ${cls}`} aria-sort={col && saved.sort === col ? (saved.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {col ? (
        <button type="button" onClick={() => sortBy(col)} className={`inline-flex items-center gap-1 ${saved.sort === col ? 'text-vellum' : ''}`}>
          {label}{saved.sort === col ? (saved.dir === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />) : <ArrowUpDown size={12} className="opacity-40" aria-hidden />}
        </button>
      ) : label}
    </th>
  );
  const maxTeam = Math.max(1, ...(s?.team.map((t) => t.clients) ?? [1]));

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Clients</PageTitle>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => set({ team: !saved.team })} className={`x-btn-sm flex items-center gap-1.5 ${saved.team ? 'is-on' : ''}`}>
            <UsersRound size={14} aria-hidden />Team
          </button>
          {admin && <button type="button" onClick={exportCsv} className="x-btn-sm flex items-center gap-1.5"><Download size={14} aria-hidden />Export CSV</button>}
          <button className={`${btn} flex items-center gap-1.5`} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : <><Plus size={16} aria-hidden />Add Client</>}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {([
          ['Total Clients', s?.total, Users, '', `${s?.new_week ?? 0} new this week`, 'all'],
          ['Active', s?.active, UserCheck, 'text-up', 'Can sign in', 'all'],
          ['Pending KYC', s?.pending_kyc, Clock, s?.pending_kyc ? 'text-ember-ink' : '', 'Awaiting verification', 'pending'],
          ['Unassigned', s?.unassigned, UserX, s?.unassigned ? 'text-ember-ink' : '', 'No manager yet', 'unassigned'],
        ] as const).map(([label, value, Icon, tone, note, v]) => (
          <button key={label} type="button" onClick={() => set({ view: v as View })} className="x-card tile lift p-4 text-left">
            <div className="flex items-center justify-between"><span className="text-[13px] text-mist">{label}</span><Icon size={16} className="text-mist" aria-hidden /></div>
            <p className={`mt-2 text-[26px] leading-none font-bold tabular-nums ${tone}`}>{value ?? '—'}</p>
            <p className="mt-2 text-xs text-slate-ink">{note}</p>
          </button>
        ))}
      </div>

      <div className={`grid gap-4 ${saved.team ? 'xl:grid-cols-[minmax(0,1fr)_270px]' : ''}`}>
        <div className="min-w-0 space-y-3">
          {/* Saved views */}
          <div role="tablist" aria-label="Views" className="flex flex-wrap gap-1.5">
            {VIEWS.map(([v, label, n]) => (
              <button key={v} role="tab" aria-selected={view === v} onClick={() => set({ view: v })} className={`x-view ${view === v ? 'is-on' : ''}`}>
                {label}{n !== undefined && <span className="x-view-n">{n}</span>}
              </button>
            ))}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="x-search min-w-56 flex-1">
              <Search size={15} aria-hidden className="text-mist" />
              <span className="sr-only">Search clients</span>
              <input placeholder="Search name, email, phone or account number…" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <select className={`${field} w-36`} value={saved.stage} onChange={(e) => set({ stage: e.target.value })} aria-label="Stage">
              <option value="">All stages</option>
              {stages.data?.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
            </select>
            {view !== 'pending' && (
              <select className={`${field} w-36`} value={saved.kyc} onChange={(e) => set({ kyc: e.target.value })} aria-label="Verification">
                <option value="">All statuses</option>
                {[['none', 'Not started'], ['pending', 'Pending KYC'], ['approved', 'Verified'], ['rejected', 'Rejected'], ['expired', 'Expired']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            )}
            {view !== 'mine' && view !== 'unassigned' && (
              <select className={`${field} w-40`} value={saved.owner} onChange={(e) => set({ owner: e.target.value })} aria-label="Manager">
                <option value="">All managers</option>
                {staff.data?.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
            )}
            {filtered && <button onClick={clear} className="x-btn-sm">Clear</button>}
            <button type="button" onClick={() => set({ compact: !saved.compact })} className={`x-btn-sm ${saved.compact ? 'is-on' : ''}`} title="Row density">
              {saved.compact ? 'Compact' : 'Comfortable'}
            </button>
          </div>

          {/* Bulk actions for the rows ticked */}
          {picked.size > 0 && (
            <div className="x-bulk" role="region" aria-label="Bulk actions">
              <span className="font-semibold">{picked.size} selected</span>
              {canWrite && (
                <select className={`${field} w-48`} defaultValue="" disabled={busy}
                  onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) void bulk({ owner_staff_id: v === 'none' ? null : v }, v === 'none' ? 'returned to the pool' : 'reassigned'); }}>
                  <option value="" disabled>Assign to…</option>
                  <option value="none">Nobody (unassign)</option>
                  {staff.data?.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </select>
              )}
              {canWrite && (
                <select className={`${field} w-44`} defaultValue="" disabled={busy}
                  onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) void bulk({ stage_id: Number(v) }, 'moved'); }}>
                  <option value="" disabled>Move to stage…</option>
                  {stages.data?.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </select>
              )}
              <CopyButton className="px-2.5 py-1 text-xs normal-case" text={rows.filter((r) => picked.has(r.id)).map((r) => r.email).join(', ')}
                label="Copy emails" done="Copied" title="Copy the selected clients' email addresses" />
              <button type="button" onClick={() => setPicked(new Set())} className="ml-auto text-xs text-mist hover:text-vellum">Clear selection</button>
            </div>
          )}
          {notice && <p role="status" className="text-xs text-up">{notice}</p>}

          {adding && <NewClient onDone={() => { setAdding(false); reload(); }} />}
          {clients.error && <p role="alert" className={alertBox}>{clients.error}</p>}

          <div className={`${tableCard} overflow-x-auto ${saved.compact ? 'is-compact' : ''}`}>
            <table className="w-full min-w-[900px] text-sm">
              <thead className={thead}>
                <tr>
                  <th className="w-10 px-3 py-2.5"><input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select every client on this page" /></th>
                  {head('Client', 'name')}{head('Email')}{head('Stage', 'stage')}{head('Status', 'status')}{head('Manager', 'manager')}
                  {head('Assets', undefined, 'text-right')}{head('Joined', 'joined')}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <ClientRow key={c.id} c={c} open={openId === c.id}
                    onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                    onChanged={reload}
                    badge={(v) => <Badge value={v} />}
                    selected={picked.has(c.id)} onSelect={(on) => pick(c.id, on)}
                    assets={c.assets_usd ?? null}
                    canReviewKyc={me?.role === 'compliance' || me?.role === 'admin'}
                    canResetPassword={me?.role === 'admin'}
                    canMoveFunds={me?.role === 'admin'}
                    canWrite={canWrite}
                    stages={stages.data ?? []} />
                ))}
              </tbody>
            </table>
            {clients.data && rows.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-slate-ink">{filtered || view !== 'all' ? 'Nobody matches that.' : 'No clients yet.'}</p>
            )}
            {!clients.data && <p className="px-4 py-8 text-center text-sm text-slate-ink">Loading…</p>}
          </div>

          {/* Paging */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-ink">
            <span>{total ? `Showing ${page * saved.size + 1}–${Math.min(total, (page + 1) * saved.size)} of ${total.toLocaleString('en-US')}` : 'No clients'}</span>
            <label className="flex items-center gap-1.5">Rows
              <select className={`${field} w-20 py-1`} value={saved.size} onChange={(e) => set({ size: Number(e.target.value) })}>
                {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span className="ml-auto flex items-center gap-1.5">
              <button type="button" className="x-btn-sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft size={14} aria-hidden /></button>
              <span className="tabular-nums">Page {page + 1} of {pages}</span>
              <button type="button" className="x-btn-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} aria-hidden /></button>
            </span>
          </div>
        </div>

        {/* The team: how the book is spread, and a click away from each person's clients. */}
        {saved.team && (
          <aside className="x-card h-fit p-4">
            <div className="flex items-baseline justify-between"><h2 className="x-h">Team</h2><span className="text-xs text-mist">{s?.team.length ?? 0} people</span></div>
            <p className="mt-1 text-xs text-slate-ink">Clients per manager. Click to see their book.</p>
            <ul className="mt-3 space-y-1">
              {s?.team.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => set({ view: 'all', owner: saved.owner === t.id ? '' : t.id })}
                    className={`x-team-row ${saved.owner === t.id && view === 'all' ? 'is-on' : ''}`}>
                    <span className="x-avatar x-avatar-sm" aria-hidden>{t.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className="flex items-baseline justify-between gap-2"><span className="truncate font-medium">{t.name}</span><span className="tabular-nums font-semibold">{t.clients}</span></span>
                      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-white/10"><span className="block h-full rounded-full bg-ember" style={{ width: `${(t.clients / maxTeam) * 100}%` }} /></span>
                      <span className="mt-1 flex gap-3 text-[11px] text-mist">
                        <span className={t.pending_kyc ? 'text-ember-ink' : ''}>{t.pending_kyc} KYC</span>
                        <span>{t.new_week} new</span>
                        <span>{t.no_login} no login</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {s && s.unassigned > 0 && (
                <li>
                  <button type="button" onClick={() => set({ view: 'unassigned' })} className={`x-team-row ${view === 'unassigned' ? 'is-on' : ''}`}>
                    <span className="x-avatar x-avatar-sm opacity-60" aria-hidden>—</span>
                    <span className="flex flex-1 items-baseline justify-between"><span className="font-medium">Unassigned</span><span className="font-semibold text-ember-ink tabular-nums">{s.unassigned}</span></span>
                  </button>
                </li>
              )}
            </ul>
          </aside>
        )}
      </div>
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
