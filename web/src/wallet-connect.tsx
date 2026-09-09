import { useState } from 'react';
import { alertBox, btn, btnGhost, mono } from './App.tsx';
import { api, useApi } from './api.ts';

/**
 * Linking a MetaMask wallet to the account.
 *
 * The client signs a challenge to prove the address is theirs. Signing is free, moves
 * nothing, and cannot be replayed as a transaction — the request is personal_sign, never
 * eth_sendTransaction and never an approval, and this component asks for nothing else.
 *
 * Nothing is deposited or withdrawn through here. It is identification: the desk knowing
 * which address belongs to whom, which is what would have to be true before an address
 * could ever be paid.
 */

type Wallet = { id: number; address: string; label: string | null; linked_at: string };

/** MetaMask injects this. Typed to the two calls used, so nothing wider is reachable. */
type Ethereum = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  isMetaMask?: boolean;
};
const injected = (): Ethereum | undefined => (globalThis as { ethereum?: Ethereum }).ethereum;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function WalletConnect() {
  const wallets = useApi<Wallet[]>('/me/wallet');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const eth = injected();
    if (!eth) {
      return setError('No wallet extension found in this browser. Install MetaMask, then reload this page.');
    }
    setError(null);
    try {
      setBusy('Waiting for the wallet…');
      const [address] = await eth.request({ method: 'eth_requestAccounts' }) as string[];
      if (!address) throw new Error('No account was shared.');

      setBusy('Building the challenge…');
      const challenge = await api<{ message: string; nonce: string }>('/me/wallet/challenge', {
        method: 'POST', body: JSON.stringify({ address }),
      });

      // personal_sign takes the message first and the account second. Nothing reaches the
      // chain: this produces a signature, not a transaction.
      setBusy('Approve the signature in MetaMask…');
      const signature = await eth.request({
        method: 'personal_sign', params: [challenge.message, address],
      }) as string;

      setBusy('Checking it…');
      await api('/me/wallet', {
        method: 'POST',
        body: JSON.stringify({ address, nonce: challenge.nonce, signature, label: 'MetaMask' }),
      });
      wallets.reload();
    } catch (err) {
      // 4001 is the wallet's code for "the person said no", which is not a failure.
      const code = (err as { code?: number }).code;
      setError(code === 4001 ? 'Cancelled in the wallet.' : (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function unlink(w: Wallet) {
    setError(null);
    try {
      await api(`/me/wallet/${w.id}`, { method: 'DELETE' });
      wallets.reload();
    } catch (err) { setError((err as Error).message); }
  }

  const rows = wallets.data ?? [];

  return (
    <div className="space-y-3">
      {rows.length === 0
        ? <p className="text-sm text-slate-ink">No wallet linked.</p>
        : (
          <ul className="divide-y divide-pebble dark:divide-white/10">
            {rows.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className={`text-sm ${mono} text-ember`} title={w.address}>{short(w.address)}</span>
                <span className="text-xs text-slate-ink">{w.label ?? 'wallet'}</span>
                <span className={`text-xs text-slate-ink ${mono}`}>
                  linked {new Date(w.linked_at).toLocaleDateString()}
                </span>
                <button type="button" onClick={() => unlink(w)}
                  className="ml-auto font-mono text-xs text-slate-ink hover:text-down hover:underline">
                  unlink
                </button>
              </li>
            ))}
          </ul>
        )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={rows.length ? btnGhost : btn} onClick={connect} disabled={!!busy}>
          {busy ?? (rows.length ? 'Link another wallet' : 'Connect MetaMask')}
        </button>
        {!injected() && (
          <a href="https://metamask.io/download/" target="_blank" rel="noreferrer noopener"
            className="font-mono text-xs text-slate-ink hover:text-obsidian hover:underline dark:hover:text-vellum">
            get MetaMask ↗
          </a>
        )}
      </div>

      <p className="text-xs text-slate-ink">
        You sign a short message to prove the address is yours. It costs nothing, moves
        nothing, and gives us no ability to spend from your wallet — we never hold your
        keys. Deposits and withdrawals do not run through this.
      </p>
      {error && <p role="alert" className={alertBox}>{error}</p>}
    </div>
  );
}

/** The same list, read-only, for staff looking at a client record. */
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
