/**
 * Klien untuk program `mini_amm_native` (tanpa Anchor).
 *
 * Hanya memakai `@solana/web3.js` — tanpa Anchor, tanpa `@solana/spl-token`.
 * Semua instruksi SPL/Token-2022 disusun manual agar bundle kecil dan layout
 * instruksi bisa dibuktikan per byte.
 *
 * State pool = 81 byte (lihat `program/src/processor.rs`).
 */
import {
  AccountMeta,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

export const SYSTEM_PROGRAM_ID = SystemProgram.programId;
export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);
export const NATIVE_SOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112'
);

/** Program ID default — HARUS sama dengan `declare_id!` di `program/src/lib.rs`. */
export const DEFAULT_NATIVE_PROGRAM_ID = new PublicKey(
  'A73BhxKr2bktNx7tgZUubMgXrumng17jYfKm5cTdWbXv'
);

export const POOL_SEED = Buffer.from('amm_pool', 'utf8');
export const FEE_VAULT_X_SEED = Buffer.from('fee_vault_x', 'utf8');
export const FEE_VAULT_Y_SEED = Buffer.from('fee_vault_y', 'utf8');

/** 1 + 32 + 32 + 8 + 1 = 74 dipakai, dialokasikan 81 byte (padding). */
export const POOL_STATE_LEN = 81;
export const POOL_STATE_DISCRIMINATOR = 9;

export const POOL_STATE_OFFSETS = {
  discriminator: 0,
  vaultX: 1,
  vaultY: 33,
  virtualReservesX: 65,
  bump: 73,
} as const;

export const NATIVE_IX = { INITIALIZE_POOL: 0, FUND_POOL: 1, SWAP: 2 } as const;

export const BPS = 10_000n;
export const CREATOR_FEE_BPS = 6n;
export const LP_FEE_BPS = 24n;

export const SPL_TOKEN_ACCOUNT_SIZE = 165;
export const SPL_MINT_SIZE = 82;
export const DEFAULT_TOKEN_DECIMALS = 9;

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------

/**
 * Rumus sewa Solana: `(128 + ukuran) * 6960` lamports.
 * Sama dengan `rentExemptLamports` di repo induk (`scripts/deployCost.ts`).
 */
export function rentExemptLamports(sizeBytes: number): number {
  return (128 + sizeBytes) * 6960;
}

export function u64Le(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

export function readU64Le(data: Uint8Array, offset: number): bigint {
  return Buffer.from(data.buffer, data.byteOffset + offset, 8).readBigUInt64LE();
}

/**
 * `a * b / d` dengan BigInt (truncating) — salinan `mul_div_u128` di on-chain.
 */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('pembagi nol');
  return (a * b) / denominator;
}

export interface SwapQuote {
  creatorFee: bigint;
  netIn: bigint;
  amountOut: bigint;
}

/**
 * Rumus AMM yang sama persis dengan `process_swap` on-chain:
 * fee 30 bps = 24 LP (tetap di pool) + 6 creator (ke fee vault).
 */
export function computeSwapOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): SwapQuote {
  if (amountIn <= 0n) throw new Error('amount_in harus > 0');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('reserve kosong');
  const creatorFee = mulDiv(amountIn, CREATOR_FEE_BPS, BPS);
  if (creatorFee >= amountIn) throw new Error('amount_in terlalu kecil');
  const netIn = amountIn - creatorFee;
  const netInWithFee = netIn * (BPS - LP_FEE_BPS);
  const denominator = reserveIn * BPS + netInWithFee;
  const amountOut = mulDiv(netInWithFee, reserveOut, denominator);
  if (amountOut <= 0n) throw new Error('output nol');
  if (amountOut >= reserveOut) throw new Error('output melebihi reserve');
  return { creatorFee, netIn, amountOut };
}

