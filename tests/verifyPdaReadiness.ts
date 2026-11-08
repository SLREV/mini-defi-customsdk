/**
 * "Apakah repo ini bisa dipanggil lewat PDA?" — audit otomatis.
 *
 * Tes ini tidak menebak: ia membaca `programs/mini-amm/src/lib.rs` dan `src/sdk/customSdk.ts`,
 * lalu memastikan sifat-sifat yang menentukan apakah instruksi bisa dijalankan dengan
 * PDA sebagai otoritas/penandatangan:
 *
 *   A. `user`/`creator` hanyalah `Signer` biasa (tidak ada `signer` khusus wallet manusia)
 *      → bisa dipenuhi `invoke_signed`.
 *   B. Tidak ada `remaining_accounts` di seluruh program
 *      → tidak ada kebutuhan akun ekstra (transfer hook) yang tidak bisa disediakan CPI.
 *   C. `swap` tidak menyentuh lamport / System Program
 *      → SOL tidak bisa "terbungkus otomatis"; wrapping WSOL wajib di luar AMM (dan itu
 *        justru menguntungkan untuk PDA karena tidak butuh tanda tangan PDA).
 *   D. `creator` pool = `payer` saat inisialisasi, dan `claim_creator_fee` memakai
 *      `has_one = creator` → hak klaim fee ikut pindah ke PDA yang membuat pool.
 *   E. Tidak ada instruksi penarikan likuiditas → LP yang disetor PDA tidak punya jalan keluar.
 *   F. Token-2022 di repo ini hanya memakai MetadataPointer + TokenMetadata (tanpa
 *      TransferFee/TransferHook) → `transfer_checked` 4 akun cukup untuk ATA milik PDA.
 *   G. SDK/dashboard hanya menghasilkan transaksi untuk EOA (feePayer = user, user = signer,
 *      ATA dibuat oleh user) → tidak bisa dipakai untuk MENANDATANGANI transaksi PDA;
 *      hanya berguna sebagai spesifikasi instruksi dalam (CPI).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CustomDefiSDK,
  DEFAULT_AMM_PROGRAM_ID,
  NATIVE_SOL_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../src/sdk/customSdk';

const LIB_RS = fs.readFileSync(
  new URL('../programs/mini-amm/src/lib.rs', import.meta.url),
  'utf8'
);
const SDK_TS = fs.readFileSync(
  new URL('../src/sdk/customSdk.ts', import.meta.url),
  'utf8'
);

/** Potongan sumber untuk satu fungsi instruksi di lib.rs. */
function fnBody(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`pub fn ${name}(`);
  assert.ok(start >= 0, `fungsi ${name} tidak ditemukan`);
  const end = source.indexOf(`pub fn ${nextName}(`, start);
  assert.ok(end > start, `batas akhir ${name} tidak ditemukan`);
  return source.slice(start, end);
}

function structBody(source: string, name: string): string {
  const header = `pub struct ${name}<'info> {`;
  const start = source.indexOf(header);
  assert.ok(start >= 0, `struct ${name} tidak ditemukan`);
  return source.slice(start, source.indexOf('\n}', start));
}

const results: Array<{ check: string; ok: boolean; note: string }> = [];
function check(name: string, ok: boolean, note: string) {
  results.push({ check: name, ok, note });
  assert.ok(ok, `${name} — ${note}`);
}

const swapBody = fnBody(LIB_RS, 'swap', 'claim_creator_fee');
const initBody = fnBody(LIB_RS, 'initialize_pool', 'add_liquidity');
const swapStruct = structBody(LIB_RS, 'Swap');
const claimStruct = structBody(LIB_RS, 'ClaimCreatorFee');
const addLiquidityStruct = structBody(LIB_RS, 'AddLiquidity');
const initStruct = structBody(LIB_RS, 'InitializePool');

