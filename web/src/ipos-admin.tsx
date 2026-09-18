import { useEffect, useState, type FormEvent } from 'react';
import { alertBox, btn, card, field, PageTitle, tableCard, thead } from './App.tsx';
import { api, token, useApi } from './api.ts';
import { IpoMark, markTint } from './ipo-art.tsx';
import { useAuthedImage } from './authed-image.ts';

/**
 * The desk side of IPO offerings: the whole shelf including drafts, the edit form, and the
 * book on each offering.
 *
 * Reading needs crm:read, which is why the list renders for any staff role. Everything that
 * writes is admin-only on the server, so the controls are hidden from anyone else rather
 * than offered and then refused — a button that 403s is worse than no button.
 */

type Ipo = {
  id: string; slug: string; name: string; summary: string; description: string | null;
  asset: string; currency: string; target_amount: number; min_subscription: number;
  valuation: string | null;
  max_subscription: number | null; roi_rate: number; term_days: number;
  opens_at: string | null; closes_at: string | null; matures_at: string | null;
  status: string; stored_status: string; group: string; sort_order: number;
  raised: number; remaining: number; progress: number | null; subscribers: number;
  raised_baseline: number;
  // image_key changes on every upload, which is what makes a preview refetch rather than
  // go on showing the picture that was just replaced.
  has_image: boolean; image_key: string | null;
};

type Sub = {
  id: string; client_id: string; client_name: string; client_email: string; tier: string;
  amount: number; accrued: number; currency: string; status: string; created_at: string;
  roi_override: number | null; effective_rate: number; offering_rate: number;
};

