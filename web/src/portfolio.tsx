import { useState } from 'react';
import { alertBox, btn, card, field } from './App.tsx';
import { api, useApi } from './api.ts';
import { PotArt } from './portfolio-art.tsx';
import type { Currency } from './wallet.tsx';

type PortfolioType = {
  code: string; name: string; description: string;
  indicative_rate: number | null; sort_order: number;
};
type Portfolio = {
  id: string; type_code: string; type_name: string; name: string; currency: string;
  balance: number; target_date: string | null; featured: boolean;
  status: 'open' | 'closed'; indicative_rate: number | null; standard_rate: number | null;
  rate_override: number | null;
  usd_value: number | null; progress: number | null; projected: number | null;
  earned: number; requested: number;
};
type Movement = {
  id: number; kind: 'contribution' | 'withdrawal' | 'interest'; amount: number;
  note: string | null; at: string;
};
type Request = {
  id: number; portfolio_name: string; currency: string; amount: number;
  status: string; note: string | null; decision_note: string | null; created_at: string;
};

const money = (n: number, code: string) =>
  `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${code}`;
// One decimal is enough for a progress bar and wrong for a rate: an agreed 7.25% shown as
// 7.2% is a smaller number than the one on the client's screen everywhere else. Up to two,
// with trailing zeros trimmed, so 3.5% does not become 3.50%.
const pct = (n: number) => `${Number((n * 100).toFixed(2))}%`;
const day = (d: string) => new Date(d).toLocaleDateString();
const usd = (n: number) =>
  '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type On = { client_id?: string };

/**
 * A client's pots: open one, pay into it, ask for money back out.
 *
 * The same panel serves both sides. A client passes no clientId and acts on themselves;
 * staff pass one and act on that client, which the API makes them name on every write. One
 * component rather than a staff copy — two versions of a screen that moves money is two
 * places for the rules to drift apart.
 */
export function PortfoliosPanel({ clientId, onChanged }: { clientId?: string; onChanged?: () => void } = {}) {
  const on: On = clientId ? { client_id: clientId } : {};
  const portfolios = useApi<Portfolio[]>(clientId ? `/portfolios?client_id=${clientId}` : '/portfolios');
  const types = useApi<PortfolioType[]>('/portfolio-types');
  const currencies = useApi<Currency[]>('/currencies');
  // A client's own requests; staff see the whole queue on their own page.
  const requests = useApi<Request[]>(clientId ? '' : '/me/portfolio-requests');
  const [adding, setAdding] = useState(false);

  const reload = () => { portfolios.reload(); requests.reload(); onChanged?.(); };
  const open = portfolios.data?.filter((p) => p.status === 'open') ?? [];
  const closed = portfolios.data?.filter((p) => p.status === 'closed') ?? [];
  const waiting = (requests.data ?? []).filter((r) => r.status === 'pending');

  // Valued in dollars so pots in different currencies can be one figure; null when
  // something has no price source, which the strip already says elsewhere.
  const total = open.reduce((n, p) => n + Number(p.usd_value ?? 0), 0);
  const earned = open.reduce((n, p) => n + Number(p.earned ?? 0), 0);

  return (
    <div className="stagger space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="metric-label">{clientId ? 'Portfolios' : 'Your portfolios'}</h3>
        <button className={`${btn} ml-auto`} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New portfolio'}
        </button>
      </div>

      {!!open.length && (
        <div className={`${card} flex flex-wrap items-center gap-x-10 gap-y-3`}>
          <div>
            <p className="metric-label">Set aside</p>
            <p className="font-mono text-2xl leading-tight font-medium tabular-nums text-ember-ink">
              {usd(total)}
            </p>
          </div>
          <div>
            <p className="metric-label">Pots</p>
            <p className="font-mono text-2xl leading-tight font-medium tabular-nums">{open.length}</p>
          </div>
          <div>
            <p className="metric-label">Interest earned</p>
            <p className="font-mono text-2xl leading-tight font-medium tabular-nums text-up">
              {earned > 0 ? `+${earned.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '0'}
            </p>
          </div>
          {!!waiting.length && (
            <div>
              <p className="metric-label">Awaiting a decision</p>
              <p className="font-mono text-2xl leading-tight font-medium tabular-nums text-ember-ink">
                {waiting.length}
              </p>
            </div>
          )}
          <p className="ml-auto max-w-xs text-xs text-slate-ink">
            Money pays in straight away and comes back out by request, so what is set aside
            stays set aside until you mean it.
          </p>
        </div>
      )}

      {adding && (
        <NewPortfolio types={types.data ?? []} currencies={currencies.data ?? []} on={on}
          onDone={() => { setAdding(false); reload(); }} />
      )}

      {open.map((p) => <Pot key={p.id} p={p} on={on} onDone={reload} />)}
      {!open.length && !adding && (
        <p className="text-sm text-slate-ink">
          {clientId
            ? 'No portfolios yet. Opening one here does it on the client’s behalf, and is recorded that way.'
            : 'No portfolios yet. Open one to set money aside for a particular purpose — it earns while it sits there.'}
        </p>
      )}

      {!clientId && !!(requests.data ?? []).length && (
        <div className={`${card} space-y-3`}>
          <h3 className="metric-label">Your requests</h3>
          <ul className="divide-y divide-pebble dark:divide-white/10">
            {requests.data!.slice(0, 8).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="font-mono tabular-nums">{money(r.amount, r.currency)}</span>
                <span className="text-slate-ink">from {r.portfolio_name}</span>
                <span className="font-mono text-xs text-slate-ink">{day(r.created_at)}</span>
                <span className={`ml-auto rounded-full px-2.5 py-0.5 font-mono text-[11px] tracking-wide uppercase ${
                  r.status === 'approved' ? 'bg-up/15 text-up'
                    : r.status === 'declined' ? 'bg-down/15 text-down'
                    : 'bg-ember/15 text-ember-ink'}`}>
                  {r.status === 'pending' ? 'with the desk' : r.status}
                </span>
                {r.decision_note && (
                  <span className="w-full text-xs text-slate-ink">{r.decision_note}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!!closed.length && (
        <details className="text-sm text-slate-ink">
          <summary className="cursor-pointer">{closed.length} closed</summary>
          <ul className="mt-1 space-y-1">
            {closed.map((p) => <li key={p.id}>{p.name} — {p.type_name}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Which pot the client wants on the balance strip at the top of every page. One at a time,
 * and theirs to choose — the desk has no business deciding which of somebody's goals they
 * want to look at.
 */
function FeatureToggle({ p, on, onDone }: { p: Portfolio; on: On; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if (on.client_id) return null;   // staff act on the client, not on their preferences
  return (
    <button type="button" disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/portfolios/${p.id}/feature`, {
            method: 'POST', body: JSON.stringify({ featured: !p.featured }),
          });
          onDone();
        } finally { setBusy(false); }
      }}
      className={`rounded-full border px-2.5 py-1 transition-colors ${p.featured
        ? 'border-ember text-ember-ink'
        : 'border-pebble text-slate-ink hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum'}`}>
      {p.featured ? '★ on your balance' : '☆ show on balance'}
    </button>
  );
}

