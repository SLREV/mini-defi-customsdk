/**
 * Verifikasi SDK native: layout instruksi, PDA, paritas matematika dengan
 * program Anchor repo induk, dan angka biaya. Tidak butuh RPC.
 */
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  DEFAULT_NATIVE_PROGRAM_ID,
  NATIVE_SOL_MINT,
  POOL_STATE_DISCRIMINATOR,
  POOL_STATE_LEN,
  POOL_STATE_OFFSETS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildCreateAtaIdempotent,
  buildFundPool,
  buildInitializePool,
  buildSwap,
  computeSwapOut,
  decodePoolState,
  deriveAssociatedTokenAddress,
  deriveFeeVault,
  derivePoolState,
  formatTokenAmount,
  parseTokenAmount,
  readU64Le,
  rentExemptLamports,
} from '../src/sdk/nativePool';
import { calculateSwapOutput } from '../../src/sdk/customSdk';

const payer = Keypair.generate().publicKey;
const mintY = Keypair.generate().publicKey;

// ---------------------------------------------------------------------------
// 1. Payload & jumlah akun — dijaga agar cocok dengan processor.rs
// ---------------------------------------------------------------------------
const pool = buildInitializePool({
  payer,
  mintX: NATIVE_SOL_MINT,
  mintY,
  tokenProgramX: TOKEN_PROGRAM_ID,
  tokenProgramY: TOKEN_2022_PROGRAM_ID,
  virtualReservesX: 30_000_000_000n,
});
assert.equal(pool.instruction.data.length, 9, 'initialize_pool: 1 disc + 8 u64');
assert.equal(pool.instruction.data[0], 0);
assert.equal(readU64Le(pool.instruction.data, 1), 30_000_000_000n);
assert.equal(pool.instruction.keys.length, 9, 'initialize_pool: 9 akun');
// 2 ATA vault + 2 fee vault (create + init) = 6 instruksi bantu
assert.equal(pool.ataInstructions.length, 6);

const fund = buildFundPool({
  creator: payer,
  mintX: NATIVE_SOL_MINT,
  mintY,
  tokenProgramY: TOKEN_2022_PROGRAM_ID,
  amount: 800_000_000_000_000_000n,
});
assert.equal(fund.data.length, 9);
assert.equal(fund.data[0], 1);
assert.equal(fund.keys.length, 6, 'fund_pool: 6 akun');

const swap = buildSwap({
  user: payer,
  mintX: NATIVE_SOL_MINT,
  mintY,
  tokenProgramX: TOKEN_PROGRAM_ID,
  tokenProgramY: TOKEN_2022_PROGRAM_ID,
  amountIn: 100_000_000n,
  minAmountOut: 1n,
  xToY: true,
});
assert.equal(swap.data.length, 18, 'swap: 18 byte (kompatibel SDK induk)');
assert.equal(swap.data[0], 2);
assert.equal(swap.data[17], 1, 'x_to_y = 1 (offset 17 = byte terakhir)');
assert.equal(swap.keys.length, 12, 'swap: 12 akun');

const swapReverse = buildSwap({
  user: payer,
  mintX: NATIVE_SOL_MINT,
  mintY,
  tokenProgramX: TOKEN_PROGRAM_ID,
  tokenProgramY: TOKEN_2022_PROGRAM_ID,
  amountIn: 1n,
  minAmountOut: 0n,
  xToY: false,
});
assert.equal(swapReverse.data[17], 0);

// ---------------------------------------------------------------------------
// 2. PDA: seed harus sama dengan `POOL_SEED` di processor.rs
// ---------------------------------------------------------------------------
const { poolState, bump } = derivePoolState(NATIVE_SOL_MINT, mintY, DEFAULT_NATIVE_PROGRAM_ID);
assert.deepEqual(
  PublicKey.findProgramAddressSync(
    [Buffer.from('amm_pool', 'utf8'), NATIVE_SOL_MINT.toBuffer(), mintY.toBuffer()],
    DEFAULT_NATIVE_PROGRAM_ID
  ),
  [poolState, bump]
);

// Fee vault TIDAK boleh sama dengan vault ATA (bug yang mudah terjadi).
const vaultY = deriveAssociatedTokenAddress(poolState, mintY, TOKEN_2022_PROGRAM_ID);
const feeVaultY = deriveFeeVault('y', poolState, DEFAULT_NATIVE_PROGRAM_ID);
assert.notEqual(vaultY.toBase58(), feeVaultY.toBase58(), 'fee vault != vault ATA');
assert.equal(pool.vaultY.toBase58(), vaultY.toBase58());
assert.equal(pool.feeVaultY.toBase58(), feeVaultY.toBase58());
// Bump PDA pool harus < 256 dan address-nya deterministik.
assert.ok(bump >= 0 && bump < 256);

