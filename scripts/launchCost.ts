/**
 * Model biaya "Launch Token-2022 & Virtual Pool" memakai SDK repo ini.
 *
 * Menjawab: "kalau wallet X membuat token (dan pool) lewat dashboard/SDK ini,
 * berapa SOL yang keluar?" — dihitung dari jalur kode yang sebenarnya:
 *
 *   tx#1  `buildCloneTokenInstructions` (src/sdk/customSdk.ts:1241)
 *         createAccount mint (ukuran penuh MetadataPointer + TokenMetadata)
 *         + MetadataPointer init + InitializeMint2 + TokenMetadata init
 *         + UpdateField (telegram/twitter) + CreateIdempotent ATA + MintToChecked
 *         + [opsional] revoke authority → 2 tanda tangan (payer + mint keypair)
 *
 *   tx#2  `buildCreatePoolTx` (customSdk.ts:1478) → `initialize_pool`
 *         Anchor `init` membuat: pool_state 289 B, lp_mint 82 B, 4 vault 165 B,
 *         ATA LP 165 B (+ CreateIdempotent ATA token Y 165 B) → 1 tanda tangan
 *
 *   tx#3  [opsional] `buildSwapTx` → ATA WSOL 165 B bila belum ada
 *
 * Rent = (128 + ukuran) × 6960 lamports. Semua rent di sini TIDAK bisa diklaim
 * kembali: program ini tidak punya instruksi close/withdraw.
 *
 * Pemakaian:
 *   npm run cost:launch
 *   npm run cost:launch -- --name "Nusantara Token" --symbol NUSA --uri ipfs://Qm…
 *   npm run cost:launch -- --no-pool
 *   npm run cost:launch -- --first-buy 0.5
 *   npm run cost:launch -- --legacy          # SPL Token + Metaplex (mint 82 B)
 *   npm run cost:launch -- --cu-price 10000 --cu 200000   # + priority fee
 *   npm run cost:launch -- --json
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateToken2022MintTotalBytes } from '../src/sdk/customSdk';
import { formatSol, lamportsToSol, rentExemptLamports } from './deployCost';

export const BASE_FEE_LAMPORTS = 5_000;
/** 8 B discriminator Anchor + 281 B PoolState. */
export const POOL_STATE_BYTES = 289;
export const MINT_BASE_BYTES = 82;
export const TOKEN_ACCOUNT_BYTES = 165;

export interface LaunchParams {
  name: string;
  symbol: string;
  uri: string;
  telegram?: string;
  twitter?: string;
  includePool?: boolean;
  firstBuySol?: number;
  legacy?: boolean;
  /** microLamports per compute unit (opsional; priority fee tidak bisa ditebak). */
  cuPrice?: number;
  cuLimit?: number;
}

export interface LineItem {
  label: string;
  bytes?: number;
  lamports: number;
  note?: string;
}

export interface LaunchCostResult {
  items: LineItem[];
  tokenLamports: number;
  poolLamports: number;
  firstBuyLamports: number;
  totalLamports: number;
  mintBytes: number;
  /** Selalu 0 untuk program ini: tidak ada instruksi close/withdraw. */
  reclaimableLamports: number;
}

