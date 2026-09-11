import { useState } from 'react';
import { alertBox, btn, card, field, input, mono, PageTitle, tableCard, thead } from './App.tsx';
import { api, useApi } from './api.ts';

type Ticket = {
  id: string; subject: string; category: string; status: string; priority: string;
  client_id: string; client_name: string; assigned_to: string | null; assignee_name: string | null;
  messages: number; last_message_at: string | null; created_at: string; updated_at: string;
};
type Message = {
  id: number; author_kind: 'client' | 'staff' | 'system'; author_name: string | null;
  body: string; internal: boolean; created_at: string;
};
type Thread = Ticket & { messages: Message[] };
type Staff = { id: string; name: string };

const CATEGORIES = ['account', 'funding', 'trading', 'kyc', 'technical', 'other'] as const;
const when = (iso: string) => new Date(iso).toLocaleString();

const STATUS: Record<string, string> = {
  open: 'bg-ember text-graphite',
  pending: 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist',
  resolved: 'bg-bone text-slate-ink dark:bg-white/5 dark:text-mist',
  closed: 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist',
};
const PRIORITY: Record<string, string> = {
  urgent: 'rounded-full bg-ember px-2 py-0.5 text-xs font-medium text-graphite', high: 'font-medium text-obsidian dark:text-vellum', normal: '', low: 'text-mist',
};

const Badge = ({ status }: { status: string }) =>
  <span className={`rounded-md px-2 py-0.5 text-xs ${STATUS[status] ?? ''}`}>{status}</span>;

// ------------------------------------------------------------------ client

/**
 * Support, as the client sees it.
 *
 * Whose turn it is leads, because that is the only thing somebody opening this page wants
 * to know: open means we are working on it, pending means it is back with them. A list
 * that shows five tickets without saying which of them is waiting on the reader is a list
 * that gets ignored.
 */
export function SupportPanel() {
  const tickets = useApi<Ticket[]>('/tickets');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (openId) {
    return <TicketThread id={openId} staff={false} onBack={() => { setOpenId(null); tickets.reload(); }} />;
  }

  const rows = tickets.data ?? [];
  const live = rows.filter((t) => t.status === 'open' || t.status === 'pending');
  const yours = rows.filter((t) => t.status === 'pending');
  const done = rows.filter((t) => t.status === 'resolved' || t.status === 'closed');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Support</PageTitle>
        <button className={`${btn} ml-auto`} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New ticket'}
        </button>
      </div>

      <div className={`${card} flex flex-wrap items-center gap-x-10 gap-y-3`}>
        <div>
          <p className="metric-label">Open with us</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">
            {live.length - yours.length}
          </p>
        </div>
        <div>
          <p className="metric-label">Waiting on you</p>
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${yours.length ? 'text-ember-ink' : ''}`}>
            {yours.length}
          </p>
        </div>
        <div>
          <p className="metric-label">Answered</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">{done.length}</p>
        </div>
        <p className="ml-auto max-w-xs text-xs text-slate-ink">
          Raise a ticket for anything that needs looking at. We answer in the thread, and
          you will get a notification when we do.
        </p>
      </div>

      {adding && <NewTicket onDone={() => { setAdding(false); tickets.reload(); }} />}

      {rows.length === 0 && !adding ? (
        <div className={`${card} py-10 text-center`}>
          <p className="text-sm font-medium text-obsidian dark:text-vellum">Nothing open</p>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-ink">
            Anything at all — a deposit that has not arrived, a document that will not
            upload, a question about a rate. It reaches the desk straight away.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((t) => (
            <li key={t.id}>
              <button onClick={() => setOpenId(t.id)}
                className="block w-full rounded-lg border border-pebble bg-bone/50 p-4 text-left transition-colors hover:border-ember/60 dark:border-white/10 dark:bg-white/5">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md font-mono text-[10px] uppercase ${
                    t.status === 'pending'
                      ? 'bg-ember/15 text-ember-ink'
                      : 'bg-bone text-slate-ink dark:bg-white/5'}`} aria-hidden>
                    {t.category.slice(0, 3)}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t.subject}</span>
                    <span className={`block text-xs text-slate-ink ${mono}`}>
                      {t.messages} message{t.messages === 1 ? '' : 's'} · {when(t.last_message_at ?? t.created_at)}
                    </span>
                  </span>
                  <span className="ml-auto flex items-center gap-3">
                    {/* Whose turn it is, said in words. "Pending" is our word for it and
                        means nothing to the person waiting. */}
                    <span className="hidden text-xs text-slate-ink sm:inline">
                      {t.status === 'open' ? 'With us'
                        : t.status === 'pending' ? 'Waiting on you'
                        : ''}
                    </span>
                    <Badge status={t.status} />
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewTicket({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form className={`${card} space-y-4`} onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      setBusy(true);
      setError(null);
      try {
        await api('/tickets', { method: 'POST', body: JSON.stringify({
          subject: f.get('subject'), category: f.get('category'), body: f.get('body') }) });
        onDone();
      } catch (err) {
        setError((err as Error).message);
      } finally { setBusy(false); }
    }}>
      <h3 className="metric-label">New ticket</h3>

      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <label className="block">
          <span className="metric-label">Subject</span>
          <input name="subject" required maxLength={200} placeholder="What is the problem?"
            className={`${field} mt-1 w-full`} />
        </label>
        <label className="block">
          <span className="metric-label">About</span>
          <select name="category" className={`${field} mt-1 w-full`} defaultValue="other">
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="metric-label">What happened</span>
        <textarea name="body" required maxLength={5000} rows={5}
          placeholder="As much as you can — what you did, what you expected, what happened instead."
          className={`${input} mt-1`} />
      </label>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      <div className="flex flex-wrap items-center gap-3 border-t border-pebble pt-4 dark:border-white/10">
        <button className={btn} disabled={busy}>{busy ? 'Sending…' : 'Raise ticket'}</button>
        <span className="text-xs text-slate-ink">It reaches the desk straight away.</span>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------- staff

