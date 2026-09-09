import { useState, type FormEvent } from 'react';
import { alertBox, btn, field, mono } from './App.tsx';
import { api, token, useApi, type ClientRow as Client } from './api.ts';

/**
 * A client row that unfolds in place: the essentials and their money without leaving the
 * list, and the funding control right there. The full record is still one click away —
 * this is for the common case of "check them, credit them, move on".
 */

type Holdings = {
  accounts: { id: string; currency: string; balance: number }[];
  wallets: { id: string; asset: string; balance: number }[];
  totals: { holdings_usd: number; open_pnl: number; equity_usd: number; unpriced: string[] };
};

const when = (iso: string) => new Date(iso).toLocaleString();
const usd = (n: number) =>
  '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function ClientRow({ c, open, onToggle, onChanged, badge, canReviewKyc }: {
  c: Client;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  badge: (value: string) => React.ReactNode;
  canReviewKyc: boolean;
}) {
  // Only fetched once the row is opened: a list of fifty clients should not pull fifty
  // holdings summaries nobody asked to see.
  const holdings = useApi<Holdings>(open ? `/clients/${c.id}/holdings` : '');
  const t = holdings.data?.totals;

  return (
    <>
      <tr onClick={onToggle} aria-expanded={open}
        className="cursor-pointer border-t border-pebble hover:bg-bone dark:border-white/10 dark:hover:bg-white/5">
        <td className="px-4 py-2">
          <span className="flex items-center gap-2">
            <span className={`font-mono text-xs text-ember transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
              aria-hidden>›</span>
            <span className="font-medium">{c.name}</span>
          </span>
        </td>
        {/* Contact details and timestamps read as data, so they take the mono face. */}
        <td className={`px-4 py-2 text-xs text-slate-ink ${mono}`}>{c.email}</td>
        <td className="px-4 py-2">{c.stage}</td>
        <td className="px-4 py-2">{badge(c.kyc_status)}</td>
        <td className="px-4 py-2 text-slate-ink">{c.owner_name ?? '—'}</td>
        <td className={`px-4 py-2 text-xs text-slate-ink ${mono}`}>{when(c.created_at)}</td>
      </tr>

      {open && (
        <tr className="border-t border-pebble bg-bone/60 dark:border-white/10 dark:bg-white/5">
          <td colSpan={6} className="px-4 py-5">
            <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
              <div>
                <h3 className="font-mono text-[11px] tracking-[0.16em] text-slate-ink uppercase">Position</h3>
                {!holdings.data || !t ? (
                  <p className="mt-3 text-sm text-slate-ink">Loading…</p>
                ) : (
                  <>
                    <dl className="mt-3 grid grid-cols-3 gap-4">
                      <Figure label="Holdings" value={usd(t.holdings_usd)} />
                      <Figure label="Open P&L" value={usd(t.open_pnl)}
                        className={t.open_pnl >= 0 ? 'text-up' : 'text-down'} />
                      <Figure label="Equity" value={usd(t.equity_usd)} />
                    </dl>
                    <p className="mt-4 font-mono text-xs text-slate-ink">
                      {holdings.data.accounts.length
                        ? holdings.data.accounts.map((a) => `${a.balance.toLocaleString()} ${a.currency}`).join(' · ')
                        : 'no cash balances'}
                    </p>
                    {!!holdings.data.wallets.length && (
                      <p className="mt-1 font-mono text-xs text-slate-ink">
                        {holdings.data.wallets.map((w) => `${w.balance} ${w.asset}`).join(' · ')}
                      </p>
                    )}
                    {!!t.unpriced.length && (
                      <p className="mt-2 text-xs text-slate-ink">
                        Excludes {t.unpriced.join(', ')} — no price source.
                      </p>
                    )}
                  </>
                )}
                <a href={`#/clients/${c.id}`}
                  className="mt-5 inline-block font-mono text-xs text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">
                  Open the full record →
                </a>
              </div>

              <div className="space-y-6">
                <QuickCredit clientId={c.id} onDone={() => { holdings.reload(); onChanged(); }} />
                <Documents clientId={c.id} canDownload={canReviewKyc} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

type Doc = { id: string; kind: string; status: string; uploaded_at: string; storage_key: string };

/**
 * Documents sit behind auth, so a plain href would arrive without the bearer token and be
 * refused. Fetch it, then hand the browser a blob URL to save.
 */
async function download(d: Doc) {
  const res = await fetch(`/api/kyc/${d.id}/file`, {
    headers: { authorization: `Bearer ${token.get()}` },
  });
  if (!res.ok) return alert('Could not download that document');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  // Keep the stored extension so the file opens in the right thing once saved.
  a.download = d.storage_key || `${d.kind}-${d.id}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The client's uploaded documents, with a download for whoever is allowed to open one.
 *
 * Listing a document and reading it are different permissions on purpose: anyone with CRM
 * access can see that an ID was uploaded, but the file itself needs kyc:review. So the
 * link only appears for those who can actually use it — offering a download that answers
 * 403 is worse than not offering it.
 */
function Documents({ clientId, canDownload }: { clientId: string; canDownload: boolean }) {
  const docs = useApi<Doc[]>(`/clients/${clientId}/kyc`);

  return (
    <div>
      <h3 className="font-mono text-[11px] tracking-[0.16em] text-slate-ink uppercase">Documents</h3>
      {!docs.data ? (
        <p className="mt-3 text-sm text-slate-ink">Loading…</p>
      ) : docs.data.length === 0 ? (
        <p className="mt-3 text-sm text-slate-ink">Nothing uploaded yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-pebble dark:divide-white/10">
          {docs.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="font-medium">{d.kind.replace(/_/g, ' ')}</span>
              <span className="rounded-full bg-pebble px-2 py-0.5 text-xs text-obsidian dark:bg-white/10 dark:text-vellum">
                {d.status}
              </span>
              <span className={`text-xs text-slate-ink ${mono}`}>{when(d.uploaded_at)}</span>
              {canDownload && (
                <button type="button" onClick={() => download(d)}
                  className="ml-auto font-mono text-xs text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">
                  Download ↓
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!canDownload && !!docs.data?.length && (
        <p className="mt-2 text-xs text-slate-ink">
          Opening a document needs KYC review permission.
        </p>
      )}
    </div>
  );
}

const Figure = ({ label, value, className = '' }: { label: string; value: string; className?: string }) => (
  <div>
    <dt className="text-xs text-slate-ink">{label}</dt>
    <dd className={`font-mono text-sm font-medium tabular-nums ${className}`}>{value}</dd>
  </div>
);

/** Credit a client without leaving the list. The same audited routes used everywhere else. */
function QuickCredit({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const currencies = useApi<{ code: string; name: string; kind: 'fiat' | 'crypto' }[]>('/currencies');
  const [code, setCode] = useState('USD');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const chosen = currencies.data?.find((x) => x.code === code);
  const fiat = currencies.data?.filter((x) => x.kind === 'fiat') ?? [];
  const crypto = currencies.data?.filter((x) => x.kind === 'crypto') ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      // Crypto goes to the wallet, fiat to the cash account. Same button, right route.
      const path = chosen?.kind === 'crypto'
        ? `/clients/${clientId}/wallet-credit`
        : `/clients/${clientId}/credit`;
      const body = chosen?.kind === 'crypto'
        ? { asset: code, amount: Number(amount) }
        : { currency: code, amount: Number(amount), note: note || undefined };
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setDone(`Credited ${amount} ${code}`);
      setAmount('');
      setNote('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="space-y-3">
      <h3 className="font-mono text-[11px] tracking-[0.16em] text-slate-ink uppercase">Add balance</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-ink">
          Currency
          <select className={`${field} mt-1 block w-48`} value={code} onChange={(e) => setCode(e.target.value)}>
            <optgroup label="Crypto">
              {crypto.map((x) => <option key={x.code} value={x.code}>{x.code} — {x.name}</option>)}
            </optgroup>
            <optgroup label="Currencies">
              {fiat.map((x) => <option key={x.code} value={x.code}>{x.code} — {x.name}</option>)}
            </optgroup>
          </select>
        </label>
        <label className="text-xs text-slate-ink">
          Amount
          <input className={`${field} mt-1 block w-32`} type="number" step="any" min="0" required
            placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {chosen?.kind !== 'crypto' && (
          <label className="text-xs text-slate-ink">
            Reason
            <input className={`${field} mt-1 block w-48`} placeholder="Appears on the timeline"
              value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        )}
        <button className={btn} disabled={busy}>{busy ? 'Crediting…' : 'Add balance'}</button>
      </div>
      <p className="text-xs text-slate-ink">
        Credits are audited and written to the client's timeline, so the money always has a
        reason attached to it.
      </p>
      {error && <p role="alert" className={alertBox}>{error}</p>}
      {done && <p role="status" className="font-mono text-xs text-slate-ink">{done}</p>}
    </form>
  );
}
