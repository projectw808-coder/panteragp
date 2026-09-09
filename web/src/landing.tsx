import { useEffect, useRef, useState } from 'react';

/**
 * The public front of the site.
 *
 * Structure and motion follow the reference the client gave (altiuslabs.xyz): a dark
 * centred hero over a warm glow, marquee strips drifting in opposite directions, a
 * problem statement, numbered capability blocks revealed on scroll, and a closing band.
 * Palette and type stay on the PanteraAI tokens rather than the reference's.
 *
 * The copy is original. It describes this platform and claims nothing about assets under
 * management, investors or a fund — see the note in the README.
 */

const CTA = 'inline-flex items-center gap-2 rounded-full bg-ember px-6 py-2.5 font-mono text-sm font-medium text-graphite transition-transform duration-200 hover:-translate-y-0.5 hover:brightness-95';
const CTA_GHOST = 'inline-flex items-center gap-2 rounded-full border border-ember/60 px-6 py-2.5 font-mono text-sm text-ember transition-colors duration-200 hover:border-ember hover:bg-ember/10';

/**
 * Reveal a block the first time it is scrolled into view, then stop watching it.
 *
 * The fallback timer matters more than the effect: a hidden or backgrounded tab does not
 * run IntersectionObserver callbacks, and this hides content until one arrives. Without
 * the timer a section can sit at opacity 0 for good — which is exactly what the reference
 * site does when its scroll triggers never fire.
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

const Kicker = ({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) => (
  <span className={`inline-block rounded-md border px-2 py-0.5 font-mono text-[11px] tracking-wide uppercase ${
    dark ? 'border-ember/50 text-ember' : 'border-ember text-ember'}`}>
    {children}
  </span>
);

// ------------------------------------------------------------------ marquee

const MARKETS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD', 'AUDUSD', 'USDCAD'];
const CAPABILITIES = ['MARKET', 'LIMIT', 'STOP', 'STOP-LIMIT', 'TRAILING STOP', 'TAKE PROFIT', 'RISK SIZING', 'MULTI-CURRENCY', 'PORTFOLIOS', 'AUDIT LOG'];

/** Two strips drifting opposite ways, as on the reference. Duplicated so the loop is seamless. */
function Marquee({ items, reverse = false }: { items: string[]; reverse?: boolean }) {
  const row = items.map((t) => (
    <span key={t} className="flex items-center gap-6 px-6 font-mono text-xs tracking-wide text-mist">
      {t}<span className="text-ember">/</span>
    </span>
  ));
  return (
    <div className="overflow-hidden py-3">
      <div className={`flex w-max ${reverse ? 'anim-drift-rev' : 'anim-drift'}`}>
        <div className="flex">{row}</div>
        <div className="flex" aria-hidden>{row}</div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- page

export function Landing({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  return (
    <div className="h-full overflow-auto bg-vellum">
      {/* ---------------------------------------------------------------- hero */}
      <section className="relative flex min-h-screen flex-col overflow-hidden bg-obsidian">
        <nav className="anim-fade relative z-10 flex items-center gap-6 px-8 py-6">
          <span className="font-display text-xl text-vellum">PanteraAI</span>
          <span className="font-mono text-xs text-mist">///</span>
          <div className="ml-auto flex items-center gap-3">
            <button onClick={onSignIn} className="font-mono text-sm text-mist transition-colors hover:text-vellum">Sign in</button>
            <button onClick={onRegister} className={CTA}>Open an account</button>
          </div>
        </nav>

        <div className="relative z-10 mx-auto flex w-full max-w-[900px] flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="anim-rise" style={{ animationDelay: '80ms' }}>
            <Kicker dark>Trading desk &amp; client system</Kicker>
          </div>
          <h1 className="mt-8 font-display text-5xl leading-[1.02] font-light tracking-tight text-vellum md:text-6xl lg:text-[72px]">
            {['Your desk.', 'Your book.'].map((line, i) => (
              <span key={line} className="anim-rise block" style={{ animationDelay: `${200 + i * 130}ms` }}>{line}</span>
            ))}
          </h1>
          <p className="anim-rise mt-8 max-w-2xl text-base leading-relaxed text-mist md:text-lg"
            style={{ animationDelay: '480ms' }}>
            Execution and the client relationship in one system. Charting, order types and a
            settlement engine on one side; funding, documents, compliance and the full client
            timeline on the other — with every change written to an immutable audit log.
          </p>
          <div className="anim-rise mt-10 flex flex-wrap justify-center gap-3" style={{ animationDelay: '620ms' }}>
            <button onClick={onRegister} className={CTA}>Open an account</button>
            <button onClick={onSignIn} className={CTA_GHOST}>Sign in to the desk</button>
          </div>
        </div>

        {/* Decorative glow rising from the foot of the hero — the reference's signature.
            A texture element, not a section background: the system's rule still holds. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-72">
          <div className="absolute inset-0 bg-[radial-gradient(60%_120%_at_50%_100%,rgba(255,120,23,0.35),transparent_70%)]" />
          <div className="absolute inset-x-0 bottom-0 flex h-full items-end gap-3 px-6 opacity-60">
            {[30, 58, 42, 74, 52, 88, 64, 96, 70, 84, 48, 66, 38, 60, 34].map((h, i) => (
              <div key={i} className="anim-grow flex-1 rounded-t-md bg-[linear-gradient(to_top,rgba(255,120,23,0.55),transparent)]"
                style={{ height: `${h}%`, animationDelay: `${600 + i * 50}ms` }} />
            ))}
          </div>
        </div>

        <div className="relative z-10 border-t border-white/10">
          <Marquee items={MARKETS} />
        </div>
      </section>

      {/* ------------------------------------------------------- the problem */}
      <section className="mx-auto max-w-[1000px] px-8 py-28 text-center">
        <Reveal>
          <Kicker>The problem</Kicker>
          <h2 className="mx-auto mt-6 max-w-3xl font-display text-4xl leading-tight font-light tracking-tight text-obsidian md:text-5xl">
            A trade without its client is half a record.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-slate-ink">
            Most desks run a trading system and a CRM that barely speak. Positions live in one,
            the person lives in the other, and the answer to "why did we approve that
            withdrawal?" lives in neither. Reconciling them is somebody's whole afternoon.
          </p>
        </Reveal>
      </section>

      {/* ------------------------------------------------------ the numbered set */}
      <section className="mx-auto max-w-[1200px] px-8 pb-28">
        <Reveal>
          <h2 className="max-w-3xl font-display text-4xl leading-tight font-light tracking-tight text-obsidian">
            One system, built as one thing
            <span className="text-ember"> ///</span>
          </h2>
        </Reveal>

        <div className="mt-14 space-y-[10px]">
          {[
            ['01', 'Own the whole record.',
              'Balances in any currency, crypto wallets, portfolios, orders, fills, funding, documents, tickets and notes — on one client timeline. Nothing to reconcile because nothing was ever split.'],
            ['02', 'Execution that keeps running.',
              'Market, limit, stop, stop-limit and trailing orders, positions priced continuously, risk-based sizing, and a settlement engine that fills resting orders whether or not anyone has the screen open.'],
            ['03', 'Auditable by construction.',
              'Every change to a client or a trade is written by a database trigger to an append-only log — not an updated-at column. Compliance flags, KYC review and withdrawal thresholds sit in the flow of work, not in a separate tool.'],
          ].map(([n, title, body], i) => (
            <Reveal key={n} delay={i * 90}>
              <div className="group grid gap-6 rounded-[20px] bg-bone p-8 transition-colors duration-300 hover:bg-pebble md:grid-cols-[auto_1fr] md:gap-12 md:p-10">
                <span className="font-mono text-sm text-ember">{n}</span>
                <div>
                  <h3 className="font-display text-3xl leading-tight font-light tracking-tight text-obsidian">{title}</h3>
                  <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-ink">{body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- closing */}
      <section className="relative overflow-hidden bg-obsidian">
        <div className="border-b border-white/10">
          <Marquee items={CAPABILITIES} reverse />
        </div>

        <Reveal>
          <div className="mx-auto max-w-[900px] px-8 py-28 text-center">
            <Kicker dark>Paper by default</Kicker>
            <h2 className="mt-6 font-display text-4xl leading-tight font-light tracking-tight text-vellum md:text-5xl">
              Simulated money, and nothing pretending otherwise
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-mist">
              Balances, wallets and fills are simulated end to end. There is no live funding
              path anywhere in the code — the separation is structural, not a setting you
              could switch by accident.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <button onClick={onRegister} className={CTA}>Open an account</button>
              <button onClick={onSignIn} className={CTA_GHOST}>Sign in</button>
            </div>
          </div>
        </Reveal>

        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 px-8 py-6 font-mono text-xs text-mist">
          <span className="text-vellum">PanteraAI</span>
          <span>Simulated trading. No real funds move.</span>
          <span className="ml-auto">© {new Date().getFullYear()}</span>
        </div>
      </section>
    </div>
  );
}
