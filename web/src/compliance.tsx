import { useEffect, useRef, useState } from 'react';
import { AlertCircle, BadgeCheck, Camera, Check, Clock, Coins, Eye, FileText, Home, IdCard, Landmark, Receipt, ShieldCheck, Upload, X } from 'lucide-react';
import { StatTile } from './x-shell.tsx';
import { alertBox, btn, card, field, input, mono, PageTitle, tableCard, thead } from './App.tsx';
import { api, token, useApi } from './api.ts';

type PendingDoc = {
  id: number; client_id: string; kind: string; uploaded_at: string;
  client_name: string; country: string | null; kyc_status: string;
};
type Doc = {
  id: number; kind: string; status: string; note: string | null;
  uploaded_at: string; reviewed_at: string | null; reviewed_by: string | null;
  storage_key?: string;
};
type Flag = {
  id: number; client_id: string; client_name: string; rule: string;
  severity: 'low' | 'medium' | 'high'; details: Record<string, unknown>; raised_at: string;
};
type Cash = {
  id: number; kind: string; amount: number; status: string; created_at: string;
  // The account the movement landed in decides this. An amount without it is a number
  // the reader has to guess the units of.
  currency: string;
};

const when = (iso: string) => new Date(iso).toLocaleString();
const pretty = (s: string) => s.replace(/_/g, ' ');

const SEVERITY: Record<string, string> = {
  high: 'bg-ember text-graphite',
  medium: 'bg-ember/15 text-ember-ink',
  low: 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist',
};
const chip = 'rounded-full px-2.5 py-0.5 font-mono text-[11px] tracking-wide uppercase';
const STATUS: Record<string, string> = {
  approved: `${chip} chip-up text-up`,
  rejected: `${chip} chip-down text-down`,
  pending: `${chip} bg-ember/15 text-ember-ink`,
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
    <div className="mx-auto max-w-[1440px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Compliance</PageTitle>
        {!review && (
          <span className="rounded-full bg-bone px-2.5 py-0.5 font-mono text-[11px] tracking-wide text-slate-ink uppercase dark:bg-white/10">
            read only
          </span>
        )}
      </div>

      <div className="x-strip">
        <div>
          <p className="metric-label">Waiting for review</p>
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${docs.length ? 'text-ember-ink' : ''}`}>
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
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${high ? 'text-ember-ink' : ''}`}>
            {high}
          </p>
        </div>
        <p className="ml-auto max-w-xs text-xs text-slate-ink">
          Documents arrive when a client uploads identification. Flags are raised by the
          rules in system configuration, never by hand.
        </p>
      </div>

      <div role="tablist" aria-label="Compliance queues" className="x-ptabs">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={tab === t.id ? 'is-on' : ''}>
            {t.label}
            <span className="x-ptab-n tabular-nums">{t.count}</span>
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
                  <a className="text-sm font-medium text-ember-ink hover:underline" href={`#/clients/${d.client_id}`}>
                    {d.client_name}
                  </a>
                  <p className="text-xs text-obsidian dark:text-vellum">{pretty(d.kind)}</p>
                  <p className={`text-xs text-slate-ink ${mono}`}>
                    {when(d.uploaded_at)} · waiting {waited(d.uploaded_at)}
                    {d.country && ` · ${d.country}`}
                  </p>
                </div>
                <button onClick={() => openDocument(d.id)}
                  className="rounded-full border border-pebble px-2.5 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
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
        className="rounded-full bg-ember px-3 py-1 text-xs font-medium text-graphite transition-colors hover:brightness-110 disabled:opacity-50">Approve</button>
      <button disabled={busy} onClick={() => send('rejected')}
        className="rounded-full border border-pebble px-3 py-1 text-xs font-medium text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian disabled:opacity-50 dark:border-white/10 dark:hover:text-vellum">Reject</button>
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
              <a className="text-xs text-ember-ink hover:underline" href={`#/clients/${f.client_id}`}>{f.client_name}</a>
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
                className="rounded-full border border-pebble px-2.5 py-1 text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
                Clear
              </button>
              <button onClick={() => decide(f.id, 'escalated')}
                className="rounded-full bg-ember px-2.5 py-1 font-medium text-graphite transition-colors hover:brightness-110">
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

