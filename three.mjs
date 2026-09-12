import fs from 'node:fs';

const sub = (s, find, put) => {
  if (!s.includes(find)) throw new Error('anchor missing: ' + find.slice(0, 70));
  return s.replace(find, () => put);
};

// ============ 1. the page title said twice, or not at all =====================
let app = fs.readFileSync('web/src/App.tsx', 'utf8');
app = sub(app,
  `              ? <div className="mx-auto max-w-3xl"><PortfoliosPanel /></div>`,
  `              ? <div className="mx-auto max-w-3xl space-y-4"><PageTitle>Portfolios</PageTitle><PortfoliosPanel /></div>`);
fs.writeFileSync('web/src/App.tsx', app);

// The panel's own heading is for when it is embedded in a client record, where there is no
// page title above it. On the client's own page the title already says the word, and saying
// it twice — "Staking" over "YOUR STAKING" — is what made the page look unauthored.
let stk = fs.readFileSync('web/src/staking.tsx', 'utf8');
stk = sub(stk,
  `        <h3 className="section-title">{clientId ? 'Staking' : 'Your staking'}</h3>`,
  `        {/* Only when embedded in a client record: the client's own page has a title above
            this already, and the same word twice reads as a mistake. */}
        {clientId && <h3 className="section-title">Staking</h3>}`);

// ============ 2. the shelf, grouped by term ==================================
const shelfStart = stk.indexOf('/** What can be staked, so the page has something to say before anything is. */');
if (shelfStart < 0) throw new Error('shelf anchor');
const shelfEnd = stk.indexOf('\n}\n', stk.indexOf('function Shelf(', shelfStart)) + 3;

const newShelf = `/**
 * What can be staked, grouped by how long it is locked for.
 *
 * Term is the decision. Rate follows from it — a longer lock pays more, that is the whole
 * trade — so a single list sorted by rate buries the thing being chosen underneath the
 * thing being compared. The groups come out of the data rather than a fixed 180/60/30:
 * whatever terms the desk has products on, longest first, with flexible last because it is
 * the absence of a term rather than the shortest one.
 */
function Shelf({ products, onPick }: { products: Product[]; onPick: () => void }) {
  // Every bar is read against the best rate on the whole shelf, not the best in its group,
  // so a 30-day product cannot look like the 180-day one by being the best of a short row.
  const topRate = Math.max(...products.map((x) => Number(x.apy)), 0.0001);

  const groups = useMemo(() => {
    const by = new Map<number, Product[]>();
    for (const product of products) {
      const days = Number(product.lock_days) || 0;
      by.set(days, [...(by.get(days) ?? []), product]);
    }
    return [...by.entries()]
      .sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : b[0] - a[0]))
      .map(([days, list]) => ({
        days,
        list: [...list].sort((a, b) => Number(b.apy) - Number(a.apy)),
      }));
  }, [products]);

  return (
    <div className="enter space-y-5" style={{ '--i': 6 } as CSSProperties}>
      <h4 className="section-title">What you can stake</h4>

      {groups.map((group) => (
        <div key={group.days}>
          <div className="mb-2 flex items-baseline gap-3">
            <span className="font-mono text-[11px] tracking-[0.16em] text-slate-ink uppercase">
              {term(group.days)}
            </span>
            <span className="text-xs text-slate-ink">
              {group.days === 0
                ? 'unstake whenever you like — the lower rate is the price of that'
                : \`locked for \${group.days} days, paid daily in the asset staked\`}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.list.map((product) => (
              <button key={product.code} type="button" onClick={onPick}
                className={\`\${card} tile lift grain focus-ring text-left\`}>
                <span className="tile-corner" aria-hidden />
                <span className="flex items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ember/15 font-mono text-[10px] font-medium text-ember-ink">
                    {product.asset}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{product.name}</span>
                    <span className="block font-mono text-[10px] tracking-wide text-slate-ink uppercase">
                      {term(product.lock_days)}
                    </span>
                  </span>
                  <span className="ml-auto font-mono text-lg leading-none font-medium tabular-nums text-ember-ink">
                    {pct(product.apy)}
                  </span>
                </span>
                <span className="mt-2 block text-xs text-slate-ink">
                  {product.description || \`From \${num(product.min_amount)} \${product.asset}.\`}
                </span>
                <span className="mt-2.5 block h-[3px] overflow-hidden rounded-full bg-slate-ink/20" aria-hidden>
                  <span className="bar-x block h-[3px] rounded-full bg-ember"
                    style={{ width: \`\${(Number(product.apy) / topRate) * 100}%\` }} />
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
`;
stk = stk.slice(0, shelfStart) + newShelf + stk.slice(shelfEnd);
stk = sub(stk, "import { useState, type CSSProperties } from 'react';",
               "import { useMemo, useState, type CSSProperties } from 'react';");
