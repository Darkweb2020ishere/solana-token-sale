// Shared by the server (builds + re-checks) and the browser (re-checks before asking the wallet to sign).
// The purchase is ONE atomic transaction with exactly three instructions:
//   1. create the buyer's token account if needed (rent paid by the seller)
//   2. buyer pays `lamports` SOL to the receiver
//   3. seller sends `tokenRaw` tokens to the buyer
// Anything else is rejected by decodePurchase().
import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
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