/**
 * The reports, as something you can actually read an answer out of.
 *
 * A report is a table somebody is looking for one row in, or one column's total. So it
 * sorts on any column, searches across all of them, and totals the numeric ones above the
 * table. The rows on screen are capped and it says so — a report that silently shows the
 * first slice of a thousand is one that gets a conclusion drawn from the wrong data.
 *
 * The export is always the whole report, not what happens to be on screen: a filtered CSV
 * that does not say it was filtered is a spreadsheet somebody will circulate as the truth.
 */

const ROWS = 250;

/** Numbers as money-ish, dates as dates, and nulls as a dash rather than "null". */
function cell(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (key.endsWith('_at')) {
    const d = new Date(String(value));
    return Number.isNaN(+d) ? String(value) : d.toLocaleDateString();
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(value);
}

/** Columns worth adding up: numeric, and not an id or a count of something unrelated. */
const totalled = (rows: Record<string, unknown>[], col: string) =>
  rows.length > 0 && typeof rows[0]![col] === 'number';

export function ReportsView() {
  const [open, setOpen] = useState<string>('clients');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null);
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

  const all = rows.data ?? [];
  const cols = all[0] ? Object.keys(all[0]) : [];
  const term = q.trim().toLowerCase();

  const matched = term
    ? all.filter((r) => cols.some((c) => String(r[c] ?? '').toLowerCase().includes(term)))
    : all;

  const sorted = sort
    ? [...matched].sort((a, b) => {
      const x = a[sort.col];
      const y = b[sort.col];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;   // blanks last, either direction
      if (y === null || y === undefined) return -1;
      const cmp = typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y));
      return sort.desc ? -cmp : cmp;
    })
    : matched;

  const shown = sorted.slice(0, ROWS);
  const report = REPORTS.find((r) => r.name === open);

  const toggle = (col: string) =>
    setSort((s) => (s?.col === col ? { col, desc: !s.desc } : { col, desc: true }));

  return (
    <div className="mx-auto max-w-[1440px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Reports</PageTitle>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className={btn} onClick={() => download(open)}>Export CSV</button>
          <button
            className="rounded-full border border-pebble px-4 py-2 font-mono text-sm text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
            onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {REPORTS.map((r) => (
          <button key={r.name} onClick={() => { setOpen(r.name); setSort(null); setQ(''); }}
            aria-pressed={open === r.name}
            className={`rounded-lg border p-3 text-left transition-colors ${open === r.name
              ? 'border-ember bg-ember/5'
              : 'border-pebble hover:border-ember/50 dark:border-white/10'}`}>
            <span className={`block text-sm font-medium ${open === r.name ? 'text-ember-ink' : ''}`}>
              {r.title}
            </span>
            <span className="mt-0.5 block text-xs text-slate-ink">{r.blurb}</span>
          </button>
        ))}
      </div>

      {/* Totals over everything that matched, not over the page on screen. */}
      {!!matched.length && (
        <div className="x-strip">
          <div>
            <p className="metric-label">{term ? 'Matching rows' : 'Rows'}</p>
            <p className="font-mono text-2xl leading-tight font-medium tabular-nums">
              {matched.length.toLocaleString()}
            </p>
          </div>
          {cols.filter((c) => totalled(all, c)).slice(0, 4).map((c) => (
            <div key={c}>
              <p className="metric-label">{pretty(c)}</p>
              <p className="font-mono text-xl leading-tight font-medium tabular-nums">
                {cell(c, matched.reduce((n, r) => n + Number(r[c] ?? 0), 0))}
              </p>
            </div>
          ))}
          <p className="ml-auto max-w-xs text-xs text-slate-ink">
            {report?.blurb} Totals cover every matching row; the export is always the whole
            report.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input className={`${field} min-w-56 flex-1`} placeholder="Search every column"
          value={q} onChange={(e) => setQ(e.target.value)} />
        {sort && (
          <button onClick={() => setSort(null)}
            className="rounded-full border border-pebble px-2.5 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
            Clear sort
          </button>
        )}
        <span className="ml-auto font-mono text-xs text-slate-ink">
          {shown.length.toLocaleString()} of {matched.length.toLocaleString()}
        </span>
      </div>

      <div className={`${tableCard} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              {cols.map((c) => (
                <th key={c} className="px-3 py-2 text-left font-medium">
                  <button onClick={() => toggle(c)}
                    className="flex items-center gap-1 transition-colors hover:text-obsidian dark:hover:text-vellum">
                    {pretty(c)}
                    <span className={`font-mono text-[10px] ${sort?.col === c ? 'text-ember-ink' : 'opacity-0'}`}
                      aria-hidden>
                      {sort?.col === c && sort.desc ? '▼' : '▲'}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-t border-pebble dark:border-white/10">
                {cols.map((c) => (
                  <td key={c}
                    className={`px-3 py-1.5 ${typeof r[c] === 'number' ? 'text-right font-mono tabular-nums' : ''}`}>
                    {cell(c, r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.data && <p className="p-4 text-sm text-slate-ink">Loading…</p>}
        {rows.data && shown.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-slate-ink">
            {term ? 'Nothing matches that.' : 'No rows.'}
          </p>
        )}
      </div>

      {matched.length > ROWS && (
        <p className="px-1 text-xs text-slate-ink">
          Showing the first {ROWS} of {matched.length.toLocaleString()}. Search or sort to
          bring what you want to the top — the CSV has all of them.
        </p>
      )}
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

/**
 * Why you would send each of the additional kinds.
 *
 * The select lists them by name and nothing else, which answers "what can I send" and
 * leaves "why would I" to a support ticket. Most of these are asked for eventually;
 * sending one before it is asked for is the difference between a withdrawal that clears
 * and one that waits a day on an email.
 */
const WHY: Record<string, string> = {
  bank_statement: 'Where funds are coming from, and where they go back to.',
  source_of_funds: 'Asked for on larger deposits. Sending it early saves the wait.',
  tax_document: 'A residency or tax reference, where your jurisdiction needs one.',
  other: 'Anything the desk has asked you for by name.',
};

/** What each kind is called on screen: the words a person uses, not the stored code. */
const DOC_LABEL: Record<string, string> = {
  id_front: 'Photo ID (front)', id_back: 'Photo ID (back)', proof_of_address: 'Proof of address', selfie: 'Selfie with ID',
  bank_statement: 'Bank statement', source_of_funds: 'Source of funds', tax_document: 'Tax document', other: 'Other',
};
const docLabel = (k: string) => DOC_LABEL[k] ?? pretty(k);
/** What the identity kinds are for, shown when one is picked — the additional ones use WHY. */
const ID_WHY: Record<string, string> = {
  id_front: 'Passport, national ID card or driving licence — the side with your photo.',
  id_back: 'The reverse of an ID card or licence, where it has one.',
  proof_of_address: 'A utility bill or bank letter from the last three months, showing your name and address.',
  selfie: 'You holding the same ID next to your face. Only if the desk asks.',
};
const DOC_ICON: Record<string, typeof FileText> = {
  id_front: IdCard, id_back: IdCard, proof_of_address: Home, selfie: Camera,
  bank_statement: Landmark, source_of_funds: Coins, tax_document: Receipt, other: FileText,
};
const BADGE: Record<string, [string, string]> = {
  approved: ['Accepted', ''], pending: ['In review', 'is-locked'], rejected: ['Resend', 'is-bad'], missing: ['Missing', 'is-muted'],
};
const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function DocumentsPanel({ clientId, canUpload, onBehalf = false, page = false }: {
  clientId: string;
  canUpload: boolean;
  /** Staff uploading for a client rather than a client uploading their own. Same form and
   *  the same route — the panel only stops addressing the reader as the document's owner. */
  onBehalf?: boolean;
  /** The client's own page: the panel carries the page title and its actions. */
  page?: boolean;
}) {
  const docs = useApi<Doc[]>(`/clients/${clientId}/kyc`);
  const [kind, setKind] = useState('id_front');
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'all' | 'identity' | 'additional' | 'action'>('all');
  const fileRef = useRef<HTMLInputElement>(null);
  const uploader = useRef<HTMLElement>(null);

  const rows = docs.data ?? [];
  const identity = rows.filter((d) => IDENTITY.includes(d.kind));
  const extra = rows.filter((d) => !IDENTITY.includes(d.kind));

  // What verification is actually waiting on, one line per required document, so the
  // answer to "what else do you need" is on the screen rather than in a support ticket.
  const checklist = REQUIRED.map((k) => {
    const sent = identity.filter((d) => d.kind === k);
    const best = sent.find((d) => d.status === 'approved')
      ?? sent.find((d) => d.status === 'pending')
      ?? sent[0] ?? null;
    return { kind: k, state: best?.status ?? 'missing', at: best?.uploaded_at ?? null, note: best?.note ?? null };
  });
  const verifiedCount = checklist.filter((c) => c.state === 'approved').length;
  const verified = verifiedCount === REQUIRED.length;
  const pending = rows.filter((d) => d.status === 'pending').length;
  const rejected = rows.filter((d) => d.status === 'rejected').length;
  const next = checklist.find((c) => c.state === 'missing' || c.state === 'rejected');

  function choose(f: File | null) {
    setFile(f);
    setError(null);
    setDone(null);
    // Pick the type from the name where it is obvious, so the commonest upload is one
    // drop and one button rather than a choice somebody has to remember to make.
    const name = f?.name.toLowerCase() ?? '';
    const guess = [...IDENTITY, ...ADDITIONAL].find((k) => name.includes(k.replace(/_/g, '')))
      ?? (/passport|licence|license|\bid\b/.test(name) ? 'id_front' : null)
      ?? (/address|utility|bill/.test(name) ? 'proof_of_address' : null);
    if (guess) setKind(guess);
  }

  /** Jump to the uploader with a type already chosen, and open the file picker. */
  function start(k: string) {
    setKind(k);
    setError(null);
    setDone(null);
    uploader.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    fileRef.current?.click();
  }

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
    setDone(`${docLabel(kind)} sent. The desk reviews it and you will hear when it is decided.`);
    setFile(null);
    if (fileRef.current) fileRef.current.value = '';
    docs.reload();
  }

  const shown = view === 'identity' ? identity : view === 'additional' ? extra
    : view === 'action' ? rows.filter((d) => d.status === 'rejected') : rows;

  return (
    <div className="stagger space-y-4">
      {page && (
        <div className="flex flex-wrap items-center gap-3">
          <PageTitle>Documents</PageTitle>
          <span className={`x-badge ${verified ? '' : 'is-locked'}`}>
            <ShieldCheck size={13} className="mr-1.5" aria-hidden />{verified ? 'Identity verified' : 'Verification in progress'}
          </span>
          {canUpload && (
            <button type="button" onClick={() => start(next?.kind ?? kind)} className={`${btn} ml-auto inline-flex items-center gap-2`}>
              <Upload size={16} aria-hidden />Upload a document
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatTile label="Verification" Icon={ShieldCheck} value={`${verifiedCount} of ${REQUIRED.length}`}
          tone={verified ? 'text-up' : ''} note={verified ? 'Identity verified' : 'Required documents accepted'}>
          <div className="x-meter mt-3"><span style={{ width: `${(verifiedCount / REQUIRED.length) * 100}%` }} /></div>
        </StatTile>
        <StatTile label="On file" Icon={FileText} value={rows.length} note={`${identity.length} identity · ${extra.length} additional`} />
        <StatTile label="In review" Icon={Clock} value={pending} tone={pending ? 'text-ember-ink' : ''}
          note={pending ? 'The desk is looking at these' : 'Nothing waiting on the desk'} />
        <StatTile label="Needs action" Icon={AlertCircle} value={rejected} tone={rejected ? 'text-down' : ''}
          note={rejected ? 'Not accepted — send again' : 'Nothing to resend'} />
      </div>

      <div className={`grid gap-4 ${canUpload ? 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : ''}`}>
        <section className="x-card x-holo space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="section-title">Identity verification</h2>
            <span className={`x-badge ml-auto ${verified ? '' : 'is-locked'}`}>{verifiedCount} of {REQUIRED.length} accepted</span>
          </div>
          <p className="text-xs text-slate-ink">
            {verified
              ? 'Both required documents are accepted. Nothing more is needed unless the desk asks.'
              : `Two documents verify ${onBehalf ? 'the' : 'your'} account. Each is reviewed by the desk, usually within a working day.`}
          </p>
          <ol className="dc-steps">
            {checklist.map((c, i) => {
              const Icon = DOC_ICON[c.kind] ?? FileText;
              const [label, badge] = BADGE[c.state] ?? BADGE.missing!;
              return (
                <li key={c.kind} className={`dc-step is-${c.state}`}>
                  <span className="dc-step-dot" aria-hidden>
                    {c.state === 'approved' ? <Check size={14} strokeWidth={2.6} /> : c.state === 'rejected' ? <X size={14} strokeWidth={2.6} /> : i + 1}
                  </span>
                  <span className="x-chip !h-9 !w-9" aria-hidden><Icon size={17} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold">{docLabel(c.kind)}</span>
                    <span className="block text-xs text-slate-ink">
                      {c.state === 'approved' ? `Accepted${c.at ? ` · sent ${dateOf(c.at)}` : ''}`
                        : c.state === 'pending' ? `With the desk for review${c.at ? ` · sent ${dateOf(c.at)}` : ''}`
                        : c.state === 'rejected' ? (c.note ? `Not accepted: ${c.note}` : 'Not accepted — please send it again')
                        : ID_WHY[c.kind]}
                    </span>
                  </span>
                  {canUpload && (c.state === 'missing' || c.state === 'rejected')
                    ? <button type="button" onClick={() => start(c.kind)} className="x-btn-sm inline-flex shrink-0 items-center gap-1.5"><Upload size={13} aria-hidden />{c.state === 'rejected' ? 'Resend' : 'Upload'}</button>
                    : <span className={`x-badge shrink-0 ${badge}`}>{label}</span>}
                </li>
              );
            })}
            <li className={`dc-step ${verified ? 'is-approved' : 'is-missing'}`}>
              <span className="dc-step-dot" aria-hidden>{verified ? <Check size={14} strokeWidth={2.6} /> : REQUIRED.length + 1}</span>
              <span className="x-chip !h-9 !w-9" aria-hidden><BadgeCheck size={17} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold">Account verified</span>
                <span className="block text-xs text-slate-ink">
                  {verified ? 'IPO subscriptions are open to you.' : 'Once both are accepted. Needed for IPO subscriptions.'}
                </span>
              </span>
              <span className={`x-badge shrink-0 ${verified ? '' : 'is-muted'}`}>{verified ? 'Done' : 'Waiting'}</span>
            </li>
          </ol>
        </section>

        {canUpload && (
          <section ref={uploader} className="x-card x-holo scroll-mt-24 space-y-4 p-5">
            <h2 className="section-title">{onBehalf ? 'Upload for this client' : 'Upload a document'}</h2>
            {onBehalf && (
              <p className="text-xs text-slate-ink">
                Filed against their record exactly as their own upload would be: it lands on
                their timeline, and an identity document moves them to pending verification.
              </p>
            )}

            <fieldset>
              <legend className="mb-2 text-[12.5px] text-mist">What is it?</legend>
              <div className="space-y-2" role="radiogroup" aria-label="Document type">
                {([['Identity', IDENTITY], ['Additional', ADDITIONAL]] as const).map(([group, kinds]) => (
                  <div key={group} className="flex flex-wrap gap-1.5">
                    {kinds.map((k) => {
                      const Icon = DOC_ICON[k] ?? FileText;
                      return (
                        <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setDone(null); }}
                          className={`dc-type ${kind === k ? 'is-on' : ''}`}>
                          <Icon size={13} aria-hidden />{docLabel(k)}
                          {REQUIRED.includes(k) && <span className="dc-req" title="Required">•</span>}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-ink">{ID_WHY[kind] ?? WHY[kind]}</p>
            </fieldset>

            {/* A drop target that is also a file picker: dragging is the fast path and the
                click is the one that works on a phone and with a keyboard. */}
            <label
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files?.[0] ?? null); }}
              className={`x-drop ${over ? 'is-over' : ''} ${file ? 'has-file' : ''}`}>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,application/pdf" className="sr-only"
                onChange={(e) => choose(e.target.files?.[0] ?? null)} />
              <span className="x-drop-icon" aria-hidden>{file ? <FileText size={24} /> : <Upload size={24} />}</span>
              <span className="block max-w-full truncate px-4 text-[15px] font-semibold text-obsidian dark:text-vellum">
                {file ? file.name : 'Drop a file here, or choose one'}
              </span>
              <span className="block text-xs text-slate-ink">
                {file
                  ? `${file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`} · ${file.type || 'unknown type'} · click to change`
                  : 'JPEG, PNG or PDF, up to 10 MB · encrypted in transit'}
              </span>
            </label>

            {error && <p role="alert" className={alertBox}>{error}</p>}
            {done && <p role="status" className="flex items-center gap-1.5 text-xs text-up"><Check size={14} aria-hidden />{done}</p>}
            <div className="flex gap-2">
              <button onClick={upload} disabled={busy || !file} className={`${btn} flex-1 disabled:opacity-50`}>
                {busy ? 'Uploading…' : file ? `Upload ${docLabel(kind)}` : 'Choose a file to upload'}
              </button>
              {file && (
                <button type="button" className="x-btn-sm !h-auto" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}>
                  Clear
                </button>
              )}
            </div>
          </section>
        )}
      </div>

      <section className="x-card x-holo space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="section-title">{onBehalf ? 'Documents on file' : 'Your documents'}</h2>
          <div className="x-qgroups ml-auto w-full sm:w-auto" role="tablist">
            {([['all', 'All', rows.length], ['identity', 'Identity', identity.length], ['additional', 'Additional', extra.length], ['action', 'Needs action', rejected]] as const).map(([k, label, n]) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
                className={`!px-3 whitespace-nowrap ${view === k ? 'is-on' : ''}`}>{label}{n ? ` · ${n}` : ''}</button>
            ))}
          </div>
        </div>
        {!docs.data && <div className="skeleton h-24 rounded-lg" />}
        {docs.data && !shown.length && (
          <div className="grid place-items-center gap-2 py-8 text-center">
            <span className="x-drop-icon" aria-hidden><FileText size={24} /></span>
            <p className="text-[15px] font-semibold">{rows.length ? 'Nothing here' : 'Nothing uploaded yet'}</p>
            <p className="max-w-sm text-xs text-slate-ink">
              {rows.length ? 'Try another filter.' : 'Start with your photo ID and a proof of address — together they verify the account.'}
            </p>
          </div>
        )}
        <ul className="dc-list">
          {shown.map((d) => <DocRow key={d.id} d={d} />)}
        </ul>
      </section>
    </div>
  );
}

