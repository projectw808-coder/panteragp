import fs from 'node:fs';

const fix = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) throw new Error('MISSING in ' + f + ': ' + a.slice(0, 70));
  fs.writeFileSync(f, s.replace(a, b));
};

const w = 'web/src/client-workspace.tsx';

fix(w, `type Person = Client & {
  phone: string | null; country: string | null;
  date_of_birth: string | null; address: string | null;
};`,
`type Person = Client & {
  phone: string | null; country: string | null;
  date_of_birth: string | null; address: string | null;
  commission_bps: number | null; spread_bps: number | null;
};`);

fix(w, "        {tab === 'trading' && <Trading h={holdings.data} />}",
  "        {tab === 'trading' && <Trading id={id} c={c} h={holdings.data} admin={admin} onChanged={refresh} />}");

fix(w, "function Trading({ h }: { h: Holdings | null }) {",
  `/**
 * What this client pays to trade, alongside what they have traded.
 *
 * Two dials and no others. Commission is charged on the size of every fill and spread moves
 * the executed price against them — both are costs, both apply the same way whichever
 * direction a trade goes, and no value of either can turn a loss into a gain. They are the
 * price of the service, so the client sees them on their own profile and on every fill.
 */
function TradingTerms({ id, c, onChanged }: { id: string; c: Person; onChanged: () => void }) {
  const [commission, setCommission] = useState(c.commission_bps === null ? '' : String(c.commission_bps));
  const [spread, setSpread] = useState(c.spread_bps === null ? '' : String(c.spread_bps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const bps = (v: string) => (v.trim() === '' ? null : Number(v));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api(\`/clients/\${id}\`, {
        method: 'PATCH',
        body: JSON.stringify({ commission_bps: bps(commission), spread_bps: bps(spread) }),
      });
      setDone(true);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className={\`\${card} space-y-3\`}>
      <div>
        <h3 className="metric-label">Trading terms</h3>
        <p className="mt-1 text-xs text-slate-ink">
          In basis points — 25 is 0.25%. Empty means the desk default. Applied to every fill
          from the moment you save, and shown to the client on their profile.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Labelled label="Commission (bps)">
          <input className={\`\${field} w-28\`} type="number" step="0.01" min="0" max="500"
            placeholder="0" value={commission} onChange={(e) => setCommission(e.target.value)} />
        </Labelled>
        <Labelled label="Spread (bps)">
          <input className={\`\${field} w-28\`} type="number" step="0.01" min="0" max="500"
            placeholder="0" value={spread} onChange={(e) => setSpread(e.target.value)} />
        </Labelled>
        <button className={btn} disabled={busy}>{busy ? 'Saving…' : 'Save terms'}</button>
      </div>
      <p className="text-xs text-slate-ink">
        Commission is charged on the notional of a fill and spread moves the fill price
        against the client. Both are costs on every trade, either direction — neither is
        able to turn a loss into a profit.
      </p>
      {error && <p role="alert" className={alertBox}>{error}</p>}
      {done && <p role="status" className="font-mono text-xs text-slate-ink">Saved.</p>}
    </form>
  );
}

function Trading({ id, c, h, admin, onChanged }: {
  id: string; c: Person; h: Holdings | null; admin: boolean; onChanged: () => void;
}) {`);

fix(w, `  if (!h) return <Empty>Loading…</Empty>;
  return (
    <div className="space-y-4">
      <Table head={['Symbol', 'Qty', 'Avg', 'Price', 'Unrealised']}>`,
`  if (!h) return <Empty>Loading…</Empty>;
  return (
    <div className="space-y-4">
      {admin && <TradingTerms id={id} c={c} onChanged={onChanged} />}
      <Table head={['Symbol', 'Qty', 'Avg', 'Price', 'Unrealised']}>`);

console.log('ok');
