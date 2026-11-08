/**
 * Kalkulator biaya: ukuran `.so` → rent deploy, plus biaya launch (mint + pool).
 *
 *   npx tsx scripts/cost.ts                # default 15 KB
 *   npx tsx scripts/cost.ts --size 21432   # ukuran byte hasil `ls -l target/deploy/*.so`
 *
 * Rumus sewa Solana: `(128 + bytes) * 6960` lamports.
 */
import {
  POOL_STATE_LEN,
  SPL_MINT_SIZE,
  SPL_TOKEN_ACCOUNT_SIZE,
  rentExemptLamports,
} from '../src/sdk/nativePool';

const LAMPORTS_PER_SOL = 1_000_000_000;
const toSol = (lamports: number): string => (lamports / LAMPORTS_PER_SOL).toFixed(6);

const PROGRAM_ACCOUNT_BYTES = 36; // akun Program itu sendiri (executable = false di data)
const BUFFER_OVERHEAD_BYTES = 45; // header ProgramData

function deployCost(programBytes: number): {
  programData: number;
  programAccount: number;
  final: number;
  peak: number;
} {
  const programData = rentExemptLamports(programBytes + BUFFER_OVERHEAD_BYTES);
  const programAccount = rentExemptLamports(PROGRAM_ACCOUNT_BYTES);
  return {
    programData,
    programAccount,
    final: programData + programAccount,
    // Saat `solana program deploy`, buffer sementara hidup bersamaan dengan akun program.
    peak: programData * 2 + programAccount,
  };
}

function launchCost(token2022MintBytes: number): Record<string, number> {
  const mint = rentExemptLamports(token2022MintBytes);
  const poolState = rentExemptLamports(POOL_STATE_LEN);
  const tokenAccounts = 4 * rentExemptLamports(SPL_TOKEN_ACCOUNT_SIZE); // 2 vault ATA + 2 fee vault
  const userAtas = 2 * rentExemptLamports(SPL_TOKEN_ACCOUNT_SIZE); // ATA token + ATA WSOL
  const fees = 5 * 5_000;
  return {
    mint,
    poolState,
    tokenAccounts,
    userAtas,
    fees,
    total: mint + poolState + tokenAccounts + userAtas + fees,
  };
}

const args = process.argv.slice(2);
const sizeFlag = args.indexOf('--size');
const programBytes =
  sizeFlag >= 0 && args[sizeFlag + 1] ? Number(args[sizeFlag + 1]) : 15 * 1024;

if (!Number.isFinite(programBytes) || programBytes <= 0) {
  console.error('--size harus angka positif (byte)');
  process.exit(1);
}

// Contoh mint Token-2022 dengan metadata (nama 12 + simbol 4 + uri 60 karakter).
const exampleMintBytes = 234 + 4 + (32 + 32 + (4 + 12) + (4 + 4) + (4 + 60) + 4);

const deploy = deployCost(programBytes);
const launch = launchCost(exampleMintBytes);

console.log(`Program .so : ${programBytes} byte (${(programBytes / 1024).toFixed(1)} KB)`);
console.log(`  ProgramData : ${toSol(deploy.programData)} SOL`);
console.log(`  Program     : ${toSol(deploy.programAccount)} SOL`);
console.log(`  Final       : ${toSol(deploy.final)} SOL`);
console.log(`  Puncak      : ${toSol(deploy.peak)} SOL (perlu buffer 2x saat deploy)`);
console.log('');
console.log('Launch token + pool (Token-2022):');
console.log(`  Mint        : ${toSol(launch.mint)} SOL`);
console.log(`  State pool  : ${toSol(launch.poolState)} SOL (${POOL_STATE_LEN} B)`);
console.log(`  Vault/fee   : ${toSol(launch.tokenAccounts)} SOL (4 x ${SPL_TOKEN_ACCOUNT_SIZE} B)`);
console.log(`  ATA user    : ${toSol(launch.userAtas)} SOL (2 x ${SPL_TOKEN_ACCOUNT_SIZE} B)`);
console.log(`  Fee tx      : ${toSol(launch.fees)} SOL (5 tx)`);
console.log(`  Total       : ${toSol(launch.total)} SOL`);
console.log('');
console.log(`Total deploy + launch: ${toSol(deploy.final + launch.total)} SOL`);
console.log(`(Sewa legacy SPL mint ${SPL_MINT_SIZE} B = ${toSol(rentExemptLamports(SPL_MINT_SIZE))} SOL)`);
