/**
 * Berapa SOL yang keluar dari sebuah wallet untuk transaksi pembuatan token/pool?
 *
 * Sandbox pengembangan repo ini TIDAK punya akses RPC Solana, jadi skrip ini harus
 * dijalankan di mesin Anda dengan RPC sendiri (Helius/QuickNode/Triton, atau
 * api.mainnet-beta.solana.com untuk percobaan singkat).
 *
 * Yang dihitung per transaksi:
 *   fee (meta.fee) + lamports yang benar-benar dikunci pada akun yang DIBUAT
 *   - `SystemProgram.createAccount*` (top-level & inner): pakai `info.lamports`
 *   - `associated-token-account` create/createIdempotent: 165 B → rent (128+165)×6960,
 *     hanya dihitung bila akun itu memang baru (preBalance 0 → postBalance > 0)
 *
 * Pemakaian:
 *   npm run cost:wallet -- --address 8HFdj9Snu3h93LqGHe83JFAgeJtnydqdt4z2mLtdsscB \
 *                          --rpc https://<RPC-anda> --limit 50
 *   npm run cost:wallet -- --address <WALLET> --rpc <RPC> --days 1      # kemarin
 *   npm run cost:wallet -- --address <WALLET> --rpc <RPC> --json
 *
 * Catatan: rent = deposit, bukan fee. Di program ini rent tidak bisa diklaim kembali.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatSol, lamportsToSol, rentExemptLamports } from './deployCost';

export const TOKEN_ACCOUNT_BYTES = 165;
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const TOKEN_2022_PROGRAM_ID_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const MINI_AMM_PROGRAM_ID_STR = 'DnW4iMWC5gCjPZkk2kkdTrY5uybW3w6r6aLdS6meynMn';

/** Bentuk minimal `ParsedTransactionWithMeta` yang dipakai (mudah diuji). */
export interface ParsedInstructionLike {
  program?: string;
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | null;
}

export interface ParsedTxLike {
  slot?: number;
  blockTime?: number | null;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string } | string>;
      instructions: ParsedInstructionLike[];
    };
  };
  meta?: {
    fee?: number;
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    innerInstructions?: Array<{ instructions: ParsedInstructionLike[] }> | null;
    logMessages?: string[] | null;
  } | null;
}

export interface CreatedAccount {
  publicKey?: string;
  lamports: number;
  bytes?: number;
  source: 'system.createAccount' | 'ata.create';
}

export interface TxCost {
  signature: string;
  blockTime: number | null;
  fee: number;
  created: CreatedAccount[];
  rentLamports: number;
  totalLamports: number;
  failed: boolean;
  programs: string[];
  /** Program yang relevan untuk pipeline repo ini. */
  flags: { token2022: boolean; ata: boolean; miniAmm: boolean };
}

export interface WalletCostSummary {
  address: string;
  txCount: number;
  failedCount: number;
  feeLamports: number;
  rentLamports: number;
  totalLamports: number;
  transactions: TxCost[];
}

function keyOf(key: { pubkey: string } | string): string {
  return typeof key === 'string' ? key : key.pubkey;
}

function balanceOf(tx: ParsedTxLike, pubkey: string): { pre: number; post: number } | null {
  const keys = tx.transaction.message.accountKeys.map(keyOf);
  const index = keys.indexOf(pubkey);
  if (index < 0) return null;
  return {
    pre: tx.meta?.preBalances?.[index] ?? 0,
    post: tx.meta?.postBalances?.[index] ?? 0,
  };
}

/** Ringkas satu transaksi terparse menjadi biaya fee + rent akun yang dibuat. */
export function summarizeTx(tx: ParsedTxLike, signature: string): TxCost {
  const instructions: ParsedInstructionLike[] = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions),
  ];

  const created: CreatedAccount[] = [];
  for (const ix of instructions) {
    const parsed = ix.parsed;
    if (!parsed || !parsed.info) continue;
    const info = parsed.info;
    const programId = ix.programId ?? '';

    if (
      ix.program === 'system' &&
      (parsed.type === 'createAccount' || parsed.type === 'createAccountWithSeed')
    ) {
      const lamports = Number(info.lamports ?? 0);
      const bytes = info.space === undefined ? undefined : Number(info.space);
      if (lamports > 0) {
        created.push({
          publicKey: typeof info.newAccount === 'string' ? info.newAccount : undefined,
          lamports,
          bytes,
          source: 'system.createAccount',
        });
      }
      continue;
    }

    if (
      programId === ATA_PROGRAM_ID &&
      (parsed.type === 'create' || parsed.type === 'createIdempotent')
    ) {
      const account = typeof info.account === 'string' ? info.account : '';
      // `createIdempotent` tidak mendanai apa pun bila ATA sudah ada.
      const balance = account ? balanceOf(tx, account) : null;
      const isNew = balance === null ? parsed.type === 'create' : balance.pre === 0 && balance.post > 0;
      if (isNew) {
        created.push({
          publicKey: account || undefined,
          lamports: rentExemptLamports(TOKEN_ACCOUNT_BYTES),
          bytes: TOKEN_ACCOUNT_BYTES,
          source: 'ata.create',
        });
      }
    }
  }

  const programs = Array.from(
    new Set(
      (tx.meta?.logMessages ?? [])
        .map((line) => /^Program (\w+) invoke/.exec(line)?.[1])
        .filter((value): value is string => Boolean(value))
    )
  );

  const fee = tx.meta?.fee ?? 0;
  const rentLamports = created.reduce((sum, item) => sum + item.lamports, 0);

  return {
    signature,
    blockTime: tx.blockTime ?? null,
    fee,
    created,
    rentLamports,
    totalLamports: fee + rentLamports,
    failed: Boolean(tx.meta?.err),
    programs,
    flags: {
      token2022: programs.includes(TOKEN_2022_PROGRAM_ID_STR),
      ata: programs.includes(ATA_PROGRAM_ID),
      miniAmm: programs.includes(MINI_AMM_PROGRAM_ID_STR),
    },
  };
}

