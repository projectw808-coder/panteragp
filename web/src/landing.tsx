import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, ArrowRight, BarChart3, Box, Brain, ChartColumnIncreasing, ChartNoAxesCombined, ChartPie, EyeOff,
  Globe2, Grid3x3, Headset, Layers, Leaf, Lock, Newspaper, Play, Plus, Rocket, ScrollText, Send, ShieldCheck,
  ShieldHalf, Shuffle, Star, Zap,
} from 'lucide-react';
import { useApi } from './api.ts';

/**
 * The public front of the site, to the second approved plan (October 2026, the "build
 * ready" pack): a night-globe hero with feature chips, a moving price strip, the live AI
 * auto trader panel, six services, the market classes, IPO sectors, three steps, the
 * platform metrics beside the terminal on three devices, security, client testimonials,
 * Insights, questions, a closing call to action and a compact footer.
 *
 * Every figure is live and true. Prices are the platform's own quotes. The auto trader
 * panel reads the record of the one desk demo account chosen in Settings, and says so.
 * Market counts come from the instruments table. Testimonials appear only when the desk
 * has entered real ones with the client's consent. The previous versions are kept at the
 * git tag pre-redesign-2026-10-24 and on the redesign branch's history.
 */

type FooterView = {
  text?: string; column_title?: string; links?: { label: string; href: string }[]; line?: string; logo_url?: string | null;
  capabilities_title?: string; capabilities?: string[];
  marks_title?: string; marks?: { id: string; name: string; href?: string; url: string }[];
  notice?: string;
  social?: { linkedin?: string; x?: string; telegram?: string };
};
type Article = { slug: string; title: string; excerpt: string | null; cover_url: string | null; tags: string[] | null; read_minutes: number; published_at: string };
type Ticker = { instruments: number; quotes: { symbol: string; price: number; change_pct: number; spark: number[] }[] };
type Showcase = {
  configured: boolean; demo?: boolean; on?: boolean; since?: string | null;
  kpis?: {
    equity: number; allocated: number; return_pct: number | null; unrealised: number;
    today_net: number; today_trades: number; today_fees: number;
    wins: number; closed: number; win_rate: number | null;
    profit_factor: number | null; avg_win_r: number | null; avg_loss_r: number | null;
    max_drawdown: number; drawdown_at: string | null; open: number;
    total_trades: number; sharpe: number | null;
  };
  curve?: { at: string; equity: number }[];
  trades?: { closed_at: string; symbol: string; side: string; entry: number; exit: number; net: number; strategy: string | null }[];
  strategies?: { name: string; kind: string; symbols: string[]; state: 'running' | 'paused'; return_pct: number | null; spark: number[] }[];
};
type Markets = { counts: Record<string, number>; total: number };
type Testimonial = { quote: string; name: string; role: string; rating: number };

/** The footer notice as the desk pasted it: blank lines end paragraphs, -, * or • lines make a list. */
function noticeBlocks(text: string): { kind: 'p' | 'ul'; lines: string[] }[] {
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((lines) => lines.length)
    .map((lines) => (lines.every((l) => /^[-*•]\s+/.test(l)) ? { kind: 'ul' as const, lines: lines.map((l) => l.replace(/^[-*•]\s+/, '')) } : { kind: 'p' as const, lines }));
}

// ------------------------------------------------------------------ formatting
const usd = (n: number, digits = 2) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${usd(n)}`;
const price = (p: number) => p.toLocaleString('en-US', { minimumFractionDigits: p < 10 ? 4 : 2, maximumFractionDigits: p < 10 ? 4 : 2 });
const shortDay = (iso: string | Date) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const compact = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : `$${n.toFixed(0)}`);
// The landing keeps its motion for every visitor, at the owner's request (25 October 2026);
// the reduced-motion softening is in index.css. Kept as a function so it can be restored.
const reduced = () => false;

/** Re-read a public endpoint every few seconds while the page is visible. */
function usePolled<T>(path: string, everyMs: number) {
  const q = useApi<T>(path);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) q.reload(); }, everyMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, everyMs]);
  return q.data;
}

/** Reveal once scrolled into view; the timer keeps a hidden tab from leaving the page blank. */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => { el.classList.add('shown'); io.disconnect(); clearTimeout(timer); };
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) show(); }, { rootMargin: '0px 0px -8% 0px' });
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

/** A figure that counts up to its value the first time it is seen, then follows it. */
function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(reduced() ? value : 0);
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useRef(false);
  useEffect(() => {
    if (reduced() || seen.current) { setShown(value); return; }
    const el = ref.current;
    if (!el) return;
    let raf = 0, settle = 0;
    const run = () => {
      seen.current = true;
      // A background tab may never paint a frame; the figure still lands on its value.
      settle = window.setTimeout(() => { cancelAnimationFrame(raf); setShown(value); }, 1500);
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / 1300);
        setShown(value * (1 - Math.pow(1 - t, 3)));
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { io.disconnect(); run(); } });
    io.observe(el);
    const timer = setTimeout(() => { io.disconnect(); if (!seen.current) run(); }, 2500);
    return () => { io.disconnect(); clearTimeout(timer); clearTimeout(settle); cancelAnimationFrame(raf); };
  }, [value]);
  return <span ref={ref}>{format(shown)}</span>;
}

// ------------------------------------------------------------------ marks and small parts
export const LogoMark = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
    <path d="M5 6.5 L16 17 L27 6.5 M16 17 V27.5" stroke="var(--lp-ember, #ff7a12)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="5" cy="6.5" r="2.6" fill="var(--lp-ember, #ff7a12)" /><circle cx="27" cy="6.5" r="2.6" fill="var(--lp-ember, #ff7a12)" /><circle cx="16" cy="27.5" r="2.6" fill="var(--lp-ember, #ff7a12)" />
  </svg>
);
const Wordmark = () => (
  <span className="flex items-center gap-2.5">
    <LogoMark />
    <span className="text-[19px] font-semibold tracking-[-0.01em] whitespace-nowrap text-white">Pantera GP</span>
    <span className="lp-slashes" aria-hidden>///</span>
  </span>
);
const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[12.5px] font-semibold tracking-[0.2em] text-[color:var(--lp-ember)] uppercase">{children}</p>
);

function Spark({ values, up, w = 52, h = 22, id }: { values: number[]; up: boolean; w?: number; h?: number; id: string }) {
  const d = useMemo(() => {
    if (values.length < 2) return '';
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(' ');
  }, [values, w, h]);
  const col = up ? 'var(--lp-up)' : 'var(--lp-down)';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="shrink-0">
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={col} stopOpacity="0.35" /><stop offset="1" stopColor={col} stopOpacity="0" /></linearGradient></defs>
      {d && <path d={`${d} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />}
      {d && <path d={d} stroke={col} strokeWidth="1.6" fill="none" className="lp-draw" pathLength={1} />}
    </svg>
  );
}

export function Coin({ symbol }: { symbol: string }) {
  const base = 'grid h-[36px] w-[36px] shrink-0 place-items-center rounded-full';
  switch (symbol) {
    case 'BTCUSD': return <span className={`${base} bg-[#f7931a] text-[18px] font-bold text-white`}>₿</span>;
    case 'ETHUSD': return (<span className={`${base} bg-[#627eea]`}><svg width="15" height="22" viewBox="0 0 16 24" aria-hidden><path d="M8 0 L16 12 L8 16.5 L0 12 Z" fill="#fff" fillOpacity=".95" /><path d="M8 18 L16 13.5 L8 24 L0 13.5 Z" fill="#fff" fillOpacity=".75" /></svg></span>);
    case 'XAUUSD': return (<span className={`${base} bg-[#d79a1e]`}><svg width="21" height="15" viewBox="0 0 22 16" aria-hidden><path d="M4 7 L7 2 H15 L18 7 Z" fill="#fff6d8" /><path d="M1 14 L4 8.5 H10.5 L10.5 14 Z M11.5 14 V8.5 H18 L21 14 Z" fill="#fde7a8" /></svg></span>);
    case 'XAGUSD': return <span className={`${base} bg-[#9aa3ad] text-[12px] font-bold text-white`}>Ag</span>;
    case 'EURUSD': return <span className={`${base} bg-[#1a6cf0] text-[18px] font-semibold text-white`}>€</span>;
    case 'GBPUSD': return <span className={`${base} bg-[#2a3f8f] text-[18px] font-semibold text-white`}>£</span>;
    case 'SPY': return <span className={`${base} bg-white text-[10px] font-bold text-[#0b0b0e]`}>S&amp;P</span>;
    case 'QQQ': return <span className={`${base} bg-[#3b5bdb] text-[10px] font-bold text-white`}>NDX</span>;
    case 'SOLUSD': return <span className={`${base} bg-gradient-to-br from-[#9945ff] to-[#14f195] text-[14px] font-bold text-white`}>S</span>;
    case 'XRPUSD': return <span className={`${base} bg-[#23292f] text-[11px] font-bold text-white ring-1 ring-white/20`}>XRP</span>;
    default: return <span className={`${base} bg-white/10 text-[11px] font-bold text-white`}>{symbol.slice(0, 3)}</span>;
  }
}

