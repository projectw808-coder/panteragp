import { useEffect, useRef, useState } from 'react';

/**
 * The public front of the site: what someone sees before they sign in.
 *
 * Built to the structure in DESIGN.md — dark full-bleed hero, hard cut to a white feature
 * grid, dark CTA band to close. The app itself lives behind "Launch app"; this page never
 * touches the API, so it renders for a visitor who has no account and no session.
 *
 * Motion is deliberately restrained: a staggered entrance on the hero, sections revealed
 * as they are reached, a ticker that drifts, and a chart that draws itself. One easing
 * curve throughout, and the whole lot collapses under prefers-reduced-motion (index.css).
 */

const CTA = 'inline-flex items-center gap-2 rounded-full bg-ember px-5 py-2 font-mono text-sm font-medium text-graphite transition-transform duration-200 hover:-translate-y-0.5 hover:brightness-95';
const CTA_GHOST = 'inline-flex items-center gap-2 rounded-full border border-mist/40 px-5 py-2 font-mono text-sm text-vellum transition-colors duration-200 hover:border-vellum';

/**
 * Reveal a block the first time it is scrolled into view, then stop watching it.
 *
 * The fallback timer matters more than the effect: a hidden or backgrounded tab does not
 * run IntersectionObserver callbacks, and this hides content until one arrives. Without
 * the timer, a section can stay at opacity 0 permanently — an invisible page is a far
 * worse failure than an unanimated one.
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

/** A section that fades up as you reach it. `delay` staggers siblings. */
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

/** The editorial kicker above a section heading — orange outline, never a filled pill. */
const Kicker = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-block rounded-md border border-ember px-2 py-0.5 text-xs font-medium text-ember">
    {children}
  </span>
);

// Prices drift on their own so the strip reads as live rather than as a picture of a strip.
const SYMBOLS = [
  ['BTCUSD', 64194.07], ['ETHUSD', 3113.95], ['EURUSD', 1.08516],
  ['GBPUSD', 1.27216], ['USDJPY', 151.348], ['XAUUSD', 2383.06],
] as const;

function Ticker() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, []);
  // Deterministic wander per symbol, so it moves without pretending to be real data.
  const row = SYMBOLS.map(([sym, base], i) => {
    const drift = Math.sin((tick + i * 7) / 3) * (base * 0.0004);
    const price = base + drift;
    const up = drift >= 0;
    return (
      <span key={sym} className="inline-flex items-center gap-2 px-6 font-mono text-xs">
        <span className="text-mist">{sym}</span>
        <span className="text-vellum tabular-nums">
          {price.toLocaleString(undefined, { minimumFractionDigits: base < 10 ? 5 : 2, maximumFractionDigits: base < 10 ? 5 : 2 })}
        </span>
        <span className={up ? 'text-up' : 'text-down'}>{up ? '▲' : '▼'}</span>
      </span>
    );
  });
  return (
    <div className="overflow-hidden border-y border-white/10 py-3">
      {/* Duplicated so the drift loops without a gap at the seam. */}
      <div className="anim-drift flex w-max whitespace-nowrap">
        <div className="flex">{row}</div>
        <div className="flex" aria-hidden>{row}</div>
      </div>
    </div>
  );
}

