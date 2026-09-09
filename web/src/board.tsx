import { useState } from 'react';
import { alertBox, card } from './App.tsx';
import { api, useApi, type Task, type TaskStatus } from './api.ts';

/**
 * The task list as a board.
 *
 * Four columns and nothing else: what has not been started, what is being worked on now,
 * what is stuck waiting on somebody, and what is finished. Cancelling is a card action
 * rather than a fifth column — a column nobody wants to look at still takes a quarter of
 * the screen.
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

export function TaskBoard() {
  // 'all' rather than four requests: the board is one view of one set of rows.
  const tasks = useApi<Task[]>('/tasks?status=all&scope=all');
  const [mine, setMine] = useState(false);
  const [me] = useState<string | null>(() => {
    try { return JSON.parse(atob((localStorage.getItem('auth.token') ?? '..').split('.')[1] ?? '')).sub ?? null; }
    catch { return null; }
  });
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = (tasks.data ?? []).filter((t) => t.status !== 'cancelled' && (!mine || t.assigned_to === me));

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
        <h1 className="font-display text-[28px] leading-none tracking-tight">Tasks</h1>
        <div className="ml-auto flex gap-1 rounded-full bg-bone p-0.5 text-xs dark:bg-white/10">
          {([['Everyone', false], ['Mine', true]] as const).map(([label, on]) => (
            <button key={label} onClick={() => setMine(on)} aria-pressed={mine === on}
              className={`rounded-full px-3 py-1 font-mono transition-colors ${mine === on
                ? 'bg-ember text-graphite'
                : 'text-slate-ink hover:text-obsidian dark:text-mist dark:hover:text-vellum'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

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
      {tasks.data?.length === 0 && <p className="text-sm text-slate-ink">No tasks yet.</p>}
    </div>
  );
}

function Card({ t, onMove, onDragStart, onDragEnd }: {
  t: Task; onMove: (id: number, status: TaskStatus) => void;
  onDragStart: () => void; onDragEnd: () => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <article draggable onDragStart={onDragStart} onDragEnd={onDragEnd}
      className="cursor-grab rounded-md border border-pebble bg-vellum p-2.5 active:cursor-grabbing dark:border-white/10 dark:bg-white/5">
      <p className="text-sm leading-snug font-medium">{t.title}</p>
      <a href={`#/clients/${t.client_id}`} className="mt-1 block text-xs text-ember hover:underline">
        {t.client_name}
      </a>
      <p className="mt-1 font-mono text-[11px] text-slate-ink">
        {t.assignee_name}
        {t.due_at && (
          <span className={overdue(t) ? 'text-down' : ''}> · due {when(t.due_at)}</span>
        )}
      </p>

      <div className="mt-2 flex flex-wrap gap-1">
        {/* The same moves as the drag, reachable from a keyboard. */}
        {COLUMNS.filter((c) => c.status !== t.status).map((c) => (
          <button key={c.status} onClick={() => onMove(t.id, c.status)}
            className="rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-slate-ink uppercase hover:bg-pebble hover:text-obsidian dark:hover:bg-white/10 dark:hover:text-vellum">
            {c.title}
          </button>
        ))}
        <button onClick={() => (menu ? onMove(t.id, 'cancelled') : setMenu(true))}
          className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase text-slate-ink hover:text-down">
          {menu ? 'sure?' : 'cancel'}
        </button>
      </div>
    </article>
  );
}