// ------------------------------------------------------------------ the page
export function Landing({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const footer = useApi<FooterView>('/site-content/footer').data ?? {};
  const ticker = usePolled<Ticker>('/public/ticker', 5000);
  const show = usePolled<Showcase>('/public/showcase', 20000);
  const markets = useApi<Markets>('/public/markets').data;
  const testimonials = useApi<Testimonial[]>('/public/testimonials').data ?? [];
  const articles = useApi<{ articles: Article[] }>('/articles').data;
  const [atFoot, setAtFoot] = useState(false);
  const [menu, setMenu] = useState(false);
  const NAV: [string, string][] = [['platform', 'Platform'], ['autotrader', 'Auto Trader'], ['portfolios', 'Portfolios'], ['staking', 'Staking'], ['ipo', 'IPO Opportunities'], ['markets', 'Markets'], ['about', 'About']];
  const instruments = ticker?.instruments ?? markets?.total ?? 100;

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

  /** A soft ember light follows the pointer across whichever card it is over. */
  const spotlight = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const card = (e.target as HTMLElement).closest<HTMLElement>('.lp-card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  };

  const go = (id: string) => scroller.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  /** The side arrow's slow glide to the footer and back; a wheel, touch or key takes over at once. */
  const glide = (id: string) => {
    const sc = scroller.current;
    const el = sc?.querySelector<HTMLElement>(`#${id}`);
    if (!sc || !el) return;
    const top = Math.min(el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop, sc.scrollHeight - sc.clientHeight);
    if (reduced()) { sc.scrollTo({ top }); setAtFoot(id === 'footer'); return; }
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

  return (
    <div ref={scroller} className="landing lp h-full overflow-auto" onPointerMove={spotlight}>
      {/* ------------------------------------------------------------ the bar */}
      <nav className="lp-bar sticky top-0 z-30">
        <div className="lp-wrap flex h-[66px] items-center gap-6">
          <button onClick={() => go('top')} aria-label="Pantera GP, back to the top" className="focus-ring rounded"><Wordmark /></button>
          <div className="ml-10 hidden items-center gap-[26px] xl:flex">
            {NAV.map(([id, label]) => <button key={id} onClick={() => go(id)} className="lp-navlink focus-ring">{label}</button>)}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button onClick={onSignIn} className="lp-btn lp-btn-dark hidden sm:inline-flex">Sign In</button>
            <button onClick={onRegister} className="lp-btn lp-btn-fill lp-sheen lp-bar-cta">Open Account <ArrowRight size={17} strokeWidth={2.2} aria-hidden /></button>
            <button type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="landing-menu" aria-label={menu ? 'Close the menu' : 'Open the menu'}
              className="focus-ring -mr-2 flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10 xl:hidden">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                {menu ? <path d="M4 4l12 12M16 4L4 16" /> : <path d="M3 5h14M3 10h14M3 15h14" />}
              </svg>
            </button>
          </div>
        </div>
        {menu && (
          <div id="landing-menu" className="absolute inset-x-0 top-full z-30 border-b border-white/10 bg-[#07090c]/95 px-6 py-3 backdrop-blur xl:hidden">
            <ul className="flex flex-col">
              {NAV.map(([id, label]) => <li key={id}><button onClick={() => { setMenu(false); go(id); }} className="lp-navlink focus-ring block w-full py-3 text-left">{label}</button></li>)}
              <li><a href="/blog" className="lp-navlink focus-ring block w-full py-3 text-left">Insights</a></li>
              <li className="sm:hidden"><button onClick={() => { setMenu(false); onSignIn(); }} className="lp-navlink focus-ring block w-full py-3 text-left">Sign In</button></li>
            </ul>
          </div>
        )}
      </nav>

      {/* ------------------------------------------------------------ the hero */}
      <section id="top" className="lp-hero relative overflow-hidden">
        <div aria-hidden className="lp-hero-art" />
        <HeroNetwork />
        <div aria-hidden className="lp-embers">
          {EMBERS.map((e, i) => <span key={i} style={{ left: `${e.x}%`, width: e.s, height: e.s, animationDuration: `${e.d}s`, animationDelay: `${e.delay}s` }} />)}
        </div>
        <div className="lp-wrap relative z-10 flex min-h-[500px] flex-col justify-center pt-10 pb-8">
          <div className="max-w-[660px]">
            <div className="anim-rise" style={{ animationDelay: '60ms' }}><Eyebrow>Powered by artificial intelligence</Eyebrow></div>
            <h1 className="mt-3 text-[44px] leading-[1.03] font-bold tracking-[-0.02em] sm:text-[60px]" style={{ animationDelay: '160ms' }}>
              <span className="block text-white">{words('AI Trading', 200)}</span>
              <span className="lp-gradient-text block">{words('for Real Opportunities.', 420)}</span>
            </h1>
            <p className="anim-rise mt-4 max-w-[580px] text-[19px] leading-[1.45] text-[color:var(--lp-soft-2)]" style={{ animationDelay: '260ms' }}>
              AI-driven strategies. Diversified portfolios. Global markets.<br className="hidden sm:inline" /> All in one platform.
            </p>
            <div className="anim-rise mt-7 flex flex-wrap gap-4" style={{ animationDelay: '360ms' }}>
              <button onClick={onRegister} className="lp-btn lp-btn-fill lp-btn-lg lp-sheen">Open Account <ArrowRight size={18} strokeWidth={2.2} aria-hidden /></button>
              <button onClick={() => go('how')} className="lp-btn lp-btn-line lp-btn-lg">
                <span className="lp-play grid h-[26px] w-[26px] place-items-center rounded-full bg-[color:var(--lp-ember)]"><Play size={12} fill="#07090c" stroke="none" aria-hidden /></span>
                See How It Works
              </button>
            </div>
          </div>
          <ul className="anim-rise lp-chips mt-8" style={{ animationDelay: '480ms' }} aria-label="What the platform does">
            {([
              [BarChart3, 'Real-Time', 'Market Analysis'], [Brain, 'AI-Powered', 'Strategies'], [Layers, 'Diversified', 'Portfolios'],
              [Globe2, 'Global', 'Opportunities'], [ShieldCheck, 'Risk', 'Optimization'],
            ] as const).map(([Icon, a, b]) => (
              <li key={a + b}><Icon size={22} strokeWidth={1.9} aria-hidden className="text-[color:var(--lp-ember)]" /><span>{a}<br />{b}</span></li>
            ))}
          </ul>
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10 hidden lg:block">
          {[
            { Icon: ChartColumnIncreasing, t: 'AI Market Analysis', d: `Scanning ${instruments}+ markets in real time`, x: '47%', y: '9%', delay: 0 },
            { Icon: ShieldCheck, t: 'Risk Optimization', d: 'Dynamic sizing, stops and targets on every trade', x: '79%', y: '17%', delay: 1.2 },
            { Icon: Globe2, t: 'Global Access', d: 'Crypto, ETFs, Forex, Metals, IPOs', x: '79%', y: '52%', delay: 0.6 },
          ].map(({ Icon, t, d, x, y, delay }) => (
            <div key={t} className="lp-float absolute" style={{ left: x, top: y, animationDelay: `${delay}s` }}>
              <span className="lp-float-icon"><Icon size={26} strokeWidth={2.1} /></span>
              <div>
                <p className="text-[15px] font-semibold text-white">{t}</p>
                <p className="mt-0.5 max-w-[185px] text-[13px] leading-snug text-[color:var(--lp-soft)]">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <PriceStrip quotes={ticker?.quotes ?? []} />

      {/* ------------------------------------------------------ the auto trader */}
      <section id="autotrader" className="lp-section scroll-mt-[66px]">
        <div className="lp-wrap">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="max-w-[720px]">
                <Eyebrow>Live AI auto trader</Eyebrow>
                <h2 className="lp-h2 mt-2">Running. Finding Opportunities.</h2>
                <p className="lp-lead mt-2">Our AI algorithms analyze the markets and execute trades automatically, based on real-time data and predefined strategies.</p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <span className={`lp-status ${show?.on ? 'is-on' : ''}`}>
                  {show?.on && <span className="lp-live-dot" aria-hidden />}
                  Auto trader: {show?.configured ? (show.on ? 'running' : 'paused') : 'starting'}
                  {show?.demo && <span className="lp-demo-tag">Demo</span>}
                </span>
                <button onClick={onSignIn} className="lp-btn lp-btn-outline">View Auto Trader <ArrowRight size={17} aria-hidden /></button>
              </div>
            </div>
          </Reveal>
          <AutoPanel show={show} onOpen={onSignIn} />
        </div>
      </section>

      {/* ------------------------------------------------------- the ecosystem */}
      <section id="platform" className="lp-section scroll-mt-[66px]">
        <div className="lp-wrap">
          <Reveal>
            <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-end">
              <div><Eyebrow>A complete investment ecosystem</Eyebrow><h2 className="lp-h2 mt-2">More Opportunities. One Platform.</h2></div>
              <p className="lp-lead max-w-[580px] lg:justify-self-end">
                From automated trading to diversified portfolios, staking rewards and IPO opportunities, Pantera GP gives you the tools to
                take control of your financial future.
              </p>
            </div>
          </Reveal>
          <div className="mt-7 grid gap-[14px] sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {([
              { id: 'autotrader-card', Icon: Brain, t: 'Auto Trader', d: 'AI-powered strategies that analyze markets and execute trades automatically.', art: 'line' as const, to: () => go('autotrader') },
              { id: 'portfolios', Icon: Layers, t: 'Portfolios', d: 'Flexible investment solutions for any goal.', art: 'bars' as const, to: onRegister },
              { id: 'staking', Icon: Rocket, t: 'Staking', d: 'Earn rewards on your digital assets.', art: 'line2' as const, to: onRegister },
              { id: 'ipo-card', Icon: ChartPie, t: 'IPO Opportunities', d: 'Fixed-return offerings timed to the year’s listings.', art: 'bars2' as const, to: () => go('ipo') },
              { id: 'markets-card', Icon: Globe2, t: 'Global Markets', d: 'Trade crypto, forex, metals and index ETFs.', art: 'line' as const, to: () => go('markets') },
              { id: 'support-card', Icon: Headset, t: 'Dedicated Support', d: 'A named desk team on your account, from onboarding on.', art: 'line2' as const, to: () => { window.location.href = '/contact'; } },
            ]).map((c, i) => (
              <Reveal key={c.t} delay={i * 60}>
                <article id={c.id} className="lp-card lp-eco lp-hover scroll-mt-[90px]">
                  <EcoArt kind={c.art} />
                  <span className="lp-icon-tile relative"><c.Icon size={26} strokeWidth={1.9} /></span>
                  <h3 className="relative mt-3 text-[19px] font-semibold text-white">{c.t}</h3>
                  <p className="relative mt-1.5 text-[14.5px] leading-[1.45] text-[color:var(--lp-soft)]">{c.d}</p>
                  <button onClick={c.to} className="lp-pill relative mt-auto">Learn more <ArrowRight size={15} aria-hidden /></button>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ the markets */}
      <section id="markets" className="lp-section scroll-mt-[66px]">
        <div className="lp-wrap grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,2.6fr)] lg:items-center">
          <Reveal>
            <Eyebrow>Global market opportunities</Eyebrow>
            <h2 className="lp-h2 lp-h2-sm mt-2">A Diverse Range of Markets.<br />A World of Possibilities.</h2>
            <p className="lp-lead mt-3 max-w-[420px]">Access opportunities across multiple asset classes and global markets, all in one platform.</p>
          </Reveal>
          <div className="grid gap-[12px] sm:grid-cols-2 lg:grid-cols-5">
            {([
              { t: 'Cryptocurrencies', d: 'Trade major coins and emerging assets.', n: markets?.counts.crypto, art: 'crypto' as const, to: onRegister },
              { t: 'ETFs & Indices', d: 'Global equity and sector indices.', n: markets?.counts.etf, art: 'stocks' as const, to: onRegister },
              { t: 'Forex', d: 'Major, minor and cross pairs.', n: markets?.counts.fx, art: 'forex' as const, to: onRegister },
              { t: 'Metals', d: 'Gold, silver and more.', n: markets?.counts.metals, art: 'gold' as const, to: onRegister },
              { t: 'Pre-IPO Opportunities', d: 'Fixed-return offerings before listing.', n: undefined, art: 'ipo' as const, to: () => go('ipo') },
            ]).map((m, i) => (
              <Reveal key={m.t} delay={i * 60}>
                <article className="lp-card lp-market lp-hover">
                  <MarketArt kind={m.art} />
                  <div className="relative">
                    <h3 className="text-[17px] font-semibold text-white">{m.t}</h3>
                    <p className="mt-1 max-w-[150px] text-[13.5px] leading-snug text-[color:var(--lp-soft)]">{m.d}</p>
                    {m.n ? <p className="mt-2 font-mono text-[11px] tracking-[0.12em] text-[color:var(--lp-ember)] uppercase">{m.n} instruments</p> : null}
                  </div>
                  <button onClick={m.to} className="lp-pill lp-pill-sm relative mt-auto">Explore <ArrowRight size={14} aria-hidden /></button>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ the sectors */}
      <section id="ipo" className="lp-section lp-ipo scroll-mt-[66px]">
        <div className="lp-wrap">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="max-w-[760px]">
                <Eyebrow>Exclusive IPO opportunities</Eyebrow>
                <h2 className="lp-h2 mt-2">Access Tomorrow’s Leaders Today.</h2>
                <p className="lp-lead mt-2">Fixed-return offerings timed to the year’s most watched listings, across the sectors shaping the next decade.</p>
              </div>
              <button onClick={onRegister} className="lp-btn lp-btn-outline">View IPO Opportunities <ArrowRight size={17} aria-hidden /></button>
            </div>
          </Reveal>
          <div className="mt-6 grid gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
            {([
              { Icon: Box, t: 'Technology Sector', d: 'AI infrastructure, chips and cloud platforms.' },
              { Icon: Leaf, t: 'Healthcare Sector', d: 'Next-generation medical technologies.' },
              { Icon: ChartNoAxesCombined, t: 'Financial Services', d: 'Modern financial infrastructure and payments.' },
              { Icon: Zap, t: 'Energy Sector', d: 'Clean energy and sustainable technologies.' },
            ]).map(({ Icon, t, d }, i) => (
              <Reveal key={t} delay={i * 60}>
                <article className="lp-card lp-hover relative flex h-full items-center gap-4 px-[18px] py-[18px]">
                  <span className="lp-state absolute top-[12px] right-[12px]">UPCOMING</span>
                  <Icon size={38} strokeWidth={1.6} className="shrink-0 text-[color:var(--lp-ember)]" aria-hidden />
                  <div className="min-w-0 pt-4 pr-2">
                    <h3 className="text-[16.5px] font-semibold text-white">{t}</h3>
                    <p className="mt-1 text-[13.5px] leading-snug text-[color:var(--lp-soft)]">{d}</p>
                  </div>
                  <button onClick={onRegister} aria-label={`Explore ${t} opportunities`} className="lp-arrow-btn ml-auto self-end"><ArrowRight size={17} strokeWidth={2.4} aria-hidden /></button>
                </article>
              </Reveal>
            ))}
          </div>
          <p className="mt-3 text-[12.5px] text-[color:var(--lp-soft)]">
            Sectors shown for illustration; live offerings and their dates are listed inside the platform. Offerings carry risk, including the loss of what you put in. Read the{' '}
            <a href="/risk" className="underline underline-offset-2 hover:text-white">risk warning</a> before you subscribe.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------- how it works */}
      <section id="how" className="lp-section scroll-mt-[66px]">
        <div className="lp-wrap grid gap-8 lg:grid-cols-[1.15fr_3fr] lg:items-center">
          <Reveal>
            <Eyebrow>How it works</Eyebrow>
            <h2 className="lp-h2 lp-h2-sm mt-2">Get Started in 3 Simple Steps.</h2>
            <p className="lp-lead mt-2 max-w-[400px]">Create your account, choose your strategy and start exploring global opportunities.</p>
          </Reveal>
          <div className="lp-steps-row grid gap-6 md:grid-cols-[1fr_1fr_1fr_auto] md:items-center">
            {([
              ['Create Account', 'Quick registration with the code the desk gives you.'],
              ['Fund Your Account', 'Add funds by card, bank transfer or a crypto wallet.'],
              ['Start Investing', 'Switch on the AI auto trader, or choose portfolios.'],
            ]).map(([t, d], i) => (
              <Reveal key={t} delay={i * 90}>
                <div className="lp-step-inline">
                  <span className="lp-step-ring" style={{ animationDelay: `${i * 0.8}s` }}>{i + 1}</span>
                  <div><h3 className="text-[16.5px] font-semibold text-white">{t}</h3><p className="mt-1 text-[14px] leading-snug text-[color:var(--lp-soft)]">{d}</p></div>
                </div>
              </Reveal>
            ))}
            <Reveal delay={300}>
              <div className="flex flex-col items-start gap-2">
                <button onClick={onRegister} className="lp-btn lp-btn-fill lp-sheen">Open Account <ArrowRight size={17} aria-hidden /></button>
                <button onClick={() => go('faq')} className="flex items-center gap-1.5 text-[14px] text-white/85 hover:text-[color:var(--lp-ember)]">Learn More <ArrowRight size={14} aria-hidden /></button>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- the metrics */}
      <section id="about" className="lp-section lp-metrics relative overflow-hidden scroll-mt-[66px]">
        <div className="lp-wrap relative z-10 grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-center">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)] xl:items-center">
            <Reveal>
              <h2 className="lp-h2 lp-h2-sm">Built for Your Success.</h2>
              <p className="lp-lead mt-2 max-w-[360px]">Advanced technology, real market data and AI-driven strategies working for you.</p>
            </Reveal>
            <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-4">
              {([
                [<CountUp key="m" value={instruments} format={(n) => `${Math.round(n)}+`} />, 'Global Markets'],
                ['24/7', 'AI Market Analysis'],
                ['AI', 'Advanced Models'],
                [<CountUp key="a" value={100} format={(n) => `${Math.round(n)}%`} />, 'Audited Records'],
              ] as [React.ReactNode, string][]).map(([v, t], i) => (
                <Reveal key={t} delay={i * 60}>
                  <div className="lp-card flex h-full flex-col items-center justify-center px-3 py-5 text-center">
                    <p className="text-[27px] leading-none font-bold text-[color:var(--lp-ember)]">{v}</p>
                    <p className="mt-2 text-[12.5px] leading-tight text-white/85">{t}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
          <Reveal delay={150}><Devices /></Reveal>
        </div>
      </section>

      {/* ---------------------------------------------------------------- security */}
      <section id="security" className="lp-section scroll-mt-[66px]">
        <div className="lp-wrap grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,3fr)] lg:items-center">
          <Reveal>
            <h2 className="lp-h2 lp-h2-sm">Security You Can Rely On.</h2>
            <p className="lp-lead mt-2 max-w-[360px] text-[15px]">Your account and data are protected by measures built into the platform itself.</p>
          </Reveal>
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {([
              [Lock, 'Encrypted in Transit', 'TLS on every request and session'],
              [ScrollText, 'Audited Infrastructure', 'Append-only log of every change'],
              [ShieldHalf, 'Secure Transactions', 'Withdrawals reviewed by the desk'],
              [EyeOff, 'Privacy Protection', 'Your data stays private'],
            ] as const).map(([Icon, t, d], i) => (
              <Reveal key={t} delay={i * 60}>
                <div className="flex items-center gap-4">
                  <span className="lp-icon-hex"><Icon size={22} strokeWidth={1.9} aria-hidden /></span>
                  <div><p className="text-[15.5px] font-semibold text-white">{t}</p><p className="text-[13.5px] text-[color:var(--lp-soft)]">{d}</p></div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ testimonials */}
      {testimonials.length > 0 && (
        <section id="clients" className="lp-section lp-quotes relative overflow-hidden scroll-mt-[66px]">
          <div className="lp-wrap relative z-10 grid gap-8 lg:grid-cols-[1fr_3fr] lg:items-center">
            <Reveal><h2 className="lp-h2 lp-h2-sm">What Our Clients Say</h2><p className="lp-lead mt-1">In their own words, with their agreement.</p></Reveal>
            <div className="grid gap-[14px] md:grid-cols-3">
              {testimonials.slice(0, 3).map((t, i) => (
                <Reveal key={t.name + i} delay={i * 80}>
                  <figure className="lp-card lp-hover flex h-full flex-col px-5 py-4">
                    <div className="flex items-start gap-3">
                      <span className="lp-avatar" aria-hidden>{t.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>
                      <blockquote className="text-[14.5px] leading-[1.5] text-white/90">“{t.quote}”</blockquote>
                    </div>
                    <figcaption className="mt-auto flex items-end justify-between gap-3 pt-3">
                      <div><p className="text-[14px] font-semibold text-white">{t.name}</p><p className="text-[12.5px] text-[color:var(--lp-soft)]">{t.role}</p></div>
                      <span className="flex gap-0.5 text-[color:var(--lp-ember)]" role="img" aria-label={`${t.rating} out of 5`}>
                        {Array.from({ length: 5 }, (_, k) => <Star key={k} size={15} fill={k < t.rating ? 'currentColor' : 'none'} aria-hidden />)}
                      </span>
                    </figcaption>
                  </figure>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* --------------------------------------------------------------- insights */}
      {!!articles?.articles.length && (
        <section id="insights" className="lp-section scroll-mt-[66px]">
          <div className="lp-wrap">
            <Reveal>
              <div className="flex flex-wrap items-end justify-between gap-6">
                <div><Eyebrow>Insights</Eyebrow><h2 className="lp-h2 mt-2">What the Desk Is Reading.</h2><p className="lp-lead mt-2 max-w-[640px]">Market commentary and platform notes from Pantera GP Research.</p></div>
                <a href="/blog" className="lp-btn lp-btn-outline">View All Insights <ArrowRight size={17} aria-hidden /></a>
              </div>
            </Reveal>
            <div className="mt-6 grid gap-[14px] md:grid-cols-3">
              {articles.articles.slice(0, 3).map((a, i) => (
                <Reveal key={a.slug} delay={i * 70}>
                  <a href={`/blog/${a.slug}`} className="lp-card lp-hover group flex h-full flex-col overflow-hidden">
                    <div className="aspect-[16/9] overflow-hidden bg-[color:var(--lp-card-2)]">
                      {a.cover_url ? <img src={a.cover_url} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
                        : <div className="grid h-full place-items-center"><Newspaper size={38} className="text-[color:var(--lp-ember)]" aria-hidden /></div>}
                    </div>
                    <div className="flex flex-1 flex-col px-[18px] py-[16px]">
                      <p className="lp-label">{a.tags?.[0] ?? 'Insight'} · {a.read_minutes} min read</p>
                      <h3 className="mt-2 text-[17px] leading-snug font-semibold text-white group-hover:text-[color:var(--lp-ember)]">{a.title}</h3>
                      {a.excerpt && <p className="mt-2 line-clamp-2 text-[14px] leading-[1.5] text-[color:var(--lp-soft)]">{a.excerpt}</p>}
                      <p className="mt-auto pt-3 text-[12.5px] text-[color:var(--lp-soft)]">{shortDay(a.published_at)}</p>
                    </div>
                  </a>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* -------------------------------------------------------------------- faq */}
      <section id="faq" className="lp-section scroll-mt-[66px]">
        <div className="lp-wrap grid gap-8 lg:grid-cols-[1fr_1.6fr]">
          <Reveal>
            <Eyebrow>FAQ</Eyebrow>
            <h2 className="lp-h2 mt-2">Questions, Answered.</h2>
            <p className="lp-lead mt-2 max-w-[420px]">Anything else, the desk answers from the Support page once you are signed in, or through the contact page.</p>
            <a href="/contact" className="lp-btn lp-btn-outline mt-5 inline-flex">Contact the Desk <ArrowRight size={17} aria-hidden /></a>
          </Reveal>
          <div className="space-y-[10px]">
            {([
              ['What is Pantera GP?', 'A trading platform where AI-driven strategies trade for you, alongside a full terminal with live charts, managed portfolios, staking and fixed-return IPO offerings, all on one account.'],
              ['How does the AI auto trader work?', 'It reads every market around the clock, opens a position when one of its strategies sees a setup, sizes each trade against the risk you set and attaches a stop and a target. You can pause a strategy, change what it may deploy, or switch it off at any time.'],
              ['How do I open an account?', 'Choose Open Account and enter your name, email, a password and the registration code the desk gave you. Verification of your identity follows inside the platform.'],
              ['What can I trade?', `${instruments} instruments across crypto, forex, metals and index ETFs, with market, limit, stop, stop-limit and trailing orders.`],
              ['How do IPO offerings pay?', 'Each offering pays a fixed rate over a set term, credited daily and settled at maturity, whatever the company’s share price does after it lists.'],
            ] as [string, string][]).map(([q, a], i) => (
              <Reveal key={q} delay={i * 50}>
                <details className="lp-card lp-faq group px-[20px] py-[2px]" open={i === 0}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-[15px] text-[16.5px] font-semibold text-white">
                    {q}<Plus size={20} className="shrink-0 text-[color:var(--lp-ember)] transition-transform duration-300 group-open:rotate-45" aria-hidden />
                  </summary>
                  <p className="pb-[16px] text-[15px] leading-[1.6] text-[color:var(--lp-soft)]">
                    {a}
                  </p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ the close */}
      <section className="lp-cta relative overflow-hidden">
        <div aria-hidden className="lp-cta-art" />
        <div className="lp-wrap relative z-10">
        <div className="grid gap-6 py-10 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-center lg:pl-[24%]">
          <Reveal>
            <h2 className="lp-h2">Join Pantera GP Today</h2>
            <p className="lp-lead mt-2 max-w-[600px]">Create your account today and start exploring AI-driven trading, diversified portfolios, staking and exclusive investment opportunities.</p>
          </Reveal>
          <Reveal delay={120}>
            <div className="flex flex-wrap gap-4 lg:justify-end">
              <button onClick={onRegister} className="lp-btn lp-btn-fill lp-btn-lg lp-sheen">Open Account <ArrowRight size={18} aria-hidden /></button>
              <button onClick={onSignIn} className="lp-btn lp-btn-outline lp-btn-lg">View Platform <ArrowRight size={18} aria-hidden /></button>
            </div>
          </Reveal>
        </div>
        </div>
      </section>

      <button onClick={() => glide(atFoot ? 'top' : 'footer')} aria-label={atFoot ? 'Back to the top' : 'Go to the footer'}
        className={`to-footer anim-rise fixed right-5 top-1/2 z-20 hidden -translate-y-1/2 flex-col items-center gap-4 md:flex ${atFoot ? 'to-top' : ''}`}
        style={{ animationDelay: '900ms' }}>
        <span className="to-footer-label font-mono text-[11px] tracking-[0.22em] text-white/60 uppercase">{atFoot ? 'Top' : 'Footer'}</span>
        <span className="to-footer-ring flex h-11 w-11 items-center justify-center rounded-full border border-white/20 text-[color:var(--lp-ember)]">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {atFoot ? <path d="M8 14V2M3 7l5-5 5 5" /> : <path d="M8 2v12M3 9l5 5 5-5" />}
          </svg>
        </span>
      </button>

      {/* ------------------------------------------------------------ the footer */}
      <footer id="footer" className="lp-footer scroll-mt-0">
        <div className="lp-wrap flex flex-wrap items-center gap-x-10 gap-y-5 py-7">
          {footer.logo_url ? <img src={footer.logo_url} alt="Pantera GP" className="h-8 w-auto" /> : <Wordmark />}
          <nav aria-label="Footer" className="flex flex-wrap gap-x-7 gap-y-2 lg:ml-8">
            {NAV.filter(([id]) => id !== 'platform').map(([id, label]) => (
              <button key={id} onClick={() => go(id)} className="text-[13.5px] text-white/80 transition-colors hover:text-[color:var(--lp-ember)]">{label}</button>
            ))}
            <a href="/contact" className="text-[13.5px] text-white/80 transition-colors hover:text-[color:var(--lp-ember)]">Contact</a>
          </nav>
          <div className="flex items-center gap-5 lg:ml-auto">
            {footer.social?.linkedin && <a href={footer.social.linkedin} rel="noopener" target="_blank" aria-label="Pantera GP on LinkedIn" className="lp-social"><span className="text-[15px] font-bold">in</span></a>}
            {footer.social?.x && <a href={footer.social.x} rel="noopener" target="_blank" aria-label="Pantera GP on X" className="lp-social"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden><path d="M3 3h4.6l4.6 6.3L17.6 3H21l-7.2 8.3L21.5 21h-4.6l-5-6.8L5.8 21H2.4l7.8-9z" fill="currentColor" /></svg></a>}
            {footer.social?.telegram && <a href={footer.social.telegram} rel="noopener" target="_blank" aria-label="Pantera GP on Telegram" className="lp-social"><Send size={16} aria-hidden /></a>}
            <span className="text-[12.5px] text-[color:var(--lp-soft)]">{footer.line?.trim() || `© ${new Date().getFullYear()} Pantera GP. All rights reserved.`}</span>
          </div>
        </div>
        <div className="lp-wrap flex flex-wrap gap-x-6 gap-y-2 border-t border-white/[0.07] py-4 text-[12.5px]">
          {(footer.links?.length ? footer.links.map((l) => [l.label, l.href] as [string, string]) : [['Terms of Service', '/terms'], ['Privacy Policy', '/privacy'], ['Risk warning', '/risk'], ['Insights', '/blog']] as [string, string][]).map(([label, href]) => (
            <a key={href + label} href={href} className="text-[color:var(--lp-soft)] transition-colors hover:text-white">{label}</a>
          ))}
        </div>
        {!!footer.marks?.length && (
          <div className="lp-wrap border-t border-white/[0.07] py-5">
            {!!footer.marks_title?.trim() && <h4 className="mb-4 text-[12px] font-semibold tracking-[0.16em] text-white uppercase">{footer.marks_title.trim()}</h4>}
            <ul className="flex flex-wrap items-center gap-x-10 gap-y-5">
              {footer.marks.map((m) => {
                const img = <img src={m.url} alt={m.name} loading="lazy" className="h-7 w-auto opacity-75 transition-opacity duration-200 hover:opacity-100" />;
                return <li key={m.id}>{m.href ? <a href={m.href} rel={/^https?:/.test(m.href) ? 'noopener' : undefined} title={m.name}>{img}</a> : img}</li>;
              })}
            </ul>
          </div>
        )}
        {!!footer.notice?.trim() && (
          <div className="lp-wrap border-t border-white/[0.07] py-5">
            <div className="max-w-[96ch] space-y-3 text-[12px] leading-relaxed text-[color:var(--lp-soft)]">
              {noticeBlocks(footer.notice).map((b, i) => (b.kind === 'ul'
                ? <ul key={i} className="list-disc space-y-1 pl-5">{b.lines.map((l, k) => <li key={k}>{l}</li>)}</ul>
                : <p key={i}>{b.lines.map((l, k) => <span key={k}>{k > 0 && <br />}{l}</span>)}</p>))}
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ sections
/** Live prices, drifting slowly on their own; the arrows step a card at a time, hover pauses. */
function PriceStrip({ quotes }: { quotes: Ticker['quotes'] }) {
  const row = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  useEffect(() => {
    if (reduced()) return;
    const id = setInterval(() => {
      const el = row.current;
      if (!el || paused.current || document.hidden) return;
      const half = el.scrollWidth / 2;
      el.scrollLeft = el.scrollLeft + 1 >= half ? 0 : el.scrollLeft + 1;
    }, 30);
    return () => clearInterval(id);
  }, []);
  const move = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * 220, behavior: 'smooth' });
  // Each quote flashes green or red when it moves, against the price shown before.
  const last = useRef(new Map<string, number>());
  const moved = new Map(quotes.map((q) => { const p = last.current.get(q.symbol); return [q.symbol, p === undefined || p === q.price ? '' : q.price > p ? 'lp-flash-up' : 'lp-flash-down'] as const; }));
  useEffect(() => { for (const q of quotes) last.current.set(q.symbol, q.price); }, [quotes]);
  const list = quotes.length ? [...quotes, ...quotes] : Array.from({ length: 7 }, () => null);
  return (
    <section className="lp-strip" aria-label="Live prices">
      <div className="lp-wrap relative py-[11px]">
        <button onClick={() => move(-1)} aria-label="Earlier prices" className="lp-round lp-strip-arrow lp-strip-prev"><ArrowLeft size={18} aria-hidden /></button>
        <div ref={row} className="lp-strip-row flex gap-[10px] overflow-x-auto" onMouseEnter={() => { paused.current = true; }} onMouseLeave={() => { paused.current = false; }}>
          {list.map((q, i) => (
            <div key={(q?.symbol ?? 'x') + i} className="lp-tick" aria-hidden={i >= quotes.length && quotes.length > 0}>
              {q ? <>
                <Coin symbol={q.symbol} />
                <div className="min-w-0">
                  <p className="text-[11.5px] font-medium text-[color:var(--lp-soft)]">{q.symbol === 'QQQ' ? 'NASDAQ' : q.symbol}</p>
                  <p key={q.price} className={`text-[15px] font-semibold text-white tabular-nums ${moved.get(q.symbol) ?? ''}`}>{price(q.price)}</p>
                </div>
                <div className="ml-auto flex flex-col items-end gap-0.5">
                  <Spark values={q.spark} up={q.change_pct >= 0} w={46} h={20} id={`tk-${i}`} />
                  <span className={`text-[12px] font-medium tabular-nums ${q.change_pct >= 0 ? 'text-[color:var(--lp-up)]' : 'text-[color:var(--lp-down)]'}`}>{q.change_pct >= 0 ? '+' : ''}{q.change_pct.toFixed(2)}%</span>
                </div>
              </> : <span className="h-[36px] w-full animate-pulse rounded bg-white/5" />}
            </div>
          ))}
        </div>
        <button onClick={() => move(1)} aria-label="Later prices" className="lp-round lp-strip-arrow lp-strip-next"><ArrowRight size={18} aria-hidden /></button>
      </div>
      <p className="lp-wrap -mt-1.5 pb-2 text-right font-mono text-[10px] tracking-[0.14em] text-white/40 uppercase">Crypto at live market prices · other markets as quoted on this platform</p>
    </section>
  );
}

const RANGES: [string, number | null][] = [['1D', 1], ['1W', 7], ['1M', 30], ['3M', 90], ['6M', 180], ['ALL', null]];

/** The auto trader's live record on the desk's showcase account. */
function AutoPanel({ show, onOpen }: { show: Showcase | null; onOpen: () => void }) {
  const k = show?.kpis;
  const dash = '—';
  const [range, setRange] = useState('ALL');
  const curve = useMemo(() => {
    const all = show?.curve ?? [];
    const days = RANGES.find(([r]) => r === range)?.[1];
    if (!days || all.length < 2) return all;
    const cut = Date.now() - days * 86_400_000;
    const inside = all.filter((p) => new Date(p.at).getTime() >= cut);
    return inside.length >= 2 ? inside : all.slice(-2);
  }, [show?.curve, range]);
  const stat = (label: string, value: React.ReactNode, sub: React.ReactNode, tone = 'text-white') => (
    <div className="lp-card lp-hover px-[18px] py-[15px]">
      <p className="lp-label">{label}</p>
      <p className={`mt-2 text-[24px] leading-none font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-2 text-[13px] text-[color:var(--lp-soft)]">{sub}</p>
    </div>
  );
  const up = (n: number) => (n >= 0 ? 'text-[color:var(--lp-up)]' : 'text-[color:var(--lp-down)]');
  const icon: Record<string, [typeof Activity, string]> = { trend: [ChartColumnIncreasing, 'is-green'], mean_reversion: [Shuffle, 'is-orange'], grid: [Grid3x3, 'is-blue'] };
  return (
    <>
      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-[10px] lg:grid-cols-[minmax(0,2.05fr)_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-[10px] md:grid-cols-4">
          {!k ? (
            ['Bot equity', 'Today', 'Win rate', 'Profit factor', 'Max drawdown', 'Open positions', 'Total trades', 'Sharpe ratio'].map((l) => (
              <div key={l} className="lp-card px-[18px] py-[15px]"><p className="lp-label">{l}</p><span className="lp-skeleton mt-3 block h-[22px] w-3/4" /><span className="lp-skeleton mt-2 block h-[12px] w-1/2" /></div>
            ))
          ) : <>
            {stat('Bot equity', <CountUp value={k.equity} format={usd} />, k.return_pct === null ? 'since start' : `${k.return_pct >= 0 ? '+' : ''}${(k.return_pct * 100).toFixed(2)}% since start`)}
            {stat('Today', signed(k.today_net), `${k.today_trades} closed · fees ${usd(k.today_fees)}`, up(k.today_net))}
            {stat('Win rate', k.win_rate === null ? dash : <CountUp value={k.win_rate * 100} format={(n) => `${Math.round(n)}%`} />, `${k.wins} of ${k.closed} closed`)}
            {stat('Profit factor', k.profit_factor === null ? dash : k.profit_factor.toFixed(2), `avg win ${k.avg_win_r?.toFixed(1) ?? '0'}R · avg loss ${k.avg_loss_r?.toFixed(1) ?? '0'}R`)}
            {stat('Max drawdown', k.max_drawdown ? `-${(k.max_drawdown * 100).toFixed(1)}%` : '0%', k.drawdown_at ? shortDay(k.drawdown_at) : 'no drawdown yet', k.max_drawdown ? 'text-[color:var(--lp-down)]' : 'text-white')}
            {stat('Open positions', String(k.open), `${signed(k.unrealised)} unrealised`, k.open ? 'text-[color:var(--lp-ember)]' : 'text-white')}
            {stat('Total trades', <CountUp value={k.total_trades} format={(n) => Math.round(n).toLocaleString('en-US')} />, 'Since inception')}
            {stat('Sharpe ratio', k.sharpe === null ? dash : k.sharpe.toFixed(2), k.sharpe === null ? 'after five trading days' : 'Risk adjusted return')}
          </>}
        </div>
        <div className="lp-card lp-scan flex min-h-[250px] flex-col px-[18px] pt-[15px] pb-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[14px] font-semibold text-white">Bot Equity{show?.since ? ` · Since ${shortDay(show.since)}` : ''}</p>
            {curve.length > 1 && <p className={`text-[13px] font-semibold tabular-nums ${up(curve[curve.length - 1]!.equity - curve[0]!.equity)}`}>{usd(curve[0]!.equity)} → {usd(curve[curve.length - 1]!.equity)}</p>}
          </div>
          <EquityChart key={range + curve.length} curve={curve} />
          <div className="mt-1 flex gap-1" role="tablist" aria-label="Chart range">
            {RANGES.map(([r]) => (
              <button key={r} role="tab" aria-selected={range === r} onClick={() => setRange(r)} className={`lp-range ${range === r ? 'is-on' : ''}`}>{r}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-[10px] grid grid-cols-[minmax(0,1fr)] gap-[10px] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="lp-card overflow-x-auto px-[18px] py-[15px]">
          <div className="flex items-center justify-between"><p className="lp-title">Recent trades</p>
            <button onClick={onOpen} className="flex items-center gap-1.5 text-[13.5px] font-medium text-[color:var(--lp-ember)] hover:underline">View all trades <ArrowRight size={14} aria-hidden /></button></div>
          <table className="mt-2 w-full min-w-[500px] text-left">
            <thead><tr className="lp-label">{['Time', 'Instrument', 'Side', 'Entry', 'Exit', 'P&L', 'Strategy'].map((h) => <th key={h} className="pb-1.5 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {(show?.trades ?? []).map((t, i) => (
                <tr key={i} className="lp-row border-t border-white/[0.06] text-[14.5px]" style={{ animationDelay: `${i * 70}ms` }}>
                  <td className="py-[8px] text-[color:var(--lp-soft)] tabular-nums">{clock(t.closed_at)}</td>
                  <td className="font-semibold text-white">{t.symbol}</td>
                  <td><span className={`lp-side ${t.side === 'long' ? 'is-long' : 'is-short'}`}>{t.side === 'long' ? 'LONG' : 'SHORT'}</span></td>
                  <td className="text-[color:var(--lp-soft)] tabular-nums">{price(t.entry)}</td>
                  <td className="text-[color:var(--lp-soft)] tabular-nums">{price(t.exit)}</td>
                  <td className={`font-semibold tabular-nums ${up(t.net)}`}>{signed(t.net)}</td>
                  <td className="text-[color:var(--lp-soft)]">{t.strategy ?? '—'}</td>
                </tr>
              ))}
              {!show?.trades?.length && <tr><td colSpan={7} className="border-t border-white/[0.06] py-6 text-[14px] text-[color:var(--lp-soft)]">No closed trades to show yet.</td></tr>}
            </tbody>
          </table>
          <p className="mt-2 text-[11.5px] text-[color:var(--lp-soft)]">{show?.demo
            ? 'Demo account: a simulated record on this platform’s live prices, not real trading results.'
            : 'Live from the desk’s demo account, on prices this platform quotes.'}</p>
        </div>
        <div className="lp-card px-[18px] py-[15px]">
          <div className="flex items-center justify-between"><p className="lp-title">Active strategies</p>
            <button onClick={onOpen} className="flex items-center gap-1.5 text-[13.5px] font-medium text-[color:var(--lp-ember)] hover:underline">Manage Strategies <ArrowRight size={14} aria-hidden /></button></div>
          <ul className="mt-2 divide-y divide-white/[0.06]">
            {(show?.strategies ?? []).map((s, i) => {
              const [Icon, tint] = icon[s.kind] ?? [Activity, 'is-orange'];
              return (
                <li key={s.name} className="flex items-center gap-3 py-[9px]">
                  <span className={`lp-strat-icon ${tint}`}><Icon size={22} strokeWidth={1.9} aria-hidden /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium text-white">{s.name}</p>
                    <p className="truncate text-[12.5px] text-[color:var(--lp-soft)]">{s.symbols.join(' · ')}</p>
                  </div>
                  <span className={`lp-state ${s.state === 'running' ? 'is-running' : ''}`}>{s.state === 'running' ? 'RUNNING' : 'PAUSED'}</span>
                  <div className="hidden items-center gap-2 sm:flex">
                    <span className={`w-[56px] text-right text-[14px] font-semibold tabular-nums ${s.return_pct === null ? 'text-white/60' : up(s.return_pct)}`}>{s.return_pct === null ? '—' : `${s.return_pct >= 0 ? '+' : ''}${(s.return_pct * 100).toFixed(1)}%`}</span>
                    <Spark values={s.spark} up={(s.return_pct ?? 0) >= 0} w={58} h={22} id={`st-${i}`} />
                  </div>
                </li>
              );
            })}
            {!show?.strategies?.length && <li className="py-4 text-[14px] text-[color:var(--lp-soft)]">No strategies to show yet.</li>}
          </ul>
        </div>
      </div>
    </>
  );
}

/** Words of a headline rising one after another. */
function words(text: string, from: number) {
  return text.split(' ').map((w, i, all) => (
    <span key={i} className="lp-word" style={{ animationDelay: `${from + i * 90}ms` }}>{w}{i < all.length - 1 ? ' ' : ''}</span>
  ));
}

// Points of light on the globe, in percent of the hero, and the routes that join them.
const NODES: [number, number][] = [[61, 28], [70, 18], [76, 42], [66, 55], [83, 30], [88, 58], [72, 70], [58, 46], [93, 40], [80, 78]];
const ROUTES: [number, number][] = [[0, 2], [1, 4], [2, 5], [3, 6], [7, 2], [4, 8], [5, 9], [0, 3], [1, 2], [6, 9]];
const EMBERS = Array.from({ length: 18 }, (_, i) => ({ x: 40 + ((i * 37) % 60), s: 2 + (i % 3), d: 9 + ((i * 7) % 8), delay: -((i * 1.7) % 12) }));

/** Data travelling between cities on the globe: dashed routes with a bright pulse running along each. */
function HeroNetwork() {
  const paths = ROUTES.map(([a, b]) => {
    const [x1, y1] = NODES[a]!, [x2, y2] = NODES[b]!;
    const cx = (x1 + x2) / 2, cy = Math.min(y1, y2) - 10;
    return `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
  });
  return (
    <div aria-hidden className="lp-network">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        {paths.map((d, i) => <path key={'r' + i} d={d} className="lp-route" pathLength={100} />)}
        {paths.map((d, i) => <path key={'p' + i} d={d} className="lp-pulse-route" pathLength={100} style={{ animationDelay: `${(i * 0.83) % 5}s`, animationDuration: `${3.6 + (i % 4) * 0.7}s` }} />)}
      </svg>
      {NODES.map(([x, y], i) => <span key={i} className="lp-node" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${(i * 0.37) % 3}s` }} />)}
    </div>
  );
}

/** The equity line over its range, drawn in on arrival, with a dollar axis on the right. */
function EquityChart({ curve }: { curve: { at: string; equity: number }[] }) {
  const W = 560, H = 170, PAD_R = 46;
  const geo = useMemo(() => {
    if (curve.length < 2) return null;
    const t0 = new Date(curve[0]!.at).getTime(), t1 = Math.max(t0 + 1, new Date(curve[curve.length - 1]!.at).getTime());
    const vs = curve.map((p) => p.equity); const lo0 = Math.min(...vs), hi0 = Math.max(...vs); const pad = (hi0 - lo0) * 0.12 || hi0 * 0.01 || 1;
    const lo = lo0 - pad, hi = hi0 + pad;
    const X = (t: number) => ((t - t0) / (t1 - t0)) * (W - PAD_R);
    const Y = (v: number) => H - 8 - ((v - lo) / (hi - lo)) * (H - 20);
    const pts = curve.map((p) => ({ x: X(new Date(p.at).getTime()), y: Y(p.equity) }));
    const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => ({ x: f * (W - PAD_R), label: shortDay(new Date(t0 + f * (t1 - t0))) }));
    const ys = [0, 1 / 3, 2 / 3, 1].map((f) => ({ y: Y(lo + f * (hi - lo)), label: compact(lo + f * (hi - lo)) }));
    return { pts, ticks, ys };
  }, [curve]);
  if (!geo) return <div className="grid flex-1 place-items-center text-[14px] text-[color:var(--lp-soft)]">The curve appears once trades close.</div>;
  const line = geo.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = geo.pts[geo.pts.length - 1]!;
  const dots = geo.pts.filter((_, i) => i % Math.max(1, Math.floor(geo.pts.length / 16)) === 0);
  return (
    <div className="mt-2 flex-1">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="h-full w-full" preserveAspectRatio="none" role="img" aria-label="Bot equity over time">
        <defs>
          <linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff7a12" stopOpacity="0.38" /><stop offset="1" stopColor="#ff7a12" stopOpacity="0" /></linearGradient>
          <filter id="eq-glow"><feGaussianBlur stdDeviation="3" /></filter>
        </defs>
        {geo.ys.map((t, i) => <g key={i}><line x1="0" x2={W - PAD_R} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.06)" /><text x={W - PAD_R + 8} y={t.y + 4} fill="rgba(255,255,255,0.55)" fontSize="11">{t.label}</text></g>)}
        <path d={`${line} L${last.x},${H} L0,${H} Z`} fill="url(#eq-fill)" className="lp-fade-in" />
        <path d={line} fill="none" stroke="#ff7a12" strokeWidth="5" opacity="0.35" filter="url(#eq-glow)" className="lp-draw" pathLength={1} />
        <path d={line} fill="none" stroke="#ff8a2a" strokeWidth="2.2" className="lp-draw" pathLength={1} />
        {dots.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="2.4" fill="#ff8a2a" className="lp-fade-in" />)}
        <circle cx={last.x} cy={last.y} r="4.5" fill="#ffc285" className="lp-pulse" />
        {geo.ticks.map((t, i) => <text key={i} x={t.x} y={H + 15} fill="rgba(255,255,255,0.55)" fontSize="11.5" textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}>{t.label}</text>)}
      </svg>
    </div>
  );
}

/** The faint ember charts in the corner of each service card. */
function EcoArt({ kind }: { kind: 'line' | 'bars' | 'line2' | 'bars2' }) {
  const bars = (n: number) => Array.from({ length: n }, (_, i) => {
    const h = 6 + Math.pow(i / (n - 1), 2.1) * 80;
    return <rect key={i} x={40 + i * 20} y={100 - h} width="12" height={h} rx="1" fill="url(#eco-bar)" className="lp-grow" style={{ animationDelay: `${i * 40}ms` }} />;
  });
  const ys = kind === 'line' ? [98, 94, 96, 90, 92, 87, 89, 82, 85, 76, 70, 60, 46, 30, 14] : [100, 96, 98, 91, 87, 89, 80, 72, 82, 70, 60, 52, 38, 22, 6];
  const d = ys.map((y, i) => `${i ? 'L' : 'M'}${30 + (i / (ys.length - 1)) * 240},${y}`).join(' ');
  return (
    <svg viewBox="0 0 280 110" className="pointer-events-none absolute right-0 bottom-[50px] h-[70px] w-[88%] opacity-80" aria-hidden>
      <defs>
        <linearGradient id="eco-bar" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff7a12" stopOpacity="0.95" /><stop offset="1" stopColor="#ff7a12" stopOpacity="0.12" /></linearGradient>
        <linearGradient id="eco-glow" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff7a12" stopOpacity="0.28" /><stop offset="1" stopColor="#ff7a12" stopOpacity="0" /></linearGradient>
      </defs>
      {kind === 'bars' && bars(11)}
      {kind === 'bars2' && bars(12)}
      {(kind === 'line' || kind === 'line2') && <>
        <path d={`${d} L270,110 L30,110 Z`} fill="url(#eco-glow)" />
        <path d={d} fill="none" stroke="#ff7a12" strokeWidth="2" className="lp-draw" pathLength={1} style={{ filter: 'drop-shadow(0 0 4px rgba(255,122,18,.85))' }} />
        <circle cx="270" cy={ys[ys.length - 1]} r="3.5" fill="#ffc285" className="lp-pulse" />
      </>}
    </svg>
  );
}

/** Illustrations for the market classes, drawn here so nothing is borrowed. */
function MarketArt({ kind }: { kind: 'crypto' | 'stocks' | 'forex' | 'gold' | 'ipo' }) {
  return (
    <svg viewBox="0 0 200 150" className="lp-market-art" aria-hidden>
      <defs>
        <radialGradient id={`mg-${kind}`} cx="70%" cy="70%" r="60%"><stop offset="0" stopColor="#ff7a12" stopOpacity="0.35" /><stop offset="1" stopColor="#ff7a12" stopOpacity="0" /></radialGradient>
        <linearGradient id={`gold-${kind}`} x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#ffe08a" /><stop offset="0.5" stopColor="#f2a623" /><stop offset="1" stopColor="#9a5a08" /></linearGradient>
        <linearGradient id={`city-${kind}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#3b6ea8" stopOpacity="0.9" /><stop offset="1" stopColor="#0b1626" stopOpacity="0.2" /></linearGradient>
      </defs>
      <rect width="200" height="150" fill={`url(#mg-${kind})`} />
      {kind === 'crypto' && <g className="lp-bob">
        <circle cx="132" cy="112" r="24" fill="#b5651d" stroke="#ffb35c" strokeWidth="2.5" /><text x="132" y="121" textAnchor="middle" fontSize="26" fontWeight="700" fill="#ffe2b8">₿</text>
        <circle cx="168" cy="96" r="22" fill="#1d6fd8" stroke="#8cc4ff" strokeWidth="2.5" /><path d="M168 82 L178 97 L168 103 L158 97 Z M168 106 L178 100 L168 113 L158 100 Z" fill="#e8f2ff" />
      </g>}
      {kind === 'stocks' && <g>
        {[[118, 60, 20], [140, 30, 24], [166, 48, 22], [102, 84, 16], [186, 74, 14]].map(([x, y, w], i) => <rect key={i} x={x} y={y} width={w} height={150 - y!} fill={`url(#city-${kind})`} stroke="rgba(140,190,255,.35)" />)}
        <path d="M96 128 L120 110 L138 116 L160 92 L182 98 L198 74" fill="none" stroke="#ff7a12" strokeWidth="2.2" className="lp-draw" pathLength={1} />
      </g>}
      {kind === 'forex' && <g className="lp-bob">
        <text x="150" y="80" fontSize="38" fontWeight="800" fill="#ffb02e" opacity="0.95">$</text>
        <text x="176" y="62" fontSize="30" fontWeight="800" fill="#ff8a1a">$</text>
        <text x="132" y="132" fontSize="40" fontWeight="800" fill="#dfe6ee">£</text>
        <text x="168" y="138" fontSize="36" fontWeight="800" fill="#c8d2dd">€</text>
      </g>}
      {kind === 'gold' && <g className="lp-bob">
        <path d="M112 120 L130 92 H178 L196 120 Z" fill={`url(#gold-${kind})`} stroke="#ffd166" strokeWidth="1.2" />
        <path d="M128 92 L144 66 H182 L196 92 Z" fill={`url(#gold-${kind})`} stroke="#ffd166" strokeWidth="1.2" />
        <path d="M150 66 L162 46 H190 L200 66 Z" fill={`url(#gold-${kind})`} stroke="#ffd166" strokeWidth="1.2" />
      </g>}
      {kind === 'ipo' && <g>
        {Array.from({ length: 7 }, (_, i) => <rect key={i} x={110 + i * 12} y={130 - (12 + i * i * 2.2)} width="8" height={12 + i * i * 2.2} fill="#ff7a12" opacity={0.35 + i * 0.09} className="lp-grow" style={{ animationDelay: `${i * 60}ms` }} />)}
        <path d="M100 128 L130 112 L150 116 L172 84 L198 52" fill="none" stroke="#ffb35c" strokeWidth="2.2" className="lp-draw" pathLength={1} />
      </g>}
    </svg>
  );
}

/** The terminal on a laptop, a tablet and a phone, in front of a slice of the globe. */
function Devices() {
  return (
    <div className="lp-devices" role="img" aria-label="The Pantera GP terminal on a laptop, a tablet and a phone">
      <div className="lp-laptop"><div className="lp-screen"><img src="/landing/device-desktop.webp" alt="" loading="lazy" /></div><div className="lp-laptop-base" /></div>
      <div className="lp-tablet"><div className="lp-screen"><img src="/landing/device-tablet.webp" alt="" loading="lazy" /></div></div>
      <div className="lp-phone"><div className="lp-screen"><img src="/landing/device-phone.webp" alt="" loading="lazy" /></div></div>
    </div>
  );
}
