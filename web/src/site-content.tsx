import { useEffect, useState } from 'react';
import { alertBox, btn, btnGhost, card, input } from './App.tsx';
import { api, token, useApi } from './api.ts';

/**
 * Site content: what the desk can change on the public pages without a deploy.
 *
 * Two things live here. The contact page — its lead line, the support address, the
 * offices (shown in place of the regions once there is one) and the answering hours per
 * region. And the fill-ins on the legal pages: every placeholder the terms, the privacy
 * policy and the risk warning still carry, each with a box; a filled one prints as plain
 * text on the page and comes off the draft count, an empty one stays a marked chip.
 *
 * Saved sections are live on the next request. Admin only, like the rest of this page.
 */

type Office = { role: string; city: string; lines: string[]; hours: string; phone: string };
type Contact = { lead?: string; support_email?: string; offices?: Office[]; region_hours?: Record<string, string> };
type Legal = Record<'terms' | 'privacy' | 'risk', { placeholders: string[]; fills: Record<string, string> }>;
type FooterLink = { label: string; href: string };
type Footer = { text?: string; column_title?: string; links?: FooterLink[]; line?: string; logo_url?: string | null };
type Content = { contact: Contact; legal: Legal; footer: Footer };

/**
 * The footer: a logo, a paragraph, one column of links and the copyright line, on the
 * landing page and on every public page. The logo goes up as a file; everything else is a
 * box. Links may be a path on this site, a web address or a mailto.
 */
