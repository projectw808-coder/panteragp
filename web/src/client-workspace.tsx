import { useState } from 'react';
import { alertBox, btn, card, field, input, tableCard, thead } from './App.tsx';
import { api, useApi, type Activity, type Client, type Stage, type Staff, type Task } from './api.ts';
import { DocumentsPanel, FlagList } from './compliance.tsx';
import { CreditForm } from './wallet.tsx';
import { PortfoliosPanel } from './portfolio.tsx';
import { StakingPanel } from './staking.tsx';
import { ResetPassword } from './settings.tsx';

type Holdings = {
  accounts: { id: string; currency: string; balance: number; mode: string; leverage: number }[];
  wallets: { id: string; asset: string; address: string; balance: number }[];
  portfolios: { id: string; name: string; type_name: string; currency: string; balance: number; status: string; target_amount: number | null }[];
  positions: { symbol: string; qty: number; avg_price: number; price: number; unrealized: number }[];
  orders: { id: string; symbol: string; side: string; type: string; qty: number; limit_price: number | null; stop_price: number | null; status: string; placed_at: string }[];
  trades: { id: number; symbol: string; side: string; qty: number; price: number; filled_at: string }[];
  cash: { id: number; kind: string; amount: number; status: string; created_at: string }[];
  totals: { holdings_usd: number; unpriced: string[]; open_pnl: number; equity_usd: number };
};
/** The client record as the workspace reads it: the CRM row plus their personal details. */
type Person = Client & {
  phone: string | null; country: string | null;
  date_of_birth: string | null; address: string | null;
  commission_bps: number | null; spread_bps: number | null;
};
type Ticket = { id: string; subject: string; status: string; priority: string; category: string; messages: number; updated_at: string };
type Audit = { id: number; at: string; actor: string; tbl: string; action: string; before: any; after: any };

const when = (iso: string) => new Date(iso).toLocaleString();
const usd = (n: number) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });
const pnlColour = (n: number) => (n >= 0 ? 'text-up' : 'text-down');

const TABS = ['overview', 'assets', 'trading', 'funding', 'documents', 'tickets', 'activity', 'audit'] as const;
// What the desk sells. Free text in the database because the list is a commercial decision
// rather than a structural one, and changing it should not be a migration.
const TIERS = ['standard', 'silver', 'gold', 'platinum'];
type Tab = (typeof TABS)[number];

const KYC: Record<string, string> = {
  approved: 'bg-pebble text-obsidian dark:bg-white/10 dark:text-vellum',
  pending: 'bg-ember text-graphite',
  rejected: 'bg-bone text-slate-ink dark:bg-white/5 dark:text-mist',
  expired: 'bg-ember text-graphite',
  none: 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist',
};