export function estimateLaunchCost(params: LaunchParams): LaunchCostResult {
  const includePool = params.includePool ?? true;
  const additionalMetadata: [string, string][] = [];
  if (params.telegram) additionalMetadata.push(['telegram', params.telegram]);
  if (params.twitter) additionalMetadata.push(['twitter', params.twitter]);

  const mintBytes = params.legacy
    ? MINT_BASE_BYTES
    : calculateToken2022MintTotalBytes({
        name: params.name,
        symbol: params.symbol,
        uri: params.uri,
        additionalMetadata,
      });

  const items: LineItem[] = [];
  const push = (label: string, lamports: number, bytes?: number, note?: string) =>
    items.push({ label, lamports, bytes, note });

  // --- tx#1: token ---------------------------------------------------------
  push(
    params.legacy
      ? 'Mint SPL legacy (82 B)'
      : 'Mint Token-2022 (MetadataPointer + TokenMetadata)',
    rentExemptLamports(mintBytes),
    mintBytes,
    params.legacy ? 'tanpa metadata on-chain' : 'ukuran mengikuti panjang nama/simbol/URI/sosial'
  );
  push('ATA token milik payer', rentExemptLamports(TOKEN_ACCOUNT_BYTES), TOKEN_ACCOUNT_BYTES, 'CreateIdempotent');
  push('Fee tx#1 (2 tanda tangan)', BASE_FEE_LAMPORTS * 2, undefined, 'payer + keypair mint');

  // --- tx#2: pool ----------------------------------------------------------
  if (includePool) {
    push('PoolState', rentExemptLamports(POOL_STATE_BYTES), POOL_STATE_BYTES, '8 B disc + 281 B');
    push('LP mint', rentExemptLamports(MINT_BASE_BYTES), MINT_BASE_BYTES, 'decimals 9, authority = pool PDA');
    push(
      'vault_x, vault_y, fee_vault_x, fee_vault_y',
      rentExemptLamports(TOKEN_ACCOUNT_BYTES) * 4,
      TOKEN_ACCOUNT_BYTES * 4,
      '4 akun token @165 B'
    );
    push('ATA LP milik payer', rentExemptLamports(TOKEN_ACCOUNT_BYTES), TOKEN_ACCOUNT_BYTES, 'init_if_needed');
    push('ATA token Y milik payer', rentExemptLamports(TOKEN_ACCOUNT_BYTES), TOKEN_ACCOUNT_BYTES, 'CreateIdempotent di tx yang sama');
    push('Fee tx#2 (1 tanda tangan)', BASE_FEE_LAMPORTS, undefined, 'initialize_pool');
  }

  // --- tx#3: beli awal -----------------------------------------------------
  let firstBuyLamports = 0;
  if ((params.firstBuySol ?? 0) > 0) {
    const ataWsol = rentExemptLamports(TOKEN_ACCOUNT_BYTES);
    push('ATA WSOL milik payer', ataWsol, TOKEN_ACCOUNT_BYTES, 'hanya bila belum ada');
    push('Fee tx#3 (1 tanda tangan)', BASE_FEE_LAMPORTS, undefined, 'transfer + SyncNative + swap');
    firstBuyLamports = ataWsol + BASE_FEE_LAMPORTS;
  }

  // --- priority fee (opsional) --------------------------------------------
  if (params.cuPrice && params.cuLimit) {
    const txs = includePool ? 2 + ((params.firstBuySol ?? 0) > 0 ? 1 : 0) : 1;
    const perTx = Math.ceil((params.cuPrice * params.cuLimit) / 1_000_000);
    push(`Priority fee (${params.cuPrice} µL/compute unit × ${txs} tx)`, perTx * txs, undefined, 'estimasi, tergantung jaringan');
  }

  const tokenLamports = items
    .slice(0, 3)
    .reduce((sum, item) => sum + item.lamports, 0);
  const poolLamports = items
    .filter((item) => /PoolState|LP mint|vault|ATA LP|ATA token Y|Fee tx#2/.test(item.label))
    .reduce((sum, item) => sum + item.lamports, 0);
  const totalLamports = items.reduce((sum, item) => sum + item.lamports, 0);

  return {
    items,
    tokenLamports,
    poolLamports,
    firstBuyLamports,
    totalLamports,
    mintBytes,
    reclaimableLamports: 0,
  };
}

function parseArgs(argv: string[]): LaunchParams & { json: boolean; noPool: boolean } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string) => {
    const v = get(flag);
    return v === undefined ? undefined : Number(v);
  };
  return {
    name: get('--name') ?? 'Nusantara Token',
    symbol: get('--symbol') ?? 'NUSA',
    uri:
      get('--uri') ??
      'https://gateway.pinata.cloud/ipfs/QmYwAPJzv5CZsnAzt8auVZRn5o1x7V7b1n5uYj9kK3sT2X',
    telegram: get('--telegram') ?? 'https://t.me/nusantara',
    twitter: get('--twitter') ?? 'https://x.com/nusantara',
    includePool: !argv.includes('--no-pool'),
    firstBuySol: num('--first-buy') ?? 0,
    legacy: argv.includes('--legacy'),
    cuPrice: num('--cu-price'),
    cuLimit: num('--cu'),
    json: argv.includes('--json'),
    noPool: argv.includes('--no-pool'),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = estimateLaunchCost(args);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('\n=== Estimasi biaya launch (SDK repo ini) ===');
  console.log(`Token          : ${args.name} ($${args.symbol})`);
  console.log(`Standar        : ${args.legacy ? 'SPL legacy + Metaplex' : 'Token-2022 (metadata on-chain)'}`);
  console.log(`Ukuran mint    : ${result.mintBytes} B`);
  console.log(`Pool           : ${args.includePool ? 'ya (initialize_pool, 17 akun)' : 'tidak'}`);
  console.log('');
  for (const item of result.items) {
    const bytes = item.bytes ? `${String(item.bytes).padStart(5)} B` : '       ';
    console.log(
      `  ${item.label.padEnd(46)} ${bytes}  ${formatSol(item.lamports, 6)} SOL` +
        (item.note ? `  (${item.note})` : '')
    );
  }
  console.log('  ' + '-'.repeat(80));
  console.log(`  ${'Token saja'.padEnd(46)} ${' '.repeat(7)}  ${formatSol(result.tokenLamports, 6)} SOL`);
  if (args.includePool) {
    console.log(`  ${'Pool (initialize_pool)'.padEnd(46)} ${' '.repeat(7)}  ${formatSol(result.poolLamports, 6)} SOL`);
  }
  console.log(`  ${'TOTAL'.padEnd(46)} ${' '.repeat(7)}  ${formatSol(result.totalLamports, 6)} SOL`);
  if ((args.firstBuySol ?? 0) > 0) {
    console.log(
      `\n  Beli awal ${args.firstBuySol} SOL tidak dihitung di atas — itu ditukar jadi token,` +
        ` bukan biaya (kecuali ATA WSOL + fee ${formatSol(result.firstBuyLamports ?? 0, 6)} SOL).`
    );
  }
  console.log(
    `\nSemua rent di atas TIDAK bisa diklaim kembali (program tanpa close/withdraw).` +
      `\nTotal ≈ ${lamportsToSol(result.totalLamports).toFixed(6)} SOL.` +
      `\nUntuk wallet tertentu yang sudah bertransaksi, jalankan: npm run cost:wallet -- --address <WALLET> --rpc <RPC>\n`
  );
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) main();
