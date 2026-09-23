import { useState, type FormEvent } from 'react';
import { alertBox, btn, card, field } from './App.tsx';
import { api, useApi } from './api.ts';

/**
 * Writing to one client, from their record.
 *
 * It sits with the tasks because that is where somebody is when they decide to write: they
 * have just read the timeline, seen the outstanding document, and want to say so. Making
 * them go to a separate screen and find the client again is how the message does not get
 * sent.
 *
 * A template fills the box and is then just text — editing it here changes this message and
 * nothing else, and what is stored is what was sent rather than a pointer to a template that
 * may be rewritten next month.
 */

type Template = { id: string; name: string; subject: string; body: string };
type Sent = {
  id: number; subject: string; body: string; email: string;
  status: string; error: string | null; sent_at: string; sent_by: string | null;
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, {
  day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
});

export function ClientEmail({ clientId, clientName, clientEmail, optedOut }: {
  clientId: string; clientName: string; clientEmail: string | null; optedOut?: boolean;
}) {
  const templates = useApi<Template[]>('/admin/email-templates');
  const sent = useApi<Sent[]>(`/clients/${clientId}/emails`);
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [usedTemplate, setUsedTemplate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Filled here as well as on the server, so what the box shows is what goes out.
  const fill = (s: string) => s.replaceAll('{{name}}', clientName).replaceAll('{{email}}', clientEmail ?? '');

  function pick(id: string) {
    const t = templates.data?.find((x) => x.id === id);
    if (!t) return;
    setSubject(fill(t.subject));
    setBody(fill(t.body));
    setUsedTemplate(t.id);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNote(null);
    try {
      const out = await api<{ to: string }>(`/clients/${clientId}/email`, {
        method: 'POST',
        body: JSON.stringify({ subject, body, template_id: usedTemplate }),
      });
      setNote(`Sent to ${out.to}.`);
      setSubject(''); setBody(''); setUsedTemplate(null); setOpen(false);
      sent.reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className={`${card} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Email this client</h2>
        {clientEmail && (
          <button className="rounded-full border border-pebble px-3 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
            onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Write a message'}
          </button>
        )}
      </div>

      {!clientEmail ? (
        <p className="text-sm text-slate-ink">
          This client has no email address on file, so there is nowhere to write to.
        </p>
      ) : (
        <p className="text-xs text-slate-ink">
          Goes to <span className="font-mono">{clientEmail}</span>
        </p>
      )}

      {/* Their consent state, stated rather than enforced. A message about their own account
          reaches them either way; whether THIS message is one of those is a judgement the
          person writing it should make with the fact in front of them. */}
      {optedOut && (
        <p className={`${alertBox} text-xs`}>
          This client has opted out of update emails. Account matters still reach them, but
          anything promotional should not be sent here.
        </p>
      )}

      {error && <p role="alert" className={alertBox}>{error}</p>}
      {note && <p className="text-sm text-up">{note}</p>}

      {open && clientEmail && (
        <form onSubmit={send} className="space-y-2 border-t border-pebble pt-3 dark:border-white/10">
          <label className="block">
            <span className="metric-label mb-1 block">Start from a template</span>
            <select className={`${field} w-full`} value={usedTemplate ?? ''}
              onChange={(e) => (e.target.value ? pick(e.target.value) : setUsedTemplate(null))}>
              <option value="">Write from scratch</option>
              {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="metric-label mb-1 block">Subject</span>
            <input className={`${field} w-full`} value={subject} maxLength={200} required
              onChange={(e) => setSubject(e.target.value)} />
          </label>

          <label className="block">
            <span className="metric-label mb-1 block">Message</span>
            <textarea className={`${field} w-full`} rows={9} value={body} maxLength={20000} required
              onChange={(e) => setBody(e.target.value)} />
            <span className="mt-1 block text-xs text-slate-ink">
              Blank lines separate paragraphs. <code className="font-mono">{'{{name}}'}</code> and{' '}
              <code className="font-mono">{'{{email}}'}</code> are filled in. Sent as plain text
              and HTML, and it goes out under the desk's address so a reply comes back here.
            </span>
          </label>

          <div className="flex flex-wrap gap-2">
            <button className={btn} disabled={busy || !subject.trim() || !body.trim()}>
              {busy ? 'Sending…' : 'Send'}
            </button>
            <button type="button" onClick={() => setOpen(false)}
              className="rounded-full border border-pebble px-3 py-1.5 text-sm text-slate-ink dark:border-white/10">
              Cancel
            </button>
          </div>
        </form>
      )}

      {!!sent.data?.length && (
        <div className="space-y-1 border-t border-pebble pt-3 dark:border-white/10">
          <span className="metric-label block">Already sent</span>
          {sent.data.slice(0, 6).map((m) => (
            <p key={m.id} className="text-xs">
              <span className={m.status === 'sent' ? '' : 'text-down'}>{m.subject}</span>
              <span className="text-slate-ink">
                {' · '}{when(m.sent_at)}{m.sent_by ? ` · ${m.sent_by}` : ''}
                {m.status === 'sent' ? '' : ` · failed: ${m.error ?? 'unknown'}`}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
