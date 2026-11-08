#!/usr/bin/env node
/**
 * Buat keypair program (program ID) + sinkronkan ke kode & env.
 *
 *   npm run program:keypair                # buat kalau belum ada, lalu sinkronkan
 *   npm run program:keypair -- --dry-run   # hanya tampilkan rencana
 *   npm run program:keypair -- --sync-only # keypair sudah ada, sinkronkan saja
 *
 * Kenapa perlu: `cargo build-sbf` hanya menghasilkan `.so`, **tidak** membuat
 * `target/deploy/*-keypair.json`. Keypair deploy biasanya baru muncul kalau Anda
 * menjalankan `solana program deploy` tanpa `--program-id` — dan itu membuat ID
 * baru yang tidak cocok dengan `declare_id!` di `src/lib.rs` serta `.env`,
 * sehingga PDA pool dihitung dengan ID yang salah.
 *
 * File keypair TIDAK boleh di-commit (berisi private key); `program/target` sudah
 * masuk `.gitignore`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const programDir = join(root, 'program');
const libRsPath = join(programDir, 'src', 'lib.rs');
const keypairPath = join(programDir, 'target', 'deploy', 'mini_amm_native-keypair.json');
const envPath = join(root, '.env');
const envExamplePath = join(root, '.env.example');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const syncOnly = args.includes('--sync-only');
if (args.some((arg) => !['--dry-run', '--sync-only'].includes(arg))) {
  console.error('Flag tidak dikenal. Keypair yang ada tidak pernah ditimpa.');
  process.exit(1);
}

const rel = (p) => p.replace(root + '/', '');
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Ed25519 + base58, tanpa dependency (node:crypto saja)
// ---------------------------------------------------------------------------
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** Keypair ed25519 baru dalam format `solana-keygen`: 64 byte = seed(32) + pubkey(32). */
function generateKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // PKCS8 DER ed25519: seed 32 byte terakhir. SPKI DER: pubkey 32 byte terakhir.
  const seed = Uint8Array.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
  const pub = Uint8Array.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { publicKey: pub, secretKey: Uint8Array.from([...seed, ...pub]) };
}

function keypairFromSecretKey(secretKey) {
  if (secretKey.length !== 64) return null;
  try {
    // Verifikasi seed → pubkey cocok, agar file yang rusak tidak lolos diam-diam.
    const seed = secretKey.subarray(0, 32);
    const pkcs8 = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(seed),
    ]);
    const derived = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
    const pub = Uint8Array.from(derived.export({ format: 'der', type: 'spki' }).subarray(-32));
    const stored = secretKey.subarray(32, 64);
    if (pub.some((byte, i) => byte !== stored[i])) return null;
    return { publicKey: pub, secretKey: Uint8Array.from(secretKey) };
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`\n✘ ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Keypair: pakai yang ada, atau buat baru
// ---------------------------------------------------------------------------
let keypair;

if (syncOnly && !existsSync(keypairPath)) {
  fail(
    `--sync-only dipakai tapi ${rel(keypairPath)} belum ada.\n` +
      '  Jalankan tanpa flag untuk membuatnya dulu.'
  );
}

if (existsSync(keypairPath)) {
  let bytes;
  try {
    bytes = JSON.parse(readFileSync(keypairPath, 'utf8'));
  } catch (error) {
    fail(`${rel(keypairPath)} bukan JSON valid: ${error.message}`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 ||
      !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    fail(
      `${rel(keypairPath)} harus berisi array 64 byte (format solana-keygen), ` +
        `ditemukan ${Array.isArray(bytes) ? `${bytes.length} item` : typeof bytes}.`
    );
  }
  keypair = keypairFromSecretKey(Uint8Array.from(bytes));
  if (!keypair) fail(`${rel(keypairPath)} bukan keypair ed25519 yang valid.`);
  log(`✓ Keypair sudah ada: ${rel(keypairPath)}`);
} else {
  keypair = generateKeypair();
  if (!dryRun) {
    mkdirSync(dirname(keypairPath), { recursive: true });
    // Format identik dengan `solana-keygen new -o`: array 64 angka.
    writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)), {
      mode: 0o600,
      flag: 'wx', // jangan timpa keypair yang mungkin sudah dipakai deploy
    });
  }
  log(
    `${dryRun ? '· (dry-run) akan membuat' : '✓ Keypair baru dibuat:'} ${rel(keypairPath)}`
  );
}

const programId = base58Encode(keypair.publicKey);
log(`  program ID : ${programId}`);

// ---------------------------------------------------------------------------
// 2. Sinkronkan `declare_id!`
// ---------------------------------------------------------------------------
if (!existsSync(libRsPath)) {
  fail(`Tidak menemukan ${rel(libRsPath)}.`);
}

const libSource = readFileSync(libRsPath, 'utf8');
const declareIdRe = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/;
const declareMatch = libSource.match(declareIdRe);
if (!declareMatch) {
  fail('Tidak menemukan `declare_id!("...")` di program/src/lib.rs.');
}

const currentId = declareMatch[1];
if (currentId === programId) {
  log(`✓ declare_id! sudah cocok`);
} else {
  log(`  declare_id! : ${currentId} → ${programId}`);
  if (!dryRun) {
    writeFileSync(libRsPath, libSource.replace(declareIdRe, `declare_id!("${programId}")`));
  }
}

// ---------------------------------------------------------------------------
// 3. Sinkronkan `.env`
// ---------------------------------------------------------------------------
if (!existsSync(envPath)) {
  if (existsSync(envExamplePath)) {
    if (!dryRun) writeFileSync(envPath, readFileSync(envExamplePath));
    log(`${dryRun ? '· (dry-run) akan menyalin' : '✓ Dibuat'} .env dari .env.example`);
  } else {
    log('⚠ .env.example tidak ada; lewati sinkronisasi .env');
  }
}

if (existsSync(envPath) || (dryRun && existsSync(envExamplePath))) {
  const envSource = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
    : readFileSync(envExamplePath, 'utf8');
  const envRe = /^VITE_NATIVE_PROGRAM_ID=.*$/m;
  const next = envRe.test(envSource)
    ? envSource.replace(envRe, `VITE_NATIVE_PROGRAM_ID=${programId}`)
    : `${envSource.trimEnd()}\nVITE_NATIVE_PROGRAM_ID=${programId}\n`;
  if (envSource !== next) {
    if (!dryRun) writeFileSync(envPath, next);
    log(`  .env        : VITE_NATIVE_PROGRAM_ID=${programId}`);
  } else {
    log('✓ .env sudah cocok');
  }
}

// ---------------------------------------------------------------------------
// 4. Langkah berikutnya
// ---------------------------------------------------------------------------
log('');
if (dryRun) {
  log('(dry-run: tidak ada file yang diubah)');
  process.exit(0);
}

log('Langkah berikutnya:');
log('  1. cargo-build-sbf  →  cd program && cargo build-sbf');
log('     (ID baru WAJIB di-build ulang supaya biner memakai declare_id! baru)');
log('  2. Ukur & hitung biaya :  npm run program:size');
log('  3. Uji di devnet terlebih dahulu; baru deploy ke mainnet bila siap:');
log('     solana program deploy \\');
log('       program/target/deploy/mini_amm_native.so \\');
log('       --program-id program/target/deploy/mini_amm_native-keypair.json \\');
log('       --url mainnet-beta');
log('');
log('CATATAN: simpan cadangan keypair dengan aman; jangan pernah commit atau membagikannya.');
log('Jika sudah pernah deploy dan keypair hilang, keypair baru menghasilkan program ID berbeda.');
