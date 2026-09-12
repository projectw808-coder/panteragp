import { useState } from 'react';
import { alertBox, card, mono, PageTitle, tableCard, thead } from './App.tsx';
import { api, useApi } from './api.ts';

/**
 * Money a client has asked to take out of a portfolio, waiting on a decision.
 *
 * Nothing has moved when a request appears here — approving is what moves it, in the same
 * transaction that records the decision. Declining costs the client nothing except the
 * answer, so both buttons are ordinary; neither is styled as the safe one.
 */

type Request = {
  id: number; client_id: string; client_name: string; portfolio_name: string;
  currency: string; amount: number; portfolio_balance: number; note: string | null;
  status: string; created_at: string; decided_at: string | null; decision_note: string | null;
};

const money = (n: number, code: string) =>
  `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${code}`;
const when = (iso: string) => new Date(iso).toLocaleString();

function waited(iso: string): string {
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function PortfolioRequests() {
  const [status, setStatus] = useState('pending');
  const rows = useApi<Request[]>(`/portfolio-requests?status=${status}`);
  const pending = useApi<Request[]>('/portfolio-requests?status=pending');
  const [error, setError] = useState<string | null>(null);

  const list = rows.data ?? [];
  const queue = pending.data ?? [];
  const oldest = queue.length ? queue[queue.length - 1] : null;
  const reload = () => { rows.reload(); pending.reload(); };

  async function decide(r: Request, next: 'approved' | 'declined', note: string) {
    setError(null);
    try {
      await api(`/portfolio-requests/${r.id}/decide`, {
        method: 'POST', body: JSON.stringify({ status: next, note: note || undefined }),
      });
      reload();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageTitle>Withdrawal requests</PageTitle>

      <div className={`${card} flex flex-wrap items-center gap-x-10 gap-y-3`}>
        <div>
          <p className="metric-label">Waiting on a decision</p>
          <p className={`font-mono text-2xl leading-tight font-medium tabular-nums ${queue.length ? 'text-ember-ink' : ''}`}>
            {queue.length}
          </p>
        </div>
        <div>
          <p className="metric-label">Longest wait</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">
            {oldest ? waited(oldest.created_at) : '—'}
          </p>
        </div>
        <p className="ml-auto max-w-sm text-xs text-slate-ink">
          A client asks to take money out of a portfolio; nothing moves until somebody here
          approves it. Approving releases it into their balance straight away.
        </p>
      </div>

      <div role="tablist" aria-label="Request status" className="flex flex-wrap gap-1 text-xs">
        {['pending', 'approved', 'declined', 'all'].map((s) => (
          <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1.5 capitalize transition-colors ${status === s
              ? 'bg-ember font-medium text-graphite'
              : 'bg-bone text-slate-ink hover:text-obsidian dark:bg-white/10 dark:text-mist dark:hover:text-vellum'}`}>
            {s}
          </button>
        ))}
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}

      {list.length === 0 ? (
        <div className={`${card} py-10 text-center`}>
          <p className="text-sm font-medium text-obsidian dark:text-vellum">
            {status === 'pending' ? 'Nothing waiting' : `Nothing ${status}`}
          </p>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-ink">
            Requests appear here when a client asks to take money out of one of their
            portfolios. Paying in never needs a decision — only taking out does.
          </p>
        </div>
      ) : status === 'pending' ? (
        <div className="space-y-2">
          {list.map((r) => <Row key={r.id} r={r} onDecide={decide} />)}
        </div>
      ) : (
        <div className={tableCard}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>{['Client', 'Portfolio', 'Amount', 'Asked', 'Decided', 'Note'].map((h) =>
                <th key={h} className="px-4 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-t border-pebble dark:border-white/10">
                  <td className="px-4 py-2">
                    <a className="font-medium text-ember-ink hover:underline" href={`#/clients/${r.client_id}`}>
                      {r.client_name}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-slate-ink">{r.portfolio_name}</td>
                  <td className="px-4 py-2 font-mono tabular-nums">{money(r.amount, r.currency)}</td>
                  <td className={`px-4 py-2 text-xs text-slate-ink ${mono}`}>{when(r.created_at)}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] uppercase ${
                      r.status === 'approved' ? 'chip-up text-up' : 'chip-down text-down'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-ink">{r.decision_note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ r, onDecide }: {
  r: Request; onDecide: (r: Request, next: 'approved' | 'declined', note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async (next: 'approved' | 'declined') => {
    setBusy(true);
    try { await onDecide(r, next, note); } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-pebble bg-bone/50 p-4 dark:border-white/10 dark:bg-white/5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <a className="text-sm font-medium text-ember-ink hover:underline" href={`#/clients/${r.client_id}`}>
            {r.client_name}
          </a>
          <p className="text-xs text-obsidian dark:text-vellum">{r.portfolio_name}</p>
          <p className={`text-xs text-slate-ink ${mono}`}>
            asked {when(r.created_at)} · waiting {waited(r.created_at)}
          </p>
        </div>
        <span className="ml-auto text-right">
          <span className="metric-label block">Asked for</span>
          <span className="block font-mono text-lg leading-tight font-medium tabular-nums text-ember-ink">
            {money(r.amount, r.currency)}
          </span>
          {/* What is in the pot, so the decision does not need a second screen. */}
          <span className="block font-mono text-[11px] text-slate-ink">
            of {money(r.portfolio_balance, r.currency)} in the pot
          </span>
        </span>
      </div>

      {r.note && <p className="mt-2 text-xs text-slate-ink">“{r.note}”</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className="min-w-48 flex-1 rounded-md border border-pebble bg-vellum px-2 py-1 text-xs dark:border-white/10 dark:bg-onyx"
          maxLength={400} placeholder="Note for the client (optional)"
          value={note} onChange={(e) => setNote(e.target.value)} />
        <button disabled={busy} onClick={() => go('approved')}
          className="rounded-full bg-ember px-3 py-1.5 text-sm font-medium text-graphite transition-colors hover:brightness-110 disabled:opacity-50">
          Approve
        </button>
        <button disabled={busy} onClick={() => go('declined')}
          className="rounded-full border border-pebble px-3 py-1.5 text-sm font-medium text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian disabled:opacity-50 dark:border-white/10 dark:hover:text-vellum">
          Decline
        </button>
      </div>
    </div>
  );
}
