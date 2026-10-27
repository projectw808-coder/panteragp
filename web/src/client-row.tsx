import { useState } from 'react';
import { mono } from './App.tsx';
import { api, type ClientRow as Client, type Stage } from './api.ts';
import { CopyButton } from './copy.tsx';

/**
 * A client in the list. Clicking it opens their full record, where everything about them
 * lives — money, documents, wallets, pots, password, notes. The row keeps only what is
 * quicker done from the list: copying the email, moving the stage, picking for bulk.
 */
export function ClientRow({ c, onChanged, badge, stages, selected, onSelect, assets }: {
  c: Client;
  onChanged: () => void;
  badge: (value: string) => React.ReactNode;
  stages: Stage[];
  /** Bulk selection, when the list offers it. */
  selected?: boolean; onSelect?: (on: boolean) => void;
  /** What they hold in dollars, when the list asked for it. */
  assets?: number | null;
}) {
  const open = () => { location.hash = `#/clients/${c.id}`; };
  return (
    <tr onClick={open} tabIndex={0} role="link" aria-label={`Open ${c.name}`}
      onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
      className={`x-crm-row cursor-pointer focus-ring ${selected ? 'is-picked' : ''}`}>
      {onSelect && (
        <td className="w-10 px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${c.name}`} />
        </td>
      )}
      <td className="px-4 py-2">
        <span className="flex items-center gap-2">
          <span className="x-avatar x-avatar-sm" aria-hidden>{c.name.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>
          <span className="font-medium">{c.name}</span>
          {c.account_number && (
            <span className="font-mono text-[11px] tracking-wide text-slate-ink" title="Account number">{c.account_number}</span>
          )}
          {/* A record without a password is a lead, not an account — and until this said
              so, it was indistinguishable from a working login in every column here. */}
          {!c.has_login && (
            <span title="No password set — this client cannot sign in yet" className="x-badge is-muted">No login</span>
          )}
        </span>
      </td>
      {/* The address is the thing staff actually need off this screen — to paste into a
          mail client, a ticket or a search — so it has its own copy button, which does not
          open the record. */}
      <td className={`px-4 py-2 text-xs text-slate-ink ${mono}`} onClick={(e) => e.stopPropagation()}>
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate">{c.email}</span>
          <CopyButton text={c.email} className="shrink-0" />
        </span>
      </td>
      {/* A select, not a label: moving somebody down the pipeline is the commonest edit on
          this screen. The click is stopped here so choosing a stage does not open the record. */}
      <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
        <StageCell c={c} stages={stages} onChanged={onChanged} />
      </td>
      <td className="px-4 py-2">{badge(c.kyc_status)}</td>
      <td className="px-4 py-2 text-slate-ink">{c.owner_name ?? <span className="text-ember-ink">Unassigned</span>}</td>
      {assets !== undefined && <td className={`px-4 py-2 text-right ${mono}`}>{assets === null ? '—' : '$' + Math.round(assets).toLocaleString('en-US')}</td>}
      <td className={`px-4 py-2 text-xs text-slate-ink ${mono}`}>{new Date(c.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
    </tr>
  );
}

/** The pipeline stage, changed in place. Saves on choosing — there is nothing to confirm. */
function StageCell({ c, stages, onChanged }: { c: Client; stages: Stage[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  return (
    <select value={c.stage_id} disabled={busy} aria-label={`Stage for ${c.name}`}
      onChange={async (e) => {
        setBusy(true);
        setError(false);
        try {
          await api(`/clients/${c.id}`, { method: 'PATCH', body: JSON.stringify({ stage_id: Number(e.target.value) }) });
          onChanged();
        } catch { setError(true); } finally { setBusy(false); }
      }}
      className={`-mx-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-pebble dark:hover:border-white/20 ${error ? 'text-down' : ''}`}>
      {stages.length
        ? stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)
        : <option value={c.stage_id}>{c.stage}</option>}
    </select>
  );
}
