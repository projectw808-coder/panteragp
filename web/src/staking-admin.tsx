import { useState } from 'react';
import { alertBox, btn, card, field, PageTitle, tableCard, thead } from './App.tsx';
import { api, useApi } from './api.ts';

/**
 * The staking desk: the catalogue, and everything staked against it.
 *
 * A product's rate is shared — every stake on it that has not had its own rate agreed is
 * paid the product's — so each row says how many stakes are riding on that number before
 * anybody edits it. Moving a product rate is not the same act as agreeing a rate with one
 * client, and the screen should not make them look alike.
 */

type Product = {
  code: string; name: string; asset: string; description: string;
  apy: number; lock_days: number; min_amount: number; active: boolean; sort_order: number;
  active_stakes: number; on_product_rate: number; staked: number;
};
type Stake = {
  id: string; client_id: string; client_name: string; product_name: string; product_code: string;
  asset: string; amount: number; rewards: number; apy: number; apy_override: number | null;
  status: string; staked_at: string; unlocks_at: string | null;
};

const pct = (n: number) => `${Number((Number(n) * 100).toFixed(2))}%`;
const num = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });
const day = (d: string) => new Date(d).toLocaleDateString();
const term = (days: number) => (days === 0 ? 'Flexible' : `${days} days`);

export function StakingAdmin() {
  const products = useApi<Product[]>('/admin/staking-products');
  const stakes = useApi<Stake[]>('/admin/stakes');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const rows = products.data ?? [];
  const open = stakes.data ?? [];
  const reload = () => { products.reload(); stakes.reload(); };

  // Grouped by asset because that is the unit staking is denominated in; a total across
  // assets would be adding BTC to USDC and calling it a number.
  const byAsset = new Map<string, number>();
  for (const s of open) byAsset.set(s.asset, (byAsset.get(s.asset) ?? 0) + Number(s.amount) + Number(s.rewards));

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Staking</PageTitle>
        <button className={`${btn} ml-auto`} onClick={() => { setAdding((v) => !v); setEditing(null); }}>
          {adding ? 'Cancel' : 'New product'}
        </button>
      </div>

      <div className={`${card} flex flex-wrap items-center gap-x-8 gap-y-3`}>
        <div>
          <p className="metric-label">Open stakes</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">{open.length}</p>
        </div>
        <div>
          <p className="metric-label">Products</p>
          <p className="font-mono text-2xl leading-tight font-medium tabular-nums">
            {rows.filter((p) => p.active).length}
            <span className="text-sm text-slate-ink"> / {rows.length}</span>
          </p>
        </div>
        {[...byAsset].sort((a, b) => a[0].localeCompare(b[0])).map(([asset, total]) => (
          <div key={asset}>
            <p className="metric-label">{asset} staked</p>
            <p className="font-mono text-lg leading-tight font-medium tabular-nums text-ember-ink">{num(total)}</p>
          </div>
        ))}
      </div>

      {adding && <ProductForm onDone={() => { setAdding(false); reload(); }} />}

      <div className="space-y-2">
        <h2 className="metric-label">Products</h2>
        {rows.map((p) => (
          <div key={p.code}
            className={`rounded-lg border p-4 ${p.active
              ? 'border-pebble bg-bone/50 dark:border-white/10 dark:bg-white/5'
              : 'border-pebble/60 opacity-60 dark:border-white/5'}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-ember/15 font-mono text-xs font-medium text-ember-ink">
                {p.asset}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {p.name}
                  {!p.active && <span className="ml-2 text-xs text-slate-ink">retired</span>}
                </span>
                <span className={`block font-mono text-[11px] text-slate-ink`}>
                  {p.code} · {term(p.lock_days)} · min {num(p.min_amount)} {p.asset}
                </span>
              </span>

              <span className="ml-auto flex items-center gap-6">
                <span className="text-right">
                  <span className="metric-label block">Rate</span>
                  <span className="block font-mono text-lg leading-tight font-medium tabular-nums text-ember-ink">
                    {pct(p.apy)}
                  </span>
                </span>
                <span className="text-right">
                  <span className="metric-label block">Staked</span>
                  <span className="block font-mono text-lg leading-tight font-medium tabular-nums">
                    {num(p.staked)} {p.asset}
                  </span>
                </span>
              </span>
            </div>

            <p className="mt-2 text-xs text-slate-ink">{p.description}</p>
            <p className="mt-1 text-xs text-slate-ink">
              {Number(p.active_stakes) === 0
                ? 'Nothing staked on it.'
                : `${p.active_stakes} open stake${Number(p.active_stakes) === 1 ? '' : 's'}, of which ` +
                  `${p.on_product_rate} take this rate — changing it changes what they earn.`}
            </p>

            <div className="mt-3">
              <button onClick={() => { setEditing(editing === p.code ? null : p.code); setAdding(false); }}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${editing === p.code
                  ? 'border border-ember text-ember-ink hover:bg-ember/10'
                  : 'bg-ember text-graphite hover:brightness-110'}`}>
                {editing === p.code ? 'Close' : 'Edit product'}
              </button>
            </div>

            {editing === p.code && (
              <ProductForm product={p} onDone={() => { setEditing(null); reload(); }} />
            )}
          </div>
        ))}
        {!rows.length && <p className="text-sm text-slate-ink">No products yet.</p>}
      </div>

      <div className="space-y-2">
        <h2 className="metric-label">Open stakes</h2>
        <div className={tableCard}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>{['Client', 'Product', 'Amount', 'Earned', 'Rate', 'Staked', 'Unlocks'].map((h) =>
                <th key={h} className="px-4 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {open.map((s) => (
                <tr key={s.id} className="border-t border-pebble dark:border-white/10">
                  <td className="px-4 py-2">
                    <a className="font-medium text-ember-ink hover:underline" href={`#/clients/${s.client_id}`}>
                      {s.client_name}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-slate-ink">{s.product_name}</td>
                  <td className="px-4 py-2 font-mono tabular-nums">{num(s.amount)} {s.asset}</td>
                  <td className="px-4 py-2 font-mono tabular-nums text-up">{num(s.rewards)}</td>
                  <td className="px-4 py-2 font-mono tabular-nums">
                    {pct(s.apy)}
                    {s.apy_override !== null && <span className="ml-1 text-[10px] text-slate-ink uppercase">agreed</span>}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-ink">{day(s.staked_at)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-ink">
                    {s.unlocks_at ? day(s.unlocks_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!open.length && <p className="px-4 py-6 text-sm text-slate-ink">Nothing staked yet.</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * One form for both adding and editing. The code is the primary key, so it is settable
 * once and shown as read-only after — a product whose code moved would orphan every stake
 * pointing at it.
 */
function ProductForm({ product, onDone }: { product?: Product; onDone: () => void }) {
  const currencies = useApi<{ code: string; name: string; kind: 'fiat' | 'crypto' }[]>('/currencies');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = !!product;

  // Held in state rather than as a defaultValue on the select. The options arrive from a
  // fetch, so on the first render there are none to match against and the browser settles
  // on whichever option turns up first — an ETH product was being drawn as ADA. A disabled
  // select is also left out of FormData entirely, so the value has to come from here
  // either way, or saving a locked product would send no asset at all.
  const [asset, setAsset] = useState(product?.asset ?? 'ETH');
  const assetLocked = editing && Number(product.active_stakes) > 0;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: String(f.get('name')),
        asset,
        description: String(f.get('description')),
        apy: Number(f.get('apy')) / 100,
        lock_days: Number(f.get('lock_days') || 0),
        min_amount: Number(f.get('min_amount') || 0),
        sort_order: Number(f.get('sort_order') || 0),
        active: f.get('active') === 'on',
      };
      if (editing) {
        await api(`/admin/staking-products/${product.code}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api('/admin/staking-products', {
          method: 'POST', body: JSON.stringify({ code: String(f.get('code')), ...body }),
        });
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  const crypto = currencies.data?.filter((c) => c.kind === 'crypto') ?? [];

  return (
    <form onSubmit={submit} className={`${card} mt-3 space-y-3`}>
      <h3 className="metric-label">{editing ? `Edit ${product.code}` : 'New product'}</h3>

      <div className="grid gap-3 sm:grid-cols-2">
        {!editing && (
          <Field label="Code" note="Lowercase, letters, numbers and underscores. Cannot change later.">
            <input name="code" required pattern="[a-z0-9_]{2,30}" placeholder="eth_180" className={field} />
          </Field>
        )}
        <Field label="Name">
          <input name="name" required maxLength={80} defaultValue={product?.name}
            placeholder="Ethereum 180-day" className={field} />
        </Field>
        <Field label="Asset" note={assetLocked
          ? 'Locked: this product has open stakes denominated in it.' : undefined}>
          <select value={asset} onChange={(e) => setAsset(e.target.value)} className={field}
            disabled={assetLocked} aria-label="Asset">
            {/* The product's own asset is always an option, even before the list loads and
                even if it were ever retired from the currency table. */}
            {!crypto.some((c) => c.code === asset) && <option value={asset}>{asset}</option>}
            {crypto.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </select>
        </Field>
        <Field label="Rate (% a year)">
          <input name="apy" type="number" step="0.01" min="0" max="100" required
            defaultValue={product ? Number((Number(product.apy) * 100).toFixed(4)) : ''}
            placeholder="5.75" className={field} />
        </Field>
        <Field label="Lock (days)" note="0 is flexible — unstake whenever.">
          <input name="lock_days" type="number" step="1" min="0" max="3650"
            defaultValue={product?.lock_days ?? 0} className={field} />
        </Field>
        <Field label="Minimum">
          <input name="min_amount" type="number" step="any" min="0"
            defaultValue={product?.min_amount ?? 0} className={field} />
        </Field>
        <Field label="Order">
          <input name="sort_order" type="number" step="1" min="0" max="1000"
            defaultValue={product?.sort_order ?? 0} className={field} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description" note="Shown to clients on the product card.">
            <input name="description" required maxLength={400} defaultValue={product?.description}
              placeholder="Locked for 180 days for a higher rate." className={field} />
          </Field>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={product?.active ?? true} />
        <span>Offered to clients</span>
        <span className="text-xs text-slate-ink">
          — unchecking retires it. Stakes already open on it carry on and keep paying.
        </span>
      </label>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      <button className={btn} disabled={busy}>
        {busy ? 'Saving…' : editing ? 'Save product' : 'Create product'}
      </button>
    </form>
  );
}

const Field = ({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="metric-label">{label}</span>
    <span className="mt-1 block">{children}</span>
    {note && <span className="mt-1 block text-xs text-slate-ink">{note}</span>}
  </label>
);
