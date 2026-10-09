/**
 * The public contact page, on the platform's terminal look.
 *
 * Where the desk operates, as regions and hours rather than premises: three day bands with
 * the desk's hours lit, then the ways to reach it. Hours render as the same marked "to
 * confirm" chip the legal pages use until the desk confirms them.
 */
import { escapeHtml as esc } from './articles.ts';
import { layout } from './blog-page.ts';

/** What the desk may set on this page from Settings; anything left out keeps the default. */
export type ContactContent = {
  lead?: string;
  support_email?: string;
  /** Offices, shown in place of the regions when there is at least one. */
  offices?: { role: string; city: string; lines: string[]; hours: string; phone: string }[];
  /** Answering hours per region, by region name. */
  region_hours?: Record<string, string>;
};

const t = (s: string) => esc(s).replace(/\[([^\]]+)\]/g, '<mark class="tbc" title="To confirm before publishing">$1</mark>');

type Region = { name: string; hub: string; zone: string; utc: string; start: number; end: number; hours: string; covers: string };

/**
 * Where the desk operates: regions and hours, not premises. Each band is a 24-hour day in
 * the region's own time with the desk's hours lit, so the three read together as the day
 * passing across the desk. Hours are the desk's to confirm; they render as marked chips
 * until it does.
 */
const REGIONS: Region[] = [
  { name: 'Americas', hub: 'New York', zone: 'Eastern Time', utc: 'UTC−4 / −5', start: 8, end: 18, hours: '[08:00–18:00 ET]', covers: 'US and Canadian clients · FX majors, gold, crypto' },
  { name: 'Europe', hub: 'London', zone: 'UK time', utc: 'UTC+0 / +1', start: 8, end: 18, hours: '[08:00–18:00 UK]', covers: 'UK and European clients · FX majors, gold, crypto' },
  { name: 'Asia-Pacific', hub: 'Singapore', zone: 'Singapore Time', utc: 'UTC+8', start: 9, end: 18, hours: '[09:00–18:00 SGT]', covers: 'Asia-Pacific clients · FX majors, gold, crypto' },
];

/** A day band: 24 hours across, the desk's hours lit in ember, a tick every six. */
function band(r: Region) {
  const W = 320, H = 44, x = (h: number) => Math.round((h / 24) * W);
  const ticks = [0, 6, 12, 18, 24].map((h) => `<line x1="${x(h)}" y1="30" x2="${x(h)}" y2="36" stroke="currentColor" stroke-opacity=".35"/><text x="${x(h)}" y="43" font-size="8" fill="currentColor" fill-opacity=".6" text-anchor="${h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}" font-family="JetBrains Mono, monospace">${String(h % 24).padStart(2, '0')}</text>`).join('');
  return `<svg class="band" viewBox="0 0 ${W} ${H}" aria-label="Desk hours ${esc(r.hours)}"><rect x="0" y="12" width="${W}" height="10" rx="5" fill="currentColor" fill-opacity=".12"/><rect x="${x(r.start)}" y="12" width="${x(r.end) - x(r.start)}" height="10" rx="5" fill="#ff7817"/><circle cx="${x(r.start)}" cy="17" r="3" fill="#09090b" stroke="#ff7817" stroke-width="1.5"/><circle cx="${x(r.end)}" cy="17" r="3" fill="#09090b" stroke="#ff7817" stroke-width="1.5"/>${ticks}</svg>`;
}

const CHANNELS: { label: string; title: string; value: string; href?: string; note: string }[] = [
  { label: 'Support', title: 'support@pantera-gp.com', value: 'support@pantera-gp.com', href: 'mailto:support@pantera-gp.com', note: 'Questions about your account, a deposit or a position. Clients can also open a ticket from the Support page once signed in.' },
  { label: 'New accounts', title: 'Open an account', value: 'A few minutes', href: '/#register', note: 'Name, email and a password. You land in the terminal signed in, with nothing to configure first.' },
];

