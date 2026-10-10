import { useEffect, useRef, useState } from 'react';
import { useApi } from './api.ts';

/** The footer as the desk has set it from Settings; anything left out keeps the words here. */
type FooterView = {
  text?: string; column_title?: string; links?: { label: string; href: string }[]; line?: string; logo_url?: string | null;
  capabilities_title?: string; capabilities?: string[];
  marks_title?: string; marks?: { id: string; name: string; href?: string; url: string }[];
};
import { ShieldCheck } from 'lucide-react';

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
      <div className="display text-[40px] text-ember-ink tabular-nums sm:text-[52px]">
        {n.toLocaleString()}{suffix}
      </div>
      <div className="soft mt-2 font-mono text-[11px] tracking-[0.16em] uppercase">{label}</div>
    </div>
  );
}

/** Small uppercase mono label above a section — the reference's eyebrow. */
// No onDark any more: ember-as-text is a token that the dark hero redefines for itself.
const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[11px] tracking-[0.18em] text-ember-ink uppercase">
    {children}
  </span>
);

/**
 * Ported from panteraai.co.uk's "Simulation Live" widget — same state machine, layout,
 * motion and copy (joy-auto-trade: src/routes/index.tsx's Dashboard, 2026-09-27), then
 * trimmed to just the chart on this page's request: no crypto-pair trade feed, a calmer
 * walk, and the daily change capped rather than left to wander past a number that would
 * read as a real return. Classes changed from that project's `bg-primary`/`eyebrow`/
 * `signal` Tailwind theme to this one's `.sim-terminal` scope in index.css, because the two
 * projects don't share a Tailwind config — the colours those classes resolve to are the
 * same oklch values either way.
 */
const SIM_START_VALUE = 184392.64;
const SIM_DAILY_PCT_CAP = 57;

function simSeedPoints() {
  const pts: number[] = [];
  let v = SIM_START_VALUE * 0.985;
  for (let i = 0; i < 60; i++) { v += (Math.random() - 0.42) * 90; pts.push(v); }
  pts[pts.length - 1] = SIM_START_VALUE;
  return pts;
}