/** One client, everything about them, for staff. */
export function ClientWorkspace({ id, me }: { id: string; me: { sub: string; role?: string } | null }) {
  const [tab, setTab] = useState<Tab>('overview');
  // Changes are made in the header, which is always on screen; the open tab is not
  // watching for them. Bumping this remounts the tab body so it refetches.
  const [version, setVersion] = useState(0);
  const refresh = () => { setVersion((v) => v + 1); client.reload(); holdings.reload(); flags.reload(); };
  const client = useApi<Person>(`/clients/${id}`);
  const holdings = useApi<Holdings>(`/clients/${id}/holdings`);
  const flags = useApi<any[]>(`/flags?status=open&client_id=${id}`);
  const tickets = useApi<Ticket[]>(`/tickets?client_id=${id}`);
  const admin = me?.role === 'admin';
  const compliance = me?.role === 'compliance' || admin;

  if (client.error) return <p role="alert" className={`${alertBox} `}>{client.error}</p>;
  if (!client.data) return <p className="text-sm text-slate-ink">Loading…</p>;
  const c = client.data;
  const t = holdings.data?.totals;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Header client={c} holdings={holdings.data ?? undefined} onSaved={refresh}
        compliance={compliance} admin={admin} />

      <div className="flex flex-wrap gap-1 text-xs">
        {TABS.map((name) => (
          <button key={name} onClick={() => setTab(name)} aria-pressed={tab === name}
            className={`rounded-md px-3 py-1 capitalize ${tab === name
              ? 'bg-ember font-medium text-graphite'
              : 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'}`}>
            {name}
            {name === 'tickets' && tickets.data?.some((x) => x.status === 'open') ? ' •' : ''}
            {name === 'overview' && flags.data?.length ? ' •' : ''}
          </button>
        ))}
      </div>

      <div key={version}>
        {tab === 'overview' && (
          <Overview id={id} client={c} totals={t} flags={flags} admin={admin} onChanged={refresh} />
        )}
        {tab === 'assets' && <Assets id={id} h={holdings.data} admin={admin} onChanged={refresh} />}
        {tab === 'trading' && <Trading id={id} c={c} h={holdings.data} admin={admin} onChanged={refresh} />}
        {tab === 'funding' && <Funding id={id} h={holdings.data} compliance={compliance} onChanged={refresh} />}
        {tab === 'documents' && <DocumentsPanel clientId={id} canUpload={false} />}
        {tab === 'tickets' && <Tickets rows={tickets.data ?? []} />}
        {tab === 'activity' && <ActivityTab id={id} />}
        {tab === 'audit' && <AuditTab id={id} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ header

/**
 * Every currency the client actually holds, one chip each, and the USD total on the right.
 *
 * Cash accounts, crypto wallets and portfolios are three tables but one balance sheet, so
 * they are summed per currency — a USD account and a USD portfolio are one USD number, not
 * two chips that look like a bug. Zero balances are left out: a wallet that exists but is
 * empty is noise here. The total is the same figure the stats row calls Holdings, so if a
 * currency has no price source it is named rather than silently dropped.
 */
function Balances({ holdings }: { holdings?: Holdings }) {
  if (!holdings) return null;
  const by = new Map<string, number>();
  const add = (code: string, amount: number) => by.set(code, (by.get(code) ?? 0) + Number(amount));
  for (const a of holdings.accounts) add(a.currency, a.balance);
  for (const w of holdings.wallets) add(w.asset, w.balance);
  for (const p of holdings.portfolios) add(p.currency, p.balance);
  const held = [...by].filter(([, amount]) => amount !== 0).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <>
      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-pebble pt-3 dark:border-white/10">
        {held.length === 0 ? (
          <div className="text-sm text-slate-ink">No balances yet.</div>
        ) : held.map(([code, amount]) => (
          <div key={code}>
            <dt className="font-mono text-[11px] tracking-[0.12em] text-slate-ink uppercase">{code}</dt>
            <dd className="font-mono text-sm font-medium tabular-nums">{num(amount)}</dd>
          </div>
        ))}
        <div className="ml-auto text-right">
          <dt className="font-mono text-[11px] tracking-[0.12em] text-slate-ink uppercase">Total</dt>
          <dd className="font-mono text-base font-medium tabular-nums">{usd(holdings.totals.holdings_usd)}</dd>
        </div>
      </dl>
      {!!holdings.totals.unpriced.length && (
        <p className="text-xs text-slate-ink">
          Total excludes {holdings.totals.unpriced.join(', ')} — no price source.
        </p>
      )}
    </>
  );
}

function Header({ client: c, holdings, onSaved, compliance, admin }: {
  client: Person;
  holdings?: Holdings; onSaved: () => void; compliance: boolean; admin: boolean;
}) {
  const totals = holdings?.totals;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stages = useApi<Stage[]>('/pipeline-stages');
  const staff = useApi<Staff[]>('/staff');

  const patch = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await api(`/clients/${c.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      onSaved();
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className={`${card} space-y-3`}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-64">
          {/* The serif starts at 28px; below that the system uses the sans. */}
          <h1 className="font-display text-[28px] leading-none tracking-tight">{c.name}</h1>
          {/* Contact details are read aloud off this screen, so they are set at the full
              ink rather than the muted grey the rest of the metadata uses. */}
          <p className="mt-2 font-mono text-sm text-ember">{c.email}</p>
          <p className="font-mono text-sm text-obsidian dark:text-vellum">
            {c.phone ?? 'no phone'}
            <span className="text-slate-ink"> · </span>{c.country ?? '—'}
            <span className="text-slate-ink"> · </span>{c.tier}
          </p>
          {(c.date_of_birth || c.address) && (
            <p className="font-mono text-sm text-obsidian dark:text-vellum">
              {c.date_of_birth ? new Date(c.date_of_birth).toLocaleDateString() : '—'}
              {c.address && <><span className="text-slate-ink"> · </span>{c.address}</>}
            </p>
          )}
          <p className="mt-2 flex items-center gap-2 text-xs">
            <span className={`rounded-full px-2 py-0.5 ${KYC[c.kyc_status] ?? ''}`}>KYC {c.kyc_status}</span>
            <span className="text-slate-ink">risk {c.risk_profile ?? 'not set'}</span>
          </p>
        </div>

        {/* The dark sidebar takes 224px, so four stat columns need a wide viewport. */}
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 text-sm xl:grid-cols-4">
          <Stat label="Holdings" value={totals ? usd(totals.holdings_usd) : '—'} />
          <Stat label="Open P&L" value={totals ? usd(totals.open_pnl) : '—'}
            className={totals ? pnlColour(totals.open_pnl) : ''} />
          <Stat label="Equity" value={totals ? usd(totals.equity_usd) : '—'} />
          <Stat label="Since" value={new Date(c.created_at).toLocaleDateString()} />
        </dl>

        <button className="rounded-md border border-ember px-3 py-1.5 text-sm font-medium text-ember hover:bg-ember hover:text-graphite"
          onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Edit'}</button>
      </div>

      <Balances holdings={holdings} />

      <div className="flex flex-wrap items-end gap-2">
        <Labelled label="Stage">
          <select className={`${field} w-36`} value={c.stage_id}
            onChange={(e) => patch({ stage_id: Number(e.target.value) })}>
            {stages.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Labelled>
        <Labelled label="Owner">
          <select className={`${field} w-40`} value={c.owner_staff_id ?? ''}
            onChange={(e) => patch({ owner_staff_id: e.target.value || null })}>
            <option value="">Unassigned</option>
            {staff.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Labelled>
        <Labelled label="Risk">
          <select className={`${field} w-28`} value={c.risk_profile ?? ''}
            onChange={(e) => patch({ risk_profile: e.target.value || null })}>
            <option value="">not set</option>
            {['low', 'medium', 'high'].map((r) => <option key={r}>{r}</option>)}
          </select>
        </Labelled>
        {admin && (
          <Labelled label="Tier">
            {/* A select rather than the free-text box in the edit form: a tier is one of a
                known set, and "Gold " with a trailing space is a tier nothing matches. The
                client's existing value is kept as an option so an older record set by hand
                is not silently rewritten by opening this menu. */}
            <select className={`${field} w-32`} value={c.tier}
              onChange={(e) => patch({ tier: e.target.value })}>
              {[...new Set([...TIERS, c.tier])].map((t) => <option key={t}>{t}</option>)}
            </select>
          </Labelled>
        )}
        {compliance && (
          <Labelled label="KYC (override)">
            <select className={`${field} w-32`} value={c.kyc_status}
              onChange={(e) => patch({ kyc_status: e.target.value })}>
              {['none', 'pending', 'approved', 'rejected', 'expired'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Labelled>
        )}
      </div>

      {editing && (
        <form className="flex flex-wrap items-end gap-2 border-t border-pebble pt-3 dark:border-white/10"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            // A cleared box means remove it, for the fields that can be nothing. The rest
            // are required, so blank there means "leave it" rather than "delete the name".
            const clearable = new Set(['date_of_birth', 'address']);
            await patch(Object.fromEntries([...f.entries()]
              .filter(([k, v]) => v !== '' || clearable.has(k))
              .map(([k, v]) => [k, v === '' ? null : v])));
            setEditing(false);
          }}>
          <p className="w-full metric-label">Personal details</p>
          <Labelled label="Name"><input name="name" defaultValue={c.name} className={`${field} w-48`} /></Labelled>
          <Labelled label="Email"><input name="email" type="email" defaultValue={c.email} className={`${field} w-56`} /></Labelled>
          <Labelled label="Phone"><input name="phone" defaultValue={c.phone ?? ''} className={`${field} w-40`} /></Labelled>
          <Labelled label="Date of birth">
            <input name="date_of_birth" type="date" defaultValue={c.date_of_birth?.slice(0, 10) ?? ''} className={`${field} w-40`} />
          </Labelled>
          <Labelled label="Country"><input name="country" maxLength={2} placeholder="GB" defaultValue={c.country ?? ''} className={`${field} w-16`} /></Labelled>
          <Labelled label="Tier"><input name="tier" defaultValue={c.tier} className={`${field} w-28`} /></Labelled>
          <Labelled label="Address">
            <input name="address" defaultValue={c.address ?? ''} placeholder="Street, city, postcode"
              className={`${field} w-full min-w-72`} />
          </Labelled>
          <button className={btn}>Save</button>
        </form>
      )}
      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
    </div>
  );
}

const Stat = ({ label, value, className = '' }: { label: string; value: string; className?: string }) => (
  <div>
    <dt className="text-xs text-slate-ink">{label}</dt>
    {/* Money reads as a system readout, so it takes the mono face — section 4.1. */}
    <dd className={`font-mono font-medium tabular-nums ${className}`}>{value}</dd>
  </div>
);
const Labelled = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="text-xs text-slate-ink">{label}{children}</label>
);

// ----------------------------------------------------------------- panels

const Empty = ({ children }: { children: React.ReactNode }) =>
  <p className="p-4 text-sm text-slate-ink">{children}</p>;

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    // The system's data table: vellum inside a pebble hairline, header row on bone.
    <div className={`${tableCard} overflow-x-auto`}>
      <table className="w-full text-sm">
        <thead className={thead}>
          <tr>{head.map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const Tr = ({ children }: { children: React.ReactNode }) =>
  <tr className="border-t border-pebble hover:bg-bone dark:border-white/10 dark:hover:bg-white/5">{children}</tr>;
const Td = ({ children, className = '' }: { children: React.ReactNode; className?: string }) =>
  <td className={`px-3 py-1.5 ${className}`}>{children}</td>;

function Overview({ id, client: c, totals, flags, admin, onChanged }: {
  id: string; client: Client; totals?: Holdings['totals']; flags: any; admin: boolean; onChanged: () => void;
}) {
  const tasks = useApi<Task[]>(`/tasks?client_id=${id}&scope=all`);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        {!!flags.data?.length && <FlagList rows={flags.data} review={false} onDone={flags.reload} />}
        {!!totals?.unpriced.length && (
          <p className={`${alertBox} text-xs`}>
            Holdings exclude {totals.unpriced.join(', ')} — no price source for those assets.
          </p>
        )}
        <div className={`${card} space-y-2`}>
          <h2 className="text-sm font-semibold">Open tasks</h2>
          {tasks.data?.map((t) => (
            <p key={t.id} className="text-sm">
              {t.title} <span className="text-xs text-slate-ink">· {t.assignee_name}</span>
            </p>
          ))}
          {tasks.data?.length === 0 && <p className="text-sm text-slate-ink">None.</p>}
        </div>
      </div>
      <div className="space-y-4">
        {admin && <CreditForm clientId={id} onDone={onChanged} />}
        {admin && <ClientPassword id={id} name={c.name} />}
      </div>
    </div>
  );
}

/** Locked-out clients ring support, so an admin can set a password for them here. */
function ClientPassword({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`${card} space-y-2`}>
      <h2 className="text-sm font-medium">Sign-in</h2>
      {open
        ? <ResetPassword path={`/clients/${id}/password`} who={name} onDone={() => setOpen(false)} />
        : <>
            <button className={btn} onClick={() => setOpen(true)}>Reset password</button>
            <p className="text-xs text-slate-ink">
              Sets a new password on the client's account. Written to their timeline, and
              they are notified.
            </p>
          </>}
    </div>
  );
}

function Assets({ id, h, admin, onChanged }: {
  id: string; h: Holdings | null; admin: boolean; onChanged: () => void;
}) {
  if (!h) return <Empty>Loading…</Empty>;
  return (
    <div className="space-y-4">
      <Table head={['Currency', 'Balance', 'Mode', 'Leverage']}>
        {h.accounts.map((a) => (
          <Tr key={a.id}>
            <Td className="font-medium">{a.currency}</Td>
            <Td className="tabular-nums">{num(a.balance)}</Td>
            <Td>{a.mode}</Td><Td>{a.leverage}×</Td>
          </Tr>
        ))}
      </Table>
      {!!h.wallets.length && (
        <Table head={['Wallet', 'Balance', 'Address']}>
          {h.wallets.map((w) => (
            <Tr key={w.id}>
              <Td className="font-medium">{w.asset}</Td>
              <Td className="tabular-nums">{num(w.balance)}</Td>
              <Td className="font-mono text-xs text-slate-ink">{w.address}</Td>
            </Tr>
          ))}
        </Table>
      )}
      {admin && <StakingPanel clientId={id} onChanged={onChanged} />}
      {admin
        ? <PortfoliosPanel clientId={id} onChanged={onChanged} />
        : !!h.portfolios.length && (
          <Table head={['Portfolio', 'Type', 'Balance', 'Target', 'Status']}>
            {h.portfolios.map((p) => (
              <Tr key={p.id}>
                <Td className="font-medium">{p.name}</Td>
                <Td className="text-slate-ink">{p.type_name}</Td>
                <Td className="tabular-nums">{num(p.balance)} {p.currency}</Td>
                <Td className="tabular-nums">{p.target_amount ? num(p.target_amount) : '—'}</Td>
                <Td>{p.status}</Td>
              </Tr>
            ))}
          </Table>
        )}
    </div>
  );
}

/**
 * What this client pays to trade, alongside what they have traded.
 *
 * Two dials and no others. Commission is charged on the size of every fill and spread moves
 * the executed price against them — both are costs, both apply the same way whichever
 * direction a trade goes, and no value of either can turn a loss into a gain. They are the
 * price of the service, so the client sees them on their own profile and on every fill.
 */
function TradingTerms({ id, c, onChanged }: { id: string; c: Person; onChanged: () => void }) {
  const [commission, setCommission] = useState(c.commission_bps === null ? '' : String(c.commission_bps));
  const [spread, setSpread] = useState(c.spread_bps === null ? '' : String(c.spread_bps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const bps = (v: string) => (v.trim() === '' ? null : Number(v));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api(`/clients/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ commission_bps: bps(commission), spread_bps: bps(spread) }),
      });
      setDone(true);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className={`${card} space-y-3`}>
      <div>
        <h3 className="metric-label">Trading terms</h3>
        <p className="mt-1 text-xs text-slate-ink">
          In basis points — 25 is 0.25%. Empty means the desk default. Applied to every fill
          from the moment you save, and shown to the client on their profile.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Labelled label="Commission (bps)">
          <input className={`${field} w-28`} type="number" step="0.01" min="0" max="500"
            placeholder="0" value={commission} onChange={(e) => setCommission(e.target.value)} />
        </Labelled>
        <Labelled label="Spread (bps)">
          <input className={`${field} w-28`} type="number" step="0.01" min="0" max="500"
            placeholder="0" value={spread} onChange={(e) => setSpread(e.target.value)} />
        </Labelled>
        <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Save terms'}</button>
      </div>
      <p className="text-xs text-slate-ink">
        Commission is charged on the notional of a fill and spread moves the fill price
        against the client. Both are costs on every trade, either direction — neither is
        able to turn a loss into a profit.
      </p>
      {error && <p role="alert" className={alertBox}>{error}</p>}
      {done && <p role="status" className="font-mono text-xs text-slate-ink">Saved.</p>}
    </form>
  );
}