export function Landing({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  return (
    <div className="h-full overflow-auto bg-vellum">
      {/* ---------------------------------------------------------------- hero */}
      <section className="relative flex min-h-[80vh] flex-col bg-obsidian">
        <nav className="anim-fade flex items-center gap-6 px-8 py-6">
          <span className="font-display text-xl text-vellum">PanteraAI</span>
          <span className="font-mono text-xs text-mist">/// trading desk</span>
          <div className="ml-auto flex items-center gap-3">
            <button onClick={onSignIn} className="font-mono text-sm text-mist transition-colors hover:text-vellum">Sign in</button>
            <button onClick={onRegister} className={CTA}>Launch app</button>
          </div>
        </nav>

        <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col justify-center px-8 py-20">
          <div className="max-w-3xl">
            {/* Staggered by 120ms a step: the eye follows the order it should read in. */}
            <div className="anim-rise" style={{ animationDelay: '80ms' }}>
              <Kicker>Execution &amp; relationship, one system</Kicker>
            </div>
            <h1 className="mt-6 font-display text-5xl font-light leading-[0.95] tracking-tight text-vellum md:text-7xl lg:text-[80px]">
              {['Every trade is a', 'conversation you', 'already know'].map((line, i) => (
                <span key={line} className="anim-rise block" style={{ animationDelay: `${200 + i * 120}ms` }}>
                  {line}{i === 2 && <span className="text-ember"> ///</span>}
                </span>
              ))}
            </h1>
            <p className="anim-rise mt-8 max-w-xl text-base leading-relaxed text-mist" style={{ animationDelay: '620ms' }}>
              Charts, execution and the client record in one place. The desk sees the
              position and the person behind it — funding, documents, tickets and every
              decision, on one timeline.
            </p>
            <div className="anim-rise mt-10 flex flex-wrap gap-3" style={{ animationDelay: '740ms' }}>
              <button onClick={onRegister} className={CTA}>Open an account</button>
              <button onClick={onSignIn} className={CTA_GHOST}>Sign in</button>
            </div>
          </div>
        </div>

        {/* Abstract, diagrammatic, monochrome — the system's imagery rule. No photography. */}
        <div className="pointer-events-none absolute right-8 bottom-16 hidden h-64 w-[420px] items-end gap-1 opacity-40 lg:flex" aria-hidden>
          {[38, 62, 45, 78, 55, 90, 70, 96, 64, 84, 52, 74, 46, 68, 40].map((h, i) => (
            <div key={i} className="anim-grow flex-1 border-t border-mist/30"
              style={{ height: `${h}%`, animationDelay: `${700 + i * 45}ms` }}>
              <div className="mx-auto h-full w-px bg-mist/40" />
              <div className={`mx-auto -mt-[70%] h-[40%] w-full ${i % 3 === 0 ? 'bg-ember/70' : 'bg-mist/25'}`} />
            </div>
          ))}
        </div>

        <Ticker />
      </section>

      {/* Hard cut to white — no gradient between the two. */}
      <section className="mx-auto max-w-[1200px] px-8 py-20">
        <Reveal>
          <Kicker>What it does</Kicker>
          <h2 className="mt-5 max-w-2xl font-display text-4xl font-light leading-tight tracking-tight text-obsidian">
            A trading platform that remembers who it is trading for
          </h2>
        </Reveal>

        <div className="mt-10 grid gap-[10px] lg:grid-cols-[1.6fr_1fr]">
          <Reveal delay={80}>
            <Card
              title="The desk"
              body="Live charting with drawing tools and indicators, market, limit, stop and trailing orders, positions priced continuously, and an execution engine that keeps filling whether anyone is watching or not."
              figure={<Candles />}
            />
          </Reveal>
          <Reveal delay={160}>
            <Card
              title="Paper by default"
              body="Simulated money, simulated wallets, no live fund movement anywhere in the code. The separation is structural, not a setting."
              figure={<Gauge />}
            />
          </Reveal>
        </div>

        <div className="mt-[10px] grid gap-[10px] md:grid-cols-3">
          {[
            ['One client record', 'Balances in any currency, crypto wallets, portfolios, orders, fills, funding, documents, tickets and notes — on a single timeline the whole desk reads.'],
            ['Audited by the database', 'Every change to a client or a trade is written by a trigger to an append-only log. Not an updated-at column: an immutable record of who changed what.'],
            ['Compliance in the flow', 'KYC review, withdrawal thresholds and flags sit where the work happens, not in a separate tool nobody opens.'],
          ].map(([title, body], i) => (
            <Reveal key={title} delay={i * 90}>
              <Card title={title} body={body} />
            </Reveal>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------ CTA band */}
      <section className="bg-obsidian">
        <Reveal>
          <div className="mx-auto flex max-w-[1200px] flex-col items-start gap-8 px-8 py-20 md:flex-row md:items-center">
            <h2 className="flex-1 font-display text-4xl font-light leading-tight tracking-tight text-vellum">
              Open an account and place your first order in a minute
              <span className="text-ember"> ///</span>
            </h2>
            <div className="flex gap-3">
              <button onClick={onRegister} className={CTA}>Create account</button>
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

// ------------------------------------------------------------------- pieces

function Card({ title, body, figure }: { title: string; body: string; figure?: React.ReactNode }) {
  return (
    // Bone on the white canvas: the tonal step replaces the shadow the system forbids.
    // Hover lifts by a hair and deepens the tone — never a shadow.
    <div className="flex h-full flex-col rounded-[20px] bg-bone p-6 transition-all duration-300 hover:-translate-y-1 hover:bg-pebble md:p-8">
      <h3 className="font-display text-2xl font-light leading-tight tracking-tight text-obsidian">{title}</h3>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-slate-ink">{body}</p>
      {figure && <div className="mt-8">{figure}</div>}
    </div>
  );
}

/** Line-art candles in the neutral scale — informational, never decorative colour. */
const Candles = () => (
  <svg viewBox="0 0 320 90" className="h-24 w-full" aria-hidden>
    {[12, 30, 48, 66, 84, 102, 120, 138, 156, 174, 192, 210, 228, 246, 264, 282].map((x, i) => {
      const h = [30, 46, 38, 58, 44, 66, 52, 72, 60, 78, 54, 68, 46, 62, 40, 56][i];
      return (
        <g key={x} stroke="#71717a" fill="none" className="anim-grow" style={{ animationDelay: `${i * 55}ms` }}>
          <line x1={x} y1={88 - h - 8} x2={x} y2={88 - h + h * 0.9} />
          <rect x={x - 4} y={88 - h} width="8" height={h * 0.55} fill={i % 4 === 0 ? '#ff7817' : 'transparent'}
            stroke="#71717a" />
        </g>
      );
    })}
  </svg>
);

/** A long/short execution gauge, the diagram the design doc calls for. */
const Gauge = () => (
  <svg viewBox="0 0 200 110" className="h-24 w-full" aria-hidden>
    <path d="M20 95 A 80 80 0 0 1 180 95" fill="none" stroke="#a1a1aa" strokeWidth="1" />
    {/* The accent arc draws itself in, rather than simply appearing. */}
    <path d="M20 95 A 80 80 0 0 1 108 18" fill="none" stroke="#ff7817" strokeWidth="2"
      strokeDasharray="200" strokeDashoffset="200">
      <animate attributeName="stroke-dashoffset" from="200" to="0" dur="1.2s"
        begin="0.3s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1" keyTimes="0;1" />
    </path>
    <line x1="100" y1="95" x2="140" y2="42" stroke="#71717a" strokeWidth="1.5" />
    <circle cx="100" cy="95" r="3" fill="#71717a" />
    <text x="20" y="108" fontSize="9" fill="#71717a" fontFamily="monospace">SHORT</text>
    <text x="152" y="108" fontSize="9" fill="#71717a" fontFamily="monospace">LONG</text>
  </svg>
);
