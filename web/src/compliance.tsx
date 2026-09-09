import { useRef, useState } from 'react';
import { btn, card, field, input } from './App.tsx';
import { api, token, useApi } from './api.ts';

type PendingDoc = {
  id: number; client_id: string; kind: string; uploaded_at: string;
  client_name: string; country: string | null; kyc_status: string;
};
type Doc = {
  id: number; kind: string; status: string; note: string | null;
  uploaded_at: string; reviewed_at: string | null; reviewed_by: string | null;
};
type Flag = {
  id: number; client_id: string; client_name: string; rule: string;
  severity: 'low' | 'medium' | 'high'; details: Record<string, unknown>; raised_at: string;
};
type Cash = { id: number; kind: string; amount: number; status: string; created_at: string };

const when = (iso: string) => new Date(iso).toLocaleString();
const pretty = (s: string) => s.replace(/_/g, ' ');

const SEVERITY: Record<string, string> = {
  high: 'bg-ember text-graphite',
  medium: 'bg-pebble text-obsidian dark:bg-white/10 dark:text-vellum',
  low: 'bg-bone text-obsidian dark:bg-white/10 dark:text-mist',
};
const STATUS: Record<string, string> = {
  approved: 'text-slate-ink', rejected: 'text-ember', pending: 'text-ember',
};

/** Documents are behind auth, so fetch as a blob and hand the viewer an object URL. */
async function openDocument(id: number) {
  const res = await fetch(`/api/kyc/${id}/file`, { headers: { authorization: `Bearer ${token.get()}` } });
  if (!res.ok) return alert('Could not open document');
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// --------------------------------------------------------------- KYC queue

export function ComplianceView({ role }: { role?: string }) {
  const [tab, setTab] = useState<'kyc' | 'flags'>('kyc');
  const queue = useApi<PendingDoc[]>('/kyc/pending');
  const flags = useApi<Flag[]>('/flags?status=open');
  const review = role === 'compliance' || role === 'admin';

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex gap-1 text-xs">
        {(['kyc', 'flags'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t}
            className={`rounded-md px-3 py-1 ${tab === t
              ? 'bg-onyx text-vellum dark:bg-pebble dark:text-obsidian'
              : 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'}`}>
            {t === 'kyc' ? `KYC queue (${queue.data?.length ?? 0})` : `Open flags (${flags.data?.length ?? 0})`}
          </button>
        ))}
      </div>

      {tab === 'kyc' ? (
        <div className={`${card} space-y-3`}>
          {queue.data?.length === 0 && <p className="text-sm text-slate-ink">Nothing waiting for review.</p>}
          {queue.data?.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 border-b border-pebble pb-3 last:border-0 dark:border-white/10">
              <div className="min-w-48">
                <a className="text-sm font-medium hover:underline" href={`#/clients/${d.client_id}`}>{d.client_name}</a>
                <p className="text-xs text-slate-ink">{pretty(d.kind)} · {when(d.uploaded_at)}</p>
              </div>
              <button onClick={() => openDocument(d.id)} className="text-xs text-slate-ink underline hover:text-obsidian dark:hover:text-vellum">
                view document
              </button>
              {review && <Decide id={d.id} onDone={() => { queue.reload(); flags.reload(); }} />}
            </div>
          ))}
        </div>
      ) : (
        <FlagList rows={flags.data ?? []} review={review} onDone={flags.reload} showClient />
      )}
    </div>
  );
}

