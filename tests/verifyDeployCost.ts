/**
 * Uji kalkulator biaya mainnet (`scripts/deployCost.ts`).
 *
 * Tujuan utama: mengunci **fakta** yang sering salah dipahami —
 * PDA tidak menghapus rent. Rent = fungsi ukuran data, bukan jenis alamat:
 *   (128 + ukuran) × 6960 lamports
 * Deploy program membayar akun `ProgramData` (milik BPF loader), sama sekali
 * tidak bergantung pada program Anda memakai PDA atau keypair biasa.
 */
import assert from 'node:assert/strict';
import {
  ACCOUNT_SIZES,
  ACCOUNT_STORAGE_OVERHEAD,
  LAMPORTS_PER_BYTE_YEAR,
  LAMPORTS_PER_SOL,
  PROGRAMDATA_METADATA_SIZE,
  PROGRAM_ACCOUNT_SIZE,
  RENT_EXEMPT_YEARS,
  buildReport,
  deployCost,
  formatSol,
  lamportsToSol,
  poolCost,
  rentExemptLamports,
  tokenMintRent,
} from '../scripts/deployCost';

const solve = (bytes: number) =>
  (ACCOUNT_STORAGE_OVERHEAD + bytes) * LAMPORTS_PER_BYTE_YEAR * RENT_EXEMPT_YEARS;

// --- Rumus rent-exempt ------------------------------------------------------
assert.equal(rentExemptLamports(0), 128 * 6960);
assert.equal(rentExemptLamports(10 * 1024), 72_161_280); // 0.07216128 SOL — angka umum "10 KB ≈ 0.072 SOL"
assert.equal(formatSol(72_192_000), '0.0722');
assert.equal(rentExemptLamports(100), solve(100));
assert.throws(() => rentExemptLamports(-1), RangeError);

// Rent hanya bergantung pada ukuran — tidak ada parameter "pemilik"/"PDA".
assert.equal(rentExemptLamports(289), solve(289));
assert.equal(lamportsToSol(LAMPORTS_PER_SOL), 1);

// --- Biaya deploy -----------------------------------------------------------
const small = deployCost(64 * 1024);
const big = deployCost(128 * 1024);
assert.equal(small.programAccount, solve(PROGRAM_ACCOUNT_SIZE));
assert.equal(
  small.programData,
  solve(64 * 1024 + PROGRAMDATA_METADATA_SIZE),
  'ProgramData = ukuran .so + 45 B metadata'
);
assert.equal(small.peak, small.programAccount + small.programData * 2, 'buffer = 1x programdata');
assert.equal(small.final, small.programAccount + small.programData);
assert.ok(big.programData > small.programData, 'deploy naik linear dengan ukuran');
assert.equal(big.programData, solve(128 * 1024 + PROGRAMDATA_METADATA_SIZE));
// Konstanta 128 B (overhead) + 45 B (metadata) hanya dihitung sekali per akun,
// sehingga 2x ukuran ≈ 2x rent dikurangi satu konstanta itu.
assert.equal(
  big.programData - 2 * small.programData,
  -(ACCOUNT_STORAGE_OVERHEAD + PROGRAMDATA_METADATA_SIZE) * LAMPORTS_PER_BYTE_YEAR * RENT_EXEMPT_YEARS,
  'rent naik linear terhadap ukuran data saja'
);
assert.match(small.maxLenNote, /pas/);

const padded = deployCost(64 * 1024, 256 * 1024);
assert.ok(padded.programData > small.programData, '--max-len lebih besar = rent lebih besar');
assert.match(padded.maxLenNote, /--max-len 262144/);

// 150 KB (ukuran tipikal program Anchor kecil) → ~1.07 SOL final.
const typical = deployCost(150 * 1024);
assert.equal(formatSol(typical.final), '1.0714');
assert.ok(
  lamportsToSol(typical.peak) > 2 && lamportsToSol(typical.peak) < 2.2,
  'puncak ~2.14 SOL (programdata + buffer)'
);

// --- Biaya per pool ---------------------------------------------------------
const pool = poolCost();
assert.equal(pool.poolState, solve(8 + 281), 'PoolState = 8 B disc + 281 B');
assert.equal(pool.lpMint, solve(ACCOUNT_SIZES.mint));
assert.equal(pool.vaultsX4, solve(ACCOUNT_SIZES.tokenAccount) * 4);
assert.equal(pool.ataPdaLp, solve(ACCOUNT_SIZES.tokenAccount));
assert.equal(pool.total, 14_560_320);
assert.equal(formatSol(pool.total), '0.0146');
assert.equal(pool.pdaAtas, solve(165) * 2);
assert.equal(pool.totalWithPdaAtas, pool.total + pool.pdaAtas);
assert.ok(
  pool.totalWithPdaAtas > pool.total,
  'interposer PDA justru MENAMBAH rent (2 ATA milik PDA), bukan mengurangi'
);

// --- Mint Token-2022 --------------------------------------------------------
const mint = tokenMintRent('Nusantara Token', 'NUSA', 'ipfs://QmExample');
assert.ok(mint.bytes > 234, 'base mint 234 B (MetadataPointer) belum termasuk TokenMetadata');
assert.equal(mint.lamports, rentExemptLamports(mint.bytes));

// Angka yang dipakai dokumen §2.6 (default `tokenMintRent()` = sampel README).
assert.equal(formatSol(tokenMintRent().lamports), '0.0038');

// --- Laporan ---------------------------------------------------------------
const noBinary = buildReport(null);
assert.equal(noBinary.deploy, null);
assert.equal(noBinary.launchTotal, null);
assert.equal(noBinary.table.length, 6);
assert.deepEqual(noBinary.table[1], { kb: 150, finalSol: '1.0714', peakSol: '2.1417' });

const withBinary = buildReport(150 * 1024);
assert.ok(withBinary.deploy && withBinary.launchTotal !== null);
assert.equal(
  withBinary.launchTotal,
  withBinary.deploy!.final + withBinary.mint.lamports + withBinary.pool.totalWithPdaAtas
);
// Modal minimum realistis untuk 1 token + 1 pool lewat interposer: ~1.11 SOL.
assert.ok(withBinary.launchTotal! > 1_000_000_000);
assert.ok(withBinary.launchTotal! < 1_200_000_000);

console.log('ALL DEPLOY COST TESTS PASSED!');
console.log({
  rentZeroBytesSol: formatSol(rentExemptLamports(0), 6),
  rent10KbSol: formatSol(rentExemptLamports(10 * 1024), 6),
  deploy150KbFinalSol: formatSol(typical.final),
  deploy150KbPeakSol: formatSol(typical.peak),
  perPoolSol: formatSol(pool.total),
  perPoolWithPdaAtasSol: formatSol(pool.totalWithPdaAtas),
  mintToken2022Sol: formatSol(mint.lamports),
  launchTotalSol: formatSol(withBinary.launchTotal!),
});
