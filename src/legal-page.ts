/**
 * The public legal pages: the terms, the privacy policy and the risk warning.
 *
 * Server-rendered like the Insights pages and on the same shell, so a reader who arrives
 * from a search engine or a sign-up link gets the whole text without the app. The words
 * are drafts written against what the platform actually does; every fact the desk has to
 * settle is written in square brackets and rendered as a marked "to confirm" chip, and a
 * page that still carries any of them says at the top that it is a draft. That is
 * deliberate: a legal page with a placeholder that looks finished is worse than one that
 * says it is not.
 *
 * Edit the text here. It is code because it changes with the product and should go
 * through the same review as the product does.
 */
import { escapeHtml as esc } from './articles.ts';
import { layout, type FooterView } from './blog-page.ts';

export type LegalKind = 'terms' | 'privacy' | 'risk';

/**
 * The desk's fill-ins: placeholder text -> what to print instead. Set from Settings; a
 * placeholder with no fill-in renders as the marked chip and counts toward the draft banner.
 */
export type Fills = Record<string, string>;

/** Text with the desk's placeholders filled or marked. Escaped first, so brackets in a mark are safe. */
const fill = (s: string, fills: Fills) => s.replace(/\[([^\]]+)\]/g, (m, key: string) => {
  const v = fills[key]?.trim();
  return v ? v : m;
});
const t = (s: string, fills: Fills = {}) => esc(fill(s, fills)).replace(/\[([^\]]+)\]/g, '<mark class="tbc" title="To confirm before publishing">$1</mark>');
// Bodies are built as functions of the fill-ins, so one page module renders both the
// draft and the filled page from the same words.
type Body = (f: Fills) => string;
const p = (...paras: string[]): Body => (f) => paras.map((x) => `<p>${t(x, f)}</p>`).join('\n');
const ul = (items: string[]): Body => (f) => `<ul>${items.map((x) => `<li>${t(x, f)}</li>`).join('')}</ul>`;
const table = (head: string[], rows: string[][]): Body => (f) =>
  `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${t(h, f)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${t(c, f)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

type Section = { id: string; title: string; body: Body };
type Page = {
  kind: LegalKind; path: string; title: string; description: string; summary: string[]; summaryNote?: string;
  warn?: string; sections: Section[]; updated: string; version: string;
};

const LAST_UPDATED = '[DATE]';
const VERSION = '1.0 draft';

const TERMS: Page = {
  kind: 'terms', path: '/terms', title: 'Terms of Service', version: VERSION, updated: LAST_UPDATED,
  description: 'The terms that govern an account on pntgp.xyz: its trading environment, its automated trader, its offerings, and the limits of what Pantera GP promises.',
  summary: [
    'Balances on the platform are the record we keep of your account: credits, deposits, trading results and withdrawals.',
    'Leveraged trading can lose quickly, and no record here is a guide to future results.',
    'The automated trader places real orders on your account under parameters we set and may change.',
  ],
  summaryNote: 'This summary is for orientation. The numbered sections are the contract.',
  warn: 'Leveraged trading can lose more than the amount at risk quickly, and most people who trade leveraged products lose. Nothing on the platform is a promise of profit. Read the full risk warning before you trade or switch on the automated trader.',
  sections: [
    { id: 'who', title: 'Who we are and what this is', body: p(
      'These terms are a contract between you and Pantera GP ("we"). They govern your use of pntgp.xyz and everything on it (the "Platform").',
      'By opening an account you accept them. If you do not accept them, do not open an account.') },
    { id: 'platform', title: 'The Platform is our own trading environment', body: p(
      'Every balance shown on the Platform is the record we keep of your account: credits, deposits, trading results and withdrawals. What can be taken out of the Platform, and how, is set by section 8.',
      'Prices on the Platform are set by us and may differ from prices quoted elsewhere. Fills are at our execution price, which includes the spread and commission that apply to your account.') },
    { id: 'risk', title: 'Risk warning', body: p(
      'Leveraged trading can lose more than the amount at risk quickly, and most people who trade leveraged products lose. Nothing on the Platform is a promise of profit.',
      'A record of past results, including a win rate or an equity curve, is not a guide to future results. Read this warning again before you turn on any automated strategy.') },
    { id: 'advice', title: 'Nothing here is advice', body: p(
      'Articles, signals, strategy names and descriptions, the automated trader\'s log, and anything our staff say to you are information only. None of it is investment, financial, legal or tax advice, and none of it is a recommendation to buy, sell or hold anything.') },
    { id: 'account', title: 'Your account', body: p(
      'You must be at least [18] years old and legally able to enter this contract. One account per person.',
      'Keep your password to yourself; you are responsible for what is done with your account until you tell us it has been compromised.',
      'We may ask you for identity documents and proof of address at any time, may suspend your account while we review them, and may refuse or close an account at our discretion.',
      'You must not use the Platform from [PROHIBITED JURISDICTIONS] or where doing so is unlawful.') },
    { id: 'trading', title: 'Trading', body: p(
      'You place orders at your own risk. We may set, and change, the leverage, spread, commission, instruments and limits that apply to your account.',
      'We may reject or reverse an order or a fill that results from an error, an abuse of the price feed, or a breach of these terms. Stops and targets are executed against our own prices and may fill at a different price from the one you set.') },
    { id: 'auto', title: 'The automated trader', body: p(
      'If you switch on the automated trader you authorise its strategies to place and close orders on your account.',
      'We set and may change the strategies\' parameters, including allocations, instruments, exit rules, a target rate for the record and daily limits, without notice. You may pause a strategy or switch the trader off at any time; positions already open keep their stops and targets.',
      'The trader is provided as is. It can lose, and we do not guarantee any rate of wins, any return or any level of activity.') },
    { id: 'money', title: 'Credits, deposits and withdrawals', body: p(
      'We may credit your account at our discretion, and may reverse a credit.',
      'Where we record a deposit or a withdrawal, it is subject to our review, to identity verification and to our approval, and it is processed within [TIMEFRAME].',
      '[STATE HOW A WITHDRAWAL IS PAID, ON WHAT CONDITIONS, AND ANY FEES.]') },
    { id: 'offerings', title: 'Offerings, portfolios and staking', body: p(
      'An offering on the Platform is a fixed-return product of ours with the term, minimum, allocation and rate shown on it. It is not a share, a security, an allocation in any listing, or any interest in the company it is named after; company names are used to describe the product only.',
      'Portfolio interest and staking rewards accrue at the rate shown, which we may change for new positions. Locked products cannot be exited before their term except as the product says.') },
    { id: 'wallet', title: 'Wallet connection', body: p(
      'Connecting a wallet lets your browser read its address and balances so you can see them beside your account. We never request a signature or a transaction, never take custody of any asset, and store the address only if you choose to link it to your account.') },
    { id: 'use', title: 'Acceptable use', body: ul([
      'Do not access the Platform other than through its own pages and application.',
      'Do not interfere with the price feed or the order book.',
      'Do not open more than one account.',
      'Do not use the Platform for anything unlawful.',
      'Do not copy or resell its content or data.']) },
    { id: 'ip', title: 'Our content', body: p(
      'The Platform, its software, drawings, strategy logic, articles and data are ours or our licensors\'. You may use them only to use the Platform. Names and marks of other companies belong to their owners.') },
    { id: 'availability', title: 'Availability', body: p(
      'We may change, suspend or withdraw any part of the Platform at any time. We aim for continuous service but do not promise it, and we may take the Platform down for maintenance without notice.') },
    { id: 'liability', title: 'Liability', body: p(
      'Nothing in these terms limits liability that cannot be limited by law, including for death, personal injury, fraud, or your statutory rights as a consumer.',
      'Subject to that, we are not liable for trading losses, lost profits, loss of data, or indirect or consequential loss, whether from your own orders, the automated trader, an offering, a price, a fill, downtime or an error in the Platform.',
      'Our total liability to you for anything else is limited to [AMOUNT OR THE FEES YOU PAID US IN THE PREVIOUS 12 MONTHS].') },
    { id: 'closing', title: 'Closing your account', body: p(
      'You may close your account at any time by [METHOD]. We may suspend or close it for breach of these terms, suspected fraud or abuse, a legal request, or if we withdraw the Platform.',
      'On closure, [STATE WHAT HAPPENS TO THE BALANCE], and we keep the records the law requires us to keep.') },
    { id: 'changes', title: 'Changes to these terms', body: p(
      'We may change these terms. We will notify material changes by email at least [14] days before they take effect. Using the Platform after that date is acceptance.') },
    { id: 'law', title: 'Law and disputes', body: p(
      'These terms are governed by the law of [JURISDICTION]. Disputes go to the courts of [JURISDICTION], except that if you are a consumer you may also bring a claim in the courts of the country where you live.') },
    { id: 'contact', title: 'Contact', body: p('Pantera GP, legal@pantera-gp.com.') },
  ],
};

const PRIVACY: Page = {
  kind: 'privacy', path: '/privacy', title: 'Privacy Policy', version: VERSION, updated: LAST_UPDATED,
  description: 'What personal data pntgp.xyz collects, why, on what legal basis, who it is shared with, how long it is kept, and the rights you have over it.',
  summary: [
    'We collect what an account needs, your identity documents when we verify you, and the record of your trading.',
    'Each use has a stated legal basis and a stated retention period, in the table below.',
    'Three providers process data for us: our host, our email service and the service that supplies public articles.',
    'We do not sell personal data and do not use advertising or analytics cookies.',
    'You can ask for a copy, a correction or a deletion, and you can complain to us and to the regulator.',
  ],
  sections: [
    { id: 'controller', title: 'Who is responsible for your data', body: p(
      'Pantera GP is the controller of the personal data described here. Privacy requests and complaints go to legal@pantera-gp.com.') },
    { id: 'what', title: 'What we collect, why, and on what basis', body: table(
      ['Purpose', 'Data', 'Lawful basis', 'Kept for'],
      [
        ['Opening and running your account', 'Name, email, phone, country, password (stored hashed), account settings', 'Contract', 'While the account is open, then [12] months'],
        ['Verifying your identity', 'Passport or national ID, proof of address, the review outcome, the reviewer', '[Legal obligation under anti-money-laundering rules / Legitimate interest in preventing fraud and impersonation, assessed and documented]', '[Five years after the relationship ends / While the account is open, then [12] months]'],
        ['Recording your trading', 'Orders, fills, positions, balances, credits, deposits, withdrawals, offering subscriptions, staking and portfolio positions, the automated trader\'s settings and log', 'Contract', 'While the account is open, then [6] years for financial records'],
        ['Keeping the Platform secure', 'Sign-in times, IP address, device and browser, the audit log of changes to your record and who made them', 'Legitimate interest in security and in a record of what was done to your account', '[12] months for sign-in data; the audit log for the life of the account plus [6] years'],
        ['Supporting you', 'Support tickets, messages and notes staff add to your record', 'Contract', 'While the account is open, then [12] months'],
        ['Sending you the weekly update', 'Email address, opt-out status', 'Consent, which you can withdraw with the link in every message', 'Until you unsubscribe'],
        ['Sending account mail', 'Email address', 'Contract; statements, security and verification mail continue after you opt out of marketing', 'While the account is open'],
        ['Showing a connected wallet', 'Wallet address and balances, read in your browser', 'Consent, given when you connect; the address is stored only if you link it', 'Not stored unless linked; then while the account is open'],
        ['Public articles and the website', 'No personal data. The session token and your theme choice are kept in your browser\'s local storage because the Platform cannot work without them; no analytics or advertising storage is used', 'Strictly necessary', 'Until you sign out or clear your browser'],
      ]) },
    { id: 'transfers', title: 'Where it is held and transfers', body: p(
      'The database is hosted in [REGION]. Where a provider processes data outside [the UK / the EEA], the transfer is covered by [Standard Contractual Clauses / the UK International Data Transfer Addendum / an adequacy decision]. Copies are available on request.') },
    { id: 'security', title: 'How we protect it', body: p(
      'Connections are encrypted in transit. Passwords are stored as one-way hashes. Identity documents are stored inside the database and are visible only to staff with the review role.',
      'Every change to a client record is written to an audit log with who made it. Access to the desk is by named staff accounts that can be switched off at once.') },
    { id: 'rights', title: 'Your rights', body: p(
      'You can ask us for a copy of your data, to correct it, to delete it, to restrict or object to how we use it, to receive it in a portable form, and to withdraw any consent you gave. Write to legal@pantera-gp.com; we answer within one month. Some records must be kept by law after you ask for deletion, and we will tell you which.',
      'You can complain to us at the same address; we acknowledge within 30 days and tell you the outcome. You can also complain to [the Information Commissioner\'s Office at ico.org.uk / your local data protection authority].') },
    { id: 'children', title: 'Children', body: p(
      'The Platform is for people aged [18] and over. We close accounts found to belong to anyone younger and delete their data.') },
    { id: 'changes', title: 'Changes to this policy', body: p(
      'We update this policy when what we do changes, and post the date of the current version at the top of this page. Material changes are announced by email.') },
  ],
};

const RISK: Page = {
  kind: 'risk', path: '/risk', title: 'Risk Warning', version: VERSION, updated: LAST_UPDATED,
  description: 'The risks of trading on pntgp.xyz in plain words: leverage, the platform\'s own prices, the automated trader, and offerings that are not equity.',
  summary: [],
  sections: [
    { id: 'leverage', title: 'Leverage', body: p(
      'A leveraged position moves in value by a multiple of the price move. A small move against you can cost more than the amount you set aside for the trade, and a stop is not a guarantee: it is executed at our price when it triggers, which can be worse than the level you set.') },
    { id: 'prices', title: 'Prices and execution', body: p(
      'Prices on the Platform are set by us and may differ from prices quoted elsewhere. Fills carry the spread and commission that apply to your account, so a result on the Platform can differ from what the same trade would have done elsewhere.') },
    { id: 'auto', title: 'The automated trader', body: p(
      'The automated strategies place and close orders on your account without asking you first. We set their parameters, including a target for the record, and may change them. They can lose, they can lose several times in a row, and a win rate or an equity curve from any period is not a forecast of the next one.') },
    { id: 'offerings', title: 'Offerings', body: p(
      'An offering is a fixed-return product of ours. It is not a share, not an allocation in a listing, and gives you no interest in the company it is named after. Its rate and term are set by us, and the company named has nothing to do with them.') },
    { id: 'balances', title: 'Balances and withdrawals', body: p(
      'Balances on the Platform are the record we keep of your account. What you can take out of the Platform, and how, is set by section 8 of the Terms of Service, and nothing on a page of the Platform changes that.') },
    { id: 'help', title: 'If you are unsure', body: p(
      'If you do not understand a product on the Platform, do not use it. Nothing here is advice, and you should take your own before committing anything you cannot afford to lose.') },
  ],
};

const PAGES: Record<LegalKind, Page> = { terms: TERMS, privacy: PRIVACY, risk: RISK };

/** Every distinct placeholder a page carries, in order of appearance: what the desk can fill in. */
export function placeholdersOf(kind: LegalKind): string[] {
  const page = PAGES[kind];
  const text = [page.updated, ...page.summary, page.summaryNote ?? '', page.warn ?? '',
    ...page.sections.map((s) => s.title + ' ' + s.body({}))].join(' ');
  const out: string[] = [];
  for (const m of text.matchAll(/\[([^\]]+)\]/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** How many placeholders a page still carries after the fill-ins: zero means it can be published as is. */
export function placeholdersIn(kind: LegalKind, fills: Fills = {}): number {
  return placeholdersOf(kind).filter((k) => !fills[k]?.trim()).length;
}

export function legalPage(kind: LegalKind, o: { publicUrl: string; fills?: Fills; footer?: FooterView }): string {
  const page = PAGES[kind];
  const f = o.fills ?? {};
  const open = placeholdersIn(kind, f);
  const others = (Object.values(PAGES) as Page[]).filter((x) => x.kind !== kind);
  const num = (i: number) => String(i + 1).padStart(2, '0');
  return layout({
    title: `${page.title} — Pantera GP`,
    description: page.description,
    canonical: `${o.publicUrl}${page.path}`,
    publicUrl: o.publicUrl, nav: 'legal', noCta: true, theme: 'terminal', footer: o.footer,
    body: `<main class="wrap legal">
  <header class="legal-head">
    <span class="mono" style="color:var(--ember)">Legal</span>
    <h1 class="display">${esc(page.title)}</h1>
    <div class="meta mono"><span>Version <b>${esc(page.version)}</b></span><span>Last updated <b>${t(page.updated, f)}</b></span><span>Applies to <b>pntgp.xyz</b></span></div>
  </header>
  ${open ? `<div class="draft-note">Draft · ${open} ${open === 1 ? 'point' : 'points'} to confirm before publishing, marked like <mark class="tbc">this</mark></div>` : ''}
  <nav class="legal-nav" aria-label="Contents">
    <span class="k mono">Contents</span>
    ${page.sections.map((s, i) => `<a href="#${s.id}"><i>${num(i)}</i>${esc(s.title)}</a>`).join('\n    ')}
    <div class="other mono"><span class="k">Also</span>${others.map((x) => `<a href="${x.path}">${esc(x.title)}</a>`).join('')}<a href="javascript:print()">Print this page</a></div>
  </nav>
  <article class="legal-body">
    ${page.summary.length ? `<aside class="summary"><span class="k mono">In plain words</span><ul>${page.summary.map((s) => `<li>${t(s, f)}</li>`).join('')}</ul>${page.summaryNote ? `<p>${t(page.summaryNote, f)}</p>` : ''}</aside>` : ''}
    ${page.warn ? `<div class="warn"><span class="k mono">Risk warning</span>${t(page.warn, f)} <a href="/risk" style="color:var(--ember);text-decoration:underline;text-underline-offset:3px">Read it in full.</a></div>` : ''}
    ${page.sections.map((s, i) => `<section><h2 id="${s.id}"><i>${num(i)}</i>${t(s.title, f)}</h2>${s.body(f)}</section>`).join('\n')}
    <div class="legal-foot mono"><span>${esc(page.title)} · version ${esc(page.version)}</span><div class="x">${others.map((x) => `<a href="${x.path}">${esc(x.title)}</a>`).join('')}</div></div>
  </article>
</main>`,
  });
}

export const LEGAL_PATHS: Record<LegalKind, string> = { terms: '/terms', privacy: '/privacy', risk: '/risk' };