export function formatTokenAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').slice(0, 4);
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}${
    fraction.replace(/0+$/, '') ? `.${fraction.replace(/0+$/, '')}` : ''
  }`;
}

export function parseTokenAmount(input: string, decimals: number): bigint {
  const clean = input.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error(`angka tidak valid: "${input}"`);
  const [whole, fraction = ''] = clean.split('.');
  if (fraction.length > decimals) {
    throw new Error(`maksimal ${decimals} angka desimal`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

// ---------------------------------------------------------------------------
// PDA / ATA
// ---------------------------------------------------------------------------

export function derivePoolState(
  mintX: PublicKey,
  mintY: PublicKey,
  programId: PublicKey
): { poolState: PublicKey; bump: number } {
  const [poolState, bump] = PublicKey.findProgramAddressSync(
    [POOL_SEED, mintX.toBuffer(), mintY.toBuffer()],
    programId
  );
  return { poolState, bump };
}

export function deriveAssociatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

/**
 * Penampung fee creator. Tidak bisa ATA karena ATA untuk (pool, mint) sudah
 * dipakai sebagai vault — jadi memakai PDA sendiri, di-initialize manual.
 */
export function deriveFeeVault(
  side: 'x' | 'y',
  poolState: PublicKey,
  programId: PublicKey = DEFAULT_NATIVE_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [side === 'x' ? FEE_VAULT_X_SEED : FEE_VAULT_Y_SEED, poolState.toBuffer()],
    programId
  )[0];
}

// ---------------------------------------------------------------------------
// Builder instruksi SPL/Token-2022 (manual)
// ---------------------------------------------------------------------------

/** `AssociatedTokenAccountInstruction::CreateIdempotent` (index 1). */
export function buildCreateAtaIdempotent(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): TransactionInstruction {
  const ata = deriveAssociatedTokenAddress(owner, mint, tokenProgramId);
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/**
 * Membuat akun token biasa (bukan ATA) lalu `InitializeAccount3` (index 18).
 * Dipakai untuk fee vault milik PDA pool (ATA untuk mint tsb. sudah jadi vault).
 */
export function buildCreateTokenAccount(
  payer: PublicKey,
  account: PublicKey,
  owner: PublicKey,
  rentLamports: number,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): TransactionInstruction[] {
  const create = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: account,
    space: SPL_TOKEN_ACCOUNT_SIZE,
    lamports: rentLamports,
    programId: tokenProgramId,
  });
  // `InitializeAccount3` (index 18): data = [18, owner(32)].
  const initialize = new TransactionInstruction({
    programId: tokenProgramId,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data: Buffer.concat([Buffer.from([18]), owner.toBuffer()]),
  });
  return [create, initialize];
}

/** `SyncNative` (index 17): saldo lamports ATA WSOL jadi saldo token. */
export function buildSyncNative(
  wsolAta: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgramId,
    keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),
  });
}

// ---------------------------------------------------------------------------
// Builder instruksi program native
// ---------------------------------------------------------------------------

export interface InitializePoolParams {
  payer: PublicKey;
  mintX: PublicKey;
  mintY: PublicKey;
  tokenProgramX: PublicKey;
  tokenProgramY: PublicKey;
  virtualReservesX: bigint;
  /** Sewa 165 byte untuk membuat 2 fee vault (default diambil dari rumus rent). */
  tokenAccountRentLamports?: number;
  programId?: PublicKey;
}

export interface InitializePoolResult {
  poolState: PublicKey;
  bump: number;
  vaultX: PublicKey;
  vaultY: PublicKey;
  feeVaultX: PublicKey;
  feeVaultY: PublicKey;
  /** 4 ATA milik PDA pool — harus dibuat SEBELUM `initialize_pool`. */
  ataInstructions: TransactionInstruction[];
  instruction: TransactionInstruction;
}

/**
 * Menyiapkan `initialize_pool` + 4 ATA vault milik PDA pool.
 * Urutan kirim: `ataInstructions` lalu `instruction` dalam satu transaksi.
 */
export function buildInitializePool(params: InitializePoolParams): InitializePoolResult {
  const programId = params.programId ?? DEFAULT_NATIVE_PROGRAM_ID;
  const { poolState, bump } = derivePoolState(params.mintX, params.mintY, programId);

  const vaultX = deriveAssociatedTokenAddress(poolState, params.mintX, params.tokenProgramX);
  const vaultY = deriveAssociatedTokenAddress(poolState, params.mintY, params.tokenProgramY);
  const feeVaultX = deriveFeeVault('x', poolState, programId);
  const feeVaultY = deriveFeeVault('y', poolState, programId);
  const rent = params.tokenAccountRentLamports ?? rentExemptLamports(SPL_TOKEN_ACCOUNT_SIZE);

  const ataInstructions = [
    buildCreateAtaIdempotent(params.payer, poolState, params.mintX, params.tokenProgramX),
    buildCreateAtaIdempotent(params.payer, poolState, params.mintY, params.tokenProgramY),
    ...buildCreateTokenAccount(params.payer, feeVaultX, poolState, rent, params.tokenProgramX),
    ...buildCreateTokenAccount(params.payer, feeVaultY, poolState, rent, params.tokenProgramY),
  ];

  const data = Buffer.concat([Buffer.from([NATIVE_IX.INITIALIZE_POOL]), u64Le(params.virtualReservesX)]);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.mintX, isSigner: false, isWritable: false },
      { pubkey: params.mintY, isSigner: false, isWritable: false },
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: vaultX, isSigner: false, isWritable: false },
      { pubkey: vaultY, isSigner: false, isWritable: false },
      { pubkey: feeVaultX, isSigner: false, isWritable: false },
      { pubkey: feeVaultY, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { poolState, bump, vaultX, vaultY, feeVaultX, feeVaultY, ataInstructions, instruction };
}

export interface FundPoolParams {
  creator: PublicKey;
  mintX: PublicKey;
  mintY: PublicKey;
  tokenProgramY: PublicKey;
  amount: bigint;
  programId?: PublicKey;
}

/** Menyetor token Y milik creator ke `vault_y` (tanpa LP token). */
export function buildFundPool(params: FundPoolParams): TransactionInstruction {
  const programId = params.programId ?? DEFAULT_NATIVE_PROGRAM_ID;
  const { poolState } = derivePoolState(params.mintX, params.mintY, programId);
  const vaultY = deriveAssociatedTokenAddress(poolState, params.mintY, params.tokenProgramY);
  const creatorAta = deriveAssociatedTokenAddress(
    params.creator,
    params.mintY,
    params.tokenProgramY
  );

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.creator, isSigner: true, isWritable: false },
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: params.mintY, isSigner: false, isWritable: false },
      { pubkey: creatorAta, isSigner: false, isWritable: true },
      { pubkey: vaultY, isSigner: false, isWritable: true },
      { pubkey: params.tokenProgramY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([NATIVE_IX.FUND_POOL]), u64Le(params.amount)]),
  });
}

export interface SwapParams {
  user: PublicKey;
  mintX: PublicKey;
  mintY: PublicKey;
  tokenProgramX: PublicKey;
  tokenProgramY: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  /** `true` = SOL/WSOL → token creator. */
  xToY: boolean;
  programId?: PublicKey;
}

export function buildSwap(params: SwapParams): TransactionInstruction {
  const programId = params.programId ?? DEFAULT_NATIVE_PROGRAM_ID;
  const { poolState } = derivePoolState(params.mintX, params.mintY, programId);
  const vaultX = deriveAssociatedTokenAddress(poolState, params.mintX, params.tokenProgramX);
  const vaultY = deriveAssociatedTokenAddress(poolState, params.mintY, params.tokenProgramY);

  const data = Buffer.concat([
    Buffer.from([NATIVE_IX.SWAP]),
    u64Le(params.amountIn),
    u64Le(params.minAmountOut),
    Buffer.from([params.xToY ? 1 : 0]),
  ]);
  if (data.length !== 18) throw new Error(`payload swap harus 18 byte, dapat ${data.length}`);

  const keys: AccountMeta[] = [
    { pubkey: params.user, isSigner: true, isWritable: false },
    { pubkey: params.mintX, isSigner: false, isWritable: false },
    { pubkey: params.mintY, isSigner: false, isWritable: false },
    { pubkey: poolState, isSigner: false, isWritable: false },
    { pubkey: vaultX, isSigner: false, isWritable: true },
    { pubkey: vaultY, isSigner: false, isWritable: true },
    { pubkey: deriveFeeVault('x', poolState, programId), isSigner: false, isWritable: true },
    { pubkey: deriveFeeVault('y', poolState, programId), isSigner: false, isWritable: true },
    {
      pubkey: deriveAssociatedTokenAddress(params.user, params.mintX, params.tokenProgramX),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: deriveAssociatedTokenAddress(params.user, params.mintY, params.tokenProgramY),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: params.tokenProgramX, isSigner: false, isWritable: false },
    { pubkey: params.tokenProgramY, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}

// ---------------------------------------------------------------------------
// Baca state pool
// ---------------------------------------------------------------------------

export interface PoolSnapshot {
  poolState: PublicKey;
  vaultX: PublicKey;
  vaultY: PublicKey;
  virtualReservesX: bigint;
  bump: number;
  reserveX: bigint;
  reserveY: bigint;
}

export function decodePoolState(_poolState: PublicKey, data: Uint8Array): {
  vaultX: PublicKey;
  vaultY: PublicKey;
  virtualReservesX: bigint;
  bump: number;
} {
  if (data.length < POOL_STATE_LEN) throw new Error(`state pool ${data.length} byte, harus 81`);
  if (data[POOL_STATE_OFFSETS.discriminator] !== POOL_STATE_DISCRIMINATOR) {
    throw new Error('discriminator state pool tidak cocok');
  }
  return {
    vaultX: new PublicKey(data.slice(POOL_STATE_OFFSETS.vaultX, POOL_STATE_OFFSETS.vaultX + 32)),
    vaultY: new PublicKey(data.slice(POOL_STATE_OFFSETS.vaultY, POOL_STATE_OFFSETS.vaultY + 32)),
    virtualReservesX: readU64Le(data, POOL_STATE_OFFSETS.virtualReservesX),
    bump: data[POOL_STATE_OFFSETS.bump],
  };
}

/** Ambil state + saldo vault. `tokenAmountOffset = 64` pada layout token account. */
export async function fetchPoolSnapshot(
  connection: Connection,
  poolState: PublicKey
): Promise<PoolSnapshot | null> {
  const account = await connection.getAccountInfo(poolState, 'confirmed');
  if (!account) return null;
  const decoded = decodePoolState(poolState, account.data);
  const [vaultXInfo, vaultYInfo] = await connection.getMultipleAccountsInfo(
    [decoded.vaultX, decoded.vaultY],
    'confirmed'
  );
  const amountOf = (data: Uint8Array | null) =>
    data && data.length >= 72 ? readU64Le(data, 64) : 0n;
  const reserveX = amountOf(vaultXInfo?.data ?? null);
  const reserveY = amountOf(vaultYInfo?.data ?? null);
  return {
    poolState,
    vaultX: decoded.vaultX,
    vaultY: decoded.vaultY,
    virtualReservesX: decoded.virtualReservesX,
    bump: decoded.bump,
    reserveX,
    reserveY,
  };
}
