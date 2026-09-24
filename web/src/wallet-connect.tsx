import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { alertBox, btn, card, mono, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';

/**
 * Linking a wallet to the account.
 *
 * The client signs a challenge to prove the address is theirs. Signing is free, moves
 * nothing, and cannot be replayed as a transaction — the request is personal_sign, never
 * eth_sendTransaction and never an approval, and nothing here asks for anything else.
 *
 * Nothing is deposited or withdrawn through this page. It is identification: the desk
 * knowing which address belongs to whom, which is what would have to be true before an
 * address could ever be paid.
 */

type Wallet = { id: number; address: string; label: string | null; linked_at: string };

/** The EIP-1193 surface, narrowed to the two calls used. */
type Provider = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/** What a wallet announces about itself under EIP-6963. */
type Announced = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Provider;
};

/**
 * Wallets we name even when they are not installed, so the page is a list of choices
 * rather than an empty box on a machine with nothing set up yet. MetaMask is first
 * because it is the one being led with; the rest are alphabetical, not ranked.
 */
const KNOWN: { rdns: string; name: string; url: string }[] = [
  { rdns: 'io.metamask', name: 'MetaMask', url: 'https://metamask.io/download/' },
  { rdns: 'com.coinbase.wallet', name: 'Coinbase Wallet', url: 'https://www.coinbase.com/wallet/downloads' },
  { rdns: 'io.rabby', name: 'Rabby', url: 'https://rabby.io/' },
  { rdns: 'com.trustwallet.app', name: 'Trust Wallet', url: 'https://trustwallet.com/download' },
  { rdns: 'app.phantom', name: 'Phantom', url: 'https://phantom.app/download' },
];

const rank = (rdns: string) => (rdns === 'io.metamask' ? -1 : 0);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The chains worth naming. Anything else shows its id rather than a guess — telling
 * somebody they are on the wrong network when we simply do not recognise it is worse
 * than admitting we do not know.
 */
const CHAINS: Record<string, { name: string; symbol: string }> = {
  '0x1': { name: 'Ethereum', symbol: 'ETH' },
  '0xaa36a7': { name: 'Sepolia', symbol: 'ETH' },
  '0x89': { name: 'Polygon', symbol: 'POL' },
  '0xa': { name: 'Optimism', symbol: 'ETH' },
  '0xa4b1': { name: 'Arbitrum One', symbol: 'ETH' },
  '0x2105': { name: 'Base', symbol: 'ETH' },
  '0x38': { name: 'BNB Chain', symbol: 'BNB' },
};

/** Wei, as a hex string, to something a person reads. */
function fromWei(hex: string): string {
  const wei = BigInt(hex);
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Every wallet installed in this browser, as each one announces itself.
 *
 * EIP-6963 rather than reading window.ethereum: with two extensions installed they fight
 * over that single property and whichever lost is unreachable, so the person with both
 * MetaMask and Rabby can end up unable to pick the one they meant. Each wallet announces
 * its own name and icon here, which is also why this page needs no logos of its own.
 */
function useProviders() {
  const [found, setFound] = useState<Announced[]>([]);

  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<Announced>).detail;
      setFound((prev) => (prev.some((p) => p.info.uuid === detail.info.uuid) ? prev : [...prev, detail]));
    };
    addEventListener('eip6963:announceProvider', on);
    // Wallets announce on request as well as at load, so ask — a page rendered after they
    // finished announcing would otherwise see nothing.
    dispatchEvent(new Event('eip6963:requestProvider'));
    return () => removeEventListener('eip6963:announceProvider', on);
  }, []);

  // A wallet that predates EIP-6963 still only lives on window.ethereum. Include it, but
  // only when nothing announced itself, so it cannot duplicate a wallet already listed.
  return useMemo(() => {
    const legacy = (globalThis as { ethereum?: Provider & { isMetaMask?: boolean } }).ethereum;
    if (!found.length && legacy) {
      return [{
        info: {
          uuid: 'legacy', name: legacy.isMetaMask ? 'MetaMask' : 'Browser wallet',
          icon: '', rdns: legacy.isMetaMask ? 'io.metamask' : 'legacy',
        },
        provider: legacy,
      }];
    }
    return [...found].sort((a, b) => rank(a.info.rdns) - rank(b.info.rdns)
      || a.info.name.localeCompare(b.info.name));
  }, [found]);
}

