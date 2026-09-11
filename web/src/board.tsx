import { useState } from 'react';
import { alertBox, btn, card, field, PageTitle } from './App.tsx';
import { api, useApi, type Staff, type Task, type TaskStatus } from './api.ts';

/**
 * The task list as a board.
 *
 * Four columns and nothing else: what has not been started, what is being worked on now,
 * what is stuck waiting on somebody, and what is finished. Cancelling is a card action
 * rather than a fifth column — a column nobody wants to look at still takes a quarter of
 * the screen — and cancelled work is behind a toggle rather than gone, because "why did
 * that stop" is a question somebody asks eventually.
 *
 * Dragging is the fast path, not the only path. Every card also carries its moves as
 * buttons, because drag and drop is unusable with a keyboard, unreliable on a touchpad and
 * absent on a phone — a board you can only operate with a mouse is a board half the desk
 * cannot use.
 */

const COLUMNS: { status: TaskStatus; title: string; note: string }[] = [
  { status: 'open',        title: 'To do',       note: 'Not started' },
  { status: 'in_progress', title: 'In progress', note: 'Being worked on now' },
  { status: 'blocked',     title: 'Blocked',     note: 'Waiting on somebody' },
  { status: 'done',        title: 'Done',        note: 'Finished' },
];

const when = (iso: string) => new Date(iso).toLocaleDateString();
const overdue = (t: Task) => !!t.due_at && t.status !== 'done' && new Date(t.due_at) < new Date();

