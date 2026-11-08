/**
 * Dashboard minimal (tanpa React/Tailwind) untuk program `mini_amm_native`.
 *
 * Alur: hubungkan wallet → isi form + unggah logo → launch (mint Token-2022 +
 * pool 81 byte) → beli/swap. Semua aritmetika swap dihitung dengan rumus yang
 * sama seperti on-chain; nominal keluar tetap ditentukan program.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  CustomDefiSDK,
  DEFAULT_TOKEN_DECIMALS,
  TOKEN_2022_PROGRAM_ID,
  calculateToken2022MintTotalBytes,
} from './sdk/customSdk';
import * as amm from './sdk/nativePool';

// ---------------------------------------------------------------------------
// Tipe provider wallet (Phantom & wallet standar lainnya)
// ---------------------------------------------------------------------------

interface SolanaProvider {
  publicKey: PublicKey | null;
  isConnected: boolean | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
}

declare global {
  interface Window {
    solana?: SolanaProvider;
    phantom?: { solana?: SolanaProvider };
  }
}

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`elemen #${id} tidak ada`);
  return element as T;
};

const logLines: string[] = [];
function log(message: string): void {
  const stamp = new Date().toLocaleTimeString('id-ID');
  logLines.push(`[${stamp}] ${message}`);
  $('log').textContent = logLines.slice(-200).join('\n');
}

function setStatus(message: string, kind: 'idle' | 'ok' | 'error' = 'idle'): void {
  const element = $('status');
  element.textContent = message;
  element.className = `status${kind === 'idle' ? '' : ` ${kind}`}`;
}

const RPC_BY_CLUSTER: Record<string, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

const lamportsToSol = (lamports: number | bigint): string =>
  (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state: {
  connection: Connection;
  provider: SolanaProvider | null;
  wallet: PublicKey | null;
  programId: PublicKey;
  tokenMint: PublicKey | null;
  tokenProgramId: PublicKey;
  imageUri: string;
  metadataUri: string;
} = {
  connection: new Connection(RPC_BY_CLUSTER.devnet, 'confirmed'),
  provider: null,
  wallet: null,
  programId: amm.DEFAULT_NATIVE_PROGRAM_ID,
  tokenMint: null,
  tokenProgramId: TOKEN_2022_PROGRAM_ID,
  imageUri: '',
  metadataUri: '',
};

// ---------------------------------------------------------------------------
// Wallet & jaringan
// ---------------------------------------------------------------------------

function pickProvider(): SolanaProvider {
  const provider = window.phantom?.solana ?? window.solana;
  if (!provider) {
    throw new Error('Wallet Solana tidak terdeteksi. Pasang Phantom/Solflare lalu muat ulang.');
  }
  return provider;
}

async function connectWallet(): Promise<void> {
  setStatus('Menghubungkan wallet…');
  const provider = pickProvider();
  const { publicKey } = await provider.connect();
  state.provider = provider;
  state.wallet = publicKey;
  $('wallet').textContent = `${publicKey.toBase58().slice(0, 4)}…${publicKey
    .toBase58()
    .slice(-4)}`;
  await refreshBalance();
  setStatus('Wallet terhubung.', 'ok');
  log(`wallet: ${publicKey.toBase58()}`);
}

async function refreshBalance(): Promise<void> {
  if (!state.wallet) return;
  const lamports = await state.connection.getBalance(state.wallet, 'confirmed');
  $('balance').textContent = `${lamportsToSol(lamports)} SOL`;
}

function applyCluster(): void {
  const cluster = ($('cluster') as HTMLSelectElement).value;
  const customRpc = ($('rpc') as HTMLInputElement).value.trim();
  const endpoint = customRpc || RPC_BY_CLUSTER[cluster] || RPC_BY_CLUSTER.devnet;
  state.connection = new Connection(endpoint, 'confirmed');
  log(`RPC: ${endpoint}`);
  void refreshBalance();
}

// ---------------------------------------------------------------------------
// Kirim transaksi
// ---------------------------------------------------------------------------

async function sendTransaction(tx: Transaction, extraSigners: Keypair[] = []): Promise<string> {
  const { connection, provider, wallet } = state;
  if (!provider || !wallet) throw new Error('Wallet belum terhubung');

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = wallet;
  tx.recentBlockhash = blockhash;
  if (extraSigners.length > 0) tx.partialSign(...extraSigners);

  const { signature } = await provider.signAndSendTransaction(tx);
  log(`kirim: ${signature}`);
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );
  if (confirmation.value.err) {
    throw new Error(`transaksi gagal: ${JSON.stringify(confirmation.value.err)}`);
  }
  await refreshBalance();
  return signature;
}

// ---------------------------------------------------------------------------
// Upload logo (Pinata dev API — JSON + base64)
// ---------------------------------------------------------------------------

async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Gagal membaca file'));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function uploadLogo(): Promise<void> {
  const file = ($('logo') as HTMLInputElement).files?.[0];
  if (!file) {
    setStatus('Pilih file logo dulu.', 'error');
    return;
  }
  setStatus('Mengunggah ke IPFS…');
  const base64 = await fileToBase64(file);
  const response = await fetch('/api/pinata/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      base64,
      name: ($('name') as HTMLInputElement).value.trim(),
      symbol: ($('symbol') as HTMLInputElement).value.trim().toUpperCase(),
      description: ($('description') as HTMLTextAreaElement).value.trim(),
      telegram: ($('telegram') as HTMLInputElement).value.trim() || undefined,
      twitter: ($('twitter') as HTMLInputElement).value.trim() || undefined,
    }),
  });
  const data = (await response.json()) as {
    imageUri?: string;
    metadataUri?: string;
    error?: string;
    detail?: string;
  };
  if (!response.ok || !data.imageUri || !data.metadataUri) {
    throw new Error(data.detail ?? data.error ?? `HTTP ${response.status}`);
  }
  state.imageUri = data.imageUri;
  state.metadataUri = data.metadataUri;
  $('ipfs').textContent = `logo: ${data.imageUri} · metadata: ${data.metadataUri}`;
  setStatus('Logo & metadata tersimpan di IPFS.', 'ok');
  log(`IPFS: ${data.imageUri}`);
  updateCosts();
}

// ---------------------------------------------------------------------------
// Launch: mint Token-2022 + pool native (state 81 B)
// ---------------------------------------------------------------------------

async function launch(): Promise<void> {
  if (!state.wallet) throw new Error('Hubungkan wallet dulu');
  const payer = state.wallet;

  const name = ($('name') as HTMLInputElement).value.trim();
  const symbol = ($('symbol') as HTMLInputElement).value.trim().toUpperCase();
  if (!name || !symbol) throw new Error('Nama dan simbol wajib diisi');
  if (!state.imageUri) throw new Error('Unggah logo dulu (tombol "Unggah logo ke IPFS")');

  const supply = amm.parseTokenAmount(($('supply') as HTMLInputElement).value, DEFAULT_TOKEN_DECIMALS);
  const poolTokens = amm.parseTokenAmount(
    ($('poolTokens') as HTMLInputElement).value,
    DEFAULT_TOKEN_DECIMALS
  );
  if (poolTokens > supply) throw new Error('Token untuk pool melebihi total supply');
  const virtualSol = amm.parseTokenAmount(($('virtualSol') as HTMLInputElement).value, 9);

  const sdk = new CustomDefiSDK(state.connection, state.programId);

  setStatus('Membuat mint Token-2022…');
  const token = await sdk.buildCloneTokenInstructions({
    payer,
    name,
    symbol,
    imageUri: state.imageUri,
    metadataUri: state.metadataUri,
    telegram: ($('telegram') as HTMLInputElement).value.trim() || undefined,
    twitter: ($('twitter') as HTMLInputElement).value.trim() || undefined,
    initialSupplyRaw: supply,
    tokenStandard: 'TOKEN_2022',
  });

  const mintTx = new Transaction().add(...token.instructions);
  await sendTransaction(mintTx, [token.mintKeypair]);
  log(`mint: ${token.mint.toBase58()}`);
  state.tokenMint = token.mint;
  state.tokenProgramId = token.tokenProgramId;

  setStatus('Membuat pool + menyetor token…');
  const pool = amm.buildInitializePool({
    payer,
    mintX: amm.NATIVE_SOL_MINT,
    mintY: token.mint,
    tokenProgramX: amm.TOKEN_PROGRAM_ID,
    tokenProgramY: token.tokenProgramId,
    virtualReservesX: virtualSol,
    programId: state.programId,
  });

  const fundIx = amm.buildFundPool({
    creator: payer,
    mintX: amm.NATIVE_SOL_MINT,
    mintY: token.mint,
    tokenProgramY: token.tokenProgramId,
    amount: poolTokens,
    programId: state.programId,
  });

  const poolTx = new Transaction().add(...pool.ataInstructions, pool.instruction, fundIx);
  await sendTransaction(poolTx);
  log(`pool: ${pool.poolState.toBase58()}`);

  setStatus('Token + pool selesai dibuat.', 'ok');
  ($('buy') as HTMLButtonElement).disabled = false;
  await refreshPool();
  void refreshQuote();
}

// ---------------------------------------------------------------------------
// Pool info & beli
// ---------------------------------------------------------------------------

async function refreshPool(): Promise<void> {
  if (!state.tokenMint) {
    $('poolInfo').textContent = 'Pool belum dibuat.';
    return;
  }
  const { poolState } = amm.derivePoolState(amm.NATIVE_SOL_MINT, state.tokenMint, state.programId);
  const snapshot = await amm.fetchPoolSnapshot(state.connection, poolState);
  if (!snapshot) {
    $('poolInfo').textContent = `Pool ${poolState.toBase58()} belum ada on-chain.`;
    return;
  }
  const reserveX = snapshot.reserveX + snapshot.virtualReservesX;
  const reserveY = snapshot.reserveY;
  const price = reserveY > 0n && reserveX > 0n ? reserveX * 1_000_000_000n / reserveY : 0n;
  $('poolInfo').innerHTML = [
    `pool      : ${snapshot.poolState.toBase58()}`,
    `vault SOL : ${lamportsToSol(snapshot.reserveX)} SOL (+ virtual ${lamportsToSol(
      snapshot.virtualReservesX
    )} SOL)`,
    `vault token: ${amm.formatTokenAmount(snapshot.reserveY, DEFAULT_TOKEN_DECIMALS)}`,
    `harga awal : ± ${lamportsToSol(price)} SOL per token`,
  ].join('\n');
  if (reserveX > 0n && reserveY > 0n) {
    ($('buy') as HTMLButtonElement).disabled = false;
    void refreshQuote();
  }
}

async function refreshQuote(): Promise<void> {
  if (!state.tokenMint) return;
  const { poolState } = amm.derivePoolState(amm.NATIVE_SOL_MINT, state.tokenMint, state.programId);
  const snapshot = await amm.fetchPoolSnapshot(state.connection, poolState);
  if (!snapshot) return;
  try {
    const amountIn = amm.parseTokenAmount(($('buyAmount') as HTMLInputElement).value || '0', 9);
    if (amountIn <= 0n) return;
    const quote = amm.computeSwapOut(
      amountIn,
      snapshot.reserveX + snapshot.virtualReservesX,
      snapshot.reserveY
    );
    $('quote').textContent = `≈ ${amm.formatTokenAmount(
      quote.amountOut,
      DEFAULT_TOKEN_DECIMALS
    )} token (fee creator ${amm.formatTokenAmount(quote.creatorFee, 9)} SOL)`;
  } catch (error) {
    $('quote').textContent = error instanceof Error ? error.message : String(error);
  }
}

async function buy(): Promise<void> {
  if (!state.wallet || !state.tokenMint) throw new Error('Belum ada pool');
  const user = state.wallet;
  const amountIn = amm.parseTokenAmount(($('buyAmount') as HTMLInputElement).value, 9);
  if (amountIn <= 0n) throw new Error('Jumlah SOL tidak valid');

  const { poolState } = amm.derivePoolState(amm.NATIVE_SOL_MINT, state.tokenMint, state.programId);
  const snapshot = await amm.fetchPoolSnapshot(state.connection, poolState);
  if (!snapshot) throw new Error('Pool tidak ditemukan on-chain');

  const quote = amm.computeSwapOut(
    amountIn,
    snapshot.reserveX + snapshot.virtualReservesX,
    snapshot.reserveY
  );
  const minAmountOut = (quote.amountOut * 99n) / 100n;

  const wsolAta = amm.deriveAssociatedTokenAddress(user, amm.NATIVE_SOL_MINT, amm.TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(
    amm.buildCreateAtaIdempotent(user, user, amm.NATIVE_SOL_MINT, amm.TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: wsolAta, lamports: Number(amountIn) }),
    amm.buildSyncNative(wsolAta),
    amm.buildCreateAtaIdempotent(user, user, state.tokenMint, state.tokenProgramId),
    amm.buildSwap({
      user,
      mintX: amm.NATIVE_SOL_MINT,
      mintY: state.tokenMint,
      tokenProgramX: amm.TOKEN_PROGRAM_ID,
      tokenProgramY: state.tokenProgramId,
      amountIn,
      minAmountOut,
      xToY: true,
      programId: state.programId,
    })
  );

  setStatus('Membeli token…');
  await sendTransaction(tx);
  setStatus(`Beli selesai. ≈ ${amm.formatTokenAmount(quote.amountOut, DEFAULT_TOKEN_DECIMALS)} token.`, 'ok');
  await refreshPool();
}

// ---------------------------------------------------------------------------
// Estimasi biaya
// ---------------------------------------------------------------------------

function updateCosts(): void {
  const soKb = Number(($('soSize') as HTMLInputElement).value.replace(',', '.')) || 0;
  const programBytes = Math.round(soKb * 1024);

  const uri = state.metadataUri || 'https://gateway.pinata.cloud/ipfs/xxxxxxxxxxxxxxxxxxxx';
  const mintBytes = calculateToken2022MintTotalBytes({
    name: ($('name') as HTMLInputElement).value.trim() || 'Token',
    symbol: ($('symbol') as HTMLInputElement).value.trim().toUpperCase() || 'TKN',
    uri,
    additionalMetadata: [],
  });

  const deploy = amm.rentExemptLamports(programBytes + 45) + amm.rentExemptLamports(36);
  const mint = amm.rentExemptLamports(mintBytes);
  const pool = amm.rentExemptLamports(amm.POOL_STATE_LEN) + 4 * amm.rentExemptLamports(165);
  const ata = 2 * amm.rentExemptLamports(165);
  const fees = 5 * 5000;
  const total = deploy + mint + pool + ata + fees;

  $('costDeploy').textContent = `${lamportsToSol(deploy)} SOL (${soKb} KB)`;
  $('costMint').textContent = `${lamportsToSol(mint)} SOL (${mintBytes} B)`;
  $('costPool').textContent = `${lamportsToSol(pool)} SOL`;
  $('costAta').textContent = `${lamportsToSol(ata)} SOL`;
  $('costFee').textContent = `${lamportsToSol(fees)} SOL`;
  $('costTotal').textContent = `${lamportsToSol(total)} SOL`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire(): void {
  $('connect').addEventListener('click', () => {
    void connectWallet().catch((error: unknown) =>
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    );
  });

  $('cluster').addEventListener('change', applyCluster);
  $('rpc').addEventListener('change', applyCluster);

  $('upload').addEventListener('click', () => {
    void uploadLogo().catch((error: unknown) =>
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    );
  });

  $('launch').addEventListener('click', () => {
    const button = $('launch') as HTMLButtonElement;
    button.disabled = true;
    void launch()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(message, 'error');
        log(`ERROR: ${message}`);
      })
      .finally(() => {
        button.disabled = false;
      });
  });

  $('buy').addEventListener('click', () => {
    void buy().catch((error: unknown) =>
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    );
  });

  $('buyAmount').addEventListener('input', () => void refreshQuote());

  for (const id of ['soSize', 'name', 'symbol']) {
    $(id).addEventListener('input', updateCosts);
  }

  const envProgramId = (import.meta.env as { VITE_NATIVE_PROGRAM_ID?: string })
    ?.VITE_NATIVE_PROGRAM_ID;
  if (envProgramId) {
    state.programId = new PublicKey(envProgramId.trim());
  }
  const envRpc = (import.meta.env as { VITE_RPC_URL?: string })?.VITE_RPC_URL;
  if (envRpc) {
    ($('rpc') as HTMLInputElement).value = envRpc;
    applyCluster();
  }

  updateCosts();
  log(`program: ${state.programId.toBase58()}`);
  log(`RPC awal: ${state.connection.rpcEndpoint}`);
}

wire();
