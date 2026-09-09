import { useState, type FormEvent } from 'react';
import { alertBox, btn, card, input, mono, tableCard, thead } from './App.tsx';
import { api, useApi, type Stage, type Task } from './api.ts';
import { ClientRow } from './client-row.tsx';

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
  const [openId, setOpenId] = useState<string | null>(null);
  // Downloading a document needs kyc:review, so the row only offers it to those who have it.
  const { data: me } = useApi<{ role: string }>("/me");
  const stages = useApi<Stage[]>('/pipeline-stages');
  const clients = useApi<Parameters<typeof ClientRow>[0]["c"][]>(`/clients${qs({ q, stage_id: stage })}`);

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

      {clients.error && <p role="alert" className={`${alertBox} `}>{clients.error}</p>}
      <div className={`${tableCard} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>{['Name', 'Email', 'Stage', 'KYC', 'Owner', 'Created'].map((h) =>
              <th key={h} className="px-4 py-2">{h}</th>)}</tr>
          </thead>
          <tbody>
            {clients.data?.map((c) => (
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
        {clients.data?.length === 0 && <p className="px-4 py-6 text-sm text-slate-ink">No clients match.</p>}
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
      <label className="text-xs text-slate-ink">Name
        <input name="name" required maxLength={200} className={input} /></label>
      <label className="text-xs text-slate-ink">Email
        <input name="email" type="email" required className={input} /></label>
      <label className="text-xs text-slate-ink">Phone
        <input name="phone" maxLength={40} className={input} /></label>
      <label className="text-xs text-slate-ink">Country
        <input name="country" maxLength={2} minLength={2} placeholder="GB" className={input} /></label>
      <button className={btn} disabled={busy}>Create</button>
      {error && <p role="alert" className={`${alertBox} w-full `}>{error}</p>}
    </form>
  );
}

// ----------------------------------------------------------- client detail

// ----------------------------------------------------------------- bits

const BADGE: Record<string, string> = {
  approved: 'bg-pebble text-obsidian dark:bg-white/10 dark:text-vellum',
  pending: 'bg-ember text-graphite',
  rejected: 'bg-bone text-slate-ink dark:bg-white/5 dark:text-mist',
  expired: 'bg-ember text-graphite',
};
const Badge = ({ value }: { value: string }) => (
  <span className={`rounded-full px-2 py-0.5 text-xs ${BADGE[value] ?? 'bg-bone text-slate-ink'}`}>{value}</span>
);