export function WalletView() {
  const wallets = useApi<Wallet[]>('/me/wallet');
  const providers = useProviders();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which wallet is mid-flow, so only that card shows the spinner.
  const active = useRef<string | null>(null);

  const installed = new Set(providers.map((p) => p.info.rdns));
  const missing = KNOWN.filter((k) => !installed.has(k.rdns));

  async function connect(w: Announced) {
    setError(null);
    active.current = w.info.uuid;
    try {
      setBusy('Waiting for the wallet…');
      const [address] = await w.provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!address) throw new Error('No account was shared.');

      setBusy('Building the challenge…');
      const challenge = await api<{ message: string; nonce: string }>('/me/wallet/challenge', {
        method: 'POST', body: JSON.stringify({ address }),
      });

      // personal_sign takes the message first and the account second. Nothing reaches the
      // chain: this produces a signature, not a transaction.
      setBusy(`Approve the signature in ${w.info.name}…`);
      const signature = await w.provider.request({
        method: 'personal_sign', params: [challenge.message, address],
      }) as string;

      setBusy('Checking it…');
      await api('/me/wallet', {
        method: 'POST',
        body: JSON.stringify({ address, nonce: challenge.nonce, signature, label: w.info.name }),
      });
      wallets.reload();
    } catch (err) {
      // 4001 is the wallet's code for "the person said no", which is not a failure.
      const code = (err as { code?: number }).code;
      setError(code === 4001 ? 'Cancelled in the wallet.' : (err as Error).message);
    } finally {
      setBusy(null);
      active.current = null;
    }
  }

  async function unlink(w: Wallet) {
    setError(null);
    try {
      await api(`/me/wallet/${w.id}`, { method: 'DELETE' });
      wallets.reload();
    } catch (err) { setError((err as Error).message); }
  }

  const linked = wallets.data ?? [];

  return (
    <div className="stagger mx-auto max-w-3xl space-y-4">
      <PageTitle>Connect wallet</PageTitle>

      <div className={`${card} space-y-4`}>
        <div>
          <h2 className="section-title">Your wallets</h2>
          <p className="mt-1 text-xs text-slate-ink">
            Addresses you have proved are yours.
          </p>
        </div>
        {linked.length === 0
          ? <p className="text-sm text-slate-ink">Nothing linked yet.</p>
          : (
            <ul className="divide-y divide-pebble dark:divide-white/10">
              {linked.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-up" aria-hidden />
                  <span className={`text-sm ${mono} text-ember-ink`} title={w.address}>{short(w.address)}</span>
                  <span className="text-xs text-slate-ink">{w.label ?? 'wallet'}</span>
                  <span className={`text-xs text-slate-ink ${mono}`}>
                    linked {new Date(w.linked_at).toLocaleDateString()}
                  </span>
                  <button type="button" onClick={() => unlink(w)}
                    className="ml-auto font-mono text-xs text-slate-ink hover:text-down hover:underline">
                    unlink
                  </button>
                  <WalletBalance address={w.address} />
                </li>
              ))}
            </ul>
          )}
      </div>

      <div className={`${card} space-y-4`}>
        <div>
          <h2 className="section-title">Choose a wallet</h2>
          <p className="mt-1 text-xs text-slate-ink">
            {providers.length
              ? 'Found in this browser. Pick the one holding the address you want to link.'
              : 'No wallet extension found in this browser. Install one of these, then reload the page.'}
          </p>
        </div>

        {!!providers.length && (
          <ul className="grid gap-2 sm:grid-cols-2">
            {providers.map((w, i) => (
              <li key={w.info.uuid}>
                <button type="button" onClick={() => connect(w)} disabled={!!busy}
                  className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-60 ${
                    i === 0
                      ? 'border-ember bg-ember/5 hover:bg-ember/10'
                      : 'border-pebble hover:border-ember/50 dark:border-white/10'}`}>
                  <Mark w={w} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{w.info.name}</span>
                    <span className="block font-mono text-[10px] tracking-wide text-slate-ink uppercase">
                      {active.current === w.info.uuid && busy ? busy : (i === 0 ? 'recommended' : 'installed')}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-ember-ink" aria-hidden>→</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!!missing.length && (
          <div>
            <h3 className="section-title">Not installed</h3>
            <ul className="mt-2 flex flex-wrap gap-2">
              {missing.map((k) => (
                <li key={k.rdns}>
                  <a href={k.url} target="_blank" rel="noreferrer noopener"
                    className="flex items-center gap-2 rounded-lg border border-pebble px-3 py-1.5 text-xs text-slate-ink transition-colors hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum">
                    {k.name} <span aria-hidden>↗</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p role="alert" className={alertBox}>{error}</p>}
      </div>

      <div className={`${card} space-y-2`}>
        <h2 className="section-title">What linking does</h2>
        <ul className="space-y-1 text-xs text-slate-ink">
          <li>You sign a short message. It costs no gas and moves nothing.</li>
          <li>We never hold your keys and cannot spend from your wallet.</li>
          <li>No transaction or token approval is ever requested from this page.</li>
          <li>Deposits and withdrawals do not run through here.</li>
          <li>Unlink whenever you like — it removes the address and nothing else.</li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Tokens worth looking for, per chain. Well-known contracts only, by address, with the
 * decimals each one uses — a balance read with the wrong decimals is off by a factor of a
 * trillion, which is the kind of wrong that looks right. A contract that fails to answer
 * shows as a dash rather than an error: an unreadable token is not a broken wallet.
 */
type Token = { symbol: string; name: string; address: string; decimals: number; quote: string | null };
const STABLE = 'stable';
const TOKENS: Record<string, Token[]> = {
  '0x1': [
    { symbol: 'USDT', name: 'Tether', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, quote: STABLE },
    { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, quote: STABLE },
    { symbol: 'DAI', name: 'Dai', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, quote: STABLE },
    { symbol: 'WBTC', name: 'Wrapped Bitcoin', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, quote: 'BTCUSD' },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, quote: 'ETHUSD' },
    { symbol: 'LINK', name: 'Chainlink', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18, quote: 'LINKUSD' },
    { symbol: 'UNI', name: 'Uniswap', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18, quote: 'UNIUSD' },
    { symbol: 'AAVE', name: 'Aave', address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18, quote: 'AAVEUSD' },
  ],
  '0x89': [
    { symbol: 'USDT', name: 'Tether', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, quote: STABLE },
    { symbol: 'USDC', name: 'USD Coin', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, quote: STABLE },
    { symbol: 'USDC.e', name: 'USD Coin (bridged)', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6, quote: STABLE },
    { symbol: 'DAI', name: 'Dai', address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18, quote: STABLE },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18, quote: 'ETHUSD' },
  ],
  '0xa4b1': [
    { symbol: 'USDT', name: 'Tether', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, quote: STABLE },
    { symbol: 'USDC', name: 'USD Coin', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, quote: STABLE },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, quote: 'ETHUSD' },
    { symbol: 'WBTC', name: 'Wrapped Bitcoin', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8, quote: 'BTCUSD' },
    { symbol: 'ARB', name: 'Arbitrum', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18, quote: 'ARBUSD' },
  ],
  '0x2105': [
    { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, quote: STABLE },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18, quote: 'ETHUSD' },
    { symbol: 'DAI', name: 'Dai', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, quote: STABLE },
  ],
};
/** What the chain's own coin is priced against on this platform. */
const NATIVE_QUOTE: Record<string, string> = {
  '0x1': 'ETHUSD', '0xaa36a7': 'ETHUSD', '0x89': 'POLUSD', '0xa': 'ETHUSD', '0xa4b1': 'ETHUSD', '0x2105': 'ETHUSD', '0x38': 'BNBUSD',
};

/** A raw integer amount, as the token counts it, to a number a person reads. */
function fromUnits(hex: string, decimals: number): number {
  const raw = BigInt(hex === '0x' ? '0x0' : hex);
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

/** balanceOf(address), as the bytes an ERC-20 expects. */
const balanceOfCall = (holder: string) => '0x70a08231' + holder.toLowerCase().replace('0x', '').padStart(64, '0');

type Holding = { symbol: string; name: string; amount: number | null; usd: number | null; native?: boolean };
type Read = { chain: string; wallet: Announced; holdings: Holding[]; at: number };

/**
 * What is actually in the wallet, read from the chain and shown here.
 *
 * MetaMask itself cannot be embedded — it is a browser extension, not a page, and its
 * own window is not something a site is allowed to render. What a site can do is ask the
 * provider the extension injects, which is what this does: the balances and network below
 * come from the wallet the client already connected, live, through calls that read and
 * never spend.
 *
 * The figures are deliberately kept apart from the account balances everywhere else on
 * this platform. It is their money, in their wallet, on a public chain — it is not
 * funding, it is not a deposit, and putting it in the same column as either would be a
 * lie. The dollar values are the desk's prices, which the window says.
 */
function useWalletRead(address: string) {
  const providers = useProviders();
  const [state, setState] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // eth_accounts lists what has already been permitted and never prompts, so this can
      // look for the right wallet without a popup appearing on page load.
      for (const w of providers) {
        const accounts = await w.provider.request({ method: 'eth_accounts' }).catch(() => []) as string[];
        if (!accounts.some((a) => a.toLowerCase() === address.toLowerCase())) continue;
        const chain = await w.provider.request({ method: 'eth_chainId' }) as string;
        const quotes = await api<{ symbol: string; price: number }[]>('/quotes').catch(() => [] as { symbol: string; price: number }[]);
        const px = (q: string | null, amount: number | null) => {
          if (amount === null || q === null) return null;
          if (q === STABLE) return amount;
          const hit = quotes.find((x) => x.symbol === q);
          return hit ? amount * hit.price : null;
        };
        const wei = await w.provider.request({ method: 'eth_getBalance', params: [address, 'latest'] }) as string;
        const native = fromUnits(wei, 18);
        const holdings: Holding[] = [{
          symbol: CHAINS[chain]?.symbol ?? 'native', name: CHAINS[chain]?.name ?? `chain ${chain}`,
          amount: native, usd: px(NATIVE_QUOTE[chain] ?? null, native), native: true,
        }];
        // Every token at once; one that fails to answer becomes a dash, not a failure.
        const tokens = TOKENS[chain] ?? [];
        const raws = await Promise.all(tokens.map((t) => w.provider.request({
          method: 'eth_call', params: [{ to: t.address, data: balanceOfCall(address) }, 'latest'],
        }).then((r) => r as string).catch(() => null)));
        tokens.forEach((t, i) => {
          const raw = raws[i] ?? null;
          const amount = raw === null ? null : fromUnits(raw, t.decimals);
          holdings.push({ symbol: t.symbol, name: t.name, amount, usd: px(t.quote, amount) });
        });
        setState({ chain, wallet: w, holdings, at: Date.now() });
        return;
      }
      setState(null);
      setError(providers.length
        ? 'This address is not unlocked in the wallet right now.'
        : 'No wallet extension in this browser to read it from.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [providers, address]);

  useEffect(() => { read(); }, [read]);

  // The person can switch account or network in the wallet at any moment, and the figure
  // on screen has to follow rather than quietly go stale.
  useEffect(() => {
    const on = () => read();
    for (const w of providers) {
      (w.provider as { on?: (e: string, f: () => void) => void }).on?.('accountsChanged', on);
      (w.provider as { on?: (e: string, f: () => void) => void }).on?.('chainChanged', on);
    }
    return () => {
      for (const w of providers) {
        (w.provider as { removeListener?: (e: string, f: () => void) => void })
          .removeListener?.('accountsChanged', on);
        (w.provider as { removeListener?: (e: string, f: () => void) => void })
          .removeListener?.('chainChanged', on);
      }
    };
  }, [providers, read]);

  return { state, error, busy, read };
}

const usd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amt = (n: number) => (n === 0 ? '0' : n >= 1
  ? n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  : n.toLocaleString('en-US', { maximumFractionDigits: 6 }));

/** The line under a linked address: network, the coin, the total — and the way into the window. */
function WalletBalance({ address }: { address: string }) {
  const { state, error, busy, read } = useWalletRead(address);
  const [open, setOpen] = useState(false);

  if (!state) {
    return (
      <p className="w-full text-xs text-slate-ink">
        {busy ? 'Reading the wallet…' : error ?? ''}
      </p>
    );
  }
  const chain = CHAINS[state.chain];
  const native = state.holdings[0]!;
  const total = state.holdings.reduce((a, h) => a + (h.usd ?? 0), 0);
  return (
    <>
      <div className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-pebble bg-bone/60 px-3 py-2 dark:border-white/10 dark:bg-white/5">
        <span>
          <span className="metric-label block">Network</span>
          <span className="block font-mono text-sm">{chain?.name ?? `chain ${state.chain}`}</span>
        </span>
        <span>
          <span className="metric-label block">On-chain balance</span>
          <span className="block font-mono text-sm font-medium tabular-nums">{amt(native.amount ?? 0)} {native.symbol}</span>
        </span>
        <span>
          <span className="metric-label block">Priced</span>
          <span className="block font-mono text-sm font-medium tabular-nums text-ember-ink">{usd(total)}</span>
        </span>
        <button type="button" onClick={() => setOpen(true)}
          className="ml-auto rounded-full bg-ember px-3 py-1.5 font-mono text-xs text-graphite hover:brightness-95">
          Open wallet
        </button>
        <button type="button" onClick={read} disabled={busy}
          className="font-mono text-xs text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">
          {busy ? 'reading…' : 'refresh'}
        </button>
      </div>
      {open && <WalletWindow address={address} state={state} busy={busy} onRefresh={read} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The wallet, as a window of its own.
 *
 * A dialog over the page rather than a panel in it, because a wallet is a thing you open
 * and look inside. The total leads, the coin the chain runs on comes first, and every
 * token the wallet holds follows in order of value; the rest are folded away rather than
 * listed as a column of zeros. It is read-only end to end — the one thing the window can
 * do to the chain is read it again.
 */
function WalletWindow({ address, state, busy, onRefresh, onClose }: {
  address: string; state: Read; busy: boolean; onRefresh: () => void; onClose: () => void;
}) {
  const [showZero, setShowZero] = useState(false);
  const [copied, setCopied] = useState(false);
  const chain = CHAINS[state.chain];
  const priced = state.holdings.filter((h) => h.usd !== null);
  const total = priced.reduce((a, h) => a + (h.usd ?? 0), 0);
  const unpriced = state.holdings.filter((h) => (h.amount ?? 0) > 0 && h.usd === null).length;
  const held = state.holdings.filter((h) => h.native || h.amount === null || h.amount > 0)
    .sort((a, b) => (b.native ? 1 : 0) - (a.native ? 1 : 0) || (b.usd ?? 0) - (a.usd ?? 0));
  const empty = state.holdings.filter((h) => !h.native && h.amount === 0);
  const rows = showZero ? [...held, ...empty] : held;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the address is on screen either way */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-graphite/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Wallet balances" onClick={(e) => e.stopPropagation()}
        className="enter relative w-full max-w-lg overflow-hidden rounded-xl bg-onyx text-vellum [box-shadow:var(--shadow-inset-dark)]"
        style={{ '--i': 0 } as CSSProperties}>
        <span className="absolute inset-x-0 top-0 h-[2px] bg-ember" aria-hidden />
        <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full" aria-hidden
          style={{ background: 'radial-gradient(closest-side, rgba(255,120,23,0.28), rgba(255,120,23,0))' }} />

        <div className="relative flex items-center gap-3 px-6 pt-6">
          <Mark w={state.wallet} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{state.wallet.info.name}</p>
            <button type="button" onClick={copy} className={`${mono} text-xs text-slate-ink hover:text-vellum`} title={address}>
              {short(address)} <span className="text-[10px] text-ember">{copied ? 'copied' : 'copy'}</span>
            </button>
          </div>
          <span className="flex items-center gap-2 rounded-full border border-white/15 px-2.5 py-1 font-mono text-[10px] tracking-wide uppercase">
            <span className="nav-live h-1.5 w-1.5 rounded-full bg-up" aria-hidden />
            {chain?.name ?? `chain ${state.chain}`}
          </span>
          <button type="button" onClick={onClose} aria-label="Close"
            className="rounded-full border border-white/15 px-2.5 py-1 font-mono text-xs text-slate-ink hover:text-vellum">✕</button>
        </div>

        <div className="relative px-6 pt-6 pb-4">
          <span className="metric-label block">Total, at the desk's prices</span>
          <p className="mt-1 font-display text-4xl leading-none tracking-tight tabular-nums">{usd(total)}</p>
          <p className="mt-2 text-xs text-slate-ink">
            {unpriced
              ? `${unpriced} token${unpriced === 1 ? ' has' : 's have'} no price here and ${unpriced === 1 ? 'is' : 'are'} left out of the total.`
              : 'Read from the chain just now. Nothing on this page can spend it.'}
          </p>
        </div>

        <ul className="stagger relative divide-y divide-white/10 border-t border-white/10">
          {rows.map((h, i) => (
            <li key={h.symbol} className="enter flex items-center gap-3 px-6 py-3" style={{ '--i': i + 1 } as CSSProperties}>
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-mono text-[11px] ${
                h.native ? 'bg-ember text-graphite' : 'border border-white/15 text-slate-ink'}`}>
                {h.symbol.slice(0, 4)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{h.symbol}</span>
                <span className="block text-xs text-slate-ink">{h.native ? `${h.name} · native coin` : h.name}</span>
              </span>
              <span className="text-right">
                <span className="block font-mono text-sm tabular-nums">{h.amount === null ? '—' : amt(h.amount)}</span>
                <span className="block font-mono text-xs tabular-nums text-slate-ink">
                  {h.usd === null ? (h.amount === null ? 'unreadable' : 'no price') : usd(h.usd)}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <div className="relative flex flex-wrap items-center gap-3 border-t border-white/10 px-6 py-4">
          {!!empty.length && (
            <button type="button" onClick={() => setShowZero(!showZero)} className="font-mono text-xs text-slate-ink hover:text-vellum">
              {showZero ? 'hide' : 'show'} {empty.length} empty
            </button>
          )}
          <span className="ml-auto font-mono text-[10px] text-slate-ink">
            read {new Date(state.at).toLocaleTimeString()}
          </span>
          <button type="button" onClick={onRefresh} disabled={busy}
            className="rounded-full border border-white/15 px-3 py-1.5 font-mono text-xs text-vellum hover:border-ember/60 disabled:opacity-50">
            {busy ? 'reading…' : 'Read again'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The wallet's own icon, which it supplies as a data URI. Falls back to its initial rather
 * than to a broken image: a wallet that announces no icon is unusual, not an error.
 */
function Mark({ w }: { w: Announced }) {
  const [broken, setBroken] = useState(false);
  if (w.info.icon && !broken) {
    return (
      <img src={w.info.icon} alt="" width={32} height={32} onError={() => setBroken(true)}
        className="h-8 w-8 shrink-0 rounded-md" />
    );
  }
  return (
    <span aria-hidden
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-ember/15 font-mono text-sm text-ember-ink">
      {w.info.name[0] ?? '?'}
    </span>
  );
}

/** The linked addresses, read-only, for staff looking at a client record. */
export function ClientWallets({ clientId }: { clientId: string }) {
  const wallets = useApi<Wallet[]>(`/clients/${clientId}/wallets`);
  const rows = wallets.data ?? [];
  if (!wallets.data) return null;

  return (
    <div>
      <h3 className="font-mono text-[11px] tracking-[0.16em] text-slate-ink uppercase">Linked wallets</h3>
      {rows.length === 0
        ? <p className="mt-2 text-sm text-slate-ink">None linked.</p>
        : (
          <ul className="mt-2 space-y-1">
            {rows.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 text-sm">
                {/* Shown in full: staff checking an address against something else need all
                    of it, and it is short enough to read. */}
                <span className={`text-xs ${mono} break-all`}>{w.address}</span>
                <span className="text-xs text-slate-ink">{w.label ?? 'wallet'}</span>
                <span className={`ml-auto text-xs text-slate-ink ${mono}`}>
                  {new Date(w.linked_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
