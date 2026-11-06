/**
 * Preflight check devnet untuk mini-defi-customsdk.
 *
 * Memverifikasi hal-hal yang TIDAK bisa diuji secara lokal/offline:
 *   1. RPC devnet bisa dihubungi + health (slot / block height)
 *   2. Program AMM benar-benar sudah ter-deploy di program ID `declare_id!`
 *   3. Wallet provider punya SOL devnet yang cukup untuk fee + rent
 *   4. (opsional) Airdrop 1 SOL devnet ke wallet tersebut
 *
 * Pemakaian:
 *   npm run devnet:check              # cek saja
 *   npm run devnet:check -- --airdrop # cek + minta 1 SOL (bila saldo < 0.5 SOL)
 *   VITE_RPC_ENDPOINT=https://devnet.helius-rpc.com/?api-key=... npm run devnet:check
 *   ANCHOR_WALLET=~/.config/solana/id.json npm run devnet:check
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import { DEFAULT_AMM_PROGRAM_ID } from '../src/sdk/customSdk';
import {
  encodeBase58,
  parseDeclareId,
  pubkeyFromKeypairJson,
} from './toolchainDoctor';

const UPGRADEABLE_LOADER_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111'
);
const LEGACY_LOADER_ID = new PublicKey(
  'BPFLoader2111111111111111111111111111111111'
);

const MIN_SOL_FOR_PIPELINE = 0.1;
const AIRDROP_TARGET_SOL = 1;

const args = process.argv.slice(2);
const wantAirdrop = args.includes('--airdrop');

const endpoint =
  process.env.VITE_RPC_ENDPOINT?.trim() || 'https://api.devnet.solana.com';
const walletPath = (
  process.env.ANCHOR_WALLET ?? join(homedir(), '.config', 'solana', 'id.json')
).replace(/^~(?=$|\/)/, homedir());

const results: { ok: boolean; label: string; detail: string; fatal?: boolean }[] =
  [];

const pass = (label: string, detail: string): void => {
  results.push({ ok: true, label, detail });
  console.log(`  \u2714 ${label}\n      ${detail}`);
};

const fail = (label: string, detail: string, fatal = false): void => {
  results.push({ ok: false, label, detail, fatal });
  console.log(`  ${fatal ? '\u2716' : '\u26a0'} ${label}\n      ${detail}`);
};

/**
 * Pubkey efektif program untuk akun Program milik upgradeable loader.
 *
 * Akun `Program` berisi: u32 tag(2) + 32 byte address ProgramData.
 * ProgramData berisi: u32 tag(3) + u64 slot + Option<Pubkey> upgrade_authority
 *                      + Pubkey programdata_address ... dan TIDAK menyimpan
 *                      program id-nya sendiri. Karena itu kecocokan ID dibuktikan
 *                      lewat `declare_id!` di source vs program id yang dipanggil,
 *                      bukan lewat data akun.
 */
const describeProgramAccount = (data: Buffer): string => {
  if (data.byteLength < 36) {
    return `data ${data.byteLength} byte`;
  }
  const tag = data.readUInt32LE(0);
  if (tag !== 2) {
    return `tag ${tag} (bukan Program)`;
  }
  const programData = encodeBase58(data.subarray(4, 36));
  return `ProgramData ${programData.slice(0, 8)}\u2026`;
};