fs.writeFileSync('web/src/staking.tsx', stk);

// ============ 3. the Portfolios shelf ========================================
let pf = fs.readFileSync('web/src/portfolio.tsx', 'utf8');

pf = sub(pf,
  `        <h3 className="section-title">{clientId ? 'Portfolios' : 'Your portfolios'}</h3>`,
  `        {/* As on Staking: only when embedded in a client record, where nothing above
            names the section. */}
        {clientId && <h3 className="section-title">Portfolios</h3>}`);

// The shelf goes after the pots and before the requests list.
pf = sub(pf, `      {!clientId && !!(requests.data ?? []).length && (`,
`      {/* What else could be opened. The page used to end with the pots you already have,
          which says nothing to somebody deciding whether to open another — the same gap
          Staking had before its product shelf. */}
      {!adding && !!types.data?.length && (
        <Shelf types={types.data} onPick={() => setAdding(true)} />
      )}

      {!clientId && !!(requests.data ?? []).length && (`);

pf = pf.trimEnd() + `

/**
 * The kinds of pot that can be opened, with the return each indicates.
 *
 * Indicative, and said so: the rate on a pot is agreed per client, and a type's number is
 * the starting point for that conversation rather than a promise. Bars are read against the
 * best indicative rate on the shelf, so they compare the types with each other.
 */
function Shelf({ types, onPick }: { types: PortfolioType[]; onPick: () => void }) {
  const priced = types.filter((t) => t.indicative_rate !== null);
  const topRate = Math.max(...priced.map((t) => Number(t.indicative_rate)), 0.0001);
  const order = [...types].sort((a, b) => Number(b.indicative_rate ?? 0) - Number(a.indicative_rate ?? 0));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="section-title">What you can open</h3>
        <span className="text-xs text-slate-ink">
          indicative annual returns — the rate on a pot is agreed with the desk
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {order.map((t) => (
          <button key={t.code} type="button" onClick={onPick}
            className={\`\${card} tile lift grain focus-ring text-left\`}>
            <span className="tile-corner" aria-hidden />
            <span className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ember/15 text-ember-ink">
                <PotArt code={t.code} size={20} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{t.name}</span>
              </span>
              <span className="ml-auto font-mono text-lg leading-none font-medium tabular-nums text-ember-ink">
                {t.indicative_rate === null ? '—' : pct(t.indicative_rate)}
              </span>
            </span>
            {t.description && (
              <span className="mt-2 block text-xs text-slate-ink">{t.description}</span>
            )}
            {t.indicative_rate !== null && (
              <span className="mt-2.5 block h-[3px] overflow-hidden rounded-full bg-slate-ink/20" aria-hidden>
                <span className="bar-x block h-[3px] rounded-full bg-ember"
                  style={{ width: \`\${(Number(t.indicative_rate) / topRate) * 100}%\` }} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
`;
fs.writeFileSync('web/src/portfolio.tsx', pf);

console.log('titles de-duplicated; staking shelf grouped by term; portfolios shelf added');