function Trading({ id, c, h, admin, onChanged }: {
  id: string; c: Person; h: Holdings | null; admin: boolean; onChanged: () => void;
}) {
  if (!h) return <Empty>Loading…</Empty>;
  return (
    <div className="space-y-4">
      {admin && <TradingTerms id={id} c={c} onChanged={onChanged} />}
      <h3 className="metric-label">Open positions</h3>
      <Table head={['Symbol', 'Qty', 'Entry', 'Price', 'Open P&L']}>
        {h.positions.map((p) => (
          <Tr key={p.symbol}>
            <Td className="font-medium">{p.symbol}</Td>
            <Td className={`tabular-nums ${p.qty > 0 ? '' : 'text-slate-ink'}`}>{num(p.qty)}</Td>
            <Td className="tabular-nums">{p.avg_price}</Td>
            <Td className="tabular-nums">{p.price}</Td>
            <Td className={`tabular-nums ${pnlColour(p.unrealized)}`}>{num(p.unrealized)}</Td>
          </Tr>
        ))}
      </Table>
      {h.positions.length === 0 && <Empty>No open positions.</Empty>}

      <h3 className="text-xs font-medium text-slate-ink">Orders</h3>
      <Table head={['Placed', 'Symbol', 'Side', 'Type', 'Qty', 'Trigger', 'Status']}>
        {h.orders.map((o) => (
          <Tr key={o.id}>
            <Td className="text-slate-ink">{when(o.placed_at)}</Td>
            <Td className="font-medium">{o.symbol}</Td>
            <Td className={'font-mono text-xs uppercase text-slate-ink'}>{o.side}</Td>
            <Td>{o.type.replace('_', '-')}</Td>
            <Td className="tabular-nums">{num(o.qty)}</Td>
            <Td className="tabular-nums">{o.limit_price ?? o.stop_price ?? '—'}</Td>
            <Td>{o.status}</Td>
          </Tr>
        ))}
      </Table>
      {h.orders.length === 0 && <Empty>No orders yet.</Empty>}

      <h3 className="text-xs font-medium text-slate-ink">Trade history</h3>
      <Table head={['Filled', 'Symbol', 'Side', 'Qty', 'Price']}>
        {h.trades.map((t) => (
          <Tr key={t.id}>
            <Td className="text-slate-ink">{when(t.filled_at)}</Td>
            <Td className="font-medium">{t.symbol}</Td>
            <Td className={'font-mono text-xs uppercase text-slate-ink'}>{t.side}</Td>
            <Td className="tabular-nums">{num(t.qty)}</Td>
            <Td className="tabular-nums">{t.price}</Td>
          </Tr>
        ))}
      </Table>
      {h.trades.length === 0 && <Empty>No trades yet.</Empty>}
    </div>
  );
}

