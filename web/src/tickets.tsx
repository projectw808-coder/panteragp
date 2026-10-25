import { useEffect, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ChartCandlestick, ChevronRight, CircleCheck, Headset, MessageCircle, MessagesSquare, Plus, Reply, Send,
  ShieldCheck, User, Wallet as WalletIcon, Wrench,
} from 'lucide-react';
import { alertBox, btn, card, field, input, mono, PageTitle, tableCard, thead } from './App.tsx';
import { api, useApi } from './api.ts';
import { StatTile } from './x-shell.tsx';

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

const CATEGORY_ICON: Record<string, typeof User> = {
  account: User, funding: WalletIcon, trading: ChartCandlestick, kyc: ShieldCheck, technical: Wrench, other: MessageCircle,
};

/** The client's words for where a thread stands — whose turn it is, not the desk's status. */
const CLIENT_STATUS: Record<string, { label: string; badge: string }> = {
  open: { label: 'With us', badge: 'is-locked' },
  pending: { label: 'Your reply', badge: 'is-warn' },
  resolved: { label: 'Answered', badge: '' },
  closed: { label: 'Closed', badge: 'is-muted' },
};

const VIEWS = [['all', 'All'], ['live', 'Open'], ['yours', 'Waiting on you'], ['done', 'Answered']] as const;

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
  const [view, setView] = useState<(typeof VIEWS)[number][0]>('all');

  if (openId) {
    return <TicketThread id={openId} staff={false} onBack={() => { setOpenId(null); tickets.reload(); }} />;
  }

  const rows = tickets.data ?? [];
  const live = rows.filter((t) => t.status === 'open' || t.status === 'pending');
  const yours = rows.filter((t) => t.status === 'pending');
  const done = rows.filter((t) => t.status === 'resolved' || t.status === 'closed');
  const shown = view === 'live' ? live : view === 'yours' ? yours : view === 'done' ? done : rows;
  const count = { all: rows.length, live: live.length, yours: yours.length, done: done.length };

  const raise = (category: string) => { setAbout(category); setAdding(true); scrollTo({ top: 0, behavior: 'smooth' }); };

  return (
    <div className="stagger space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Support</PageTitle>
        <span className="x-badge"><i className="nav-live mr-1.5 block size-1.5 rounded-full bg-up" aria-hidden />The desk answers in the thread</span>
        <button className={`${btn} ml-auto inline-flex items-center gap-2`} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : <><Plus size={16} aria-hidden />New ticket</>}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Open threads" Icon={MessagesSquare} value={live.length}
          note={live.length ? 'Not finished yet' : 'Nothing open right now'} />
        <StatTile label="Waiting on you" Icon={Reply} value={yours.length} tone={yours.length ? 'text-ember-ink' : ''}
          note={yours.length ? 'We answered — your reply moves it on' : 'Nothing needs your reply'} />
        <StatTile label="With us" Icon={Headset} value={live.length - yours.length}
          note={live.length - yours.length ? 'You get a notification when we answer' : 'Nothing waiting on the desk'} />
        <StatTile label="Answered" Icon={CircleCheck} value={done.length} tone={done.length ? 'text-up' : ''}
          note={`${rows.length} thread${rows.length === 1 ? '' : 's'} in all`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {adding && <NewTicket about={about} onDone={() => { setAdding(false); tickets.reload(); }} />}

          <div className="x-card x-holo space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="section-title">Your threads</h2>
              <span className="text-xs text-slate-ink">most recently answered first</span>
              <div className="x-qgroups ml-auto w-full sm:w-auto" role="tablist">
                {VIEWS.map(([k, label]) => (
                  <button key={k} type="button" role="tab" aria-selected={view === k} className={`!px-3 whitespace-nowrap ${view === k ? 'is-on' : ''}`}
                    onClick={() => setView(k)}>{label}{count[k] ? ` · ${count[k]}` : ''}</button>
                ))}
              </div>
            </div>

            {!tickets.data && <div className="skeleton h-24 rounded-lg" />}

            {tickets.data && shown.length === 0 && (
              <div className="grid place-items-center gap-2 py-10 text-center">
                <span className="x-drop-icon" aria-hidden><MessagesSquare size={24} /></span>
                <p className="text-[15px] font-semibold">{rows.length ? 'Nothing here' : 'No threads yet'}</p>
                <p className="max-w-sm text-xs text-slate-ink">
                  Anything at all — a deposit that has not arrived, a document that will not
                  upload, a question about a rate. It reaches the desk straight away.
                </p>
                {!adding && <button type="button" className="x-btn-sm mt-2" onClick={() => setAdding(true)}>Raise a ticket</button>}
              </div>
            )}

            <ul className="space-y-2">
              {shown.map((t) => {
                const Icon = CATEGORY_ICON[t.category] ?? MessageCircle;
                const st = CLIENT_STATUS[t.status] ?? { label: t.status, badge: 'is-muted' };
                return (
                  <li key={t.id}>
                    {/* The one waiting on you is lifted out of the list rather than told apart
                        by a status word: "pending" is the desk's word for it and means nothing
                        to the person it is waiting on. */}
                    <button type="button" onClick={() => setOpenId(t.id)}
                      className={`x-wallet-row lift focus-ring w-full text-left ${t.status === 'pending' ? '!border-ember/60 !bg-ember/[0.07]' : ''}`}>
                      <span className="x-chip" aria-hidden><Icon size={17} strokeWidth={1.9} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold">{t.subject}</span>
                        <span className="block text-xs text-slate-ink">
                          {ABOUT[t.category]?.name ?? t.category} · {t.messages} message{t.messages === 1 ? '' : 's'} · {ago(t.last_message_at ?? t.created_at)}
                        </span>
                      </span>
                      <span className={`x-badge ${st.badge}`}>{st.label}</span>
                      <ChevronRight size={16} className="text-mist" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="space-y-4">
          <Shelf onPick={raise} />
          <div className="x-card x-holo space-y-4 p-5">
            <h2 className="section-title">How support works</h2>
            <ol className="space-y-4">
              {([
                ['Raise a ticket', 'Pick what it is about and say what happened. It reaches the desk straight away.'],
                ['We answer in the thread', 'You get a notification on the bell as soon as the desk replies.'],
                ['Reply or let it close', 'Answer in the same thread until it is sorted — the history stays here.'],
              ] as const).map(([t, d], i) => (
                <li key={t} className="flex gap-3">
                  <span className="x-step" aria-hidden>{i + 1}</span>
                  <span><span className="block text-[15px] font-semibold">{t}</span><span className="block text-xs text-slate-ink">{d}</span></span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

/** How long ago, as a person reads it; a date once it is more than a week old. */
function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * What a ticket can be about, and what belongs in each.
 *
 * The categories existed only inside the new-ticket dropdown, which answers "what are my
 * options" to somebody already filling the form and nothing to somebody deciding whether
 * this page is the right place at all. Picking one opens the form with it already set.
 */
function Shelf({ onPick }: { onPick: (category: string) => void }) {
  return (
    <div className="x-card space-y-3 p-5">
      <div>
        <h2 className="section-title">What we can help with</h2>
        <p className="mt-1 text-xs text-slate-ink">Pick one to start a ticket. Anything that does not fit goes under the last.</p>
      </div>
      <ul className="space-y-1.5">
        {CATEGORIES.map((c) => {
          const Icon = CATEGORY_ICON[c] ?? MessageCircle;
          return (
            <li key={c}>
              <button type="button" onClick={() => onPick(c)} className="x-help-row focus-ring">
                <span className="x-chip" aria-hidden><Icon size={17} strokeWidth={1.9} /></span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block text-[14px] font-semibold">{ABOUT[c].name}</span>
                  <span className="block text-xs text-slate-ink">{ABOUT[c].note}</span>
                </span>
                <ArrowRight size={15} className="x-help-go" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NewTicket({ about, onDone }: { about: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState(about);
  useEffect(() => setCategory(about), [about]);

  return (
    <form className="x-card x-holo space-y-4 p-5" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      setBusy(true);
      setError(null);
      try {
        await api('/tickets', { method: 'POST', body: JSON.stringify({
          subject: f.get('subject'), category, body: f.get('body') }) });
        onDone();
      } catch (err) {
        setError((err as Error).message);
      } finally { setBusy(false); }
    }}>
      <div>
        <h3 className="section-title">New ticket</h3>
        <p className="mt-1 text-xs text-slate-ink">What it is about</p>
      </div>
      {/* The categories as buttons rather than a dropdown: six choices fit on one glance. */}
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="What it is about">
        {CATEGORIES.map((c) => {
          const Icon = CATEGORY_ICON[c] ?? MessageCircle;
          return (
            <button key={c} type="button" role="radio" aria-checked={category === c} onClick={() => setCategory(c)}
              className={`x-btn-sm inline-flex items-center gap-1.5 ${category === c ? 'is-on' : ''}`}>
              <Icon size={14} aria-hidden />{ABOUT[c].name}
            </button>
          );
        })}
      </div>

      <label className="block">
        <span className="metric-label">Subject</span>
        <input name="subject" required maxLength={200} placeholder="What is the problem?"
          className={`${field} mt-1 w-full`} />
      </label>

      <label className="block">
        <span className="metric-label">What happened</span>
        <textarea name="body" required maxLength={5000} rows={5}
          placeholder="As much as you can — what you did, what you expected, what happened instead."
          className={`${input} mt-1`} />
      </label>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-4">
        <button className={`${btn} inline-flex items-center gap-2`} disabled={busy}><Send size={15} aria-hidden />{busy ? 'Sending…' : 'Raise ticket'}</button>
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

  if (!t) return <div className="skeleton h-40 rounded-lg" />;

  const Icon = CATEGORY_ICON[t.category] ?? MessageCircle;
  const st = staff ? null : CLIENT_STATUS[t.status];

  return (
    <div className="stagger space-y-4">
      <button type="button" onClick={onBack} className="x-btn-sm inline-flex items-center gap-1.5">
        <ArrowLeft size={14} aria-hidden />{staff ? 'Back to the queue' : 'All threads'}
      </button>

      <div className="x-card x-holo flex flex-wrap items-center gap-3 p-5">
        <span className="x-chip" aria-hidden><Icon size={18} strokeWidth={1.9} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[18px] font-semibold">{t.subject}</h2>
          <p className="text-xs text-slate-ink">
            {ABOUT[t.category]?.name ?? t.category}
            {staff && <> · {t.client_name}</>}
            {' · '}opened {new Date(t.created_at).toLocaleDateString()} · {t.messages.length} message{t.messages.length === 1 ? '' : 's'}
          </p>
        </div>
        {st ? <span className={`x-badge ${st.badge}`}>{st.label}</span> : <Badge status={t.status} />}
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

      <div className="x-card space-y-4 p-5">
        <ol className="space-y-3">
          {t.messages.map((m) => {
            // The reader's own messages sit on the right, the other side's on the left.
            const mine = staff ? m.author_kind === 'staff' : m.author_kind === 'client';
            return (
              <li key={m.id} className={`flex ${m.author_kind === 'system' ? 'justify-center' : mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`x-msg ${m.internal ? 'is-note' : m.author_kind === 'system' ? 'is-system' : mine ? 'is-mine' : ''}`}>
                  <p className="mb-1 text-[11.5px] text-mist">
                    {m.internal && <span className="font-semibold text-ember-ink">Internal note · </span>}
                    <span className="font-semibold">{m.author_name ?? (m.author_kind === 'staff' ? 'Pantera GP desk' : m.author_kind)}</span> · {when(m.created_at)}
                  </p>
                  <p className="text-[14px] whitespace-pre-wrap">{m.body}</p>
                </div>
              </li>
            );
          })}
        </ol>

        {canReply && t.status !== 'closed' && (
          <form onSubmit={send} className="space-y-3 border-t border-white/10 pt-4">
            <textarea className={input} rows={3} required maxLength={5000} value={body}
              placeholder={internal ? 'Note for colleagues — the client will not see this' : 'Write a reply…'}
              onChange={(e) => setBody(e.target.value)} />
            <div className="flex flex-wrap items-center gap-3">
              <button className={`${btn} inline-flex items-center gap-2`} disabled={busy}><Send size={15} aria-hidden />{busy ? 'Sending…' : 'Send reply'}</button>
              {staff && (
                <label className="flex items-center gap-1 text-xs text-slate-ink">
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                  internal note (hidden from the client)
                </label>
              )}
            </div>
          </form>
        )}
        {t.status === 'closed' && <p className="border-t border-white/10 pt-4 text-sm text-slate-ink">This thread is closed. Raise a new ticket if anything else comes up.</p>}
        {error && <p role="alert" className={alertBox}>{error}</p>}
      </div>
    </div>
  );
}
