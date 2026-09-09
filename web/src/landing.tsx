import { useEffect, useRef, useState } from 'react';

/**
 * The public front of the site.
 *
 * Visual language follows the reference the client chose (altiuslabs.xyz): a dark centred
 * hero over a warm glow, a sans display face at very tight tracking, square-cornered
 * outline buttons, marquee strips drifting in opposite directions, numbered capability
 * blocks revealed on scroll, and a lavender-white body. The surface tokens for all of that
 * live under `.landing` in index.css, scoped so the product UI keeps its own system.
 *
 * The copy is original: it describes this platform and claims nothing about a fund,
 * investors or assets under management.
 */

/**
 * Reveal a block the first time it is scrolled into view, then stop watching it.
 *
 * The fallback timer matters more than the effect: a hidden or backgrounded tab does not
 * run IntersectionObserver callbacks, and this hides content until one arrives. The
 * reference site shows the failure — its sections render blank when its scroll triggers
 * never fire — and an invisible page is far worse than an unanimated one.
 */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => { el.classList.add('shown'); io.disconnect(); clearTimeout(timer); };
    const io = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) show(); },
      { rootMargin: '0px 0px -12% 0px' });
    io.observe(el);
    const timer = setTimeout(show, 2500);
    return () => { io.disconnect(); clearTimeout(timer); };
  }, []);
  return ref;
}

function Reveal({ children, delay = 0, className = '' }: {
  children: React.ReactNode; delay?: number; className?: string;
}) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/** Headings whose lines slide up from behind their own edge, one after another. */
function MaskedHeading({ lines, className = '', delay = 0 }: {
  lines: string[]; className?: string; delay?: number;
}) {
  const ref = useReveal<HTMLHeadingElement>();
  return (
    <h2 ref={ref} className={className}>
      {lines.map((line, i) => (
        <span key={line} className="mask">
          <span style={{ transitionDelay: `${delay + i * 110}ms` }}>{line}</span>
        </span>
      ))}
    </h2>
  );
}

/**
 * Count a number up once it is on screen. Eased, so it decelerates into the final value
 * rather than arriving at a constant rate — a linear counter reads as a machine.
 */
function useCountUp(target: number, duration = 1400) {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setValue(target); return; }
    let raf = 0;
    const run = () => {
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        setValue(Math.round(target * (1 - Math.pow(1 - t, 3))));   // ease-out cubic
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { run(); io.disconnect(); } });
    io.observe(el);
    // Same reasoning as useReveal: a hidden tab never fires the observer.
    const timer = setTimeout(() => { io.disconnect(); run(); }, 2500);
    return () => { io.disconnect(); clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [target, duration]);
  return [value, ref] as const;
}

function Stat({ value, suffix = '', label }: { value: number; suffix?: string; label: string }) {
  const [n, ref] = useCountUp(value);
  return (
    <div ref={ref} className="px-6 py-8">
      <div className="display text-[40px] text-ember tabular-nums sm:text-[52px]">
        {n.toLocaleString()}{suffix}
      </div>
      <div className="soft mt-2 font-mono text-[11px] tracking-[0.16em] uppercase">{label}</div>
    </div>
  );
}

/** Small uppercase mono label above a section — the reference's eyebrow. */
const Eyebrow = ({ children, onDark = false }: { children: React.ReactNode; onDark?: boolean }) => (
  <span className={`font-mono text-[11px] tracking-[0.18em] uppercase ${onDark ? 'text-ember' : 'text-ember'}`}>
    {children}
  </span>
);

const MARKETS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD', 'AUDUSD', 'USDCAD'];
const CAPABILITIES = ['MARKET', 'LIMIT', 'STOP', 'STOP-LIMIT', 'TRAILING STOP', 'TAKE PROFIT',
  'RISK SIZING', 'MULTI-CURRENCY', 'PORTFOLIOS', 'AUDIT LOG', 'KYC REVIEW', 'SETTLEMENT'];

