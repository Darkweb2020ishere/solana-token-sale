// Jupiter Mobile connect. Built by `npm run build` into public/jupiter-bundle.js and loaded only when a buyer taps Jupiter.
// Same pieces as Jupiter's own adapter (@jup-ag/jup-mobile-adapter), but WITHOUT its extra generic QR window:
// it asks Reown's wallet button for Jupiter directly, which opens the Jupiter app.
import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { VersionedTransaction } from '@solana/web3.js';
import { SolanaAdapter } from '@reown/appkit-adapter-solana';
import * as networks from '@reown/appkit/networks';
import { createAppKit, useAppKitAccount, useAppKitProvider, useDisconnect } from '@reown/appkit/react';
import { useAppKitWallet } from '@reown/appkit-wallet-button/react';

let ready = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function Boot({ onApi }) {
  const { connect } = useAppKitWallet();
  const account = useAppKitAccount();
  const { walletProvider } = useAppKitProvider('solana');
  const { disconnect } = useDisconnect();
  const api = useRef({});
  api.current = { connect, account, provider: walletProvider, disconnect };
  useEffect(() => { onApi(api); }, []);
  return null;
}

function load(projectId, cluster) {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    try {
      createAppKit({
        adapters: [new SolanaAdapter({ wallets: [] })],
        networks: [cluster === 'devnet' ? networks.solanaDevnet : networks.solana],
        projectId,
        metadata: {
          name: document.title || 'Token Sale',
          description: 'Token sale',
          url: location.origin,
          icons: [`${location.origin}/favicon.ico`],
        },
        features: { analytics: false, socials: false, email: false },
        enableWallets: false,
      });
    } catch (e) { reject(e); return; }
    const host = document.createElement('div');
    host.style.display = 'none';
    document.body.append(host);
    const timer = setTimeout(() => reject(new Error('Jupiter connect did not start')), 15000);
    createRoot(host).render(React.createElement(Boot, { onApi: (api) => { clearTimeout(timer); resolve(api); } }));
  });
  return ready;
}

export async function createJupiterAdapter({ projectId, cluster }) {
  const api = await load(projectId, cluster);
  let address = null;
  return {
    name: 'Jupiter',
    async connect() {
      if (!api.current.provider?.publicKey) {
        try { await api.current.connect('jupiter'); } catch { /* the loop below reports a timeout if nothing connects */ }
      }
      const end = Date.now() + 120000;
      while (Date.now() < end) {
        const key = api.current.provider?.publicKey;
        if (key) { address = key.toBase58(); return address; }
        await sleep(500);
      }
      throw new Error('Jupiter did not approve in time. Please try again.');
    },
    async sign(tx) {
      const p = api.current.provider;
      if (!p?.signTransaction) throw new Error('Jupiter is not connected');
      // Use this bundle's own copy of web3.js so the wallet always gets the type it expects.
      const signed = await p.signTransaction(VersionedTransaction.deserialize(tx.serialize()));
      return signed.serialize();
    },
    async disconnect() { try { await api.current.disconnect(); } catch { /* ignore */ } },
  };
}