export function summarizeWallet(
  address: string,
  entries: Array<{ signature: string; tx: ParsedTxLike }>
): WalletCostSummary {
  const transactions = entries.map(({ signature, tx }) => summarizeTx(tx, signature));
  return {
    address,
    txCount: transactions.length,
    failedCount: transactions.filter((tx) => tx.failed).length,
    feeLamports: transactions.reduce((sum, tx) => sum + tx.fee, 0),
    rentLamports: transactions.reduce((sum, tx) => sum + tx.rentLamports, 0),
    totalLamports: transactions.reduce((sum, tx) => sum + tx.totalLamports, 0),
    transactions,
  };
}

export async function fetchWalletCost(
  connection: Connection,
  address: string,
  options: { limit?: number; sinceUnix?: number } = {}
): Promise<WalletCostSummary> {
  const pubkey = new PublicKey(address);
  const limit = options.limit ?? 25;
  const signatures = await connection.getSignaturesForAddress(pubkey, { limit });

  const selected = signatures.filter((entry) =>
    options.sinceUnix === undefined || (entry.blockTime ?? 0) >= options.sinceUnix
  );

  const entries: Array<{ signature: string; tx: ParsedTxLike }> = [];
  const batch = 5;
  for (let i = 0; i < selected.length; i += batch) {
    const chunk = selected.slice(i, i + batch);
    const results = await Promise.all(
      chunk.map(async (entry) => {
        const tx = await connection.getParsedTransaction(entry.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        return tx ? { signature: entry.signature, tx: tx as unknown as ParsedTxLike } : null;
      })
    );
    for (const result of results) if (result) entries.push(result);
  }

  return summarizeWallet(address, entries);
}

function isoDate(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function main() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const address = get('--address');
  if (!address) {
    console.error(
      'Wajib --address <PUBKEY> dan --rpc <URL>.\n' +
        'Contoh: npm run cost:wallet -- --address 8HFdj9Snu3h93LqGHe83JFAgeJtnydqdt4z2mLtdsscB --rpc https://api.mainnet-beta.solana.com --limit 50'
    );
    process.exit(1);
  }
  try {
    new PublicKey(address);
  } catch {
    console.error(`Alamat tidak valid: ${address}`);
    process.exit(1);
  }

  const rpc = get('--rpc') ?? process.env.VITE_MAINNET_RPC_ENDPOINT ?? 'https://api.mainnet-beta.solana.com';
  const limit = Number(get('--limit') ?? 25);
  const days = get('--days') === undefined ? undefined : Number(get('--days'));
  const sinceUnix =
    days === undefined ? undefined : Math.floor(Date.now() / 1000) - days * 86_400;

  if (!/^https?:\/\//.test(rpc)) {
    console.error(`--rpc harus URL http(s), diterima: ${rpc}`);
    process.exit(1);
  }

  const connection = new Connection(rpc, 'confirmed');
  fetchWalletCost(connection, address, { limit, sinceUnix })
    .then((summary) => {
      if (argv.includes('--json')) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      console.log(`\nWallet : ${summary.address}`);
      console.log(`RPC    : ${rpc}`);
      console.log(`Tx     : ${summary.txCount} (gagal: ${summary.failedCount})\n`);
      for (const tx of summary.transactions) {
        const when = tx.blockTime ? isoDate(new Date(tx.blockTime * 1000)) : '—';
        const tags = [
          tx.flags.token2022 ? 'Token2022' : '',
          tx.flags.ata ? 'ATA' : '',
          tx.flags.miniAmm ? 'mini-amm' : '',
          tx.failed ? 'GAGAL' : '',
        ]
          .filter(Boolean)
          .join(',');
        console.log(
          `  ${when}  ${tx.signature.slice(0, 12)}…  fee ${formatSol(tx.fee, 6)}  akun baru ${tx.created.length}  ` +
            `rent ${formatSol(tx.rentLamports, 6)}  total ${formatSol(tx.totalLamports, 6)} SOL ${tags ? `[${tags}]` : ''}`
        );
        for (const item of tx.created) {
          console.log(
            `      + ${item.source.padEnd(22)} ${String(item.bytes ?? '?').padStart(6)} B  ${formatSol(item.lamports, 6)} SOL${item.publicKey ? `  ${item.publicKey}` : ''}`
          );
        }
      }
      console.log('\n=== Ringkasan ===');
      console.log(`Fee transaksi : ${lamportsToSol(summary.feeLamports).toFixed(6)} SOL`);
      console.log(`Rent akun baru: ${lamportsToSol(summary.rentLamports).toFixed(6)} SOL`);
      console.log(`TOTAL         : ${lamportsToSol(summary.totalLamports).toFixed(6)} SOL`);
      console.log(
        '\nCatatan: rent adalah deposit, bukan fee. Program ini tidak punya close/withdraw,\n' +
          'jadi rent pool/vault/mint tidak bisa diklaim kembali.\n'
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Gagal membaca RPC: ${message}`);
      console.error(
        'Pastikan endpoint dapat diakses dari mesin ini (sandbox pengembangan repo tidak punya akses RPC).'
      );
      process.exit(1);
    });
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) main();
