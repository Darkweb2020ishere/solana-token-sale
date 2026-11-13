// One serverless function: /api/config, /api/tokens, /api/quote, /api/submit, /api/status
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMint,
} from '@solana/spl-token';
import {
  WSOL,
  buildPurchase,
  decodePurchase,
  decodeTokenPurchase,
  isTokenPurchase,
  loadLookupTables,
  parseUnits,
  tableKeys,
  tokensForLamports,
} from '../public/purchase.js';

const env = process.env;
const LAMPORTS_PER_SOL = 1_000_000_000;
const toLamports = (s) => BigInt(Math.round(Number(s) * LAMPORTS_PER_SOL));

const conn = new Connection(env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const cluster = env.CLUSTER === 'devnet' ? 'devnet' : 'mainnet-beta';
const chain = cluster === 'devnet' ? 'solana:devnet' : 'solana:mainnet';
// Browsers are blocked (403) by api.mainnet-beta.solana.com, so the buyer's browser needs its own RPC list (comma-separated, no secret keys).
const publicRpcs = (env.PUBLIC_RPC_URL || 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com').split(',').map((u) => u.trim()).filter(Boolean);

function loadSeller() {
  const raw = (env.SELLER_SECRET_KEY || '').trim();
  if (!raw) return null;
  return Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
}
const seller = loadSeller();
const receiver = env.RECEIVER_ADDRESS ? new PublicKey(env.RECEIVER_ADDRESS) : null;
const mint = env.TOKEN_MINT ? new PublicKey(env.TOKEN_MINT) : null;
const tokensPerSol = Number(env.TOKENS_PER_SOL || 0);
const minLamports = toLamports(env.MIN_SOL || '0.01');
const maxLamports = toLamports(env.MAX_SOL || '10');
const enabled = Boolean(seller && receiver && mint && tokensPerSol > 0);

// Jupiter (get a free key at https://portal.jup.ag). Paying with other tokens needs a mainnet key.
const JUP = (env.JUPITER_BASE || 'https://api.jup.ag').replace(/\/$/, '');
const jupHeaders = { 'content-type': 'application/json', ...(env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : {}) };
const swapEnabled = enabled && cluster === 'mainnet-beta' && Boolean(env.JUPITER_API_KEY);
const SLIPPAGE_BPS = Number(env.SLIPPAGE_BPS || 150);
const CU_LIMIT = Number(env.CU_LIMIT || 600_000);
const CU_PRICE = Number(env.CU_PRICE_MICROLAMPORTS || 50_000);

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// Token-2022 extensions we refuse as a PAYMENT token, because they can change or block a transfer in ways the
// sale cannot predict. (Names are looked up safely so an older spl-token version simply skips ones it lacks.)
const BLOCKED_EXTENSIONS = ['TransferHook', 'NonTransferable', 'PausableConfig']
  .map((name) => ExtensionType[name])
  .filter((v) => v !== undefined);

// Which token program owns this mint: classic or Token-2022. Anything else is not a token we accept.
async function tokenProgramOf(mintKey) {
  const info = await conn.getAccountInfo(mintKey);
  if (info && (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) return info.owner;
  throw new Error('That token is not supported');
}

async function jup(path, init = {}) {
  const r = await fetch(JUP + path, { ...init, headers: jupHeaders });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || `Jupiter error ${r.status}`);
  return j;
}

const asIx = (i) =>
  new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(i.data, 'base64'),
  });

const tokenAmount = (acc) => (acc && acc.data.length >= 72 ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n);
const fromSim = (a) => (a ? { data: Buffer.from(a.data[0], 'base64'), lamports: a.lamports } : null);

