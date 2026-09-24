/**
 * The public Insights pages, rendered on the server as plain HTML.
 *
 * Not React, on purpose. The articles exist to be found by search engines and by the
 * assistants that read pages, and the app is a client-rendered shell whose first response
 * is an empty div. A crawler that does not run scripts gets nothing from that; it gets the
 * whole article from this. The look is the landing page's — same grounds, same type, same
 * one accent — restated here in a stylesheet the page carries with it, because the app's
 * CSS is built with the app and these pages are served without it.
 *
 * Everything from the database is escaped on the way in except the article body, which
 * was cleaned once when it arrived (see articles.ts) and is rendered as stored.
 */
import { escapeHtml as esc, type Article, type Faq } from './articles.ts';

export type ArticleCard = Pick<Article, 'slug' | 'title' | 'excerpt' | 'cover_url' | 'tags' | 'read_minutes' | 'published_at'>;

/** The one name on every article. Who wrote it is the desk, not a person. */
export const BYLINE = 'Pantera GP Research';

const DISCLAIMER = 'This article is general market commentary from Pantera GP. It is not investment advice and does not take account of your objectives or circumstances. Trading leveraged products carries a risk of loss.';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Whether to say "Updated": only for a revision on a later day. The service stamps an
 * update a few milliseconds after the publish, and "Updated" on the day it appeared says
 * nothing a reader can use.
 */
const revised = (a: Pick<Article, 'published_at' | 'updated_at'>) =>
  !!a.updated_at && a.updated_at.slice(0, 10) > a.published_at.slice(0, 10);

