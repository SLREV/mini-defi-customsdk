/**
 * Doctor toolchain SBF — kenapa `anchor build` gagal?
 *
 * `anchor build` memanggil `cargo-build-sbf`, dan BINARY ITU membawa Cargo/rustc
 * sendiri (platform-tools), bukan rustc sistem. Kalau rustc bawaannya < 1.85,
 * manifest crate ber-edition 2024 (`zeroize_derive 1.5`, `blake3 1.8.3`,
 * `constant_time_eq 0.4.2`, ...) gagal di-parse SEBELUM kompilasi:
 *
 *   error: failed to parse manifest at `.../zeroize_derive-1.5.0/Cargo.toml`
 *   Caused by: feature `edition2024` is required
 *
 * Skrip ini membaca versi yang benar-benar dipakai build, lalu memberi tahu
 * apakah repo sudah "terlindungi" (resolver=3 + MSRV) atau masih butuh upgrade
 * platform-tools.
 *
 * Pemakaian:
 *   npm run toolchain:check
 *   npm run toolchain:check -- --json
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Edition 2024 stabil sejak rustc 1.85 — di bawah ini manifest gagal di-parse. */
export const MIN_RUSTC = [1, 85, 0] as const;
/** platform-tools pertama yang membawa rustc >= 1.85 (v1.56 = rustc 1.89). */
export const MIN_PLATFORM_TOOLS = 56;

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** Ambil versi pertama yang cocok dari sebuah teks, mis. `rustc 1.84.1` → 1.84.1. */
export function parseVersion(text: string, label: string): Version | null {
  const re = new RegExp(`${label}\\s+v?(\\d+)\\.(\\d+)\\.(\\d+)`, 'i');
  const m = text.match(re);
  if (!m) {
    return null;
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** `platform-tools v1.58` → 58 (dibandingkan sebagai integer). */
export function parsePlatformTools(text: string): number | null {
  const m = text.match(/platform-tools\s+v?(\d+)\.(\d+)/i);
  if (!m) {
    return null;
  }
  return Number(m[1]) * 100 + Number(m[2]);
}

export function compareVersion(a: Version, b: readonly [number, number, number]): number {
  if (a.major !== b[0]) return a.major - b[0];
  if (a.minor !== b[1]) return a.minor - b[1];
  return a.patch - b[2];
}

export function formatVersion(v: Version | null): string {
  return v ? `${v.major}.${v.minor}.${v.patch}` : 'tidak terbaca';
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode byte menjadi base58 (algoritma sama dengan `bs58`):
 * digit dihitung little-endian lalu dibalik; nol di depan menjadi '1'.
 */
export function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '';
  // Nol di depan → karakter '1'. Elemen terakhir tidak dihitung karena
  // digit awal [0] sudah menghasilkan satu '1'.
  for (let k = 0; k < bytes.length - 1 && bytes[k] === 0; k += 1) {
    out += BASE58_ALPHABET[0];
  }
  for (let q = digits.length - 1; q >= 0; q -= 1) {
    out += BASE58_ALPHABET[digits[q]];
  }
  return out;
}

/**
 * Program ID default di `src/sdk/customSdk.ts` — dibaca dari fallback
 * `AMM_PROGRAM_ID_OVERRIDE || '<pubkey>'`.
 */
export function parseSdkProgramId(sdkTs: string): string | null {
  const m = sdkTs.match(/AMM_PROGRAM_ID_OVERRIDE\s*\|\|\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'/);
  return m ? m[1] : null;
}

/** Baca satu nilai dari file `.env` (`KEY=value`, abaikan komentar). */
export function readEnvValue(envPath: string, key: string): string | null {
  if (!existsSync(envPath)) {
    return null;
  }
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || !line.startsWith(`${key}=`)) {
      continue;
    }
    const value = line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
    return value.length > 0 ? value : null;
  }
  return null;
}

/** Baca `declare_id!("...")` dari `programs/mini-amm/src/lib.rs`. */
export function parseDeclareId(libRs: string): string | null {
  const m = libRs.match(/declare_id!\s*\(\s*"(\w+)"\s*\)/);
  return m ? m[1] : null;
}

/** Pubkey dari isi `target/deploy/<program>-keypair.json` (array 64 byte). */
export function pubkeyFromKeypairJson(json: string): string | null {
  try {
    const arr = JSON.parse(json) as number[];
    if (!Array.isArray(arr) || arr.length !== 64) {
      return null;
    }
    // 32 byte terakhir = public key
    return encodeBase58(Uint8Array.from(arr.slice(32)));
  } catch {
    return null;
  }
}

export type ToolchainVerdict =
  | 'ok'
  | 'edition2024-blocked'
  | 'anchor-manifest-incompatible'
  | 'program-id-mismatch'
  | 'missing-binary'
  | 'unknown';

export interface ToolchainReport {
  verdict: ToolchainVerdict;
  cargoBuildSbf: string | null;
  rustc: Version | null;
  platformTools: number | null;
  anchorSolanaVersion: string | null;
  resolver: string | null;
  msrvAwareResolver: boolean;
  /** true bila Cargo.toml memakai resolver yang ditolak Anchor 0.31.1 (`3`). */
  anchorManifestIncompatible: boolean;
  /** Pubkey program di declare_id! (programs/mini-amm/src/lib.rs). */
  declareId: string | null;
  /** Pubkey dari target/deploy/mini_amm-keypair.json (yang benar-benar di-deploy). */
  deployKeypairPubkey: string | null;
  /** Program ID yang dipanggil dashboard/SDK (VITE_AMM_PROGRAM_ID atau isi customSdk.ts). */
  sdkProgramId: string | null;
  /** Nilai VITE_AMM_PROGRAM_ID di .env (null bila tidak ada). */
  envAmmProgramId: string | null;
  /** true bila program yang dipanggil dashboard berbeda dari keypair deploy. */
  programIdMismatch: boolean;
  /** true bila declare_id! tidak sama dengan program ID yang dipanggil dashboard. */
  declareIdStale: boolean;
  binary: string | null;
  hints: string[];
}

/** Jalankan perintah, kembalikan stdout+stderr atau `null` bila tidak ada. */
function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string };
    if (e.code === 'ENOENT') {
      return null;
    }
    // exit code != 0 tapi tetap mengeluarkan versi (umum pada cargo-build-sbf)
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    return out.length > 0 ? out : null;
  }
}

