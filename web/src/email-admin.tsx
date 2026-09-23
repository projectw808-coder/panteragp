import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { alertBox, btn, card, field, PageTitle, tableCard, thead } from './App.tsx';
import { api, useApi } from './api.ts';

/**
 * The desk side of client email.
 *
 * The shape of this screen is the shape of the risk. Writing and sending are separate steps,
 * the test send is offered before the real one, and the button that reaches everybody states
 * the number it will reach and makes you type it back. None of that is ceremony: an email is
 * the only thing this application does that cannot be undone by pressing something else.
 *
 * A new email asks two questions before it shows a text box — what to send, and who gets
 * it — because those are the two decisions that shape everything after, and a box that
 * appears already full of the week's news makes the second one easy to forget.
 */

type Status = {
  configured: boolean; transport: 'postmark-api' | 'smtp' | null;
  host: string | null; port: number | null; secure: boolean | null;
  from: string | null; authenticated: boolean; eligible: number; opted_out: number;
  settings?: Record<string, boolean>; missing?: string[];
};

type Audience = 'all' | 'selected';

type Campaign = {
  id: string; kind: string; subject: string; status: string; created_at: string;
  started_at: string | null; finished_at: string | null;
  recipients: number; failures: number; created_by: string | null;
  audience: Audience; chosen: number | null;
};

/** A client as the picker sees them: enough to name them, and whether mail may go to them. */
type Chosen = { id: string; name: string; email: string | null; email_opt_out: boolean };

type Delivery = { status: string; email: string; error: string | null; sent_at: string; name: string };
type Full = Campaign & {
  body: string; eligible: number; deliveries: Delivery[];
  recipient_ids: string[] | null; chosen_clients: Chosen[];
};

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');

const ghost = 'rounded-full border border-pebble px-3 py-1.5 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum';

/** Can a campaign reach this person? The reason it cannot is shown, never guessed at. */
const cannot = (c: Chosen) => (!c.email ? 'no email address' : c.email_opt_out ? 'opted out' : null);

