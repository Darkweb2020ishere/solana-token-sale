// Jupiter Mobile connect, using Jupiter's own adapter (@jup-ag/jup-mobile-adapter).
// Built by `npm run build` into public/jupiter-bundle.js. It is loaded ONLY when the buyer taps Jupiter.
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { VersionedTransaction } from '@solana/web3.js';
import { useWrappedReownAdapter } from '@jup-ag/jup-mobile-adapter';

let ready = null;

function Boot({ projectId, onAdapter }) {
  const { jupiterAdapter } = useWrappedReownAdapter({
    appKitOptions: {
      metadata: {
        name: document.title || 'Token Sale',
        description: 'Token sale',
        url: location.origin,
        icons: [`${location.origin}/favicon.ico`],
      },
      projectId,
      features: { analytics: false, socials: false, email: false },
      enableWallets: false,
    },
  });
  useEffect(() => { if (jupiterAdapter) onAdapter(jupiterAdapter); }, [jupiterAdapter]);
  return null;
}

function load(projectId) {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const host = document.createElement('div');
    host.style.display = 'none';
    document.body.append(host);
    const timer = setTimeout(() => reject(new Error('Jupiter connect did not start')), 15000);
    createRoot(host).render(
      React.createElement(Boot, { projectId, onAdapter: (a) => { clearTimeout(timer); resolve(a); } }),
    );
  });
  return ready;
}

export async function createJupiterAdapter({ projectId }) {
  const j = await load(projectId);
  let address = null;
  return {
    name: 'Jupiter',
    async connect() {
      await j.connect();
      const key = j.publicKey;
      if (!key) throw new Error('Jupiter did not return a Solana account');
      address = key.toBase58();
      return address;
    },
    async sign(tx) {
      // Use this bundle's own copy of web3.js so the wallet adapter always gets the type it expects.
      const own = VersionedTransaction.deserialize(tx.serialize());
      const signed = await j.signTransaction(own);
      return signed.serialize();
    },
    async disconnect() { try { await j.disconnect(); } catch { /* ignore */ } },
  };
}
