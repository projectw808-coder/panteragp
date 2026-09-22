import { useState, type FormEvent } from 'react';
import { alertBox, btn, card, field, PageTitle, tableCard, thead } from './App.tsx';
import { api, useApi } from './api.ts';

/**
 * The desk side of client email.
 *
 * The shape of this screen is the shape of the risk. Writing and sending are separate steps,
 * the test send is offered before the real one, and the button that reaches everybody states
 * the number it will reach and makes you type it back. None of that is ceremony: an email is
 * the only thing this application does that cannot be undone by pressing something else.
 */

type Status = {
  configured: boolean; host: string | null; port: number | null; secure: boolean | null;
  from: string | null; authenticated: boolean; eligible: number; opted_out: number;
};

type Campaign = {
  id: string; kind: string; subject: string; status: string; created_at: string;
  started_at: string | null; finished_at: string | null;
  recipients: number; failures: number; created_by: string | null;
};

type Delivery = { status: string; email: string; error: string | null; sent_at: string; name: string };
type Full = Campaign & { body: string; eligible: number; deliveries: Delivery[] };

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');

export function EmailAdmin({ admin }: { admin: boolean }) {
  const status = useApi<Status>('/admin/email/status');
  const list = useApi<Campaign[]>('/admin/campaigns');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState<string | null>(null);

  const refresh = () => { list.reload(); status.reload(); };

  async function draft() {
    setBusy(true); setError(null);
    try {
      const made = await api<Campaign>('/admin/campaigns', { method: 'POST' });
      setOpen(made.id);
      refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

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
          <button className={btn} onClick={draft} disabled={busy}>
            {busy ? 'Working…' : 'New weekly update'}
          </button>
        )}
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      {verified && <p className={`${card} text-sm text-up`}>{verified}</p>}

      {/* Whether mail can go out at all, before offering a button that would fail. */}
      {!status.data ? <p className="text-sm text-slate-ink">Loading…</p> : !s?.configured ? (
        <div className={`${card} space-y-2`}>
          <p className="text-sm font-medium">Email is not configured.</p>
          <p className="text-xs text-slate-ink">
            Set <code className="font-mono">SMTP_HOST</code> and{' '}
            <code className="font-mono">SMTP_FROM</code> in the environment, and{' '}
            <code className="font-mono">SMTP_USER</code> and{' '}
            <code className="font-mono">SMTP_PASS</code> if the server wants them.{' '}
            <code className="font-mono">PUBLIC_URL</code> is what the links in a message point at.
            Nothing can be sent until then, which is why there is no button.
          </p>
        </div>
      ) : (
        <div className={`${card} flex flex-wrap items-center gap-x-8 gap-y-3`}>
          <span>
            <span className="metric-label block">Sending as</span>
            <span className="font-mono text-sm">{s.from}</span>
          </span>
          <span>
            <span className="metric-label block">Server</span>
            <span className="font-mono text-sm">
              {s.host}:{s.port} {s.secure ? 'TLS' : 'STARTTLS'}
              {s.authenticated ? '' : ' · no auth'}
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
            <button className="ml-auto rounded-full border border-pebble px-3 py-1.5 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
              onClick={verify} disabled={busy}>
              Test the connection
            </button>
          )}
        </div>
      )}

      {!list.data ? null : !list.data.length ? (
        <p className={`${card} py-10 text-center text-sm text-slate-ink`}>
          Nothing has been sent. A new weekly update is written from what happened on the desk
          this week — you can edit every word of it before it goes anywhere.
        </p>
      ) : (
        <div className={`${tableCard} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>{['Subject', 'Status', 'Sent', 'Failed', 'When', ''].map((h) => (
                <th key={h} className="px-4 py-2 text-left">{h}</th>))}
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className="border-t border-pebble dark:border-white/10">
                  <td className="px-4 py-2">
                    <span className="block font-medium">{c.subject}</span>
                    <span className="block text-[11px] text-slate-ink">
                      {c.created_by ? `by ${c.created_by}` : 'by the desk'} · {when(c.created_at)}
                    </span>
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
                    <button className="rounded-full border border-pebble px-2.5 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
                      onClick={() => setOpen(open === c.id ? null : c.id)}>
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

  const c = one.data;
  if (!c) return <p className="text-sm text-slate-ink">Loading…</p>;
  const editable = admin && c.status === 'draft';

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

  return (
    <div className={`${card} space-y-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="section-title">{c.status === 'draft' ? 'Draft' : 'Sent'}</span>
        <button className="rounded-full border border-pebble px-3 py-1.5 text-xs text-slate-ink dark:border-white/10"
          onClick={onClose}>Close</button>
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      {note && <p className="text-sm text-up">{note}</p>}

      <form onSubmit={save} className="space-y-3">
        <label className="block">
          <span className="metric-label mb-1 block">Subject</span>
          <input name="subject" defaultValue={c.subject} maxLength={200} required readOnly={!editable}
            className={`${field} w-full ${editable ? '' : 'opacity-70'}`} />
        </label>
        <label className="block">
          <span className="metric-label mb-1 block">The article</span>
          <textarea name="body" defaultValue={c.body} rows={12} maxLength={20000} required readOnly={!editable}
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
            <button type="button" disabled={busy || !testTo}
              className="rounded-full border border-pebble px-3 py-2 text-sm text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
              onClick={() => run(async () => {
                await api(`/admin/campaigns/${id}/test`, { method: 'POST', body: JSON.stringify({ to: testTo }) });
                return `Sent to ${testTo}. Read it before you send it to anybody else.`;
              })}>
              Send test
            </button>
          </div>

          <div className="rounded-lg border border-ember/40 bg-ember/5 p-3 space-y-2">
            <p className="text-sm">
              This will email <strong className="font-mono">{c.eligible}</strong>{' '}
              {c.eligible === 1 ? 'client' : 'clients'}. It cannot be undone.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="metric-label mb-1 block">Type {c.eligible} to confirm</span>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  inputMode="numeric" className={`${field} w-32`} />
              </label>
              <button type="button" className={btn}
                disabled={busy || confirm.trim() !== String(c.eligible)}
                onClick={() => run(async () => {
                  const out = await api<{ sent: number; failed: number }>(
                    `/admin/campaigns/${id}/send`,
                    { method: 'POST', body: JSON.stringify({ confirm_recipients: c.eligible }) });
                  return `Sent to ${out.sent}.${out.failed ? ` ${out.failed} could not be delivered.` : ''}`;
                })}>
                {busy ? 'Sending…' : 'Send to everyone'}
              </button>
            </div>
          </div>
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
