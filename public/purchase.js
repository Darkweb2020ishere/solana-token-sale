// Shared by the server (builds + re-checks) and the browser (re-checks before asking the wallet to sign).
// The purchase is ONE atomic transaction with exactly three instructions:
//   1. create the buyer's token account if needed (rent paid by the seller)
//   2. buyer pays `lamports` SOL to the receiver
//   3. seller sends `tokenRaw` tokens to the buyer
// Anything else is rejected by decodePurchase().
import {
  AddressLookupTableAccount,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const LAMPORTS_PER_SOL = 1_000_000_000n;

export function tokensForLamports(lamports, tokensPerSol, decimals) {
  return (lamports * BigInt(tokensPerSol) * 10n ** BigInt(decimals)) / LAMPORTS_PER_SOL;
}

export function parseUnits(text, decimals) {
  const s = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Enter a valid number');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

export function formatUnits(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function buildPurchase({ buyer, seller, receiver, mint, decimals, lamports, tokenRaw, blockhash }) {
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer);
  const sellerAta = getAssociatedTokenAddressSync(mint, seller);
  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(seller, buyerAta, buyer, mint),
    SystemProgram.transfer({ fromPubkey: buyer, toPubkey: receiver, lamports }),
    createTransferCheckedInstruction(sellerAta, mint, buyerAta, seller, tokenRaw, decimals),
  ];
  const message = new TransactionMessage({
    payerKey: seller,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

const fail = (why) => {
  throw new Error(`Unexpected transaction: ${why}`);
};

// Strictly decodes a purchase transaction. Throws unless it is exactly the three instructions above.
export function decodePurchase(tx, { seller, receiver, mint }) {
  const msg = tx.message;
  if (msg.addressTableLookups.length) fail('lookup tables');
  if (msg.header.numRequiredSignatures !== 2) fail('signer count');
  const keys = msg.staticAccountKeys;
  if (!keys[0].equals(seller)) fail('fee payer is not the seller');
  const buyer = keys[1];
  if (buyer.equals(seller) || buyer.equals(receiver)) fail('bad buyer');

  const ixs = TransactionMessage.decompile(msg).instructions;
  if (ixs.length !== 3) fail('instruction count');
  const [ata, pay, deliver] = ixs;
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer);
  const sellerAta = getAssociatedTokenAddressSync(mint, seller);

  if (!ata.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || ata.data.length !== 1 || ata.data[0] !== 1) fail('account setup');
  const [k0, k1, k2, k3] = ata.keys.map((k) => k.pubkey);
  if (!k0.equals(seller) || !k1.equals(buyerAta) || !k2.equals(buyer) || !k3.equals(mint)) fail('account setup keys');

  if (!pay.programId.equals(SystemProgram.programId) || SystemInstruction.decodeInstructionType(pay) !== 'Transfer') fail('payment');
  const t = SystemInstruction.decodeTransfer(pay);
  if (!t.fromPubkey.equals(buyer) || !t.toPubkey.equals(receiver)) fail('payment route');
  const lamports = BigInt(t.lamports);
  if (lamports <= 0n) fail('payment amount');

  if (!deliver.programId.equals(TOKEN_PROGRAM_ID) || deliver.data[0] !== 12) fail('delivery');
  const d = decodeTransferCheckedInstruction(deliver, TOKEN_PROGRAM_ID);
  if (
    !d.keys.mint.pubkey.equals(mint) ||
    !d.keys.source.pubkey.equals(sellerAta) ||
    !d.keys.destination.pubkey.equals(buyerAta) ||
    !d.keys.owner.pubkey.equals(seller)
  ) {
    fail('delivery route');
  }
  if (d.data.amount <= 0n) fail('delivery amount');

  return {
    buyer: buyer.toBase58(),
    buyerAta: buyerAta.toBase58(),
    lamports,
    tokenRaw: BigInt(d.data.amount),
    decimals: d.data.decimals,
  };
}

export const pk = (s) => new PublicKey(s);

// ---------------------------------------------------------------------------
// Phase 2: pay with any SPL token. One atomic transaction:
//   compute budget (set by the seller) -> create receiver's wSOL account (seller pays rent, idempotent)
//   -> create buyer's sale-token account (seller pays rent, idempotent)
//   -> ONE Jupiter swap: buyer's token -> wSOL straight into the receiver's wSOL account
//   -> seller delivers the sale tokens to the buyer.
// If the swap fails, the delivery never happens. If anything fails, nothing moves.
// ---------------------------------------------------------------------------
export const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
export const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
export const WSOL = NATIVE_MINT;

export const isTokenPurchase = (tx) => tx.message.staticAccountKeys.some((k) => k.equals(JUPITER_V6));
export const tableKeys = (tx) => tx.message.addressTableLookups.map((l) => l.accountKey);

export async function loadLookupTables(conn, keys) {
  if (!keys.length) return [];
  const infos = await conn.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)));
  return infos.map((info, i) => {
    if (!info) throw new Error('Lookup table not found');
    return new AddressLookupTableAccount({
      key: new PublicKey(keys[i]),
      state: AddressLookupTableAccount.deserialize(info.data),
    });
  });
}