/** An accordion row. Height is animated via grid-template-rows, which needs no measuring. */
function Faq({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-black/10">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex w-full items-center gap-6 py-6 text-left transition-colors hover:text-ember">
        <span className="display flex-1 text-[19px] sm:text-[22px]">{q}</span>
        <span className={`font-mono text-xl text-ember transition-transform duration-300 ${open ? 'rotate-45' : ''}`}
          aria-hidden>+</span>
      </button>
      <div className="grid transition-[grid-template-rows] duration-400 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
        <div className="overflow-hidden">
          <p className="soft max-w-3xl pb-7 text-base leading-relaxed">{a}</p>
        </div>
      </div>
    </div>
  );
}

/** Two strips drifting opposite ways, 60s, as on the reference. Duplicated for a seamless loop. */
function Marquee({ items, reverse = false, onDark = false }: {
  items: string[]; reverse?: boolean; onDark?: boolean;
}) {
  const row = items.map((t) => (
    <span key={t} className={`flex items-center gap-8 px-8 font-mono text-xs tracking-[0.14em] ${onDark ? 'text-mist' : 'soft'}`}>
      {t}<span className="text-ember">/</span>
    </span>
  ));
  return (
    <div className="overflow-hidden py-4">
      <div className={`flex w-max ${reverse ? 'anim-drift-rev' : 'anim-drift'}`}>
        <div className="flex">{row}</div>
        <div className="flex" aria-hidden>{row}</div>
      </div>
    </div>
  );
}

