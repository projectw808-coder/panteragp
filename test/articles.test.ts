import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { bearerMatches, markdownToHtml, parseDelivery, readMinutes, sanitizeHtml, signatureMatches } from '../src/articles.ts';
import { articlePage, indexPage, sitemap } from '../src/blog-page.ts';

const SECRET = 'whsec_test_0123456789';
const sign = (body: string, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

/** The example from bunzy's own integration page, verbatim in shape. */
const delivery = (over: Record<string, unknown> = {}, article: Record<string, unknown> = {}) => ({
  event_type: 'article.published',
  timestamp: '2026-08-13T09:30:00.000Z',
  delivery_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  test: false,
  data: {
    article: {
      slug: 'how-to-build-backlinks',
      title: 'How to Build Backlinks That Actually Move Rankings',
      excerpt: 'A practical walkthrough of the four link types worth chasing.',
      markdown: '# How to Build Backlinks\n\nBuilding high-quality...',
      html: '<h1>How to Build Backlinks That Actually Move Rankings</h1><p>Building high-quality...</p>',
      url: 'https://pntgp.xyz/blog/how-to-build-backlinks',
      tags: ['seo', 'link building'],
      readingMinutes: 7,
      thumbnailUrl: 'https://cdn.bunzy.io/covers/how-to-build-backlinks.jpg',
      author: { name: 'Jane Doe', avatarUrl: 'x', link: 'y' },
      publishedAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T09:29:58.000Z',
      keyTakeaways: ['Editorial links outperform directory links.'],
      faq: [{ question: 'How long do backlinks take?', answer: 'Typically 4–12 weeks.' }],
      seo: {
        metaTitle: 'How to Build Backlinks That Actually Move Rankings',
        metaDescription: 'A practical walkthrough of the four link types worth chasing.',
        canonicalUrl: 'https://pntgp.xyz/blog/how-to-build-backlinks',
        ogImage: 'https://cdn.bunzy.io/covers/how-to-build-backlinks.jpg',
        jsonLd: { '@context': 'https://schema.org', '@type': 'BlogPosting' },
      },
      ...article,
    },
  },
  ...over,
});

describe('the signature', () => {
  it('matches the HMAC of the exact bytes, and nothing else', () => {
    const body = JSON.stringify(delivery());
    assert.ok(signatureMatches(body, sign(body), SECRET));
    assert.ok(!signatureMatches(body + ' ', sign(body), SECRET), 'a re-serialised body is a different body');
    assert.ok(!signatureMatches(body, sign(body, 'other'), SECRET));
    assert.ok(!signatureMatches(body, sign(body).slice(0, -1), SECRET), 'a truncated digest is not a prefix match');
  });
  it('matches nothing when the secret or the header is missing', () => {
    const body = '{}';
    assert.ok(!signatureMatches(body, sign(body), undefined), 'an unconfigured receiver admits nobody');
    assert.ok(!signatureMatches(body, undefined, SECRET));
    assert.ok(!signatureMatches(body, '', SECRET));
  });
  it('checks the bearer the same way', () => {
    assert.ok(bearerMatches(`Bearer ${SECRET}`, SECRET));
    assert.ok(bearerMatches(`bearer ${SECRET}`, SECRET));
    assert.ok(!bearerMatches(`Bearer ${SECRET}x`, SECRET));
    assert.ok(!bearerMatches(SECRET, SECRET), 'a bare secret is not a bearer');
    assert.ok(!bearerMatches(`Bearer ${SECRET}`, undefined));
  });
});

describe('reading a delivery', () => {
  it('maps the documented shape onto the row', () => {
    const d = parseDelivery(delivery());
    assert.equal(d.event, 'article.published');
    assert.equal(d.delivery_id, '7c9e6679-7425-40de-944b-e07fc1f90ae7');
    assert.equal(d.test, false);
    const a = d.article!;
    assert.equal(a.slug, 'how-to-build-backlinks');
    assert.equal(a.excerpt, 'A practical walkthrough of the four link types worth chasing.');
    assert.equal(a.html, '<p>Building high-quality...</p>', 'the title heading is dropped: the page sets it');
    assert.deepEqual(a.tags, ['seo', 'link building']);
    assert.equal(a.read_minutes, 7);
    assert.equal(a.cover_url, 'https://cdn.bunzy.io/covers/how-to-build-backlinks.jpg');
    assert.equal(a.author_name, 'Jane Doe');
    assert.equal(a.canonical_url, 'https://pntgp.xyz/blog/how-to-build-backlinks');
    assert.deepEqual(a.json_ld, { '@context': 'https://schema.org', '@type': 'BlogPosting' });
    assert.deepEqual(a.key_takeaways, ['Editorial links outperform directory links.']);
    assert.equal(a.faq.length, 1);
    assert.equal(a.published_at, '2026-08-13T00:00:00.000Z');
    assert.equal(a.updated_at, '2026-08-13T09:29:58.000Z');
  });
  it('flags the Test button and reads an unpublish without an article body', () => {
    assert.equal(parseDelivery(delivery({ test: true })).test, true);
    const gone = parseDelivery({ event_type: 'article.unpublished', data: { article: { slug: 'sample-post' } } });
    assert.equal(gone.event, 'article.unpublished');
    assert.equal(gone.slug, 'sample-post');
    assert.equal(gone.article, null);
  });
  it('refuses what it cannot act on, by name', () => {
    assert.throws(() => parseDelivery(delivery({ event_type: 'article.liked' })), /unknown event_type/);
    assert.throws(() => parseDelivery(delivery({}, { slug: '../etc/passwd' })), /not a slug/);
    assert.throws(() => parseDelivery(delivery({}, { title: '' })), /title is missing/);
    assert.throws(() => parseDelivery(delivery({}, { html: '', markdown: '' })), /neither html nor markdown/);
    assert.throws(() => parseDelivery('nope'), /not an object/);
  });
  it('falls back to the markdown, to a computed reading time, and to the delivery time', () => {
    const d = parseDelivery(delivery({ timestamp: '2026-09-01T10:00:00Z' }, {
      html: undefined, readingMinutes: undefined, publishedAt: undefined,
      markdown: '# Title\n\nOne **bold** point.\n\n- a\n- b',
    }));
    assert.equal(d.article!.html, '<h2>Title</h2>\n<p>One <strong>bold</strong> point.</p>\n<ul><li>a</li><li>b</li></ul>');
    assert.equal(d.article!.read_minutes, 1);
    assert.equal(d.article!.published_at, '2026-09-01T10:00:00.000Z');
  });
  it('keeps only web URLs for pictures and links', () => {
    const d = parseDelivery(delivery({}, { thumbnailUrl: 'javascript:alert(1)', seo: { ogImage: 'data:image/png;base64,AAAA' } }));
    assert.equal(d.article!.cover_url, null);
    assert.equal(d.article!.og_image_url, null);
  });
});

describe('the HTML on its way in', () => {
  it('keeps prose and drops scripts, handlers and unsafe targets', () => {
    const dirty = `<p onclick="x()" style="color:red">Hi <a href="javascript:alert(1)">bad</a> <a href="https://a.b/c" target="_blank">ok</a></p>
<script>steal()</script><style>p{}</style><iframe src="https://evil"></iframe>
<img src="https://cdn/x.png" alt="pic" onerror="x()"><form><input></form><!-- note -->`;
    const clean = sanitizeHtml(dirty);
    // The javascript: link keeps its text and loses its target; an anchor without an href is inert.
    assert.equal(clean, '<p>Hi <a>bad</a> <a href="https://a.b/c" rel="noopener">ok</a></p>\n\n<img src="https://cdn/x.png" alt="pic" />');
  });
  it('turns a stray angle bracket into text and keeps one h1 for the page', () => {
    assert.equal(sanitizeHtml('<h1>Top</h1><p>1 <b 2</p>'), '<h2>Top</h2><p>1 &lt;b 2</p>');
    assert.equal(sanitizeHtml('<h1>Top</h1><p>x</p>', { dropLeadingHeading: 'top' }), '<p>x</p>');
    assert.equal(sanitizeHtml('<h1>Other</h1><p>x</p>', { dropLeadingHeading: 'top' }), '<h2>Other</h2><p>x</p>');
  });
  it('keeps tables, code and figures, which articles are made of', () => {
    const s = '<table><tr><th colspan="2">a</th></tr><tr><td>b</td></tr></table><pre><code>x &lt; y</code></pre><figure><img src="/p.png"><figcaption>c</figcaption></figure>';
    assert.equal(sanitizeHtml(s), '<table><tr><th colspan="2">a</th></tr><tr><td>b</td></tr></table><pre><code>x &lt; y</code></pre><figure><img src="/p.png" /><figcaption>c</figcaption></figure>');
  });
  it('estimates a reading time from the words', () => {
    assert.equal(readMinutes('<p>' + 'word '.repeat(660) + '</p>'), 3);
    assert.equal(readMinutes('<p>short</p>'), 1);
  });
  it('renders the small markdown', () => {
    assert.equal(markdownToHtml('> quoted\n> lines'), '<blockquote><p>quoted lines</p></blockquote>');
    assert.equal(markdownToHtml('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
    assert.equal(markdownToHtml('see [it](https://x.y) `now`'), '<p>see <a href="https://x.y">it</a> <code>now</code></p>');
    assert.equal(markdownToHtml('a <b> & c'), '<p>a &lt;b&gt; &amp; c</p>');
  });
});

describe('the pages', () => {
  const a = parseDelivery(delivery()).article!;
  const card = { slug: 'other', title: 'Other <post>', excerpt: null, cover_url: null, tags: [], read_minutes: 2, published_at: '2026-08-01T00:00:00.000Z' };
  it('carry the article, its metadata and the byline, with the text escaped', () => {
    const page = articlePage({ article: { ...a, title: 'Gold & the "dollar"' }, more: [card], publicUrl: 'https://www.pntgp.xyz' });
    assert.match(page, /<title>How to Build Backlinks That Actually Move Rankings<\/title>/, 'the meta title wins');
    assert.match(page, /<h1 class="display">Gold &amp; the &quot;dollar&quot;<\/h1>/);
    assert.match(page, /<link rel="canonical" href="https:\/\/www\.pntgp\.xyz\/blog\/how-to-build-backlinks">/);
    assert.match(page, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"BlogPosting"\}<\/script>/);
    assert.match(page, /Pantera GP Research/);
    assert.ok(!page.includes('Jane Doe'), 'the author from the service is never the byline');
    assert.match(page, /Key takeaways/);
    assert.match(page, /<summary>How long do backlinks take\?<\/summary>/);
    assert.match(page, /Other &lt;post&gt;/);
    assert.match(page, /property="og:image" content="https:\/\/cdn\.bunzy\.io\/covers\/how-to-build-backlinks\.jpg"/);
  });
  it('escape a script tag inside the JSON-LD so it cannot close the script', () => {
    const page = articlePage({ article: { ...a, json_ld: { x: '</script><script>alert(1)' } }, more: [], publicUrl: 'https://x' });
    assert.ok(!page.includes('</script><script>alert(1)'));
    assert.match(page, /\\u003c\/script>\\u003cscript>alert\(1\)/);
  });
  it('list the articles and say when there are none', () => {
    assert.match(indexPage({ articles: [card], page: 1, pages: 1, publicUrl: 'https://x' }), /href="\/blog\/other"/);
    assert.match(indexPage({ articles: [], page: 1, pages: 1, publicUrl: 'https://x' }), /Nothing published yet/);
    assert.match(indexPage({ articles: [card], page: 2, pages: 3, publicUrl: 'https://x' }), /href="\/blog\?page=3">Older/);
  });
  it('put every live article in the sitemap', () => {
    const xml = sitemap({ publicUrl: 'https://x', articles: [{ slug: 'a', published_at: '2026-08-13T00:00:00.000Z', updated_at: null }] });
    assert.match(xml, /<loc>https:\/\/x\/blog\/a<\/loc><lastmod>2026-08-13<\/lastmod>/);
  });
});
