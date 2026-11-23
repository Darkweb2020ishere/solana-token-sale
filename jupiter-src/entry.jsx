// EXACT README setup of @jup-ag/jup-mobile-adapter (https://github.com/TeamRaccoons/jup-mobile-adapter):
// useWrappedReownAdapter -> [reownAdapter, jupiterAdapter] -> <WalletProvider wallets autoConnect>.
// Built by `npm run build` into public/jupiter-bundle.js; loaded only when a buyer taps Jupiter.
import React, { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';
import { useWrappedReownAdapter } from '@jup-ag/jup-mobile-adapter';

let ready = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function Bridge({ onApi }) {
  const w = useWallet();
  const api = useRef(w);
  api.current = w;
  useEffect(() => { onApi(api); }, []);
  return null;
}

function WalletConnectionProvider({ projectId, onApi }) {
  // Refer to https://reown.com/appkit
  const { reownAdapter, jupiterAdapter } = useWrappedReownAdapter({
    appKitOptions: {
      metadata: {
        name: document.title || 'Token Sale',
        description: 'Token sale',
        url: location.origin, // origin must match your domain & subdomain
        icons: [`${location.origin}/favicon.ico`],
      },
      projectId,
      features: {
        analytics: false,
        socials: ['google', 'x', 'apple'],
        email: false,
      },
      enableWallets: false,
    },
  });

  const wallets = useMemo(() => [reownAdapter, jupiterAdapter], []);

  return React.createElement(WalletProvider, { wallets, autoConnect: true },
    React.createElement(Bridge, { onApi }));
}

function load(projectId) {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const host = document.createElement('div');
    host.style.display = 'none';
    document.body.append(host);
    const timer = setTimeout(() => reject(new Error('Jupiter connect did not start')), 15000);
    createRoot(host).render(React.createElement(WalletConnectionProvider, {
      projectId,
      onApi: (api) => { clearTimeout(timer); resolve(api); },
    }));
  });
  return ready;
}

export async function createJupiterAdapter({ projectId, log = () => {} }) {
  const api = await load(projectId);
  log('wallet provider ready');
  const NAME = 'Jupiter Mobile';
  return {
    name: 'Jupiter',
    onLink: null,
    async connect() {
      api.current.select(NAME);
      const end = Date.now() + 5000;
      while (api.current.wallet?.adapter?.name !== NAME && Date.now() < end) await sleep(100);
      if (api.current.wallet?.adapter?.name !== NAME) throw new Error('Jupiter Mobile was not found in the wallet list');
      log('selected Jupiter Mobile; connecting');
      await api.current.connect();
      const end2 = Date.now() + 5000;
      while (!api.current.publicKey && Date.now() < end2) await sleep(100);
      const key = api.current.publicKey;
      if (!key) throw new Error('Jupiter did not return a Solana account');
      return key.toBase58();
    },
    async sign(tx) {
      if (!api.current.signTransaction) throw new Error('Jupiter is not connected');
      const signed = await api.current.signTransaction(VersionedTransaction.deserialize(tx.serialize()));
      return signed.serialize();
    },
    async disconnect() { try { await api.current.disconnect(); } catch { /* ignore */ } },
  };
}
