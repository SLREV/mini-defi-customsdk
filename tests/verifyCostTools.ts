/**
 * Uji dua alat biaya:
 *   1. `scripts/launchCost.ts`  — model biaya launch token (+pool) dengan SDK repo ini
 *   2. `scripts/walletCost.ts`  — pembaca riwayat wallet (fee + rent akun baru)
 *
 * Semua diuji offline: tidak ada RPC yang dipanggil.
 */
import assert from 'node:assert/strict';
import { formatSol, rentExemptLamports } from '../scripts/deployCost';
import {
  BASE_FEE_LAMPORTS,
  MINT_BASE_BYTES,
  POOL_STATE_BYTES,
  TOKEN_ACCOUNT_BYTES,
  estimateLaunchCost,
} from '../scripts/launchCost';
import {
  ATA_PROGRAM_ID,
  MINI_AMM_PROGRAM_ID_STR,
  TOKEN_2022_PROGRAM_ID_STR,
  summarizeTx,
  summarizeWallet,
  type ParsedTxLike,
} from '../scripts/walletCost';

const rent = rentExemptLamports;
const ataRent = rent(TOKEN_ACCOUNT_BYTES);
assert.equal(ataRent, 2_039_280, 'rent 165 B = 0.002039 SOL');

// ---------------------------------------------------------------------------
// 1. Model biaya launch
// ---------------------------------------------------------------------------
const base = {
  name: 'Nusantara Token',
  symbol: 'NUSA',
  uri: 'https://gateway.pinata.cloud/ipfs/QmYwAPJzv5CZsnAzt8auVZRn5o1x7V7b1n5uYj9kK3sT2X',
  telegram: 'https://t.me/nusantara',
  twitter: 'https://x.com/nusantara',
};

const tokenOnly = estimateLaunchCost({ ...base, includePool: false });
assert.equal(tokenOnly.mintBytes, 493, 'ukuran mint Token-2022 untuk metadata contoh');
assert.equal(
  tokenOnly.totalLamports,
  rent(493) + ataRent + BASE_FEE_LAMPORTS * 2,
  'mint + ATA + fee 2 tanda tangan'
);
assert.equal(tokenOnly.poolLamports, 0);
assert.equal(formatSol(tokenOnly.totalLamports), '0.0064');

const full = estimateLaunchCost({ ...base, includePool: true });
assert.equal(
  full.poolLamports,
  rent(POOL_STATE_BYTES) +
    rent(MINT_BASE_BYTES) +
    rent(TOKEN_ACCOUNT_BYTES) * 4 +
    rent(TOKEN_ACCOUNT_BYTES) +
    rent(TOKEN_ACCOUNT_BYTES) +
    BASE_FEE_LAMPORTS,
  'pool_state + lp mint + 4 vault + ATA LP + ATA token Y + fee'
);
assert.equal(full.totalLamports, tokenOnly.totalLamports + full.poolLamports);
assert.equal(formatSol(full.totalLamports), '0.0230');
assert.equal(full.reclaimableLamports, 0, 'program tanpa close/withdraw → tidak ada refund');

// Nama/URI lebih panjang → mint lebih besar (metadata disimpan on-chain).
const longer = estimateLaunchCost({ ...base, name: 'Nusantara Token Ekosistem Rakyat Indonesia', includePool: false });
assert.ok(longer.mintBytes > tokenOnly.mintBytes);
assert.ok(longer.totalLamports > tokenOnly.totalLamports);

// SPL legacy: mint 82 B, tanpa metadata on-chain.
const legacy = estimateLaunchCost({ ...base, legacy: true, includePool: false });
assert.equal(legacy.mintBytes, MINT_BASE_BYTES);
assert.ok(legacy.totalLamports < tokenOnly.totalLamports);

// Beli awal menambah ATA WSOL + fee, bukan "biaya" tambahan.
const withBuy = estimateLaunchCost({ ...base, includePool: true, firstBuySol: 0.5 });
assert.equal(withBuy.firstBuyLamports, ataRent + BASE_FEE_LAMPORTS);
assert.equal(withBuy.totalLamports, full.totalLamports + (ataRent + BASE_FEE_LAMPORTS));

// Priority fee opsional: ceil(cuPrice × cu / 1e6) per transaksi.
const priority = estimateLaunchCost({
  ...base,
  includePool: true,
  cuPrice: 10_000,
  cuLimit: 200_000,
});
const perTx = Math.ceil((10_000 * 200_000) / 1_000_000);
assert.equal(priority.totalLamports, full.totalLamports + perTx * 2);

// ---------------------------------------------------------------------------
// 2. Pembaca riwayat wallet (data sintetis, tanpa RPC)
// ---------------------------------------------------------------------------
const MINT = 'Mint1111111111111111111111111111111111111111';
const ATA = 'Ata11111111111111111111111111111111111111111';
const WALLET = '8HFdj9Snu3h93LqGHe83JFAgeJtnydqdt4z2mLtdsscB';