/**
 * A document on file.
 *
 * The thumbnail is fetched with the bearer token and handed over as a blob: these sit
 * behind auth, so a plain src would arrive without one and draw a broken image. Seeing
 * what was actually sent is most of the value — "is that the right page" cannot be
 * answered from a filename.
 */
function DocRow({ d }: { d: Doc }) {
  const [src, setSrc] = useState<string | null>(null);
  const pdf = /\.pdf$/i.test(d.storage_key ?? '');

  useEffect(() => {
    if (pdf) return;
    let url: string | null = null;
    let dropped = false;
    fetch(`/api/kyc/${d.id}/file`, { headers: { authorization: `Bearer ${token.get()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('no preview'))))
      .then((b) => { if (!dropped) { url = URL.createObjectURL(b); setSrc(url); } })
      .catch(() => setSrc(null));
    return () => { dropped = true; if (url) URL.revokeObjectURL(url); };
  }, [d.id, pdf]);

  const open = async () => {
    const res = await fetch(`/api/kyc/${d.id}/file`, {
      headers: { authorization: `Bearer ${token.get()}` },
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const [label, badge] = BADGE[d.status] ?? [d.status, 'is-muted'];

  return (
    <li>
      <button type="button" onClick={open} title="Open the document" className="dc-thumb">
        {src ? <img src={src} alt="" /> : <span aria-hidden>{pdf ? 'PDF' : <FileText size={18} />}</span>}
      </button>
      <span className="min-w-0 flex-1">
        <button type="button" onClick={open} className="block text-left text-[14px] font-semibold hover:underline">{docLabel(d.kind)}</button>
        <span className="block text-xs text-slate-ink">
          Sent {dateOf(d.uploaded_at)}{d.reviewed_at && ` · reviewed ${dateOf(d.reviewed_at)}`}
          {' · '}{IDENTITY.includes(d.kind) ? 'Identity' : 'Additional'}
        </span>
        {d.note && <span className="mt-1 block text-xs text-slate-ink"><span className="font-semibold text-obsidian dark:text-vellum">Desk:</span> {d.note}</span>}
      </span>
      <button type="button" onClick={open} className="x-btn-sm hidden items-center gap-1.5 sm:inline-flex"><Eye size={13} aria-hidden />View</button>
      <span className={`x-badge shrink-0 ${badge}`}>{label}</span>
    </li>
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
              <td className="px-3 py-1.5 tabular-nums">{t.amount} {t.currency}</td>
              <td className={`px-3 py-1.5 ${STATUS[t.status] ?? ''}`}>{t.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {history.data?.length === 0 && <p className="text-sm text-slate-ink">No funding requests yet.</p>}
    </div>
  );
}