/** A drawn mark per office, cycled: our lines, not a map or a logo. */
const OFFICE_MARKS = [
  `<svg viewBox="0 0 120 72" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 20h104M8 36h104M8 52h104" opacity=".35"/><path d="M28 8v56M60 8v56M92 8v56" opacity=".35"/><circle cx="60" cy="36" r="7"/><circle cx="60" cy="36" r="2.5" fill="currentColor"/></svg>`,
  `<svg viewBox="0 0 120 72" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M20 64V30h20v34M44 64V14h32v50M80 64V38h20v26" /><path d="M52 24h16M52 34h16M52 44h16M52 54h16" opacity=".5"/><path d="M8 64h104" opacity=".35"/></svg>`,
  `<svg viewBox="0 0 120 72" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="60" cy="36" r="10"/><circle cx="60" cy="36" r="22" opacity=".5"/><circle cx="60" cy="36" r="34" opacity=".25"/><path d="M60 2v10M60 60v10M26 36h10M84 36h10" opacity=".5"/></svg>`,
];

export function contactPage(o: { publicUrl: string; content?: ContactContent }): string {
  const c = o.content ?? {};
  const support = c.support_email?.trim() || 'support@pantera-gp.com';
  const offices = (c.offices ?? []).filter((of) => of.city?.trim() || of.lines?.some((l) => l.trim()));
  const regions = REGIONS.map((r) => ({ ...r, hours: c.region_hours?.[r.name]?.trim() || r.hours }));
  const officesHtml = offices.length ? `<section class="offices" aria-label="Offices">
    ${offices.map((of, i) => `<article class="office">
      <div class="office-mark">${OFFICE_MARKS[i % OFFICE_MARKS.length]}</div>
      <span class="mono k">${String(i + 1).padStart(2, '0')} · ${t(of.role || 'Office')}</span>
      <h2 class="display">${t(of.city)}</h2>
      <address>${of.lines.filter((l) => l.trim()).map((l) => `<span>${t(l)}</span>`).join('')}</address>
      <dl class="office-meta mono">
        ${of.hours?.trim() ? `<div><dt>Hours</dt><dd>${t(of.hours)}</dd></div>` : ''}
        ${of.phone?.trim() ? `<div><dt>Phone</dt><dd>${t(of.phone)}</dd></div>` : ''}
      </dl>
    </article>`).join('\n    ')}
  </section>` : '';
  return layout({
    title: 'Contact — Pantera GP',
    description: 'Where Pantera GP is, and how to reach the desk: offices, support from your account, and the address for legal and privacy matters.',
    canonical: `${o.publicUrl}/contact`,
    publicUrl: o.publicUrl, nav: 'legal', noCta: true, theme: 'terminal',
    body: `<main class="wrap contact">
  <header class="contact-head">
    <span class="mono" style="color:var(--ember)">Contact</span>
    <h1 class="display">Talk to the desk</h1>
    <p class="lead">${t(c.lead?.trim() || 'One desk across three regions. Clients reach it from their account; everyone else by the channels below.')}</p>
  </header>
  ${officesHtml}
  ${offices.length ? '' : `<section class="coverage" aria-label="Where we operate">
    <div class="section-head"><span class="mono" style="color:var(--ember)">Where we operate</span><span class="rule"></span></div>
    <div class="regions">
      ${regions.map((r, i) => `<article class="region">
        <span class="mono k">${String(i + 1).padStart(2, '0')} · ${esc(r.name)}</span>
        <h2 class="display">${esc(r.hub)}</h2>
        <p class="zone mono">${esc(r.zone)} · ${esc(r.utc)}</p>
        ${band(r)}
        <dl class="region-meta mono">
          <div><dt>Desk hours</dt><dd>${t(r.hours)}</dd></div>
          <div><dt>Covers</dt><dd>${esc(r.covers)}</dd></div>
        </dl>
      </article>`).join('\n      ')}
    </div>
    <p class="coverage-note">Hours are the desk's answering hours in each region's local time. Trading runs around the clock from your account.</p>
  </section>`}
  <section class="channels" aria-label="How to reach us">
    <div class="section-head"><span class="mono" style="color:var(--ember)">How to reach us</span><span class="rule"></span></div>
    <div class="channel-grid">
      ${CHANNELS.map((ch) => ch.label === 'Support' ? { ...ch, title: support, value: support, href: `mailto:${support}` } : ch).map((ch) => `<a class="channel" href="${esc(ch.href ?? '#')}">
        <span class="mono k">${esc(ch.label)}</span>
        <strong>${esc(ch.title)}</strong>
        <p>${esc(ch.note)}</p>
        <span class="mono go">${esc(ch.value)} →</span>
      </a>`).join('\n      ')}
    </div>
  </section>
</main>`,
  });
}
