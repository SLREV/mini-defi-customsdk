import assert from 'node:assert/strict';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionConfirmationStrategy } from '@solana/web3.js';
import { CustomDefiSDK, NATIVE_SOL_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, parseTokenAmount } from '../src/sdk/customSdk';
import { MAINNET_GENESIS, assertMainnet, launchRentAccountSizes, preflightMainnetBalance, sendMainnetTransaction, validatePacketSize } from '../src/mainnet';

class Rpc extends Connection {
  genesis = MAINNET_GENESIS;
  executable = true;
  balance = 100_000_000;
  fee: number | null = 10_000;
  confirmationFailure = false;
  confirmStrategy: unknown;
  constructor() { super('https://mock.invalid'); }
  override async getGenesisHash() { return this.genesis; }
  override async getAccountInfo() { return this.executable ? { data: Buffer.alloc(0), executable: true, lamports: 1, owner: PublicKey.default } : null; }
  override async getLatestBlockhash() { return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 }; }
  override async getBalance() { return this.balance; }
  override async getMinimumBalanceForRentExemption(size: number) { return size * 10 + 1000; }
  override async getFeeForMessage() { return { context: { slot: 1 }, value: this.fee }; }
  override async confirmTransaction(strategy: TransactionConfirmationStrategy | string) {
    this.confirmStrategy = strategy;
    if (this.confirmationFailure) throw new Error('RPC timeout');
    return { context: { slot: 1 }, value: { err: null } };
  }
}
async function main() {
  const rpc = new Rpc(); const payer = Keypair.generate().publicKey; const program = Keypair.generate().publicKey;
  const sdk = new CustomDefiSDK(rpc, program); const mintKeypair = Keypair.generate();
  const clone = await sdk.buildCloneTokenInstructions({ mint: mintKeypair.publicKey, payer, name: 'Test', symbol: 'TST', imageUri: 'https://example.com/i', initialSupplyRaw: parseTokenAmount('1000000'), authorities: { mint: false, freeze: false, metadata: false } });
  const pool = await sdk.buildCreatePoolTx({ payer, tokenX: NATIVE_SOL_MINT, tokenY: clone.mint, tokenProgramX: TOKEN_PROGRAM_ID, tokenProgramY: TOKEN_2022_PROGRAM_ID, initialRealTokenY: parseTokenAmount('1000000'), virtualReservesX: parseTokenAmount('30') });
  assert(clone.userTokenAta.equals(pool.userTokenY));
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...clone.instructions, pool.instruction);
  tx.feePayer = payer; tx.recentBlockhash = PublicKey.default.toBase58();
  assert(validatePacketSize(tx) <= 1232);
  assert.equal(tx.instructions.filter((ix) => ix.programId.equals(program)).length, 1);
  assert(tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures).some((key) => key.equals(mintKeypair.publicKey)));
  const over = await sdk.buildCloneTokenInstructions({ mint: mintKeypair.publicKey, payer, name: 'Very long token name for testing', symbol: 'TST', imageUri: 'https://example.com/' + 'a'.repeat(100), telegram: 'https://t.me/' + 'b'.repeat(60), twitter: 'https://x.com/' + 'c'.repeat(60), initialSupplyRaw: 1n, authorities: { mint: false, freeze: false, metadata: false } });
  const tooLarge = new Transaction().add(...over.instructions, pool.instruction); tooLarge.feePayer = payer; tooLarge.recentBlockhash = PublicKey.default.toBase58();
  assert.throws(() => validatePacketSize(tooLarge), /melampaui batas/);
  const sizes = launchRentAccountSizes(clone.allocatedMintBytes); assert.equal(sizes.length, 9);
  const estimate = await preflightMainnetBalance(rpc, payer, tx, sizes, 123n);
  assert.equal(estimate.required, 2_000_000n + 10_000n + sizes.reduce((x, s) => x + BigInt(s * 10 + 1000), 0n) + 123n);
  rpc.balance = Number(estimate.required - 1n);
  await assert.rejects(preflightMainnetBalance(rpc, payer, tx, sizes, 123n), /tidak mencukupi/);
  rpc.balance = 100_000_000; rpc.fee = null; await assert.rejects(preflightMainnetBalance(rpc, payer, tx, sizes), /tidak dapat menghitung/); rpc.fee = 10_000;
  rpc.genesis = 'devnet'; await assert.rejects(assertMainnet(rpc, program), /bukan Solana Mainnet/); rpc.genesis = MAINNET_GENESIS;
  rpc.executable = false; await assert.rejects(assertMainnet(rpc, program), /belum tersedia/); rpc.executable = true;
  let sends = 0; let submitted = '';
  const send = async (t: Transaction, conn: Connection, options: { signers: import('@solana/web3.js').Signer[]; skipPreflight: false; preflightCommitment: 'confirmed' }) => {
    sends++; assert.equal(t, tx); assert.equal(conn, rpc); assert.equal(options.signers[0], mintKeypair); assert.equal(options.skipPreflight, false); return 'signature-test';
  };
  const execute = () => sendMainnetTransaction(rpc, program, payer, tx, [mintKeypair], sizes, 0n, send, () => {}, () => {}, (sig) => { submitted = sig; });
  rpc.balance = 0; await assert.rejects(execute(), /tidak mencukupi/); assert.equal(sends, 0);
  rpc.balance = 100_000_000; rpc.genesis = 'devnet'; await assert.rejects(execute(), /bukan Solana Mainnet/); assert.equal(sends, 0); rpc.genesis = MAINNET_GENESIS;
  assert.equal(await execute(), 'signature-test'); assert.equal(sends, 1); assert.equal(submitted, 'signature-test');
  assert.deepEqual(rpc.confirmStrategy, { signature: 'signature-test', blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 });
  rpc.confirmationFailure = true; await assert.rejects(execute(), /signature-test sudah dikirim/); assert.equal(sends, 2); assert.equal(submitted, 'signature-test');
  console.log('MAINNET ATOMIC LAUNCH AND SAFETY TESTS PASSED (MOCKS ONLY)');
}
main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
