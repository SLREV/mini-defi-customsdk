import { Connection, PublicKey } from '@solana/web3.js';
import {
  CustomDefiSDK,
  DEFAULT_TOKEN_DECIMALS,
  SPL_TOKEN_ACCOUNT_LAYOUT,
  SPL_TOKEN_ACCOUNT_SIZE,
} from './sdk/customSdk';

/** Decimal input with no grouping or precision loss, suitable for parseTokenAmount. */
export function formatExactTokenAmount(raw: bigint, decimals = DEFAULT_TOKEN_DECIMALS): string {
  if (raw < 0n || !Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError('Saldo atau desimal token tidak valid');
  }
  const divisor = 10n ** BigInt(decimals);
  const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction && decimals > 0 ? `${raw / divisor}.${fraction}` : (raw / divisor).toString();
}

/** Read the same associated token account that buildSwapTx uses as its source. */
export async function readSwapTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey
): Promise<bigint> {
  const sdk = new CustomDefiSDK(connection);
  const ata = sdk.deriveAssociatedTokenAddress(owner, mint, tokenProgram);
  const account = await connection.getAccountInfo(ata, 'confirmed');
  if (!account) return 0n;
  if (!account.owner.equals(tokenProgram) || account.data.length < SPL_TOKEN_ACCOUNT_SIZE) {
    throw new Error('Akun token wallet tidak valid');
  }
  const token = SPL_TOKEN_ACCOUNT_LAYOUT.decode(account.data.subarray(0, SPL_TOKEN_ACCOUNT_SIZE));
  if (!token.owner.equals(owner) || !token.mint.equals(mint) || token.state !== 1) {
    throw new Error('Akun token wallet tidak aktif atau tidak sesuai');
  }
  return token.amount;
}
