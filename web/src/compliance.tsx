import { useRef, useState } from 'react';
import { alertBox, btn, card, field, input, mono, PageTitle, tableCard, thead } from './App.tsx';
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
  medium: 'bg-ember/15 text-ember',
  low: 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist',
};
const chip = 'rounded-full px-2.5 py-0.5 font-mono text-[11px] tracking-wide uppercase';
const STATUS: Record<string, string> = {
  approved: `${chip} bg-up/15 text-up`,
  rejected: `${chip} bg-down/15 text-down`,
  pending: `${chip} bg-ember/15 text-ember`,
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

/**
 * The compliance desk: what is waiting to be reviewed, and what has been flagged.
 *
 * Both queues are meant to be empty most of the time, so the empty states carry their
 * weight — a screen that says only "nothing" gives no way to tell a quiet morning from a
 * broken feed. They name what would appear here and where it comes from.
 *
 * The oldest item leads the summary rather than the count. Ten documents that arrived this
 * morning is a normal Tuesday; one that has been sitting for three days is the thing worth
 * knowing, and a count alone cannot tell you which you are looking at.
 */

/** Longest wait in the queue, as something a person reads. */
function waited(iso: string): string {
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function ComplianceView({ role }: { role?: string }) {
  const [tab, setTab] = useState<'kyc' | 'flags'>('kyc');
  const queue = useApi<PendingDoc[]>('/kyc/pending');
  const flags = useApi<Flag[]>('/flags?status=open');
  const review = role === 'compliance' || role === 'admin';

  const docs = queue.data ?? [];
  const open = flags.data ?? [];
  const high = open.filter((f) => f.severity === 'high').length;
  // The queue comes back newest first, so the last row is the one that has waited longest.
  const oldest = docs.length ? docs[docs.length - 1] : null;

  const tabs = [
    { id: 'kyc' as const, label: 'KYC queue', count: docs.length },
    { id: 'flags' as const, label: 'Open flags', count: open.length },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Compliance</PageTitle>
        {!review && (
          <span className="rounded-full bg-bone px-2.5 py-0.5 font-mono text-[11px] tracking-wide text-slate-ink uppercase dark:bg-white/10">
            read only
          </span>
        )}
      </div>

      <div className={`${card} flex flex-wrap items-center gap-x-10 gap-y-3`}>
        <div>
          <p className="metric-label">Waiting for review</p>
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${docs.length ? 'text-ember' : ''}`}>
            {docs.length}
          </p>
        </div>
        <div>
          <p className="metric-label">Longest wait</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">
            {oldest ? waited(oldest.uploaded_at) : '—'}
          </p>
        </div>
        <div>
          <p className="metric-label">Open flags</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">{open.length}</p>
        </div>
        <div>
          <p className="metric-label">High severity</p>
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${high ? 'text-ember' : ''}`}>
            {high}
          </p>
        </div>
        <p className="ml-auto max-w-xs text-xs text-slate-ink">
          Documents arrive when a client uploads identification. Flags are raised by the
          rules in system configuration, never by hand.
        </p>
      </div>

      <div role="tablist" aria-label="Compliance queues" className="flex flex-wrap gap-1 text-xs">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors ${tab === t.id
              ? 'bg-ember font-medium text-graphite'
              : 'bg-bone text-slate-ink hover:text-obsidian dark:bg-white/10 dark:text-mist dark:hover:text-vellum'}`}>
            {t.label}
            <span className={`rounded-full px-1.5 font-mono tabular-nums ${tab === t.id
              ? 'bg-graphite/15' : 'bg-black/10 dark:bg-white/10'}`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {tab === 'kyc' ? (
        docs.length === 0 ? (
          <Empty
            title="Nothing waiting for review"
            body="Identification uploaded by a client lands here. Approving the required documents verifies them; rejecting one sends them back to it." />
        ) : (
          <div className={`${card} divide-y divide-pebble dark:divide-white/10`}>
            {docs.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-bone font-mono text-xs text-slate-ink dark:bg-white/5" aria-hidden>
                  &#9636;
                </span>
                <div className="min-w-48">
                  <a className="text-sm font-medium text-ember hover:underline" href={`#/clients/${d.client_id}`}>
                    {d.client_name}
                  </a>
                  <p className="text-xs text-obsidian dark:text-vellum">{pretty(d.kind)}</p>
                  <p className={`text-xs text-slate-ink ${mono}`}>
                    {when(d.uploaded_at)} · waiting {waited(d.uploaded_at)}
                    {d.country && ` · ${d.country}`}
                  </p>
                </div>
                <button onClick={() => openDocument(d.id)}
                  className="rounded-md border border-pebble px-2.5 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
                  View document
                </button>
                {review
                  ? <Decide id={d.id} onDone={() => { queue.reload(); flags.reload(); }} />
                  : <span className="ml-auto text-xs text-slate-ink">Reviewing needs kyc:review.</span>}
              </div>
            ))}
          </div>
        )
      ) : (
        open.length === 0 ? (
          <Empty
            title="No open flags"
            body="A flag is raised automatically when a client trips one of the risk rules — an unusual volume, a large withdrawal. Clearing one closes it; escalating leaves it open and on the record." />
        ) : (
          <FlagList rows={open} review={review} onDone={flags.reload} showClient />
        )
      )}
    </div>
  );
}