export function Landing({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);

  /** Nav links scroll the container, not the window — the page scrolls inside a div. */
  const go = (id: string) => {
    const el = scroller.current?.querySelector(`#${id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Reading progress, and a slow parallax on the hero glow. Both read the same scroll
  // position and are written inside one rAF, so scrolling stays on one frame's work.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = el.scrollHeight - el.clientHeight;
        const pct = max > 0 ? el.scrollTop / max : 0;
        if (bar.current) bar.current.style.width = `${pct * 100}%`;
        // The glow drifts at a third of scroll speed, so the hero has depth as it leaves.
        if (glow.current) glow.current.style.transform = `translateY(${el.scrollTop * 0.32}px)`;
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => { el.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, []);

  return (
    <div ref={scroller} className="landing h-full overflow-auto">
      <div ref={bar} className="progress" style={{ width: 0 }} aria-hidden />
      {/* ---------------------------------------------------------------- hero */}
      <section id="top" className="stage relative flex min-h-screen flex-col overflow-hidden">
        <nav className="anim-fade sticky top-0 z-30 flex items-center gap-4 border-b border-white/10 bg-[color:var(--stage)]/85 px-8 py-4 backdrop-blur">
          <button onClick={() => go('top')} className="flex items-center gap-2">
            <span className="display text-lg text-vellum">Pantera GP</span>
            <span className="font-mono text-xs text-ember">///</span>
          </button>
          <div className="ml-8 hidden items-center gap-7 lg:flex">
            {[['platform','Platform'],['audiences','Who it is for'],['how','How it works'],['security','Security'],['faq','FAQ']].map(([id,label]) => (
              <button key={id} onClick={() => go(id)}
                className="font-mono text-xs tracking-wide text-mist transition-colors hover:text-vellum">
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button onClick={onSignIn} className="font-mono text-sm text-mist transition-colors hover:text-vellum">
              Sign in
            </button>
            <button onClick={onRegister} className="btn-fill font-mono text-sm">Open an account</button>
          </div>
        </nav>

        <div className="relative z-10 mx-auto flex w-full max-w-[880px] flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="anim-rise" style={{ animationDelay: '80ms' }}>
            <Eyebrow onDark>Trading desk &amp; client system</Eyebrow>
          </div>
          {/* Sans, medium weight, −0.045em: the reference's headline is one tight mass. */}
          <h1 className="display mt-7 text-[42px] text-vellum sm:text-[56px] lg:text-[68px]">
            <span className="anim-rise block" style={{ animationDelay: '200ms' }}>Your Desk.</span>
            <span className="anim-rise block" style={{ animationDelay: '330ms' }}>Your Book.</span>
          </h1>
          <p className="anim-rise mt-7 max-w-xl text-base leading-relaxed text-ember/90"
            style={{ animationDelay: '470ms' }}>
            Execution and the client relationship in one system. Charting, order types and a
            settlement engine on one side; funding, documents, compliance and the whole client
            timeline on the other.
          </p>
          <div className="anim-rise mt-9 flex flex-wrap justify-center gap-3" style={{ animationDelay: '600ms' }}>
            <button onClick={onRegister} className="btn-line font-mono text-sm">Open an account</button>
            <button onClick={onSignIn} className="btn-fill font-mono text-sm">Sign in to the desk</button>
          </div>
        </div>

        {/* The signature: a warm glow rising from the foot of the hero, with bars growing
            out of it. Decorative texture, not a section background. */}
        <div ref={glow} aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-80 will-change-transform">
          <div className="absolute inset-0 bg-[radial-gradient(70%_130%_at_50%_100%,rgba(255,120,23,0.45),transparent_72%)]" />
          <div className="absolute inset-x-0 bottom-0 flex h-full items-end gap-2 px-4">
            {[26, 54, 38, 72, 48, 88, 60, 96, 66, 82, 44, 64, 34, 58, 30, 70, 40].map((h, i) => (
              <div key={i} className="anim-grow flex-1 bg-[linear-gradient(to_top,rgba(255,120,23,0.6),transparent)]"
                style={{ height: `${h}%`, animationDelay: `${560 + i * 45}ms` }} />
            ))}
          </div>
        </div>

        <div className="relative z-10 border-t border-white/10">
          <Marquee items={MARKETS} onDark />
        </div>
      </section>

      {/* ------------------------------------------------------- the problem */}
      <section className="mx-auto max-w-[900px] px-8 py-28 text-center">
        <Reveal>
          <Eyebrow>The problem</Eyebrow>
          <MaskedHeading className="display mx-auto mt-6 max-w-3xl text-[34px] sm:text-[44px]"
            lines={['A trade without its client', 'is half a record.']} />
          <p className="soft mx-auto mt-6 max-w-2xl text-base leading-relaxed">
            Most desks run a trading system and a CRM that barely speak. Positions live in one,
            the person lives in the other, and the answer to “why did we approve that
            withdrawal?” lives in neither.
          </p>
        </Reveal>
      </section>

      {/* ------------------------------------------------------------- stats
          Every figure here is true of the platform, checkable in the codebase. A
          marketing number that cannot be verified is the one that gets quoted back. */}
      <section className="border-y border-black/10">
        <Reveal>
          <div className="mx-auto grid max-w-[1100px] grid-cols-2 divide-x divide-black/10 px-4 md:grid-cols-4">
            <Stat value={5} label="Order types" />
            <Stat value={167} label="Currencies" />
            <Stat value={27} label="Audited tables" />
            <Stat value={0} label="Live money paths" />
          </div>
        </Reveal>
      </section>

      {/* -------------------------------------------------- numbered capabilities */}
      <section id="platform" className="mx-auto max-w-[1100px] scroll-mt-20 px-8 pb-28">
        <Reveal>
          <MaskedHeading className="display max-w-3xl text-[34px] sm:text-[44px]"
            lines={['One system,', 'built as one thing.']} />
        </Reveal>

        <div className="mt-14 divide-y divide-black/10 border-y border-black/10">
          {[
            ['01', 'Own the whole record.',
              'Balances in any currency, crypto wallets, portfolios, orders, fills, funding, documents, tickets and notes — on one client timeline. Nothing to reconcile, because nothing was ever split.'],
            ['02', 'Execution that keeps running.',
              'Market, limit, stop, stop-limit and trailing orders, positions priced continuously, risk-based sizing, and a settlement engine that fills resting orders whether or not anyone has the screen open.'],
            ['03', 'Auditable by construction.',
              'Every change to a client or a trade is written by a database trigger to an append-only log — not an updated-at column. Compliance flags, KYC review and withdrawal thresholds sit in the flow of work.'],
          ].map(([n, title, body], i) => (
            <Reveal key={n} delay={i * 90}>
              <div className="row-rule grid gap-5 py-10 transition-colors duration-300 hover:bg-black/[0.03] md:grid-cols-[80px_1fr] md:gap-12">
                <span className="font-mono text-sm text-ember">{n}</span>
                <div>
                  <h3 className="display flex items-center gap-3 text-[26px] sm:text-[32px]">
                    {title}
                    <span className="row-arrow font-mono text-lg text-ember" aria-hidden>→</span>
                  </h3>
                  <p className="soft mt-4 max-w-2xl text-base leading-relaxed">{body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------ audiences */}
      <section id="audiences" className="scroll-mt-20 border-t border-black/10 bg-black/[0.02]">
        <div className="mx-auto max-w-[1100px] px-8 py-24">
          <Reveal>
            <Eyebrow>Who it is for</Eyebrow>
            <MaskedHeading className="display mt-6 max-w-3xl text-[34px] sm:text-[44px]"
              lines={['Three jobs, one screen each.']} />
          </Reveal>
          <div className="mt-12 grid gap-[10px] md:grid-cols-3">
            {[
              ['Traders', 'A terminal with live charts, drawing tools, indicators and every order type, plus their own balances, wallets, portfolios and documents in the same place they trade.'],
              ['The desk', 'Sales and support open one client record and see holdings, open positions, funding requests, tickets and the whole timeline — without a second system to reconcile against.'],
              ['Compliance', 'KYC review with document uploads, withdrawal thresholds that flag automatically, and an append-only audit log that answers who changed what, and when.'],
            ].map(([title, body], i) => (
              <Reveal key={title} delay={i * 90}>
                <div className="h-full border border-black/10 bg-[color:var(--canvas)] p-8 transition-colors duration-300 hover:border-ember">
                  <h3 className="display text-[24px]">{title}</h3>
                  <p className="soft mt-4 text-base leading-relaxed">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- how it works */}
      <section id="how" className="mx-auto max-w-[1100px] scroll-mt-20 px-8 py-24">
        <Reveal>
          <Eyebrow>How it works</Eyebrow>
          <MaskedHeading className="display mt-6 max-w-3xl text-[34px] sm:text-[44px]"
            lines={['From sign-up to first fill,', 'in about a minute.']} />
        </Reveal>
        <div className="mt-12 grid gap-10 md:grid-cols-3">
          {[
            ['Open an account', 'Name, email, password. You land in the terminal signed in, on a paper account, with nothing to configure first.'],
            ['Fund and size a position', 'Balances arrive in any of 167 currencies, or a simulated crypto wallet. Set a stop and the ticket sizes the position against your risk.'],
            ['Place the order', 'Market, limit, stop, stop-limit or trailing. Resting orders are filled by a settlement engine that runs whether or not your screen is open.'],
          ].map(([title, body], i) => (
            <Reveal key={title} delay={i * 90}>
              <div className="border-t border-ember pt-6">
                <span className="font-mono text-xs text-ember">STEP {String(i + 1).padStart(2, '0')}</span>
                <h3 className="display mt-3 text-[24px]">{title}</h3>
                <p className="soft mt-3 text-base leading-relaxed">{body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------------------- security */}
      <section id="security" className="stage scroll-mt-20">
        <div className="mx-auto max-w-[1100px] px-8 py-24">
          <Reveal>
            <Eyebrow onDark>Security &amp; audit</Eyebrow>
            <MaskedHeading className="display mt-6 max-w-3xl text-[34px] text-vellum sm:text-[44px]"
              lines={['The database keeps', 'the receipts.']} />
          </Reveal>
          <div className="mt-12 grid gap-[10px] md:grid-cols-2">
            {[
              ['Append-only audit log', 'A trigger on every mutable table writes each insert, update and delete to a log that cannot be edited or deleted — enforced in the database, not in application code that could be bypassed.'],
              ['Role-based access', 'Sales, support, compliance and admin each see exactly what their role permits. Roles are read from the row on every request, so revoking access takes effect immediately rather than when a token expires.'],
              ['Passwords never in the clear', 'Hashed with scrypt and a per-account salt. The audit log strips the hash from both sides of every diff, so credentials never reach it.'],
              ['No live-money path', 'Balances, wallets and fills are simulated end to end. There is no code path that moves real funds — the separation is structural rather than a flag.'],
            ].map(([title, body], i) => (
              <Reveal key={title} delay={i * 80}>
                <div className="h-full border border-white/10 p-8 transition-colors duration-300 hover:border-ember">
                  <h3 className="display text-[22px] text-vellum">{title}</h3>
                  <p className="mt-4 text-base leading-relaxed text-mist">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------- faq */}
      <section id="faq" className="mx-auto max-w-[900px] scroll-mt-20 px-8 py-24">
        <Reveal>
          <Eyebrow>Questions</Eyebrow>
          <MaskedHeading className="display mt-6 text-[34px] sm:text-[44px]" lines={['Before you ask.']} />
        </Reveal>
        <div className="mt-10 border-t border-black/10">
          {[
            ['Is this real money?', 'No. Every balance, wallet and fill is simulated, and there is no live funding path anywhere in the code. You cannot deposit real funds, and nothing you do here moves any.'],
            ['What can I trade?', 'Foreign exchange, metals and crypto pairs, with market, limit, stop, stop-limit and trailing-stop orders, plus attached take-profit and stop-loss.'],
            ['Who can see my data?', 'Staff roles see what their permission allows and nothing more. Every access and change is recorded, and an internal note on a support ticket is never shown to the client it concerns.'],
            ['Can my password be reset?', 'You can change your own from Settings using your current password. An administrator can also set a new one — you are notified, and it lands on your timeline when they do.'],
            ['What happens to documents I upload?', 'KYC documents are stored against your client record and visible to reviewing staff. They are held on the platform and not shared with third parties.'],
          ].map(([q, a]) => <Faq key={q} q={q} a={a} />)}
        </div>
      </section>

      {/* ------------------------------------------------------------- closing */}
      <section className="stage relative overflow-hidden">
        <div className="border-b border-white/10">
          <Marquee items={CAPABILITIES} reverse onDark />
        </div>

        <Reveal>
          <div className="mx-auto max-w-[860px] px-8 py-28 text-center">
            <Eyebrow onDark>Paper by default</Eyebrow>
            <h2 className="display mt-6 text-[34px] text-vellum sm:text-[44px]">
              Simulated money, and nothing pretending otherwise
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-mist">
              Balances, wallets and fills are simulated end to end. There is no live funding
              path anywhere in the code — the separation is structural, not a setting you
              could switch by accident.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <button onClick={onRegister} className="btn-line font-mono text-sm">Open an account</button>
              <button onClick={onSignIn} className="btn-fill font-mono text-sm">Sign in</button>
            </div>
          </div>
        </Reveal>

        {/* Footer: columns of real destinations only. Nothing here links to a page that
            does not exist — a dead "Careers" link is worse than no link. */}
        <div className="border-t border-white/10">
          <div className="mx-auto grid max-w-[1100px] gap-10 px-8 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div>
              <div className="flex items-center gap-2">
                <span className="display text-lg text-vellum">Pantera GP</span>
                <span className="font-mono text-xs text-ember">///</span>
              </div>
              <p className="mt-4 max-w-xs text-sm leading-relaxed text-mist">
                A trading desk and a client system built as one thing, on a simulated book.
              </p>
            </div>
            {[
              ['Platform', [['Capabilities', 'platform'], ['Who it is for', 'audiences'], ['How it works', 'how']]],
              ['Trust', [['Security & audit', 'security'], ['Questions', 'faq']]],
            ].map(([heading, links]) => (
              <div key={heading as string}>
                <h4 className="font-mono text-[11px] tracking-[0.16em] text-vellum uppercase">{heading as string}</h4>
                <ul className="mt-4 space-y-2">
                  {(links as [string, string][]).map(([label, id]) => (
                    <li key={id}>
                      <button onClick={() => go(id)} className="text-sm text-mist transition-colors hover:text-ember">
                        {label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div>
              <h4 className="font-mono text-[11px] tracking-[0.16em] text-vellum uppercase">Account</h4>
              <ul className="mt-4 space-y-2">
                <li><button onClick={onRegister} className="text-sm text-mist transition-colors hover:text-ember">Open an account</button></li>
                <li><button onClick={onSignIn} className="text-sm text-mist transition-colors hover:text-ember">Sign in</button></li>
              </ul>
            </div>
          </div>

          <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 px-8 py-6 font-mono text-xs text-mist">
            <span>Simulated trading. No real funds move, and no real funds can be deposited.</span>
            <span className="ml-auto">© {new Date().getFullYear()} Pantera GP</span>
          </div>
        </div>
      </section>
    </div>
  );
}
