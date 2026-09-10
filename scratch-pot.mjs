import fs from 'node:fs';

const p = 'web/src/portfolio.tsx';
let s = fs.readFileSync(p, 'utf8');
const fix = (a, b) => {
  if (!s.includes(a)) throw new Error('MISSING: ' + a.slice(0, 80));
  s = s.replace(a, b);
};

fix(`  const [action, setAction] = useState<'contribute' | 'withdraw' | null>(null);
  const [rate, setRate] = useState(false);`,
`  const [action, setAction] = useState<'contribute' | 'withdraw' | null>(null);
  const [rate, setRate] = useState(false);
  const [history, setHistory] = useState(false);`);

// What it has earned sits beside what is in it: the balance answers "how much", and this
// answers "is it doing anything", which is the reason to have opened it.
fix(`          <span className="text-right">
            <span className="metric-label block">Balance</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums">
              {money(p.balance, p.currency)}
            </span>
          </span>
        </span>
      </div>`,
`          <span className="text-right">
            <span className="metric-label block">Earned</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums text-up">
              {Number(p.earned) > 0 ? \`+\${money(p.earned, p.currency)}\` : \`0 \${p.currency}\`}
            </span>
          </span>
          <span className="text-right">
            <span className="metric-label block">Balance</span>
            <span className="block font-mono text-lg leading-tight font-medium tabular-nums">
              {money(p.balance, p.currency)}
            </span>
          </span>
        </span>
      </div>

      {/* Money already asked for, so a second request is made knowing about the first. */}
      {Number(p.requested) > 0 && (
        <p className="mt-2 rounded-md border border-ember/40 bg-ember/10 px-2.5 py-1.5 text-xs text-ember">
          {money(p.requested, p.currency)} is with the desk waiting on a decision.
        </p>
      )}`);

fix(`        {on.client_id && (
          <button onClick={() => { setRate((v) => !v); setError(null); }}`,
`        <button onClick={() => setHistory((v) => !v)}
          className="rounded-md border border-pebble px-2.5 py-1 text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
          {history ? 'hide history' : 'history'}
        </button>
        {on.client_id && (
          <button onClick={() => { setRate((v) => !v); setError(null); }}`);

fix(`      {rate && on.client_id && (
        <SetRate p={p} on={on} onDone={() => { setRate(false); onDone(); }} onError={setError} />
      )}`,
`      {history && <History p={p} />}
      {rate && on.client_id && (
        <SetRate p={p} on={on} onDone={() => { setRate(false); onDone(); }} onError={setError} />
      )}`);

fs.writeFileSync(p, s);
console.log('ok');
