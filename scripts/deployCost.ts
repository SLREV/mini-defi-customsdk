/**
 * Kalkulator biaya mainnet — berapa SOL yang benar-benar terkunci saat deploy & per pool.
 *
 * Latar belakang: "pakai PDA jadi tidak perlu sewa 1–3 SOL" adalah miskonsepsi. Rent
 * di Solana adalah **deposit per byte** pada akun mana pun (termasuk PDA), dan deploy
 * program membayar rent sebuah akun `ProgramData` milik BPF loader — bukan akun program
 * Anda, jadi tidak ada hubungannya dengan PDA.
 *
 * Pemakaian:
 *   npm run cost:deploy                 # baca target/deploy/mini_amm.so
 *   npm run cost:deploy -- --size 153600
 *   npm run cost:deploy -- --json
 *
 * Semua angka mengikuti rumus rent-exempt Solana:
 *   (128 + ukuran_byte) × 3480 lamports/byte-tahun × 2 tahun = (128 + ukuran) × 6960
 * Akun `ProgramData` menambah 45 byte metadata; akun `Program` 36 byte.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateToken2022MintTotalBytes } from '../src/sdk/customSdk';

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const LAMPORTS_PER_BYTE_YEAR = 3480;
export const RENT_EXEMPT_YEARS = 2;
/** Solana: `ACCOUNT_STORAGE_OVERHEAD`. */
export const ACCOUNT_STORAGE_OVERHEAD = 128;
/** `UpgradeableLoaderState::size_of_program()` */
export const PROGRAM_ACCOUNT_SIZE = 36;
/** `UpgradeableLoaderState::size_of_programdata_metadata()` */
export const PROGRAMDATA_METADATA_SIZE = 45;

/** Ukuran akun yang dibuat repo ini (lihat lib.rs / customSdk.ts). */
export const ACCOUNT_SIZES = {
  /** 8 B discriminator Anchor + 281 B PoolState. */
  poolState: 8 + 281,
  /** SPL/Token-2022 mint dasar. */
  mint: 82,
  /** SPL/Token-2022 token account dasar. */
  tokenAccount: 165,
} as const;

/** Rent-exempt minimum (lamports) untuk `bytes` byte data. */
export function rentExemptLamports(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError('ukuran akun harus >= 0');
  }
  return Math.ceil(
    (ACCOUNT_STORAGE_OVERHEAD + bytes) * LAMPORTS_PER_BYTE_YEAR * RENT_EXEMPT_YEARS
  );
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

/** Format SOL ringkas: 0.0714 / 2.1400 */
export function formatSol(lamports: number, digits = 4): string {
  return lamportsToSol(lamports).toFixed(digits);
}

export interface DeployCost {
  binaryBytes: number;
  programAccount: number;
  programData: number;
  /** Rent buffer yang harus tersedia bersamaan saat deploy (buffer + programdata). */
  peak: number;
  /** Rent yang tersisa setelah deploy selesai (buffer dikembalikan/tertutup). */
  final: number;
  /** Tambahan bila `--max-len` dipakai lebih besar dari ukuran binary. */
  maxLenNote: string;
}

export function deployCost(binaryBytes: number, maxLen = binaryBytes): DeployCost {
  const programAccount = rentExemptLamports(PROGRAM_ACCOUNT_SIZE);
  const programData = rentExemptLamports(Math.max(binaryBytes, maxLen) + PROGRAMDATA_METADATA_SIZE);
  return {
    binaryBytes,
    programAccount,
    programData,
    peak: programAccount + programData * 2,
    final: programAccount + programData,
    maxLenNote:
      maxLen > binaryBytes
        ? `--max-len ${maxLen} menambah ${formatSol(
            rentExemptLamports(maxLen + PROGRAMDATA_METADATA_SIZE) - programData
          )} SOL yang tidak perlu`
        : 'pas: --max-len = ukuran .so',
  };
}

export interface PoolCost {
  poolState: number;
  lpMint: number;
  vaultsX4: number;
  ataPdaLp: number;
  total: number;
  /** Dua ATA milik PDA (mint X & Y) yang wajib ada untuk swap lewat PDA. */
  pdaAtas: number;
  totalWithPdaAtas: number;
}

/** Rent yang dibayar `payer` saat `initialize_pool` (17 akun). */
export function poolCost(): PoolCost {
  const poolState = rentExemptLamports(ACCOUNT_SIZES.poolState);
  const lpMint = rentExemptLamports(ACCOUNT_SIZES.mint);
  const vault = rentExemptLamports(ACCOUNT_SIZES.tokenAccount);
  const vaultsX4 = vault * 4; // vault_x, vault_y, fee_vault_x, fee_vault_y
  const ataPdaLp = vault; // ATA LP (init_if_needed)
  const total = poolState + lpMint + vaultsX4 + ataPdaLp;
  const pdaAtas = vault * 2;
  return {
    poolState,
    lpMint,
    vaultsX4,
    ataPdaLp,
    total,
    pdaAtas,
    totalWithPdaAtas: total + pdaAtas,
  };
}

/** Rent mint Token-2022 (MetadataPointer + TokenMetadata dinamis). */
export function tokenMintRent(name = 'Nusantara', symbol = 'NUSA', uri = 'ipfs://Qm…'): {
  bytes: number;
  lamports: number;
} {
  const bytes = calculateToken2022MintTotalBytes({
    name,
    symbol,
    uri,
    additionalMetadata: [
      ['telegram', 'https://t.me/nusantara'],
      ['twitter', 'https://x.com/nusantara'],
    ],
  });
  return { bytes, lamports: rentExemptLamports(bytes) };
}

