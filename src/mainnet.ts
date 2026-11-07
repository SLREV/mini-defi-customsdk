import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { POOL_STATE_SIZE, SPL_MINT_SIZE } from './sdk/customSdk';

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PACKET_LIMIT = 1232;
// Token-2022 ATA accounts can include ImmutableOwner: 165 + account type + TLV header.
const TOKEN_ACCOUNT_MAX_BASE = 170;
const SOL_BUFFER_LAMPORTS = 2_000_000n;

export async function assertMainnet(connection: Connection, programId: PublicKey): Promise<void> {
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) {
    throw new Error('RPC bukan Solana Mainnet Beta. Transaksi dibatalkan.');
  }
  const account = await connection.getAccountInfo(programId, 'confirmed');
  if (!account?.executable) throw new Error(`Program AMM ${programId.toBase58()} belum tersedia di mainnet.`);
}

/** Conservative upper-bound for expected rent, not a promise of exact final cost. */
export function launchRentAccountSizes(mintBytes: number): number[] {
  // Mint; pool state; LP mint; vault X/Y, creator fee vault X/Y; creator ATA and LP ATA.
  return [mintBytes, POOL_STATE_SIZE, SPL_MINT_SIZE, ...Array(6).fill(TOKEN_ACCOUNT_MAX_BASE)];
}

export function validatePacketSize(tx: Transaction): number {
  try {
    const length = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    if (length > PACKET_LIMIT) throw new Error('too large');
    return length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/too large|encoding overruns|out of range/i.test(message)) {
      throw new Error(`Transaksi gabungan melampaui batas ${PACKET_LIMIT} byte. Pendekkan nama, URI, Telegram atau Twitter; transaksi tidak dikirim.`);
    }
    throw err;
  }
}

/** Fail closed when RPC cannot price a message or read rent/balance. */
export async function preflightMainnetBalance(
  conn: Pick<Connection, 'getBalance' | 'getMinimumBalanceForRentExemption' | 'getFeeForMessage'>,
  payer: PublicKey, tx: Transaction, rentSizes: number[], transferLamports = 0n,
): Promise<{ balance: bigint; required: bigint; fee: bigint; rent: bigint }> {
  validatePacketSize(tx);
  const [balance, feeResult, ...rents] = await Promise.all([
    conn.getBalance(payer, 'confirmed'),
    conn.getFeeForMessage(tx.compileMessage(), 'confirmed'),
    ...rentSizes.map((size) => conn.getMinimumBalanceForRentExemption(size, 'confirmed')),
  ]);
  if (feeResult.value === null) throw new Error('RPC tidak dapat menghitung biaya transaksi. Coba ulang.');
  const fee = BigInt(feeResult.value);
  const rent = rents.reduce((acc, amount) => acc + BigInt(amount), 0n);
  const required = fee + rent + transferLamports + SOL_BUFFER_LAMPORTS;
  if (BigInt(balance) < required) {
    throw new Error(`Saldo SOL tidak mencukupi. Tersedia ${balance} lamports, estimasi minimum ${required} lamports (fee, rent, transfer dan cadangan).`);
  }
  return { balance: BigInt(balance), required, fee, rent };
}

/** A single wallet submission; publish the signature before waiting for confirmation. */
export async function sendMainnetTransaction(
  connection: Connection,
  programId: PublicKey,
  payer: PublicKey,
  transaction: Transaction,
  signers: import('@solana/web3.js').Signer[],
  rentSizes: number[],
  transferLamports: bigint,
  send: (transaction: Transaction, connection: Connection, options: { signers: import('@solana/web3.js').Signer[]; skipPreflight: false; preflightCommitment: 'confirmed' }) => Promise<string>,
  checkWallet: () => void,
  onEstimate: (required: bigint) => void,
  onSubmitted: (signature: string) => void,
): Promise<string> {
  await assertMainnet(connection, programId);
  const block = await connection.getLatestBlockhash('confirmed');
  transaction.feePayer = payer;
  transaction.recentBlockhash = block.blockhash;
  const estimate = await preflightMainnetBalance(connection, payer, transaction, rentSizes, transferLamports);
  onEstimate(estimate.required);
  await assertMainnet(connection, programId);
  checkWallet();
  let sent = '';
  try {
    sent = await send(transaction, connection, { signers, skipPreflight: false, preflightCommitment: 'confirmed' });
    onSubmitted(sent);
    const confirmation = await connection.confirmTransaction({ signature: sent, ...block }, 'confirmed');
    if (confirmation.value.err) throw new Error(`Transaksi gagal on-chain: ${JSON.stringify(confirmation.value.err)}`);
    return sent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (sent) throw new Error(`Transaksi ${sent} sudah dikirim. Periksa status di Explorer sebelum mencoba ulang. ${message}`);
    throw new Error(`Wallet/RPC tidak mengembalikan signature. Periksa riwayat wallet sebelum mencoba ulang. ${message}`);
  }
}