const loadWallet = (): Keypair | null => {
  const absolute = resolve(walletPath);
  if (!existsSync(absolute)) {
    return null;
  }
  try {
    const secret = JSON.parse(readFileSync(absolute, 'utf8')) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (err) {
    console.log(
      `  \u26a0 Gagal membaca wallet ${absolute}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
};

async function main(): Promise<void> {
  console.log('\n=== Devnet Preflight: mini-defi-customsdk ===');
  console.log(`RPC      : ${endpoint}`);
  console.log(`Program  : ${DEFAULT_AMM_PROGRAM_ID.toBase58()}`);
  console.log(`Anchor   : anchor 0.31.1 (declare_id! di programs/mini-amm/src/lib.rs)`);
  console.log('');

  // 1. RPC reachable?
  const connection = new Connection(endpoint, 'confirmed');
  try {
    const version = await connection.getVersion();
    const slot = await connection.getSlot('confirmed');
    pass('RPC devnet terhubung', `solana-core ${version['solana-core']} \u00b7 slot ${slot}`);
  } catch (err) {
    fail(
      'RPC devnet TIDAK bisa dihubungi',
      `${err instanceof Error ? err.message : String(err)} \u2014 periksa koneksi atau set VITE_RPC_ENDPOINT`,
      true
    );
    return summarize();
  }

  // 2. Program sudah ter-deploy?
  try {
    const accountInfo = await connection.getAccountInfo(
      DEFAULT_AMM_PROGRAM_ID,
      'confirmed'
    );
    if (!accountInfo) {
      fail(
        'Program AMM BELUM ter-deploy di program ID tersebut',
        [
          'Semua transaksi mode "Devnet RPC" akan gagal (Attempt to load a program that does not exist).',
          'Deploy dulu:',
          '  anchor build',
          '  anchor keys sync        # pastikan declare_id! == Anchor.toml',
          '  anchor deploy --provider.cluster devnet',
        ].join('\n      '),
        true
      );
    } else if (!accountInfo.executable) {
      fail(
        'Akun program ID ada tetapi tidak executable',
        `owner=${accountInfo.owner.toBase58()} \u2014 bukan program BPF`,
        true
      );
    } else {
      const loader =
        accountInfo.owner.equals(UPGRADEABLE_LOADER_ID)
          ? 'upgradeable loader'
          : accountInfo.owner.equals(LEGACY_LOADER_ID)
            ? 'legacy loader'
            : accountInfo.owner.toBase58();
      pass(
        'Program AMM ter-deploy & executable',
        `${loader} \u00b7 data ${accountInfo.data.byteLength} byte \u00b7 ${describeProgramAccount(
          Buffer.from(accountInfo.data)
        )}`
      );

      // Cek kecocokan declare_id! dengan program id yang dipanggil dashboard.
      // Kalau beda, Anchor menolak SEMUA instruksi dengan 4100
      // (DeclaredProgramIdMismatch / custom error 0x1004).
      const libRsPath = resolve('programs/mini-amm/src/lib.rs');
      const declared = existsSync(libRsPath)
        ? parseDeclareId(readFileSync(libRsPath, 'utf8'))
        : null;
      if (declared === null) {
        fail(
          'declare_id! tidak terbaca',
          `${libRsPath} tidak ditemukan atau tidak memuat declare_id!`
        );
      } else if (declared !== DEFAULT_AMM_PROGRAM_ID.toBase58()) {
        fail(
          'declare_id! TIDAK SAMA dengan program yang dipanggil dashboard',
          [
            `declare_id! di source : ${declared}`,
            `program yang dipanggil : ${DEFAULT_AMM_PROGRAM_ID.toBase58()}`,
            'Anchor akan menolak setiap instruksi dengan 4100 / 0x1004 (DeclaredProgramIdMismatch).',
            'Perbaiki: samakan declare_id! dengan alamat deploy, lalu',
            '  anchor build && anchor upgrade --program-id ' +
              `${DEFAULT_AMM_PROGRAM_ID.toBase58()} target/deploy/mini_amm.so`,
          ].join('\n      '),
          true
        );
      } else {
        pass('declare_id! cocok dengan program ID dashboard', declared);
      }

      // Pubkey di keypair deploy lokal (kalau ada) juga harus sama.
      const keypairPath = resolve('target/deploy/mini_amm-keypair.json');
      if (existsSync(keypairPath)) {
        const localPubkey = pubkeyFromKeypairJson(readFileSync(keypairPath, 'utf8'));
        if (localPubkey && localPubkey !== DEFAULT_AMM_PROGRAM_ID.toBase58()) {
          fail(
            'keypair deploy lokal menunjuk program ID lain',
            `${localPubkey} \u2260 ${DEFAULT_AMM_PROGRAM_ID.toBase58()}. ` +
              'Jalankan `anchor keys sync` lalu build ulang sebelum deploy.'
          );
        }
      }
    }
  } catch (err) {
    fail(
      'Gagal memeriksa akun program',
      err instanceof Error ? err.message : String(err),
      true
    );
  }

  // 3. Wallet provider + saldo
  const wallet = loadWallet();
  if (!wallet) {
    fail(
      'File wallet tidak ditemukan',
      `${resolve(walletPath)}\n      Set ANCHOR_WALLET=... atau buat dengan: solana-keygen new -o ${walletPath}`
    );
  } else {
    const pubkey = wallet.publicKey;
    pass('Wallet ditemukan', `${pubkey.toBase58()} (${resolve(walletPath)})`);
    try {
      let lamports = await connection.getBalance(pubkey, 'confirmed');
      let balance = lamports / LAMPORTS_PER_SOL;

      if (balance < MIN_SOL_FOR_PIPELINE && wantAirdrop) {
        console.log(
          `      Saldo ${balance.toFixed(4)} SOL < ${MIN_SOL_FOR_PIPELINE} \u2014 meminta airdrop ${AIRDROP_TARGET_SOL} SOL...`
        );
        try {
          const signature = await connection.requestAirdrop(
            pubkey,
            AIRDROP_TARGET_SOL * LAMPORTS_PER_SOL
          );
          const latest = await connection.getLatestBlockhash('confirmed');
          await connection.confirmTransaction(
            {
              signature,
              blockhash: latest.blockhash,
              lastValidBlockHeight: latest.lastValidBlockHeight,
            },
            'confirmed'
          );
          lamports = await connection.getBalance(pubkey, 'confirmed');
          balance = lamports / LAMPORTS_PER_SOL;
          console.log(`      Airdrop terkirim (${signature}).`);
        } catch (err) {
          console.log(
            `      Airdrop gagal: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (balance >= MIN_SOL_FOR_PIPELINE) {
        pass('Saldo SOL cukup untuk pipeline', `${balance.toFixed(4)} SOL`);
      } else {
        fail(
          'Saldo SOL devnet kurang',
          `${balance.toFixed(4)} SOL (butuh \u2265 ${MIN_SOL_FOR_PIPELINE} SOL). Jalankan "npm run devnet:check -- --airdrop" atau faucet.solana.com`
        );
      }
    } catch (err) {
      fail(
        'Gagal membaca saldo',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // 4. Info build lokal (tidak wajib)
  const soPath = resolve('target/deploy/mini_amm.so');
  if (existsSync(soPath)) {
    pass('Artefak build lokal tersedia', soPath);
  } else {
    console.log(
      `  \u26a0 target/deploy/mini_amm.so belum ada \u2014 jalankan "anchor build" sebelum "anchor deploy".`
    );
  }

  summarize();
}

function summarize(): void {
  const fatal = results.filter((r) => !r.ok && r.fatal);
  const warnings = results.filter((r) => !r.ok && !r.fatal);
  console.log(
    `\n=== Ringkasan: ${results.filter((r) => r.ok).length} OK, ${fatal.length} gagal, ${warnings.length} peringatan ===`
  );
  if (fatal.length > 0) {
    console.log('Status: BELUM siap dipakai untuk transaksi devnet.\n');
    process.exitCode = 1;
  } else if (warnings.length > 0) {
    console.log('Status: siap, tetapi ada peringatan di atas.\n');
  } else {
    console.log(
      'Status: SIAP. Jalankan "npm run dev", pilih mode "Devnet RPC", hubungkan Phantom, lalu launch token.\n'
    );
  }
}

main().catch((err) => {
  console.error('\nPreflight error:', err);
  process.exit(1);
});
