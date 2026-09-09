import { useState } from 'react';
import { alertBox, btn, card, field, input } from './App.tsx';
import { api, useApi } from './api.ts';

export type Currency = { code: string; name: string; kind: 'fiat' | 'crypto'; decimals: number };
type Balance = { currency: string; balance: number; usd_value: number | null };
type Wallet = { id: string; asset: string; address: string; balance: number; usd_value: number | null };
type Accounts = { cash: Balance[]; wallets: Wallet[]; total_usd: number; unpriced: string[] };
type WalletTx = {
  id: number; asset: string; kind: string; amount: number;
  to_address: string | null; tx_ref: string | null; status: string; created_at: string;
};

const when = (iso: string) => new Date(iso).toLocaleString();
const usd = (n: number) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Show a balance to its own minor unit — JPY has none, ETH has eighteen. */
const amount = (n: number, decimals: number) =>
  Number(n).toLocaleString(undefined, { minimumFractionDigits: Math.min(decimals, 2), maximumFractionDigits: decimals });

const STATUS: Record<string, string> = {
  confirmed: 'text-slate-ink', rejected: 'text-slate-ink', pending: 'rounded-full bg-ember px-2 py-0.5 text-xs font-medium text-graphite',
};

/** Every balance the client holds: fiat accounts and crypto wallets, plus a USD total. */
export function HoldingsPanel() {
  const accounts = useApi<Accounts>('/accounts');
  const currencies = useApi<Currency[]>('/currencies');
  const history = useApi<WalletTx[]>('/wallet-transactions');
  const [asset, setAsset] = useState('BTC');
  const [error, setError] = useState<string | null>(null);

  const decimals = (code: string) => currencies.data?.find((c) => c.code === code)?.decimals ?? 2;
  const crypto = currencies.data?.filter((c) => c.kind === 'crypto') ?? [];
  const reload = () => { accounts.reload(); history.reload(); };

  async function openWallet() {
    setError(null);
    try {
      await api('/wallets', { method: 'POST', body: JSON.stringify({ asset }) });
      reload();
    } catch (err) { setError((err as Error).message); }
  }

  const a = accounts.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-sm text-slate-ink">Total holdings</span>
        <span className="text-xl font-semibold tabular-nums">{a ? usd(a.total_usd) : '—'}</span>
        {!!a?.unpriced.length && (
          <span className="text-xs text-slate-ink">
            excludes {a.unpriced.join(', ')} — no price source
          </span>
        )}
      </div>

      <Converter held={[...(a?.cash.map((c) => c.currency) ?? []), ...(a?.wallets.map((w) => w.asset) ?? [])]}
        currencies={currencies.data ?? []} onDone={reload} />

      <div>
        <h3 className="mb-1 text-xs font-medium text-slate-ink">Cash</h3>
        <table className="w-full text-sm">
          <tbody>
            {a?.cash.map((b) => (
              <tr key={b.currency} className="border-t border-pebble dark:border-white/10">
                <td className="px-3 py-1.5 font-medium">{b.currency}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{amount(b.balance, decimals(b.currency))}</td>
                <td className="px-3 py-1.5 text-right text-slate-ink tabular-nums">
                  {b.usd_value === null ? '—' : usd(b.usd_value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-medium text-slate-ink">Crypto wallets</h3>
        {/* A real safety warning, so it must be readable: ember edge, obsidian words. */}
        <p className={`${alertBox} mb-2 text-xs`}>
          Simulated wallets. Addresses are labelled <code>DEMO-</code> and belong to no chain —
          never send real funds to one.
        </p>
        {a?.wallets.map((w) => (
          <Wallet key={w.id} wallet={w} decimals={decimals(w.asset)} onDone={reload} />
        ))}
        {a?.wallets.length === 0 && <p className="px-3 py-2 text-sm text-slate-ink">No wallets yet.</p>}

        <div className="mt-2 flex items-center gap-2">
          <select className={`${field} w-32`} value={asset} onChange={(e) => setAsset(e.target.value)}>
            {crypto.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </select>
          <button className={btn} onClick={openWallet}>Open wallet</button>
        </div>
        {error && <p role="alert" className={`${alertBox} mt-1 `}>{error}</p>}
      </div>

      {!!history.data?.length && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-slate-ink">Wallet activity</h3>
          <table className="w-full text-sm">
            <tbody>
              {history.data.map((t) => (
                <tr key={t.id} className="border-t border-pebble dark:border-white/10">
                  <td className="px-3 py-1.5 text-slate-ink">{when(t.created_at)}</td>
                  <td className="px-3 py-1.5">{t.kind}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {amount(t.amount, decimals(t.asset))} {t.asset}
                  </td>
                  <td className={`px-3 py-1.5 ${STATUS[t.status] ?? ''}`}>{t.status}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-ink">{t.tx_ref ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type Quote = { from: string; to: string; amount: number; received: number; rate: number; dustUsd: number };

/** Exchange one of the client's own balances for another. */
function Converter({ held, currencies, onDone }: {
  held: string[]; currencies: Currency[]; onDone: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('USD');
  const [amt, setAmt] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const source = from || held[0] || '';
  const amount = Number(amt);
  const ready = source && to && source !== to && amount > 0;

  // Quote on demand rather than on every keystroke: it is only indicative anyway, since
  // the rate is read again when the exchange actually runs.
  async function getQuote() {
    setError(null); setQuote(null);
    try {
      setQuote(await api<Quote>(`/convert/quote?from=${source}&to=${to}&amount=${amount}`));
    } catch (err) { setError((err as Error).message); }
  }

  async function exchange() {
    setBusy(true); setError(null);
    try {
      // Accept a little movement, but not a collapse: if the rate has moved enough that
      // 1% less would arrive, the exchange is refused rather than silently repriced.
      await api('/convert', {
        method: 'POST',
        body: JSON.stringify({ from: source, to, amount, ...(quote ? { min_receive: quote.received * 0.99 } : {}) }),
      });
      setAmt(''); setQuote(null);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-md border border-pebble p-3 dark:border-white/10">
      <h3 className="mb-2 text-xs font-medium text-slate-ink">Exchange between your balances</h3>
      <div className="flex flex-wrap items-end gap-2">
        <input className={`${field} w-28`} type="number" step="any" min="0" placeholder="Amount"
          value={amt} onChange={(e) => { setAmt(e.target.value); setQuote(null); }} />
        <select className={`${field} w-28`} value={source} onChange={(e) => { setFrom(e.target.value); setQuote(null); }}>
          {held.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="pb-2 text-slate-ink">to</span>
        <select className={`${field} w-36`} value={to} onChange={(e) => { setTo(e.target.value); setQuote(null); }}>
          {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
        </select>
        {quote
          ? <button className={btn} disabled={busy} onClick={exchange}>{busy ? 'Exchanging…' : 'Confirm'}</button>
          : <button className={btn} disabled={!ready} onClick={getQuote}>Quote</button>}
      </div>
      {quote && (
        <p className="mt-2 text-sm">
          {quote.amount} {quote.from} → <strong>{quote.received} {quote.to}</strong>
          <span className="text-slate-ink"> at {quote.rate.toPrecision(6)}</span>
          {/* Only worth saying when it rounds to something visible; sub-cent dust shown
              as "$0.00 lost" reads as a bug rather than as nothing. */}
          {quote.dustUsd >= 0.005 && <span className="text-slate-ink"> · {usd(quote.dustUsd)} lost to rounding</span>}
        </p>
      )}
      {error && <p role="alert" className={`${alertBox} mt-1 `}>{error}</p>}
    </div>
  );
}

function Wallet({ wallet, decimals, onDone }: { wallet: Wallet; decimals: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function withdraw(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/wallets/${wallet.id}/withdraw`, {
        method: 'POST', body: JSON.stringify({ amount: Number(amt), to_address: to }),
      });
      setAmt(''); setTo(''); setOpen(false);
      onDone();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="border-t border-pebble py-2 dark:border-white/10">
      <div className="flex flex-wrap items-baseline gap-3 text-sm">
        <span className="w-14 font-medium">{wallet.asset}</span>
        <span className="tabular-nums">{amount(wallet.balance, decimals)}</span>
        <span className="text-slate-ink">{wallet.usd_value === null ? '' : `≈ ${usd(wallet.usd_value)}`}</span>
        <button onClick={() => setOpen((v) => !v)} className="ml-auto text-xs text-slate-ink hover:text-obsidian dark:hover:text-vellum">
          {open ? 'cancel' : 'withdraw'}
        </button>
      </div>
      <p className="font-mono text-xs break-all text-slate-ink">{wallet.address}</p>
      {open && (
        <form onSubmit={withdraw} className="mt-2 flex flex-wrap items-end gap-2">
          <input className={`${field} w-32`} type="number" step="any" min="0" required placeholder="Amount"
            value={amt} onChange={(e) => setAmt(e.target.value)} />
          <input className={`${field} w-64`} required placeholder="Destination address"
            value={to} onChange={(e) => setTo(e.target.value)} />
          <button className={btn}>Request</button>
          <span className="text-xs text-slate-ink">Debited now; returned if rejected.</span>
        </form>
      )}
      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
    </div>
  );
}

/** Admin-only: put credit on a client's account in any currency, or into a crypto wallet. */
export function CreditForm({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const currencies = useApi<Currency[]>('/currencies');
  const [code, setCode] = useState('GBP');
  const [amt, setAmt] = useState('');
  const [note, setNote] = useState('');
  // Which way the money goes. Crypto only supports crediting here — taking coin back
  // out of a wallet is a withdrawal, which has its own flow and its own record.
  const [dir, setDir] = useState<'credit' | 'debit'>('credit');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chosen = currencies.data?.find((c) => c.code === code);
  const fiat = currencies.data?.filter((c) => c.kind === 'fiat') ?? [];
  const crypto = currencies.data?.filter((c) => c.kind === 'crypto') ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Crypto goes to the wallet, fiat to the currency account. Same button, right route.
      const path = chosen?.kind === 'crypto'
        ? `/clients/${clientId}/wallet-credit`
        : `/clients/${clientId}/${dir}`;
      const body = chosen?.kind === 'crypto'
        ? { asset: code, amount: Number(amt) }
        : { currency: code, amount: Number(amt), note: note || undefined };
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setResult(`${dir === 'debit' ? 'Debited' : 'Credited'} ${amt} ${code}`);
      setAmt(''); setNote('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-2`}>
      <h2 className="text-sm font-semibold">Adjust this account</h2>
      {/* Direction first: it changes what the button does, so it should be read first. */}
      <div className="flex gap-1">
        {(['credit', 'debit'] as const).map((d) => (
          <button key={d} type="button" onClick={() => setDir(d)} aria-pressed={dir === d}
            disabled={d === 'debit' && chosen?.kind === 'crypto'}
            className={`flex-1 rounded-md px-2 py-1 font-mono text-xs capitalize disabled:opacity-40 ${dir === d
              ? 'bg-ember font-medium text-graphite'
              : 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'}`}>
            {d}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <select className={`${field} w-40`} value={code} onChange={(e) => setCode(e.target.value)}>
          <optgroup label="Crypto">
            {crypto.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </optgroup>
          <optgroup label="Currencies">
            {fiat.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </optgroup>
        </select>
        <input className={input} type="number" step="any" min="0" required placeholder="Amount"
          value={amt} onChange={(e) => setAmt(e.target.value)} />
      </div>
      {chosen?.kind === 'fiat' && (
        <input className={input} maxLength={500} placeholder="Reason (appears on the timeline)"
          value={note} onChange={(e) => setNote(e.target.value)} />
      )}
      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
      {result && <p className="text-sm text-slate-ink">{result}</p>}
      <button className={`${btn} w-full`} disabled={busy}>
        {busy ? 'Working…' : dir === 'debit' ? 'Debit' : 'Credit'}
      </button>
      <p className="text-xs text-slate-ink">
        {dir === 'debit'
          ? 'Removes funds from the account. Refused rather than overdrawn if the balance is short, and the client is notified.'
          : "Creates funds out of nothing on a demo account. Audited, and written to the client's timeline."}
      </p>
    </form>
  );
}
