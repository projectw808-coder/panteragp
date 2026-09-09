import { useState, type FormEvent } from 'react';
import { btn, card, input } from './App.tsx';
import { api, useApi, type ClientRow, type Stage, type Task } from './api.ts';

const when = (iso: string) => new Date(iso).toLocaleString();
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString() ? `?${p}` : '';
};

// ------------------------------------------------------------- client list

export function ClientList() {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [adding, setAdding] = useState(false);
  const stages = useApi<Stage[]>('/pipeline-stages');
  const clients = useApi<ClientRow[]>(`/clients${qs({ q, stage_id: stage })}`);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input className={`${input} max-w-xs`} placeholder="Search name or email"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${input} max-w-40`} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages</option>
          {stages.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className={`${btn} ml-auto`} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New client'}
        </button>
      </div>

      {adding && <NewClient onDone={() => { setAdding(false); clients.reload(); }} />}

      {clients.error && <p role="alert" className="text-sm text-red-600">{clients.error}</p>}
      <div className={`${card} p-0 overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-700">
            <tr>{['Name', 'Email', 'Stage', 'KYC', 'Owner', 'Created'].map((h) =>
              <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {clients.data?.map((c) => (
              <tr key={c.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800">
                <td className="px-4 py-2">
                  <a className="font-medium hover:underline" href={`#/clients/${c.id}`}>{c.name}</a>
                </td>
                <td className="px-4 py-2 text-slate-500">{c.email}</td>
                <td className="px-4 py-2">{c.stage}</td>
                <td className="px-4 py-2"><Badge value={c.kyc_status} /></td>
                <td className="px-4 py-2 text-slate-500">{c.owner_name ?? '—'}</td>
                <td className="px-4 py-2 text-slate-500">{when(c.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {clients.data?.length === 0 && <p className="px-4 py-6 text-sm text-slate-500">No clients match.</p>}
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
    <form onSubmit={submit} className={`${card} flex flex-wrap items-end gap-3`}>
      <label className="text-xs text-slate-500">Name
        <input name="name" required maxLength={200} className={input} /></label>
      <label className="text-xs text-slate-500">Email
        <input name="email" type="email" required className={input} /></label>
      <label className="text-xs text-slate-500">Phone
        <input name="phone" maxLength={40} className={input} /></label>
      <label className="text-xs text-slate-500">Country
        <input name="country" maxLength={2} minLength={2} placeholder="GB" className={input} /></label>
      <button className={btn} disabled={busy}>Create</button>
      {error && <p role="alert" className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}

// ----------------------------------------------------------- client detail

export function TaskList() {
  const tasks = useApi<Task[]>('/tasks');
  return (
    <div className={`${card} mx-auto max-w-3xl space-y-2`}>
      <h1 className="text-sm font-semibold">My open tasks</h1>
      {tasks.data?.map((t) => (
        <div key={t.id} className="flex items-center gap-3 border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
          <input type="checkbox" onChange={async () => {
            await api(`/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
            tasks.reload();
          }} />
          <div className="text-sm">
            {t.title}
            <a className="block text-xs text-slate-500 hover:underline" href={`#/clients/${t.client_id}`}>
              {t.client_name}{t.due_at ? ` · due ${when(t.due_at)}` : ''}
            </a>
          </div>
        </div>
      ))}
      {tasks.data?.length === 0 && <p className="text-sm text-slate-500">Nothing open.</p>}
    </div>
  );
}

// ----------------------------------------------------------------- bits

const BADGE: Record<string, string> = {
  approved: 'bg-green-100 text-green-800',
  pending: 'bg-amber-100 text-amber-800',
  rejected: 'bg-red-100 text-red-800',
  expired: 'bg-red-100 text-red-800',
};
const Badge = ({ value }: { value: string }) => (
  <span className={`rounded px-2 py-0.5 text-xs ${BADGE[value] ?? 'bg-slate-100 text-slate-600'}`}>{value}</span>
);
