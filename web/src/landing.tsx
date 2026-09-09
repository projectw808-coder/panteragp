/**
 * The public front of the site: what someone sees before they sign in.
 *
 * Built to the structure in DESIGN.md — dark full-bleed hero, hard cut to a white feature
 * grid, dark CTA band to close. The app itself lives behind "Launch app"; this page never
 * touches the API, so it renders for a visitor who has no account and no session.
 */

const CTA = 'inline-flex items-center gap-2 rounded-full bg-ember px-5 py-2 font-mono text-sm font-medium text-graphite hover:brightness-95';
const CTA_GHOST = 'inline-flex items-center gap-2 rounded-full border border-mist/40 px-5 py-2 font-mono text-sm text-vellum hover:border-vellum';

/** The editorial kicker above a section heading — orange outline, never a filled pill. */
const Kicker = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-block rounded-md border border-ember px-2 py-0.5 text-xs font-medium text-ember">
    {children}
  </span>
);

export function Landing({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  return (
    <div className="h-full overflow-auto bg-vellum">
      {/* ---------------------------------------------------------------- hero */}
      <section className="relative flex min-h-[80vh] flex-col bg-obsidian">
        <nav className="flex items-center gap-6 px-8 py-6">
          <span className="font-display text-xl text-vellum">PanteraAI</span>
          <span className="font-mono text-xs text-mist">/// trading desk</span>
          <div className="ml-auto flex items-center gap-3">
            <button onClick={onSignIn} className="font-mono text-sm text-mist hover:text-vellum">Sign in</button>
            <button onClick={onRegister} className={CTA}>Launch app</button>
          </div>
        </nav>

        <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col justify-center px-8 py-20">
          <div className="max-w-3xl">
            <Kicker>Execution &amp; relationship, one system</Kicker>
            <h1 className="mt-6 font-display text-5xl font-light leading-[0.95] tracking-tight text-vellum md:text-7xl lg:text-[80px]">
              Every trade is a<br />conversation you<br />already know
              <span className="text-ember"> ///</span>
            </h1>
            <p className="mt-8 max-w-xl text-base leading-relaxed text-mist">
              Charts, execution and the client record in one place. The desk sees the
              position and the person behind it — funding, documents, tickets and every
              decision, on one timeline.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <button onClick={onRegister} className={CTA}>Open an account</button>
              <button onClick={onSignIn} className={CTA_GHOST}>Sign in</button>
            </div>
          </div>
        </div>

        {/* Abstract, diagrammatic, monochrome — the system's imagery rule. No photography. */}
        <div className="pointer-events-none absolute right-8 bottom-0 hidden h-64 w-[420px] items-end gap-1 opacity-40 lg:flex" aria-hidden>
          {[38, 62, 45, 78, 55, 90, 70, 96, 64, 84, 52, 74, 46, 68, 40].map((h, i) => (
            <div key={i} className="flex-1 border-t border-mist/30" style={{ height: `${h}%` }}>
              <div className="mx-auto h-full w-px bg-mist/40" />
              <div className={`mx-auto -mt-[70%] h-[40%] w-full ${i % 3 === 0 ? 'bg-ember/70' : 'bg-mist/25'}`} />
            </div>
          ))}
        </div>
      </section>

      {/* Hard cut to white — no gradient between the two. */}
      <section className="mx-auto max-w-[1200px] px-8 py-20">
        <Kicker>What it does</Kicker>
        <h2 className="mt-5 max-w-2xl font-display text-4xl font-light leading-tight tracking-tight text-obsidian">
          A trading platform that remembers who it is trading for
        </h2>

        <div className="mt-10 grid gap-[10px] lg:grid-cols-[1.6fr_1fr]">
          <Card
            title="The desk"
            body="Live charting with drawing tools and indicators, market, limit, stop and trailing orders, positions priced continuously, and an execution engine that keeps filling whether anyone is watching or not."
            figure={<Candles />}
          />
          <Card
            title="Paper by default"
            body="Simulated money, simulated wallets, no live fund movement anywhere in the code. The separation is structural, not a setting."
            figure={<Gauge />}
          />
        </div>

        <div className="mt-[10px] grid gap-[10px] md:grid-cols-3">
          <Card
            title="One client record"
            body="Balances in any currency, crypto wallets, portfolios, orders, fills, funding, documents, tickets and notes — on a single timeline the whole desk reads."
          />
          <Card
            title="Audited by the database"
            body="Every change to a client or a trade is written by a trigger to an append-only log. Not an updated-at column: an immutable record of who changed what."
          />
          <Card
            title="Compliance in the flow"
            body="KYC review, withdrawal thresholds and flags sit where the work happens, not in a separate tool nobody opens."
          />
        </div>
      </section>

      {/* ------------------------------------------------------------ CTA band */}
      <section className="bg-obsidian">
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
    <div className="flex flex-col rounded-[20px] bg-bone p-6 md:p-8">
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
        <g key={x} stroke="#71717a" fill="none">
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
    <path d="M20 95 A 80 80 0 0 1 108 18" fill="none" stroke="#ff7817" strokeWidth="2" />
    <line x1="100" y1="95" x2="140" y2="42" stroke="#71717a" strokeWidth="1.5" />
    <circle cx="100" cy="95" r="3" fill="#71717a" />
    <text x="20" y="108" fontSize="9" fill="#71717a" fontFamily="monospace">SHORT</text>
    <text x="152" y="108" fontSize="9" fill="#71717a" fontFamily="monospace">LONG</text>
  </svg>
);