function Funding({ id, h, compliance, onChanged }: {
  id: string; h: Holdings | null; compliance: boolean; onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const decide = async (txId: number, status: 'approved' | 'rejected') => {
    setBusy(txId);
    try {
      await api(`/cash/${txId}/decide`, { method: 'POST', body: JSON.stringify({ status }) });
      onChanged();
    } finally { setBusy(null); }
  };
  if (!h) return <Empty>Loading…</Empty>;
  if (!h.cash.length) return <Empty>No deposits or withdrawals.</Empty>;

  return (
    <Table head={['Requested', 'Type', 'Amount', 'Status', '']}>
      {h.cash.map((t) => (
        <Tr key={t.id}>
          <Td className="text-slate-ink">{when(t.created_at)}</Td>
          <Td>{t.kind}</Td>
          <Td className="tabular-nums">{num(t.amount)}</Td>
          {/* Only "pending" is waiting on someone; rejected and settled are just facts. */}
          <Td className={t.status === 'pending' ? 'font-medium text-obsidian dark:text-vellum' : 'text-slate-ink'}>
            {t.status}
          </Td>
          <Td>
            {t.status === 'pending' && compliance && (
              <span className="flex gap-2 text-xs">
                <button disabled={busy === t.id} onClick={() => decide(t.id, 'approved')}
                  className="text-slate-ink hover:text-slate-ink">approve</button>
                <button disabled={busy === t.id} onClick={() => decide(t.id, 'rejected')}
                  className="text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">reject</button>
              </span>
            )}
          </Td>
        </Tr>
      ))}
    </Table>
  );
}

function Tickets({ rows }: { rows: Ticket[] }) {
  if (!rows.length) return <Empty>No tickets.</Empty>;
  return (
    <Table head={['Subject', 'Category', 'Priority', 'Status', 'Messages', 'Updated']}>
      {rows.map((t) => (
        <Tr key={t.id}>
          <Td className="font-medium"><a className="hover:underline" href="#/support">{t.subject}</a></Td>
          <Td className="text-slate-ink">{t.category}</Td>
          <Td>{t.priority}</Td><Td>{t.status}</Td>
          <Td className="tabular-nums">{t.messages}</Td>
          <Td className="text-slate-ink">{when(t.updated_at)}</Td>
        </Tr>
      ))}
    </Table>
  );
}

function ActivityTab({ id }: { id: string }) {
  const timeline = useApi<Activity[]>(`/clients/${id}/timeline?limit=200`);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');

  return (
    <div className={`${card} space-y-3`}>
      <form className="flex gap-2" onSubmit={async (e) => {
        e.preventDefault();
        await api(`/clients/${id}/notes`, { method: 'POST', body: JSON.stringify({ text: note }) });
        setNote(''); timeline.reload();
      }}>
        <input className={input} required maxLength={4000} placeholder="Internal note…"
          value={note} onChange={(e) => setNote(e.target.value)} />
        <button className={btn}>Add note</button>
      </form>
      <form className="flex gap-2" onSubmit={async (e) => {
        e.preventDefault();
        await api(`/clients/${id}/notify`, { method: 'POST', body: JSON.stringify({ title: msg }) });
        setMsg(''); timeline.reload();
      }}>
        <input className={input} required maxLength={120} placeholder="Message the client…"
          value={msg} onChange={(e) => setMsg(e.target.value)} />
        <button className={btn}>Send</button>
      </form>
      <ol className="space-y-2">
        {timeline.data?.map((a) => (
          <li key={a.id} className="border-l-2 border-pebble pl-3 dark:border-white/10">
            <p className="text-sm">{a.summary}</p>
            <p className="text-xs text-slate-ink">{a.kind} · {when(a.at)}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AuditTab({ id }: { id: string }) {
  const audit = useApi<Audit[]>(`/audit?row_id=${id}&limit=100`);
  if (audit.error) return <Empty>Audit needs the audit:read permission.</Empty>;
  if (!audit.data?.length) return <Empty>No changes recorded against this record.</Empty>;
  return (
    <Table head={['When', 'Actor', 'Action', 'Changed']}>
      {audit.data.map((a) => {
        const changed = a.before && a.after
          ? Object.keys(a.after).filter((k) => k !== 'updated_at' && JSON.stringify(a.before[k]) !== JSON.stringify(a.after[k]))
          : [];
        return (
          <Tr key={a.id}>
            <Td className="text-slate-ink">{when(a.at)}</Td>
            <Td className="font-mono text-xs">{String(a.actor).slice(0, 8)}</Td>
            <Td>{a.action}</Td>
            <Td className="text-slate-ink">
              {changed.length
                ? changed.map((k) => `${k}: ${JSON.stringify(a.before[k])} → ${JSON.stringify(a.after[k])}`).join(', ')
                : a.action.toLowerCase()}
            </Td>
          </Tr>
        );
      })}
    </Table>
  );
}