function SimTerminal() {
  const [points, setPoints] = useState<number[]>(() => Array.from({ length: 60 }, (_, i) => SIM_START_VALUE * 0.985 + i * 16));
  const [running, setRunning] = useState(true);
  const [clock, setClock] = useState('--:--:--');
  const [stats, setStats] = useState({ wins: 0, total: 0 });

  useEffect(() => { setPoints(simSeedPoints()); }, []);

  useEffect(() => {
    if (!running) return;
    let tick = 0;
    const id = setInterval(() => {
      tick++;
      setClock(new Date().toISOString().slice(11, 19));
      setPoints((p) => {
        const last = p[p.length - 1]!;
        const next = last + (Math.random() - 0.46) * 90;
        return [...p.slice(1), next];
      });
      if (tick % 3 === 0) {
        setStats((s) => ({ wins: s.wins + (Math.random() < 0.68 ? 1 : 0), total: s.total + 1 }));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  const value = points[points.length - 1]!;
  const rawChange = value - SIM_START_VALUE + 2841.2;
  const rawPct = (rawChange / SIM_START_VALUE) * 100;
  const pct = Math.max(-SIM_DAILY_PCT_CAP, Math.min(rawPct, SIM_DAILY_PCT_CAP));
  const change = (pct / 100) * SIM_START_VALUE;
  const min = Math.min(...points), max = Math.max(...points);
  const coords: [number, number][] = points.map((v, i): [number, number] => [(i / (points.length - 1)) * 760, 220 - ((v - min) / (max - min || 1)) * 190]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const lastY = coords[coords.length - 1]![1];
  const winRate = stats.total ? ((stats.wins / stats.total) * 100).toFixed(1) : '68.4';
  const up = change >= 0;

  const reset = () => { setPoints(simSeedPoints()); setStats({ wins: 0, total: 0 }); setRunning(true); };

  return (
    <div className="sim-terminal relative mx-auto w-full max-w-none overflow-hidden">
      <div className="flex h-12 items-center justify-between border-b border-[color:var(--st-border)] px-4 sm:px-6">
        <div className="flex items-center gap-2 text-xs text-[color:var(--st-muted-foreground)]">
          <span className={`size-2 rounded-full ${running ? 'bg-[color:var(--st-success)] animate-pulse' : 'bg-[color:var(--st-muted-foreground)]'}`} />
          {running ? 'SIMULATION LIVE' : 'SIMULATION PAUSED'}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setRunning((r) => !r)} className="border border-[color:var(--st-border)] px-2.5 py-1 font-mono text-[10px] text-[color:var(--st-foreground)] transition-colors hover:border-[color:var(--st-primary)] hover:text-[color:var(--st-primary)]">
            {running ? '❚❚ PAUSE' : '▶ RUN'}
          </button>
          <button onClick={reset} className="border border-[color:var(--st-border)] px-2.5 py-1 font-mono text-[10px] text-[color:var(--st-muted-foreground)] transition-colors hover:border-[color:var(--st-primary)] hover:text-[color:var(--st-primary)]">↺ RESET</button>
          <span className="hidden font-mono text-[10px] text-[color:var(--st-muted-foreground)] sm:inline">UTC {clock}</span>
        </div>
      </div>
      <div className="p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="st-eyebrow">Portfolio value · simulated</p>
            <p className="mt-2 font-mono text-3xl text-[color:var(--st-foreground)] tabular-nums sm:text-4xl">£{value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
          <div className="text-right">
            <p className="st-eyebrow">Today</p>
            <p className={`mt-2 font-mono text-sm tabular-nums ${up ? 'text-[color:var(--st-success)]' : 'text-[color:var(--st-danger)]'}`}>
              {up ? '+' : '-'}£{Math.abs(change).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}&nbsp; / &nbsp;{up ? '+' : ''}{pct.toFixed(2)}%
            </p>
          </div>
        </div>
        <div className="relative mt-8 h-48 overflow-hidden border-y border-[color:var(--st-border)]/70 sm:h-64">
          <div className="st-chart-grid absolute inset-0" />
          <svg viewBox="0 0 760 240" className="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="sim-terminal-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--st-primary)" stopOpacity=".24" />
                <stop offset="1" stopColor="var(--st-primary)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`${line} L760 240 L0 240Z`} fill="url(#sim-terminal-fill)" style={{ transition: 'd 0.9s linear' }} />
            <path d={line} fill="none" stroke="var(--st-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" style={{ transition: 'd 0.9s linear' }} />
          </svg>
          <span className="absolute right-3 bg-[color:var(--st-primary)] px-2 py-1 font-mono text-[10px] text-[color:var(--st-primary-foreground)] transition-all duration-700" style={{ top: `calc(${(lastY / 240) * 100}% - 12px)` }}>
            £{Math.round(value).toLocaleString('en-US')}
          </span>
        </div>
        <div className="mt-5 grid grid-cols-3 divide-x divide-[color:var(--st-border)] border border-[color:var(--st-border)]">
          {[['ACTIVE', '3 strategies'], ['WIN RATE', `${winRate}%`], ['TRADES', `${stats.total} executed`]].map(([label, v]) => (
            <div key={label} className="px-3 py-4 sm:px-5">
              <p className="st-eyebrow">{label}</p>
              <p className="mt-2 font-mono text-xs text-[color:var(--st-foreground)] tabular-nums sm:text-sm">{v}</p>
            </div>
          ))}
        </div>
        <div className="mt-5 border border-[color:var(--st-primary)]/30 bg-[color:var(--st-primary)]/5 p-4">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[color:var(--st-primary)]" />
            <p className="text-xs leading-5 text-[color:var(--st-muted-foreground)]">Risk guard active. Simulated data for illustration only — not real trades.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

const MARKETS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD', 'AUDUSD', 'USDCAD'];
const CAPABILITIES = ['MARKET', 'LIMIT', 'STOP', 'STOP-LIMIT', 'TRAILING STOP', 'TAKE PROFIT',
  'RISK SIZING', 'MULTI-CURRENCY', 'PORTFOLIOS', 'AUDIT LOG', 'KYC REVIEW', 'SETTLEMENT'];

export function Landing({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const footer = useApi<FooterView>('/site-content/footer').data ?? {};
  // The footer's "what the engine takes" list: the desk's own when it has set one.
  const capabilities = footer.capabilities?.length ? footer.capabilities : CAPABILITIES;
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
            <span className="font-mono text-xs text-ember-ink">///</span>
          </button>
          {/* Set like the marks inside the product rather than like small grey body text.
              Contrast was never the problem — mist reads 7.82:1 on this ground — it was
              12px at almost no tracking, which looks faint whatever colour it is. */}
          <div className="ml-10 hidden items-center gap-9 xl:flex">
            {[['autotrader','Auto trader'],['platform','Services'],['engine','The engine'],['audiences','Who it is for'],['security','Security']].map(([id,label]) => (
              <button key={id} onClick={() => go(id)} className="nav-link focus-ring">
                {label}
              </button>
            ))}
            {/* A real link, not a scroll: the articles are served as their own pages. */}
            <a href="/blog" className="nav-link focus-ring">Insights</a>
          </div>
          <div className="ml-auto flex items-center gap-4">
            <button onClick={onSignIn} className="nav-link focus-ring">Sign in</button>
            <button onClick={onRegister} className="btn-fill font-mono">Open an account</button>
          </div>
        </nav>

        {/* pointer-events-none so this box's empty space (it's centred text in a wide
            flex-1 column, not a filled panel) doesn't sit on top of the bars below and
            swallow their hover — the buttons opt back in below, same as the bars do. */}
        <div className="pointer-events-none relative z-10 mx-auto flex w-full max-w-[880px] flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="anim-rise" style={{ animationDelay: '80ms' }}>
            <Eyebrow>Automated execution // client system</Eyebrow>
          </div>
          {/* Sans, medium weight, −0.045em: the reference's headline is one tight mass. */}
          <h1 className="display mt-7 text-[42px] text-vellum sm:text-[56px] lg:text-[68px]">
            <span className="anim-rise block" style={{ animationDelay: '200ms' }}>You set the levels.</span>
            <span className="anim-rise block" style={{ animationDelay: '330ms' }}>The engine waits.</span>
          </h1>
          <p className="anim-rise mt-7 max-w-xl text-base leading-relaxed text-ember-ink/90"
            style={{ animationDelay: '470ms' }}>
            Rest an order at a price and close the tab. A settlement engine prices every
            instrument continuously and fires your limits, stops and trailing exits the moment
            they trigger — server-side, with the client record and audit trail attached.
          </p>
          <div className="pointer-events-auto anim-rise mt-9 flex flex-wrap justify-center gap-3" style={{ animationDelay: '600ms' }}>
            <button onClick={onRegister} className="btn-line font-mono">Open an account</button>
            <button onClick={onSignIn} className="btn-fill font-mono">Sign in to the desk</button>
          </div>
        </div>

        {/* The signature: a warm glow rising from the foot of the hero, with bars growing
            out of it. Decorative texture, not a section background. The bars themselves
            take pointer events (their parent's pointer-events-none doesn't stop a child
            opting back in) so they can light up and rise under the cursor — everything
            else in here stays inert. */}
        <div ref={glow} aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-80 will-change-transform">
          <div className="absolute inset-0 bg-[radial-gradient(70%_130%_at_50%_100%,rgba(255,120,23,0.45),transparent_72%)]" />
          <div className="pointer-events-auto absolute inset-x-0 bottom-0 flex h-full items-end gap-2 px-4">
            {[26, 54, 38, 72, 48, 88, 60, 96, 66, 82, 44, 64, 34, 58, 30, 70, 40].map((h, i) => (
              <div key={i} className="anim-grow hero-bar flex-1 bg-[linear-gradient(to_top,rgba(255,120,23,0.6),transparent)]"
                style={{ height: `${h}%`, animationDelay: `${560 + i * 45}ms` }} />
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- the problem */}
      <section className="mx-auto max-w-[900px] px-8 py-28 text-center">
        <Reveal>
          <Eyebrow>The problem</Eyebrow>
          <MaskedHeading className="display mx-auto mt-6 max-w-3xl text-[34px] sm:text-[44px]"
            lines={['A position without its', 'counterparty is half a record.']} />
          <p className="soft mx-auto mt-6 max-w-2xl text-base leading-relaxed">
            Most desks run execution and relationship as separate stacks. State diverges, the two
            disagree, and the answer to “why was that withdrawal approved” exists in neither.
            Reconciliation becomes a job somebody does, instead of a thing the system makes
            unnecessary.
          </p>
        </Reveal>
      </section>

      {/* ------------------------------------------------------------- stats
          Every figure here is true of the platform, checkable in the codebase. A
          marketing number that cannot be verified is the one that gets quoted back. */}
      <section className="border-y border-black/10">
        <Reveal>
          <div className="mx-auto grid max-w-[1100px] grid-cols-2 divide-x divide-black/10 px-4 md:grid-cols-4">
            <Stat value={101} label="Instruments" />
            <Stat value={69} label="Crypto pairs" />
            <Stat value={22} label="ETFs" />
            <Stat value={168} label="Currencies" />
          </div>
        </Reveal>
      </section>

      {/* ------------------------------------------------------- charting preview
          The panteraai.co.uk "Simulation Live" chart, trimmed to just the graph. Dark
          "stage" ground like the other dark sections, so the terminal card doesn't sit on
          the light canvas it was designed to contrast against. */}
      <section className="stage border-y border-white/10">
        <div className="mx-auto max-w-[1100px] px-8 py-20">
          <Eyebrow>Charting</Eyebrow>
          <h2 className="display mt-6 max-w-2xl text-[28px] text-vellum sm:text-[34px]">
            The shape of the real thing.
          </h2>
          <div className="mt-8">
            <SimTerminal />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- the auto trader
          Every claim here is behaviour of the engine in src/server.ts and src/autotrader.ts:
          three strategies, real orders on the book, risk per trade against the stop, stops
          and targets attached, the switch and the kill switch. No performance figure and no
          promise of profit: a record is a record, and the note says so. */}
      <section id="autotrader" className="stage scroll-mt-20 border-b border-white/10">
        <div className="mx-auto max-w-[1100px] px-8 py-24">
          <Reveal>
            <Eyebrow>Auto trading algorithm // developed in-house</Eyebrow>
            <MaskedHeading className="display mt-6 max-w-3xl text-[34px] text-vellum sm:text-[44px]"
              lines={['Switch it on.', 'The algorithm does the rest.']} />
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-mist">
              Our own auto trader reads every instrument every ten seconds, places a real order on
              your account when a setup appears, sizes it against your risk, attaches its stop and
              target, and leaves when its rules say so — around the clock, whether or not you are
              looking. You keep the switch.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-[10px] md:grid-cols-3">
            {[
              ['Grid', 'Buys a set step below the recent average and sells a step above, taking each level back to the average. Patient by design: it waits for the price to come back.'],
              ['Mean reversion', 'Fades a stretch. When price runs more than one and a half standard deviations from its average, it takes the other side and exits at the average.'],
              ['Trend follower', 'A moving-average crossover: long while the fast average sits above the slow one, short while it sits below, out when they cross back.'],
            ].map(([title, body], i) => (
              <Reveal key={title} delay={i * 80}>
                <div className="h-full border border-white/10 p-8 transition-colors duration-300 hover:border-ember">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-xs text-ember-ink">{String(i + 1).padStart(2, '0')}</span>
                    <h3 className="display text-[22px] text-vellum">{title}</h3>
                  </div>
                  <p className="mt-4 text-base leading-relaxed text-mist">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <div className="mt-[10px] grid gap-[10px] md:grid-cols-2">
            {[
              ['Risk before anything else', 'One percent of the bot\'s equity per trade by default, measured against the stop. Every entry carries its stop and target from the first fill, a loser is cut at half its risk, and the day limits halt new entries when they are reached.'],
              ['Your hand stays on the switch', 'Pause one strategy, change what it may deploy, or switch the trader off; open positions keep their stops and targets. The kill switch closes everything, cancels everything and stops. Every use of it is on your record.'],
            ].map(([title, body], i) => (
              <Reveal key={title} delay={240 + i * 80}>
                <div className="h-full border border-white/10 p-8">
                  <h3 className="display text-[22px] text-vellum">{title}</h3>
                  <p className="mt-4 text-base leading-relaxed text-mist">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={400}>
            <div className="mt-10 flex flex-wrap items-center justify-between gap-6">
              <p className="max-w-3xl font-mono text-xs leading-relaxed text-mist">
                <span className="text-ember-ink">NOTE //</span> a rules-based engine, not a promise. It can
                lose, it can lose several times in a row, and a record of past results is no guide to the
                next one. Read the risk warning before you switch it on.
              </p>
              <button onClick={onRegister} className="btn-fill font-mono">Open an account</button>
            </div>
          </Reveal>
        </div>
      </section>

      {/* -------------------------------------------------- the other services, numbered */}
      <section id="platform" className="mx-auto max-w-[1100px] scroll-mt-20 px-8 pt-24 pb-28">
        <Reveal>
          <Eyebrow>Our services</Eyebrow>
          <MaskedHeading className="display mt-6 max-w-3xl text-[34px] sm:text-[44px]"
            lines={['Everything else the desk', 'does for you.']} />
        </Reveal>

        <div className="mt-14 divide-y divide-black/10 border-y border-black/10">
          {[
            ['01', 'The trading terminal.',
              'Live charts with drawing tools and indicators, every order type — market, limit, stop, stop-limit, trailing — with take-profit and stop-loss attached, and position sizing against the risk you set.'],
            ['02', 'Offerings.',
              'A shelf of fixed-return offerings, each with its rate, term, minimum and allocation shown up front. Subscribe through a window, accrue daily, and settle at maturity.'],
            ['03', 'Portfolios and staking.',
              'Managed portfolios that accrue interest every day, and staking products on ETH, BTC, SOL and the stablecoins — flexible, or locked for a higher rate.'],
            ['04', 'Wallets and currencies.',
              'Balances in 168 currencies and crypto wallets side by side, with exchange between them at the desk\'s rate, and a connected MetaMask read in your own browser.'],
            ['05', 'The desk behind it.',
              'A named team on your account: support from the Support page, document review for verification, and a weekly update written by Pantera GP Research.'],
          ].map(([n, title, body], i) => (
            <Reveal key={n} delay={i * 90}>
              <div className="row-rule grid gap-5 py-10 transition-colors duration-300 hover:bg-black/[0.03] md:grid-cols-[80px_1fr] md:gap-12">
                <span className="font-mono text-sm text-ember-ink">{n}</span>
                <div>
                  <h3 className="display flex items-center gap-3 text-[26px] sm:text-[32px]">
                    {title}
                    <span className="row-arrow font-mono text-lg text-ember-ink" aria-hidden>→</span>
                  </h3>
                  <p className="soft mt-4 max-w-2xl text-base leading-relaxed">{body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* --------------------------------------------------------- the engine
          Every claim in this section is behaviour that exists: see settle() and
          startTicker() in src/server.ts. It describes order automation, not a
          strategy engine; the auto trader has its own section above. */}
      <section id="engine" className="stage scroll-mt-20 border-t border-white/10">
        <div className="mx-auto max-w-[1100px] px-8 py-24">
          <Reveal>
            <Eyebrow>The engine</Eyebrow>
            <MaskedHeading className="display mt-6 max-w-3xl text-[34px] text-vellum sm:text-[44px]"
              lines={['Your orders keep working', 'after you close the tab.']} />
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-mist">
              Resting orders live on the server, not in your browser. A settlement pass prices
              every instrument on each tick and acts the moment a level trades — whether or not
              anyone is connected.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-[10px] md:grid-cols-2">
            {[
              ['Limit and stop', 'Set the price you want. The engine watches every tick and fills when the market reaches it — no manual monitoring, no missed level while you were away.'],
              ['Stop-limit', 'Two conditions, one order: the stop arms it, the limit caps what you will pay. It fills only if both hold, so a gap does not fill you at any price.'],
              ['Trailing stop', 'The stop ratchets behind the price as it moves your way and never loosens. Profit follows the move up; the exit stays where it was if the move reverses.'],
              ['Attached exits', 'Take-profit and stop-loss ride with the position from the moment it opens. Whichever trades first closes it, so a position is never left unprotected.'],
            ].map(([title, body], i) => (
              <Reveal key={title} delay={i * 80}>
                <div className="h-full border border-white/10 p-8 transition-colors duration-300 hover:border-ember">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-xs text-ember-ink">{String(i + 1).padStart(2, '0')}</span>
                    <h3 className="display text-[22px] text-vellum">{title}</h3>
                  </div>
                  <p className="mt-4 text-base leading-relaxed text-mist">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={120}>
            <div className="mt-[10px] border border-white/10 p-8">
              <h3 className="display text-[22px] text-vellum">Sized against your risk, not your nerve</h3>
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-mist">
                Give the ticket a stop and the percentage of the balance you are willing to lose,
                and it works out the position size for you — capped by your available margin, and
                rounded down so it never overshoots. The arithmetic is done before the order
                exists rather than after the loss does.
              </p>
            </div>
          </Reveal>

          <Reveal delay={160}>
            <p className="mt-8 max-w-3xl font-mono text-xs leading-relaxed text-mist">
              <span className="text-ember-ink">NOTE //</span> this automates the orders you place. It
              is not a strategy engine and does not trade on your behalf — nothing here opens a
              position you did not ask for.
            </p>
          </Reveal>
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
            ['Fund and size a position', 'Balances arrive in any of 168 currencies, or a crypto wallet. Set a stop and the ticket sizes the position against your risk.'],
            ['Place the order', 'Market, limit, stop, stop-limit or trailing. Resting orders are filled by a settlement engine that runs whether or not your screen is open.'],
          ].map(([title, body], i) => (
            <Reveal key={title} delay={i * 90}>
              <div className="border-t border-ember pt-6">
                <span className="font-mono text-xs text-ember-ink">STEP {String(i + 1).padStart(2, '0')}</span>
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
            <Eyebrow>Security &amp; audit</Eyebrow>
            <MaskedHeading className="display mt-6 max-w-3xl text-[34px] text-vellum sm:text-[44px]"
              lines={['The database keeps', 'the receipts.']} />
          </Reveal>
          <div className="mt-12 grid gap-[10px] md:grid-cols-2">
            {[
              ['Append-only audit log', 'A trigger on every mutable table writes each insert, update and delete to a log that cannot be edited or deleted — enforced in the database, not in application code that could be bypassed.'],
              ['Role-based access', 'Sales, support, compliance and admin each see exactly what their role permits. Roles are read from the row on every request, so revoking access takes effect immediately rather than when a token expires.'],
              ['Passwords never in the clear', 'Hashed with scrypt and a per-account salt. The audit log strips the hash from both sides of every diff, so credentials never reach it.'],
              ['Isolated by construction', 'Client funds, positions and documents are separated at the database level rather than by application code that could be bypassed. Each role reaches only what its permission allows.'],
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

      {/* ------------------------------------------------------------- closing */}
      <section className="stage relative overflow-hidden border-t border-white/10">
        <Reveal>
          <div className="mx-auto max-w-[860px] px-8 py-28 text-center">
            <Eyebrow>Paper by default</Eyebrow>
            <h2 className="display mt-6 text-[34px] text-vellum sm:text-[44px]">
              Open an account and place your first order
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-mist">
              Name, email, password, and you are in the terminal — charts, the full order
              book of instruments, and a client record that starts as yours from the first
              login.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <button onClick={onRegister} className="btn-line font-mono">Open an account</button>
              <button onClick={onSignIn} className="btn-fill font-mono">Sign in</button>
            </div>
          </div>
        </Reveal>

        {/* Footer: columns of real destinations only. Nothing here links to a page that
            does not exist — a dead "Careers" link is worse than no link. */}
        <div className="border-t border-white/10">
          <div className="mx-auto grid max-w-[1100px] gap-10 px-8 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div>
              <div className="flex items-center gap-2">
                {footer.logo_url
                  ? <img src={footer.logo_url} alt="Pantera GP" className="h-8 w-auto" />
                  : <>
                    <span className="display text-lg text-vellum">Pantera GP</span>
                    <span className="font-mono text-xs text-ember-ink">///</span>
                  </>}
              </div>
              <p className="mt-4 max-w-xs text-sm leading-relaxed text-mist">
                {footer.text?.trim() || 'A trading desk and a client system, built as one thing. Orders rest with the engine rather than in an open tab, and every fill, decision and document is written down against the account it belongs to.'}
              </p>

              {/* Two real figures, not a row of numbers chosen to look substantial. The
                  instrument count is the list this page is built from; the order types are
                  the OrderType union in src/trading.ts — market, limit, stop, stop-limit
                  and trailing stop. Take profit is a field on an order, not a sixth type. */}
              <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
                {[[String(MARKETS.length), 'instruments'], ['5', 'order types']].map(([n, label]) => (
                  <div key={label}>
                    <dt className="font-mono text-lg text-vellum tabular-nums">{n}</dt>
                    <dd className="mt-0.5 font-mono text-[10px] tracking-[0.16em] text-mist uppercase">{label}</dd>
                  </div>
                ))}
              </dl>
            </div>
            {[
              ['Platform', [['Auto trader', 'autotrader'], ['Services', 'platform'], ['The engine', 'engine'], ['How it works', 'how']]],
              ['Trust', [['Security & audit', 'security'], ['Insights', '/blog'], ['Back to top', 'top']]],
              [footer.column_title?.trim() || 'Legal', footer.links?.length
                ? footer.links.map((l) => [l.label, l.href])
                : [['Terms of Service', '/terms'], ['Privacy Policy', '/privacy'], ['Risk warning', '/risk'], ['Contact', '/contact']]],
            ].map(([heading, links]) => (
              <div key={heading as string}>
                <h4 className="font-mono text-[11px] tracking-[0.16em] text-vellum uppercase">{heading as string}</h4>
                <ul className="mt-4 space-y-2">
                  {(links as [string, string][]).map(([label, id]) => (
                    <li key={id}>
                      {/^(\/|https?:|mailto:)/.test(id)
                        ? <a href={id} className="text-sm text-mist transition-colors hover:text-ember-ink">{label}</a>
                        : <button onClick={() => go(id)} className="text-sm text-mist transition-colors hover:text-ember-ink">{label}</button>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div>
              <h4 className="font-mono text-[11px] tracking-[0.16em] text-vellum uppercase">Account</h4>
              <ul className="mt-4 space-y-2">
                <li><button onClick={onRegister} className="text-sm text-mist transition-colors hover:text-ember-ink">Open an account</button></li>
                <li><button onClick={onSignIn} className="text-sm text-mist transition-colors hover:text-ember-ink">Sign in</button></li>
              </ul>
              <p className="mt-4 max-w-[22ch] text-xs leading-relaxed text-mist/80">
                Name, email and a password. You land in the terminal signed in, with nothing
                to configure first.
              </p>
            </div>
          </div>

          {/* What the engine actually takes, listed once, still enough to be read. */}
          <div className="mx-auto max-w-[1100px] border-t border-white/10 px-8 py-6">
            <h4 className="font-mono text-[11px] tracking-[0.16em] text-vellum uppercase">{footer.capabilities_title?.trim() || 'What the engine takes'}</h4>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
              {capabilities.map((c) => (
                <li key={c} className="font-mono text-[11px] tracking-[0.12em] text-mist">{c}</li>
              ))}
            </ul>
          </div>

          {/* The row of company marks the desk put up from Settings; nothing when there are none. */}
          {!!footer.marks?.length && (
            <div className="mx-auto max-w-[1100px] border-t border-white/10 px-8 py-6">
              {!!footer.marks_title?.trim() && (
                <h4 className="mb-5 font-mono text-[11px] tracking-[0.16em] text-vellum uppercase">{footer.marks_title.trim()}</h4>
              )}
              <ul className="flex flex-wrap items-center gap-x-10 gap-y-5">
                {footer.marks.map((m) => {
                  const img = <img src={m.url} alt={m.name} loading="lazy" className="h-7 w-auto opacity-75 transition-opacity duration-200 hover:opacity-100" />;
                  return (
                    <li key={m.id}>
                      {m.href ? <a href={m.href} rel={/^https?:/.test(m.href) ? 'noopener' : undefined} title={m.name}>{img}</a> : img}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 px-8 py-6 font-mono text-[11px] text-mist/85">
            <span className="ml-auto">{footer.line?.trim() || `© ${new Date().getFullYear()} Pantera GP`}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
