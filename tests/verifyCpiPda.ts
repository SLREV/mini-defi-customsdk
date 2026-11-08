/**
 * Verifikasi "envelope" CPI untuk program perantara (interposer).
 *
 * Skenario yang diuji (lihat `docs/PDA-INTERPOSING-GUIDE.md`):
 *   Program Anda (program_id = P) memiliki PDA `otoritas_pda_anda`.
 *   PDA itu dipakai sebagai `user` + penandatangan ketika P memanggil
 *   `swap` milik mini-amm (`DnW4iMWC5gCjPZkk2kkdTrY5uybW3w6r6aLdS6meynMn`).
 *
 * Tes ini TIDAK mengirim transaksi dan tidak butuh validator. Yang diperiksa:
 *   1. Urutan & flag akun `swap` di SDK === urutan field `Swap<'info>` di lib.rs
 *      (dibaca langsung dari sumber Rust, jadi tes ikut gagal bila struct berubah).
 *   2. Payload 18 byte: `[u8(2), u64_le(amount_in), u64_le(min_amount_out), u8(x_to_y)]`.
 *   3. PDA hanya bisa jadi signer lewat CPI — di level transaksi ia wajib tanda
 *      tangan yang tidak mungkin dipenuhi (bukti mengapa `invoke_signed` dipakai).
 *   4. PDA pool diturunkan dari program ID mini-amm, bukan dari program perantara.
 *   5. Envelope `claim_creator_fee` (creator = PDA) juga 10 byte & 10 akun.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import {
  AMM_IX_DISCRIMINATOR,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CLAIM_CREATOR_FEE_IX_LAYOUT,
  CustomDefiSDK,
  DEFAULT_AMM_PROGRAM_ID,
  NATIVE_SOL_MINT,
  POOL_STATE_SIZE,
  SWAP_IX_LAYOUT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../src/sdk/customSdk';

const LIB_RS = fs.readFileSync(
  new URL('../programs/mini-amm/src/lib.rs', import.meta.url),
  'utf8'
);

/** Ambil nama field `pub struct <name><'info> { ... }` sesuai urutan deklarasi. */
function structFields(source: string, name: string): string[] {
  const header = `pub struct ${name}<'info> {`;
  const start = source.indexOf(header);
  assert.ok(start >= 0, `struct ${name}<'info> tidak ditemukan di lib.rs`);
  const bodyStart = start + header.length;
  const bodyEnd = source.indexOf('\n}', bodyStart);
  assert.ok(bodyEnd > bodyStart, `akhir struct ${name} tidak ditemukan`);
  const body = source.slice(bodyStart, bodyEnd);
  return body
    .split('\n')
    .map((line) => line.match(/^\s*pub\s+([a-z0-9_]+)\s*:/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1]);
}

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

