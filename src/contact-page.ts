/**
 * The public contact page, on the platform's terminal look.
 *
 * Offices are cards: a drawn mark, the office's role, its city set in Playfair, the address
 * lines, hours and a phone. Every address is a placeholder until the desk gives one for
 * premises Pantera GP actually occupies, and a placeholder renders as the same marked
 * "to confirm" chip the legal pages use, so a draft cannot be mistaken for a published
 * contact page. The channels below the offices are the ones the platform already has.
 */
import { escapeHtml as esc } from './articles.ts';
import { layout } from './blog-page.ts';

const t = (s: string) => esc(s).replace(/\[([^\]]+)\]/g, '<mark class="tbc" title="To confirm before publishing">$1</mark>');

type Office = { role: string; city: string; lines: string[]; hours: string; phone: string; mark: string };

/** Three drawn marks, one per office, in the house manner: our lines, not a map or a logo. */
const MARKS = {
  grid: `<svg viewBox="0 0 120 72" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 20h104M8 36h104M8 52h104" opacity=".35"/><path d="M28 8v56M60 8v56M92 8v56" opacity=".35"/><circle cx="60" cy="36" r="7"/><circle cx="60" cy="36" r="2.5" fill="currentColor"/></svg>`,
  tower: `<svg viewBox="0 0 120 72" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M20 64V30h20v34M44 64V14h32v50M80 64V38h20v26" /><path d="M52 24h16M52 34h16M52 44h16M52 54h16" opacity=".5"/><path d="M8 64h104" opacity=".35"/></svg>`,
  rings: `<svg viewBox="0 0 120 72" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="60" cy="36" r="10"/><circle cx="60" cy="36" r="22" opacity=".5"/><circle cx="60" cy="36" r="34" opacity=".25"/><path d="M60 2v10M60 60v10M26 36h10M84 36h10" opacity=".5"/></svg>`,
};

const OFFICES: Office[] = [
  { role: 'Headquarters', city: '[City]', lines: ['[Street and number]', '[Suite or floor]', '[Postcode]', '[Country]'], hours: '[Mon–Fri 09:00–18:00]', phone: '[Phone]', mark: MARKS.grid },
  { role: 'Office', city: '[City]', lines: ['[Street and number]', '[Suite or floor]', '[Postcode]', '[Country]'], hours: '[Mon–Fri 09:00–18:00]', phone: '[Phone]', mark: MARKS.tower },
  { role: 'Office', city: '[City]', lines: ['[Street and number]', '[Suite or floor]', '[Postcode]', '[Country]'], hours: '[Mon–Fri 09:00–18:00]', phone: '[Phone]', mark: MARKS.rings },
];

const CHANNELS: { label: string; title: string; value: string; href?: string; note: string }[] = [
  { label: 'Support', title: 'support@pantera-gp.com', value: 'support@pantera-gp.com', href: 'mailto:support@pantera-gp.com', note: 'Questions about your account, a deposit or a position. Clients can also open a ticket from the Support page once signed in.' },
  { label: 'Legal and privacy', title: 'legal@pantera-gp.com', value: 'legal@pantera-gp.com', href: 'mailto:legal@pantera-gp.com', note: 'Notices under the terms, privacy requests and complaints. Acknowledged within 30 days.' },
  { label: 'New accounts', title: 'Open an account', value: 'A few minutes', href: '/#register', note: 'Name, email and a password. You land in the terminal signed in, with nothing to configure first.' },
];

export function placeholdersInContact(): number {
  const text = OFFICES.map((o) => [o.city, ...o.lines, o.hours, o.phone].join(' ')).join(' ');
  return (text.match(/\[[^\]]+\]/g) ?? []).length;
}

export function contactPage(o: { publicUrl: string }): string {
  return layout({
    title: 'Contact — Pantera GP',
    description: 'Where Pantera GP is, and how to reach the desk: offices, support from your account, and the address for legal and privacy matters.',
    canonical: `${o.publicUrl}/contact`,
    publicUrl: o.publicUrl, nav: 'legal', noCta: true, theme: 'terminal',
    body: `<main class="wrap contact">
  <header class="contact-head">
    <span class="mono" style="color:var(--ember)">Contact</span>
    <h1 class="display">Talk to the desk</h1>
    <p class="lead">Three offices, one desk. Clients reach it from their account; everyone else by the channels below.</p>
  </header>
  <section class="offices" aria-label="Offices">
    ${OFFICES.map((of, i) => `<article class="office">
      <div class="office-mark">${of.mark}</div>
      <span class="mono k">${String(i + 1).padStart(2, '0')} · ${esc(of.role)}</span>
      <h2 class="display">${t(of.city)}</h2>
      <address>${of.lines.map((l) => `<span>${t(l)}</span>`).join('')}</address>
      <dl class="office-meta mono">
        <div><dt>Hours</dt><dd>${t(of.hours)}</dd></div>
        <div><dt>Phone</dt><dd>${t(of.phone)}</dd></div>
      </dl>
    </article>`).join('\n    ')}
  </section>
  <section class="channels" aria-label="How to reach us">
    <div class="section-head"><span class="mono" style="color:var(--ember)">How to reach us</span><span class="rule"></span></div>
    <div class="channel-grid">
      ${CHANNELS.map((c) => `<a class="channel" href="${esc(c.href ?? '#')}">
        <span class="mono k">${esc(c.label)}</span>
        <strong>${esc(c.title)}</strong>
        <p>${esc(c.note)}</p>
        <span class="mono go">${esc(c.value)} →</span>
      </a>`).join('\n      ')}
    </div>
  </section>
</main>`,
  });
}
