/**
 * Uji unit `scripts/toolchainDoctor.ts` — regresi untuk kegagalan
 * `feature edition2024 is required` saat `anchor build`.
 *
 * Tidak butuh Rust/Solana: seluruh parsing diuji terhadap string output nyata.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_PLATFORM_TOOLS,
  MIN_RUSTC,
  compareVersion,
  formatVersion,
  encodeBase58,
  inspectToolchain,
  parseDeclareId,
  pubkeyFromKeypairJson,
  MIN_SOLANA_VERSION,
  parsePlatformTools,
  parseSolanaVersion,
  parseVersion,
  solanaVersionSupportsEdition2024,
} from '../scripts/toolchainDoctor';

// 1. Parsing identitas versi dari output asli `cargo-build-sbf --version`
const modern = `solana-cargo-build-sbf 4.4.1
platform-tools v1.58
rustc 1.89.0`;
assert.deepEqual(parseVersion(modern, 'rustc'), { major: 1, minor: 89, patch: 0 });
assert.equal(parsePlatformTools(modern), 158);

const legacy = `solana-cargo-build-sbf 2.2.20
platform-tools v1.48
rustc 1.84.1`;
assert.deepEqual(parseVersion(legacy, 'rustc'), { major: 1, minor: 84, patch: 1 });
assert.equal(parsePlatformTools(legacy), 148);
assert.equal(parseVersion('tanpa versi', 'rustc'), null);
assert.equal(parsePlatformTools('tanpa toolchain'), null);

// 2. Ambang batas: 1.84.x terblokir, 1.85.0 lolos
assert.ok(compareVersion({ major: 1, minor: 84, patch: 1 }, MIN_RUSTC) < 0);
assert.ok(compareVersion({ major: 1, minor: 85, patch: 0 }, MIN_RUSTC) === 0);
assert.ok(compareVersion({ major: 1, minor: 89, patch: 0 }, MIN_RUSTC) > 0);
assert.ok(compareVersion({ major: 2, minor: 0, patch: 0 }, MIN_RUSTC) > 0);
assert.equal(formatVersion({ major: 1, minor: 84, patch: 1 }), '1.84.1');
assert.equal(formatVersion(null), 'tidak terbaca');
assert.equal(MIN_PLATFORM_TOOLS, 56);

// 3. `solana_version` dibaca dari [toolchain] Anchor.toml (bukan dari section lain)
assert.equal(
  parseSolanaVersion('[toolchain]\nanchor_version = "0.31.1"\nsolana_version = "4.4.1"\n'),
  '4.4.1'
);
assert.equal(parseSolanaVersion('[toolchain]\nanchor_version = "0.31.1"'), null);
assert.equal(
  parseSolanaVersion('[programs.devnet]\nmine = "x"\nsolana_version = "3.1.8"'),
  null,
  'tidak boleh membaca solana_version di luar [toolchain]'
);
assert.equal(MIN_SOLANA_VERSION, '4.0.0');
// Agave 3.x masih membawa Cargo 1.84 → terblokir; 4.x membawa rustc 1.89 → lolos.
assert.equal(solanaVersionSupportsEdition2024('3.1.8'), false);
assert.equal(solanaVersionSupportsEdition2024('4.0.0'), true);
assert.equal(solanaVersionSupportsEdition2024('4.4.1'), true);
assert.equal(solanaVersionSupportsEdition2024(null), false);

// 4. Laporan untuk toolchain modern: OK + binary siap
const okRoot = mkdtempSync(join(tmpdir(), 'doctor-ok-'));
writeFileSync(join(okRoot, 'Anchor.toml'), '[toolchain]\nsolana_version = "4.4.1"\n');
writeFileSync(join(okRoot, 'Cargo.toml'), '[workspace]\nresolver = "2"\n');
mkdirSync(join(okRoot, '.cargo'), { recursive: true });
writeFileSync(join(okRoot, '.cargo', 'config.toml'), '[resolver]\nincompatible-rust-versions = "fallback"\n');
mkdirSync(join(okRoot, 'target', 'deploy'), { recursive: true });
writeFileSync(join(okRoot, 'target', 'deploy', 'mini_amm.so'), 'x');

const ok = inspectToolchain(okRoot);
assert.equal(ok.resolver, '2');
assert.equal(ok.anchorManifestIncompatible, false);
assert.equal(ok.msrvAwareResolver, true);
assert.equal(ok.anchorSolanaVersion, '4.4.1');
// Tanpa cargo-build-sbf di PATH, verdict-nya "missing-binary" tetapi hint binary tetap benar.
assert.ok(['ok', 'missing-binary'].includes(ok.verdict));
assert.ok(ok.hints.some((h) => h.includes('Binary siap deploy')));

// 5. Laporan untuk repo tanpa perlindungan MSRV: hint resolver 3 muncul
const bareRoot = mkdtempSync(join(tmpdir(), 'doctor-bare-'));
writeFileSync(join(bareRoot, 'Cargo.toml'), '[workspace]\nresolver = "1"\n');

const bare = inspectToolchain(bareRoot);
assert.equal(bare.resolver, '1');
assert.equal(bare.msrvAwareResolver, false);
assert.ok(
  bare.hints.some((h) => h.includes('mini_amm.so belum ada')),
  'harus menyebut binary yang hilang'
);

// 6. resolver = "3" (ditolak Anchor 0.31.1 / cargo_toml 0.19) harus terdeteksi
const badRoot = mkdtempSync(join(tmpdir(), 'doctor-resolver3-'));
writeFileSync(join(badRoot, 'Cargo.toml'), '[workspace]\nresolver = "3"\n');
writeFileSync(join(badRoot, 'Anchor.toml'), '[toolchain]\nsolana_version = "4.4.1"\n');
const bad = inspectToolchain(badRoot);
assert.equal(bad.resolver, '3');
assert.equal(bad.anchorManifestIncompatible, true);
assert.ok(
  bad.hints.some((h) => h.includes('DITOLAK Anchor 0.31.1')),
  'harus menyebut resolver 3 ditolak Anchor'
);
// Hanya "1"/"2" yang dikenali cargo_toml 0.19 (enum Resolver = V1 | V2).
assert.ok(!['1', '2'].includes('3'), 'resolver 3 harus dianggap tidak kompatibel');

// 7. Program ID: declare_id! vs keypair di target/deploy
assert.equal(
  parseDeclareId('declare_id!("Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp");'),
  'Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp'
);
assert.equal(parseDeclareId('pub fn x() {}'), null);

// Base58: 32 byte nol = System Program (32 karakter '1')
assert.equal(encodeBase58(new Uint8Array(32)), '1'.repeat(32));
// Vektor uji resmi crate `bs58` (dipakai @solana/web3.js)
assert.equal(encodeBase58(Uint8Array.from([0])), '1');
assert.equal(encodeBase58(Uint8Array.from([0, 0])), '11');
// Vektor di bawah diverifikasi langsung terhadap `bs58` (dependency web3.js)
assert.equal(encodeBase58(Uint8Array.from([57, 2, 0])), 'L9bu');
assert.equal(encodeBase58(Uint8Array.from([255])), '5Q');
assert.equal(encodeBase58(Uint8Array.from([1, 2, 3])), 'Ldp');

// Isi keypair Solana = 64 byte: seed(32) + publicKey(32). Hanya 32 byte
// terakhir yang dipakai untuk menghitung pubkey.
const seq = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const seqB58 = encodeBase58(seq);
const keypairBytes = Uint8Array.from([...new Uint8Array(32).fill(9), ...seq]);
assert.equal(pubkeyFromKeypairJson(JSON.stringify(Array.from(keypairBytes))), seqB58);
assert.equal(
  pubkeyFromKeypairJson(JSON.stringify(Array.from(new Uint8Array(64)))),
  '1'.repeat(32),
  'keypair nol = System Program'
);
assert.equal(pubkeyFromKeypairJson('[]'), null);
assert.equal(pubkeyFromKeypairJson('bukan json'), null);
assert.equal(pubkeyFromKeypairJson(JSON.stringify([1, 2, 3])), null, 'harus 64 byte');

// Mismatch: keypair berbeda dari declare_id! harus terdeteksi
const mismatchRoot = mkdtempSync(join(tmpdir(), 'doctor-mismatch-'));
mkdirSync(join(mismatchRoot, 'programs', 'mini-amm', 'src'), { recursive: true });
writeFileSync(
  join(mismatchRoot, 'programs', 'mini-amm', 'src', 'lib.rs'),
  'declare_id!("Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp");\n'
);
writeFileSync(join(mismatchRoot, 'Cargo.toml'), '[workspace]\nresolver = "2"\n');
mkdirSync(join(mismatchRoot, 'target', 'deploy'), { recursive: true });
// keypair dengan public key 1..32 -> beda dari declare_id!
writeFileSync(
  join(mismatchRoot, 'target', 'deploy', 'mini_amm-keypair.json'),
  JSON.stringify(Array.from(keypairBytes))
);
const mm = inspectToolchain(mismatchRoot);
assert.equal(mm.declareId, 'Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp');
assert.equal(mm.deployKeypairPubkey, seqB58);
assert.equal(mm.programIdMismatch, true);
assert.equal(mm.verdict, 'program-id-mismatch');
assert.ok(mm.hints.some((h) => h.includes('PROGRAM ID TIDAK COCOK')));

// 8. Repo asli: konfigurasi yang dikomit memang MSRV-aware
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const repo = inspectToolchain(repoRoot);
assert.equal(repo.resolver, '2', 'Cargo.toml root wajib resolver = "2" (Anchor 0.31.1 menolak "3")');
assert.equal(
  repo.anchorManifestIncompatible,
  false,
  'manifest tidak boleh memakai resolver yang ditolak Anchor 0.31.1'
);
assert.equal(repo.msrvAwareResolver, true, 'harus ada resolver 3 atau cargo config');
assert.equal(repo.anchorSolanaVersion, '4.4.1', 'Anchor.toml wajib mematok solana_version 4.4.1');
assert.equal(
  solanaVersionSupportsEdition2024(repo.anchorSolanaVersion),
  true,
  'solana_version yang dipatok harus membawa rustc >= 1.85'
);

console.log('ALL TOOLCHAIN DOCTOR TESTS PASSED!');
console.log({
  modernRustc: formatVersion(ok.rustc),
  anchorSolanaVersion: repo.anchorSolanaVersion,
  repoResolver: repo.resolver,
});