const createTokenTx = {
  blockTime: 1_762_500_000,
  transaction: {
    message: {
      accountKeys: [{ pubkey: WALLET }, { pubkey: MINT }, { pubkey: ATA }],
      instructions: [
        {
          program: 'system',
          programId: '11111111111111111111111111111111',
          parsed: {
            type: 'createAccount',
            info: { newAccount: MINT, lamports: rent(493), space: 493, source: WALLET },
          },
        },
        {
          programId: ATA_PROGRAM_ID,
          parsed: { type: 'create', info: { account: ATA, mint: MINT, source: WALLET } },
        },
      ],
    },
  },
  meta: {
    fee: BASE_FEE_LAMPORTS * 2,
    err: null,
    preBalances: [10_000_000_000, 0, 0],
    postBalances: [10_000_000_000 - rent(493) - ataRent - 10_000, rent(493), ataRent],
    logMessages: [
      `Program ${TOKEN_2022_PROGRAM_ID_STR} invoke [1]`,
      `Program ${ATA_PROGRAM_ID} invoke [1]`,
      'Program log: done',
    ],
  },
} as unknown as ParsedTxLike;

const withPoolTx = {
  blockTime: 1_762_500_100,
  transaction: {
    message: {
      accountKeys: [{ pubkey: WALLET }, { pubkey: 'Pool1111' }, { pubkey: ATA }],
      instructions: [
        {
          programId: MINI_AMM_PROGRAM_ID_STR,
          parsed: { type: 'initializePool', info: {} },
        },
      ],
    },
  },
  meta: {
    fee: BASE_FEE_LAMPORTS,
    err: null,
    preBalances: [9_000_000_000, 0, ataRent],
    postBalances: [9_000_000_000 - rent(POOL_STATE_BYTES) - BASE_FEE_LAMPORTS, rent(POOL_STATE_BYTES), ataRent],
    // ATA sudah ada (pre > 0) → CreateIdempotent TIDAK menambah rent.
    innerInstructions: [
      {
        instructions: [
          {
            program: 'system',
            parsed: {
              type: 'createAccount',
              info: { newAccount: 'Pool1111', lamports: rent(POOL_STATE_BYTES), space: POOL_STATE_BYTES },
            },
          },
          {
            programId: ATA_PROGRAM_ID,
            parsed: { type: 'createIdempotent', info: { account: ATA } },
          },
        ],
      },
    ],
    logMessages: [
      `Program ${MINI_AMM_PROGRAM_ID_STR} invoke [1]`,
      `Program ${ATA_PROGRAM_ID} invoke [2]`,
    ],
  },
} as unknown as ParsedTxLike;

const failedTx = {
  blockTime: 1_762_500_200,
  transaction: { message: { accountKeys: [{ pubkey: WALLET }], instructions: [] } },
  meta: { fee: BASE_FEE_LAMPORTS, err: { InstructionError: [0, 'Custom'] }, preBalances: [0], postBalances: [0] },
} as unknown as ParsedTxLike;

const tokenCost = summarizeTx(createTokenTx, 'sigA');
assert.equal(tokenCost.rentLamports, rent(493) + ataRent);
assert.equal(tokenCost.totalLamports, rent(493) + ataRent + BASE_FEE_LAMPORTS * 2);
assert.equal(tokenCost.created.length, 2);
assert.deepEqual(tokenCost.flags, { token2022: true, ata: true, miniAmm: false });
assert.equal(tokenCost.failed, false);

const poolCost = summarizeTx(withPoolTx, 'sigB');
assert.equal(poolCost.created.length, 1, 'createIdempotent pada ATA yang sudah ada tidak dihitung');
assert.equal(poolCost.rentLamports, rent(POOL_STATE_BYTES));
assert.equal(poolCost.totalLamports, rent(POOL_STATE_BYTES) + BASE_FEE_LAMPORTS);
assert.deepEqual(poolCost.flags, { token2022: false, ata: true, miniAmm: true });

const failedCost = summarizeTx(failedTx, 'sigC');
assert.equal(failedCost.failed, true);
assert.equal(failedCost.rentLamports, 0);
assert.equal(failedCost.totalLamports, BASE_FEE_LAMPORTS, 'transaksi gagal tetap membayar fee');

const summary = summarizeWallet(WALLET, [
  { signature: 'sigA', tx: createTokenTx },
  { signature: 'sigB', tx: withPoolTx },
  { signature: 'sigC', tx: failedTx },
]);
assert.equal(summary.txCount, 3);
assert.equal(summary.failedCount, 1);
assert.equal(
  summary.totalLamports,
  tokenCost.totalLamports + poolCost.totalLamports + failedCost.totalLamports
);
assert.equal(summary.feeLamports, BASE_FEE_LAMPORTS * 4);
assert.equal(summary.address, WALLET);

console.log('ALL COST TOOL TESTS PASSED!');
console.log({
  launchTokenOnlySol: formatSol(tokenOnly.totalLamports, 6),
  launchTokenAndPoolSol: formatSol(full.totalLamports, 6),
  launchWithFirstBuySol: formatSol(withBuy.totalLamports, 6),
  walletSyntheticTotalSol: formatSol(summary.totalLamports, 6),
  ataRentSol: formatSol(ataRent, 6),
});
