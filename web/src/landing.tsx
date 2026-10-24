import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, BarChart3, Box, Brain, ChartNoAxesCombined, Database, Globe2, Layers, Leaf, Play, Rocket,
  Settings2, ShieldCheck, Zap,
} from 'lucide-react';
import { useApi } from './api.ts';

/**
 * The public front of the site, built to the October 2026 mockup: a night-globe hero
 * with floating feature cards, a live price strip, the auto trader's record, the
 * platform's four services, its metrics, the offerings and a closing call to action,
 * then the footer the desk edits from Settings.
 *
 * Every figure on it is live and true. The prices are the platform's own quotes. The
 * auto trader panel reads the record of the one account the desk chooses in Settings,
 * labelled as the desk's demo account on this platform's prices. The counts are counts of real things. The previous version is
 * kept at the git tag pre-redesign-2026-10-24.
 */

/** The footer as the desk has set it from Settings; anything left out keeps the words here. */
type FooterView = {
  text?: string; column_title?: string; links?: { label: string; href: string }[]; line?: string; logo_url?: string | null;
  capabilities_title?: string; capabilities?: string[];
  marks_title?: string; marks?: { id: string; name: string; href?: string; url: string }[];
  notice?: string;
};
type Ticker = { instruments: number; quotes: { symbol: string; price: number; change_pct: number; spark: number[] }[] };
type Showcase = {
  configured: boolean; on?: boolean; since?: string | null;
  kpis?: {
    equity: number; allocated: number; return_pct: number | null; unrealised: number;
    today_net: number; today_trades: number; today_fees: number;
    wins: number; closed: number; win_rate: number | null;
    profit_factor: number | null; avg_win_r: number | null; avg_loss_r: number | null;
    max_drawdown: number; drawdown_at: string | null; open: number;
  };
  curve?: { at: string; equity: number }[];
  trades?: { closed_at: string; symbol: string; side: string; entry: number; exit: number; net: number; strategy: string | null }[];
  strategies?: { name: string; symbols: string[]; state: 'running' | 'paused' }[];
};

const CAPABILITIES = ['MARKET', 'LIMIT', 'STOP', 'STOP-LIMIT', 'TRAILING STOP', 'TAKE PROFIT',
  'RISK SIZING', 'MULTI-CURRENCY', 'PORTFOLIOS', 'AUDIT LOG', 'KYC REVIEW', 'SETTLEMENT'];

/** The footer notice as the desk pasted it: a blank line ends a paragraph, lines starting with -, * or • make a list. Same rules as the server's noticeBlocks. */
function noticeBlocks(text: string): { kind: 'p' | 'ul'; lines: string[] }[] {
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((lines) => lines.length)
    .map((lines) => (lines.every((l) => /^[-*•]\s+/.test(l)) ? { kind: 'ul', lines: lines.map((l) => l.replace(/^[-*•]\s+/, '')) } : { kind: 'p', lines }));
}