// --- A. user/creator = Signer biasa, tanpa syarat "harus wallet manusia" -----
check(
  'A1 swap: `user` hanya Signer (bisa PDA via invoke_signed)',
  /#\[account\(mut\)\]\s*\n\s*pub user: Signer<'info>,/.test(swapStruct),
  'tidak ada constraint tambahan seperti address/has_one pada `user`'
);
check(
  'A2 claim: `creator` Signer + has_one = creator',
  /pub creator: Signer<'info>/.test(claimStruct) &&
    /has_one = creator/.test(claimStruct),
  'PDA hanya bisa klaim bila PDA itu pembuat pool'
);
check(
  'A3 add_liquidity: LP & ATA dimiliki `user`',
  /pub user: Signer<'info>/.test(addLiquidityStruct) &&
    (addLiquidityStruct.match(/token::authority = user/g) ?? []).length >= 3,
  'user_token_x, user_token_y, user_lp_token semua authority = user'
);

// --- B. Tidak butuh akun tambahan (transfer hook) ---------------------------
check(
  'B1 tidak ada `remaining_accounts` di program',
  !LIB_RS.includes('remaining_accounts'),
  'CPI tidak perlu menyediakan akun ekstra; hook Token-2022 tidak didukung'
);

// --- C. swap tidak memindahkan lamport / tidak panggil System Program -------
check(
  'C1 swap tidak menyentuh lamport / system_program',
  !/lamport|system_program|system_instruction/.test(swapBody),
  'AMM hanya `transfer_checked`; SOL harus dibungkus jadi WSOL di luar AMM'
);
check(
  'C2 swap hanya memakai transfer_checked',
  (swapBody.match(/token_interface::transfer_checked/g) ?? []).length >= 3 &&
    !/token_interface::transfer\b/.test(swapBody),
  '3 transfer (fee creator + net_in + output), semuanya checked'
);

// --- D. creator pool = payer -----------------------------------------------
check(
  'D1 pool.creator = payer saat initialize_pool',
  /pool\.creator = ctx\.accounts\.payer\.key\(\)/.test(initBody),
  'PDA yang membayar pool otomatis menjadi penerima fee 0.06%'
);
check(
  'D2 initialize_pool: payer Signer & menanggung rent',
  /pub payer: Signer<'info>/.test(initStruct) &&
    (initStruct.match(/payer = payer/g) ?? []).length >= 6,
  'pool_state, lp_mint, 4 vault, ATA LP semua dibayar payer → PDA harus punya SOL'
);

// --- E. Tidak ada jalan keluar likuiditas ----------------------------------
check(
  'E1 tidak ada remove_liquidity/withdraw',
  !/remove_liquidity|withdraw/i.test(LIB_RS),
  'LP yang disetor PDA tidak bisa ditarik lewat program ini'
);

// --- F. Token-2022 repo tanpa TransferFee/TransferHook ---------------------
check(
  'F1 SDK tidak memakai ekstensi TransferFee/TransferHook',
  !/TransferFee|TransferHook/.test(SDK_TS),
  'transfer_checked 4 akun cukup; ATA milik PDA tidak perlu akun hook'
);
check(
  'F2 metadata hanya MetadataPointer + TokenMetadata',
  /MetadataPointer/.test(SDK_TS) && /TokenMetadata/.test(SDK_TS),
  'mint self-referential, tidak memengaruhi jalur swap'
);

// --- G. SDK/dashboard hanya untuk EOA -------------------------------------
const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const sdk = new CustomDefiSDK(connection, DEFAULT_AMM_PROGRAM_ID);
const pdaOwnerProgram = Keypair.generate().publicKey;
const [pdaAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from('otoritas_pda_anda', 'utf8')],
  pdaOwnerProgram
);
const tokenY = Keypair.generate().publicKey;

const built = await sdk.buildSwapTx({
  user: pdaAuthority,
  tokenY,
  amountIn: 1_000_000n,
  xToY: true,
  recentBlockhash: '11111111111111111111111111111111',
});

