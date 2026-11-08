#!/usr/bin/env node
/**
 * Build program native lalu UKUR `.so` dan hitung biaya deploy mainnet.
 *
 *   node scripts/program-build.mjs              # build + ukur + biaya
 *   node scripts/program-build.mjs --measure     # pakai .so yang sudah ada (tanpa build)
 *
 * Kenapa perlu: biaya deploy Solana = rent dari ukuran `.so`. Tanpa mengukur, angka
 * "15 KB / 0.15 SOL" hanya perkiraan. Skrip ini mencetak angka sebenarnya.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const programDir = join(root, 'program');
const measureOnly = process.argv.includes('--measure');

const LAMPORTS_PER_SOL = 1_000_000_000;
const PER_BYTE = 6960;
const rent = (bytes) => (128 + bytes) * PER_BYTE;
const sol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(4);

function findSo() {
  const candidates = [
    join(programDir, 'target', 'deploy'),
    join(root, 'target', 'deploy'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith('.so'));
    if (files.length === 0) continue;
    const newest = files
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f;
    return join(dir, newest);
  }
  return null;
}

if (!measureOnly) {
  const hasSbf = spawnSync('cargo-build-sbf', ['--version'], { stdio: 'ignore' });
  if (hasSbf.error || hasSbf.status !== 0) {
    console.error('\n✘ `cargo-build-sbf` tidak ditemukan.');
    console.error('  Pasang: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"');
    console.error('  lalu:   cargo-build-sbf --version');
    console.error('\n  Atau build di mesin lain, copy `.so` ke sini, lalu:');
    console.error('  node scripts/program-build.mjs --measure\n');
    process.exit(1);
  }

  // `cargo-build-sbf` build release secara default; flag `--release` DITOLAK
  // ("Found argument '--release' which wasn't expected") pada CLI Solana.
  console.log('→ cargo build-sbf (program/)');
  const build = spawnSync('cargo', ['build-sbf'], {
    cwd: programDir,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    console.error('\n✘ Build gagal. Cek error di atas.');
    process.exit(build.status ?? 1);
  }
}

const soPath = findSo();
if (!soPath) {
  console.error('\n✘ Tidak ada file .so di program/target/deploy.');
  console.error('  Jalankan build dulu: node scripts/program-build.mjs\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Program ID: `cargo build-sbf` TIDAK pernah membuat keypair deploy.
// ---------------------------------------------------------------------------
const keypairPath = join(programDir, 'target', 'deploy', 'mini_amm_native-keypair.json');
if (!existsSync(keypairPath)) {
  console.log('');
  console.log('⚠ Keypair program belum ada:', keypairPath.replace(root + '/', ''));
  console.log('  `cargo build-sbf` hanya menghasilkan .so, bukan keypair deploy.');
  console.log('  Jalankan:  npm run program:keypair');
  console.log('  (sinkronkan ID, lalu WAJIB build ulang sebelum deploy)');
  console.log('  Jika sudah pernah deploy, pulihkan keypair asli dari cadangan.');
}

const bytes = statSync(soPath).size;
const programData = rent(bytes + 45);
const programAccount = rent(36);
const final = programData + programAccount;
const peak = programData * 2 + programAccount;

// Acuan: 1 KB = 1024 B. Harga per KB dipakai untuk melihat dampak 1 perubahan kode.
const perKb = (rent(1024 + 45) - rent(45)) / LAMPORTS_PER_SOL;

console.log('');
console.log('program     :', soPath.replace(root + '/', ''));
console.log('ukuran .so  :', bytes.toLocaleString('en-US'), 'byte', `(${(bytes / 1024).toFixed(1)} KB)`);
console.log('');
console.log('deploy final :', sol(final), 'SOL   (rent terkunci; dapat dipulihkan saat program ditutup sesuai aturan loader)');
console.log('puncak deploy:', sol(peak), 'SOL   (butuh saldo ≥ ini saat deploy)');
console.log('per KB       :', perKb.toFixed(4), 'SOL');
console.log('');
console.log('Hemat potensial vs Anchor 150 KB:');
console.log('  150 KB →', sol(rent(150 * 1024 + 45) + programAccount), 'SOL');
console.log('  hemat  :', sol(rent(150 * 1024 + 45) - programData), 'SOL');
console.log('');