// ---------------------------------------------------------------------------
// 3. Paritas matematika dengan SDK induk
// ---------------------------------------------------------------------------
const reserves: [bigint, bigint][] = [
  [30_000_000_000n, 800_000_000_000_000_000n],
  [45_000_000_000n, 500_000_000_000_000_000n],
  [1_000_000_000n, 1_000_000_000n],
];
let parityCases = 0;
let zeroRejected = 0;
for (const [reserveIn, reserveOut] of reserves) {
  for (const amountIn of [1n, 1_000_000n, 100_000_000n, 1_000_000_000n, 5_000_000_000n]) {
    let parent: bigint | null = null;
    let mine: bigint | null = null;
    try {
      parent = calculateSwapOutput(amountIn, reserveIn, reserveOut);
    } catch {
      parent = null;
    }
    try {
      mine = computeSwapOut(amountIn, reserveIn, reserveOut).amountOut;
    } catch {
      mine = null;
    }
    if (mine === null || parent === null) {
      // Keduanya menolak input yang menghasilkan 0 (pembulatan) — perilaku sama,
      // dan sesuai `require!(amount_out > 0)` di on-chain.
      assert.equal(mine, parent, `penolakan tidak konsisten: in=${amountIn}`);
      zeroRejected += 1;
      continue;
    }
    assert.equal(mine, parent, `paritas gagal: in=${amountIn} rIn=${reserveIn}`);
    parityCases += 1;
  }
}
assert.ok(parityCases >= 10, `kasus paritas terlalu sedikit: ${parityCases}`);

// Fee creator 6 bps, dibulatkan ke bawah.
const quote = computeSwapOut(1_000_000_000n, 30_000_000_000n, 800_000_000_000_000_000n);
assert.equal(quote.creatorFee, 600_000n);
assert.equal(quote.netIn, 999_400_000n);
assert.ok(quote.amountOut > 0n && quote.amountOut < 800_000_000_000_000_000n);

// Input tidak valid harus melempar, bukan diam-diam menghasilkan 0.
for (const bad of [
  () => computeSwapOut(0n, 1n, 1n),
  () => computeSwapOut(1n, 0n, 1n),
  () => computeSwapOut(1n, 1n, 0n),
]) {
  assert.throws(bad);
}

// ---------------------------------------------------------------------------
// 4. Decode state: offset 1/33/65/73, ukuran 81
// ---------------------------------------------------------------------------
assert.equal(POOL_STATE_LEN, 81);
assert.equal(rentExemptLamports(POOL_STATE_LEN), 1_454_640);

const raw = new Uint8Array(POOL_STATE_LEN);
raw[POOL_STATE_OFFSETS.discriminator] = POOL_STATE_DISCRIMINATOR;
const vaultXPubkey = Keypair.generate().publicKey;
raw.set(vaultXPubkey.toBuffer(), POOL_STATE_OFFSETS.vaultX);
raw.set(vaultY.toBuffer(), POOL_STATE_OFFSETS.vaultY);
new DataView(raw.buffer).setBigUint64(POOL_STATE_OFFSETS.virtualReservesX, 42_000_000_000n, true);
raw[POOL_STATE_OFFSETS.bump] = bump;

const decoded = decodePoolState(poolState, raw);
assert.equal(decoded.vaultX.toBase58(), vaultXPubkey.toBase58());
assert.equal(decoded.vaultY.toBase58(), vaultY.toBase58());
assert.equal(decoded.virtualReservesX, 42_000_000_000n);
assert.equal(decoded.bump, bump);

assert.throws(() => decodePoolState(poolState, new Uint8Array(80)), /harus 81/);
const wrongDisc = raw.slice();
wrongDisc[0] = 0;
assert.throws(() => decodePoolState(poolState, wrongDisc), /discriminator/);

// ---------------------------------------------------------------------------
// 5. Angka & biaya
// ---------------------------------------------------------------------------
assert.equal(formatTokenAmount(1_500_000_000_000n, 9), '1,500');
assert.equal(parseTokenAmount('1.5', 9), 1_500_000_000n);
assert.throws(() => parseTokenAmount('1.2345678901', 9));
assert.equal(rentExemptLamports(165), 2_039_280);

// ATA idempotent: index 1, 6 akun.
const ata = buildCreateAtaIdempotent(payer, payer, mintY, TOKEN_PROGRAM_ID);
assert.deepEqual([...ata.data], [1]);
assert.equal(ata.keys.length, 6);

console.log('ALL NATIVE POOL TESTS PASSED!');
console.log({
  parityCases,
  zeroRejected,
  poolState: poolState.toBase58(),
  bump,
  feeVaultY: feeVaultY.toBase58(),
  swapPayloadBytes: swap.data.length,
  swapAccounts: swap.keys.length,
  quoteOut: quote.amountOut.toString(),
  poolStateRentSol: (rentExemptLamports(POOL_STATE_LEN) / 1e9).toFixed(6),
});
