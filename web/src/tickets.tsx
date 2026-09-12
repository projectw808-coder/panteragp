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

/**
 * What each category is for, in the reader's words rather than ours.
 *
 * "kyc" is an industry initialism and names nothing to the person choosing it; the rest
 * are one-word column values that say what a ticket is filed under and not what belongs
 * in it. The stored value is unchanged — this is only how it is read aloud.
 */
const ABOUT: Record<string, { name: string; note: string }> = {
  account: { name: 'Account', note: 'Your email, your sign-in, closing the account.' },
  funding: { name: 'Funding', note: 'A deposit that has not landed, a withdrawal still waiting.' },
  trading: { name: 'Trading', note: 'A position, a rate, a portfolio or a stake.' },
  kyc: { name: 'Verification', note: 'A document rejected, or one that will not upload.' },
  technical: { name: 'Technical', note: 'Something on the platform is not doing what it should.' },
  other: { name: 'Something else', note: 'Anything at all. It reaches the desk the same way.' },
};

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
  const [about, setAbout] = useState<string>('other');

  if (openId) {
    return <TicketThread id={openId} staff={false} onBack={() => { setOpenId(null); tickets.reload(); }} />;
  }

  const rows = tickets.data ?? [];
  const live = rows.filter((t) => t.status === 'open' || t.status === 'pending');
  const yours = rows.filter((t) => t.status === 'pending');
  const done = rows.filter((t) => t.status === 'resolved' || t.status === 'closed');

  const raise = (category: string) => { setAbout(category); setAdding(true); };

  return (
    <div className="stagger space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Support</PageTitle>
        <button className={`${btn} ml-auto`} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New ticket'}
        </button>
      </div>

      <Turn live={live.length} yours={yours.length} done={done.length} />

      {adding && (
        <NewTicket about={about} onDone={() => { setAdding(false); tickets.reload(); }} />
      )}

      {rows.length === 0 && !adding ? (
        <div className={`${card} py-10 text-center`}>
          <p className="text-sm font-medium text-obsidian dark:text-vellum">Nothing open</p>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-ink">
            Anything at all — a deposit that has not arrived, a document that will not
            upload, a question about a rate. It reaches the desk straight away.
          </p>
        </div>
      ) : (
        <div className={`${card} space-y-3`}>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="section-title">Your threads</h2>
            <span className="ml-auto text-xs text-slate-ink">most recently answered first</span>
          </div>

          <ul className="space-y-2">
            {rows.map((t) => (
              <li key={t.id}>
                {/* The one waiting on you is lifted out of the list rather than told apart
                    by a status word: "pending" is the desk's word for it and means nothing
                    to the person it is waiting on. */}
                <button onClick={() => setOpenId(t.id)}
                  className={`lift focus-ring block w-full rounded-lg p-4 text-left transition-colors ${
                    t.status === 'pending'
                      ? 'border border-ember/45 bg-ember/[0.06]'
                      : 'border border-pebble bg-bone/50 hover:border-ember/60 dark:border-white/10 dark:bg-white/5'}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full font-mono text-[10px] tracking-wide uppercase ${
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
                      {/* Whose turn it is, said in words. */}
                      <span className={`hidden text-xs sm:inline ${
                        t.status === 'pending' ? 'text-ember-ink' : 'text-slate-ink'}`}>
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
        </div>
      )}

      {!adding && <Shelf onPick={raise} />}
    </div>
  );
}

/**
 * Whose turn it is, as one ring.
 *
 * The three figures were a flat strip, which said what the numbers were and nothing about
 * how they relate. They are one quantity split two ways — the live threads, and which of
 * them the reader is holding up — so they are drawn that way: one ring, an ember arc for
 * yours and a grey one for ours. Answered sits beside it as a count, because it is a
 * different thing and does not belong in the same circle.
 */
function Turn({ live, yours, done }: { live: number; yours: number; done: number }) {
  const C = 163.36;                       // 2πr at r = 26
  const mine = live - yours;
  const share = live ? mine / live : 0;

  return (
    <div className={`${card} flex flex-wrap items-center gap-6`}>
      <span className="relative h-[62px] w-[62px] shrink-0" aria-hidden>
        <svg width="62" height="62" viewBox="0 0 62 62">
          <circle cx="31" cy="31" r="26" fill="none" strokeWidth="5"
            className="stroke-slate-ink/20" />
          {live > 0 && (
            <>
              <circle cx="31" cy="31" r="26" fill="none" strokeWidth="5" stroke="currentColor"
                className="text-slate-ink" transform="rotate(-90 31 31)"
                strokeDasharray={C} strokeDashoffset={C * (1 - share)} />
              <circle className="ring-draw text-ember" cx="31" cy="31" r="26" fill="none" strokeWidth="5"
                stroke="currentColor" transform={`rotate(${share * 360 - 90} 31 31)`}
                strokeDasharray={C} strokeDashoffset={C * share} />
            </>
          )}
        </svg>
        <span className="absolute inset-0 grid place-items-center font-mono text-sm font-medium tabular-nums">
          {live}
        </span>
      </span>

      <div className="min-w-0 flex-1">
        <h2 className="section-title">Open threads</h2>
        <p className="mt-2 max-w-md text-xs text-slate-ink">
          {live === 0
            ? 'Nothing open. Raise a ticket for anything that needs looking at — we answer in the thread and you get a notification when we do.'
            : yours === 0
              ? 'All of them are with us. You will get a notification when we answer.'
              : `${yours === live ? 'All' : yours} of them ${yours === 1 ? 'is' : 'are'} back with you — we have answered and are waiting on your reply.`}
        </p>
      </div>

      <dl className="w-full space-y-2.5 sm:w-56">
        <Split tone="bg-slate-ink" label="With us" n={mine} />
        <Split tone="bg-ember" label="Waiting on you" n={yours} ember={yours > 0} />
        <Split tone="bg-slate-ink/20" label="Answered" n={done} quiet />
      </dl>
    </div>
  );
}

const Split = ({ tone, label, n, ember, quiet }: {
  tone: string; label: string; n: number; ember?: boolean; quiet?: boolean;
}) => (
  <div className="flex items-center gap-2.5">
    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone}`} aria-hidden />
    <dt className={`text-sm ${quiet ? 'text-slate-ink' : 'font-medium'}`}>{label}</dt>
    <dd className={`ml-auto font-mono text-base font-medium tabular-nums ${
      ember ? 'text-ember-ink' : quiet ? 'text-slate-ink' : ''}`}>
      {n}
    </dd>
  </div>
);

/**
 * What a ticket can be about, and what belongs in each.
 *
 * The categories existed only inside the new-ticket dropdown, which answers "what are my
 * options" to somebody already filling the form and nothing to somebody deciding whether
 * this page is the right place at all. Picking one opens the form with it already set.
 */
function Shelf({ onPick }: { onPick: (category: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="section-title">What we can help with</h2>
        <span className="text-xs text-slate-ink">
          anything that does not fit goes under the last one
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CATEGORIES.map((c) => (
          <button key={c} type="button" onClick={() => onPick(c)}
            className={`${card} tile lift grain focus-ring text-left`}>
            <span className="tile-corner" aria-hidden />
            <span className="flex items-center gap-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ember/15 font-mono text-[10px] tracking-wide text-ember-ink uppercase" aria-hidden>
                {c.slice(0, 3)}
              </span>
              <span className="block truncate text-sm font-medium">{ABOUT[c].name}</span>
            </span>
            <span className="mt-2 block text-xs text-slate-ink">{ABOUT[c].note}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NewTicket({ about, onDone }: { about: string; onDone: () => void }) {
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
      <h3 className="section-title">New ticket</h3>

      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <label className="block">
          <span className="metric-label">Subject</span>
          <input name="subject" required maxLength={200} placeholder="What is the problem?"
            className={`${field} mt-1 w-full`} />
        </label>
        <label className="block">
          <span className="metric-label">About</span>
          {/* Keyed on the picked category so choosing another tile from the shelf while the
              form is open moves the select with it — a defaultValue alone would not. */}
          <select key={about} name="category" className={`${field} mt-1 w-full`} defaultValue={about}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{ABOUT[c].name}</option>)}
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
    <div className="stagger mx-auto max-w-5xl space-y-4">
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
            className={`rounded-full px-3 py-1.5 transition-colors ${status === f.id
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
