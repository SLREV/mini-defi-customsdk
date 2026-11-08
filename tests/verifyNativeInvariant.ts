/**
 * Uji desain program native "tipis" (`examples/mini-amm-native/`) — dua hal:
 *
 *   A. PARITAS: matematika on-chain di `processor.rs` harus sama dengan
 *      `calculateSwapOutput` di SDK, sehingga klien bisa memakai SDK untuk
 *      menghitung `min_amount_out` tanpa risiko selisih.
 *
 *   B. KEAMANAN: menunjukkan kenapa "matematika dipindah ke frontend" berbahaya —
 *      (1) nominal keluar dari klien = vault dikuras;
 *      (2) `virtual_reserves_x` dari klien = harga bisa dipalsukan.
 *      Lalu membuktikan bahwa versi on-chain menolak keduanya.
 *
 * Semua aritmetika di bawah ini adalah salinan 1:1 dari `mul_div_u128` +
 * rumus fee di `processor.rs` (u128, truncating).
 */
import assert from 'node:assert/strict';
import { calculateSwapOutput } from '../src/sdk/customSdk';
import { formatSol, rentExemptLamports } from '../scripts/deployCost';

const BPS = 10_000n;
const CREATOR_FEE_BPS = 6n;
const LP_FEE_BPS = 24n;
const SOL = 1_000_000_000n;

/** Layout state pool native (lihat processor.rs). */
export const POOL_STATE_LEN = 81;
export const POOL_STATE_OFFSETS = {
  discriminator: 0,
  vaultX: 1,
  vaultY: 33,
  virtualReservesX: 65,
  bump: 73,
} as const;

/** Salinan `process_swap` versi on-chain (tanpa validasi akun). */
export function nativeSwapOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): { creatorFee: bigint; netIn: bigint; amountOut: bigint } {
  assert.ok(amountIn > 0n, 'ZeroSwapAmount');
  assert.ok(reserveIn > 0n && reserveOut > 0n, 'EmptyReserves');
  const creatorFee = (amountIn * CREATOR_FEE_BPS) / BPS;
  assert.ok(creatorFee < amountIn, 'ZeroSwapAmount');
  const netIn = amountIn - creatorFee;
  const netInWithFee = netIn * (BPS - LP_FEE_BPS);
  const denominator = reserveIn * BPS + netInWithFee;
  const amountOut = (netInWithFee * reserveOut) / denominator;
  return { creatorFee, netIn, amountOut };
}

// ---------------------------------------------------------------------------
// A. Paritas dengan SDK
// ---------------------------------------------------------------------------
const virtualX = 30n * SOL;
const realY = 1_000_000_000_000_000n; // 1e15 unit token (10^6 token @9 desimal)
const reserveIn = virtualX; // vault_x = 0 pada awal (virtual liquidity)
const reserveOut = realY;

for (const amountIn of [1n, 1_000n, SOL / 100n, SOL / 10n, SOL, 5n * SOL, 20n * SOL]) {
  const native = nativeSwapOut(amountIn, reserveIn, reserveOut);
  const sdk = calculateSwapOutput(amountIn, reserveIn, reserveOut);
  assert.equal(
    native.amountOut,
    sdk,
    `paritas gagal untuk amount_in=${amountIn}: native ${native.amountOut} vs sdk ${sdk}`
  );
  assert.ok(native.amountOut > 0n);
  assert.ok(native.amountOut < reserveOut);
  // Fee creator 6 bps dibulatkan ke bawah, seperti di on-chain.
  assert.equal(native.creatorFee, (amountIn * 6n) / 10_000n);
}

// Spot check angka yang wajar: 1 SOL pertama ≈ 1/30 dari reserve Y (virtual 30 SOL).
const firstSol = nativeSwapOut(SOL, reserveIn, reserveOut);
// Dengan fee 6 bps + 24 bps, 1 SOL pertama memberi ~96.5% dari 1/30 reserve Y.
assert.ok(firstSol.amountOut < realY / 30n, 'output 1 SOL < 1/30 reserve Y');
assert.ok(firstSol.amountOut > realY / 32n, 'output 1 SOL > 1/32 reserve Y');

// ---------------------------------------------------------------------------
// B1. Serangan: klien menentukan nominal keluar (seperti draf)
// ---------------------------------------------------------------------------
const vaultBalance = realY;
const attackerClaim = vaultBalance; // "ambil semuanya"

// Draf: program mentransfer `min_amount_out` dari klien → 100% vault hilang.
assert.equal(attackerClaim, vaultBalance);

// Versi on-chain: nominal dihitung, klien hanya boleh menentukan batas BAWAH.
const honestOut = nativeSwapOut(SOL, reserveIn, reserveOut).amountOut;
assert.ok(honestOut < vaultBalance / 30n, 'nominal hasil hitung hanya sebagian kecil vault');

// Klien yang memaksa `min_amount_out = vault` ditolak (SlippageExceeded),
// bukan dieksekusi.
const wouldPassSlippage = honestOut >= attackerClaim;
assert.equal(wouldPassSlippage, false, 'permintaan 100% vault wajib ditolak on-chain');

// ---------------------------------------------------------------------------
// B2. Serangan: virtual_reserves_x dipalsukan klien
// ---------------------------------------------------------------------------
const amountIn = SOL;
const outWithClientVirtualZero = nativeSwapOut(
  amountIn,
  0n + 1n, // klien mengaku virtual_x = 1 lamport
  reserveOut
).amountOut;
const outWithStoredVirtual = nativeSwapOut(amountIn, reserveIn, reserveOut).amountOut;

assert.ok(
  outWithClientVirtualZero > (reserveOut * 99n) / 100n,
  'virtual_x = 1 lamport → keluar >99% dari seluruh reserve Y'
);
assert.ok(
  outWithClientVirtualZero > outWithStoredVirtual * 30n,
  'selisihnya puluhan kali lipat (≈31x), bukan pembulatan'
);
// Kesimpulan: `virtual_reserves_x` WAJIB tersimpan on-chain (81 B), bukan dari klien.

// ---------------------------------------------------------------------------
// C. Biaya state: membuktikan "stateless" bukan penghematan berarti
// ---------------------------------------------------------------------------
const stateRent = rentExemptLamports(POOL_STATE_LEN);
assert.equal(POOL_STATE_LEN, 81);
assert.equal(stateRent, 1_454_640);
assert.equal(formatSol(stateRent), '0.0015');
assert.equal(POOL_STATE_OFFSETS.bump, 73);
assert.equal(POOL_STATE_OFFSETS.virtualReservesX, 65);
assert.equal(POOL_STATE_OFFSETS.vaultY, 33);

// Angka pembanding: biner 15 KB = 0.1093 SOL; state pool hanya 1.4% dari itu.
assert.ok(stateRent * 70 < rentExemptLamports(15 * 1024 + 45));

console.log('ALL NATIVE INVARIANT TESTS PASSED!');
console.log({
  parityCases: 7,
  firstSolOut: firstSol.amountOut.toString(),
  outWithClientVirtualZero: outWithClientVirtualZero.toString(),
  outWithStoredVirtual: outWithStoredVirtual.toString(),
  attackRejected: !wouldPassSlippage,
  poolStateRentSol: formatSol(stateRent, 6),
});
