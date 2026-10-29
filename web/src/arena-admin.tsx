import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  ArrowDown, ArrowUp, Award, Check, Clock, Crown, Gift, Play, Plus, Square, Trash2,
  Trophy, Users, X, Zap,
} from 'lucide-react';
import { alertBox, btn, field, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { ACH_ICON } from './arena.tsx';
import { OFFER_ICON, offerAction, timeLeft } from './offers.tsx';

/**
 * The desk's Arena, laid out like the client's own: a control room for the season, the
 * offers the desk runs, the bonuses waiting on a decision, the achievement rewards and the
 * leagues with the real people behind the aliases. Paying anything needs funds:credit and
 * changing rewards needs admin; the server refuses anyone else whatever this page shows.
 */

type Bonus = {
  source: 'achievement' | 'offer'; id: number; client_id: string; name: string; title: string; detail: string;
  at: string; amount: number; status: 'pending' | 'paid' | 'declined' | 'none'; decided_at: string | null;
};
type Row = { client_id: string; name: string; alias: string; rank: number; score: number; ret: number; move: 'up' | 'down' | 'stay' };
type Overview = { month: string; ends_at: string; leagues: { league: string; profiles: number; ranked: number; rows: Row[] }[]; bonuses: Bonus[] };
type Rule = { min?: number; percent?: number; fixed?: number; cap?: number; first_only?: boolean; product?: 'stake' | 'pot' | 'ipo'; multiplier?: number; prizes?: number[] };
type OfferRow = {
  id: number; kind: Kind; title: string; body: string; rule: Rule; terms: string; starts_at: string | null; ends_at: string | null;
  status: 'draft' | 'active' | 'ended'; popup: boolean; notify: boolean; auto_pay: boolean;
  grants: number; clients: number; paid: number; pending: number;
};
type Reward = { code: string; title: string; note: string; icon: string; default_bonus: number | null; bonus: number | null; enabled: boolean;
  holders: number; members: number; paid: number; pending: number };
type Kind = 'deposit_bonus' | 'product_bonus' | 'achievement_multiplier' | 'league_prize' | 'announcement';

const LEAGUE_TONE: Record<string, string> = { bronze: '#c0743a', silver: '#a9b4c2', gold: '#f5c542', platinum: '#7fd1d8', diamond: '#9db4ff' };
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const pctOf = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(2)}%`;
const usd = (n: number) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The kinds of offer, each with a ready example the desk can start from. */
const KINDS: { kind: Kind; name: string; blurb: string; title: string; body: string; rule: Rule }[] = [
  { kind: 'deposit_bonus', name: 'Deposit bonus', blurb: 'A bonus on every deposit above a threshold.',
    title: 'Deposit week: 10% on $10k+', body: 'Deposit $10,000 or more this week and we add a trading bonus on top.', rule: { min: 10000, percent: 10, cap: 2500 } },
  { kind: 'product_bonus', name: 'Product bonus', blurb: 'Reward an IPO subscription, a stake or a pot payment.',
    title: 'IPO kickstart: $100 on $5k+', body: 'Subscribe $5,000 or more to any offering and receive $100.', rule: { product: 'ipo', min: 5000, fixed: 100 } },
  { kind: 'achievement_multiplier', name: 'Double rewards', blurb: 'Multiply achievement bonuses for a while.',
    title: 'Double rewards weekend', body: 'Every achievement bonus earned this weekend is worth double.', rule: { multiplier: 2 } },
  { kind: 'league_prize', name: 'League prize pool', blurb: 'Extra prizes for the top of every league at month end.',
    title: 'Season prize pool', body: 'The top three in every league win extra prizes when the month closes.', rule: { prizes: [250, 150, 100] } },
  { kind: 'announcement', name: 'Announcement', blurb: 'A message only, as a pop-up and in the bell.',
    title: 'New in the Arena', body: 'Leagues and achievements are live. See where you rank.', rule: {} },
];

export function ArenaAdmin({ admin }: { admin: boolean }) {
  const ov = useApi<Overview>('/arena/overview');
  const offers = useApi<OfferRow[]>('/arena/offers');
  const rewards = useApi<Reward[]>('/arena/rewards');
  const [tab, setTab] = useState<'offers' | 'bonuses' | 'rewards' | 'leagues'>('offers');
  const d = ov.data;
  const pending = d?.bonuses.filter((b) => b.status === 'pending') ?? [];
  const live = offers.data?.filter((o) => o.status === 'active') ?? [];
  const reload = () => { ov.reload(); offers.reload(); rewards.reload(); };

  if (ov.error) return <p role="alert" className={alertBox}>{ov.error}</p>;

  return (
    <div className="stagger mx-auto max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Arena</PageTitle>
        {d && <span className="x-badge is-locked"><Trophy size={13} className="mr-1.5" aria-hidden />Season {monthName(d.month)}</span>}
        {!admin && <span className="text-xs text-slate-ink">View only. Offers, rewards and payouts are an admin's to change.</span>}
      </div>

      <ControlRoom d={d} live={live.length} pending={pending} />

      <div role="tablist" aria-label="Arena admin" className="x-segs ad-tabs">
        {([['offers', 'Offers', live.length], ['bonuses', 'Bonuses to decide', pending.length], ['rewards', 'Achievement rewards', 0], ['leagues', 'Leagues', 0]] as const).map(([k, l, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={tab === k ? 'is-on' : ''}>
            {l}{n ? <span className="ad-count">{n}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'offers' && <Offers rows={offers.data} admin={admin} onChange={reload} />}
      {tab === 'bonuses' && <Bonuses rows={d?.bonuses} admin={admin} onChange={reload} />}
      {tab === 'rewards' && <Rewards rows={rewards.data} admin={admin} onChange={reload} />}
      {tab === 'leagues' && <Leagues d={d} />}
    </div>
  );
}

/** The season at a glance, in the same hero the client sees. */
function ControlRoom({ d, live, pending }: { d: Overview | null | undefined; live: number; pending: Bonus[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  if (!d) return <div className="x-card skeleton h-48" />;
  const ms = Math.max(0, new Date(d.ends_at).getTime() - now);
  const clock = [[Math.floor(ms / 86_400_000), 'days'], [Math.floor((ms % 86_400_000) / 3_600_000), 'hrs'], [Math.floor((ms % 3_600_000) / 60_000), 'min'], [Math.floor((ms % 60_000) / 1000), 'sec']] as const;
  const ranked = d.leagues.reduce((n, l) => n + l.ranked, 0);
  const members = d.leagues.reduce((n, l) => n + l.profiles, 0);
  const owed = pending.reduce((n, b) => n + b.amount, 0);
  const stats: [string, string, typeof Users][] = [
    ['Players', `${ranked} ranked of ${members}`, Users], ['Live offers', String(live), Zap],
    ['Bonuses to decide', `${pending.length} · ${usd(owed)}`, Gift], ['Leagues in play', String(d.leagues.filter((l) => l.ranked).length), Trophy],
  ];
  return (
    <section className="ar-hero" style={{ '--tone': '#ff9a3c' } as CSSProperties}>
      <div className="ad-hero-grid">
        <div className="ar-crest" aria-hidden>
          <svg viewBox="0 0 120 136"><path d="M60 4 L112 22 V66 C112 100 88 122 60 132 C32 122 8 100 8 66 V22 Z" fill="var(--tone)" fillOpacity="0.85" stroke="var(--tone)" strokeWidth="2.5" /></svg>
          <span className="ar-crest-icon"><Crown size={40} strokeWidth={1.8} /></span>
          <span className="ar-crest-name">Desk</span>
        </div>
        <div className="min-w-0">
          <p className="text-[12.5px] text-mist">Arena control room</p>
          <p className="text-[26px] leading-tight font-extrabold tracking-tight">Season {monthName(d.month)}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stats.map(([l, v, Icon]) => (
              <div key={l} className="ad-stat"><Icon size={15} className="text-ember-ink" aria-hidden /><span className="text-[11.5px] text-mist">{l}</span><b>{v}</b></div>
            ))}
          </div>
        </div>
        <div className="ar-clock">
          <span className="text-[12px] text-mist">Season closes in</span>
          <div className="flex gap-1.5">{clock.map(([v, l]) => <span key={l} className="ar-clock-cell"><b>{String(v).padStart(2, '0')}</b><i>{l}</i></span>)}</div>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ offers

function Offers({ rows, admin, onChange }: { rows?: OfferRow[] | null; admin: boolean; onChange: () => void }) {
  const [building, setBuilding] = useState(false);
  const list = rows ?? [];
  return (
    <div className="space-y-4">
      {admin && !building && (
        <button type="button" onClick={() => setBuilding(true)} className="ad-new">
          <span className="ad-new-icon" aria-hidden><Plus size={22} /></span>
          <span className="text-left"><span className="block text-[15px] font-bold">Create an offer</span>
            <span className="block text-xs text-slate-ink">A deposit bonus, a product bonus, double rewards, a league prize pool or an announcement — sent as a pop-up and a notification when you activate it.</span></span>
        </button>
      )}
      {building && <OfferBuilder onDone={() => { setBuilding(false); onChange(); }} onCancel={() => setBuilding(false)} />}
      {!rows && <div className="skeleton h-40 rounded-xl" />}
      {rows && !list.length && !building && <p className="py-8 text-center text-sm text-slate-ink">No offers yet.</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        {list.map((o) => <OfferCard key={o.id} o={o} admin={admin} onChange={onChange} />)}
      </div>
    </div>
  );
}

function OfferCard({ o, admin, onChange }: { o: OfferRow; admin: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = OFFER_ICON[o.kind] ?? Gift;
  const live = o.status === 'active' && (!o.ends_at || new Date(o.ends_at).getTime() > Date.now());

  async function act(action: 'activate' | 'end' | 'delete') {
    if (action === 'activate' && !window.confirm(`Activate "${o.title}"?${o.notify ? ' Every client is notified.' : ''}${o.popup ? ' They see it as a pop-up.' : ''}`)) return;
    setBusy(true); setError(null);
    try { await api(`/arena/offers/${o.id}`, { method: 'PATCH', body: JSON.stringify({ action }) }); onChange(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <article className={`ad-offer ${live ? 'is-live' : o.status === 'draft' ? 'is-draft' : 'is-ended'}`}>
      <div className="flex items-start gap-3">
        <span className="of-card-icon" aria-hidden><Icon size={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold">{o.title}</p>
          <p className="text-[12px] text-slate-ink">{KINDS.find((k) => k.kind === o.kind)?.name}</p>
        </div>
        <span className={`x-badge ${live ? '' : o.status === 'draft' ? 'is-muted' : 'is-locked'}`}>
          {live ? <><i className="nav-live mr-1.5 block size-1.5 rounded-full bg-up" aria-hidden />Live</> : o.status === 'draft' ? 'Draft' : 'Ended'}
        </span>
      </div>
      {o.terms && <p className="mt-3 text-[13px] font-semibold">{o.terms}</p>}
      {o.body && <p className="mt-1 text-[12.5px] text-slate-ink">{o.body}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11.5px]">
        {o.popup && <span className="x-badge is-muted">Pop-up</span>}
        {o.notify && <span className="x-badge is-muted">Notification</span>}
        <span className="x-badge is-muted">{o.auto_pay ? 'Pays automatically' : 'Desk approves'}</span>
        {live && <span className="x-badge is-locked"><Clock size={11} className="mr-1" aria-hidden />{timeLeft(o.ends_at)}</span>}
        {!live && o.ends_at && o.status !== 'draft' && <span className="x-badge is-muted">Ended {dateOf(o.ends_at)}</span>}
      </div>
      {o.kind !== 'announcement' && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="x-mini-tile"><p className="text-[11px] text-mist">Qualified</p><p className="text-[15px] font-bold tabular-nums">{o.clients}</p></div>
          <div className="x-mini-tile"><p className="text-[11px] text-mist">Paid</p><p className="text-[15px] font-bold tabular-nums text-up">{usd(o.paid)}</p></div>
          <div className="x-mini-tile"><p className="text-[11px] text-mist">Waiting</p><p className="text-[15px] font-bold tabular-nums text-ember-ink">{usd(o.pending)}</p></div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-down">{error}</p>}
      {admin && (
        <div className="mt-3 flex flex-wrap gap-2">
          {o.status !== 'active' && o.status !== 'ended' && <button type="button" disabled={busy} onClick={() => act('activate')} className={`${btn} inline-flex items-center gap-1.5 !px-4 !py-1.5 text-xs`}><Play size={13} aria-hidden />Activate</button>}
          {live && <button type="button" disabled={busy} onClick={() => act('end')} className="x-btn-sm inline-flex items-center gap-1.5"><Square size={12} aria-hidden />End now</button>}
          {o.status === 'draft' && <button type="button" disabled={busy} onClick={() => act('delete')} className="x-btn-sm inline-flex items-center gap-1.5 hover:!border-down hover:!text-down"><Trash2 size={13} aria-hidden />Delete</button>}
        </div>
      )}
    </article>
  );
}

/** Building an offer, with the client's pop-up previewed live beside the form. */
function OfferBuilder({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<Kind>('deposit_bonus');
  const base = KINDS.find((k) => k.kind === kind)!;
  const [title, setTitle] = useState(base.title);
  const [body, setBody] = useState(base.body);
  const [rule, setRule] = useState<Rule>(base.rule);
  const [mode, setMode] = useState<'percent' | 'fixed'>(base.rule.percent ? 'percent' : 'fixed');
  const [days, setDays] = useState(7);
  const [popup, setPopup] = useState(true);
  const [notify, setNotify] = useState(true);
  const [autoPay, setAutoPay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pick(k: Kind) {
    const b = KINDS.find((x) => x.kind === k)!;
    setKind(k); setTitle(b.title); setBody(b.body); setRule(b.rule); setMode(b.rule.percent ? 'percent' : 'fixed');
  }
  const set = (patch: Rule) => setRule((r) => ({ ...r, ...patch }));
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const cleanRule = useMemo<Rule>(() => {
    if (kind === 'deposit_bonus' || kind === 'product_bonus') {
      const { percent, fixed, cap: c, ...rest } = rule;
      return mode === 'percent' ? { ...rest, percent, cap: c } : { ...rest, fixed };
    }
    return rule;
  }, [rule, mode, kind]);
  const terms = previewTerms(kind, cleanRule);
  const preview = { kind, product: cleanRule.product ?? null };

  async function save(activate: boolean) {
    setBusy(true); setError(null);
    try {
      const ends = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
      const o = await api<{ id: number }>('/arena/offers', { method: 'POST', body: JSON.stringify({ kind, title, body, rule: cleanRule, ends_at: ends, popup, notify, auto_pay: autoPay }) });
      if (activate) await api(`/arena/offers/${o.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'activate' }) });
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const Icon = OFFER_ICON[kind] ?? Gift;
  return (
    <section className="x-card x-holo grid gap-5 p-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        <div className="flex items-center gap-2"><Zap size={17} className="text-ember-ink" aria-hidden /><h2 className="section-title">New offer</h2>
          <button type="button" onClick={onCancel} className="x-btn-sm ml-auto inline-flex items-center gap-1"><X size={13} aria-hidden />Cancel</button></div>

        <fieldset>
          <legend className="ad-legend"><span className="sk-step">1</span>Type</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5" role="radiogroup">
            {KINDS.map((k) => {
              const KI = OFFER_ICON[k.kind] ?? Gift;
              return (
                <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} onClick={() => pick(k.kind)} className={`sk-opt ad-kind ${kind === k.kind ? 'is-on' : ''}`}>
                  <KI size={20} aria-hidden /><span className="text-[12.5px] font-bold">{k.name}</span><span className="text-[11px] leading-snug text-slate-ink">{k.blurb}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {kind !== 'announcement' && (
          <fieldset>
            <legend className="ad-legend"><span className="sk-step">2</span>Rule</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {kind === 'product_bonus' && (
                <Lbl text="Product">
                  <select className={`${field} w-full`} value={rule.product ?? 'ipo'} onChange={(e) => set({ product: e.target.value as Rule['product'] })}>
                    <option value="ipo">IPO subscription</option><option value="stake">New stake</option><option value="pot">Payment into a pot</option>
                  </select>
                </Lbl>
              )}
              {(kind === 'deposit_bonus' || kind === 'product_bonus') && (
                <>
                  <Lbl text={kind === 'deposit_bonus' ? 'Minimum deposit (USD)' : 'Minimum amount (USD)'}>
                    <input className={`${field} w-full`} type="number" min="0" value={rule.min ?? ''} onChange={(e) => set({ min: num(e.target.value) })} />
                  </Lbl>
                  <Lbl text="Bonus is">
                    <div className="x-qgroups">
                      {(['percent', 'fixed'] as const).map((m) => <button key={m} type="button" onClick={() => setMode(m)} className={mode === m ? 'is-on' : ''}>{m === 'percent' ? '% of amount' : 'Fixed $'}</button>)}
                    </div>
                  </Lbl>
                  {mode === 'percent' ? (
                    <>
                      <Lbl text="Percent"><input className={`${field} w-full`} type="number" min="0" step="0.5" value={rule.percent ?? ''} onChange={(e) => set({ percent: num(e.target.value) })} /></Lbl>
                      <Lbl text="Cap per bonus (USD, optional)"><input className={`${field} w-full`} type="number" min="0" value={rule.cap ?? ''} onChange={(e) => set({ cap: num(e.target.value) })} /></Lbl>
                    </>
                  ) : (
                    <Lbl text="Bonus (USD)"><input className={`${field} w-full`} type="number" min="0" value={rule.fixed ?? ''} onChange={(e) => set({ fixed: num(e.target.value) })} /></Lbl>
                  )}
                  {kind === 'deposit_bonus' && (
                    <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={!!rule.first_only} onChange={(e) => set({ first_only: e.target.checked })} />First deposit only</label>
                  )}
                </>
              )}
              {kind === 'achievement_multiplier' && (
                <Lbl text="Multiplier">
                  <div className="x-qgroups">{[1.5, 2, 3].map((m) => <button key={m} type="button" onClick={() => set({ multiplier: m })} className={rule.multiplier === m ? 'is-on' : ''}>×{m}</button>)}</div>
                </Lbl>
              )}
              {kind === 'league_prize' && [0, 1, 2].map((i) => (
                <Lbl key={i} text={`${['1st', '2nd', '3rd'][i]} place (USD)`}>
                  <input className={`${field} w-full`} type="number" min="0" value={rule.prizes?.[i] ?? ''}
                    onChange={(e) => { const p = [...(rule.prizes ?? [])]; p[i] = Number(e.target.value) || 0; set({ prizes: p.filter((x, j) => x > 0 || j < i) }); }} />
                </Lbl>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset>
          <legend className="ad-legend"><span className="sk-step">{kind === 'announcement' ? 2 : 3}</span>Message</legend>
          <div className="space-y-2">
            <Lbl text="Title"><input className={`${field} w-full`} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></Lbl>
            <Lbl text="Message"><textarea className={`${field} min-h-20 w-full`} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} /></Lbl>
          </div>
        </fieldset>

        <fieldset>
          <legend className="ad-legend"><span className="sk-step">{kind === 'announcement' ? 3 : 4}</span>Run and deliver</legend>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-mist">Runs for</span>
            {[1, 3, 7, 14, 30].map((n) => <button key={n} type="button" onClick={() => setDays(n)} className={`x-btn-sm ${days === n ? 'is-on' : ''}`}>{n} day{n > 1 ? 's' : ''}</button>)}
            <button type="button" onClick={() => setDays(0)} className={`x-btn-sm ${days === 0 ? 'is-on' : ''}`}>Until ended</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-[13px]">
            <label className="flex items-center gap-2"><input type="checkbox" checked={popup} onChange={(e) => setPopup(e.target.checked)} />Pop-up on the client's screen</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Notification in the bell</label>
            {kind !== 'announcement' && <label className="flex items-center gap-2"><input type="checkbox" checked={autoPay} onChange={(e) => setAutoPay(e.target.checked)} />Pay automatically (otherwise the desk approves each)</label>}
          </div>
        </fieldset>

        {error && <p role="alert" className={alertBox}>{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || !title.trim()} onClick={() => save(true)} className={`${btn} inline-flex items-center gap-2`}><Play size={15} aria-hidden />Activate now</button>
          <button type="button" disabled={busy || !title.trim()} onClick={() => save(false)} className="x-btn-sm !h-auto !px-4">Save as draft</button>
        </div>
      </div>

      <div className="min-w-0">
        <p className="mb-2 text-[12.5px] text-mist">What the client sees</p>
        <div className="ad-preview">
          <div className="of-pop !static !w-full !max-w-none">
            <div className="of-burst" aria-hidden><Icon size={34} strokeWidth={1.8} /></div>
            <p className="of-kicker">{kind === 'announcement' ? 'From the desk' : 'Limited-time offer'}</p>
            <h3 className="text-center text-[20px] leading-tight font-extrabold">{title || 'Your title'}</h3>
            {body && <p className="mt-2 text-center text-[13.5px] text-slate-ink">{body}</p>}
            {terms && <p className="of-terms">{terms}</p>}
            <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-mist"><Clock size={13} aria-hidden />{days ? `${days}d 0h left` : 'No end date'}</p>
            {offerAction(preview) && <span className="mt-4 flex items-center justify-center rounded-full bg-ember px-5 py-2.5 text-[14px] font-bold text-graphite">{offerAction(preview)![1]}</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

const Lbl = ({ text, children }: { text: string; children: React.ReactNode }) => (
  <label className="block"><span className="text-[12px] text-mist">{text}</span><span className="mt-1 block">{children}</span></label>
);

/** The same one-sentence terms the server writes, for the preview before anything is saved. */
function previewTerms(kind: Kind, r: Rule) {
  const earn = r.percent ? `${r.percent}%${r.cap ? ` (up to ${usd(r.cap)})` : ''}` : usd(r.fixed ?? 0);
  if (kind === 'deposit_bonus') return `Each ${r.first_only ? 'first ' : ''}deposit of ${usd(r.min ?? 0)} or more earns a ${earn} bonus${r.percent ? ' of the deposit' : ''}.`;
  if (kind === 'product_bonus') return `Each ${{ stake: 'stake', pot: 'payment into a portfolio', ipo: 'IPO subscription' }[r.product ?? 'ipo']} of ${usd(r.min ?? 0)} or more earns a ${earn} bonus.`;
  if (kind === 'achievement_multiplier') return `Achievement bonuses earned during the offer are worth ×${r.multiplier ?? 2}.`;
  if (kind === 'league_prize') return `At month end the top ${(r.prizes ?? []).length} of every league win ${(r.prizes ?? []).map(usd).join(' / ')}.`;
  return '';
}

// ------------------------------------------------------------------ bonuses

function Bonuses({ rows, admin, onChange }: { rows?: Bonus[] | null; admin: boolean; onChange: () => void }) {
  const [view, setView] = useState<'pending' | 'decided'>('pending');
  const list = (rows ?? []).filter((b) => (view === 'pending' ? b.status === 'pending' : b.status === 'paid' || b.status === 'declined'));
  return (
    <section className="x-card x-holo space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Gift size={17} className="text-ember-ink" aria-hidden />
        <h2 className="section-title">Bonuses</h2>
        <div className="x-qgroups ml-auto" role="tablist">
          {(['pending', 'decided'] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)} className={`!px-3 whitespace-nowrap ${view === k ? 'is-on' : ''}`}>{k === 'pending' ? 'To decide' : 'Decided'}</button>)}
        </div>
      </div>
      {!rows && <div className="skeleton h-24 rounded-lg" />}
      {rows && !list.length && <p className="py-8 text-center text-sm text-slate-ink">{view === 'pending' ? 'Nothing is waiting.' : 'Nothing decided yet.'}</p>}
      <ul className="ar-bonuses">{list.map((b) => <BonusRow key={`${b.source}-${b.id}`} b={b} admin={admin} onDone={onChange} />)}</ul>
    </section>
  );
}

function BonusRow({ b, admin, onDone }: { b: Bonus; admin: boolean; onDone: () => void }) {
  const [amount, setAmount] = useState(String(b.amount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(approve: boolean) {
    setBusy(true); setError(null);
    try {
      const path = b.source === 'offer' ? `/arena/grants/${b.id}/decide` : `/arena/bonuses/${b.id}/decide`;
      await api(path, { method: 'POST', body: JSON.stringify({ approve, ...(approve ? { amount: Number(amount) } : {}) }) });
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <li>
      <span className="x-chip !h-9 !w-9" aria-hidden>{b.source === 'offer' ? <Zap size={16} /> : <Award size={16} />}</span>
      <span className="min-w-0 flex-1">
        <a href={`#/clients/${b.client_id}`} className="block truncate text-[14px] font-semibold hover:text-ember-ink hover:underline">{b.name}</a>
        <span className="block text-xs text-slate-ink">{b.source === 'offer' ? 'Offer' : 'Achievement'}: {b.title}{b.detail ? ` · ${b.detail}` : ''} · {dateOf(b.at)}</span>
        {error && <span role="alert" className="block text-xs text-down">{error}</span>}
      </span>
      {b.status === 'pending' ? (admin ? (
        <span className="flex items-center gap-2">
          <span className="sk-amount w-28">
            <input className="x-field w-full !h-9 !text-[14px]" type="number" min="1" step="1" value={amount} aria-label="Bonus in USD" onChange={(e) => setAmount(e.target.value)} />
            <span className="sk-amount-unit !text-[11px]">USD</span>
          </span>
          <button type="button" className={`${btn} !px-3 !py-1.5 text-xs`} disabled={busy || !(Number(amount) > 0)} onClick={() => decide(true)}><Check size={13} className="mr-1 inline" aria-hidden />Pay</button>
          <button type="button" className="x-btn-sm inline-flex items-center gap-1 hover:!border-down hover:!text-down" disabled={busy} onClick={() => decide(false)}><X size={13} aria-hidden />Decline</button>
        </span>
      ) : <span className="x-badge is-locked">{usd(b.amount)} pending</span>)
        : <span className={`x-badge ${b.status === 'paid' ? '' : 'is-muted'}`}>{b.status === 'paid' ? `${usd(b.amount)} paid` : 'Declined'}{b.decided_at ? ` · ${dateOf(b.decided_at)}` : ''}</span>}
    </li>
  );
}

// ------------------------------------------------------------------ achievement rewards

function Rewards({ rows, admin, onChange }: { rows?: Reward[] | null; admin: boolean; onChange: () => void }) {
  return (
    <section className="x-card x-holo space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Award size={17} className="text-ember-ink" aria-hidden />
        <h2 className="section-title">Achievement rewards</h2>
        <span className="ml-auto text-xs text-slate-ink">Set each bonus, or switch an achievement off. Changes apply to what is earned from now on.</span>
      </div>
      {!rows && <div className="skeleton h-40 rounded-lg" />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {(rows ?? []).map((r) => <RewardCard key={r.code} r={r} admin={admin} onChange={onChange} />)}
      </div>
    </section>
  );
}

function RewardCard({ r, admin, onChange }: { r: Reward; admin: boolean; onChange: () => void }) {
  const [bonus, setBonus] = useState(r.bonus === null ? '' : String(r.bonus));
  const [busy, setBusy] = useState(false);
  const Icon = ACH_ICON[r.icon] ?? Award;
  const dirty = (r.bonus === null ? '' : String(r.bonus)) !== bonus;
  async function save(enabled = r.enabled) {
    setBusy(true);
    try { await api(`/arena/rewards/${r.code}`, { method: 'PUT', body: JSON.stringify({ bonus: bonus === '' ? null : Number(bonus), enabled }) }); onChange(); }
    finally { setBusy(false); }
  }
  return (
    <article className={`ar-ach ${r.enabled ? 'is-earned' : ''}`}>
      <span className={`ar-badge ${r.enabled ? 'is-earned' : ''}`} aria-hidden><Icon size={26} /></span>
      <p className="mt-2 text-center text-[13.5px] font-bold">{r.title}</p>
      <p className="text-center text-[11px] leading-snug text-slate-ink">{r.note}</p>
      <p className="mt-1 text-[11px] text-mist">{r.holders} of {r.members} hold it{r.paid ? ` · ${usd(r.paid)} paid` : ''}</p>
      <div className="mt-auto w-full space-y-2 pt-3">
        <div className="sk-amount">
          <input className="x-field w-full !h-9 !text-[14px]" type="number" min="0" placeholder="No bonus" disabled={!admin} value={bonus}
            aria-label={`${r.title} bonus in USD`} onChange={(e) => setBonus(e.target.value)} />
          <span className="sk-amount-unit !text-[11px]">USD</span>
        </div>
        {admin && (
          <div className="flex gap-1.5">
            <button type="button" disabled={busy || !dirty} onClick={() => save()} className={`${btn} flex-1 !px-2 !py-1 text-[11.5px] disabled:opacity-40`}>Save</button>
            <button type="button" role="switch" aria-checked={r.enabled} aria-label={`${r.title} offered`} disabled={busy} onClick={() => save(!r.enabled)} className={`st-switch !mt-0 ${r.enabled ? 'is-on' : ''}`}><span /></button>
          </div>
        )}
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ leagues

function Leagues({ d }: { d: Overview | null | undefined }) {
  const busiest = d?.leagues.slice().sort((a, b) => b.ranked - a.ranked)[0]?.league ?? 'gold';
  const [league, setLeague] = useState<string | null>(null);
  const shown = league ?? busiest;
  const table = d?.leagues.find((l) => l.league === shown);
  const top = table?.rows.slice(0, 3) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist">
        {(d?.leagues ?? []).map((l) => (
          <button key={l.league} type="button" role="tab" aria-selected={shown === l.league} onClick={() => setLeague(l.league)}
            className={`ad-league ${shown === l.league ? 'is-on' : ''}`} style={{ '--tone': LEAGUE_TONE[l.league] } as CSSProperties}>
            <Trophy size={18} aria-hidden /><span className="font-bold">{cap(l.league)}</span><span className="text-[11px] text-slate-ink">{l.ranked} ranked · {l.profiles} players</span>
          </button>
        ))}
      </div>
      {!!top.length && (
        <section className="x-card x-holo p-5">
          <div className="ar-podium">
            {[top[1], top[0], top[2]].map((r, i) => r ? (
              <div key={r.client_id} className={`ar-step is-${r.rank}`} style={{ '--i': i } as CSSProperties}>
                <span className={`ar-medal is-${r.rank} !h-8 !w-8 !text-[14px]`}>{r.rank}</span>
                <a href={`#/clients/${r.client_id}`} className="mt-2 max-w-full truncate px-1 text-[13px] font-bold hover:underline">{r.name}</a>
                <span className="text-[11px] text-slate-ink">{r.alias}</span>
                <span className="ar-step-block"><b>{r.score}</b><i>{pctOf(r.ret)}</i></span>
              </div>
            ) : <div key={i} />)}
          </div>
        </section>
      )}
      <section className="x-card x-holo space-y-3 p-5">
        {!table?.rows.length ? <p className="py-6 text-center text-sm text-slate-ink">Nobody ranked in {cap(shown)} yet.</p> : (
          <div className="table-card x-table overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="x-thead"><tr>{['#', 'Client', 'Alias', 'Return', 'Score', 'If it ended now'].map((h, i) => <th key={h} className={`px-3 py-2 ${i >= 3 ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
              <tbody>
                {table.rows.map((r) => (
                  <tr key={r.client_id} className="border-t border-white/5">
                    <td className="px-3 py-2 tabular-nums">{r.rank <= 3 ? <span className={`ar-medal is-${r.rank}`}>{r.rank}</span> : r.rank}</td>
                    <td className="px-3 py-2"><a href={`#/clients/${r.client_id}`} className="font-semibold hover:text-ember-ink hover:underline">{r.name}</a></td>
                    <td className="px-3 py-2 text-slate-ink">{r.alias}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${r.ret >= 0 ? 'text-up' : 'text-down'}`}>{pctOf(r.ret)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.score}</td>
                    <td className="px-3 py-2 text-right">{r.move === 'up' ? <span className="x-badge"><ArrowUp size={12} className="mr-1" aria-hidden />Up</span> : r.move === 'down' ? <span className="x-badge is-bad"><ArrowDown size={12} className="mr-1" aria-hidden />Down</span> : <span className="x-badge is-muted">Stays</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