/**
 * Agave release pertama yang membawa platform-tools dengan rustc >= 1.85.
 * Agave 4.0.x → platform-tools v1.53 (rustc 1.89).
 */
export const MIN_SOLANA_VERSION = '4.0.0' as const;

/** Ambil `solana_version` dari `[toolchain]` di Anchor.toml (mis. "4.4.1"). */
export function parseSolanaVersion(anchorToml: string): string | null {
  // Pisahkan per section TOML, lalu hanya baca isi `[toolchain]`.
  const toolchain = anchorToml
    .split(/^\[/m)
    .find((section) => section.startsWith('toolchain]'));
  if (!toolchain) {
    return null;
  }
  const m = toolchain.match(/solana_version\s*=\s*"(\d+)\.(\d+)\.(\d+)"/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** true bila `solana_version` di Anchor.toml sudah membawa rustc >= 1.85. */
export function solanaVersionSupportsEdition2024(version: string | null): boolean {
  if (!version) {
    return false;
  }
  const [major] = version.split('.').map(Number);
  return major >= 4;
}

export function inspectToolchain(root = process.cwd()): ToolchainReport {
  const hints: string[] = [];
  const anchorTomlPath = join(root, 'Anchor.toml');
  const anchorToml = existsSync(anchorTomlPath)
    ? readFileSync(anchorTomlPath, 'utf8')
    : '';
  const anchorSolanaVersion = parseSolanaVersion(anchorToml);

  const rootCargo = join(root, 'Cargo.toml');
  const cargoToml = existsSync(rootCargo) ? readFileSync(rootCargo, 'utf8') : '';
  const resolver = cargoToml.match(/^\s*resolver\s*=\s*"(\d+)"/m)?.[1] ?? null;
  const configPath = join(root, '.cargo', 'config.toml');
  const cargoConfig = existsSync(configPath)
    ? readFileSync(configPath, 'utf8')
    : '';
  // Anchor 0.31.1 mem-parse Cargo.toml lewat cargo_toml 0.19, yang enum
  // Resolver-nya hanya V1/V2. `resolver = "3"` membuat anchor build/deploy mati
  // dengan "unknown variant `3`, expected `1` or `2`" sebelum menyentuh kode.
  const anchorManifestIncompatible = resolver !== null && !['1', '2'].includes(resolver);
  const msrvAwareResolver =
    /incompatible-rust-versions\s*=\s*"fallback"/.test(cargoConfig);

  const raw = run('cargo-build-sbf', ['--version']);
  const rustc = raw ? parseVersion(raw, 'rustc') : null;
  const platformTools = raw ? parsePlatformTools(raw) : null;

  const libRsPath = join(root, 'programs', 'mini-amm', 'src', 'lib.rs');
  const declareId = existsSync(libRsPath)
    ? parseDeclareId(readFileSync(libRsPath, 'utf8'))
    : null;
  // Program ID yang benar-benar dipanggil dashboard & script.
  const sdkPath = join(root, 'src', 'sdk', 'customSdk.ts');
  const sdkProgramId = existsSync(sdkPath)
    ? parseSdkProgramId(readFileSync(sdkPath, 'utf8'))
    : null;
  const envAmmProgramId = readEnvValue(join(root, '.env'), 'VITE_AMM_PROGRAM_ID');
  // .env menang, lalu default SDK, terakhir declare_id! (repo tanpa SDK).
  const effectiveProgramId = envAmmProgramId ?? sdkProgramId ?? declareId;
  const keypairJsonPath = join(root, 'target', 'deploy', 'mini_amm-keypair.json');
  const deployKeypairPubkey = existsSync(keypairJsonPath)
    ? pubkeyFromKeypairJson(readFileSync(keypairJsonPath, 'utf8'))
    : null;
  const programIdMismatch =
    effectiveProgramId !== null &&
    deployKeypairPubkey !== null &&
    effectiveProgramId !== deployKeypairPubkey;
  const declareIdStale =
    declareId !== null &&
    effectiveProgramId !== null &&
    declareId !== effectiveProgramId;

  const deployDir = join(root, 'target', 'deploy');
  const binary = existsSync(join(deployDir, 'mini_amm.so'))
    ? join(deployDir, 'mini_amm.so')
    : null;

  let verdict: ToolchainVerdict;
  if (!raw) {
    verdict = 'missing-binary';
    hints.push(
      'cargo-build-sbf tidak ditemukan di PATH. Install Solana/Agave CLI (lihat README) ' +
        'lalu jalankan `anchor build` sekali agar platform-tools terunduh.'
    );
  } else if (!rustc) {
    verdict = 'unknown';
    hints.push('Versi rustc tidak terbaca dari output `cargo-build-sbf --version`.');
  } else if (compareVersion(rustc, MIN_RUSTC) < 0) {
    verdict = 'edition2024-blocked';
    hints.push(
      `rustc bawaan toolchain SBF = ${formatVersion(rustc)} (< 1.85) → crate edition 2024 ` +
        '(zeroize_derive 1.5, blake3 1.8.3, constant_time_eq 0.4.2) gagal di-parse.'
    );
    hints.push(
      'Perbaikan utama: upgrade Solana CLI ke rilis yang membawa platform-tools >= v1.56, ' +
        'mis. `sh -c "$(curl -sSfL https://release.anza.xyz/v4.4.1/install)"` lalu `anchor clean`.'
    );
    if (!msrvAwareResolver) {
      hints.push(
        'Fallback: aktifkan resolver 3 (`resolver = "3"` di Cargo.toml) + `.cargo/config.toml` ' +
          '`incompatible-rust-versions = "fallback"` — versi lama tiap crate akan dipilih otomatis.'
      );
    } else {
      hints.push(
        'Repo sudah memakai resolver MSRV-aware; kalau masih gagal berarti ada crate yang ' +
          'SEMUA versinya edition 2024 → upgrade toolchain tetap diperlukan.'
      );
    }
  } else {
    verdict = 'ok';
    hints.push(`Toolchain SBF memakai rustc ${formatVersion(rustc)} (edition 2024 didukung).`);
  }

  if (programIdMismatch) {
    verdict = 'program-id-mismatch';
    hints.push(
      'PROGRAM ID TIDAK COCOK: yang dipanggil dashboard/SDK = ' +
        `${effectiveProgramId}` +
        (envAmmProgramId ? ' (dari .env VITE_AMM_PROGRAM_ID)' : ' (dari src/sdk/customSdk.ts)') +
        `, tetapi target/deploy/mini_amm-keypair.json = ${deployKeypairPubkey}.`
    );
    hints.push(
      'anchor deploy memakai keypair itu, jadi program mendarat di alamat yang BUKAN ' +
        'dipanggil dashboard/scripts. Pilih salah satu:'
    );
    hints.push(
      `  (a) ikuti keypair deploy: set VITE_AMM_PROGRAM_ID=${deployKeypairPubkey} di .env, ` +
        'samakan [programs.*] di Anchor.toml + declare_id! (anchor keys sync), lalu rebuild.'
    );
    hints.push(
      '  (b) paksa alamat lama: taruh keypair program yang benar di ' +
        'target/deploy/mini_amm-keypair.json, lalu `anchor clean && anchor build`.'
    );
  }

  if (declareIdStale && !programIdMismatch) {
    hints.push(
      `declare_id! (${declareId}) berbeda dari program ID yang dipanggil dashboard (${effectiveProgramId}). ` +
        'Jalankan `anchor keys sync` lalu `anchor clean && anchor build` agar binary dan SDK sepakat.'
    );
  }

  if (anchorManifestIncompatible) {
    verdict = 'anchor-manifest-incompatible';
    hints.push(
      `Cargo.toml memakai resolver = "${resolver}" yang DITOLAK Anchor 0.31.1 ` +
        '(cargo_toml 0.19 hanya mengenal "1"/"2"): ' +
        '`unknown variant, expected 1 or 2` saat anchor build/deploy.'
    );
    hints.push(
      'Ganti ke resolver = "2"; aktifkan resolver MSRV-aware lewat .cargo/config.toml ' +
        '(`[resolver] incompatible-rust-versions = "fallback"`).'
    );
  }

  if (!solanaVersionSupportsEdition2024(anchorSolanaVersion)) {
    hints.push(
      'Anchor.toml belum mematok `solana_version` >= 4.0.0 di [toolchain]; tanpa itu ' +
        '`anchor build` memakai cargo-build-sbf dari Solana CLI yang terpasang, yang bisa ' +
        'masih membawa Cargo 1.84.'
    );
  }

  hints.push(
    binary
      ? `Binary siap deploy: ${binary}`
      : 'target/deploy/mini_amm.so belum ada — itulah sebabnya `anchor deploy` bilang ' +
          '"Unable to open program file".'
  );

  return {
    verdict,
    cargoBuildSbf: raw,
    rustc,
    platformTools,
    anchorSolanaVersion,
    resolver,
    msrvAwareResolver,
    anchorManifestIncompatible,
    declareId,
    sdkProgramId,
    envAmmProgramId,
    deployKeypairPubkey,
    programIdMismatch,
    declareIdStale,
    binary,
    hints,
  };
}

function main(): void {
  const json = process.argv.slice(2).includes('--json');
  const report = inspectToolchain();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.verdict === 'ok' ? 0 : 1);
  }

  const label: Record<ToolchainVerdict, string> = {
    ok: '\u2714 OK',
    'edition2024-blocked': '\u2716 TERBLOKIR edition2024',
    'anchor-manifest-incompatible': '\u2716 MANIFEST DITOLAK ANCHOR',
    'program-id-mismatch': '\u2716 PROGRAM ID TIDAK COCOK',
    'missing-binary': '\u26a0 cargo-build-sbf tidak ada',
    unknown: '\u26a0 versi tidak terbaca',
  };

  console.log('\n=== Toolchain Doctor (SBF / Anchor) ===');
  console.log(`Status          : ${label[report.verdict]}`);
  console.log(
    `cargo-build-sbf : ${report.cargoBuildSbf?.replace(/\s+/g, ' ').trim() ?? 'tidak ditemukan'}`
  );
  console.log(`rustc SBF       : ${formatVersion(report.rustc)} (minimal 1.85)`);
  console.log(
    `platform-tools  : ${
      report.platformTools !== null
        ? `v${Math.floor(report.platformTools / 100)}.${report.platformTools % 100}`
        : 'tidak terbaca'
    }`
  );
  console.log(
    `solana_version  : ${report.anchorSolanaVersion ?? 'tidak dipatok di Anchor.toml'} (minimal 4.0.0)`
  );
  console.log(
    `Resolver MSRV   : ${report.msrvAwareResolver ? 'aktif' : `belum (resolver=${report.resolver ?? '-'})`}`
  );
  console.log(`declare_id!     : ${report.declareId ?? 'tidak terbaca'}`);
  console.log(
    `SDK / .env      : ${report.envAmmProgramId ?? report.sdkProgramId ?? 'tidak terbaca'}` +
      (report.envAmmProgramId ? ' (dari .env)' : ' (dari customSdk.ts)')
  );
  console.log(
    `deploy keypair  : ${report.deployKeypairPubkey ?? 'belum ada (dibuat saat build pertama)'}`
  );
  console.log('');
  for (const hint of report.hints) {
    console.log(`  - ${hint}`);
  }
  console.log('');
  if (report.verdict !== 'ok') {
    console.log('Detail lengkap: README bagian "Gagal `anchor build`: feature `edition2024`".\n');
  }
  process.exit(report.verdict === 'ok' ? 0 : 1);
}

if (process.argv[1] && /toolchainDoctor/.test(process.argv[1])) {
  main();
}