const CSS = `
:root{--ember:#ff7817;--ember-ink:#9a4000;--canvas:#f7f6ff;--ink:#190501;--ink-soft:#4a3a35;--stage:#140402;--pebble:#e5e7eb;--mist:#a1a1aa;--vellum:#fff;--graphite:#000;--ui:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--ease:cubic-bezier(.22,1,.36,1)}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--canvas);color:var(--ink);font-family:var(--ui);letter-spacing:-.02em;line-height:1.3;-webkit-font-smoothing:antialiased}
.mono{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.16em;text-transform:uppercase}
.display{font-weight:500;letter-spacing:-.022em;line-height:1.1}
a{color:inherit;text-decoration:none}
a:focus-visible,button:focus-visible{outline:2px solid var(--ember);outline-offset:3px}
nav{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:16px;padding:16px 32px;background:rgba(20,4,2,.85);backdrop-filter:blur(8px);border-bottom:1px solid rgba(255,255,255,.1);color:var(--vellum)}
nav .brand{display:flex;align-items:center;gap:8px;font-size:18px}
nav .brand i{font:500 12px var(--mono);color:var(--ember);font-style:normal}
nav .links{display:flex;gap:36px;margin-left:40px}
nav .links a,nav .right a.mono{position:relative;padding:6px 0;font-size:13px;font-weight:700;letter-spacing:.2em;color:var(--vellum);transition:color .18s var(--ease)}
nav .links a::after,nav .right a.mono::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--ember);transform:scaleX(0);transform-origin:left;transition:transform .3s var(--ease)}
nav .links a.on{color:var(--ember)}
nav .links a.on::after,nav .links a:hover::after,nav .right a.mono:hover::after{transform:scaleX(1)}
nav .links a:hover,nav .right a.mono:hover{color:var(--ember)}
nav .right{margin-left:auto;display:flex;align-items:center;gap:16px}
.btn-fill{display:inline-block;background:var(--ember);color:var(--graphite);padding:8px 16px;font:500 12px var(--mono);letter-spacing:.16em;text-transform:uppercase;transition:filter .14s var(--ease)}
.btn-fill:hover{filter:brightness(.94)}
.btn-line{display:inline-block;border:1px solid var(--ember);color:var(--ember);padding:8px 16px;font:500 12px var(--mono);letter-spacing:.16em;text-transform:uppercase;transition:background .14s var(--ease),color .14s var(--ease)}
.btn-line:hover{background:var(--ember);color:var(--graphite)}
.wrap{max-width:1200px;margin:0 auto;padding:0 32px}
.crumb{display:flex;gap:12px;align-items:center;padding:28px 0 0;color:var(--ink-soft)}
.crumb .sep{color:var(--ember-ink)}
header.art{max-width:880px;margin:0 auto;padding:56px 32px 40px;text-align:center}
.eyebrow{display:flex;justify-content:center;flex-wrap:wrap;gap:14px;color:var(--ember-ink);margin-bottom:22px}
.eyebrow span+span::before{content:"/";margin-right:14px;color:var(--mist)}
h1{font-size:52px;margin:0 0 20px}
.stand{font-size:19px;line-height:1.45;color:var(--ink-soft);margin:0 auto;max-width:720px}
.byline{display:flex;justify-content:center;align-items:center;gap:14px;margin-top:28px;color:var(--ink-soft);font-size:13px}
.byline strong{color:var(--ink);font-weight:500}
.avatar{width:32px;height:32px;background:var(--stage);display:grid;place-items:center;color:var(--ember);font:500 10px var(--mono);flex:none}
.hero{max-width:1040px;margin:0 auto;padding:0 32px}
.hero .img{position:relative;height:440px;background:var(--stage);overflow:hidden}
.hero .img img{width:100%;height:100%;object-fit:cover;display:block}
.hero .img.empty::before{content:"";position:absolute;inset:0;background:radial-gradient(60% 70% at 50% 110%,rgba(255,120,23,.42),transparent 70%)}
.hero .img.empty::after{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,transparent 0 3px,rgba(255,255,255,.035) 3px 4px)}
.body{max-width:720px;margin:0 auto;padding:56px 32px 40px;font-size:17px;line-height:1.6;letter-spacing:-.01em}
.body p{margin:0 0 24px}
.body>p:first-of-type::first-letter{float:left;font-size:64px;line-height:.8;padding:6px 10px 0 0;color:var(--ember-ink);font-weight:500}
.body h2,.body h3,.body h4{letter-spacing:-.022em;line-height:1.15;margin:44px 0 16px;font-weight:500}
.body h2{font-size:26px;counter-increment:sec;display:flex;gap:14px;align-items:baseline}
.body h2::before{content:counter(sec,decimal-leading-zero);font:500 11px var(--mono);letter-spacing:.16em;color:var(--ember-ink)}
.body h3{font-size:21px}.body h4{font-size:18px}
.body ul,.body ol{padding-left:22px;margin:0 0 24px}.body li{margin:0 0 8px}
.body a{color:var(--ember-ink);text-decoration:underline;text-underline-offset:3px}
.body img{max-width:100%;height:auto;display:block;margin:28px 0}
.body figure{margin:28px 0}.body figcaption{margin-top:8px;font:500 11px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft)}
.body blockquote{margin:40px 0;padding:0 0 0 28px;border-left:2px solid var(--ember);font-size:24px;line-height:1.3;letter-spacing:-.022em;font-weight:500}
.body blockquote p{margin:0}
.body code{font-family:var(--mono);font-size:.9em;background:rgba(25,5,1,.06);padding:2px 5px}
.body pre{background:var(--stage);color:var(--pebble);padding:18px 20px;overflow:auto;font-size:14px;line-height:1.5;margin:0 0 24px}
.body pre code{background:none;padding:0;color:inherit}
.body table{width:100%;border-collapse:collapse;margin:0 0 24px;font-size:15px}
.body th,.body td{border:1px solid var(--ink);padding:10px 12px;text-align:left;vertical-align:top}
.body th{font:500 11px var(--mono);letter-spacing:.16em;text-transform:uppercase}
.body hr{border:0;border-top:1px solid var(--ink);margin:40px 0}
.takeaways{border:1px solid var(--ink);padding:22px 24px;margin:0 0 36px}
.takeaways .k{color:var(--ember-ink);display:block;margin-bottom:12px}
.takeaways ol{margin:0;padding-left:0;list-style:none;counter-reset:tk}
.takeaways li{position:relative;padding-left:40px;margin:0 0 10px;font-size:16px;line-height:1.45;counter-increment:tk}
.takeaways li::before{content:counter(tk,decimal-leading-zero);position:absolute;left:0;top:3px;font:500 11px var(--mono);letter-spacing:.16em;color:var(--ember-ink)}
.faq{margin:44px 0 0}
.faq .k{color:var(--ember-ink);display:block;margin-bottom:6px}
.faq h2{margin:0 0 18px}
.faq h2::before{content:none}
.faq details{border-top:1px solid var(--ink)}
.faq details:last-child{border-bottom:1px solid var(--ink)}
.faq summary{cursor:pointer;padding:16px 0;font-size:17px;font-weight:500;letter-spacing:-.015em;list-style:none;display:flex;justify-content:space-between;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";color:var(--ember-ink);font-family:var(--mono)}
.faq details[open] summary::after{content:"\\2212"}
.faq details p{margin:0 0 18px;color:var(--ink-soft)}
.tags{display:flex;gap:10px;flex-wrap:wrap;margin:36px 0 0}
.tags a{border:1px solid var(--ink);padding:6px 12px;font:500 11px var(--mono);letter-spacing:.16em;text-transform:uppercase;transition:background .14s var(--ease),color .14s var(--ease)}
.tags a:hover{background:var(--ink);color:var(--canvas)}
.share{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);padding:18px 0;margin-top:40px;color:var(--ink-soft)}
.share .x{display:flex;gap:22px}
.share a:hover{color:var(--ember-ink)}
.disc{max-width:720px;margin:0 auto;padding:24px 32px 0;font-size:12px;line-height:1.5;color:var(--ink-soft)}
.more{padding:80px 0 72px}
.more .head{display:flex;justify-content:space-between;align-items:end;gap:16px;flex-wrap:wrap;margin-bottom:28px}
.more h2,.index h1{font-size:32px;margin:6px 0 0}
.cards{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--ink);border-left:1px solid var(--ink)}
.card{background:var(--canvas);border-right:1px solid var(--ink);border-bottom:1px solid var(--ink);padding:22px;display:flex;flex-direction:column;gap:14px;min-height:300px;transition:background .3s var(--ease)}
.card:hover{background:var(--vellum)}
.card .thumb{height:140px;background:var(--stage);position:relative;overflow:hidden}
.card .thumb img{width:100%;height:100%;object-fit:cover;display:block}
.card .thumb.empty::before{content:"";position:absolute;inset:0;background:radial-gradient(70% 90% at 50% 120%,rgba(255,120,23,.35),transparent 70%)}
.card .k{color:var(--ember-ink)}
.card h3{font-size:19px;margin:0;letter-spacing:-.022em;line-height:1.2;font-weight:500}
.card p{margin:0;color:var(--ink-soft);font-size:14px;line-height:1.45;flex:1}
.card .f{display:flex;justify-content:space-between;color:var(--ink-soft);font-size:12px}
.index{padding:56px 0 24px}
.index p.lead{color:var(--ink-soft);font-size:17px;max-width:60ch;margin:14px 0 0}
.empty-state{border:1px solid var(--ink);padding:40px;text-align:center;color:var(--ink-soft);margin:40px 0 80px}
.pager{display:flex;justify-content:space-between;padding:28px 0 80px}
.cta{background:var(--stage);color:var(--vellum);padding:72px 32px;text-align:center;position:relative;overflow:hidden}
.cta::before{content:"";position:absolute;inset:0;background:radial-gradient(50% 60% at 50% 120%,rgba(255,120,23,.35),transparent 70%)}
.cta>*{position:relative}
.cta h2{font-size:36px;margin:0 0 12px}
.cta p{color:var(--pebble);margin:0 0 28px}
footer{background:var(--stage);color:var(--mist);padding:24px 32px;border-top:1px solid rgba(255,255,255,.1);display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:12px}
footer a:hover{color:var(--ember)}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media(max-width:820px){nav{padding:14px 16px}nav .links{display:none}.wrap,header.art,.hero,.body,.disc{padding-left:16px;padding-right:16px}h1{font-size:34px}.cards{grid-template-columns:1fr}.hero .img{height:240px}.more h2,.index h1{font-size:26px}}
`;

