// Jupiter Mobile connect over WalletConnect, using Jupiter's own link format:
//   connect: jupiter://wc?uri=<walletconnect uri>
// Built by `npm run build` into public/jupiter-bundle.js and loaded only when a buyer taps Jupiter.
// The link is shown as a real button the buyer taps (iOS only reliably opens apps from a direct tap).
import UniversalProvider from '@walletconnect/universal-provider';
import { VersionedTransaction } from '@solana/web3.js';

const CHAINS = {
  'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(text) {
  let n = 0n;
  for (const ch of text) { const i = B58.indexOf(ch); if (i < 0) throw new Error('Bad signature from the wallet'); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of text) { if (ch === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

export async function createJupiterAdapter({ projectId, cluster, log = () => {} }) {
  const chain = CHAINS[cluster] || CHAINS['mainnet-beta'];
  const provider = await UniversalProvider.init({
    projectId,
    metadata: {
      name: document.title || 'Token Sale',
      description: 'Token sale',
      url: location.origin,
      icons: [`${location.origin}/favicon.ico`],
    },
  });
  log('WalletConnect ready');
  let address = null;
  const adapter = {
    name: 'Jupiter',
    onLink: null, // the page sets this; called with a link to show as a button, or null to hide it
    async connect() {
      try { if (provider.session) await Promise.race([provider.disconnect(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* ignore */ }
      provider.on('display_uri', (uri) => {
        const link = `jupiter://wc?uri=${encodeURIComponent(uri)}`;
        log('pairing link ready - tap the Open Jupiter button');
        adapter.onLink?.(link);
      });
      const session = await provider.connect({
        namespaces: { solana: { chains: [chain], methods: ['solana_signTransaction', 'solana_signMessage'], events: [] } },
      });
      const account = session?.namespaces?.solana?.accounts?.[0];
      if (!account) throw new Error('Jupiter did not return a Solana account');
      address = account.split(':')[2];
      adapter.onLink?.(null);
      return address;
    },
    async sign(tx) {
      // Offer a button that brings the buyer back to Jupiter, where the pending request waits for approval.
      adapter.onLink?.('jupiter://wc');
      try {
        const result = await provider.request({ method: 'solana_signTransaction', params: { transaction: bytesToB64(tx.serialize()) } }, chain);
        if (result?.transaction) return b64ToBytes(result.transaction);
        if (!result?.signature) throw new Error('The wallet did not sign the transaction');
        const own = VersionedTransaction.deserialize(tx.serialize());
        const keys = own.message.staticAccountKeys;
        const index = keys.findIndex((k, i) => i < own.message.header.numRequiredSignatures && k.toBase58() === address);
        if (index < 0) throw new Error('Wallet is not a signer of this transaction');
        own.signatures[index] = base58Decode(result.signature);
        return own.serialize();
      } finally { adapter.onLink?.(null); }
    },
    async disconnect() { try { await provider.disconnect(); } catch { /* ignore */ } },
  };
  return adapter;
}