/** How near a due date is, in the words somebody would use out loud. */
function due(iso: string): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < -1) return `${-days} days late`;
  if (days === -1) return 'yesterday';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export function TaskBoard() {
  // 'all' rather than four requests: the board is one view of one set of rows.
  const tasks = useApi<Task[]>('/tasks?status=all&scope=all');
  const staff = useApi<Staff[]>('/staff');
  // Asked of the API rather than unpacked from the token in the browser: the token is a
  // credential, not a place to read your own identity out of.
  const me = useApi<{ sub: string; role: string }>('/me');

  const [who, setWho] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = tasks.data ?? [];
  const mine = who === 'me' ? me.data?.sub : who;
  const rows = all
    .filter((t) => (showCancelled ? true : t.status !== 'cancelled'))
    .filter((t) => !mine || t.assigned_to === mine);

  const live = rows.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const late = live.filter(overdue).length;
  const blocked = live.filter((t) => t.status === 'blocked').length;

  async function move(id: number, status: TaskStatus) {
    setError(null);
    try {
      await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      tasks.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Tasks</PageTitle>
        <button className={`${btn} ml-auto`} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New task'}
        </button>
      </div>

      <div className={`${card} flex flex-wrap items-center gap-x-10 gap-y-3`}>
        <div>
          <p className="metric-label">Open</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">{live.length}</p>
        </div>
        <div>
          <p className="metric-label">Overdue</p>
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${late ? 'text-down' : ''}`}>
            {late}
          </p>
        </div>
        <div>
          <p className="metric-label">Blocked</p>
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${blocked ? 'text-ember-ink' : ''}`}>
            {blocked}
          </p>
        </div>
        <div>
          <p className="metric-label">Done</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">
            {rows.filter((t) => t.status === 'done').length}
          </p>
        </div>
        <p className="ml-auto max-w-xs text-xs text-slate-ink">
          Drag a card between columns, or use the buttons on it. Either way the client's
          timeline records the move.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select className={`${field} w-44`} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Everyone</option>
          <option value="me">Mine</option>
          {staff.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs text-slate-ink">
          <input type="checkbox" checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)} />
          Include cancelled
        </label>
        <span className="ml-auto font-mono text-xs text-slate-ink">{rows.length} shown</span>
      </div>

      {adding && (
        <NewTask staff={staff.data ?? []} meId={me.data?.sub}
          onDone={() => { setAdding(false); tasks.reload(); }} />
      )}

      {error && <p role="alert" className={alertBox}>{error}</p>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => {
          const cards = rows.filter((t) => t.status === col.status);
          return (
            <section key={col.status}
              onDragOver={(e) => { e.preventDefault(); setOver(col.status); }}
              onDragLeave={() => setOver((v) => (v === col.status ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (dragging !== null) move(dragging, col.status);
                setDragging(null);
              }}
              className={`${card} min-h-48 space-y-2 transition-colors ${
                over === col.status ? 'border-ember bg-ember/5' : ''}`}>
              <div className="flex items-baseline gap-2">
                <h2 className="metric-label">{col.title}</h2>
                <span className="ml-auto font-mono text-xs tabular-nums text-slate-ink">{cards.length}</span>
              </div>
              {cards.length === 0 && <p className="text-xs text-slate-ink">{col.note}</p>}
              {cards.map((t) => (
                <Card key={t.id} t={t} onMove={move}
                  onDragStart={() => setDragging(t.id)} onDragEnd={() => setDragging(null)} />
              ))}
            </section>
          );
        })}
      </div>

      {!tasks.data && <p className="text-sm text-slate-ink">Loading…</p>}
      {tasks.data?.length === 0 && (
        <div className={`${card} py-10 text-center`}>
          <p className="text-sm font-medium text-obsidian dark:text-vellum">No tasks yet</p>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-ink">
            A task is a note to somebody about a client — chase a document, call them back,
            look at a flag. It shows on their board and on that client's timeline.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Raising one. Every task belongs to a client and to a person: an unassigned task on a
 * shared board is one nobody picks up, and a task with no client is a reminder rather
 * than work the desk can see the reason for.
 */
function NewTask({ staff, meId, onDone }: {
  staff: Staff[]; meId?: string; onDone: () => void;
}) {
  const [q, setQ] = useState('');
  const clients = useApi<{ id: string; name: string; email: string }[]>(
    `/clients?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          client_id: f.get('client_id'),
          assigned_to: f.get('assigned_to'),
          title: f.get('title'),
          ...(f.get('due_at') ? { due_at: f.get('due_at') } : {}),
        }),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-4`}>
      <div>
        <h2 className="metric-label">New task</h2>
        <p className="mt-1 text-xs text-slate-ink">
          It lands on the assignee's board, tells them, and goes on the client's timeline.
        </p>
      </div>

      <label className="block">
        <span className="metric-label">What needs doing</span>
        <input name="title" required maxLength={200} className={`${field} mt-1 w-full`}
          placeholder="Chase the proof of address" />
      </label>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block sm:col-span-2">
          <span className="metric-label">Client</span>
          <input className={`${field} mt-1 w-full`} placeholder="Search to narrow the list"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <select name="client_id" required className={`${field} mt-1 w-full`}>
            {clients.data?.map((c) => (
              <option key={c.id} value={c.id}>{c.name} — {c.email}</option>
            ))}
          </select>
        </label>
        <div className="space-y-3">
          <label className="block">
            <span className="metric-label">Assign to</span>
            <select name="assigned_to" required defaultValue={meId} className={`${field} mt-1 w-full`}>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="metric-label">Due (optional)</span>
            <input name="due_at" type="date" className={`${field} mt-1 w-full`} />
          </label>
        </div>
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      <div className="border-t border-pebble pt-4 dark:border-white/10">
        <button className={btn} disabled={busy || !clients.data?.length}>
          {busy ? 'Creating…' : 'Create task'}
        </button>
      </div>
    </form>
  );
}

function Card({ t, onMove, onDragStart, onDragEnd }: {
  t: Task; onMove: (id: number, status: TaskStatus) => void;
  onDragStart: () => void; onDragEnd: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const late = overdue(t);

  return (
    <article draggable onDragStart={onDragStart} onDragEnd={onDragEnd}
      className={`cursor-grab rounded-md border bg-vellum p-2.5 active:cursor-grabbing dark:bg-white/5 ${
        late ? 'border-down/50' : 'border-pebble dark:border-white/10'} ${
        t.status === 'cancelled' ? 'opacity-50' : ''}`}>
      <p className="text-sm leading-snug font-medium">{t.title}</p>
      <a href={`#/clients/${t.client_id}`} className="mt-1 block text-xs text-ember-ink hover:underline">
        {t.client_name}
      </a>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-slate-ink">
        <span>{t.assignee_name}</span>
        {t.due_at && (
          <span className={late ? 'font-medium text-down' : ''}>· {due(t.due_at)}</span>
        )}
      </p>
      {t.due_at && (
        <p className="font-mono text-[10px] text-slate-ink">{when(t.due_at)}</p>
      )}

      <div className="mt-2 flex flex-wrap gap-1">
        {/* The same moves as the drag, reachable from a keyboard. */}
        {COLUMNS.filter((c) => c.status !== t.status).map((c) => (
          <button key={c.status} onClick={() => onMove(t.id, c.status)}
            className="rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-slate-ink uppercase hover:bg-pebble hover:text-obsidian dark:hover:bg-white/10 dark:hover:text-vellum">
            {c.title}
          </button>
        ))}
        {t.status !== 'cancelled' && (
          <button onClick={() => (menu ? onMove(t.id, 'cancelled') : setMenu(true))}
            className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-slate-ink uppercase hover:text-down">
            {menu ? 'sure?' : 'cancel'}
          </button>
        )}
      </div>
    </article>
  );
}
