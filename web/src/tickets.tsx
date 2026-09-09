import { useState } from 'react';
import { alertBox, btn, card, field, input, tableCard, thead } from './App.tsx';
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

/** The client's own tickets: raise one, read the thread, reply. */
export function SupportPanel() {
  const tickets = useApi<Ticket[]>('/tickets');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (openId) {
    return <TicketThread id={openId} staff={false} onBack={() => { setOpenId(null); tickets.reload(); }} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-slate-ink">Support</h3>
        <button className={btn} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New ticket'}
        </button>
      </div>

      {adding && <NewTicket onDone={() => { setAdding(false); tickets.reload(); }} />}

      {tickets.data?.map((t) => (
        <button key={t.id} onClick={() => setOpenId(t.id)}
          className="block w-full rounded-md border border-pebble p-3 text-left hover:border-ember dark:border-white/10 dark:hover:border-ember">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium">{t.subject}</span>
            <Badge status={t.status} />
            <span className="ml-auto text-xs text-slate-ink">
              {t.messages} message{t.messages === 1 ? '' : 's'} · {when(t.last_message_at ?? t.created_at)}
            </span>
          </div>
          <p className="text-xs text-slate-ink">{t.category}</p>
        </button>
      ))}
      {tickets.data?.length === 0 && !adding && (
        <p className="text-sm text-slate-ink">No tickets. Raise one if something needs looking at.</p>
      )}
    </div>
  );
}

function NewTicket({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form className={`${card} space-y-2`} onSubmit={async (e) => {
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
      <div className="flex gap-2">
        <input name="subject" required maxLength={200} placeholder="What is the problem?"
          className={`${field} flex-1`} />
        <select name="category" className={`${field} w-32`} defaultValue="other">
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <textarea name="body" required maxLength={5000} rows={4} placeholder="Tell us what happened…"
        className={input} />
      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
      <button className={btn} disabled={busy}>{busy ? 'Sending…' : 'Raise ticket'}</button>
    </form>
  );
}

// ------------------------------------------------------------------- staff

/** The queue: everything waiting on us, worst first. */
export function SupportQueue({ role }: { role?: string }) {
  const [status, setStatus] = useState('live');
  const tickets = useApi<Ticket[]>(`/tickets?status=${status}`);
  const [openId, setOpenId] = useState<string | null>(null);
  const canReply = role !== 'compliance';

  if (openId) {
    return (
      <div className="mx-auto max-w-3xl">
        <TicketThread id={openId} staff canReply={canReply} onBack={() => { setOpenId(null); tickets.reload(); }} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex gap-1 text-xs">
        {['live', 'open', 'pending', 'resolved', 'closed'].map((s) => (
          <button key={s} onClick={() => setStatus(s)} aria-pressed={status === s}
            className={`rounded-md px-3 py-1 ${status === s
              ? 'bg-ember font-medium text-graphite'
              : 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'}`}>
            {s}
          </button>
        ))}
      </div>

      <div className={`${tableCard} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>{['Subject', 'Client', 'Category', 'Priority', 'Status', 'Assigned', 'Updated'].map((h) =>
              <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {tickets.data?.map((t) => (
              <tr key={t.id} onClick={() => setOpenId(t.id)}
                className="cursor-pointer border-t border-pebble hover:bg-bone dark:border-white/10 dark:hover:bg-white/5">
                <td className="px-3 py-2 font-medium">{t.subject}</td>
                <td className="px-3 py-2">{t.client_name}</td>
                <td className="px-3 py-2 text-slate-ink">{t.category}</td>
                <td className={`px-3 py-2 ${PRIORITY[t.priority] ?? ''}`}>{t.priority}</td>
                <td className="px-3 py-2"><Badge status={t.status} /></td>
                <td className="px-3 py-2 text-slate-ink">{t.assignee_name ?? '—'}</td>
                <td className="px-3 py-2 text-slate-ink">{when(t.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tickets.data?.length === 0 && <p className="p-4 text-sm text-slate-ink">Nothing here.</p>}
      </div>
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