/** What has gone in, come out and been paid, once somebody asks to see it. */
function History({ p }: { p: Portfolio }) {
  const rows = useApi<Movement[]>(`/portfolios/${p.id}/transactions`);
  const list = rows.data ?? [];

  if (!rows.data) return <p className="mt-3 text-xs text-slate-ink">Loading…</p>;
  if (!list.length) return <p className="mt-3 text-xs text-slate-ink">Nothing has moved yet.</p>;

  return (
    <ul className="mt-3 divide-y divide-pebble text-xs dark:divide-white/10">
      {list.slice(0, 20).map((m) => (
        <li key={m.id} className="flex flex-wrap items-center gap-3 py-1.5">
          <span className={`w-24 shrink-0 rounded-md px-1.5 py-0.5 text-center font-mono text-[10px] uppercase ${
            m.kind === 'interest' ? 'bg-up/15 text-up'
              : m.kind === 'contribution' ? 'bg-bone text-slate-ink dark:bg-white/10'
              : 'bg-ember/15 text-ember-ink'}`}>
            {m.kind === 'contribution' ? 'paid in' : m.kind === 'withdrawal' ? 'taken out' : 'interest'}
          </span>
          <span className={`font-mono tabular-nums ${Number(m.amount) < 0 ? 'text-down' : 'text-up'}`}>
            {Number(m.amount) > 0 ? '+' : ''}{money(m.amount, p.currency)}
          </span>
          {m.note && <span className="text-slate-ink">{m.note}</span>}
          <span className="ml-auto font-mono text-slate-ink">{day(m.at)}</span>
        </li>
      ))}
    </ul>
  );
}

