import { useState } from 'react';
import {
  Activity as ActivityIcon, ArrowDownLeft, ArrowDownUp, ChartCandlestick, Clock, FileText, Flag, Headset, History, KeyRound, Landmark,
  LayoutGrid, ListTodo, Mail, Pencil, Plus, ShieldCheck, User, Wallet,
} from 'lucide-react';
import { alertBox, btn, card, field, input, tableCard, thead } from './App.tsx';
import type { Book } from './balance.tsx';
import { ClientEmail } from './client-email.tsx';
import { ClientAutoTrader } from './client-autotrader.tsx';
import { api, useApi, type Activity, type Client, type Stage, type Staff, type Task } from './api.ts';
import { DocumentsPanel, FlagList } from './compliance.tsx';
import { CreditForm, DepositForm, PnlForm } from './wallet.tsx';
import { CopyButton } from './copy.tsx';
import { PortfoliosPanel } from './portfolio.tsx';
import { StakingPanel } from './staking.tsx';
import { IposPanel } from './ipos.tsx';
import { ResetPassword } from './settings.tsx';

type Holdings = {
  accounts: { id: string; currency: string; balance: number; mode: string; leverage: number }[];
  wallets: { id: string; asset: string; address: string; balance: number }[];
  portfolios: { id: string; name: string; type_name: string; currency: string; balance: number; status: string; target_amount: number | null }[];
  positions: { symbol: string; qty: number; avg_price: number; price: number; unrealized: number }[];
  orders: { id: string; symbol: string; side: string; type: string; qty: number; limit_price: number | null; stop_price: number | null; status: string; placed_at: string }[];
  trades: { id: number; symbol: string; side: string; qty: number; price: number; filled_at: string }[];
  cash: { id: number; kind: string; amount: number; status: string; created_at: string }[];
  totals: { holdings_usd: number; unpriced: string[]; open_pnl: number; equity_usd: number; book?: Book };
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


const TAB_META: Record<Tab, { label: string; Icon: typeof User }> = {
  overview: { label: 'Overview', Icon: LayoutGrid }, assets: { label: 'Assets', Icon: Wallet },
  trading: { label: 'Trading', Icon: ChartCandlestick }, funding: { label: 'Funding', Icon: ArrowDownUp },
  documents: { label: 'Documents', Icon: FileText }, tickets: { label: 'Tickets', Icon: Headset },
  activity: { label: 'Activity', Icon: ActivityIcon }, audit: { label: 'Audit', Icon: History },
};

const KYC_BADGE: Record<string, string> = { approved: '', pending: 'is-locked', rejected: 'is-bad', expired: 'is-warn', none: 'is-muted' };
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

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
  // The roles the server grants crm:write, which is what uploading for a client needs.
  // Compliance reviews documents but does not file them, so it is deliberately not here.
  const canWrite = me?.role === 'sales' || me?.role === 'support' || admin;

  if (client.error) return <p role="alert" className={`${alertBox} `}>{client.error}</p>;
  if (!client.data) return <div className="mx-auto max-w-[1440px] space-y-4"><div className="skeleton h-48 rounded-xl" /><div className="skeleton h-10 rounded-lg" /></div>;
  const c = client.data;
  const t = holdings.data?.totals;
  const h = holdings.data;
  // What each tab holds, on the tab, so nobody has to open one to find it is empty.
  const count: Partial<Record<Tab, number>> = {
    trading: h?.positions.length, funding: h?.cash.filter((x) => x.status === 'pending').length,
    tickets: tickets.data?.filter((x) => x.status === 'open' || x.status === 'pending').length,
  };
  const go = (next: Tab) => { setTab(next); document.getElementById('record-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return (
    <div className="mx-auto max-w-[1440px] space-y-4">
      <Header client={c} holdings={h ?? undefined} onSaved={refresh}
        compliance={compliance} admin={admin} flags={flags.data?.length ?? 0} onGo={go} />

      <div id="record-tabs" className="x-rtabs" role="tablist" aria-label="Client record">
        {TABS.map((name) => {
          const { label, Icon } = TAB_META[name];
          const n = count[name];
          return (
            <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}
              className={tab === name ? 'is-on' : ''}>
              <Icon size={15} aria-hidden />{label}
              {!!n && <span className="x-rtab-n">{n}</span>}
              {name === 'overview' && !!flags.data?.length && <span className="x-rtab-n is-alert">{flags.data.length}</span>}
            </button>
          );
        })}
      </div>

      <div key={version}>
        {tab === 'overview' && (
          <Overview id={id} client={c} totals={t} flags={flags} admin={admin} onChanged={refresh} />
        )}
        {tab === 'assets' && <Assets id={id} h={holdings.data} admin={admin} onChanged={refresh} />}
        {tab === 'trading' && <Trading id={id} c={c} h={holdings.data} admin={admin} onChanged={refresh} />}
        {tab === 'funding' && <Funding id={id} h={holdings.data} compliance={compliance} onChanged={refresh} />}
        {tab === 'documents' && <DocumentsPanel clientId={id} canUpload={canWrite} onBehalf />}
        {tab === 'tickets' && <Tickets rows={tickets.data ?? []} />}
        {tab === 'activity' && <ActivityTab id={id} />}
        {tab === 'audit' && <AuditTab id={id} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ header

/**
 * Where the client's money sits, from the same book their own screens read: cash, crypto,
 * savings, staked and IPOs, then open P&L, adding up to the equity at the top. A part
 * they hold nothing in is left out; a currency with no price source is named.
 */
function Breakdown({ totals }: { totals?: Holdings['totals'] }) {
  if (!totals?.book) return null;
  const b = totals.book;
  const parts = ([
    ['Cash', b.cash_usd], ['Crypto', b.crypto_usd], ['Savings', b.savings_usd], ['Staked', b.staked_usd], ['IPOs', b.ipos_usd],
  ] as const).filter(([, v]) => v !== 0);
  return (
    <div className="x-book">
      {parts.length === 0 && <span className="text-sm text-slate-ink">No balances yet.</span>}
      {parts.map(([label, v]) => (
        <span key={label} className="x-book-part">
          <span className="text-[11.5px] text-mist">{label}</span>
          <span className="text-[14px] font-semibold tabular-nums">{usd(v)}</span>
        </span>
      ))}
      {b.open_pnl !== 0 && (
        <span className="x-book-part">
          <span className="text-[11.5px] text-mist">Open P&amp;L</span>
          <span className={`text-[14px] font-semibold tabular-nums ${pnlColour(b.open_pnl)}`}>{b.open_pnl > 0 ? '+' : ''}{usd(b.open_pnl)}</span>
        </span>
      )}
      {!!totals.unpriced.length && <span className="text-xs text-slate-ink">Excludes {totals.unpriced.join(', ')} — no price source.</span>}
    </div>
  );
}

function Header({ client: c, holdings, onSaved, compliance, admin, flags, onGo }: {
  client: Person;
  holdings?: Holdings; onSaved: () => void; compliance: boolean; admin: boolean; flags: number; onGo: (t: Tab) => void;
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
  const stage = stages.data?.find((s) => s.id === c.stage_id)?.name;

  return (
    <div className="space-y-4">
      <div className="x-card x-holo p-5">
        <div className="flex flex-wrap items-start gap-5">
          <span className="x-avatar !size-16 !text-[22px] shrink-0" aria-hidden>{initials(c.name)}</span>
          <div className="min-w-0 flex-1 sm:min-w-72">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[26px] leading-tight font-bold tracking-[-0.02em]">{c.name}</h1>
              <span className={`x-badge ${KYC_BADGE[c.kyc_status] ?? 'is-muted'}`}><ShieldCheck size={12} className="mr-1" aria-hidden />KYC {c.kyc_status}</span>
              <span className="x-badge is-locked capitalize">{c.tier}</span>
              {stage && <span className="x-badge is-muted">{stage}</span>}
              {flags > 0 && <span className="x-badge is-bad"><Flag size={12} className="mr-1" aria-hidden />{flags} open flag{flags === 1 ? '' : 's'}</span>}
            </div>
            {/* The details the desk reads aloud and searches by, each one click to copy. */}
            <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-2">
              {c.account_number && (
                <div className="flex items-center gap-2"><dt className="w-16 shrink-0 text-mist">Account</dt><dd className="font-mono">{c.account_number}</dd><CopyButton text={c.account_number} /></div>
              )}
              <div className="flex min-w-0 items-center gap-2"><dt className="w-16 shrink-0 text-mist">Email</dt><dd className="truncate text-ember-ink">{c.email}</dd><CopyButton text={c.email} /></div>
              <div className="flex items-center gap-2"><dt className="w-16 shrink-0 text-mist">Phone</dt><dd>{c.phone ?? '—'}</dd>{c.phone && <CopyButton text={c.phone} />}</div>
              <div className="flex items-center gap-2"><dt className="w-16 shrink-0 text-mist">Country</dt><dd>{c.country ?? '—'}</dd></div>
              <div className="flex items-center gap-2"><dt className="w-16 shrink-0 text-mist">Born</dt><dd>{c.date_of_birth ? new Date(c.date_of_birth).toLocaleDateString() : '—'}</dd></div>
              <div className="flex items-center gap-2"><dt className="w-16 shrink-0 text-mist">Since</dt><dd>{new Date(c.created_at).toLocaleDateString()}</dd></div>
              {c.address && <div className="flex min-w-0 items-center gap-2 sm:col-span-2"><dt className="w-16 shrink-0 text-mist">Address</dt><dd className="truncate">{c.address}</dd></div>}
            </dl>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={`mailto:${c.email}`} className="x-btn-sm inline-flex items-center gap-1.5"><Mail size={14} aria-hidden />Email</a>
            <button type="button" className="x-btn-sm inline-flex items-center gap-1.5" onClick={() => onGo('trading')}><ChartCandlestick size={14} aria-hidden />Trading</button>
            <button type="button" className="x-btn-sm inline-flex items-center gap-1.5" onClick={() => onGo('documents')}><FileText size={14} aria-hidden />Documents</button>
            <button type="button" className={`x-btn-sm inline-flex items-center gap-1.5 ${editing ? 'is-on' : ''}`} onClick={() => setEditing((v) => !v)}>
              <Pencil size={14} aria-hidden />{editing ? 'Close' : 'Edit details'}
            </button>
          </div>
        </div>

        {/* The money, the same figures the client sees on their own overview. */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Figure label="Equity" Icon={Landmark} value={totals ? usd(totals.equity_usd) : null} note="Holdings plus open P&L" lead />
          <Figure label="Holdings" Icon={Wallet} value={totals ? usd(totals.holdings_usd) : null} note="Cash, crypto, savings, staked, IPOs" />
          <Figure label="Open P&L" Icon={ChartCandlestick} value={totals ? `${totals.open_pnl > 0 ? '+' : ''}${usd(totals.open_pnl)}` : null}
            tone={totals ? pnlColour(totals.open_pnl) : ''} note={holdings ? `${holdings.positions.length} open position${holdings.positions.length === 1 ? '' : 's'}` : ''} />
          <Figure label="Pending" Icon={Clock} value={holdings ? String(holdings.cash.filter((x) => x.status === 'pending').length) : null}
            note="Deposits and withdrawals waiting on a decision" />
        </div>
        <div className="mt-3"><Breakdown totals={totals} /></div>
      </div>

      {/* Who looks after them and where they stand: always one change away. */}
      <div className="x-card x-manage">
        <Labelled label="Stage">
          <select className={field} value={c.stage_id}
            onChange={(e) => patch({ stage_id: Number(e.target.value) })}>
            {stages.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Labelled>
        <Labelled label="Owner">
          <select className={field} value={c.owner_staff_id ?? ''}
            onChange={(e) => patch({ owner_staff_id: e.target.value || null })}>
            <option value="">Unassigned</option>
            {staff.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Labelled>
        <Labelled label="Risk">
          <select className={field} value={c.risk_profile ?? ''}
            onChange={(e) => patch({ risk_profile: e.target.value || null })}>
            <option value="">not set</option>
            {['low', 'medium', 'high'].map((r) => <option key={r}>{r}</option>)}
          </select>
        </Labelled>
        {admin && (
          <Labelled label="Tier">
            {/* A select rather than free text: a tier is one of a known set, and "Gold " with
                a trailing space is a tier nothing matches. The client's existing value is kept
                as an option so an older record set by hand is not silently rewritten. */}
            <select className={field} value={c.tier}
              onChange={(e) => patch({ tier: e.target.value })}>
              {[...new Set([...TIERS, c.tier])].map((t) => <option key={t}>{t}</option>)}
            </select>
          </Labelled>
        )}
        {compliance && (
          <Labelled label="KYC (override)">
            <select className={field} value={c.kyc_status}
              onChange={(e) => patch({ kyc_status: e.target.value })}>
              {['none', 'pending', 'approved', 'rejected', 'expired'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Labelled>
        )}
      </div>

      {editing && (
        <form className="x-card x-holo space-y-4 p-5"
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
          <h2 className="section-title">Personal details</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Labelled label="Name"><input name="name" defaultValue={c.name} className={`${field} w-full`} /></Labelled>
            <Labelled label="Email"><input name="email" type="email" defaultValue={c.email} className={`${field} w-full`} /></Labelled>
            <Labelled label="Phone"><input name="phone" defaultValue={c.phone ?? ''} className={`${field} w-full`} /></Labelled>
            <Labelled label="Date of birth">
              <input name="date_of_birth" type="date" defaultValue={c.date_of_birth?.slice(0, 10) ?? ''} className={`${field} w-full`} />
            </Labelled>
            <Labelled label="Country"><input name="country" maxLength={2} placeholder="GB" defaultValue={c.country ?? ''} className={`${field} w-full`} /></Labelled>
            <Labelled label="Tier"><input name="tier" defaultValue={c.tier} className={`${field} w-full`} /></Labelled>
            <div className="sm:col-span-2 xl:col-span-3">
              <Labelled label="Address">
                <input name="address" defaultValue={c.address ?? ''} placeholder="Street, city, postcode" className={`${field} w-full`} />
              </Labelled>
            </div>
          </div>
          <div className="flex gap-2">
            <button className={btn}>Save details</button>
            <button type="button" className="x-btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p role="alert" className={`${alertBox} `}>{error}</p>}
    </div>
  );
}

function Figure({ label, Icon, value, note, tone = '', lead }: {
  label: string; Icon: typeof User; value: string | null; note?: string; tone?: string; lead?: boolean;
}) {
  return (
    <div className={`x-figure ${lead ? 'is-lead' : ''}`}>
      <div className="flex items-center gap-2.5">
        <span className="x-chip !size-8"><Icon size={16} strokeWidth={1.9} aria-hidden /></span>
        <span className="text-[13px] text-mist">{label}</span>
      </div>
      {value === null
        ? <span className="skeleton mt-3 block h-6 w-32" />
        : <p className={`mt-3 truncate text-[22px] leading-none font-bold tabular-nums ${tone}`}>{value}</p>}
      {note && <p className="mt-2 text-xs text-slate-ink">{note}</p>}
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
  <label className="flex flex-col gap-1 text-xs text-mist">{label}{children}</label>
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

const ACTIONS = [
  ['deposit', 'Record deposit', ArrowDownLeft], ['credit', 'Credit / debit', Plus],
  ['pnl', 'Adjust P&L', ChartCandlestick], ['password', 'Password', KeyRound],
] as const;

function Overview({ id, client: c, totals, flags, admin, onChanged }: {
  id: string; client: Client; totals?: Holdings['totals']; flags: any; admin: boolean; onChanged: () => void;
}) {
  const tasks = useApi<Task[]>(`/tasks?client_id=${id}&scope=all`);
  const [action, setAction] = useState<(typeof ACTIONS)[number][0]>('deposit');
  const open = tasks.data?.filter((t) => t.status !== 'done' && t.status !== 'cancelled') ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        {!!flags.data?.length && <FlagList rows={flags.data} review={false} onDone={flags.reload} />}
        {!!totals?.unpriced.length && (
          <p className={`${alertBox} text-xs`}>
            Holdings exclude {totals.unpriced.join(', ')} — no price source for those assets.
          </p>
        )}
        <ClientAutoTrader clientId={id} admin={admin} />
        <ClientEmail clientId={id} clientName={c.name} clientEmail={c.email}
          optedOut={c.email_opt_out} />
      </div>
      <div className="space-y-4">
        {/* One place for everything that moves this client's money, picked rather than
            stacked: four forms down the side made the one you wanted a scroll away. */}
        {admin && (
          <div className="x-card x-holo space-y-4 p-5">
            <div>
              <h2 className="section-title">Money actions</h2>
              <p className="mt-1 text-xs text-slate-ink">Audited, written to the client's timeline, and the client is notified.</p>
            </div>
            <div className="grid grid-cols-2 gap-2" role="tablist">
              {ACTIONS.map(([k, label, Icon]) => (
                <button key={k} type="button" role="tab" aria-selected={action === k} onClick={() => setAction(k)}
                  className={`x-action ${action === k ? 'is-on' : ''}`}>
                  <Icon size={15} aria-hidden />{label}
                </button>
              ))}
            </div>
            <div className="x-actions">
              {action === 'deposit' && <DepositForm clientId={id} onDone={onChanged} />}
              {action === 'credit' && <CreditForm clientId={id} onDone={onChanged} />}
              {action === 'pnl' && <PnlForm clientId={id} onDone={onChanged} />}
              {action === 'password' && <ClientPassword id={id} name={c.name} />}
            </div>
          </div>
        )}
        <div className="x-card space-y-3 p-5">
          <div className="flex items-baseline gap-3">
            <h2 className="section-title">Open tasks</h2>
            <span className="text-xs text-slate-ink">{open.length || 'none'}</span>
            <a href="#/tasks" className="ml-auto text-xs text-ember-ink hover:underline">All tasks</a>
          </div>
          {tasks.data && !open.length && <p className="text-sm text-slate-ink">Nothing open for this client.</p>}
          <ul className="space-y-2">
            {open.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2.5">
                <span className="x-chip !size-7" aria-hidden><ListTodo size={14} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{t.title}</span>
                  <span className="block text-xs text-slate-ink">{t.assignee_name}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Locked-out clients ring support, so an admin can set a password for them here. */
function ClientPassword({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
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
      {admin && <IposPanel clientId={id} onChanged={onChanged} />}
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
        <h3 className="section-title">Trading terms</h3>
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
      <h3 className="section-title">Open positions</h3>
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