function layout(o: {
  title: string; description: string; canonical: string; publicUrl: string;
  ogImage?: string | null; ogType?: 'article' | 'website'; jsonLd?: unknown; body: string; nav: 'insights';
}) {
  const ld = o.jsonLd ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, '\\u003c')}</script>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(o.canonical)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#140402">
<meta property="og:site_name" content="Pantera GP">
<meta property="og:type" content="${o.ogType ?? 'website'}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(o.canonical)}">
${o.ogImage ? `<meta property="og:image" content="${esc(o.ogImage)}">\n<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
${ld}
</head>
<body>
<nav aria-label="Site">
  <a class="brand display" href="/">Pantera GP <i>///</i></a>
  <div class="links mono"><a href="/">Platform</a><a class="on" href="/blog" aria-current="page">Insights</a></div>
  <div class="right"><a class="mono" href="/#signin">Sign in</a><a class="btn-fill" href="/#register">Open an account</a></div>
</nav>
${o.body}
<section class="cta">
  <span class="mono" style="color:var(--ember)">Get this every week</span>
  <h2 class="display">The desk's view, in your inbox</h2>
  <p>Clients receive the weekly update automatically. Everyone else can open an account in a few minutes.</p>
  <a class="btn-fill" href="/#register">Open an account</a>
</section>
<footer class="mono"><span>Pantera GP ///</span><span><a href="/blog">Insights</a> · <a href="/">Platform</a> · © ${new Date().getUTCFullYear()} Pantera GP</span></footer>
</body>
</html>`;
}