export interface Report {
  deploy: DeployCost | null;
  pool: PoolCost;
  mint: { bytes: number; lamports: number };
  /** Deploy + 1 mint + 1 pool + 2 ATA PDA (skenario interposer). */
  launchTotal: number | null;
  /** Ukuran umum bila .so belum ada. */
  table: Array<{ kb: number; finalSol: string; peakSol: string }>;
}

export const COMMON_SIZES_KB = [100, 150, 200, 250, 300, 400];

export function buildReport(binaryBytes: number | null, maxLen?: number): Report {
  const deploy = binaryBytes === null ? null : deployCost(binaryBytes, maxLen ?? binaryBytes);
  const pool = poolCost();
  const mint = tokenMintRent();
  const table = COMMON_SIZES_KB.map((kb) => {
    const c = deployCost(kb * 1024);
    return {
      kb,
      finalSol: formatSol(c.final),
      peakSol: formatSol(c.peak),
    };
  });
  const launchTotal =
    deploy === null ? null : deploy.final + mint.lamports + pool.totalWithPdaAtas;
  return { deploy, pool, mint, launchTotal, table };
}

function readBinarySize(explicit?: number): number | null {
  if (explicit !== undefined) return explicit;
  const candidates = [
    'target/deploy/mini_amm.so',
    'target/deploy/mini_amm.so.debug',
  ];
  for (const rel of candidates) {
    const path = resolve(process.cwd(), rel);
    if (existsSync(path) && rel.endsWith('.so')) return statSync(path).size;
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const sizeIdx = argv.indexOf('--size');
  const explicit = sizeIdx >= 0 ? Number(argv[sizeIdx + 1]) : undefined;
  if (sizeIdx >= 0 && (!Number.isFinite(explicit) || (explicit as number) <= 0)) {
    console.error('--size harus angka byte positif, mis. --size 153600');
    process.exit(1);
  }
  const maxLenIdx = argv.indexOf('--max-len');
  const maxLen = maxLenIdx >= 0 ? Number(argv[maxLenIdx + 1]) : undefined;

  const binaryBytes = readBinarySize(explicit);
  const report = buildReport(binaryBytes, maxLen);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n=== Biaya mainnet: deploy program ===');
  if (report.deploy) {
    const d = report.deploy;
    console.log(`Binary            : ${(d.binaryBytes / 1024).toFixed(1)} KB`);
    console.log(`Akun Program (36B): ${formatSol(d.programAccount)} SOL`);
    console.log(`ProgramData       : ${formatSol(d.programData)} SOL  (rent-exempt, ${d.maxLenNote})`);
    console.log(`Puncak saat deploy: ${formatSol(d.peak)} SOL  (programdata + buffer)`);
    console.log(`Tersisa setelahnya: ${formatSol(d.final)} SOL  (buffer ditutup, rent kembali)`);
  } else {
    console.log('target/deploy/mini_amm.so belum ada — jalankan `anchor build` dulu,');
    console.log('atau pakai --size <byte>. Perkiraan berdasarkan ukuran umum:');
    for (const row of report.table) {
      console.log(
        `  ${String(row.kb).padStart(4)} KB → final ${row.finalSol} SOL, puncak ${row.peakSol} SOL`
      );
    }
  }

  const p = report.pool;
  console.log('\n=== Biaya per pool (dibayar `payer` saat initialize_pool) ===');
  console.log(`PoolState 289B    : ${formatSol(p.poolState)} SOL`);
  console.log(`LP mint 82B       : ${formatSol(p.lpMint)} SOL`);
  console.log(`4 vault 165B      : ${formatSol(p.vaultsX4)} SOL`);
  console.log(`ATA LP 165B       : ${formatSol(p.ataPdaLp)} SOL`);
  console.log(`Total per pool    : ${formatSol(p.total)} SOL`);
  console.log(`+ 2 ATA milik PDA : ${formatSol(p.pdaAtas)} SOL → ${formatSol(p.totalWithPdaAtas)} SOL`);

  console.log('\n=== Mint Token-2022 (per token) ===');
  console.log(
    `${report.mint.bytes} B (MetadataPointer + TokenMetadata) : ${formatSol(report.mint.lamports)} SOL`
  );

  if (report.launchTotal !== null) {
    console.log(`\nModal minimum 1 token + 1 pool + interposer PDA : ${formatSol(report.launchTotal)} SOL`);
  }

  console.log('\n=== Yang TIDAK dihemat oleh PDA ===');
  console.log('- Rent program dihitung dari ukuran .so (akun ProgramData milik BPF loader).');
  console.log('- PDA dengan data tetap kena (128 + ukuran) × 6960 lamports.');
  console.log('- Rent pool/vault tidak bisa diklaim kembali: repo ini tidak punya instruksi close.');
  console.log('\n=== Yang benar-benar menghemat ===');
  console.log('- Deploy sekali, banyak pool (biaya deploy tidak berulang).');
  console.log('- Uji dulu di devnet (SOL devnet gratis).');
  console.log('- Kecilkan .so (opt-level="z", strip) dan pakai --max-len = ukuran .so.');
  console.log('- Deploy gagal? Tutup buffer: solana program close <BUFFER_ADDRESS>.');
  console.log('- anchor deploy 0.31.1 tidak membuat akun IDL on-chain (tidak ada rent IDL).\n');
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) main();