function FooterEditor({ initial, busy, saved, onSave, onLogo }: {
  initial: Footer; busy: boolean; saved: boolean;
  onSave: (f: Footer) => Promise<void>;
  onLogo: (file: File | null) => Promise<Footer | null>;
}) {
  const [f, setF] = useState<Footer>(initial);
  const [logoBusy, setLogoBusy] = useState(false);
  useEffect(() => { setF(initial); }, [initial]);
  const links = f.links ?? [];
  const setLink = (i: number, patch: Partial<FooterLink>) => setF({ ...f, links: links.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const logo = async (file: File | null) => {
    setLogoBusy(true);
    try { const next = await onLogo(file); if (next) setF({ ...f, logo_url: next.logo_url }); } finally { setLogoBusy(false); }
  };
  return (
    <div className="space-y-3 border-t border-pebble pt-4 dark:border-white/10">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-semibold">Footer</h3>
        <span className="text-xs text-slate-ink">On the landing page and every public page.</span>
      </div>
      <Row label="Logo">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          {f.logo_url
            ? <img src={f.logo_url} alt="Footer logo" className="h-8 w-auto rounded bg-onyx p-1" />
            : <span className="text-xs text-slate-ink">None: the footer shows the Pantera GP wordmark.</span>}
          <label className={`${btnGhost} cursor-pointer`}>
            {logoBusy ? 'Uploading…' : f.logo_url ? 'Replace' : 'Upload'}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={logoBusy}
              onChange={(e) => { const file = e.target.files?.[0]; if (file) void logo(file); e.target.value = ''; }} />
          </label>
          {f.logo_url && <button type="button" className="text-xs text-slate-ink hover:text-down" disabled={logoBusy} onClick={() => void logo(null)}>Remove</button>}
          <span className="basis-full text-xs text-slate-ink">PNG, JPEG or WebP up to 2 MB, shown 28px tall; a wide, light-on-dark mark reads best.</span>
        </div>
      </Row>
      <Row label="Text">
        <textarea className={`${input} min-h-20`} value={f.text ?? ''} maxLength={400}
          placeholder="A trading desk and a client system, built as one thing…"
          onChange={(e) => setF({ ...f, text: e.target.value })} />
      </Row>
      <Row label="Column title">
        <input className={`${input} max-w-xs`} value={f.column_title ?? ''} placeholder="Legal" onChange={(e) => setF({ ...f, column_title: e.target.value })} />
      </Row>
      <Row label="Links">
        <div className="flex-1 space-y-2">
          {links.map((l, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
              <input className={input} value={l.label} placeholder="Label" aria-label="Link label" onChange={(e) => setLink(i, { label: e.target.value })} />
              <input className={input} value={l.href} placeholder="/terms, https://… or mailto:…" aria-label="Link address" onChange={(e) => setLink(i, { href: e.target.value })} />
              <button type="button" className="text-xs text-slate-ink hover:text-down" onClick={() => setF({ ...f, links: links.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          {links.length < 12 && <button type="button" className={btnGhost} onClick={() => setF({ ...f, links: [...links, { label: '', href: '' }] })}>Add a link</button>}
          <p className="text-xs text-slate-ink">With no links, the column shows Terms, Privacy, Risk warning and Contact.</p>
        </div>
      </Row>
      <Row label="Copyright line">
        <input className={`${input} max-w-md`} value={f.line ?? ''} placeholder={`© ${new Date().getFullYear()} Pantera GP`} onChange={(e) => setF({ ...f, line: e.target.value })} />
      </Row>
      <div className="flex items-center gap-3">
        <button className={btn} disabled={busy} onClick={() => onSave({ ...f, links: links.filter((l) => l.label.trim() && l.href.trim()) })}>
          {busy ? 'Saving…' : 'Save footer'}
        </button>
        {saved && <span className="text-xs text-up">Saved · live now</span>}
      </div>
    </div>
  );
}

const REGIONS = ['Americas', 'Europe', 'Asia-Pacific'];
const PAGES: { key: keyof Legal; title: string; path: string }[] = [
  { key: 'terms', title: 'Terms of Service', path: '/terms' },
  { key: 'privacy', title: 'Privacy Policy', path: '/privacy' },
  { key: 'risk', title: 'Risk warning', path: '/risk' },
];
const blankOffice = (): Office => ({ role: 'Office', city: '', lines: ['', '', '', ''], hours: '', phone: '' });

export function SiteContent() {
  const loaded = useApi<Content>('/admin/site-content');
  const [contact, setContact] = useState<Contact>({});
  const [legal, setLegal] = useState<Legal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded.data) return;
    setContact(loaded.data.contact);
    setLegal(loaded.data.legal);
  }, [loaded.data]);

  const save = async (key: string, body: unknown) => {
    setBusy(key); setError(null); setSaved(null);
    try {
      await api(`/admin/site-content/${key}`, { method: 'PUT', body: JSON.stringify(body) });
      setSaved(key);
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  };

  if (!legal) return null;
  const offices = contact.offices ?? [];
  const setOffice = (i: number, patch: Partial<Office>) =>
    setContact({ ...contact, offices: offices.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  return (
    <section className={`${card} space-y-6`}>
      <div>
        <h2 className="section-title">Site content</h2>
        <p className="mt-1.5 max-w-2xl text-xs text-slate-ink">
          The public pages, editable here without a deploy. A save is live on the next visit. Leave a box empty to keep the page's own words.
        </p>
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}

      {/* ------------------------------------------------------------ contact */}
      <div className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-semibold">Contact page</h3>
          <a href="/contact" target="_blank" rel="noopener" className="text-xs text-ember-ink">Open the page</a>
        </div>
        <Row label="Lead line">
          <input className={input} value={contact.lead ?? ''} placeholder="One desk across three regions. Clients reach it from their account; everyone else by the channels below."
            onChange={(e) => setContact({ ...contact, lead: e.target.value })} />
        </Row>
        <Row label="Support email">
          <input className={`${input} max-w-sm`} type="email" value={contact.support_email ?? ''} placeholder="support@pantera-gp.com"
            onChange={(e) => setContact({ ...contact, support_email: e.target.value })} />
        </Row>
        <Row label="Region hours">
          <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
            {REGIONS.map((r) => (
              <label key={r} className="text-xs text-slate-ink">
                {r}
                <input className={`${input} mt-1`} value={contact.region_hours?.[r] ?? ''} placeholder="08:00–18:00"
                  onChange={(e) => setContact({ ...contact, region_hours: { ...(contact.region_hours ?? {}), [r]: e.target.value } })} />
              </label>
            ))}
          </div>
        </Row>
        <Row label="Offices">
          <div className="flex-1 space-y-3">
            <p className="text-xs text-slate-ink">
              With at least one office, the page shows office cards in place of the regions. Address lines print one under the other; empty lines are skipped.
            </p>
            {offices.map((o, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-pebble p-3 sm:grid-cols-2 dark:border-white/10">
                <input className={input} value={o.role} placeholder="Headquarters" aria-label="Role" onChange={(e) => setOffice(i, { role: e.target.value })} />
                <input className={input} value={o.city} placeholder="City" aria-label="City" onChange={(e) => setOffice(i, { city: e.target.value })} />
                {o.lines.map((l, k) => (
                  <input key={k} className={input} value={l} placeholder={['Street and number', 'Suite or floor', 'Postcode', 'Country'][k] ?? 'Address line'} aria-label={`Address line ${k + 1}`}
                    onChange={(e) => setOffice(i, { lines: o.lines.map((x, m) => (m === k ? e.target.value : x)) })} />
                ))}
                <input className={input} value={o.hours} placeholder="Mon–Fri 09:00–18:00" aria-label="Hours" onChange={(e) => setOffice(i, { hours: e.target.value })} />
                <input className={input} value={o.phone} placeholder="Phone" aria-label="Phone" onChange={(e) => setOffice(i, { phone: e.target.value })} />
                <button type="button" className="text-left text-xs text-slate-ink hover:text-down" onClick={() => setContact({ ...contact, offices: offices.filter((_, j) => j !== i) })}>Remove this office</button>
              </div>
            ))}
            {offices.length < 6 && (
              <button type="button" className={btnGhost} onClick={() => setContact({ ...contact, offices: [...offices, blankOffice()] })}>Add an office</button>
            )}
          </div>
        </Row>
        <div className="flex items-center gap-3">
          <button className={btn} disabled={busy === 'contact'} onClick={() => save('contact', { ...contact, support_email: contact.support_email?.trim() || undefined })}>
            {busy === 'contact' ? 'Saving…' : 'Save contact page'}
          </button>
          {saved === 'contact' && <span className="text-xs text-up">Saved · live now</span>}
        </div>
      </div>

      {/* ------------------------------------------------------------- footer */}
      <FooterEditor initial={loaded.data?.footer ?? {}} busy={busy === 'footer'} saved={saved === 'footer'}
        onSave={(f) => save('footer', { text: f.text, column_title: f.column_title, links: f.links, line: f.line })}
        onLogo={async (file) => {
          setError(null);
          try {
            if (!file) return await api<Footer>('/admin/site-content/footer/logo', { method: 'DELETE' });
            // Multipart goes through fetch, not the api helper: a JSON content-type on it
            // would strip the boundary the server needs to read the parts.
            const form = new FormData(); form.append('file', file);
            const res = await fetch('/api/admin/site-content/footer/logo', { method: 'POST', headers: { authorization: `Bearer ${token.get()}` }, body: form });
            if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Upload failed');
            return await res.json() as Footer;
          } catch (err) { setError((err as Error).message); return null; }
        }} />

      {/* -------------------------------------------------------------- legal */}
      {PAGES.map(({ key, title, path }) => {
        const page = legal[key];
        const open = page.placeholders.filter((p) => !page.fills[p]?.trim()).length;
        return (
          <div key={key} className="space-y-3 border-t border-pebble pt-4 dark:border-white/10">
            <div className="flex flex-wrap items-baseline gap-3">
              <h3 className="text-sm font-semibold">{title}</h3>
              <span className="font-mono text-xs text-slate-ink">{open ? `${open} of ${page.placeholders.length} still to confirm` : 'nothing left to confirm'}</span>
              <a href={path} target="_blank" rel="noopener" className="ml-auto text-xs text-ember-ink">Open the page</a>
            </div>
            {page.placeholders.length === 0 && <p className="text-xs text-slate-ink">This page has no placeholders.</p>}
            {page.placeholders.map((ph) => (
              <Row key={ph} label={ph}>
                <input className={input} value={page.fills[ph] ?? ''} placeholder="Leave empty to keep the marked chip"
                  onChange={(e) => setLegal({ ...legal, [key]: { ...page, fills: { ...page.fills, [ph]: e.target.value } } })} />
              </Row>
            ))}
            <div className="flex items-center gap-3">
              <button className={btn} disabled={busy === `legal:${key}`} onClick={() => save(`legal:${key}`, page.fills)}>
                {busy === `legal:${key}` ? 'Saving…' : `Save ${title}`}
              </button>
              {saved === `legal:${key}` && <span className="text-xs text-up">Saved · live now</span>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-wrap items-start gap-3 border-t border-pebble py-2 first:border-0 first:pt-0 dark:border-white/10">
    <span className="metric-label w-44 shrink-0 pt-2 normal-case tracking-normal">{label}</span>
    <div className="flex min-w-0 flex-1">{children}</div>
  </div>
);