export function EmailAdmin({ admin }: { admin: boolean }) {
  const status = useApi<Status>('/admin/email/status');
  const list = useApi<Campaign[]>('/admin/campaigns');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState<string | null>(null);

  const refresh = () => { list.reload(); status.reload(); };

  async function verify() {
    setBusy(true); setError(null); setVerified(null);
    try {
      await api('/admin/email/verify', { method: 'POST' });
      setVerified('The mail server accepted the connection.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const s = status.data;

  return (
    <div className="stagger mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>Client email</PageTitle>
        {admin && s?.configured && (
          <button className={creating ? ghost : btn} onClick={() => { setCreating(!creating); setOpen(null); }}>
            {creating ? 'Cancel' : 'New email'}
          </button>
        )}
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      {verified && <p className={`${card} text-sm text-up`}>{verified}</p>}

      {/* Whether mail can go out at all, before offering a button that would fail. */}
      {!status.data ? <p className="text-sm text-slate-ink">Loading…</p> : !s?.configured ? (
        <div className={`${card} space-y-3`}>
          <p className="text-sm font-medium">
            Email is not configured{s?.missing?.length
              ? `: ${s.missing.join(' and ')} ${s.missing.length > 1 ? 'are' : 'is'} not set.`
              : '.'}
          </p>

          {/* Which names the process can actually see. Names and ticks only — what they are
              set to is a credential and never leaves the server. Without this the screen
              sends somebody to check five variables when four of them are already right. */}
          {s?.settings && (
            <div className="grid gap-1 sm:grid-cols-2">
              {Object.entries(s.settings).map(([name, present]) => (
                <span key={name} className="flex items-center gap-2 font-mono text-xs">
                  <span className={present ? 'text-up' : 'text-slate-ink'}>{present ? '✓' : '·'}</span>
                  <span className={present ? '' : 'text-slate-ink'}>{name}</span>
                  {!present && name === 'SMTP_FROM' && (
                    <span className="text-down">required</span>
                  )}
                  {!present && (name === 'POSTMARK_SERVER_TOKEN' || name === 'SMTP_HOST')
                    && !s.settings?.POSTMARK_SERVER_TOKEN && !s.settings?.SMTP_HOST && (
                    <span className="text-down">one of these</span>
                  )}
                </span>
              ))}
            </div>
          )}

          <p className="text-xs text-slate-ink">
            <code className="font-mono">SMTP_FROM</code> is the sender and is always needed.
            Then one way out: <code className="font-mono">POSTMARK_SERVER_TOKEN</code> sends over
            HTTPS and works on any host, or <code className="font-mono">SMTP_HOST</code> with{' '}
            <code className="font-mono">SMTP_USER</code> and <code className="font-mono">SMTP_PASS</code>{' '}
            if the server wants them — but some hosts block outbound SMTP altogether, and Railway
            does below its Pro plan, so the token is the one that works there.{' '}
            <code className="font-mono">PUBLIC_URL</code> is what the links in a message point
            at, and <code className="font-mono">SMTP_MESSAGE_STREAM</code> names the provider's
            stream where one is required. This reads the environment the running process has,
            so a variable added without a restart shows as missing here.
          </p>
        </div>
      ) : (
        <div className={`${card} flex flex-wrap items-center gap-x-8 gap-y-3`}>
          <span>
            <span className="metric-label block">Sending as</span>
            <span className="font-mono text-sm">{s.from}</span>
          </span>
          <span>
            <span className="metric-label block">{s.transport === 'postmark-api' ? 'Through' : 'Server'}</span>
            <span className="font-mono text-sm">
              {s.transport === 'postmark-api'
                ? 'Postmark API over HTTPS'
                : `${s.host}:${s.port} ${s.secure ? 'TLS' : 'STARTTLS'}${s.authenticated ? '' : ' · no auth'}`}
            </span>
          </span>
          <span>
            <span className="metric-label block">Would reach</span>
            <span className="font-mono text-lg font-medium tabular-nums text-ember-ink">{s.eligible}</span>
          </span>
          <span>
            <span className="metric-label block">Opted out</span>
            <span className="font-mono text-lg font-medium tabular-nums">{s.opted_out}</span>
          </span>
          {admin && (
            <button className={`ml-auto ${ghost}`} onClick={verify} disabled={busy}>
              Test the connection
            </button>
          )}
        </div>
      )}

      {creating && s?.configured && (
        <NewCampaign everyone={s.eligible} onCreated={(id) => { setCreating(false); setOpen(id); refresh(); }} />
      )}

      {!list.data ? null : !list.data.length ? (
        <p className={`${card} py-10 text-center text-sm text-slate-ink`}>
          Nothing has been sent. A new email starts from this week's update or from a blank
          page, goes to everyone or to the clients you pick, and you read every word of it
          before it goes anywhere.
        </p>
      ) : (
        <div className={`${tableCard} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>{['Subject', 'To', 'Status', 'Sent', 'Failed', 'When', ''].map((h) => (
                <th key={h} className="px-4 py-2 text-left">{h}</th>))}
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className="border-t border-pebble dark:border-white/10">
                  <td className="px-4 py-2">
                    <span className="block font-medium">{c.subject || <span className="text-slate-ink">Untitled</span>}</span>
                    <span className="block text-[11px] text-slate-ink">
                      {c.created_by ? `by ${c.created_by}` : 'by the desk'} · {when(c.created_at)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-ink">
                    {c.audience === 'selected' ? `${c.chosen ?? 0} chosen` : 'everyone'}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${
                      c.status === 'sent' ? 'bg-ember/15 text-ember-ink'
                        : c.status === 'failed' ? 'bg-down/15 text-down'
                          : 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono tabular-nums">{c.recipients}</td>
                  <td className="px-4 py-2 font-mono tabular-nums">
                    {c.failures ? <span className="text-down">{c.failures}</span> : '0'}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-ink">{when(c.finished_at)}</td>
                  <td className="px-4 py-2 text-right">
                    <button className={ghost} onClick={() => { setOpen(open === c.id ? null : c.id); setCreating(false); }}>
                      {open === c.id ? 'Close' : c.status === 'draft' ? 'Edit' : 'Look'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <Editor id={open} admin={admin} onChanged={refresh} onClose={() => setOpen(null)} />}

      <Templates admin={admin} />
    </div>
  );
}

/**
 * One choice, drawn as a card.
 *
 * A real radio input underneath, visually hidden: the keyboard, screen readers and the form
 * all see a radio group, and the card is only what it looks like. The whole card is the
 * target, well past the minimum for a fingertip.
 */
function Choice({ name, value, current, onPick, title, children }: {
  name: string; value: string; current: string; onPick: (v: string) => void;
  title: string; children: ReactNode;
}) {
  const on = current === value;
  return (
    <label className={`block min-h-[44px] cursor-pointer rounded-lg border p-3 transition-colors focus-within:ring-1 focus-within:ring-ember ${
      on ? 'border-ember bg-ember/5' : 'border-pebble hover:border-ember/40 dark:border-white/10'}`}>
      <input type="radio" name={name} value={value} checked={on} onChange={() => onPick(value)} className="sr-only" />
      <span className="flex items-start gap-3">
        <span aria-hidden className={`mt-1 inline-block h-3 w-3 shrink-0 rounded-full border ${
          on ? 'border-ember bg-ember' : 'border-mist'}`} />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-slate-ink">{children}</span>
        </span>
      </span>
    </label>
  );
}

/**
 * The two questions, then a draft.
 *
 * Nothing is sent from here and nothing is even saved until the button at the bottom: the
 * draft that opens afterwards is where the words get read. Picking clients happens in place,
 * so the choice of "who" is made with the list in front of you rather than remembered.
 */
function NewCampaign({ everyone, onCreated }: { everyone: number; onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<'weekly' | 'blank'>('weekly');
  const [audience, setAudience] = useState<Audience>('all');
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reachable = chosen.filter((c) => !cannot(c)).length;
  const ready = audience === 'all' || reachable > 0;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const made = await api<{ id: string }>('/admin/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          mode, audience,
          ...(audience === 'selected' ? { recipient_ids: chosen.map((c) => c.id) } : {}),
        }),
      });
      onCreated(made.id);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={create} className={`${card} space-y-5`}>
      <span className="section-title">New email</span>
      {error && <p role="alert" className={alertBox}>{error}</p>}

      <fieldset className="space-y-2">
        <legend className="metric-label mb-2 flex items-baseline gap-2">
          <span className="font-mono text-ember-ink">01</span> What to send
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice name="mode" value="weekly" current={mode} onPick={(v) => setMode(v as 'weekly')} title="This week's update, written for you">
            Drafted from what happened on the desk this week — what opened, what is closing,
            what matured. You can edit every word before it goes anywhere.
          </Choice>
          <Choice name="mode" value="blank" current={mode} onPick={(v) => setMode(v as 'blank')} title="Write it myself">
            A blank subject and message. Same delivery, same unsubscribe link, your words.
          </Choice>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="metric-label mb-2 flex items-baseline gap-2">
          <span className="font-mono text-ember-ink">02</span> Who gets it
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice name="audience" value="all" current={audience} onPick={(v) => setAudience(v as Audience)} title={`Everyone · ${everyone}`}>
            Every client with an email address who has not opted out of updates.
          </Choice>
          <Choice name="audience" value="selected" current={audience} onPick={(v) => setAudience(v as Audience)}
            title={chosen.length ? `Chosen clients · ${reachable}` : 'Chosen clients'}>
            Pick them by name or email. Anyone who has opted out is skipped even if picked.
          </Choice>
        </div>
        {audience === 'selected' && <ClientPicker value={chosen} onChange={setChosen} />}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button className={btn} disabled={busy || !ready}>
          {busy ? 'Working…' : 'Create the draft'}
        </button>
        <span className="text-xs text-slate-ink">
          Nothing is sent yet. The draft opens for you to read, test and then release.
        </span>
      </div>
    </form>
  );
}

/**
 * Choosing clients by hand.
 *
 * Search as you type, tick to add, and what has been chosen sits above the results as chips
 * that wrap rather than clip, each with its own remove. A client who cannot be reached —
 * no address, or opted out — is shown with the reason and cannot be ticked, because a list
 * that silently drops people is a list nobody trusts.
 */
export function ClientPicker({ value, onChange }: { value: Chosen[]; onChange: (v: Chosen[]) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Chosen[] | null>(null);
  const [searching, setSearching] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        setRows(await api<Chosen[]>(`/clients?limit=50${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`));
      } catch { setRows([]); } finally { setSearching(false); }
    }, 250);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [q]);

  const has = (id: string) => value.some((c) => c.id === id);
  const toggle = (c: Chosen) => onChange(has(c.id) ? value.filter((x) => x.id !== c.id) : [...value, c]);
  const skipped = value.filter(cannot).length;

  return (
    <div className="space-y-3 rounded-lg border border-pebble p-3 dark:border-white/10">
      {!!value.length && (
        <div className="space-y-1">
          <span className="text-xs text-slate-ink">
            {value.length - skipped} will get it{skipped ? ` · ${skipped} skipped` : ''}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {value.map((c) => {
              const why = cannot(c);
              return (
                <span key={c.id} className={`inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-xs ${
                  why ? 'border-pebble text-slate-ink line-through dark:border-white/10' : 'border-ember/40 bg-ember/5'}`}>
                  <span className="truncate">{c.name}</span>
                  {why && <span className="no-underline text-[10px] not-italic">({why})</span>}
                  <button type="button" onClick={() => toggle(c)} aria-label={`Remove ${c.name}`}
                    className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-ember/15">
                    <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 2l6 6M8 2l-6 6" />
                    </svg>
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <label className="block">
        <span className="metric-label mb-1 block">Find clients</span>
        <input className={`${field} w-full`} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Part of a name or an email address" autoComplete="off" />
      </label>

      <div className="max-h-64 overflow-y-auto rounded-md border border-pebble dark:border-white/10" aria-busy={searching}>
        {rows === null ? (
          <p className="p-3 text-xs text-slate-ink">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-xs text-slate-ink">
            No clients match “{q.trim()}”. Try a shorter part of the name, or the email address.
          </p>
        ) : rows.map((c) => {
          const why = cannot(c);
          const on = has(c.id);
          return (
            <label key={c.id} className={`flex min-h-[44px] items-center gap-3 border-t border-pebble px-3 py-2 first:border-0 dark:border-white/10 ${
              why ? 'opacity-60' : 'cursor-pointer hover:bg-ember/5'}`}>
              <input type="checkbox" checked={on} disabled={!!why} onChange={() => toggle(c)} className="accent-ember" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{c.name}</span>
                <span className="block truncate font-mono text-[11px] text-slate-ink">{c.email ?? '—'}</span>
              </span>
              {why && <span className="shrink-0 text-[11px] text-slate-ink">{why}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}

type Template = { id: string; name: string; subject: string; body: string; updated_at: string };

/**
 * The templates a one-to-one message can start from, edited here and picked on a client's
 * own record.
 *
 * They are a starting point and nothing more: picking one fills the box and the text is then
 * the sender's to change. What gets stored against the client is what was actually sent, so
 * editing a template here never rewrites a message somebody already received.
 */
function Templates({ admin }: { admin: boolean }) {
  const rows = useApi<Template[]>('/admin/email-templates');
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      name: String(f.get('name')), subject: String(f.get('subject')), body: String(f.get('body')),
    };
    setBusy(true); setError(null);
    try {
      if (editing === 'new') await api('/admin/email-templates', { method: 'POST', body: JSON.stringify(body) });
      else if (editing) await api(`/admin/email-templates/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setEditing(null);
      rows.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 border-t border-pebble pt-5 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="section-title">Templates</span>
        {admin && (
          <button className={ghost} onClick={() => setEditing(editing === 'new' ? null : 'new')}>
            {editing === 'new' ? 'Cancel' : 'New template'}
          </button>
        )}
      </div>
      <p className="text-xs text-slate-ink">
        Used when writing to one client, from their own record. Picking one fills the box —
        the text is then yours to change, and what is stored against the client is what you
        actually sent.
      </p>

      {error && <p role="alert" className={alertBox}>{error}</p>}

      {editing && (
        <form onSubmit={save} className={`${card} space-y-2`}>
          <label className="block">
            <span className="metric-label mb-1 block">Name</span>
            <input name="name" required maxLength={80} className={`${field} w-full`}
              defaultValue={editing === 'new' ? '' : editing.name} />
          </label>
          <label className="block">
            <span className="metric-label mb-1 block">Subject</span>
            <input name="subject" required maxLength={200} className={`${field} w-full`}
              defaultValue={editing === 'new' ? '' : editing.subject} />
          </label>
          <label className="block">
            <span className="metric-label mb-1 block">Message</span>
            <textarea name="body" required rows={8} maxLength={20000} className={`${field} w-full`}
              defaultValue={editing === 'new' ? '' : editing.body} />
            <span className="mt-1 block text-xs text-slate-ink">
              <code className="font-mono">{'{{name}}'}</code> and{' '}
              <code className="font-mono">{'{{email}}'}</code> are filled in per client.
            </span>
          </label>
          <div className="flex gap-2">
            <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" onClick={() => setEditing(null)}
              className="rounded-full border border-pebble px-3 py-1.5 text-sm text-slate-ink dark:border-white/10">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {rows.data?.map((t) => (
          <div key={t.id} className={`${card} space-y-1`}>
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium">{t.name}</span>
              {admin && (
                <span className="flex gap-1">
                  <button className="rounded-full border border-pebble px-2 py-0.5 text-[11px] text-slate-ink dark:border-white/10"
                    onClick={() => setEditing(t)}>Edit</button>
                  <button className="rounded-full border border-pebble px-2 py-0.5 text-[11px] text-slate-ink dark:border-white/10"
                    onClick={async () => {
                      setError(null);
                      try { await api(`/admin/email-templates/${t.id}`, { method: 'DELETE' }); rows.reload(); }
                      catch (err) { setError((err as Error).message); }
                    }}>Delete</button>
                </span>
              )}
            </div>
            <p className="text-xs text-slate-ink">{t.subject}</p>
            <p className="line-clamp-3 text-xs whitespace-pre-line text-slate-ink opacity-80">{t.body}</p>
          </div>
        ))}
      </div>
      {rows.data?.length === 0 && <p className="text-sm text-slate-ink">No templates yet.</p>}
    </div>
  );
}

function Editor({ id, admin, onChanged, onClose }: {
  id: string; admin: boolean; onChanged: () => void; onClose: () => void;
}) {
  const one = useApi<Full>(`/admin/campaigns/${id}`);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [confirm, setConfirm] = useState('');
  const [changing, setChanging] = useState(false);
  const [draftChosen, setDraftChosen] = useState<Chosen[] | null>(null);

  const c = one.data;
  if (!c) return <p className="text-sm text-slate-ink">Loading…</p>;
  const editable = admin && c.status === 'draft';
  const blank = !c.subject.trim() || !c.body.trim();

  const run = async (what: () => Promise<string>) => {
    setBusy(true); setError(null); setNote(null);
    try { setNote(await what()); one.reload(); onChanged(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      await api(`/admin/campaigns/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ subject: String(f.get('subject')), body: String(f.get('body')) }),
      });
      return 'Saved.';
    });
  }

  const picked = draftChosen ?? c.chosen_clients;
  const pickedReachable = picked.filter((x) => !cannot(x)).length;

  async function saveAudience(audience: Audience) {
    await run(async () => {
      await api(`/admin/campaigns/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(audience === 'all'
          ? { audience }
          : { audience, recipient_ids: picked.map((x) => x.id) }),
      });
      setChanging(false); setDraftChosen(null); setConfirm('');
      return audience === 'all' ? 'Going to everyone.' : `Going to ${pickedReachable} chosen ${pickedReachable === 1 ? 'client' : 'clients'}.`;
    });
  }

  return (
    <div className={`${card} space-y-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="section-title">{c.status === 'draft' ? 'Draft' : 'Sent'}</span>
        <button className={ghost} onClick={onClose}>Close</button>
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      {note && <p className="text-sm text-up">{note}</p>}

      {/* Who it is going to, stated where the words are written, because the two are read
          together: a paragraph that is fine for everyone may be wrong for these three. */}
      <div className="space-y-2 rounded-lg border border-pebble p-3 dark:border-white/10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">
            <span className="metric-label mr-2">Going to</span>
            {c.audience === 'selected'
              ? <><strong className="font-mono">{c.eligible}</strong> chosen {c.eligible === 1 ? 'client' : 'clients'}</>
              : <>everyone who has not opted out · <strong className="font-mono">{c.eligible}</strong></>}
          </span>
          {editable && (
            <div className="flex gap-2">
              {c.audience === 'selected' && !changing && (
                <button type="button" className={ghost} disabled={busy} onClick={() => saveAudience('all')}>
                  Send to everyone instead
                </button>
              )}
              <button type="button" className={ghost} onClick={() => { setChanging(!changing); setDraftChosen(null); }}>
                {changing ? 'Cancel' : c.audience === 'selected' ? 'Change who' : 'Choose clients instead'}
              </button>
            </div>
          )}
        </div>

        {c.audience === 'selected' && !changing && !!c.chosen_clients.length && (
          <div className="flex flex-wrap gap-1.5">
            {c.chosen_clients.map((x) => {
              const why = cannot(x);
              return (
                <span key={x.id} className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  why ? 'border-pebble text-slate-ink line-through dark:border-white/10' : 'border-ember/40 bg-ember/5'}`}>
                  {x.name}{why ? ` (${why})` : ''}
                </span>
              );
            })}
          </div>
        )}

        {changing && (
          <div className="space-y-2">
            <ClientPicker value={picked} onChange={setDraftChosen} />
            <button type="button" className={btn} disabled={busy || pickedReachable === 0}
              onClick={() => saveAudience('selected')}>
              {busy ? 'Saving…' : `Use these ${pickedReachable}`}
            </button>
          </div>
        )}
      </div>

      <form onSubmit={save} className="space-y-3">
        <label className="block">
          <span className="metric-label mb-1 block">Subject</span>
          <input name="subject" defaultValue={c.subject} maxLength={200} required readOnly={!editable}
            placeholder={editable ? 'What the reader sees first' : undefined}
            className={`${field} w-full ${editable ? '' : 'opacity-70'}`} />
        </label>
        <label className="block">
          <span className="metric-label mb-1 block">The article</span>
          <textarea name="body" defaultValue={c.body} rows={12} maxLength={20000} required readOnly={!editable}
            placeholder={editable ? 'Blank lines separate paragraphs.' : undefined}
            className={`${field} w-full ${editable ? '' : 'opacity-70'}`} />
          <span className="mt-1 block text-xs text-slate-ink">
            Blank lines separate paragraphs. It is sent as plain text and as HTML, and every
            message carries the reader's own unsubscribe link.
          </span>
        </label>
        {editable && <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</button>}
      </form>

      {editable && (
        <div className="space-y-3 border-t border-pebble pt-4 dark:border-white/10">
          {/* The test comes before the send, in that order on the screen, because that is the
              order it should happen in. */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="metric-label mb-1 block">Send a test to</span>
              <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@yourdesk.com" className={`${field} w-72`} />
            </label>
            <button type="button" disabled={busy || !testTo || blank}
              className="rounded-full border border-pebble px-3 py-2 text-sm text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian disabled:opacity-50 dark:border-white/10 dark:hover:text-vellum"
              onClick={() => run(async () => {
                await api(`/admin/campaigns/${id}/test`, { method: 'POST', body: JSON.stringify({ to: testTo }) });
                return `Sent to ${testTo}. Read it before you send it to anybody else.`;
              })}>
              Send test
            </button>
          </div>

          {blank ? (
            <p className="text-xs text-slate-ink">Save a subject and a message before sending.</p>
          ) : (
            <div className="rounded-lg border border-ember/40 bg-ember/5 p-3 space-y-2">
              <p className="text-sm">
                This will email <strong className="font-mono">{c.eligible}</strong>{' '}
                {c.eligible === 1 ? 'client' : 'clients'}
                {c.audience === 'selected' ? ' you chose' : ''}. It cannot be undone.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="block">
                  <span className="metric-label mb-1 block">Type {c.eligible} to confirm</span>
                  <input value={confirm} onChange={(e) => setConfirm(e.target.value)}
                    inputMode="numeric" className={`${field} w-32`} />
                </label>
                <button type="button" className={btn}
                  disabled={busy || c.eligible === 0 || confirm.trim() !== String(c.eligible)}
                  onClick={() => run(async () => {
                    const out = await api<{ sent: number; failed: number }>(
                      `/admin/campaigns/${id}/send`,
                      { method: 'POST', body: JSON.stringify({ confirm_recipients: c.eligible }) });
                    return `Sent to ${out.sent}.${out.failed ? ` ${out.failed} could not be delivered.` : ''}`;
                  })}>
                  {busy ? 'Sending…' : c.audience === 'selected'
                    ? `Send to ${c.eligible} ${c.eligible === 1 ? 'client' : 'clients'}`
                    : 'Send to everyone'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {!!c.deliveries.length && (
        <div className="space-y-2 border-t border-pebble pt-4 dark:border-white/10">
          <span className="section-title">Who it reached</span>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <tbody>
                {c.deliveries.map((d, n) => (
                  <tr key={n} className="border-t border-pebble first:border-0 dark:border-white/10">
                    <td className="py-1.5 pr-3">{d.name}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs text-slate-ink">{d.email}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`font-mono text-[10px] tracking-wide uppercase ${
                        d.status === 'sent' ? 'text-up' : 'text-down'}`}>{d.status}</span>
                    </td>
                    <td className="py-1.5 text-xs text-slate-ink">{d.error ?? when(d.sent_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