/** Both decimals, so a rate reads the same here as it does on the client page. */
const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(2)}%`);
const num = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });
// The year is not optional here. A 365-day term puts the close and the maturity on the
// same day and month twelve months apart, which read as identical without it.
const day = (iso: string | null) => (iso
  ? new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' })
  : '—');
/** A datetime-local value, which wants local time without a zone suffix. */
const forInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function IposAdmin({ admin }: { admin: boolean }) {
  const rows = useApi<Ipo[]>('/admin/ipos');
  const [editing, setEditing] = useState<Ipo | null>(null);
  const [creating, setCreating] = useState(false);
  const [openBook, setOpenBook] = useState<string | null>(null);
  const list = rows.data ?? [];

  const refresh = () => rows.reload();

  return (
    <div className="stagger mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>IPO offerings</PageTitle>
        {admin && (
          <button className={btn} onClick={() => { setCreating(true); setEditing(null); }}>
            New offering
          </button>
        )}
      </div>

      {rows.error && <p role="alert" className={alertBox}>{rows.error}</p>}

      {creating && admin && (
        <IpoForm onDone={() => { setCreating(false); refresh(); }} onCancel={() => setCreating(false)} />
      )}

      {!rows.data ? <p className="text-sm text-slate-ink">Loading…</p> : (
        <div className={`${tableCard} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                {['Offering', 'Status', 'Raised', 'Subs', 'ROI', 'Opens', 'Closes', 'Matures', ''].map((h) => (
                  <th key={h} className="px-4 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id} className="border-t border-pebble dark:border-white/10">
                  <td className="px-4 py-2">
                    <span className="block font-medium">{i.name}</span>
                    <span className="block font-mono text-[11px] text-slate-ink">
                      {i.asset} · {i.currency} · {i.slug}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${
                      i.group === 'hidden'
                        ? 'bg-bone text-slate-ink dark:bg-white/10 dark:text-mist'
                        : 'bg-ember/15 text-ember-ink'}`}>
                      {i.status}
                    </span>
                    {/* When the stored status and the computed one differ, the dates are
                        doing the work — worth showing on the screen that sets them. */}
                    {i.stored_status !== i.status && (
                      <span className="mt-0.5 block font-mono text-[10px] text-slate-ink">
                        stored: {i.stored_status}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2" style={{ minWidth: 140 }}>
                    <span className="font-mono text-xs tabular-nums">
                      {num(i.raised)} / {num(i.target_amount)}
                    </span>
                    <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-slate-ink/20" aria-hidden>
                      <span className="bar-x block h-[3px] rounded-full bg-ember"
                        style={{ width: `${Math.round((i.progress ?? 0) * 100)}%` }} />
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono tabular-nums">{i.subscribers}</td>
                  <td className="px-4 py-2 font-mono tabular-nums">{pct(i.roi_rate)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-ink">{day(i.opens_at)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-ink">{day(i.closes_at)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-ink">{day(i.matures_at)}</td>
                  <td className="px-4 py-2">
                    <span className="flex gap-2">
                      {admin && (
                        <button className="rounded-full border border-pebble px-2.5 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
                          onClick={() => { setEditing(i); setCreating(false); }}>
                          Edit
                        </button>
                      )}
                      <button className="rounded-full border border-pebble px-2.5 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
                        onClick={() => setOpenBook(openBook === i.id ? null : i.id)}>
                        Book
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && (
            <p className="px-4 py-8 text-center text-sm text-slate-ink">No offerings yet.</p>
          )}
        </div>
      )}

      {editing && admin && (
        <IpoForm ipo={editing} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />
      )}

      {openBook && <Book ipoId={openBook} canOverride={admin} />}
    </div>
  );
}

/**
 * Create or edit. Rate and dates sit behind admin on the server, because changing the ROI
 * on a live offering changes what every subscriber is paid.
 */
function IpoForm({ ipo, onDone, onCancel }: { ipo?: Ipo; onDone: () => void; onCancel: () => void }) {
  const currencies = useApi<{ code: string; name: string; kind: string }[]>('/currencies');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fiat = (currencies.data ?? []).filter((c) => c.kind === 'fiat');
  /**
   * Controlled rather than defaultValue, because the options arrive after the mount.
   *
   * The list is fetched, so the first render has none of it. An uncontrolled select mounted
   * empty has nothing for defaultValue to match, and when the options do arrive the browser
   * leaves it on the first one — which is AED. Opening a USD offering and saving it without
   * touching the currency would have changed what its subscribers pay in.
   */
  const [currency, setCurrency] = useState(ipo?.currency ?? 'USD');
  const [chosen, setChosen] = useState<File | null>(null);
  const [removing, setRemoving] = useState(false);

  // The picture as stored, fetched with the token — an <img src> pointed at the API carries
  // no Authorization header and comes back 401.
  const stored = useAuthedImage(
    ipo?.has_image ? `/api/ipos/${ipo.id}/image?v=${ipo.image_key}` : null, ipo?.image_key);

  // A file picked but not yet saved previews from the browser, so the desk sees the crop it
  // is about to commit rather than the one it is replacing.
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!chosen) { setLocal(null); return; }
    const url = URL.createObjectURL(chosen);
    setLocal(url);
    return () => URL.revokeObjectURL(url);
  }, [chosen]);

  const shot = local ?? stored.src;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num_ = (k: string) => (f.get(k) === '' || f.get(k) === null ? undefined : Number(f.get(k)));
    const str = (k: string) => (String(f.get(k) ?? '').trim() || undefined);
    const date = (k: string) => (f.get(k) ? new Date(String(f.get(k))).toISOString() : null);

    const body: Record<string, unknown> = {
      slug: str('slug'), name: str('name'), summary: str('summary'),
      description: str('description') ?? null,
      asset: str('asset'), currency: str('currency'), valuation: str('valuation') ?? null,
      target_amount: num_('target_amount'), min_subscription: num_('min_subscription') ?? 0,
      raised_baseline: num_('raised_baseline') ?? 0,
      max_subscription: num_('max_subscription') ?? null,
      roi_rate: num_('roi_rate'), term_days: num_('term_days'),
      opens_at: date('opens_at'), closes_at: date('closes_at'), matures_at: date('matures_at'),
      sort_order: num_('sort_order') ?? 0,
    };

    setBusy(true);
    setError(null);
    try {
      const saved = ipo
        ? await api<Ipo>(`/admin/ipos/${ipo.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api<Ipo>('/admin/ipos', { method: 'POST', body: JSON.stringify(body) });

      // The picture is multipart, so it goes on its own request after the row exists.
      const file = (f.get('image') as File | null);
      if (file && file.size) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/admin/ipos/${saved.id}/image`, {
          method: 'POST', headers: { authorization: `Bearer ${token.get()}` }, body: form,
        });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => null))?.error ?? 'the picture was refused');
        }
      }
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const affected = ipo?.subscribers ?? 0;

  return (
    <form onSubmit={submit} className={`${card} tile grain relative space-y-3`}>
      <span className="tile-corner" aria-hidden />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="section-title">{ipo ? `Edit — ${ipo.name}` : 'New offering'}</span>
        {ipo && (
          <span className="rounded-full bg-ember/15 px-2 py-0.5 font-mono text-[10px] tracking-wide text-ember-ink uppercase">
            {ipo.status}
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Name" wide>
          <input name="name" required maxLength={200} defaultValue={ipo?.name} className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Slug" >
          <input name="slug" required maxLength={80} pattern="[a-z0-9-]+" defaultValue={ipo?.slug}
            className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Sort order">
          <input name="sort_order" type="number" defaultValue={ipo?.sort_order ?? 0} className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Summary" wide>
          <input name="summary" required maxLength={500} defaultValue={ipo?.summary} className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Description" wide>
          <textarea name="description" rows={3} maxLength={5000} defaultValue={ipo?.description ?? ''}
            className={`${field} w-full`} />
        </Labelled>

        <Labelled label="Asset">
          <input name="asset" required maxLength={20} defaultValue={ipo?.asset} className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Currency">
          <select name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}
            className={`${field} w-full`}>
            {/* The offering's own currency stays selectable while the list is loading, so
                the field never shows something the offering is not. */}
            {!fiat.some((c) => c.code === currency) && <option value={currency}>{currency}</option>}
            {fiat.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </select>
        </Labelled>
        {/* Free text and shown to clients as typed. A valuation is reported as a range or an
            approximation as often as a number, and forcing it into one would mean choosing a
            figure the reporting did not. */}
        <Labelled label="Valuation">
          <input name="valuation" maxLength={60} defaultValue={ipo?.valuation ?? ''}
            placeholder="$2tn, $165-175bn, none" className={`${field} w-full`} />
        </Labelled>

        <Labelled label="Target amount">
          <input name="target_amount" type="number" step="any" required min="0.00000001"
            defaultValue={ipo?.target_amount} className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Minimum subscription">
          <input name="min_subscription" type="number" step="any" min="0"
            defaultValue={ipo?.min_subscription ?? 0} className={`${field} w-full`} />
        </Labelled>
        {/* Allocation placed away from this platform, before the book opened here. It is
            added to the raise on every screen AND to the cap on every subscription, so
            setting it genuinely reduces what clients can take — a bar that moved without the
            allocation moving would be a bar that lies. */}
        <Labelled label="Already placed elsewhere">
          <input name="raised_baseline" type="number" step="any" min="0"
            defaultValue={ipo?.raised_baseline ?? 0} className={`${field} w-full`} />
          <span className="mt-1 block text-xs text-slate-ink">
            Counted in the raise and against the cap. Not client money: nothing settles or
            refunds it, and it appears in no client's position.
          </span>
        </Labelled>
        <Labelled label="Maximum subscription">
          <input name="max_subscription" type="number" step="any" min="0" placeholder="none"
            defaultValue={ipo?.max_subscription ?? ''} className={`${field} w-full`} />
        </Labelled>
        <Labelled label="ROI rate (% a year)">
          {/* No max: a short-dated offering annualises to a figure that reads absurd and is
              still the right number, and the ceiling here only ever stopped the desk typing
              its own rate. The server still refuses a negative one. */}
          <input name="roi_rate" type="number" step="0.01" required min="0"
            defaultValue={ipo ? Number((ipo.roi_rate * 100).toFixed(2)) : ''} className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Term (days)">
          <input name="term_days" type="number" required min="1" max="3650"
            defaultValue={ipo?.term_days} className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Picture" wide>
          <div className="flex flex-wrap items-start gap-4">
            {/* What is actually on the card right now, at the shape the card uses — a
                picture chosen against a square preview and shown in 16:9 is a picture with
                its subject cropped out, and the desk should see that before a client does. */}
            <span className="shot block w-56 shrink-0"
              style={markTint(ipo?.asset ?? '') ? ({ '--mark': markTint(ipo?.asset ?? '') } as React.CSSProperties) : undefined}>
              {shot ? <img src={shot} alt="" /> : <IpoMark asset={ipo?.asset ?? ''} />}
            </span>
            <span className="min-w-56 flex-1 space-y-2">
              <input name="image" type="file" accept="image/jpeg,image/png,image/webp"
                className={`${field} w-full`}
                onChange={(e) => setChosen(e.target.files?.[0] ?? null)} />
              <span className="block text-xs text-slate-ink">
                JPEG, PNG or WebP, up to 5 MB. Shown at 16:9 on the client's card.
                {!ipo && ' It is uploaded once the offering is saved.'}
              </span>
              {chosen && (
                <span className="block text-xs text-ember-ink">
                  Previewing {chosen.name} — not saved until you save the offering.
                </span>
              )}
              {ipo?.has_image && !chosen && (
                <button type="button" className="rounded-full border border-pebble px-3 py-1.5 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
                  disabled={removing}
                  onClick={async () => {
                    setRemoving(true);
                    setError(null);
                    try {
                      await api(`/admin/ipos/${ipo.id}/image`, { method: 'DELETE' });
                      onDone();
                    } catch (err) { setError((err as Error).message); } finally { setRemoving(false); }
                  }}>
                  {removing ? 'Removing…' : 'Remove picture'}
                </button>
              )}
              {!ipo?.has_image && !chosen && (
                <span className="block text-xs text-slate-ink">
                  No picture, so the card wears the offering's drawn mark.
                </span>
              )}
            </span>
          </div>
        </Labelled>

        <Labelled label="Opens at">
          <input name="opens_at" type="datetime-local" defaultValue={forInput(ipo?.opens_at ?? null)}
            className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Closes at">
          <input name="closes_at" type="datetime-local" defaultValue={forInput(ipo?.closes_at ?? null)}
            className={`${field} w-full`} />
        </Labelled>
        <Labelled label="Matures at">
          <input name="matures_at" type="datetime-local" defaultValue={forInput(ipo?.matures_at ?? null)}
            className={`${field} w-full`} />
        </Labelled>
      </div>

      {/* A number that silently changes what people are paid deserves a sentence of
          friction, so the form says who it affects and from when. */}
      {ipo && affected > 0 && (
        <p className="rounded-r-md border-l-2 border-ember bg-ember/5 px-3 py-2 text-xs">
          Changing the ROI affects <strong>{affected} subscriber{affected === 1 ? '' : 's'}</strong>
          {' '}holding <strong>{num(ipo.raised)} {ipo.currency}</strong>. The new rate applies from
          the next daily accrual; nothing already credited is recalculated, and anyone on an
          agreed override keeps it.
        </p>
      )}

      {error && <p role="alert" className={alertBox}>{error}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-pebble pt-3 dark:border-white/10">
        <button className={btn} disabled={busy}>{busy ? 'Saving…' : ipo ? 'Save' : 'Create'}</button>
        <button type="button" onClick={onCancel}
          className="rounded-full border border-pebble px-3 py-1.5 text-sm text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
          Cancel
        </button>
        {ipo && <Lifecycle ipo={ipo} onDone={onDone} />}
      </div>
      {!ipo && (
        <p className="text-xs text-slate-ink">
          Created as a draft, invisible to clients until you publish it.
        </p>
      )}
    </form>
  );
}

/** Publish, cancel, settle. Each moves either visibility or money, so each is explicit. */
function Lifecycle({ ipo, onDone }: { ipo: Ipo; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(label);
    setError(null);
    try { await fn(); onDone(); } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  };

  return (
    <>
      {ipo.stored_status === 'draft' && (
        <button type="button" className={btn} disabled={!!busy}
          onClick={() => run('publish', () => api(`/admin/ipos/${ipo.id}`, {
            method: 'PATCH', body: JSON.stringify({ status: 'upcoming' }),
          }))}>
          {busy === 'publish' ? 'Publishing…' : 'Publish'}
        </button>
      )}
      {(ipo.status === 'active' || ipo.status === 'closed') && (
        <button type="button" disabled={!!busy}
          className="rounded-full border border-pebble px-3 py-1.5 text-sm text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum"
          onClick={() => run('settle', () => api(`/admin/ipos/${ipo.id}/settle`, { method: 'POST' }),
            `Settle ${ipo.name} now? Every subscriber is paid their principal plus what has accrued to today.`)}>
          {busy === 'settle' ? 'Settling…' : 'Settle early'}
        </button>
      )}
      {ipo.status !== 'cancelled' && ipo.status !== 'completed' && ipo.status !== 'active' && (
        <button type="button" disabled={!!busy}
          className="rounded-full border border-pebble px-3 py-1.5 text-sm text-slate-ink transition-colors hover:border-down/60 hover:text-down dark:border-white/10"
          onClick={() => run('cancel', () => api(`/admin/ipos/${ipo.id}/cancel`, { method: 'POST' }),
            `Cancel ${ipo.name}? Every active subscription is refunded in full, at the amount originally debited.`)}>
          {busy === 'cancel' ? 'Cancelling…' : 'Cancel offering'}
        </button>
      )}
      {error && <span role="alert" className="text-xs text-down">{error}</span>}
    </>
  );
}

/** The book: who subscribed, what they hold, and what they are actually paid. */
function Book({ ipoId, canOverride }: { ipoId: string; canOverride: boolean }) {
  const rows = useApi<Sub[]>(`/admin/ipos/${ipoId}/subscriptions`);
  const list = rows.data ?? [];
  const total = list.filter((s) => s.status !== 'refunded').reduce((n, s) => n + Number(s.amount), 0);

  return (
    <section className={`${card} space-y-3`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="section-title">Book</span>
        <span className="text-xs text-slate-ink">
          {list.length} subscription{list.length === 1 ? '' : 's'} · {num(total)} committed
        </span>
      </div>
      {rows.error && <p role="alert" className={alertBox}>{rows.error}</p>}
      {!rows.data ? <p className="text-sm text-slate-ink">Loading…</p> : !list.length
        ? <p className="py-6 text-center text-sm text-slate-ink">Nobody has subscribed yet.</p>
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={thead}>
                <tr>{['Client', 'Amount', 'Earned', 'Effective', 'Status', 'When', ''].map((h) => (
                  <th key={h} className="px-3 py-2 text-left">{h}</th>))}
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <Row key={s.id} sub={s} canOverride={canOverride} onDone={rows.reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      <p className="text-xs text-slate-ink">
        An override is the desk's agreement with one client and stays desk-side — the client
        page shows the offering's own rate. Setting one needs funds:credit and lands on that
        client's timeline.
      </p>
    </section>
  );
}

function Row({ sub, canOverride, onDone }: { sub: Sub; canOverride: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(sub.roi_override === null ? '' : String(Number((sub.roi_override * 100).toFixed(2))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: number | null) {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/ipo-subscriptions/${sub.id}`, {
        method: 'PATCH', body: JSON.stringify({ roi_override: next }),
      });
      setOpen(false);
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <tr className="border-t border-pebble dark:border-white/10">
        <td className="px-3 py-2">
          <span className="block font-medium">{sub.client_name}</span>
          <span className="block font-mono text-[11px] text-slate-ink">{sub.client_email} · {sub.tier}</span>
        </td>
        <td className="px-3 py-2 font-mono tabular-nums">{num(sub.amount)}</td>
        <td className="px-3 py-2 font-mono tabular-nums text-up">+{num(sub.accrued)}</td>
        <td className="px-3 py-2 font-mono tabular-nums">
          {pct(sub.effective_rate)}
          {sub.roi_override !== null && (
            <span className="ml-1.5 rounded-full bg-bone px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-slate-ink uppercase dark:bg-white/10 dark:text-mist">
              agreed
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-slate-ink">{sub.status}</td>
        <td className="px-3 py-2 font-mono text-xs text-slate-ink">{day(sub.created_at)}</td>
        <td className="px-3 py-2">
          {canOverride && sub.status === 'active' && (
            <button onClick={() => setOpen(!open)}
              className="rounded-full border border-pebble px-2.5 py-1 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
              {open ? 'Close' : 'Override'}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-pebble bg-bone/60 dark:border-white/10 dark:bg-white/5">
          <td colSpan={7} className="px-3 py-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="metric-label">Agreed rate</span>
                <span className="mt-1 flex items-center gap-2">
                  <input className={`${field} w-28`} type="number" step="0.01" min="0"
                    placeholder={String(Number((sub.offering_rate * 100).toFixed(2)))}
                    value={value} onChange={(e) => setValue(e.target.value)} />
                  <span className="font-mono text-xs">% a year</span>
                </span>
              </label>
              <button className={btn} disabled={busy || value === ''}
                onClick={() => save(Number(value))}>
                {busy ? 'Saving…' : 'Set rate'}
              </button>
              {sub.roi_override !== null && (
                <button disabled={busy} onClick={() => save(null)}
                  className="rounded-full border border-pebble px-3 py-1.5 text-sm text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
                  Back to the offering's rate
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-ink">
              {sub.roi_override === null
                ? `On the offering's ${pct(sub.offering_rate)}.`
                : `Agreed rate. The offering pays ${pct(sub.offering_rate)}.`}
              {' '}Applies from the next daily accrual; the client is told.
            </p>
            {error && <p role="alert" className={`${alertBox} mt-2`}>{error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

const Labelled = ({ label, wide, children }: {
  label: string; wide?: boolean; children: React.ReactNode;
}) => (
  <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
    <span className="metric-label mb-1 block">{label}</span>
    {children}
  </label>
);
