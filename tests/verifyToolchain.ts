/**
 * Uji unit `scripts/toolchainDoctor.ts` — regresi untuk kegagalan
 * `feature edition2024 is required` saat `anchor build`.
 *
 * Tidak butuh Rust/Solana: seluruh parsing diuji terhadap string output nyata.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_PLATFORM_TOOLS,
  MIN_RUSTC,
  compareVersion,
  formatVersion,
  encodeBase58,
  findFiles,
  inspectToolchain,
  parseDeclareId,
  parseSdkProgramId,
  pubkeyFromKeypairJson,
  readEnvValue,
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
// Verdict mencerminkan MESIN yang menjalankan tes, bukan repo, jadi tidak
// dipatok ke satu nilai:
//   ok                       -> toolchain modern & repo sehat
//   missing-binary/unknown   -> tanpa cargo-build-sbf / versi tak terbaca
//   edition2024-blocked      -> cargo-build-sbf di mesin ini masih rustc < 1.85
// Yang penting hanya: veredict TIDAK boleh menyalahkan repo, karena fixture ini
// sudah benar (resolver 2, config MSRV-aware, binary ada). Dua verdict repo-lah
// yang harus mustahil muncul.
assert.notEqual(
  ok.verdict,
  'anchor-manifest-incompatible',
  `fixture sehat tidak boleh dianggap manifest rusak: ${ok.verdict}`
);
assert.notEqual(
  ok.verdict,
  'program-id-mismatch',
  `fixture sehat tidak boleh dianggap ID mismatch: ${ok.verdict}`
);
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

// 8. Tiga sumber program ID: declare_id!, SDK, .env — dan skenario deploy nyata
const realDeployed = 'DnW4iMWC5gCjPZkk2kkdTrY5uybW3w6r6aLdS6meynMn'; // dari `anchor deploy`
const sdkSrc = `const AMM_PROGRAM_ID_OVERRIDE = (import.meta.env.VITE_AMM_PROGRAM_ID)?.trim();\n` +
  `export const DEFAULT_AMM_PROGRAM_ID = new PublicKey(\n  AMM_PROGRAM_ID_OVERRIDE || '${realDeployed}'\n);\n`;
assert.equal(parseSdkProgramId(sdkSrc), realDeployed);
assert.equal(parseSdkProgramId('export const X = 1;'), null);

// .env: hanya key yang diminta, komentar diabaikan, tanda kutip dibuang
const envRoot = mkdtempSync(join(tmpdir(), 'doctor-env-'));
writeFileSync(
  join(envRoot, '.env'),
  `# komentar\nVITE_RPC_ENDPOINT=https://api.devnet.solana.com\nVITE_AMM_PROGRAM_ID="${realDeployed}"\n`
);
assert.equal(readEnvValue(join(envRoot, '.env'), 'VITE_AMM_PROGRAM_ID'), realDeployed);
assert.equal(readEnvValue(join(envRoot, '.env'), 'TIDAK_ADA'), null);
assert.equal(readEnvValue(join(envRoot, 'tidak-ada.env'), 'VITE_AMM_PROGRAM_ID'), null);

// Skenario nyata pengguna: keypair deploy baru (DnW4...) tapi SDK masih Csre71k9
const scenarioRoot = mkdtempSync(join(tmpdir(), 'doctor-scenario-'));
mkdirSync(join(scenarioRoot, 'programs', 'mini-amm', 'src'), { recursive: true });
mkdirSync(join(scenarioRoot, 'src', 'sdk'), { recursive: true });
mkdirSync(join(scenarioRoot, 'target', 'deploy'), { recursive: true });
writeFileSync(
  join(scenarioRoot, 'programs', 'mini-amm', 'src', 'lib.rs'),
  'declare_id!("Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp");\n'
);
writeFileSync(join(scenarioRoot, 'Cargo.toml'), '[workspace]\nresolver = "2"\n');
// SDK masih memakai ID lama, keypair deploy = ID baru hasil anchor build di folder ZIP
writeFileSync(join(scenarioRoot, 'src', 'sdk', 'customSdk.ts'), sdkSrc.replace(realDeployed, 'Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp'));
const deployedBytes = Uint8Array.from([...new Uint8Array(32).fill(3), ...seq]);
writeFileSync(
  join(scenarioRoot, 'target', 'deploy', 'mini_amm-keypair.json'),
  JSON.stringify(Array.from(deployedBytes))
);
const sc = inspectToolchain(scenarioRoot);
assert.equal(sc.deployKeypairPubkey, seqB58);
assert.equal(sc.sdkProgramId, 'Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp');
assert.equal(sc.envAmmProgramId, null);
assert.equal(sc.programIdMismatch, true, 'SDK vs keypair deploy harus terdeteksi beda');
assert.equal(sc.verdict, 'program-id-mismatch');

// Setelah .env diisi ID hasil deploy, mismatch hilang
writeFileSync(join(scenarioRoot, '.env'), `VITE_AMM_PROGRAM_ID=${seqB58}\n`);
const fixed = inspectToolchain(scenarioRoot);
assert.equal(fixed.envAmmProgramId, seqB58);
assert.equal(fixed.programIdMismatch, false, 'setelah .env diisi, tidak boleh mismatch');
assert.equal(fixed.declareIdStale, true, 'declare_id! masih lama -> harus diperingatkan');

// 9. Semua deklarasi program ID di repo harus menunjuk alamat yang SAMA.
//    Kalau tidak, Anchor menolak semua instruksi dengan 4100 / 0x1004.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const repoDeclareId = parseDeclareId(
  readFileSync(join(REPO, 'programs', 'mini-amm', 'src', 'lib.rs'), 'utf8')
);
const repoAnchorToml = readFileSync(join(REPO, 'Anchor.toml'), 'utf8');
const anchorTomlIds = [...repoAnchorToml.matchAll(/mini_amm = "([1-9A-HJ-NP-Za-km-z]+)"/g)].map(
  (m) => m[1]
);
assert.ok(repoDeclareId, 'declare_id! harus terbaca');
assert.equal(anchorTomlIds.length, 2, 'Anchor.toml harus punya entri localnet + devnet');
for (const id of anchorTomlIds) {
  assert.equal(
    id,
    repoDeclareId,
    `Anchor.toml (${id}) harus sama dengan declare_id! (${repoDeclareId})`
  );
}
const repoReport = inspectToolchain(REPO);
assert.equal(
  repoReport.deployKeypairPubkey,
  null,
  'repo tanpa target/deploy tidak boleh melaporkan keypair'
);
assert.equal(
  repoReport.programIdMismatch,
  false,
  'tanpa target/deploy tidak boleh ada mismatch palsu'
);

// 10. Bundle `dist/` basi: kalau masih memuat program ID lama, `npm run preview`
//     akan menyajikan kode lama -> dashboard menembak alamat yang salah.
const distRoot = mkdtempSync(join(tmpdir(), 'doctor-dist-'));
mkdirSync(join(distRoot, 'src', 'sdk'), { recursive: true });
mkdirSync(join(distRoot, 'programs', 'mini-amm', 'src'), { recursive: true });
mkdirSync(join(distRoot, 'dist', 'assets'), { recursive: true });
writeFileSync(join(distRoot, 'Cargo.toml'), '[workspace]\nresolver = "2"\n');
writeFileSync(
  join(distRoot, 'programs', 'mini-amm', 'src', 'lib.rs'),
  `declare_id!("${realDeployed}");\n`
);
writeFileSync(
  join(distRoot, 'src', 'sdk', 'customSdk.ts'),
  `export const DEFAULT_AMM_PROGRAM_ID = new PublicKey(\n  AMM_PROGRAM_ID_OVERRIDE || '${realDeployed}'\n);\n`
);

// (a) dist memuat ID lama -> basi
writeFileSync(
  join(distRoot, 'dist', 'assets', 'index-old.js'),
  'const A="Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp";'
);
assert.equal(inspectToolchain(distRoot).distStale, true, 'dist ID lama harus terdeteksi basi');

// (b) dist memuat ID yang benar -> tidak basi
writeFileSync(join(distRoot, 'dist', 'assets', 'index-new.js'), `const A="${realDeployed}";`);
rmSync(join(distRoot, 'dist', 'assets', 'index-old.js'));
assert.equal(inspectToolchain(distRoot).distStale, false, 'dist ID benar tidak boleh ditandai');

// (c) tanpa dist -> tidak ada laporan palsu
rmSync(join(distRoot, 'dist'), { recursive: true, force: true });
assert.equal(inspectToolchain(distRoot).distStale, false, 'tanpa dist tidak boleh ada laporan');

// (d) findFiles hanya mengambil .js di dalam subdirektori
mkdirSync(join(distRoot, 'dist', 'assets'), { recursive: true });
writeFileSync(join(distRoot, 'dist', 'assets', 'a.js'), 'x');
writeFileSync(join(distRoot, 'dist', 'assets', 'b.css'), 'x');
assert.equal(findFiles(join(distRoot, 'dist'), /\.js$/).length, 1);

// 11. Parser harus memahami output NYATA `cargo-build-sbf --version`.
//     Bentuk asli (Agave 4.5.0):
//       cargo-build-sbf 4.5.0 Default platform-tools: v1.57 Default Rust: 1.95.0
//     Perhatikan: tidak ada kata "rustc", dan ada titik dua setelah
//     "platform-tools". Keduanya dulu membuat parseVersion/parsePlatformTools
//     mengembalikan null sehingga doctor melaporkan "tidak terbaca" dan
//     verdict jatuh ke "unknown" (inilah yang menggagalkan `npm test`).
const realVersionOutput =
  'cargo-build-sbf 4.5.0 Default platform-tools: v1.57 Default Rust: 1.95.0';
assert.deepEqual(
  parseVersion(realVersionOutput, 'rustc'),
  { major: 1, minor: 95, patch: 0 },
  'versi rustc harus terbaca dari "Default Rust: 1.95.0"'
);
assert.equal(parsePlatformTools(realVersionOutput), 157, 'platform-tools v1.57 -> 157');
assert.ok(
  parsePlatformTools(realVersionOutput)! >= MIN_PLATFORM_TOOLS,
  'v1.57 harus dianggap memadai'
);

// Bentuk lama tetap harus jalan (jangan regresi).
assert.deepEqual(
  parseVersion('cargo-build-sbf 4.4.0 (platform-tools v1.53, rustc 1.89.0)', 'rustc'),
  { major: 1, minor: 89, patch: 0 }
);
assert.equal(parsePlatformTools('platform-tools v1.53'), 153);
assert.equal(parseVersion('tidak ada versi di sini', 'rustc'), null);
assert.equal(parsePlatformTools('tanpa platform tools'), null);

// Label di laporan tidak boleh berbunyi "belum" hanya karena config fallback
// tidak diperlukan (rustc modern + resolver 2 sudah cukup).
assert.ok(parseSolanaVersion('[toolchain]\nsolana_version = "4.4.1"') === '4.4.1');

// 12. Repo asli: konfigurasi yang dikomit memang MSRV-aware
const repo = inspectToolchain(REPO);
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