function Pot({ p, on, onDone }: { p: Portfolio; on: On; onDone: () => void }) {
  const [action, setAction] = useState<'contribute' | 'withdraw' | null>(null);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [rate, setRate] = useState(false);
  const [history, setHistory] = useState(false);
  const [amt, setAmt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function move(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (action === 'withdraw' && !on.client_id) {
        // A client asks; the desk decides. Nothing moves here.
        await api(`/portfolios/${p.id}/requests`, {
          method: 'POST', body: JSON.stringify({ amount: Number(amt), note: note || undefined }),
        });
        setSent('Sent to the desk. You will hear when it is decided.');
      } else {
        await api(`/portfolios/${p.id}/${action}`, { method: 'POST', body: JSON.stringify({ ...on, amount: Number(amt) }) });
        setSent(null);
      }
      setAmt(''); setNote(''); setAction(null);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  async function close() {
    setError(null);
    try {
      await api(`/portfolios/${p.id}`, { method: 'PATCH', body: JSON.stringify({ ...on, status: 'closed' }) });
      onDone();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="rounded-lg border border-pebble bg-bone/50 p-4 dark:border-white/10 dark:bg-white/5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="shrink-0 text-ember-ink"><PotArt code={p.type_code} size={32} /></span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{p.name}</span>
          <span className="block text-xs text-slate-ink">{p.type_name}</span>
        </span>

        <span className="ml-auto flex items-center gap-6">
          <span className="text-right">
            <span className="metric-label block">Return</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums text-ember-ink">
              {p.indicative_rate === null ? '—' : pct(p.indicative_rate)}
            </span>
            {p.rate_override !== null && (
              <span className="block font-mono text-[10px] tracking-wide text-slate-ink uppercase">agreed</span>
            )}
          </span>
          <span className="text-right">
            <span className="metric-label block">Earned</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums text-up">
              {Number(p.earned) > 0 ? `+${money(p.earned, p.currency)}` : `0 ${p.currency}`}
            </span>
          </span>
          <span className="text-right">
            <span className="metric-label block">Balance</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums">
              {money(p.balance, p.currency)}
            </span>
          </span>
        </span>
      </div>

      {/* Money already asked for, so a second request is made knowing about the first. */}
      {Number(p.requested) > 0 && (
        <p className="mt-2 rounded-md border border-ember/40 bg-ember/10 px-2.5 py-1.5 text-xs text-ember-ink">
          {money(p.requested, p.currency)} is with the desk waiting on a decision.
        </p>
      )}

      {p.target_date && (
        <p className="mt-2 text-xs text-slate-ink">Target date {day(p.target_date)}.</p>
      )}

      {p.projected !== null && (
        <p className="mt-1 text-xs text-slate-ink">
          {/* Interest is genuinely credited daily at this rate, so the projection is a
              forecast of the accrual rather than a decorative illustration. */}
          Credited daily — projected {money(p.projected, p.currency)} by {p.target_date && day(p.target_date)} if
          left untouched.
        </p>
      )}
      {p.projected === null && p.indicative_rate !== null && (
        <p className="mt-1 text-xs text-slate-ink">Credited daily on the balance in the pot.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => { setAction(action === 'contribute' ? null : 'contribute'); setError(null); }}
          className="rounded-full border border-pebble px-2.5 py-1 text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
          pay in
        </button>
        <button onClick={() => { setAction(action === 'withdraw' ? null : 'withdraw'); setError(null); setSent(null); }}
          className="rounded-full border border-pebble px-2.5 py-1 text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
          {on.client_id ? 'take out' : 'submit a request'}
        </button>
        <FeatureToggle p={p} on={on} onDone={onDone} />
        <button onClick={() => setHistory((v) => !v)}
          className="rounded-full border border-pebble px-2.5 py-1 text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
          {history ? 'hide history' : 'history'}
        </button>
        {on.client_id && (
          <button onClick={() => { setRate((v) => !v); setError(null); }}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${rate
              ? 'border border-ember text-ember-ink hover:bg-ember/10'
              : 'bg-ember text-graphite hover:brightness-110'}`}>
            {rate ? 'Close' : 'Change return'}
          </button>
        )}
        {Number(p.balance) === 0 && (
          <button onClick={close} className="ml-auto text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">close</button>
        )}
      </div>

      {action && (
        <form onSubmit={move} className="mt-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <input className={`${field} w-32`} type="number" step="any" min="0" required autoFocus
              placeholder={`Amount in ${p.currency}`} value={amt} onChange={(e) => setAmt(e.target.value)} />
            {action === 'withdraw' && !on.client_id && (
              <input className={`${field} min-w-48 flex-1`} maxLength={400} placeholder="What it is for (optional)"
                value={note} onChange={(e) => setNote(e.target.value)} />
            )}
            <button className={btn} disabled={busy}>
              {busy ? 'Sending…'
                : action === 'contribute' ? 'Pay in'
                : on.client_id ? 'Take out' : 'Submit request'}
            </button>
          </div>
          {action === 'withdraw' && !on.client_id && (
            <p className="text-xs text-slate-ink">
              Money comes out of a pot by request. The desk decides, and nothing moves until
              it does.
            </p>
          )}
        </form>
      )}
      {sent && <p role="status" className="mt-2 text-xs text-up">{sent}</p>}
      {history && <History p={p} />}
      {rate && on.client_id && (
        <SetRate p={p} on={on} onDone={() => { setRate(false); onDone(); }} onError={setError} />
      )}
      {error && <p role="alert" className={`${alertBox} mt-1 `}>{error}</p>}
    </div>
  );
}

/**
 * The rate this one pot earns, as agreed with this one client.
 *
 * Entered as a percentage because that is how it is agreed and how it is shown; stored as
 * a fraction, converted once, here. Clearing it puts the pot back on the product's rate
 * rather than on nothing — a blank box meaning "earns zero" would be a quiet way to stop
 * paying somebody.
 */
function SetRate({ p, on, onDone, onError }: {
  p: Portfolio; on: On; onDone: () => void; onError: (m: string | null) => void;
}) {
  const asPercent = (n: number | null) => (n === null ? '' : String(Number((n * 100).toFixed(4))));
  const [value, setValue] = useState(asPercent(p.rate_override));
  const [busy, setBusy] = useState(false);

  async function save(next: number | null) {
    setBusy(true);
    onError(null);
    try {
      await api(`/portfolios/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...on, rate_override: next }),
      });
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form className="mt-2 space-y-2 rounded-md border border-ember/40 p-2"
      onSubmit={(e) => { e.preventDefault(); save(value === '' ? null : Number(value) / 100); }}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-ink">
          Rate
          <span className="mt-1 flex items-center gap-1">
            <input className={`${field} w-24`} type="number" step="0.01" min="0" max="100" autoFocus
              placeholder={asPercent(p.standard_rate) || '0'}
              value={value} onChange={(e) => setValue(e.target.value)} />
            <span className="font-mono text-xs">% a year</span>
          </span>
        </label>
        <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Set rate'}</button>
        {p.rate_override !== null && (
          <button type="button" disabled={busy} onClick={() => save(null)}
            className="font-mono text-xs text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">
            back to standard
          </button>
        )}
      </div>
      <p className="text-xs text-slate-ink">
        {p.rate_override === null
          ? `On the standard ${p.standard_rate === null ? 'rate' : pct(p.standard_rate)} for this product.`
          : `Agreed rate. The standard for this product is ${p.standard_rate === null ? 'nothing' : pct(p.standard_rate)}.`}
        {' '}Credited daily, and the client is told when it changes.
      </p>
    </form>
  );
}

function NewPortfolio({ types, currencies, on, onDone }: {
  types: PortfolioType[]; currencies: Currency[]; on: On; onDone: () => void;
}) {
  const [type, setType] = useState('retirement');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = types.find((t) => t.code === type);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/portfolios', {
        method: 'POST',
        body: JSON.stringify({
          ...on,
          type_code: type,
          name: f.get('name'),
          currency: f.get('currency'),
          ...(f.get('target_date') ? { target_date: f.get('target_date') } : {}),
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
        <h3 className="metric-label">What is it for?</h3>
        {/* A radiogroup, not a listbox: these are six things with pictures, and the picture
            is most of what tells them apart. Kept as real radios underneath so arrow keys
            move between them and a screen reader reads it as one choice. */}
        <div role="radiogroup" aria-label="Kind of portfolio"
          className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {types.map((t) => {
            const on = t.code === type;
            return (
              <label key={t.code}
                className={`flex aspect-square cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border p-3 text-center transition-colors ${on
                  ? 'border-ember bg-ember/10 text-ember-ink'
                  : 'border-pebble text-slate-ink hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum'}`}>
                <input type="radio" name="type_code" value={t.code} checked={on} className="sr-only"
                  onChange={() => setType(t.code)} />
                <PotArt code={t.code} />
                <span className={`text-xs leading-tight font-medium ${on ? '' : 'text-obsidian dark:text-vellum'}`}>
                  {t.name}
                </span>

              </label>
            );
          })}
        </div>
      </div>
      {chosen && <p className="text-xs text-slate-ink">{chosen.description}</p>}
      <div className="flex flex-wrap gap-2">
        <input name="name" required maxLength={80} placeholder="Name it, e.g. Retirement 2055"
          className={`${field} flex-1`} />
        <select name="currency" className={`${field} w-28`} defaultValue="USD">
          {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="text-xs text-slate-ink">Target date (optional)
          <input name="target_date" type="date" className={field} /></label>
      </div>
      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
      <button className={btn} disabled={busy}>{busy ? 'Opening…' : 'Open portfolio'}</button>
    </form>
  );
}