function card(a: ArticleCard) {
  const kicker = a.tags[0] ?? 'Insights';
  return `<a class="card" href="/blog/${esc(a.slug)}">
  <div class="thumb${a.cover_url ? '' : ' empty'}">${a.cover_url ? `<img src="${esc(a.cover_url)}" alt="" loading="lazy">` : ''}</div>
  <span class="k mono">${esc(kicker)}</span>
  <h3>${esc(a.title)}</h3>
  <p>${esc(a.excerpt ?? '')}</p>
  <div class="f mono"><span><time datetime="${esc(a.published_at)}">${day(a.published_at)}</time></span><span>${a.read_minutes} min</span></div>
</a>`;
}

/** The Insights index: every live article, newest first, a page at a time. */
export function indexPage(o: { articles: ArticleCard[]; page: number; pages: number; publicUrl: string }) {
  const canonical = `${o.publicUrl}/blog${o.page > 1 ? `?page=${o.page}` : ''}`;
  const list = o.articles.length
    ? `<div class="cards">${o.articles.map(card).join('\n')}</div>`
    : '<div class="empty-state">Nothing published yet. The first article lands here.</div>';
  const pager = o.pages > 1 ? `<div class="pager mono">
  <span>${o.page > 1 ? `<a class="btn-line" href="/blog?page=${o.page - 1}">Newer</a>` : ''}</span>
  <span style="align-self:center;color:var(--ink-soft)">Page ${o.page} of ${o.pages}</span>
  <span>${o.page < o.pages ? `<a class="btn-line" href="/blog?page=${o.page + 1}">Older</a>` : ''}</span>
</div>` : '<div style="height:80px"></div>';
  return layout({
    title: 'Insights — Pantera GP',
    description: 'Market commentary and platform notes from the Pantera GP desk.',
    canonical, publicUrl: o.publicUrl, nav: 'insights',
    body: `<main class="wrap">
  <div class="index">
    <span class="mono" style="color:var(--ember-ink)">Insights</span>
    <h1 class="display">What the desk is reading</h1>
    <p class="lead">Market commentary and platform notes, written for the people who trade here. A new piece most days.</p>
  </div>
  ${list}
  ${pager}
</main>`,
  });
}

