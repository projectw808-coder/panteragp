/**
 * Articles that arrive from outside — today from bunzy, the content service that writes
 * and publishes posts for search — and are kept here so the site owns what it shows.
 *
 * The pure half of the integration: checking a delivery's signature, turning bunzy's
 * payload into a row, and cleaning the HTML before it is stored. No database, no HTTP —
 * the route in server.ts does those, which keeps this testable with nothing running.
 *
 * Why the HTML is cleaned at all: the pages render it straight into the document, and a
 * page that renders whatever a third party sends is a page whose safety is somebody else's
 * account settings. The service is trusted; its HTML still passes through an allow-list,
 * once, on the way in, so the pages can render it without thinking about it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// ------------------------------------------------------------------ signature

/**
 * True when `header` is the HMAC-SHA256 of `rawBody` under `secret`, as `sha256=<hex>`.
 *
 * Over the raw bytes, because that is what was signed: a re-serialised JSON body would
 * differ in key order or whitespace and never match. Compared in constant time so the
 * check does not leak how much of a guess was right. A missing secret matches nothing —
 * an unconfigured receiver must not become an open one.
 */
export function signatureMatches(rawBody: string | Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const received = Buffer.from(String(header).trim());
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** The bearer the service also sends: the same secret, compared the same way. */
export function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------------- payload

export type ArticleEvent = 'article.published' | 'article.updated' | 'article.unpublished';

export type Faq = { question: string; answer: string };

/** An article as the site stores it. Field names are the table's. */
export type Article = {
  slug: string;
  title: string;
  excerpt: string | null;
  html: string;
  markdown: string | null;
  cover_url: string | null;
  tags: string[];
  read_minutes: number;
  author_name: string | null;
  canonical_url: string | null;
  meta_title: string | null;
  meta_description: string | null;
  og_image_url: string | null;
  json_ld: unknown;
  key_takeaways: string[];
  faq: Faq[];
  published_at: string;
  updated_at: string | null;
};

export type Delivery = {
  event: ArticleEvent;
  delivery_id: string | null;
  timestamp: string | null;
  test: boolean;
  slug: string;
  /** Null for an unpublish, which carries the slug and nothing the site needs to keep. */
  article: Article | null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const url = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
};
const when = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** A slug is a path segment and nothing else. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Read a delivery. Throws with a plain message when the shape is not one the site can act
 * on, so the route can answer 400 with the reason and the service's delivery log shows it.
 */
export function parseDelivery(body: unknown): Delivery {
  if (!body || typeof body !== 'object') throw new Error('body is not an object');
  const b = body as Record<string, unknown>;
  const event = str(b.event_type);
  if (event !== 'article.published' && event !== 'article.updated' && event !== 'article.unpublished') {
    throw new Error(`unknown event_type ${JSON.stringify(b.event_type ?? null)}`);
  }
  const data = (b.data && typeof b.data === 'object' ? b.data : {}) as Record<string, unknown>;
  const a = (data.article && typeof data.article === 'object' ? data.article : null) as Record<string, unknown> | null;
  if (!a) throw new Error('data.article is missing');
  const slug = str(a.slug)?.toLowerCase() ?? null;
  if (!slug || !SLUG.test(slug) || slug.length > 200) throw new Error('data.article.slug is missing or not a slug');

  const base = { event: event as ArticleEvent, delivery_id: str(b.delivery_id), timestamp: when(b.timestamp), test: b.test === true, slug };
  if (event === 'article.unpublished') return { ...base, article: null };

  const title = str(a.title);
  if (!title) throw new Error('data.article.title is missing');
  const markdown = str(a.markdown);
  const rawHtml = str(a.html) ?? (markdown ? markdownToHtml(markdown) : null);
  if (!rawHtml) throw new Error('data.article has neither html nor markdown');
  const seo = (a.seo && typeof a.seo === 'object' ? a.seo : {}) as Record<string, unknown>;
  const author = (a.author && typeof a.author === 'object' ? a.author : {}) as Record<string, unknown>;
  const tags = Array.isArray(a.tags)
    ? a.tags.map((t) => (typeof t === 'string' ? t : (t as { name?: unknown })?.name)).map(str).filter((t): t is string => !!t).slice(0, 20)
    : [];
  const takeaways = Array.isArray(a.keyTakeaways) ? a.keyTakeaways.map(str).filter((t): t is string => !!t) : [];
  const faq: Faq[] = Array.isArray(a.faq)
    ? a.faq.flatMap((f) => {
      const q = str((f as { question?: unknown })?.question);
      const ans = str((f as { answer?: unknown })?.answer);
      return q && ans ? [{ question: q, answer: ans }] : [];
    })
    : [];
  const html = sanitizeHtml(rawHtml, { dropLeadingHeading: title });
  const minutes = Number(a.readingMinutes);
  return {
    ...base,
    article: {
      slug,
      title,
      excerpt: str(a.excerpt) ?? str(seo.metaDescription),
      html,
      markdown,
      cover_url: url(a.thumbnailUrl) ?? url(seo.ogImage),
      tags,
      read_minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : readMinutes(html),
      author_name: str(author.name),
      canonical_url: url(seo.canonicalUrl) ?? url(a.url),
      meta_title: str(seo.metaTitle),
      meta_description: str(seo.metaDescription),
      og_image_url: url(seo.ogImage) ?? url(a.thumbnailUrl),
      json_ld: seo.jsonLd && typeof seo.jsonLd === 'object' ? seo.jsonLd : null,
      key_takeaways: takeaways,
      faq,
      published_at: when(a.publishedAt) ?? when(b.timestamp) ?? new Date().toISOString(),
      updated_at: when(a.updatedAt),
    },
  };
}

/** Words over a reading pace, never under one minute. */
export function readMinutes(html: string): number {
  const words = html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

// ------------------------------------------------------------------ the HTML

export const escapeHtml = (s: string) => s
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Element -> the attributes it may keep. Anything not listed is dropped, tag and all. */
const ALLOWED: Record<string, readonly string[]> = {
  p: [], br: [], hr: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ['start'], li: [],
  strong: [], em: [], b: [], i: [], u: [], s: [], del: [], ins: [], mark: [], small: [], sup: [], sub: [],
  blockquote: ['cite'], code: [], pre: [], span: [], div: [],
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  figure: [], figcaption: [],
  table: [], thead: [], tbody: [], tfoot: [], tr: [], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
};
/** Elements whose content goes with them: a script's body is not prose. */
const GUTTED = ['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'form', 'textarea', 'select', 'button'];
/** Where a URL may point from a page on this site. Relative paths and anchors are fine. */
const SAFE_URL = /^(?:https?:|mailto:|tel:|\/(?!\/)|#|[^:/?#]+(?:[/?#]|$))/i;

/**
 * Keep the elements an article is made of and nothing else.
 *
 * Tags outside the list are removed and their text kept; the gutted ones lose their
 * content too. On the kept ones only the listed attributes survive, which is what
 * removes every `on*` handler and `style` without naming them, and a link or image
 * target has to be a web URL, a relative path or an anchor — no `javascript:` and no
 * `data:`. A heading that repeats the title is dropped, because the page already set it,
 * and any other h1 becomes an h2 so the page keeps one h1.
 */
export function sanitizeHtml(input: string, opts: { dropLeadingHeading?: string } = {}): string {
  let s = input.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  for (const tag of GUTTED) s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
  // One pass over every '<': a tag is rebuilt from its allow-list, and a '<' that starts
  // no tag is text and stays text in the browser too.
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*)>|<(?=[a-zA-Z/!?])/g, (whole, rawName?: string, rawAttrs?: string) => {
    if (!rawName) return '&lt;';
    let name = rawName.toLowerCase();
    if (name === 'h1') name = 'h2';
    const allowed = ALLOWED[name];
    if (!allowed) return '';
    if (whole.startsWith('</')) return `</${name}>`;
    const attrs: string[] = [];
    const re = /([a-zA-Z-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    for (let m = re.exec(rawAttrs ?? ''); m; m = re.exec(rawAttrs ?? '')) {
      const key = m[1]!.toLowerCase();
      if (!allowed.includes(key)) continue;
      const value = (m[2] ?? m[3] ?? m[4] ?? '').trim();
      if ((key === 'href' || key === 'src' || key === 'cite') && !SAFE_URL.test(value)) continue;
      attrs.push(`${key}="${escapeHtml(value)}"`);
    }
    if (name === 'a' && attrs.some((x) => x.startsWith('href="http'))) attrs.push('rel="noopener"');
    const selfClosing = name === 'br' || name === 'hr' || name === 'img';
    return `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClosing ? ' /' : ''}>`;
  });
  if (opts.dropLeadingHeading) {
    const m = /^\s*<h2>([\s\S]*?)<\/h2>/.exec(s);
    const same = m && m[1]!.replace(/<[^>]*>/g, '').trim().toLowerCase() === opts.dropLeadingHeading.trim().toLowerCase();
    if (same) s = s.slice(m![0].length);
  }
  return s.trim();
}

/**
 * The small markdown an article needs, for a delivery that carries only that half. bunzy
 * sends both, so this is the fallback and stays deliberately plain: headings, paragraphs,
 * lists, quotes, emphasis, code and links. The result goes through sanitizeHtml like any
 * other HTML, so nothing here has to be careful about anything but escaping text.
 */
export function markdownToHtml(md: string): string {
  const inline = (t: string) => escapeHtml(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  const blocks = md.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const h = /^(#{1,6})\s+(.+)$/.exec(block);
    if (h) return `<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`;
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    if (lines.every((l) => /^\s*>\s?/.test(l))) return `<blockquote><p>${inline(lines.map((l) => l.replace(/^\s*>\s?/, '')).join(' '))}</p></blockquote>`;
    if (/^```/.test(block)) return `<pre><code>${escapeHtml(block.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, ''))}</code></pre>`;
    return `<p>${inline(lines.join(' '))}</p>`;
  }).join('\n');
}