async function main() {
  // ---------------------------------------------------------------------------
  // 0. "Program perantara" + PDA-nya (tidak ada hubungannya dengan mini-amm)
  // ---------------------------------------------------------------------------
  const interposerProgramId = Keypair.generate().publicKey;
  const [pdaAuthority, pdaBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('otoritas_pda_anda', 'utf8')],
    interposerProgramId
  );

  // Bump yang disimpan on-chain harus mereproduksi alamat yang sama.
  // `createProgramAddressSync` = `create_program_address` di Rust, yaitu yang
  // dipakai Anchor saat memeriksa seeds `[b"otoritas_pda_anda", &[bump]]`.
  const pdaRecheck = PublicKey.createProgramAddressSync(
    [Buffer.from('otoritas_pda_anda', 'utf8'), Buffer.from([pdaBump])],
    interposerProgramId
  );
  assert.ok(
    pdaRecheck.equals(pdaAuthority),
    'seeds [seed, bump] harus menghasilkan PDA yang sama'
  );

  // ---------------------------------------------------------------------------
  // 1. Urutan field struct on-chain = sumber kebenaran jumlah & urutan akun
  // ---------------------------------------------------------------------------
  const swapFields = structFields(LIB_RS, 'Swap');
  assert.deepEqual(
    swapFields,
    [
      'user',
      'token_x',
      'token_y',
      'pool_state',
      'vault_x',
      'vault_y',
      'fee_vault_x',
      'fee_vault_y',
      'user_token_x',
      'user_token_y',
      'token_program_x',
      'token_program_y',
    ],
    'Swap<\'info> berubah: perbarui docs/PDA-INTERPOSING-GUIDE.md + kode CPI'
  );
  assert.equal(swapFields.length, 12, 'swap harus butuh tepat 12 akun');

  const claimFields = structFields(LIB_RS, 'ClaimCreatorFee');
  assert.deepEqual(claimFields, [
    'creator',
    'pool_state',
    'token_x',
    'token_y',
    'fee_vault_x',
    'fee_vault_y',
    'creator_token_x',
    'creator_token_y',
    'token_program_x',
    'token_program_y',
  ]);
  assert.equal(claimFields.length, 10);

  const addLiquidityFields = structFields(LIB_RS, 'AddLiquidity');
  assert.equal(addLiquidityFields.length, 13);
  assert.equal(addLiquidityFields[0], 'user');

  // ---------------------------------------------------------------------------
  // 2. Envelope `swap` dengan PDA sebagai `user`
  // ---------------------------------------------------------------------------
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const sdk = new CustomDefiSDK(connection, DEFAULT_AMM_PROGRAM_ID);

  const tokenX = NATIVE_SOL_MINT;
  const tokenY = Keypair.generate().publicKey;
  const tokenProgramX = TOKEN_PROGRAM_ID;
  const tokenProgramY = TOKEN_2022_PROGRAM_ID;
  const amountIn = 250_000_000n; // 0.25 SOL
  const minAmountOut = 12_345n;

  const built = await sdk.buildSwapTx({
    user: pdaAuthority,
    tokenX,
    tokenY,
    amountIn,
    minAmountOut,
    xToY: true,
    tokenProgramX,
    tokenProgramY,
    recentBlockhash: '11111111111111111111111111111111',
  });

  const addresses = built.addresses;
  const expectedByField: Record<string, PublicKey> = {
    user: pdaAuthority,
    token_x: tokenX,
    token_y: tokenY,
    pool_state: addresses.poolState,
    vault_x: addresses.vaultX,
    vault_y: addresses.vaultY,
    fee_vault_x: addresses.feeVaultX,
    fee_vault_y: addresses.feeVaultY,
    user_token_x: sdk.deriveAssociatedTokenAddress(
      pdaAuthority,
      tokenX,
      tokenProgramX
    ),
    user_token_y: sdk.deriveAssociatedTokenAddress(
      pdaAuthority,
      tokenY,
      tokenProgramY
    ),
    token_program_x: tokenProgramX,
    token_program_y: tokenProgramY,
  };

  assert.equal(
    built.instruction.keys.length,
    swapFields.length,
    'jumlah AccountMeta harus sama dengan jumlah field struct Swap'
  );
  assert.equal(built.instruction.programId.toBase58(), DEFAULT_AMM_PROGRAM_ID.toBase58());

  // Flag yang harus dipakai CPI (dicocokkan ke urutan field Rust).
  const expectedFlags: Record<string, { signer: boolean; writable: boolean }> = {
    user: { signer: true, writable: true },
    token_x: { signer: false, writable: false },
    token_y: { signer: false, writable: false },
    pool_state: { signer: false, writable: false },
    vault_x: { signer: false, writable: true },
    vault_y: { signer: false, writable: true },
    fee_vault_x: { signer: false, writable: true },
    fee_vault_y: { signer: false, writable: true },
    user_token_x: { signer: false, writable: true },
    user_token_y: { signer: false, writable: true },
    token_program_x: { signer: false, writable: false },
    token_program_y: { signer: false, writable: false },
  };

  swapFields.forEach((field, index) => {
    const meta = built.instruction.keys[index];
    assert.ok(
      meta.pubkey.equals(expectedByField[field]),
      `akun #${index} (${field}) salah: ${meta.pubkey.toBase58()}`
    );
    assert.equal(meta.isSigner, expectedFlags[field].signer, `isSigner ${field}`);
    assert.equal(
      meta.isWritable,
      expectedFlags[field].writable,
      `isWritable ${field}`
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Payload 18 byte, little-endian, `x_to_y` 1 byte (Borsh bool)
  // ---------------------------------------------------------------------------
  const data = built.serializedIxData;
  assert.equal(data.length, 18, 'payload swap harus 18 byte');
  assert.equal(data[0], AMM_IX_DISCRIMINATOR.SWAP);
  assert.equal(data[0], 2);
  assert.deepEqual(
    data,
    Buffer.concat([Buffer.from([2]), u64le(amountIn), u64le(minAmountOut), Buffer.from([1])]),
    'layout swap harus [u8(2), u64_le(amount_in), u64_le(min_amount_out), u8(x_to_y)]'
  );

  const decoded = SWAP_IX_LAYOUT.decode(data);
  assert.equal(decoded.discriminator, 2);
  assert.equal(decoded.amountIn, amountIn);
  assert.equal(decoded.minAmountOut, minAmountOut);
  assert.equal(decoded.xToY, 1);

  // Borsh `bool` = 1 byte; nilai selain 0/1 gagal dideserialisasi program.
  const sell = await sdk.buildSwapTx({
    user: pdaAuthority,
    tokenX,
    tokenY,
    amountIn: 1n,
    xToY: false,
    unwrapWsol: false,
    tokenProgramX,
    tokenProgramY,
    recentBlockhash: '11111111111111111111111111111111',
  });
  assert.equal(sell.serializedIxData[17], 0, 'x_to_y=false harus byte 0');
  assert.equal(sell.serializedIxData[0], 2);

  // ---------------------------------------------------------------------------
  // 4. Bukti mengapa CPI wajib: PDA ditandai signer di transaksi, tapi kunci
  //    privatnya tidak ada — `sign()` mustahil. Hanya `invoke_signed` yang bisa.
  // ---------------------------------------------------------------------------
  const message = built.transaction.compileMessage();
  const pdaIndex = message.accountKeys.findIndex((k) => k.equals(pdaAuthority));
  assert.ok(pdaIndex >= 0, 'PDA harus ada di accountKeys transaksi');
  assert.equal(
    message.isAccountSigner(pdaIndex),
    true,
    'PDA ditandai signer sehingga transaksi top-level menuntut tanda tangannya'
  );
  assert.equal(
    new Set(message.accountKeys.map((k) => k.toBase58())).size,
    message.accountKeys.length,
    'AccountMeta ganda harus digabung runtime (composite account)'
  );
  assert.ok(
    built.transaction.instructions.length >= 1,
    'SDK juga menyiapkan ATA idempotent untuk PDA sebelum swap'
  );
  const ataCreateIx = built.transaction.instructions[0];
  assert.equal(
    ataCreateIx.programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
  );
  // ATA dibuat untuk PDA => payer pun harus PDA (tidak ada signer lain).
  assert.ok(
    ataCreateIx.keys.some(
      (k) => k.pubkey.equals(pdaAuthority) && k.isSigner && k.isWritable
    ),
    'CreateIdempotent ATA milik PDA: PDA jadi payer + owner, wajib signer'
  );

  // ---------------------------------------------------------------------------
  // 5. PDA pool diturunkan dari program ID mini-amm, bukan program perantara
  // ---------------------------------------------------------------------------
  const [manualPool] = PublicKey.findProgramAddressSync(
    [Buffer.from('amm_pool', 'utf8'), tokenX.toBuffer(), tokenY.toBuffer()],
    DEFAULT_AMM_PROGRAM_ID
  );
  assert.ok(manualPool.equals(addresses.poolState));
  const [wrongPool] = PublicKey.findProgramAddressSync(
    [Buffer.from('amm_pool', 'utf8'), tokenX.toBuffer(), tokenY.toBuffer()],
    interposerProgramId
  );
  assert.ok(
    !wrongPool.equals(addresses.poolState),
    'menurunkan pool PDA dengan program ID perantara menghasilkan alamat salah'
  );
  assert.equal(addresses.poolState.toBase58(), manualPool.toBase58());
  assert.ok(POOL_STATE_SIZE === 281);

  // ---------------------------------------------------------------------------
  // 6. Envelope `claim_creator_fee` (creator = PDA) — 10 akun, 10 byte
  // ---------------------------------------------------------------------------
  const claim = await sdk.buildClaimCreatorFeeTx({
    creator: pdaAuthority,
    tokenX,
    tokenY,
    side: 'X',
    minAmount: 0n,
    createMissingAtas: false,
    tokenProgramX,
    tokenProgramY,
    recentBlockhash: '11111111111111111111111111111111',
  });

  assert.equal(claim.instruction.keys.length, 10);
  assert.equal(claim.instruction.data.length, CLAIM_CREATOR_FEE_IX_LAYOUT.span);
  assert.equal(claim.instruction.data.length, 10);
  assert.equal(claim.instruction.data[0], AMM_IX_DISCRIMINATOR.CLAIM_CREATOR_FEE);
  assert.equal(claim.instruction.data[1], 1, 'side X = byte 1');
  const claimDecoded = CLAIM_CREATOR_FEE_IX_LAYOUT.decode(claim.instruction.data);
  assert.equal(claimDecoded.discriminator, 3);
  assert.equal(claimDecoded.side, 1);
  assert.equal(claimDecoded.minAmount, 0n);

  assert.ok(
    claim.instruction.keys[0].pubkey.equals(pdaAuthority) &&
      claim.instruction.keys[0].isSigner,
    'akun #0 claim harus creator (PDA) & signer'
  );
  // Pool milik wallet biasa => PDA tidak bisa mengklaim (has_one = creator).
  assert.ok(
    claimFields[0] === 'creator',
    'urutan field ClaimCreatorFee diawali creator'
  );

  // System program tidak ikut di envelope swap/claim; ia hanya perlu ada bila
  // program perantara sendiri yang membungkus SOL (transfer + SyncNative).
  assert.ok(
    !built.instruction.keys.some((k) =>
      k.pubkey.equals(SystemProgram.programId)
    ),
    'swap mini-amm tidak membutuhkan System Program'
  );

  console.log('ALL PDA / CPI ENVELOPE TESTS PASSED!');
  console.log({
    interposerProgramId: interposerProgramId.toBase58(),
    pdaAuthority: pdaAuthority.toBase58(),
    pdaBump,
    swapAccounts: swapFields.length,
    swapPayloadBytes: data.length,
    claimAccounts: claimFields.length,
    claimPayloadBytes: claim.instruction.data.length,
    poolState: addresses.poolState.toBase58(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