// Simulates the transaction and checks the REAL balance changes, so we do not have to trust Jupiter's response.
async function verifyEffects(tx, d, simOpts) {
  const addrs = [d.recvWsol, d.srcAta, d.buyerAta, d.buyer].map((a) => new PublicKey(a));
  const pre = await conn.getMultipleAccountsInfo(addrs);
  const sim = await conn.simulateTransaction(tx, {
    commitment: 'confirmed',
    ...simOpts,
    accounts: { encoding: 'base64', addresses: addrs.map((a) => a.toBase58()) },
  });
  if (sim.value.err) {
    const err = JSON.stringify(sim.value.err);
    if (err.includes('BlockhashNotFound')) throw new Error('Quote expired. Please get a new quote.');
    throw new Error(`Swap would fail (${err}). Try a smaller amount or another token.`);
  }
  const post = sim.value.accounts.map(fromSim);
  const [recvPre, srcPre, ataPre, buyerPre] = pre;
  const [recvPost, srcPost, ataPost, buyerPost] = post;

  const received = tokenAmount(recvPost) - tokenAmount(recvPre);
  const spent = tokenAmount(srcPre) - tokenAmount(srcPost);
  const delivered = tokenAmount(ataPost) - tokenAmount(ataPre);
  const solBefore = BigInt(buyerPre?.lamports ?? 0);
  const solAfter = BigInt(buyerPost?.lamports ?? 0);

  if (spent < 0n || spent > d.amountIn) throw new Error('Check failed: unexpected amount leaves your wallet');
  if (tokensForLamports(received, tokensPerSol, d.decimals) < d.tokenRaw) throw new Error('Check failed: payment would be too low');
  if (delivered !== d.tokenRaw) throw new Error('Check failed: delivery amount mismatch');
  if (solAfter < solBefore) throw new Error('Check failed: your SOL balance would change');
  return { spent, received };
}

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    if (action === 'config') {
      if (!enabled) return res.json({ enabled: false });
      const { decimals } = await getMint(conn, mint);
      return res.json({
        enabled: true, chain, cluster, publicRpcs, swapEnabled,
        seller: seller.publicKey.toBase58(), receiver: receiver.toBase58(), mint: mint.toBase58(),
        decimals, tokensPerSol,
        minSol: Number(minLamports) / LAMPORTS_PER_SOL, maxSol: Number(maxLamports) / LAMPORTS_PER_SOL,
      });
    }

    if (action === 'status') {
      const { value } = await conn.getSignatureStatuses([String(req.query.sig || '')]);
      const st = value[0];
      return res.json({ status: st?.err ? 'failed' : st?.confirmationStatus || 'unknown' });
    }

    // Tokens the buyer can pay with: classic SPL tokens held in their standard (associated) token accounts.
    if (action === 'tokens') {
      if (!swapEnabled) return res.json({ tokens: [] });
      const owner = new PublicKey(String(req.query.owner));
      const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
      const lists = await Promise.all(programs.map(async (programId) => {
        const { value } = await conn.getParsedTokenAccountsByOwner(owner, { programId });
        return value.map((a) => ({ addr: a.pubkey.toBase58(), info: a.account.data.parsed.info, programId }));
      }));
      let held = lists.flat().filter(({ addr, info, programId }) =>
          BigInt(info.tokenAmount.amount) > 0n &&
          info.mint !== mint.toBase58() &&
          addr === getAssociatedTokenAddressSync(new PublicKey(info.mint), owner, false, programId).toBase58());
      held = held.slice(0, 100);
      let meta = new Map();
      let known = false;
      try {
        if (held.length) {
          const list = await jup(`/tokens/v2/search?query=${held.map((h) => h.info.mint).join(',')}`);
          meta = new Map(list.map((t) => [t.id, t]));
          known = true;
        }
      } catch { /* fall back to showing mints */ }
      const tokens = held
        .filter((h) => !known || meta.has(h.info.mint))
        .map((h) => ({
          mint: h.info.mint,
          symbol: meta.get(h.info.mint)?.symbol || `${h.info.mint.slice(0, 4)}…${h.info.mint.slice(-4)}`,
          name: meta.get(h.info.mint)?.name || '',
          decimals: h.info.tokenAmount.decimals,
          amount: h.info.tokenAmount.amount,
        }));
      return res.json({ tokens });
    }

    if (req.method !== 'POST') return bad(res, 'POST required', 405);
    if (!enabled) return bad(res, 'The sale is not open yet', 503);

    if (action === 'quote') {
      const buyer = new PublicKey(String(req.body.buyer));
      const { decimals } = await getMint(conn, mint);
      const { blockhash } = await conn.getLatestBlockhash('confirmed');

      // ---- Pay with SOL ----
      if (!req.body.payMint) {
        const lamports = toLamports(req.body.sol);
        if (lamports < minLamports || lamports > maxLamports) return bad(res, 'Amount outside the allowed range');
        const tokenRaw = tokensForLamports(lamports, tokensPerSol, decimals);
        const [balance, stock] = await Promise.all([
          conn.getBalance(buyer),
          conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, seller.publicKey)),
        ]);
        if (BigInt(balance) < lamports) return bad(res, 'Not enough SOL in your wallet');
        if (BigInt(stock.value.amount) < tokenRaw) return bad(res, 'Not enough tokens left for that amount');
        const tx = buildPurchase({ buyer, seller: seller.publicKey, receiver, mint, decimals, lamports, tokenRaw, blockhash });
        tx.sign([seller]);
        return res.json({ transaction: Buffer.from(tx.serialize()).toString('base64') });
      }

      // ---- Pay with another token (swapped to SOL by Jupiter inside the same transaction) ----
      if (!swapEnabled) return bad(res, 'Paying with other tokens is not available yet');
      const payMint = new PublicKey(String(req.body.payMint));
      if (payMint.equals(mint) || payMint.equals(WSOL)) return bad(res, 'Choose a different token');
      const payProgram = await tokenProgramOf(payMint);
      const payMintInfo = await getMint(conn, payMint, 'confirmed', payProgram);
      if (payProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        const blocked = getExtensionTypes(payMintInfo.tlvData).filter((t) => BLOCKED_EXTENSIONS.includes(t));
        if (blocked.length) return bad(res, 'This token has special rules (transfer hook, pausable or non-transferable) that this sale cannot accept. Please pay with another token.');
      }
      const payDecimals = payMintInfo.decimals;
      const amountIn = parseUnits(req.body.amount, payDecimals);
      if (amountIn <= 0n) return bad(res, 'Enter an amount');

      const srcAta = getAssociatedTokenAddressSync(payMint, buyer, false, payProgram);
      const [src, stock] = await Promise.all([
        conn.getTokenAccountBalance(srcAta).catch(() => null),
        conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, seller.publicKey)),
      ]);
      if (!src || BigInt(src.value.amount) < amountIn) return bad(res, 'Not enough of that token in your wallet');

      const quote = await jup('/swap/v1/quote?' + new URLSearchParams({
        inputMint: payMint.toBase58(), outputMint: WSOL.toBase58(), amount: amountIn.toString(),
        slippageBps: String(SLIPPAGE_BPS), swapMode: 'ExactIn', restrictIntermediateTokens: 'true', maxAccounts: '40',
      }));
      const minOut = BigInt(quote.otherAmountThreshold); // guaranteed SOL (lamports) reaching the receiver
      if (minOut < minLamports) return bad(res, `Too small. Minimum purchase is ${Number(minLamports) / LAMPORTS_PER_SOL} SOL worth.`);
      if (minOut > maxLamports) return bad(res, `Too large. Maximum purchase is ${Number(maxLamports) / LAMPORTS_PER_SOL} SOL worth.`);
      const tokenRaw = tokensForLamports(minOut, tokensPerSol, decimals);
      if (BigInt(stock.value.amount) < tokenRaw) return bad(res, 'Not enough tokens left for that amount');

      const recvWsol = getAssociatedTokenAddressSync(WSOL, receiver);
      const built = await jup('/swap/v1/swap-instructions', {
        method: 'POST',
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: buyer.toBase58(),
          destinationTokenAccount: recvWsol.toBase58(),
          wrapAndUnwrapSol: false,
          dynamicComputeUnitLimit: false,
        }),
      });
      // The buyer may have zero SOL, so the SELLER pays for any account setup Jupiter asks for.
      const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
      const buyerAtaKey = getAssociatedTokenAddressSync(mint, buyer).toBase58();
      const unsupported = [];
      if (built.cleanupInstruction) unsupported.push('cleanup');
      if (built.tokenLedgerInstruction) unsupported.push('ledger');
      if (built.otherInstructions?.length) unsupported.push('other');
      const setup = [];
      for (const i of built.setupInstructions || []) {
        const ix = asIx(i);
        const funder = ix.keys[0]?.pubkey;
        if (i.programId !== ATA || !funder?.equals(buyer)) { unsupported.push(`setup:${i.programId.slice(0, 6)}`); continue; }
        const target = ix.keys[1].pubkey.toBase58();
        if (target === recvWsol.toBase58() || target === buyerAtaKey) continue; // we already create these ourselves
        ix.keys[0] = { pubkey: seller.publicKey, isSigner: true, isWritable: true };
        setup.push(ix);
      }
      if (unsupported.length) {
        console.error('Unsupported Jupiter route', JSON.stringify({ payMint: payMint.toBase58(), unsupported }));
        return bad(res, `That token needs a route this sale cannot sponsor yet (${unsupported.join(', ')}). Try a smaller amount or another token.`);
      }

      const tables = await loadLookupTables(conn, built.addressLookupTableAddresses || []);
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }),
        createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, recvWsol, receiver, WSOL),
        createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, getAssociatedTokenAddressSync(mint, buyer), buyer, mint),
        ...setup,
        asIx(built.swapInstruction),
        createTransferCheckedInstruction(
          getAssociatedTokenAddressSync(mint, seller.publicKey), mint, getAssociatedTokenAddressSync(mint, buyer),
          seller.publicKey, tokenRaw, decimals,
        ),
      ];
      const tx = new VersionedTransaction(
        new TransactionMessage({ payerKey: seller.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(tables),
      );
      let bytes;
      try { bytes = tx.serialize(); } catch { return bad(res, 'That swap route is too large. Try a smaller amount or another token.'); }

      // Self-check the transaction, then check the real balance changes by simulation.
      const d = decodeTokenPurchase(tx, { seller: seller.publicKey, receiver, mint, payMint, payProgram }, tables);
      if (d.amountIn !== amountIn) return bad(res, 'Quote mismatch. Please try again.');
      await verifyEffects(tx, d, { sigVerify: false, replaceRecentBlockhash: true });

      tx.sign([seller]);
      return res.json({
        transaction: Buffer.from(tx.serialize()).toString('base64'),
        minOutLamports: minOut.toString(),
      });
    }

    if (action === 'submit') {
      const tx = VersionedTransaction.deserialize(Buffer.from(String(req.body.transaction), 'base64'));
      if (isTokenPurchase(tx)) {
        if (!swapEnabled) return bad(res, 'Paying with other tokens is not available yet');
        const tables = await loadLookupTables(conn, tableKeys(tx));
        const payMint = new PublicKey(String(req.body.payMint));
        const payProgram = await tokenProgramOf(payMint);
        const d = decodeTokenPurchase(tx, { seller: seller.publicKey, receiver, mint, payMint, payProgram }, tables);
        await verifyEffects(tx, d, { sigVerify: true });
      } else {
        decodePurchase(tx, { seller: seller.publicKey, receiver, mint });
        const sim = await conn.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
        if (sim.value.err) return bad(res, `Transaction would fail: ${JSON.stringify(sim.value.err)}`);
      }
      const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      return res.json({ signature });
    }

    return bad(res, 'Not found', 404);
  } catch (e) {
    return bad(res, e.message || 'Server error');
  }
}