/** An empty queue that says what would be in it, rather than only that it is empty. */
const Empty = ({ title, body }: { title: string; body: string }) => (
  <div className={`${card} py-10 text-center`}>
    <p className="text-sm font-medium text-obsidian dark:text-vellum">{title}</p>
    <p className="mx-auto mt-2 max-w-md text-xs text-slate-ink">{body}</p>
  </div>
);

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
        className="rounded-md bg-ember px-3 py-1 text-xs font-medium text-graphite transition-colors hover:brightness-110 disabled:opacity-50">Approve</button>
      <button disabled={busy} onClick={() => send('rejected')}
        className="rounded-md border border-pebble px-3 py-1 text-xs font-medium text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian disabled:opacity-50 dark:border-white/10 dark:hover:text-vellum">Reject</button>
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
    <div className={`${card} divide-y divide-pebble dark:divide-white/10`}>
      {rows.map((f) => (
        <div key={f.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
          <span className={`${chip} shrink-0 ${SEVERITY[f.severity]}`}>{f.severity}</span>
          <div className="min-w-0">
            <p className="text-sm font-medium">{pretty(f.rule)}</p>
            {showClient && (
              <a className="text-xs text-ember hover:underline" href={`#/clients/${f.client_id}`}>{f.client_name}</a>
            )}
            <p className={`text-xs text-slate-ink ${mono}`}>
              {when(f.raised_at)}
              {Object.entries(f.details).length > 0
                && ` · ${Object.entries(f.details).map(([k, v]) => `${pretty(k)} ${v}`).join(', ')}`}
            </p>
          </div>
          {review && (
            <div className="ml-auto flex gap-2 text-xs">
              <button onClick={() => decide(f.id, 'cleared')}
                className="rounded-md border border-pebble px-2.5 py-1 text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
                Clear
              </button>
              <button onClick={() => decide(f.id, 'escalated')}
                className="rounded-md bg-ember px-2.5 py-1 font-medium text-graphite transition-colors hover:brightness-110">
                Escalate
              </button>
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
              ? 'bg-ember font-medium text-graphite'
              : 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'}`}>
            {r.title}
          </button>
        ))}
        <button className={`${btn} ml-auto`} onClick={() => download(open)}>Export CSV</button>
        <button className={btn} onClick={() => window.print()}>Print / PDF</button>
      </div>
      <p className="text-sm text-slate-ink">{REPORTS.find((r) => r.name === open)?.blurb}</p>

      <div className={`${tableCard} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>{cols.map((c) => <th key={c} className="px-3 py-2 font-medium">{pretty(c)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.data?.map((r, i) => (
              <tr key={i} className="border-t border-pebble dark:border-white/10">
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

/**
 * Everything on one client's file, with upload.
 *
 * Two groups, because they answer different questions. Identity is what verification
 * needs — those are the ones that move somebody from unverified to verified, and the
 * panel says which are still missing rather than leaving people to guess. Everything else
 * is what the desk asks for afterwards: where the money came from, a statement, a tax
 * form. Sent up the same way, reviewed the same way, but they neither start nor finish a
 * verification, so they are listed apart from the ones that do.
 */
const IDENTITY = ['id_front', 'id_back', 'proof_of_address', 'selfie'];
const ADDITIONAL = ['bank_statement', 'source_of_funds', 'tax_document', 'other'];
const REQUIRED = ['id_front', 'proof_of_address'];

export function DocumentsPanel({ clientId, canUpload }: { clientId: string; canUpload: boolean }) {
  const docs = useApi<Doc[]>(`/clients/${clientId}/kyc`);
  const [kind, setKind] = useState('id_front');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = docs.data ?? [];
  const identity = rows.filter((d) => IDENTITY.includes(d.kind));
  const extra = rows.filter((d) => !IDENTITY.includes(d.kind));
  const missing = REQUIRED.filter((k) => !identity.some((d) => d.kind === k && d.status !== 'rejected'));

  async function upload() {
    if (!file) return setError('Choose a file first.');
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', file);
    // Sent with fetch rather than the api helper: this is multipart, and setting a JSON
    // content-type on it would strip the boundary the server needs to read the parts.
    const res = await fetch(`/api/clients/${clientId}/kyc`, {
      method: 'POST', headers: { authorization: `Bearer ${token.get()}` }, body: form,
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json().catch(() => null))?.error ?? 'Upload failed');
    setFile(null);
    if (fileRef.current) fileRef.current.value = '';
    docs.reload();
  }

  return (
    <div className="space-y-4">
      {/* Verification first, and said plainly. Somebody opening this screen wants one
          answer — am I done, and if not what is missing — and that should not be a grey
          line under a grey heading. */}
      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="metric-label">Identity</h2>
          <span className={`ml-auto rounded-full px-2.5 py-0.5 font-mono text-[11px] tracking-wide uppercase ${
            missing.length === 0 ? 'bg-up/15 text-up' : 'bg-ember/15 text-ember'}`}>
            {missing.length === 0 ? 'complete' : `${missing.length} outstanding`}
          </span>
        </div>

        {missing.length === 0 ? (
          <p className="text-sm text-obsidian dark:text-vellum">
            Everything needed for verification is on file.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-obsidian dark:text-vellum">Still needed:</p>
            <ul className="flex flex-wrap gap-2">
              {missing.map((k) => (
                <li key={k}
                  className="rounded-md border border-ember/40 bg-ember/10 px-2.5 py-1 text-xs font-medium text-ember">
                  {pretty(k)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DocList rows={identity} empty="No identification uploaded yet." />
      </div>

      <div className={`${card} space-y-3`}>
        <h2 className="metric-label">Additional documents</h2>
        <p className="text-sm text-obsidian dark:text-vellum">
          Anything else the desk has asked for.
        </p>
        <p className="text-xs text-slate-ink">
          Reviewed like the rest, but they do not change your verification either way.
        </p>
        <DocList rows={extra} empty="Nothing else on file." />
      </div>

      {canUpload && (
        <div className={`${card} space-y-3`}>
          <h2 className="metric-label">Upload</h2>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="text-xs text-slate-ink">Document type</span>
              <select className={`${field} mt-1 w-full`} value={kind} onChange={(e) => setKind(e.target.value)}>
                <optgroup label="Identity">
                  {IDENTITY.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}
                </optgroup>
                <optgroup label="Additional">
                  {ADDITIONAL.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}
                </optgroup>
              </select>
            </label>
            <button onClick={upload} disabled={busy || !file} className={`${btn} self-end disabled:opacity-50`}>
              {busy ? 'Uploading…' : 'Upload'}
            </button>
          </div>

          {/* The browser's own file button is unstyled and says nothing useful once a file
              is chosen, so it is hidden behind a label that reports the name back. */}
          <label className="flex cursor-pointer flex-wrap items-center gap-3 rounded-lg border border-dashed border-pebble px-4 py-4 transition-colors hover:border-ember/60 dark:border-white/15">
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,application/pdf" className="sr-only"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-ember/15 font-mono text-ember" aria-hidden>↑</span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-obsidian dark:text-vellum">
                {file ? file.name : 'Choose a file'}
              </span>
              <span className="block text-xs text-slate-ink">
                {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : 'JPEG, PNG or PDF, up to 10 MB'}
              </span>
            </span>
          </label>

          {error && <p role="alert" className={alertBox}>{error}</p>}
        </div>
      )}
    </div>
  );
}

const DocList = ({ rows, empty }: { rows: Doc[]; empty: string }) => (
  rows.length === 0
    ? <p className="text-sm text-slate-ink">{empty}</p>
    : (
      <ul className="divide-y divide-pebble dark:divide-white/10">
        {rows.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-bone font-mono text-xs text-slate-ink dark:bg-white/5" aria-hidden>
              &#9636;
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-obsidian dark:text-vellum">{pretty(d.kind)}</span>
              <span className={`block text-xs text-slate-ink ${mono}`}>
                {new Date(d.uploaded_at).toLocaleDateString()}
              </span>
            </span>
            <span className={`ml-auto ${STATUS[d.status] ?? ''}`}>{d.status}</span>
            {d.note && <span className="w-full text-xs text-slate-ink">{d.note}</span>}
          </li>
        ))}
      </ul>
    )
);

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
      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
      {raised.length > 0 && (
        <p className="text-sm text-slate-ink">
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
