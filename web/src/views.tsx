import { useState, type FormEvent } from 'react';
import { btn, card, input } from './App.tsx';
import { FlagList, KycPanel } from './compliance.tsx';
import { CreditForm } from './wallet.tsx';
import { ClientPortfolios } from './portfolio.tsx';
import { api, useApi, type Activity, type Client, type ClientRow, type Stage, type Staff, type Task } from './api.ts';

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

export function ClientDetail({ id, me }: { id: string; me: { sub: string; role?: string } | null }) {
  const client = useApi<Client>(`/clients/${id}`);
  const timeline = useApi<Activity[]>(`/clients/${id}/timeline`);
  const tasks = useApi<Task[]>(`/tasks${qs({ client_id: id, scope: 'all' })}`);
  const stages = useApi<Stage[]>('/pipeline-stages');
  const staff = useApi<Staff[]>('/staff');
  const flags = useApi<any[]>(`/flags?status=open&client_id=${id}`);

  async function patch(body: Record<string, unknown>) {
    await api(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    client.reload();
    timeline.reload();
  }

  if (client.error) return <p role="alert" className="text-sm text-red-600">{client.error}</p>;
  if (!client.data) return <p className="text-sm text-slate-500">Loading…</p>;
  const c = client.data;

  return (
    <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[20rem_1fr]">
      <div className="space-y-4">
        <div className={`${card} space-y-3`}>
          <div>
            <h1 className="text-lg font-semibold">{c.name}</h1>
            <p className="text-sm text-slate-500">{c.email}</p>
            <p className="text-sm text-slate-500">{c.phone ?? '—'} · {c.country ?? '—'}</p>
          </div>
          <Field label="Stage">
            <select className={input} value={c.stage_id}
              onChange={(e) => patch({ stage_id: Number(e.target.value) })}>
              {stages.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Owner">
            <select className={input} value={c.owner_staff_id ?? ''}
              onChange={(e) => patch({ owner_staff_id: e.target.value || null })}>
              <option value="">Unassigned</option>
              {staff.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Risk profile">
            <select className={input} value={c.risk_profile ?? ''}
              onChange={(e) => patch({ risk_profile: e.target.value })}>
              <option value="" disabled>Not set</option>
              {['low', 'medium', 'high'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="KYC"><Badge value={c.kyc_status} /></Field>
        </div>

        {me?.role === 'admin' && <CreditForm clientId={id} onDone={timeline.reload} />}

        <ClientPortfolios clientId={id} />

        <KycPanel clientId={id} canUpload />

        <div className={`${card} space-y-2`}>
          <h2 className="text-sm font-semibold">Tasks</h2>
          {tasks.data?.map((t) => (
            <label key={t.id} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={t.status === 'done'}
                onChange={async () => {
                  await api(`/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
                  tasks.reload();
                  timeline.reload();
                }} />
              <span>
                {t.title}
                <span className="block text-xs text-slate-500">
                  {t.assignee_name}{t.due_at ? ` · due ${when(t.due_at)}` : ''}
                </span>
              </span>
            </label>
          ))}
          {tasks.data?.length === 0 && <p className="text-sm text-slate-500">No open tasks.</p>}
          <NewTask clientId={id} defaultAssignee={me?.sub} staff={staff.data ?? []}
            onDone={() => { tasks.reload(); timeline.reload(); }} />
        </div>
      </div>

      <div className="space-y-4">
        {(flags.data?.length ?? 0) > 0 && (
          <FlagList rows={flags.data ?? []} review={false} onDone={flags.reload} />
        )}
        <div className={`${card} space-y-4`}>
        <h2 className="text-sm font-semibold">Activity</h2>
        <NoteBox clientId={id} onDone={timeline.reload} />
        <MessageBox clientId={id} onDone={timeline.reload} />
        <ol className="space-y-3">
          {timeline.data?.map((a) => (
            <li key={a.id} className="border-l-2 border-slate-200 pl-3 dark:border-slate-700">
              <p className="text-sm">{a.summary}</p>
              <p className="text-xs text-slate-500">{a.kind} · {when(a.at)}</p>
            </li>
          ))}
        </ol>
        {timeline.data?.length === 0 && <p className="text-sm text-slate-500">Nothing yet.</p>}
        </div>
      </div>
    </div>
  );
}

/** A note is internal; a message goes to the client's notifications. */
function MessageBox({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <form className="flex gap-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        await api(`/clients/${clientId}/notify`, { method: 'POST', body: JSON.stringify({ title }) });
        setTitle('');
        setSent(true);
        setTimeout(() => setSent(false), 3000);
        onDone();
      } finally { setBusy(false); }
    }}>
      <input className={input} required maxLength={120} placeholder="Message the client…"
        value={title} onChange={(e) => setTitle(e.target.value)} />
      <button className={btn} disabled={busy || !title.trim()}>{sent ? 'Sent' : 'Send'}</button>
    </form>
  );
}

function NoteBox({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="flex gap-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        await api(`/clients/${clientId}/notes`, { method: 'POST', body: JSON.stringify({ text }) });
        setText('');
        onDone();
      } finally { setBusy(false); }
    }}>
      <input className={input} required maxLength={4000} placeholder="Add a note…"
        value={text} onChange={(e) => setText(e.target.value)} />
      <button className={btn} disabled={busy || !text.trim()}>Add</button>
    </form>
  );
}

function NewTask(
  { clientId, defaultAssignee, staff, onDone }:
  { clientId: string; defaultAssignee?: string; staff: Staff[]; onDone: () => void },
) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="text-sm text-slate-500 hover:text-slate-900"
    onClick={() => setOpen(true)}>+ Add task</button>;

  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      await api('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          client_id: clientId,
          assigned_to: f.get('assigned_to'),
          title: f.get('title'),
          ...(f.get('due_at') ? { due_at: f.get('due_at') } : {}),
        }),
      });
      setOpen(false);
      onDone();
    }}>
      <input name="title" required maxLength={200} placeholder="Follow up call" className={input} />
      <select name="assigned_to" required defaultValue={defaultAssignee} className={input}>
        {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <input name="due_at" type="datetime-local" className={input} />
      <button className={btn}>Create task</button>
    </form>
  );
}

// --------------------------------------------------------------- my tasks

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

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block text-xs text-slate-500">{label}{children}</label>
);

const BADGE: Record<string, string> = {
  approved: 'bg-green-100 text-green-800',
  pending: 'bg-amber-100 text-amber-800',
  rejected: 'bg-red-100 text-red-800',
  expired: 'bg-red-100 text-red-800',
};
const Badge = ({ value }: { value: string }) => (
  <span className={`rounded px-2 py-0.5 text-xs ${BADGE[value] ?? 'bg-slate-100 text-slate-600'}`}>{value}</span>
);
