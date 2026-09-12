import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
          <h2 className="metric-label">Your wallets</h2>
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
          <h2 className="metric-label">Choose a wallet</h2>
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
            <h3 className="metric-label">Not installed</h3>
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
        <h2 className="metric-label">What linking does</h2>
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
 * What is actually in the wallet, read from the chain and shown here.
 *
 * MetaMask itself cannot be embedded — it is a browser extension, not a page, and its
 * own window is not something a site is allowed to render. What a site can do is ask the
 * provider the extension injects, which is what this does: the balance and network below
 * come from the wallet the client already connected, live, through calls that read and
 * never spend.
 *
 * The figure is deliberately kept apart from the account balances everywhere else on this
 * platform. It is their money, in their wallet, on a public chain — it is not funding, it
 * is not a deposit, and putting it in the same column as either would be a lie.
 */
function WalletBalance({ address }: { address: string }) {
  const providers = useProviders();
  const [state, setState] = useState<{ chain: string; balance: string } | null>(null);
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
        const wei = await w.provider.request({
          method: 'eth_getBalance', params: [address, 'latest'],
        }) as string;
        setState({ chain, balance: fromWei(wei) });
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

  if (!state) {
    return (
      <p className="w-full text-xs text-slate-ink">
        {busy ? 'Reading the wallet…' : error ?? ''}
      </p>
    );
  }

  const chain = CHAINS[state.chain];
  return (
    <div className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-pebble bg-bone/60 px-3 py-2 dark:border-white/10 dark:bg-white/5">
      <span>
        <span className="metric-label block">Network</span>
        <span className="block font-mono text-sm">{chain?.name ?? `chain ${state.chain}`}</span>
      </span>
      <span>
        <span className="metric-label block">On-chain balance</span>
        <span className="block font-mono text-sm font-medium tabular-nums">
          {state.balance} {chain?.symbol ?? ''}
        </span>
      </span>
      <button type="button" onClick={read} disabled={busy}
        className="ml-auto font-mono text-xs text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">
        {busy ? 'reading…' : 'refresh'}
      </button>
      <p className="w-full text-xs text-slate-ink">
        Read from the chain. This is your own wallet — it is not part of your account here,
        and nothing on this page can spend it.
      </p>
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
