/** Uji keypair dalam direktori sementara, tanpa menyentuh private key pengguna. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';

const dir = mkdtempSync(join(tmpdir(), 'mini-amm-keypair-'));
try {
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'program', 'src'), { recursive: true });
  copyFileSync(new URL('../scripts/program-keypair.mjs', import.meta.url), join(dir, 'scripts', 'program-keypair.mjs'));
  writeFileSync(join(dir, 'program', 'src', 'lib.rs'), 'solana_program::declare_id!("A73BhxKr2bktNx7tgZUubMgXrumng17jYfKm5cTdWbXv");\n');
  writeFileSync(join(dir, '.env.example'), 'VITE_NATIVE_PROGRAM_ID=old\nPINATA_JWT=\n');
  const keyPath = join(dir, 'program', 'target', 'deploy', 'mini_amm_native-keypair.json');
  const run = (...args) => spawnSync(process.execPath, [join(dir, 'scripts', 'program-keypair.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(run('--sync-only').status, 1);
  assert.equal(run('--dry-run').status, 0);
  assert.equal(existsSync(keyPath), false);
  assert.equal(existsSync(join(dir, '.env')), false);
  assert.equal(run().status, 0);
  const saved = readFileSync(keyPath, 'utf8');
  const id = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved))).publicKey.toBase58();
  assert.ok(readFileSync(join(dir, 'program', 'src', 'lib.rs'), 'utf8').includes(`declare_id!("${id}")`));
  assert.ok(readFileSync(join(dir, '.env'), 'utf8').includes(`VITE_NATIVE_PROGRAM_ID=${id}`));
  if (process.platform !== 'win32') assert.equal(statSync(keyPath).mode & 0o077, 0);
  writeFileSync(join(dir, '.env'), 'PINATA_JWT=secret\nVITE_NATIVE_PROGRAM_ID=old\n');
  assert.equal(run('--sync-only').status, 0);
  assert.equal(readFileSync(keyPath, 'utf8'), saved);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), `PINATA_JWT=secret\nVITE_NATIVE_PROGRAM_ID=${id}\n`);
  assert.notEqual(run('--force').status, 0);
  assert.equal(readFileSync(keyPath, 'utf8'), saved);
  const invalid = JSON.parse(saved);
  invalid[0] = 256;
  writeFileSync(keyPath, JSON.stringify(invalid));
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(keyPath, 'utf8'), JSON.stringify(invalid));
  console.log('✓ Keypair: dry-run, pembuatan, sinkronisasi, keamanan, dan penolakan data rusak');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