// Strictly decodes a token purchase. `tables` are the lookup tables the message uses (fetch with loadLookupTables).
// Throws unless the transaction is exactly the shape above and the swap cannot touch the seller's assets.
export function decodeTokenPurchase(tx, { seller, receiver, mint, payMint }, tables) {
  const msg = tx.message;
  if (msg.header.numRequiredSignatures !== 2) fail('signer count');
  const keys = msg.staticAccountKeys;
  if (!keys[0].equals(seller)) fail('fee payer is not the seller');
  const buyer = keys[1];
  if (buyer.equals(seller) || buyer.equals(receiver)) fail('bad buyer');

  const ixs = TransactionMessage.decompile(msg, { addressLookupTableAccounts: tables }).instructions;
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer);
  const sellerAta = getAssociatedTokenAddressSync(mint, seller);
  const recvWsol = getAssociatedTokenAddressSync(WSOL, receiver);
  const srcAta = getAssociatedTokenAddressSync(payMint, buyer);

  let limits = 0, prices = 0, ataBuyer = 0, ataRecv = 0, swapAt = -1, deliverAt = -1;
  ixs.forEach((ix, i) => {
    if (ix.programId.equals(COMPUTE_BUDGET)) {
      if (ix.data[0] === 2) limits++;
      else if (ix.data[0] === 3) prices++;
      else fail('compute budget');
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (ix.data.length !== 1 || ix.data[0] !== 1) fail('account setup');
      const [payer, ata, owner, m] = ix.keys.map((k) => k.pubkey);
      if (!payer.equals(seller)) fail('account setup payer');
      if (ata.equals(buyerAta) && owner.equals(buyer) && m.equals(mint)) ataBuyer++;
      else if (ata.equals(recvWsol) && owner.equals(receiver) && m.equals(WSOL)) ataRecv++;
      else fail('account setup keys');
    } else if (ix.programId.equals(JUPITER_V6)) {
      if (swapAt >= 0) fail('multiple swaps');
      swapAt = i;
    } else if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 12) {
      if (deliverAt >= 0) fail('multiple deliveries');
      deliverAt = i;
    } else {
      fail('program not allowed');
    }
  });
  if (limits > 1 || prices > 1 || ataBuyer !== 1 || ataRecv !== 1) fail('setup steps');
  if (swapAt < 0 || deliverAt !== ixs.length - 1 || swapAt > deliverAt) fail('swap or delivery missing');

  const swap = ixs[swapAt];
  for (const k of swap.keys) {
    if (k.pubkey.equals(seller) || k.pubkey.equals(sellerAta)) fail('swap touches the seller');
    if (k.isSigner && !k.pubkey.equals(buyer)) fail('swap signer');
  }
  const swapKeys = swap.keys.map((k) => k.pubkey);
  if (!swapKeys.some((k) => k.equals(srcAta)) || !swapKeys.some((k) => k.equals(recvWsol))) fail('swap route');

  // Jupiter route data ends with: in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8
  const sd = swap.data;
  if (sd.length < 27) fail('swap data');
  const amountIn = new DataView(sd.buffer, sd.byteOffset, sd.byteLength).getBigUint64(sd.length - 19, true);
  if (sd[sd.length - 1] !== 0) fail('swap fee');
  if (amountIn <= 0n) fail('swap amount');

  const deliver = ixs[deliverAt];
  const d = decodeTransferCheckedInstruction(deliver, TOKEN_PROGRAM_ID);
  if (
    !d.keys.mint.pubkey.equals(mint) ||
    !d.keys.source.pubkey.equals(sellerAta) ||
    !d.keys.destination.pubkey.equals(buyerAta) ||
    !d.keys.owner.pubkey.equals(seller)
  ) {
    fail('delivery route');
  }
  if (d.data.amount <= 0n) fail('delivery amount');

  return {
    buyer: buyer.toBase58(),
    srcAta: srcAta.toBase58(),
    buyerAta: buyerAta.toBase58(),
    recvWsol: recvWsol.toBase58(),
    amountIn,
    tokenRaw: BigInt(d.data.amount),
    decimals: d.data.decimals,
  };
}