/**
 * The support desk: every ticket, and which of them are waiting on us.
 *
 * "Live" leads because it is the working view — open and pending together, everything not
 * yet finished. The distinction that matters inside it is whose turn it is: open means the
 * client is waiting on us, pending means we are waiting on them, and a queue that does not
 * separate those two is a queue where the second kind quietly buries the first.
 */

/** How long since something last moved, as a person reads it. */
function since(iso: string): string {
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

const FILTERS = [
  { id: 'live', label: 'Live', note: 'Open and pending' },
  { id: 'open', label: 'Open', note: 'Waiting on us' },
  { id: 'pending', label: 'Pending', note: 'Waiting on the client' },
  { id: 'resolved', label: 'Resolved', note: 'Answered' },
  { id: 'closed', label: 'Closed', note: 'Done' },
] as const;

export function SupportQueue({ role }: { role?: string }) {
  const [status, setStatus] = useState<string>('live');
  const tickets = useApi<Ticket[]>(`/tickets?status=${status}`);
  const live = useApi<Ticket[]>('/tickets?status=live');
  const [openId, setOpenId] = useState<string | null>(null);
  const canReply = role !== 'compliance';

  if (openId) {
    return (
      <div className="mx-auto max-w-3xl">
        <TicketThread id={openId} staff canReply={canReply}
          onBack={() => { setOpenId(null); tickets.reload(); live.reload(); }} />
      </div>
    );
  }

  const rows = tickets.data ?? [];
  const all = live.data ?? [];
  const ours = all.filter((t) => t.status === 'open');
  const urgent = all.filter((t) => t.priority === 'high' || t.priority === 'urgent').length;
  // Oldest first, so the longest-waiting ticket is the one the figure describes.
  const waiting = [...ours].sort((a, b) => +new Date(a.updated_at) - +new Date(b.updated_at))[0];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Support</PageTitle>
        {!canReply && (
          <span className="rounded-full bg-bone px-2.5 py-0.5 font-mono text-[11px] tracking-wide text-slate-ink uppercase dark:bg-white/10">
            read only
          </span>
        )}
      </div>

      <div className={`${card} flex flex-wrap items-center gap-x-10 gap-y-3`}>
        <div>
          <p className="metric-label">Waiting on us</p>
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${ours.length ? 'text-ember-ink' : ''}`}>
            {ours.length}
          </p>
        </div>
        <div>
          <p className="metric-label">Longest wait</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">
            {waiting ? since(waiting.updated_at) : '—'}
          </p>
        </div>
        <div>
          <p className="metric-label">Live tickets</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">{all.length}</p>
        </div>
        <div>
          <p className="metric-label">High priority</p>
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${urgent ? 'text-ember-ink' : ''}`}>
            {urgent}
          </p>
        </div>
        <p className="ml-auto max-w-xs text-xs text-slate-ink">
          A ticket is open while the client is waiting on us and pending once we have
          replied. Their answer reopens it.
        </p>
      </div>

      <div role="tablist" aria-label="Ticket status" className="flex flex-wrap gap-1 text-xs">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={status === f.id} onClick={() => setStatus(f.id)}
            title={f.note}
            className={`rounded-md px-3 py-1.5 transition-colors ${status === f.id
              ? 'bg-ember font-medium text-graphite'
              : 'bg-bone text-slate-ink hover:text-obsidian dark:bg-white/10 dark:text-mist dark:hover:text-vellum'}`}>
            {f.label}
          </button>
        ))}
        <span className="ml-2 self-center text-slate-ink">
          {FILTERS.find((f) => f.id === status)?.note}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className={`${card} py-10 text-center`}>
          <p className="text-sm font-medium text-obsidian dark:text-vellum">
            {status === 'live' ? 'No live tickets' : `Nothing ${status}`}
          </p>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-ink">
            Clients raise tickets from their own support page. Whatever they send lands
            here, and replying moves it to pending until they answer.
          </p>
        </div>
      ) : (
        <div className={`${tableCard} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>{['Subject', 'Client', 'Category', 'Priority', 'Status', 'Assigned', 'Last moved'].map((h) =>
                <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} onClick={() => setOpenId(t.id)}
                  className="cursor-pointer border-t border-pebble hover:bg-bone dark:border-white/10 dark:hover:bg-white/5">
                  <td className="px-3 py-2 font-medium">{t.subject}</td>
                  <td className="px-3 py-2 text-ember-ink">{t.client_name}</td>
                  <td className="px-3 py-2 text-slate-ink">{t.category}</td>
                  <td className={`px-3 py-2 ${PRIORITY[t.priority] ?? ''}`}>{t.priority}</td>
                  <td className="px-3 py-2"><Badge status={t.status} /></td>
                  <td className="px-3 py-2 text-slate-ink">{t.assignee_name ?? 'Unassigned'}</td>
                  <td className={`px-3 py-2 text-xs text-slate-ink ${mono}`}>
                    {since(t.updated_at)} ago
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ thread

function TicketThread({ id, staff, canReply = true, onBack }: {
  id: string; staff: boolean; canReply?: boolean; onBack: () => void;
}) {
  const thread = useApi<Thread>(`/tickets/${id}`);
  const people = useApi<Staff[]>(staff ? '/staff' : null);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = thread.data;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/tickets/${id}/messages`, { method: 'POST', body: JSON.stringify({ body, internal }) });
      setBody('');
      setInternal(false);
      thread.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  const update = async (patch: Record<string, unknown>) => {
    await api(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    thread.reload();
  };

  if (!t) return <p className="text-sm text-slate-ink">Loading…</p>;

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-xs text-slate-ink hover:text-obsidian dark:hover:text-vellum">
        ← back
      </button>

      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-medium">{t.subject}</h3>
        <Badge status={t.status} />
        <span className="text-xs text-slate-ink">{t.category}</span>
        {staff && <span className="text-xs text-slate-ink">· {t.client_name}</span>}
      </div>

      {staff && canReply && (
        <div className="flex flex-wrap gap-2 text-xs">
          <select className={`${field} w-28`} value={t.status} onChange={(e) => update({ status: e.target.value })}>
            {['open', 'pending', 'resolved', 'closed'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <select className={`${field} w-28`} value={t.priority} onChange={(e) => update({ priority: e.target.value })}>
            {['low', 'normal', 'high', 'urgent'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <select className={`${field} w-40`} value={t.assigned_to ?? ''}
            onChange={(e) => update({ assigned_to: e.target.value || null })}>
            <option value="">Unassigned</option>
            {people.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}

      <ol className="space-y-2">
        {t.messages.map((m) => (
          <li key={m.id}
            className={`rounded-md p-2 text-sm ${m.internal
              ? 'border border-dashed border-ember bg-bone dark:bg-white/10'
              : m.author_kind === 'staff'
                ? 'bg-bone dark:bg-white/10'
                : 'bg-vellum dark:bg-onyx'}`}>
            <p className="text-xs text-slate-ink">
              {m.internal && <span className="font-medium text-obsidian dark:text-vellum">internal note · </span>}
              {m.author_name ?? m.author_kind} · {when(m.created_at)}
            </p>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ol>

      {canReply && t.status !== 'closed' && (
        <form onSubmit={send} className="space-y-2">
          <textarea className={input} rows={3} required maxLength={5000} value={body}
            placeholder={internal ? 'Note for colleagues — the client will not see this' : 'Reply…'}
            onChange={(e) => setBody(e.target.value)} />
          <div className="flex items-center gap-3">
            <button className={btn} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
            {staff && (
              <label className="flex items-center gap-1 text-xs text-slate-ink">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                internal note (hidden from the client)
              </label>
            )}
          </div>
        </form>
      )}
      {t.status === 'closed' && <p className="text-sm text-slate-ink">This ticket is closed.</p>}
      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
    </div>
  );
}