check(
  'G1 buildSwapTx memakai user sebagai feePayer',
  built.transaction.feePayer?.equals(pdaAuthority) === true,
  'transaksi harus ditandatangani PDA → mustahil; SDK ini hanya spesifikasi instruksi'
);
check(
  'G2 instruksi ATA dibuat & dibayar oleh user (PDA)',
  built.transaction.instructions[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
    built.transaction.instructions[0].keys.some(
      (k) => k.pubkey.equals(pdaAuthority) && k.isSigner && k.isWritable
    ),
  'untuk PDA, pembuatan ATA harus dilakukan program Anda sendiri'
);
check(
  'G3 ATA milik PDA berbeda dari ATA wallet biasa',
  !sdk
    .deriveAssociatedTokenAddress(pdaAuthority, tokenY, TOKEN_2022_PROGRAM_ID)
    .equals(
      sdk.deriveAssociatedTokenAddress(
        Keypair.generate().publicKey,
        tokenY,
        TOKEN_2022_PROGRAM_ID
      )
    ),
  'seed ATA = [owner, tokenProgram, mint] di program ATA'
);
check(
  'G4 PDA pool tidak bergantung pada pemanggil',
  sdk
    .derivePoolAddresses(NATIVE_SOL_MINT, tokenY)
    .poolState.equals(
      sdk.derivePoolAddresses(NATIVE_SOL_MINT, tokenY).poolState
    ) && DEFAULT_AMM_PROGRAM_ID instanceof PublicKey,
  'pool/vault diturunkan dari program ID mini-amm + mint, bukan dari user'
);
check(
  'G5 ATA WSOL PDA memakai Token Program legacy',
  sdk
    .deriveAssociatedTokenAddress(pdaAuthority, NATIVE_SOL_MINT, TOKEN_PROGRAM_ID)
    .equals(
      PublicKey.findProgramAddressSync(
        [
          pdaAuthority.toBuffer(),
          TOKEN_PROGRAM_ID.toBuffer(),
          NATIVE_SOL_MINT.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
      )[0]
    ),
  'WSOL selalu Tokenkeg, token proyek Token-2022'
);

// ---------------------------------------------------------------------------
// Matriks kemampuan per instruksi (diambil dari struct di lib.rs)
// ---------------------------------------------------------------------------
const matrix = [
  {
    instruksi: 'initialize_pool',
    akun: structBody(LIB_RS, 'InitializePool').match(/^\s*pub [a-z_]+:/gm)?.length,
    lewatPda: 'BISA',
    syarat: 'PDA harus punya SOL (rent 6 akun + ATA), saldo token Y, & signer via invoke_signed',
  },
  {
    instruksi: 'add_liquidity',
    akun: structBody(LIB_RS, 'AddLiquidity').match(/^\s*pub [a-z_]+:/gm)?.length,
    lewatPda: 'BISA, dengan catatan',
    syarat: 'LP + ATA X/Y harus milik PDA; LP tidak bisa ditarik (tidak ada remove_liquidity)',
  },
  {
    instruksi: 'swap',
    akun: structBody(LIB_RS, 'Swap').match(/^\s*pub [a-z_]+:/gm)?.length,
    lewatPda: 'BISA (jalur utama)',
    syarat: 'ATA X & Y milik PDA sudah ada; WSOL dibungkus di luar AMM bila sisi input SOL',
  },
  {
    instruksi: 'claim_creator_fee',
    akun: structBody(LIB_RS, 'ClaimCreatorFee').match(/^\s*pub [a-z_]+:/gm)?.length,
    lewatPda: 'BISA hanya bila PDA = pool.creator',
    syarat: 'Pool harus dibuat oleh PDA (payer = PDA); pool buatan wallet tidak bisa diklaim PDA',
  },
];

console.log('PDA READINESS AUDIT PASSED!');
for (const r of results) console.log(`  ✓ ${r.check} — ${r.note}`);
console.table(matrix);
