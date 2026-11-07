import { Connection, PublicKey } from '@solana/web3.js';

export type RpcNetwork = 'DEVNET' | 'MAINNET';
export type ExecutionMode = 'SANDBOX' | RpcNetwork;
export const NETWORK_GENESIS: Record<RpcNetwork, string> = {
  DEVNET: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  MAINNET: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
};

/** Never trust an RPC URL's name: require the actual cluster genesis hash. */
export async function assertRpcNetwork(connection: Pick<Connection, 'getGenesisHash'>, network: RpcNetwork): Promise<void> {
  const actual = await connection.getGenesisHash();
  if (actual !== NETWORK_GENESIS[network]) {
    throw new Error(`RPC bukan jaringan ${network}. Periksa URL RPC sebelum melanjutkan.`);
  }
}

/** Existence/executable checks are not a code audit or proof of deployment identity. */
export async function assertRpcReady(
  connection: Pick<Connection, 'getGenesisHash' | 'getAccountInfo'>,
  network: RpcNetwork,
  programId: PublicKey | null
): Promise<void> {
  if (!programId) throw new Error(`Program ID ${network} belum dikonfigurasi atau tidak valid. Periksa VITE_${network}_AMM_PROGRAM_ID di .env.`);
  await assertRpcNetwork(connection, network);
  const program = await connection.getAccountInfo(programId, 'confirmed');
  if (!program?.executable) {
    throw new Error(`Program AMM ${programId.toBase58()} tidak ditemukan atau tidak executable di ${network}.`);
  }
}

/** Mainnet never uses the ephemeral keypair; require the connected provider and payer. */
export function assertMainnetWallet(
  acknowledged: boolean,
  walletType: 'INJECTED' | 'EPHEMERAL' | null,
  wallet: PublicKey | null,
  providerWallet: PublicKey | null | undefined,
  feePayer: PublicKey | null | undefined,
): void {
  if (!acknowledged || walletType !== 'INJECTED' || !wallet || !providerWallet ||
      !feePayer || !wallet.equals(providerWallet) || !wallet.equals(feePayer)) {
    throw new Error('Mainnet memerlukan persetujuan risiko dan wallet Phantom yang sesuai dengan fee payer. Hubungkan ulang bila wallet berubah.');
  }
}

/** A separate explicit mainnet program ID avoids assuming devnet deployments exist there. */
export function resolveProgramId(network: RpcNetwork, value: string | undefined, devnetDefault: PublicKey): PublicKey | null {
  const configured = value?.trim();
  if (!configured) return network === 'DEVNET' ? devnetDefault : null;
  try { return new PublicKey(configured); } catch { return null; }
}
