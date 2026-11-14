// Connects wallet apps that can only be reached through WalletConnect (Jupiter Mobile has no "open this page in
// the app" link). Loaded ONLY when the buyer taps the button, so a problem here can never break the other wallets.
//
// Flow: pair over WalletConnect -> the buyer approves in the wallet app -> later the wallet app signs the purchase.
// The signed result goes through the same server checks as every other wallet.

// esm.sh serves the WalletConnect library. Pin an exact version here once you have tested one that you like.
const UNIVERSAL_PROVIDER_URL = 'https://esm.sh/@walletconnect/universal-provider@2';

const CHAINS = {
  'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(text) {
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('Bad signature from the wallet');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of text) { if (ch === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

// WalletConnect deep link conventions: native "scheme://wc?uri=..." and universal "https://host/path/wc?uri=...".
function pairingLink(listing, uri) {
  const universal = listing?.mobile?.universal;
  const native = listing?.mobile?.native;
  if (universal) return `${universal.endsWith('/') ? universal : universal + '/'}wc?uri=${encodeURIComponent(uri)}`;
  if (native) return `${native.includes('://') ? native : native + '://'}wc?uri=${encodeURIComponent(uri)}`;
  return null;
}

// Finds the wallet's own deep links in WalletConnect's public wallet directory.
async function findListing(projectId, walletName) {
  try {
    const url = `https://explorer-api.walletconnect.com/v3/wallets?projectId=${encodeURIComponent(projectId)}&search=${encodeURIComponent(walletName)}&entries=10&page=1`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const { listings } = await r.json();
    const all = Object.values(listings || {});
    const wanted = walletName.toLowerCase();
    return all.find((w) => (w.name || '').toLowerCase().startsWith(wanted) && (w.mobile?.universal || w.mobile?.native)) || null;
  } catch { return null; }
}

export async function createWalletConnectAdapter({ projectId, cluster, walletName, onLink }) {
  const chain = CHAINS[cluster] || CHAINS['mainnet-beta'];
  const { UniversalProvider } = await import(UNIVERSAL_PROVIDER_URL);
  const provider = await UniversalProvider.init({
    projectId,
    metadata: {
      name: document.title || 'Token Sale',
      description: 'Token sale',
      url: location.origin, // must match the domain allowed in your Reown project
      icons: [`${location.origin}/favicon.ico`],
    },
  });
  const listing = await findListing(projectId, walletName);
  let address = null;

  const walletRedirect = () => {
    const r = provider.session?.peer?.metadata?.redirect;
    return r?.universal || r?.native || listing?.mobile?.universal || listing?.mobile?.native || null;
  };

  return {
    name: walletName,
    async connect() {
      // Drop any old session so the buyer always approves a fresh one.
      try { if (provider.session) await Promise.race([provider.disconnect(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* ignore */ }
      provider.on('display_uri', (uri) => {
        const link = pairingLink(listing, uri);
        if (!link) { onLink?.(null, uri); return; }
        onLink?.(link, uri);
        try { location.href = link; } catch { /* the buyer can tap the button instead */ }
      });
      const session = await provider.connect({
        namespaces: { solana: { chains: [chain], methods: ['solana_signTransaction', 'solana_signMessage'], events: [] } },
      });
      const account = session?.namespaces?.solana?.accounts?.[0];
      if (!account) throw new Error(`${walletName} did not return a Solana account`);
      address = account.split(':')[2];
      onLink?.(null, null); // hide the "open the app" button
      return address;
    },
    async sign(tx) {
      const request = provider.request({ method: 'solana_signTransaction', params: { transaction: bytesToB64(tx.serialize()) } }, chain);
      const back = walletRedirect();
      if (back) { try { location.href = back; } catch { /* the buyer opens the app by hand */ } }
      const result = await request;
      // Some wallets return the whole signed transaction, others only their signature. Handle both.
      if (result?.transaction) return b64ToBytes(result.transaction);
      if (!result?.signature) throw new Error('The wallet did not sign the transaction');
      const keys = tx.message.staticAccountKeys;
      const index = keys.findIndex((k, i) => i < tx.message.header.numRequiredSignatures && k.toBase58() === address);
      if (index < 0) throw new Error('Wallet is not a signer of this transaction');
      tx.signatures[index] = base58Decode(result.signature);
      return tx.serialize();
    },
    async disconnect() { try { await provider.disconnect(); } catch { /* ignore */ } },
  };
}
