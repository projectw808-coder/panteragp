import { useEffect, useRef } from 'react';

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

/** Small uppercase mono label above a section — the reference's eyebrow. */
const Eyebrow = ({ children, onDark = false }: { children: React.ReactNode; onDark?: boolean }) => (
  <span className={`font-mono text-[11px] tracking-[0.18em] uppercase ${onDark ? 'text-ember' : 'text-ember'}`}>
    {children}
  </span>
);

const MARKETS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD', 'AUDUSD', 'USDCAD'];
const CAPABILITIES = ['MARKET', 'LIMIT', 'STOP', 'STOP-LIMIT', 'TRAILING STOP', 'TAKE PROFIT',
  'RISK SIZING', 'MULTI-CURRENCY', 'PORTFOLIOS', 'AUDIT LOG', 'KYC REVIEW', 'SETTLEMENT'];

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
  return (
    <div className="landing h-full overflow-auto">
      {/* ---------------------------------------------------------------- hero */}
      <section className="stage relative flex min-h-screen flex-col overflow-hidden">
        <nav className="anim-fade relative z-10 flex items-center gap-4 px-8 py-6">
          <span className="display text-lg text-vellum">PanteraAI</span>
          <span className="font-mono text-xs text-ember">///</span>
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
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-80">
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
          <h2 className="display mx-auto mt-6 max-w-3xl text-[34px] sm:text-[44px]">
            A trade without its client is half a record.
          </h2>
          <p className="soft mx-auto mt-6 max-w-2xl text-base leading-relaxed">
            Most desks run a trading system and a CRM that barely speak. Positions live in one,
            the person lives in the other, and the answer to “why did we approve that
            withdrawal?” lives in neither.
          </p>
        </Reveal>
      </section>

      {/* -------------------------------------------------- numbered capabilities */}
      <section className="mx-auto max-w-[1100px] px-8 pb-28">
        <Reveal>
          <h2 className="display max-w-3xl text-[34px] sm:text-[44px]">
            One system, built as one thing<span className="text-ember">.</span>
          </h2>
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
              <div className="grid gap-5 py-10 transition-colors duration-300 hover:bg-black/[0.03] md:grid-cols-[80px_1fr] md:gap-12">
                <span className="font-mono text-sm text-ember">{n}</span>
                <div>
                  <h3 className="display text-[26px] sm:text-[32px]">{title}</h3>
                  <p className="soft mt-4 max-w-2xl text-base leading-relaxed">{body}</p>
                </div>
              </div>
            </Reveal>
          ))}
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

        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 px-8 py-6 font-mono text-xs text-mist">
          <span className="text-vellum">PanteraAI</span>
          <span>Simulated trading. No real funds move.</span>
          <span className="ml-auto">© {new Date().getFullYear()}</span>
        </div>
      </section>
    </div>
  );
}