function faqBlock(faq: Faq[]) {
  if (!faq.length) return '';
  return `<section class="faq">
  <span class="k mono">Questions</span>
  <h2 class="display">Frequently asked</h2>
  ${faq.map((f) => `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`).join('\n')}
</section>`;
}

/** One article, with three more underneath it. */
export function articlePage(o: { article: Article; more: ArticleCard[]; publicUrl: string }) {
  const a = o.article;
  const canonical = `${o.publicUrl}/blog/${a.slug}`;
  const kicker = a.tags[0] ?? 'Insights';
  const takeaways = a.key_takeaways.length
    ? `<aside class="takeaways"><span class="k mono">Key takeaways</span><ol>${a.key_takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></aside>`
    : '';
  const share = `mailto:?subject=${encodeURIComponent(a.title)}&body=${encodeURIComponent(canonical)}`;
  return layout({
    title: a.meta_title ?? a.title,
    description: a.meta_description ?? a.excerpt ?? a.title,
    canonical, publicUrl: o.publicUrl, nav: 'insights',
    ogImage: a.og_image_url ?? a.cover_url, ogType: 'article', jsonLd: a.json_ld,
    body: `<div class="wrap crumb mono"><a href="/blog">Insights</a><span class="sep">/</span><span>${esc(kicker)}</span></div>
<article>
<header class="art">
  <div class="eyebrow mono"><span>${esc(kicker)}</span><span><time datetime="${esc(a.published_at)}">${day(a.published_at)}</time></span><span>${a.read_minutes} min read</span></div>
  <h1 class="display">${esc(a.title)}</h1>
  ${a.excerpt ? `<p class="stand">${esc(a.excerpt)}</p>` : ''}
  <div class="byline"><span class="avatar" aria-hidden="true">PG</span><span><strong>${BYLINE}</strong>${revised(a) ? ` · Updated <time datetime="${esc(a.updated_at!)}">${day(a.updated_at!)}</time>` : ''}</span></div>
</header>
<div class="hero">
  <div class="img${a.cover_url ? '' : ' empty'}">${a.cover_url ? `<img src="${esc(a.cover_url)}" alt="">` : ''}</div>
</div>
<div class="body" style="counter-reset:sec">
  ${takeaways}
  ${a.html}
  ${faqBlock(a.faq)}
  ${a.tags.length ? `<div class="tags">${a.tags.map((t) => `<a href="/blog?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : ''}
  <div class="share mono"><span>Share this article</span><div class="x">
    <a href="https://x.com/intent/tweet?url=${encodeURIComponent(canonical)}&text=${encodeURIComponent(a.title)}" rel="noopener" target="_blank">X</a>
    <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(canonical)}" rel="noopener" target="_blank">LinkedIn</a>
    <a href="${esc(share)}">Email</a>
  </div></div>
</div>
</article>
<p class="disc">${DISCLAIMER}</p>
${o.more.length ? `<section class="wrap more">
  <div class="head"><div><span class="mono" style="color:var(--ember-ink)">More from Insights</span><h2 class="display">Recent articles</h2></div><a class="btn-line" href="/blog">All articles</a></div>
  <div class="cards">${o.more.map(card).join('\n')}</div>
</section>` : '<div style="height:60px"></div>'}`,
  });
}

/** Every live article, for search engines. */
export function sitemap(o: { publicUrl: string; articles: Pick<Article, 'slug' | 'published_at' | 'updated_at'>[] }) {
  const urls = [
    `<url><loc>${esc(o.publicUrl)}/</loc></url>`,
    `<url><loc>${esc(o.publicUrl)}/blog</loc><changefreq>daily</changefreq></url>`,
    ...o.articles.map((a) => `<url><loc>${esc(o.publicUrl)}/blog/${esc(a.slug)}</loc><lastmod>${esc((a.updated_at ?? a.published_at).slice(0, 10))}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