// ------------------------------------------------------------------ formatting
const usd = (n: number, digits = 2) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${usd(n)}`;
const pct = (f: number, digits = 0) => `${(f * 100).toFixed(digits)}%`;
const price = (p: number) => p.toLocaleString('en-US', { minimumFractionDigits: p < 10 ? 4 : 2, maximumFractionDigits: p < 10 ? 4 : 2 });
const shortDay = (iso: string | Date) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** Re-read a public endpoint every few seconds while the page is open. */
function usePolled<T>(path: string, everyMs: number) {
  const q = useApi<T>(path);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) q.reload(); }, everyMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, everyMs]);
  return q.data;
}

/**
 * Reveal a block the first time it is scrolled into view, then stop watching it. The
 * fallback timer matters: a hidden tab never fires IntersectionObserver, and an invisible
 * page is far worse than an unanimated one.
 */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => { el.classList.add('shown'); io.disconnect(); clearTimeout(timer); };
    const io = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) show(); }, { rootMargin: '0px 0px -8% 0px' });
    io.observe(el);
    const timer = setTimeout(show, 2500);
    return () => { io.disconnect(); clearTimeout(timer); };
  }, []);
  return ref;
}
function Reveal({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useReveal<HTMLDivElement>();
  return <div ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>{children}</div>;
}

// ------------------------------------------------------------------ small parts
/** The mark: a three-pronged node, drawn rather than imported so it takes the ember. */
export const LogoMark = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
    <path d="M5 6.5 L16 17 L27 6.5 M16 17 V27.5" stroke="var(--lp-ember)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="5" cy="6.5" r="2.6" fill="var(--lp-ember)" />
    <circle cx="27" cy="6.5" r="2.6" fill="var(--lp-ember)" />
    <circle cx="16" cy="27.5" r="2.6" fill="var(--lp-ember)" />
  </svg>
);
const Wordmark = () => (
  <span className="flex items-center gap-2.5">
    <LogoMark />
    <span className="text-[19px] font-semibold tracking-[-0.01em] text-white">Pantera GP</span>
    <span className="lp-slashes" aria-hidden>///</span>
  </span>
);

const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[12.5px] font-semibold tracking-[0.2em] text-[color:var(--lp-ember)] uppercase">{children}</p>
);

/** A day of hourly closes as a small line, green when the day is up and red when it is down. */
function Spark({ values, up, w = 52, h = 22 }: { values: number[]; up: boolean; w?: number; h?: number }) {
  const d = useMemo(() => {
    if (values.length < 2) return '';
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(' ');
  }, [values, w, h]);
  const col = up ? 'var(--lp-up)' : 'var(--lp-down)';
  const id = `sp-${up ? 'u' : 'd'}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="shrink-0">
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={col} stopOpacity="0.35" /><stop offset="1" stopColor={col} stopOpacity="0" /></linearGradient></defs>
      {d && <path d={`${d} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />}
      {d && <path d={d} stroke={col} strokeWidth="1.6" fill="none" />}
    </svg>
  );
}

/** Round marks for the strip's instruments, drawn so nothing is borrowed from anyone. */
function Coin({ symbol }: { symbol: string }) {
  const base = 'grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full';
  switch (symbol) {
    case 'BTCUSD': return <span className={`${base} bg-[#f7931a] text-[19px] font-bold text-white`}>₿</span>;
    case 'ETHUSD': return (
      <span className={`${base} bg-[#627eea]`}>
        <svg width="16" height="24" viewBox="0 0 16 24" aria-hidden><path d="M8 0 L16 12 L8 16.5 L0 12 Z" fill="#fff" fillOpacity=".95" /><path d="M8 18 L16 13.5 L8 24 L0 13.5 Z" fill="#fff" fillOpacity=".75" /></svg>
      </span>);
    case 'XAUUSD': return (
      <span className={`${base} bg-[#d79a1e]`}>
        <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden><path d="M4 7 L7 2 H15 L18 7 Z" fill="#fff6d8" /><path d="M1 14 L4 8.5 H10.5 L10.5 14 Z M11.5 14 V8.5 H18 L21 14 Z" fill="#fde7a8" /></svg>
      </span>);
    case 'XAGUSD': return <span className={`${base} bg-[#9aa3ad] text-[13px] font-bold text-white`}>Ag</span>;
    case 'EURUSD': return <span className={`${base} bg-[#1a6cf0] text-[19px] font-semibold text-white`}>€</span>;
    case 'GBPUSD': return <span className={`${base} bg-[#2a3f8f] text-[19px] font-semibold text-white`}>£</span>;
    case 'SPY': return <span className={`${base} bg-white text-[10.5px] font-bold text-[#0b0b0e]`}>S&amp;P</span>;
    case 'QQQ': return <span className={`${base} bg-[#e3262f] text-[17px] font-bold text-white`}>Q</span>;
    case 'SOLUSD': return <span className={`${base} bg-gradient-to-br from-[#9945ff] to-[#14f195] text-[15px] font-bold text-white`}>S</span>;
    case 'XRPUSD': return <span className={`${base} bg-[#23292f] text-[13px] font-bold text-white ring-1 ring-white/20`}>XRP</span>;
    default: return <span className={`${base} bg-white/10 text-[12px] font-bold text-white`}>{symbol.slice(0, 3)}</span>;
  }
}

// ------------------------------------------------------------------ the page
export function Landing({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const footer = useApi<FooterView>('/site-content/footer').data ?? {};
  const capabilities = footer.capabilities?.length ? footer.capabilities : CAPABILITIES;
  const ticker = usePolled<Ticker>('/public/ticker', 5000);
  const show = usePolled<Showcase>('/public/showcase', 20000);
  const [atFoot, setAtFoot] = useState(false);
  const [menu, setMenu] = useState(false);
  const NAV: [string, string][] = [['platform', 'Platform'], ['autotrader', 'Auto Trader'], ['portfolios', 'Portfolios'], ['staking', 'Staking'], ['ipo', 'IPO Opportunities'], ['about', 'About']];

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let was = false;
    const onScroll = () => {
      const foot = el.querySelector('#footer');
      const now = !!foot && foot.getBoundingClientRect().top < el.clientHeight;
      if (now !== was) { was = now; setAtFoot(now); }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  /** Nav links scroll the container, not the window — the page scrolls inside a div. */
  const go = (id: string) => scroller.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  /** The side arrow's slow glide to the footer and back; a wheel, touch or key takes over at once. */
  const glide = (id: string) => {
    const sc = scroller.current;
    const el = sc?.querySelector<HTMLElement>(`#${id}`);
    if (!sc || !el) return;
    const top = Math.min(el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop, sc.scrollHeight - sc.clientHeight);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { sc.scrollTo({ top }); setAtFoot(id === 'footer'); return; }
    const from = sc.scrollTop, distance = top - from;
    const duration = Math.min(distance < 0 ? 4800 : 5600, 700 + Math.abs(distance) * (distance < 0 ? 0.45 : 0.58));
    const start = performance.now();
    let frame = 0;
    const stop = () => { cancelAnimationFrame(frame); for (const ev of ['wheel', 'touchstart', 'keydown'] as const) sc.removeEventListener(ev, stop); };
    for (const ev of ['wheel', 'touchstart', 'keydown'] as const) sc.addEventListener(ev, stop, { passive: true });
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      sc.scrollTop = from + distance * ease(t);
      if (t < 1) frame = requestAnimationFrame(step); else { stop(); setAtFoot(id === 'footer'); }
    };
    frame = requestAnimationFrame(step);
  };

  const instruments = ticker?.instruments ?? 100;

  return (
    <div ref={scroller} className="landing lp h-full overflow-auto">
      {/* ------------------------------------------------------------ the bar */}
      <nav className="lp-bar sticky top-0 z-30">
        <div className="lp-wrap flex h-[70px] items-center gap-6">
          <button onClick={() => go('top')} aria-label="Pantera GP, back to the top" className="focus-ring rounded"><Wordmark /></button>
          <div className="ml-12 hidden items-center gap-[30px] xl:flex">
            {NAV.map(([id, label]) => (
              <button key={id} onClick={() => go(id)} className="lp-navlink focus-ring">{label}</button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button onClick={onSignIn} className="lp-btn lp-btn-dark hidden sm:inline-flex">Sign In</button>
            <button onClick={onRegister} className="lp-btn lp-btn-fill">Open Account <ArrowRight size={17} strokeWidth={2.2} aria-hidden /></button>
            <button type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="landing-menu" aria-label={menu ? 'Close the menu' : 'Open the menu'}
              className="focus-ring -mr-2 flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10 xl:hidden">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                {menu ? <path d="M4 4l12 12M16 4L4 16" /> : <path d="M3 5h14M3 10h14M3 15h14" />}
              </svg>
            </button>
          </div>
        </div>
        {menu && (
          <div id="landing-menu" className="absolute inset-x-0 top-full z-30 border-b border-white/10 bg-[#0b0b0e]/95 px-6 py-3 backdrop-blur xl:hidden">
            <ul className="flex flex-col">
              {NAV.map(([id, label]) => (
                <li key={id}><button onClick={() => { setMenu(false); go(id); }} className="lp-navlink focus-ring block w-full py-3 text-left">{label}</button></li>
              ))}
              <li><a href="/blog" className="lp-navlink focus-ring block w-full py-3 text-left">Insights</a></li>
              <li className="sm:hidden"><button onClick={() => { setMenu(false); onSignIn(); }} className="lp-navlink focus-ring block w-full py-3 text-left">Sign In</button></li>
            </ul>
          </div>
        )}
      </nav>

      {/* ------------------------------------------------------------ the hero */}
      <section id="top" className="lp-hero relative overflow-hidden">
        <div className="lp-wrap relative z-10 flex min-h-[520px] flex-col justify-center py-12">
          <div className="max-w-[640px]">
            <div className="anim-rise" style={{ animationDelay: '60ms' }}><Eyebrow>Powered by algorithmic execution</Eyebrow></div>
            <h1 className="anim-rise mt-4 text-[44px] leading-[1.05] font-bold tracking-[-0.02em] sm:text-[58px]" style={{ animationDelay: '160ms' }}>
              <span className="block text-white">Auto Trading</span>
              <span className="block text-[color:var(--lp-ember)]">for Real Opportunities</span>
            </h1>
            <p className="anim-rise mt-5 max-w-[560px] text-[18px] leading-[1.5] text-[color:var(--lp-soft)]" style={{ animationDelay: '260ms' }}>
              Automated strategies. Diversified portfolios. Global markets.<br className="hidden sm:inline" /> All in one secure platform.
            </p>
            <div className="anim-rise mt-9 flex flex-wrap gap-4" style={{ animationDelay: '360ms' }}>
              <button onClick={onRegister} className="lp-btn lp-btn-fill lp-btn-lg">Open Account <ArrowRight size={18} strokeWidth={2.2} aria-hidden /></button>
              <button onClick={() => go('autotrader')} className="lp-btn lp-btn-line lp-btn-lg">
                <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-[color:var(--lp-ember)]"><Play size={12} fill="#0b0b0e" stroke="none" aria-hidden /></span>
                See How It Works
              </button>
            </div>
          </div>
        </div>

        {/* Four true facts floating over the globe, as on the mockup. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10 hidden lg:block">
          {[
            { Icon: BarChart3, t: 'Market Scanning', d: `${instruments}+ instruments read every ten seconds`, x: '45%', y: '10%', delay: 0 },
            { Icon: ShieldCheck, t: 'Risk Controls', d: 'Stops, targets and sizing on every trade', x: '76.5%', y: '22%', delay: 1.2 },
            { Icon: Settings2, t: 'Automated Strategies', d: 'Grid, mean reversion and trend following', x: '47%', y: '60%', delay: 0.6 },
            { Icon: Globe2, t: 'Global Access', d: 'Crypto, ETFs, Forex, Metals, IPOs', x: '77.5%', y: '61%', delay: 1.8 },
          ].map(({ Icon, t, d, x, y, delay }) => (
            <div key={t} className="lp-float absolute" style={{ left: x, top: y, animationDelay: `${delay}s` }}>
              <Icon size={30} strokeWidth={2.2} className="shrink-0 text-[color:var(--lp-ember)]" />
              <div>
                <p className="text-[15px] font-semibold text-white">{t}</p>
                <p className="mt-0.5 max-w-[190px] text-[13px] leading-snug text-[color:var(--lp-soft)]">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------- the price strip */}
      <PriceStrip quotes={ticker?.quotes ?? []} />

      {/* ------------------------------------------------------ the auto trader */}
      <section id="autotrader" className="lp-section scroll-mt-[70px]">
        <div className="lp-wrap">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="max-w-[720px]">
                <Eyebrow>Live auto trader</Eyebrow>
                <h2 className="lp-h2 mt-2">Running. Finding Opportunities.</h2>
                <p className="lp-lead mt-2">Our algorithms read the markets and execute trades automatically, based on live prices and predefined strategies.</p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <span className={`lp-status ${show?.on ? 'is-on' : ''}`}>Auto trader: {show?.configured ? (show.on ? 'running' : 'paused') : 'offline'}</span>
                <button onClick={onSignIn} className="lp-btn lp-btn-outline">View Auto Trader <ArrowRight size={17} aria-hidden /></button>
              </div>
            </div>
          </Reveal>
          <AutoPanel show={show} />
        </div>
      </section>

      {/* ------------------------------------------------------- the ecosystem */}
      <section id="platform" className="lp-section scroll-mt-[70px]">
        <div className="lp-wrap">
          <Reveal>
            <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-end">
              <div>
                <Eyebrow>A complete investment ecosystem</Eyebrow>
                <h2 className="lp-h2 mt-2">More Opportunities. One Platform.</h2>
              </div>
              <p className="lp-lead max-w-[560px] lg:justify-self-end">
                From automated trading to diversified portfolios, staking rewards and fixed-return offerings — Pantera GP gives
                you the tools to take control of your financial future.
              </p>
            </div>
          </Reveal>
          <div className="mt-7 grid gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
            {([
              { id: 'autotrader-card', Icon: Brain, t: 'Auto Trader', d: 'Rules-based strategies that read markets and execute trades automatically.', art: 'line' as const, to: () => go('autotrader') },
              { id: 'portfolios', Icon: Layers, t: 'Portfolios', d: 'Flexible investment solutions for any goal.', art: 'bars' as const, to: onRegister },
              { id: 'staking', Icon: Database, t: 'Staking', d: 'Earn rewards on your digital assets.', art: 'line2' as const, to: onRegister },
              { id: 'ipo-card', Icon: Rocket, t: 'IPO Opportunities', d: 'Fixed-return offerings timed to the year’s listings.', art: 'bars2' as const, to: () => go('ipo') },
            ]).map((c, i) => (
              <Reveal key={c.t} delay={i * 70}>
                <article id={c.id} className="lp-card lp-eco scroll-mt-[90px]">
                  <EcoArt kind={c.art} />
                  <c.Icon size={38} strokeWidth={1.9} className="relative text-[color:var(--lp-ember)]" />
                  <h3 className="relative mt-4 text-[21px] font-semibold text-white">{c.t}</h3>
                  <p className="relative mt-1.5 max-w-[230px] text-[15px] leading-[1.45] text-[color:var(--lp-soft)]">{c.d}</p>
                  <button onClick={c.to} className="lp-pill relative mt-auto">Learn more <ArrowRight size={16} aria-hidden /></button>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- the metrics */}
      <section id="about" className="lp-section scroll-mt-[70px]">
        <div className="lp-wrap grid gap-8 lg:grid-cols-[1fr_2fr] lg:items-center">
          <Reveal>
            <Eyebrow>Platform metrics</Eyebrow>
            <h2 className="lp-h2 mt-2">Built for<br />Your Success.</h2>
            <p className="lp-lead mt-2 max-w-[440px]">Advanced technology, live market data and rules-based strategies working for you.</p>
            <a href="/contact" className="lp-btn lp-btn-fill mt-5 inline-flex">Why Pantera GP <ArrowRight size={17} aria-hidden /></a>
          </Reveal>
          <div className="grid grid-cols-2 gap-[14px] lg:grid-cols-4">
            {[
              [`${instruments}+`, 'Instruments', 'Crypto, ETFs, Forex, Metals'],
              ['24/7', 'Always Running', 'Strategies and orders work around the clock'],
              ['3', 'Trading Strategies', 'Grid, mean reversion and trend following'],
              ['100%', 'Audited Records', 'Every change written to an append-only log'],
            ].map(([v, t, d], i) => (
              <Reveal key={t} delay={i * 70}>
                <div className="lp-card flex h-full flex-col items-center px-4 py-7 text-center">
                  <p className="text-[38px] leading-none font-bold text-[color:var(--lp-ember)]">{v}</p>
                  <p className="mt-3 text-[17.5px] font-semibold text-white">{t}</p>
                  <p className="mt-2 text-[14.5px] leading-snug text-[color:var(--lp-soft)]">{d}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ the sectors
          Generic sectors, as the coding pack requires: no company names, no return
          figures, an illustrative label and an inquiry action rather than a purchase. */}
      <section id="ipo" className="lp-section lp-ipo scroll-mt-[70px]">
        <div className="lp-wrap">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="max-w-[760px]">
                <Eyebrow>Exclusive IPO opportunities</Eyebrow>
                <h2 className="lp-h2 mt-2">Access Tomorrow’s Leaders Today.</h2>
                <p className="lp-lead mt-2">
                  Fixed-return offerings timed to the year’s most watched listings, across the sectors shaping the next decade.
                </p>
              </div>
              <button onClick={onRegister} className="lp-btn lp-btn-outline">View IPO Opportunities <ArrowRight size={17} aria-hidden /></button>
            </div>
          </Reveal>
          <div className="mt-7 grid gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
            {([
              { Icon: Box, t: 'Technology Sector', d: 'AI infrastructure, chips and cloud platforms.' },
              { Icon: Leaf, t: 'Healthcare Sector', d: 'Next-generation medical technologies.' },
              { Icon: ChartNoAxesCombined, t: 'Financial Services', d: 'Modern financial infrastructure and global payment solutions.' },
              { Icon: Zap, t: 'Energy Sector', d: 'Clean energy and sustainable technologies.' },
            ]).map(({ Icon, t, d }, i) => (
              <Reveal key={t} delay={i * 70}>
                <article className="lp-card relative flex h-full flex-col px-[20px] pt-[18px] pb-[18px]">
                  <span className="lp-state absolute top-[14px] right-[14px]">ILLUSTRATIVE</span>
                  <div className="flex items-start gap-4">
                    <Icon size={40} strokeWidth={1.6} className="mt-1 shrink-0 text-[color:var(--lp-ember)]" />
                    <div className="min-w-0 pt-7">
                      <h3 className="text-[17px] font-semibold text-white">{t}</h3>
                      <p className="mt-1 text-[14px] leading-snug text-[color:var(--lp-soft)]">{d}</p>
                    </div>
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-4 pt-5">
                    <button onClick={onRegister} className="text-[15px] font-medium text-white transition-colors hover:text-[color:var(--lp-ember)]">Explore Opportunities</button>
                    <button onClick={onRegister} aria-label={`Explore ${t} opportunities`} className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-[color:var(--lp-ember)] text-[#0b0b0e] transition-transform hover:scale-105">
                      <ArrowRight size={18} strokeWidth={2.4} aria-hidden />
                    </button>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
          <p className="mt-4 text-[12.5px] text-[color:var(--lp-soft)]">
            Illustrative sectors; availability subject to verification. Offerings carry risk, including the loss of what you put in.
            Read the <a href="/risk" className="underline underline-offset-2 hover:text-white">risk warning</a> before you subscribe.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------ the close */}
      <section className="lp-cta relative overflow-hidden">
        <div className="lp-wrap relative z-10 py-14">
          <Reveal>
            <p className="text-[16px] text-white/85">Join Pantera GP</p>
            <h2 className="lp-h2 mt-1">Your Gateway to Global Markets</h2>
            <p className="lp-lead mt-2 max-w-[640px]">
              Create your account today and start exploring automated trading, diversified portfolios, staking and fixed-return
              offerings.
            </p>
            <div className="mt-6 flex flex-wrap gap-4">
              <button onClick={onRegister} className="lp-btn lp-btn-fill">Open Account <ArrowRight size={17} aria-hidden /></button>
              <button onClick={onSignIn} className="lp-btn lp-btn-outline">View Platform <ArrowRight size={17} aria-hidden /></button>
            </div>
          </Reveal>
        </div>
      </section>

      {/* The arrow riding the right edge: down to the footer, then back up. */}
      <button onClick={() => glide(atFoot ? 'top' : 'footer')} aria-label={atFoot ? 'Back to the top' : 'Go to the footer'}
        className={`to-footer anim-rise fixed right-6 top-1/2 z-20 hidden -translate-y-1/2 flex-col items-center gap-4 md:flex ${atFoot ? 'to-top' : ''}`}
        style={{ animationDelay: '900ms' }}>
        <span className="to-footer-label font-mono text-[11px] tracking-[0.22em] text-white/60 uppercase">{atFoot ? 'Top' : 'Footer'}</span>
        <span className="to-footer-ring flex h-11 w-11 items-center justify-center rounded-full border border-white/20 text-[color:var(--lp-ember)]">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {atFoot ? <path d="M8 14V2M3 7l5-5 5 5" /> : <path d="M8 2v12M3 9l5 5 5-5" />}
          </svg>
        </span>
      </button>

      {/* ----------------------------------------------------------- the footer */}
      <footer id="footer" className="lp-footer scroll-mt-0">
        <div className="lp-wrap grid gap-10 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            {footer.logo_url ? <img src={footer.logo_url} alt="Pantera GP" className="h-8 w-auto" /> : <Wordmark />}
            <p className="mt-4 max-w-xs text-[14px] leading-relaxed text-[color:var(--lp-soft)]">
              {footer.text?.trim() || 'A trading desk and a client system, built as one thing. Orders rest with the engine rather than in an open tab, and every fill, decision and document is written down against the account it belongs to.'}
            </p>
          </div>
          {[
            ['Platform', [['Auto Trader', 'autotrader'], ['Portfolios & Staking', 'platform'], ['IPO Opportunities', 'ipo'], ['About', 'about']]],
            ['Company', [['Insights', '/blog'], ['Contact', '/contact'], ['Back to top', 'top']]],
            [footer.column_title?.trim() || 'Legal', footer.links?.length
              ? footer.links.map((l) => [l.label, l.href])
              : [['Terms of Service', '/terms'], ['Privacy Policy', '/privacy'], ['Risk warning', '/risk'], ['Contact', '/contact']]],
          ].map(([heading, links]) => (
            <div key={heading as string}>
              <h4 className="text-[12px] font-semibold tracking-[0.16em] text-white uppercase">{heading as string}</h4>
              <ul className="mt-4 space-y-2">
                {(links as [string, string][]).map(([label, id]) => (
                  <li key={id + label}>
                    {/^(\/|https?:|mailto:)/.test(id)
                      ? <a href={id} className="text-[14px] text-[color:var(--lp-soft)] transition-colors hover:text-[color:var(--lp-ember)]">{label}</a>
                      : <button onClick={() => go(id)} className="text-[14px] text-[color:var(--lp-soft)] transition-colors hover:text-[color:var(--lp-ember)]">{label}</button>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="lp-wrap border-t border-white/[0.07] py-6">
          <h4 className="text-[12px] font-semibold tracking-[0.16em] text-white uppercase">{footer.capabilities_title?.trim() || 'What the engine takes'}</h4>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            {capabilities.map((c) => <li key={c} className="font-mono text-[11px] tracking-[0.12em] text-[color:var(--lp-soft)]">{c}</li>)}
          </ul>
        </div>

        {!!footer.marks?.length && (
          <div className="lp-wrap border-t border-white/[0.07] py-6">
            {!!footer.marks_title?.trim() && <h4 className="mb-5 text-[12px] font-semibold tracking-[0.16em] text-white uppercase">{footer.marks_title.trim()}</h4>}
            <ul className="flex flex-wrap items-center gap-x-10 gap-y-5">
              {footer.marks.map((m) => {
                const img = <img src={m.url} alt={m.name} loading="lazy" className="h-7 w-auto opacity-75 transition-opacity duration-200 hover:opacity-100" />;
                return <li key={m.id}>{m.href ? <a href={m.href} rel={/^https?:/.test(m.href) ? 'noopener' : undefined} title={m.name}>{img}</a> : img}</li>;
              })}
            </ul>
          </div>
        )}

        {!!footer.notice?.trim() && (
          <div className="lp-wrap border-t border-white/[0.07] py-6">
            <div className="max-w-[96ch] space-y-3 text-[12.5px] leading-relaxed text-[color:var(--lp-soft)]">
              {noticeBlocks(footer.notice).map((b, i) => (b.kind === 'ul'
                ? <ul key={i} className="list-disc space-y-1 pl-5">{b.lines.map((l, k) => <li key={k}>{l}</li>)}</ul>
                : <p key={i}>{b.lines.map((l, k) => <span key={k}>{k > 0 && <br />}{l}</span>)}</p>))}
            </div>
          </div>
        )}

        <div className="lp-wrap flex border-t border-white/[0.07] py-6 font-mono text-[11px] text-[color:var(--lp-soft)]">
          <span className="ml-auto">{footer.line?.trim() || `© ${new Date().getFullYear()} Pantera GP`}</span>
        </div>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ sections
/** The strip of live prices under the hero, scrolled a card at a time by its arrows. */
function PriceStrip({ quotes }: { quotes: Ticker['quotes'] }) {
  const row = useRef<HTMLDivElement>(null);
  const move = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * 220, behavior: 'smooth' });
  return (
    <section className="lp-strip" aria-label="Live prices">
      {/* The arrows sit in the side margins, as on the mockup, so the six cards take the full width. */}
      <div className="lp-wrap relative py-[13px]">
        <button onClick={() => move(-1)} aria-label="Earlier prices" className="lp-round lp-strip-arrow lp-strip-prev"><ArrowLeft size={18} aria-hidden /></button>
        <div ref={row} className="lp-strip-row flex gap-[12px] overflow-x-auto">
          {(quotes.length ? quotes : Array.from({ length: 6 }, () => null)).map((q, i) => (
            <div key={q?.symbol ?? i} className="lp-tick">
              {q ? <>
                <Coin symbol={q.symbol} />
                <div className="min-w-0">
                  <p className="text-[12px] font-medium tracking-[0.02em] text-[color:var(--lp-soft)]">{q.symbol}</p>
                  <p className="text-[16px] font-semibold text-white tabular-nums">{price(q.price)}</p>
                </div>
                <div className="ml-auto flex flex-col items-end gap-0.5">
                  <Spark values={q.spark} up={q.change_pct >= 0} />
                  <span className={`text-[12.5px] font-medium tabular-nums ${q.change_pct >= 0 ? 'text-[color:var(--lp-up)]' : 'text-[color:var(--lp-down)]'}`}>
                    {q.change_pct >= 0 ? '+' : ''}{q.change_pct.toFixed(2)}%
                  </span>
                </div>
              </> : <span className="h-[38px] w-full animate-pulse rounded bg-white/5" />}
            </div>
          ))}
        </div>
        <button onClick={() => move(1)} aria-label="Later prices" className="lp-round lp-strip-arrow lp-strip-next"><ArrowRight size={18} aria-hidden /></button>
      </div>
      <p className="lp-wrap -mt-2 pb-2 text-right font-mono text-[10px] tracking-[0.14em] text-white/40 uppercase">Prices quoted on this platform · updated every five seconds</p>
    </section>
  );
}

/** The auto trader's live record on the desk's showcase account. */
function AutoPanel({ show }: { show: Showcase | null }) {
  const k = show?.kpis;
  const none = !show?.configured || !k;
  const dash = '—';
  const curve = show?.curve ?? [];
  const stat = (label: string, value: React.ReactNode, sub: React.ReactNode, tone = 'text-white') => (
    <div className="lp-card px-[22px] py-[18px]">
      <p className="lp-label">{label}</p>
      <p className={`mt-2.5 text-[25px] leading-none font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-2.5 text-[13.5px] text-[color:var(--lp-soft)]">{sub}</p>
    </div>
  );
  return (
    <>
      <div className="mt-6 grid gap-[10px] lg:grid-cols-[1fr_1fr_1fr_1.3fr]">
        <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-3 lg:col-span-3">
          {stat('Bot equity', none ? dash : usd(k.equity), none ? 'no showcase account set' : k.return_pct === null ? 'since start' : `${k.return_pct >= 0 ? '+' : ''}${(k.return_pct * 100).toFixed(2)}% since start`)}
          {stat('Today', none ? dash : signed(k.today_net), none ? dash : `${k.today_trades} closed · fees ${usd(k.today_fees)}`, none ? 'text-white' : k.today_net >= 0 ? 'text-[color:var(--lp-up)]' : 'text-[color:var(--lp-down)]')}
          {stat('Win rate', none || k.win_rate === null ? dash : pct(k.win_rate), none ? dash : `${k.wins} of ${k.closed} closed`)}
          {stat('Profit factor', none || k.profit_factor === null ? dash : k.profit_factor.toFixed(2), none ? dash : `avg win ${k.avg_win_r?.toFixed(1) ?? '0'}R · avg loss ${k.avg_loss_r?.toFixed(1) ?? '0'}R`)}
          {stat('Max drawdown', none ? dash : k.max_drawdown ? `-${pct(k.max_drawdown, 1)}` : '0%', none ? dash : k.drawdown_at ? shortDay(k.drawdown_at) : 'no drawdown yet', none || !k.max_drawdown ? 'text-white' : 'text-[color:var(--lp-down)]')}
          {stat('Open', none ? dash : String(k.open), none ? dash : `${signed(k.unrealised)} unrealised`, none || !k.open ? 'text-white' : 'text-[color:var(--lp-ember)]')}
        </div>
        <div className="lp-card flex min-h-[230px] flex-col px-[22px] pt-[18px] pb-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="lp-label">Bot equity{show?.since ? ` · since ${shortDay(show.since)}` : ''}</p>
            {curve.length > 1 && <p className="font-mono text-[11.5px] text-[color:var(--lp-soft)] tabular-nums">{usd(curve[0]!.equity)} → {usd(curve[curve.length - 1]!.equity)}</p>}
          </div>
          <EquityChart curve={curve} />
          <p className="mt-1 text-[12px] text-[color:var(--lp-soft)]">Realised plus unrealised, after commissions. Every point is a trade that closed.</p>
        </div>
      </div>

      <div className="mt-[10px] grid gap-[10px] lg:grid-cols-[1.85fr_1fr]">
        <div className="lp-card overflow-x-auto px-[22px] py-[18px]">
          <p className="lp-title">Recent trades</p>
          <table className="mt-3 w-full min-w-[560px] text-left">
            <thead>
              <tr className="lp-label">{['Time', 'Instrument', 'Side', 'Entry', 'Exit', 'P&L', 'Strategy'].map((h) => <th key={h} className="pb-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {(show?.trades ?? []).map((t, i) => (
                <tr key={i} className="border-t border-white/[0.06] text-[15px]">
                  <td className="py-[9px] text-[color:var(--lp-soft)] tabular-nums">{clock(t.closed_at)}</td>
                  <td className="font-semibold text-white">{t.symbol}</td>
                  <td><span className={`lp-side ${t.side === 'long' ? 'is-long' : 'is-short'}`}>{t.side === 'long' ? 'LONG' : 'SHORT'}</span></td>
                  <td className="text-[color:var(--lp-soft)] tabular-nums">{price(t.entry)}</td>
                  <td className="text-[color:var(--lp-soft)] tabular-nums">{price(t.exit)}</td>
                  <td className={`font-semibold tabular-nums ${t.net >= 0 ? 'text-[color:var(--lp-up)]' : 'text-[color:var(--lp-down)]'}`}>{signed(t.net)}</td>
                  <td className="text-[color:var(--lp-soft)]">{t.strategy ?? '—'}</td>
                </tr>
              ))}
              {!show?.trades?.length && <tr><td colSpan={7} className="border-t border-white/[0.06] py-6 text-[14px] text-[color:var(--lp-soft)]">No closed trades to show yet.</td></tr>}
            </tbody>
          </table>
          <p className="mt-3 text-[11.5px] text-[color:var(--lp-soft)]">Live from the desk’s demo account, on prices this platform quotes.</p>
        </div>
        <div className="lp-card px-[22px] py-[18px]">
          <p className="lp-title">Active strategies</p>
          <p className="mt-2 text-[14px] text-[color:var(--lp-soft)]">Allocation is what each one may deploy.</p>
          <ul className="mt-3 space-y-4">
            {(show?.strategies ?? []).map((s) => (
              <li key={s.name} className="flex items-center gap-4">
                <span className={`h-[14px] w-[14px] shrink-0 rounded-full ${s.state === 'running' ? 'bg-[#5cc8b4]' : 'bg-white/35'}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-medium text-white">{s.name}</p>
                  <p className="truncate text-[13.5px] text-[color:var(--lp-soft)]">{s.symbols.join(' · ')}</p>
                </div>
                <span className={`lp-state ${s.state === 'running' ? 'is-running' : ''}`}>{s.state === 'running' ? 'RUNNING' : 'PAUSED'}</span>
              </li>
            ))}
            {!show?.strategies?.length && <li className="text-[14px] text-[color:var(--lp-soft)]">No strategies to show yet.</li>}
          </ul>
        </div>
      </div>
    </>
  );
}

/** The showcase account's equity since its record began: an ember line over a glow, a dot per trade. */
function EquityChart({ curve }: { curve: { at: string; equity: number }[] }) {
  const W = 560, H = 150;
  const geo = useMemo(() => {
    if (curve.length < 2) return null;
    const t0 = new Date(curve[0]!.at).getTime(), t1 = new Date(curve[curve.length - 1]!.at).getTime() || t0 + 1;
    const vs = curve.map((p) => p.equity); const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
    const pts = curve.map((p) => ({ x: ((new Date(p.at).getTime() - t0) / Math.max(1, t1 - t0)) * W, y: H - 10 - ((p.equity - lo) / span) * (H - 24) }));
    const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => ({ x: f * W, label: shortDay(new Date(t0 + f * (t1 - t0))) }));
    return { pts, ticks };
  }, [curve]);
  if (!geo) return <div className="grid flex-1 place-items-center text-[14px] text-[color:var(--lp-soft)]">The curve appears once trades close.</div>;
  const line = geo.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const dots = geo.pts.filter((_, i) => i % Math.max(1, Math.floor(geo.pts.length / 14)) === 0 || i === geo.pts.length - 1);
  return (
    <div className="mt-2 flex-1">
      <svg viewBox={`0 0 ${W} ${H + 20}`} className="h-full w-full" preserveAspectRatio="none" aria-label="Bot equity over time">
        <defs><linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff7817" stopOpacity="0.35" /><stop offset="1" stopColor="#ff7817" stopOpacity="0" /></linearGradient></defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="rgba(255,255,255,0.06)" />)}
        <path d={`${line} L${W},${H} L0,${H} Z`} fill="url(#eq-fill)" />
        <path d={line} fill="none" stroke="#ff7817" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
        {dots.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="2.6" fill="#ff7817" />)}
        <circle cx={geo.pts[geo.pts.length - 1]!.x} cy={geo.pts[geo.pts.length - 1]!.y} r="4.5" fill="#ffb26b" />
        {geo.ticks.map((t, i) => <text key={i} x={t.x} y={H + 16} fill="rgba(255,255,255,0.55)" fontSize="12" textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}>{t.label}</text>)}
      </svg>
    </div>
  );
}

/** The faint ember charts in the corner of each service card. */
function EcoArt({ kind }: { kind: 'line' | 'bars' | 'line2' | 'bars2' }) {
  const bars = (n: number) => Array.from({ length: n }, (_, i) => {
    const h = 6 + Math.pow(i / (n - 1), 2.1) * 88;
    return <rect key={i} x={30 + i * 22} y={110 - h} width="13" height={h} rx="1" fill="url(#eco-bar)" />;
  });
  return (
    <svg viewBox="0 0 280 120" className="pointer-events-none absolute right-0 bottom-[38px] h-[104px] w-[90%]" aria-hidden>
      <defs>
        <linearGradient id="eco-bar" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff7817" stopOpacity="0.95" /><stop offset="1" stopColor="#ff7817" stopOpacity="0.15" /></linearGradient>
        <linearGradient id="eco-glow" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff7817" stopOpacity="0.3" /><stop offset="1" stopColor="#ff7817" stopOpacity="0" /></linearGradient>
      </defs>
      {kind === 'bars' && bars(11)}
      {kind === 'bars2' && bars(12)}
      {(kind === 'line' || kind === 'line2') && (() => {
        const ys = kind === 'line' ? [108, 104, 106, 100, 102, 97, 99, 92, 95, 86, 80, 70, 56, 36, 18] : [110, 106, 108, 101, 97, 99, 90, 82, 92, 80, 70, 62, 48, 30, 8];
        const d = ys.map((y, i) => `${i ? 'L' : 'M'}${(i / (ys.length - 1)) * 270},${y}`).join(' ');
        return <>
          <path d={`${d} L270,120 L0,120 Z`} fill="url(#eco-glow)" />
          <path d={d} fill="none" stroke="#ff7817" strokeWidth="2" style={{ filter: 'drop-shadow(0 0 4px rgba(255,120,23,.8))' }} />
          <circle cx="270" cy={ys[ys.length - 1]} r="3.5" fill="#ffb26b" />
        </>;
      })()}
    </svg>
  );
}