function Decide({ id, onDone }: { id: number; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (status: 'approved' | 'rejected') => {
    setBusy(true);
    try {
      await api(`/kyc/${id}/review`, { method: 'POST', body: JSON.stringify({ status, note: note || undefined }) });
      onDone();
    } finally { setBusy(false); }
  };
  return (
    <div className="ml-auto flex items-center gap-2">
      <input className={`${field} w-48 py-1`} placeholder="Note (optional)"
        value={note} onChange={(e) => setNote(e.target.value)} />
      {/* Approving is the primary action here, so it takes the ember fill; rejecting is
          the secondary one and takes the neutral. Neither is red or green. */}
      <button disabled={busy} onClick={() => send('approved')}
        className="rounded-md bg-ember px-3 py-1 font-mono text-xs font-medium text-graphite disabled:opacity-50">approve</button>
      <button disabled={busy} onClick={() => send('rejected')}
        className="rounded-md border border-pebble bg-bone px-3 py-1 font-mono text-xs font-medium text-obsidian hover:bg-pebble disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:text-vellum">reject</button>
    </div>
  );
}

// ------------------------------------------------------------------- flags

export function FlagList({ rows, review, onDone, showClient = false }: {
  rows: Flag[]; review: boolean; onDone: () => void; showClient?: boolean;
}) {
  const decide = async (id: number, status: 'cleared' | 'escalated') => {
    await api(`/flags/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    onDone();
  };
  if (!rows.length) return <div className={`${card} text-sm text-slate-ink`}>No open flags.</div>;
  return (
    <div className={`${card} space-y-3`}>
      {rows.map((f) => (
        <div key={f.id} className="flex flex-wrap items-center gap-3 border-b border-pebble pb-3 last:border-0 dark:border-white/10">
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${SEVERITY[f.severity]}`}>{f.severity}</span>
          <div>
            <p className="text-sm font-medium">{pretty(f.rule)}</p>
            <p className="text-xs text-slate-ink">
              {showClient && <a className="hover:underline" href={`#/clients/${f.client_id}`}>{f.client_name} · </a>}
              {when(f.raised_at)} · {Object.entries(f.details).map(([k, v]) => `${pretty(k)} ${v}`).join(', ')}
            </p>
          </div>
          {review && (
            <div className="ml-auto flex gap-2 text-xs">
              <button onClick={() => decide(f.id, 'cleared')} className="text-slate-ink hover:text-slate-ink">clear</button>
              <button onClick={() => decide(f.id, 'escalated')} className="text-slate-ink hover:text-ember">escalate</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- reports

const REPORTS = [
  { name: 'clients', title: 'Client report', blurb: 'Lifetime value, volume, deposits and withdrawals per client.' },
  { name: 'team', title: 'Team report', blurb: 'Pipeline throughput, KYC conversion and time to first contact per staff member.' },
] as const;

export function ReportsView() {
  const [open, setOpen] = useState<string>('clients');
  const rows = useApi<Record<string, unknown>[]>(`/reports/${open}`);

  // The CSV endpoint needs the auth header, so fetch it and save the blob.
  const download = async (name: string) => {
    const res = await fetch(`/api/reports/${name}.csv`, { headers: { authorization: `Bearer ${token.get()}` } });
    if (!res.ok) return alert('Export failed');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const cols = rows.data?.[0] ? Object.keys(rows.data[0]) : [];
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap gap-2">
        {REPORTS.map((r) => (
          <button key={r.name} onClick={() => setOpen(r.name)} aria-pressed={open === r.name}
            className={`rounded-md px-3 py-1 text-xs ${open === r.name
              ? 'bg-onyx text-vellum dark:bg-pebble dark:text-obsidian'
              : 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'}`}>
            {r.title}
          </button>
        ))}
        <button className={`${btn} ml-auto`} onClick={() => download(open)}>Export CSV</button>
        <button className={btn} onClick={() => window.print()}>Print / PDF</button>
      </div>
      <p className="text-sm text-slate-ink">{REPORTS.find((r) => r.name === open)?.blurb}</p>

      <div className={`${card} overflow-x-auto p-0`}>
        <table className="w-full text-sm">
          <thead className="border-b border-pebble text-left text-slate-ink dark:border-white/10">
            <tr>{cols.map((c) => <th key={c} className="px-3 py-2 font-medium">{pretty(c)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.data?.map((r, i) => (
              <tr key={i} className="border-b border-pebble last:border-0 dark:border-white/10">
                {cols.map((c) => (
                  <td key={c} className={`px-3 py-1.5 ${typeof r[c] === 'number' ? 'tabular-nums' : ''}`}>
                    {r[c] === null ? '—' : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.data?.length === 0 && <p className="p-4 text-sm text-slate-ink">No rows.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------- panels used on other screens

/** KYC documents for one client, with upload. Shown on the client record and to traders. */
export function KycPanel({ clientId, canUpload }: { clientId: string; canUpload: boolean }) {
  const docs = useApi<Doc[]>(`/clients/${clientId}/kyc`);
  const [kind, setKind] = useState('id_front');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', file);
    const res = await fetch(`/api/clients/${clientId}/kyc`, {
      method: 'POST', headers: { authorization: `Bearer ${token.get()}` }, body: form,
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json().catch(() => null))?.error ?? 'Upload failed');
    if (fileRef.current) fileRef.current.value = '';
    docs.reload();
  }

  return (
    <div className={`${card} space-y-2`}>
      <h2 className="text-sm font-semibold">KYC documents</h2>
      {docs.data?.map((d) => (
        <div key={d.id} className="flex items-center gap-2 text-sm">
          <span className="flex-1">{pretty(d.kind)}</span>
          <span className={STATUS[d.status] ?? ''}>{d.status}</span>
          {d.note && <span className="text-xs text-slate-ink" title={d.note}>note</span>}
        </div>
      ))}
      {docs.data?.length === 0 && <p className="text-sm text-slate-ink">Nothing uploaded yet.</p>}

      {canUpload && (
        <div className="space-y-2 border-t border-pebble pt-2 dark:border-white/10">
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
            {['id_front', 'id_back', 'proof_of_address', 'selfie'].map((k) =>
              <option key={k} value={k}>{pretty(k)}</option>)}
          </select>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,application/pdf"
            className="block w-full text-xs text-slate-ink" />
          <p className="text-xs text-slate-ink">JPEG, PNG or PDF, up to 10 MB.</p>
          {error && <p role="alert" className="text-sm text-ember">{error}</p>}
          <button onClick={upload} disabled={busy} className={`${btn} w-full`}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Deposits and withdrawals for the signed-in trader. */
export function FundingPanel() {
  const history = useApi<Cash[]>('/cash');
  const [kind, setKind] = useState<'deposit' | 'withdrawal'>('deposit');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [raised, setRaised] = useState<string[]>([]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ flags: { rule: string }[] }>('/cash', {
        method: 'POST', body: JSON.stringify({ kind, amount: Number(amount) }),
      });
      setRaised(r.flags.map((f) => f.rule));
      setAmount('');
      history.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <select className={`${field} w-36`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="deposit">Deposit</option>
          <option value="withdrawal">Withdrawal</option>
        </select>
        <input className={`${field} w-40`} type="number" step="any" min="0" required placeholder="Amount"
          value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button className={btn}>Request</button>
      </form>
      <p className="text-xs text-slate-ink">
        A withdrawal leaves your balance immediately and is returned if it is rejected.
        A deposit is credited once it has been approved.
      </p>
      {error && <p role="alert" className="text-sm text-ember">{error}</p>}
      {raised.length > 0 && (
        <p className="text-sm text-ember dark:text-ember">
          Submitted for review — compliance was notified ({raised.map(pretty).join(', ')}).
        </p>
      )}

      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-ink">
          <th className="px-3 py-1.5 font-medium">Requested</th>
          <th className="px-3 py-1.5 font-medium">Type</th>
          <th className="px-3 py-1.5 font-medium">Amount</th>
          <th className="px-3 py-1.5 font-medium">Status</th>
        </tr></thead>
        <tbody>
          {history.data?.map((t) => (
            <tr key={t.id} className="border-t border-pebble dark:border-white/10">
              <td className="px-3 py-1.5 text-slate-ink">{when(t.created_at)}</td>
              <td className="px-3 py-1.5">{t.kind}</td>
              <td className="px-3 py-1.5 tabular-nums">{t.amount}</td>
              <td className={`px-3 py-1.5 ${STATUS[t.status] ?? ''}`}>{t.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {history.data?.length === 0 && <p className="text-sm text-slate-ink">No funding requests yet.</p>}
    </div>
  );
}
