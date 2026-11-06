import React, { useMemo, useState } from 'react';
import {
  AccountInfo,
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  CustomDefiSDK,
  DEFAULT_AMM_PROGRAM_ID,
  DEFAULT_TOKEN_DECIMALS,
  DeserializedPoolInfo,
  NATIVE_SOL_MINT,
  POOL_STATE_DISCRIMINATOR,
  POOL_STATE_SIZE,
  PoolStateLayout,
  SPL_MINT_ACCOUNT_LAYOUT,
  SPL_MINT_SIZE,
  SPL_TOKEN_ACCOUNT_LAYOUT,
  SPL_TOKEN_ACCOUNT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenStandardMode,
  calculateSwapOutput,
  formatTokenAmount,
  parseTokenAmount,
} from './sdk/customSdk';

interface InjectedSolanaProvider {
  isPhantom?: boolean;
  publicKey?: PublicKey;
  connect: () => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

declare global {
  interface Window {
    solana?: InjectedSolanaProvider;
  }
}

type LaunchStage =
  | 'IDLE'
  | 'MINTING_TOKEN'
  | 'INITIALIZING_POOL'
  | 'INITIAL_SWAP'
  | 'FETCHING_POOL'
  | 'SWAPPING'
  | 'SUCCESS'
  | 'ERROR';

interface PipelineStepLog {
  step: number;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
}

interface BinaryTelemetry {
  mintAddress: string;
  tokenStandard: TokenStandardMode;
  tokenProgramY: string;
  allocatedMintBytes: number;
  additionalMetadata: [string, string][];
  createPoolIxHex: string;
  lastSwapIxHex?: string;
  cloneIxCount: number;
}

const DEVNET_RPC_ENDPOINT = 'https://api.devnet.solana.com';

class SandboxBinaryConnection extends Connection {
  private readonly accounts = new Map<string, AccountInfo<Buffer>>();

  constructor() {
    super(DEVNET_RPC_ENDPOINT, 'confirmed');
  }

  public writeRawAccount(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    this.accounts.set(pubkey.toBase58(), info);
  }

  public override async getMinimumBalanceForRentExemption(
    dataLength: number
  ): Promise<number> {
    return (128 + dataLength) * 6960;
  }

  public override async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    return {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 320_000_000,
    };
  }

  public override async getAccountInfo(
    publicKey: PublicKey,
    _commitmentOrConfig?: Commitment
  ): Promise<AccountInfo<Buffer> | null> {
    return this.accounts.get(publicKey.toBase58()) ?? null;
  }

  public override async getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    _commitmentOrConfig?: Commitment
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    return publicKeys.map((pk) => this.accounts.get(pk.toBase58()) ?? null);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const shortenAddress = (addr: string, chars = 6): string =>
  addr.length <= chars * 2 + 3
    ? addr
    : `${addr.slice(0, chars)}...${addr.slice(-chars)}`;

export default function App(): React.ReactElement {
  // Cluster & Wallet State
  const [executionMode, setExecutionMode] = useState<'SANDBOX' | 'DEVNET'>(
    'SANDBOX'
  );
  const [walletPubkey, setWalletPubkey] = useState<PublicKey | null>(null);
  const [walletType, setWalletType] = useState<'INJECTED' | 'EPHEMERAL' | null>(
    null
  );
  const [ephemeralKeypair] = useState<Keypair>(() => Keypair.generate());

  // Unified Token-2022 + Virtual Liquidity Form State
  const [tokenStandard, setTokenStandard] =
    useState<TokenStandardMode>('TOKEN_2022');
  const [tokenName, setTokenName] = useState<string>('Nusantara Token 2022');
  const [ticker, setTicker] = useState<string>('NUSA');
  const [imageUri, setImageUri] = useState<string>(
    'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
  );
  const [telegram, setTelegram] = useState<string>('https://t.me/nusa_2022');
  const [twitter, setTwitter] = useState<string>('https://x.com/nusa_2022');
  const [totalSupply, setTotalSupply] = useState<string>('1000000000');
  const [virtualSolLiquidity, setVirtualSolLiquidity] = useState<string>('30');
  const [initialBuySol, setInitialBuySol] = useState<string>('0');

  // Execution & Deserialized Pool State
  const [stage, setStage] = useState<LaunchStage>('IDLE');
  const [statusBanner, setStatusBanner] = useState<string>(
    'Siap — Luncurkan Token-2022 (MetadataPointer + On-Chain Socials) & Virtual Liquidity AMM'
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [steps, setSteps] = useState<PipelineStepLog[]>([
    {
      step: 1,
      label: 'Clone Token-2022 + Native MetadataPointer & On-Chain Fields',
      status: 'pending',
    },
    {
      step: 2,
      label: 'Initialize Virtual Liquidity Pool (transfer_checked 100% Supply)',
      status: 'pending',
    },
    {
      step: 3,
      label: 'Initial SOL Swap (Opsional pada Detik ke-0)',
      status: 'pending',
    },
    {
      step: 4,
      label: 'Fetch & Unpack 185-Byte PoolState + Token-2022 Vaults',
      status: 'pending',
    },
  ]);

  const [poolInfo, setPoolInfo] = useState<DeserializedPoolInfo | null>(null);
  const [userTokenBalanceRaw, setUserTokenBalanceRaw] = useState<bigint>(0n);
  const [telemetry, setTelemetry] = useState<BinaryTelemetry | null>(null);

  // Interactive Swap Terminal State
  const [tradeSide, setTradeSide] = useState<'BUY' | 'SELL'>('BUY');
  const [tradeAmountInput, setTradeAmountInput] = useState<string>('5');

  const sandboxConnection = useMemo(() => new SandboxBinaryConnection(), []);
  const devnetConnection = useMemo(
    () => new Connection(DEVNET_RPC_ENDPOINT, 'confirmed'),
    []
  );

  const handleConnectWallet = async (preferInjected: boolean): Promise<void> => {
    setErrorMessage(null);
    if (preferInjected && window.solana) {
      try {
        const res = await window.solana.connect();
        setWalletPubkey(res.publicKey);
        setWalletType('INJECTED');
        setStatusBanner(
          `Wallet Terhubung (${shortenAddress(res.publicKey.toBase58())})`
        );
        return;
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Gagal menghubungkan wallet'
        );
        return;
      }
    }

    setWalletPubkey(ephemeralKeypair.publicKey);
    setWalletType('EPHEMERAL');
    setStatusBanner(
      `Mock Keypair Terhubung (${shortenAddress(ephemeralKeypair.publicKey.toBase58())})`
    );
  };

  const handleDisconnectWallet = async (): Promise<void> => {
    if (walletType === 'INJECTED' && window.solana) {
      await window.solana.disconnect().catch(() => undefined);
    }
    setWalletPubkey(null);
    setWalletType(null);
    setStatusBanner('Wallet terputus');
  };

  const updateStep = (
    stepNum: number,
    patch: Partial<PipelineStepLog>
  ): void => {
    setSteps((prev) =>
      prev.map((item) =>
        item.step === stepNum ? { ...item, ...patch } : item
      )
    );
  };

  const signAndDispatch = async (
    tx: Transaction,
    extraSigners: Keypair[],
    conn: Connection
  ): Promise<{ signature: string; byteLength: number }> => {
    if (extraSigners.length > 0) {
      tx.partialSign(...extraSigners);
    }
    if (walletType === 'EPHEMERAL' || !walletType) {
      tx.partialSign(ephemeralKeypair);
    } else if (walletType === 'INJECTED' && window.solana) {
      tx = await window.solana.signTransaction(tx);
    }

    const rawTx = tx.serialize();
    if (executionMode === 'SANDBOX') {
      await sleep(300);
      const sig =
        Keypair.generate().publicKey.toBase58() +
        Keypair.generate().publicKey.toBase58().slice(0, 40);
      return { signature: sig, byteLength: rawTx.byteLength };
    }

    const signature = await conn.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    const latest = await conn.getLatestBlockhash('confirmed');
    await conn.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed'
    );
    return { signature, byteLength: rawTx.byteLength };
  };

  /**
   * Menulis akun biner `PoolState` (185B), `vault_x` (165B SPL), `vault_y` (165B Token-2022),
   * dan `lp_mint` (82B Token-2022) ke Sandbox Ledger agar `fetchPoolInfo()` menjalankan
   * jalur deserialisasi `PoolStateLayout.decode()` yang sesungguhnya.
   */
  const commitSandboxState = (params: {
    poolAddress: PublicKey;
    tokenX: PublicKey;
    tokenY: PublicKey;
    vaultX: PublicKey;
    vaultY: PublicKey;
    lpMint: PublicKey;
    tokenProgramY: PublicKey;
    realX: bigint;
    realY: bigint;
    virtualX: bigint;
    virtualY: bigint;
    lpSupply: bigint;
    bump: number;
  }): void => {
    const poolBuf = Buffer.alloc(POOL_STATE_SIZE);
    PoolStateLayout.encode(
      {
        discriminator: POOL_STATE_DISCRIMINATOR,
        tokenX: params.tokenX,
        tokenY: params.tokenY,
        vaultX: params.vaultX,
        vaultY: params.vaultY,
        lpMint: params.lpMint,
        virtualReservesX: params.virtualX,
        virtualReservesY: params.virtualY,
        bump: params.bump,
      },
      poolBuf
    );
    sandboxConnection.writeRawAccount(params.poolAddress, {
      data: poolBuf,
      executable: false,
      lamports: 2_150_000,
      owner: DEFAULT_AMM_PROGRAM_ID,
      rentEpoch: 0,
    });

    const vaultXBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
    SPL_TOKEN_ACCOUNT_LAYOUT.encode(
      {
        mint: params.tokenX,
        owner: params.poolAddress,
        amount: params.realX,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 1,
        isNative: 2_039_280n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      vaultXBuf
    );
    sandboxConnection.writeRawAccount(params.vaultX, {
      data: vaultXBuf,
      executable: false,
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM_ID,
      rentEpoch: 0,
    });

    const vaultYBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
    SPL_TOKEN_ACCOUNT_LAYOUT.encode(
      {
        mint: params.tokenY,
        owner: params.poolAddress,
        amount: params.realY,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      vaultYBuf
    );
    sandboxConnection.writeRawAccount(params.vaultY, {
      data: vaultYBuf,
      executable: false,
      lamports: 2_039_280,
      owner: params.tokenProgramY,
      rentEpoch: 0,
    });

    const lpMintBuf = Buffer.alloc(SPL_MINT_SIZE);
    SPL_MINT_ACCOUNT_LAYOUT.encode(
      {
        mintAuthorityOption: 1,
        mintAuthority: params.poolAddress,
        supply: params.lpSupply,
        decimals: DEFAULT_TOKEN_DECIMALS,
        isInitialized: 1,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      lpMintBuf
    );
    sandboxConnection.writeRawAccount(params.lpMint, {
      data: lpMintBuf,
      executable: false,
      lamports: 1_461_600,
      owner: TOKEN_2022_PROGRAM_ID,
      rentEpoch: 0,
    });
  };

  /**
   * Pipeline Utama: Clone Token-2022 -> Initialize Virtual Liquidity Pool -> Optional Buy -> Fetch Pool Info
   */
  const handleLaunchPlatform = async (
    e: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    e.preventDefault();
    setErrorMessage(null);

    const activePayer = walletPubkey ?? ephemeralKeypair.publicKey;
    if (!walletPubkey) {
      setWalletPubkey(ephemeralKeypair.publicKey);
      setWalletType('EPHEMERAL');
    }

    setPoolInfo(null);
    setUserTokenBalanceRaw(0n);
    setTelemetry(null);
    setSteps([
      {
        step: 1,
        label:
          tokenStandard === 'TOKEN_2022'
            ? 'Clone Token-2022 + MetadataPointer & On-Chain Socials'
            : 'Clone SPL Legacy + Metaplex Metadata V3',
        status: 'pending',
      },
      {
        step: 2,
        label: 'Initialize Virtual Liquidity Pool (transfer_checked)',
        status: 'pending',
      },
      {
        step: 3,
        label: 'Initial SOL Swap (Opsional pada Detik ke-0)',
        status: 'pending',
      },
      {
        step: 4,
        label: 'Fetch & Unpack 185-Byte PoolState + Vaults',
        status: 'pending',
      },
    ]);

    const activeConnection =
      executionMode === 'SANDBOX' ? sandboxConnection : devnetConnection;
    const sdk = new CustomDefiSDK(activeConnection, DEFAULT_AMM_PROGRAM_ID);

    try {
      const supplyRaw = parseTokenAmount(totalSupply, DEFAULT_TOKEN_DECIMALS);
      const virtualSolRaw = parseTokenAmount(
        virtualSolLiquidity,
        DEFAULT_TOKEN_DECIMALS
      );
      const firstBuySolRaw = parseTokenAmount(
        initialBuySol || '0',
        DEFAULT_TOKEN_DECIMALS
      );

      if (supplyRaw <= 0n || virtualSolRaw <= 0n) {
        throw new Error(
          'Total Supply dan Virtual SOL Liquidity harus lebih besar dari 0'
        );
      }

      // ----------------------------------------------------------------------
      // STEP 1: Clone Token-2022 (MetadataPointer + TokenMetadata + UpdateField)
      // ----------------------------------------------------------------------
      setStage('MINTING_TOKEN');
      setStatusBanner(
        tokenStandard === 'TOKEN_2022'
          ? 'Minting Token-2022 + Menyimpan Nama, Simbol, URI & Sosial On-Chain...'
          : 'Minting SPL Token + Metaplex Metadata V3...'
      );
      updateStep(1, {
        status: 'active',
        detail: 'Menyusun instruksi biner alokasi Mint, Metadata & MintToChecked...',
      });

      const cloneResult = await sdk.buildCloneTokenInstructions({
        payer: activePayer,
        name: tokenName,
        symbol: ticker,
        imageUri,
        telegram,
        twitter,
        decimals: DEFAULT_TOKEN_DECIMALS,
        initialSupplyRaw: supplyRaw,
        tokenStandard,
      });

      const cloneTx = new Transaction().add(...cloneResult.instructions);
      cloneTx.feePayer = activePayer;
      cloneTx.recentBlockhash = (
        await activeConnection.getLatestBlockhash('confirmed')
      ).blockhash;

      await signAndDispatch(
        cloneTx,
        [cloneResult.mintKeypair],
        activeConnection
      );

      updateStep(1, {
        status: 'done',
        detail: `Mint ${shortenAddress(cloneResult.mint.toBase58())} (${cloneResult.allocatedMintBytes}B Mint, ${cloneResult.instructions.length} raw ixs)`,
      });

      // ----------------------------------------------------------------------
      // STEP 2: Initialize Virtual Pool (`initialize_pool` — Discriminator 0)
      // ----------------------------------------------------------------------
      setStage('INITIALIZING_POOL');
      setStatusBanner(
        'Initializing Hybrid Token-2022 Virtual Liquidity Pool (0 Real SOL)...'
      );
      updateStep(2, {
        status: 'active',
        detail: 'Serialisasi 17B BufferLayout + transfer_checked 100% suplai ke vault_y...',
      });

      const createPoolResult = await sdk.buildCreatePoolTx({
        payer: activePayer,
        tokenX: NATIVE_SOL_MINT,
        tokenY: cloneResult.mint,
        initialRealTokenY: supplyRaw,
        virtualReservesX: virtualSolRaw,
        tokenProgramX: TOKEN_PROGRAM_ID,
        tokenProgramY: cloneResult.tokenProgramId,
        tokenProgramLp: TOKEN_2022_PROGRAM_ID,
      });

      await signAndDispatch(createPoolResult.transaction, [], activeConnection);

      let realX = 0n;
      let realY = supplyRaw;
      let lastSwapHex: string | undefined;

      if (executionMode === 'SANDBOX') {
        commitSandboxState({
          poolAddress: createPoolResult.addresses.poolState,
          tokenX: NATIVE_SOL_MINT,
          tokenY: cloneResult.mint,
          vaultX: createPoolResult.addresses.vaultX,
          vaultY: createPoolResult.addresses.vaultY,
          lpMint: createPoolResult.addresses.lpMint,
          tokenProgramY: cloneResult.tokenProgramId,
          realX,
          realY,
          virtualX: virtualSolRaw,
          virtualY: supplyRaw,
          lpSupply: createPoolResult.expectedInitialLp,
          bump: createPoolResult.addresses.poolBump,
        });
      }

      updateStep(2, {
        status: 'done',
        detail: `Pool ${shortenAddress(createPoolResult.addresses.poolState.toBase58())} | LP Awal: ${formatTokenAmount(createPoolResult.expectedInitialLp, 9, 2)}`,
      });

      // ----------------------------------------------------------------------
      // STEP 3: Optional First Swap (`swap` — Discriminator 2)
      // ----------------------------------------------------------------------
      if (firstBuySolRaw > 0n) {
        setStage('INITIAL_SWAP');
        setStatusBanner('Mengeksekusi Pembelian Awal via Token-2022 transfer_checked...');
        updateStep(3, {
          status: 'active',
          detail: `Membeli dengan ${formatTokenAmount(firstBuySolRaw)} SOL...`,
        });

        const totalX = realX + virtualSolRaw;
        const totalY = realY + supplyRaw;
        const expectedOut = calculateSwapOutput(firstBuySolRaw, totalX, totalY);

        const swapBuild = await sdk.buildSwapTx({
          user: activePayer,
          tokenX: NATIVE_SOL_MINT,
          tokenY: cloneResult.mint,
          amountIn: firstBuySolRaw,
          minAmountOut: expectedOut,
          xToY: true,
          tokenProgramX: TOKEN_PROGRAM_ID,
          tokenProgramY: cloneResult.tokenProgramId,
        });

        await signAndDispatch(swapBuild.transaction, [], activeConnection);
        lastSwapHex = swapBuild.serializedIxData.toString('hex');

        realX += firstBuySolRaw;
        realY -= expectedOut;
        setUserTokenBalanceRaw(expectedOut);

        if (executionMode === 'SANDBOX') {
          commitSandboxState({
            poolAddress: createPoolResult.addresses.poolState,
            tokenX: NATIVE_SOL_MINT,
            tokenY: cloneResult.mint,
            vaultX: createPoolResult.addresses.vaultX,
            vaultY: createPoolResult.addresses.vaultY,
            lpMint: createPoolResult.addresses.lpMint,
            tokenProgramY: cloneResult.tokenProgramId,
            realX,
            realY,
            virtualX: virtualSolRaw,
            virtualY: supplyRaw,
            lpSupply: createPoolResult.expectedInitialLp,
            bump: createPoolResult.addresses.poolBump,
          });
        }

        updateStep(3, {
          status: 'done',
          detail: `Diterima ${formatTokenAmount(expectedOut, 9, 2)} ${ticker.toUpperCase()}`,
        });
      } else {
        updateStep(3, {
          status: 'done',
          detail: 'Dilewati (0 SOL Modal Riil Awal)',
        });
      }

      // ----------------------------------------------------------------------
      // STEP 4: Fetch & Unpack 185-Byte PoolState + Vault Reserves
      // ----------------------------------------------------------------------
      setStage('FETCHING_POOL');
      setStatusBanner('Membaca & Deserialisasi PoolState + Token-2022 Vaults...');
      updateStep(4, {
        status: 'active',
        detail: 'Unpacking 185B PoolStateLayout + 165B Vaults...',
      });

      await sleep(200);
      const unpacked = await sdk.fetchPoolInfo(
        NATIVE_SOL_MINT,
        cloneResult.mint
      );

      setTelemetry({
        mintAddress: cloneResult.mint.toBase58(),
        tokenStandard: cloneResult.tokenStandard,
        tokenProgramY: cloneResult.tokenProgramId.toBase58(),
        allocatedMintBytes: cloneResult.allocatedMintBytes,
        additionalMetadata: cloneResult.additionalMetadata,
        createPoolIxHex: createPoolResult.serializedIxData.toString('hex'),
        lastSwapIxHex: lastSwapHex,
        cloneIxCount: cloneResult.instructions.length,
      });

      setPoolInfo(unpacked);
      updateStep(4, {
        status: 'done',
        detail: `185B PoolState Terbaca | Total Efektif X: ${formatTokenAmount(unpacked.totalReservesX, 9, 2)} SOL`,
      });

      setStage('SUCCESS');
      setStatusBanner(
        `Success! $${ticker.trim().toUpperCase()} (${cloneResult.tokenStandard}) aktif di Virtual Liquidity AMM`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaksi gagal';
      setStage('ERROR');
      setErrorMessage(msg);
      setStatusBanner(`Pipeline terhenti: ${msg}`);
      setSteps((prev) =>
        prev.map((item) =>
          item.status === 'active'
            ? { ...item, status: 'error', detail: msg }
            : item
        )
      );
    }
  };

  // Estimasi Swap Real-time (`total_reserve = vault.amount + virtual_reserves`)
  const swapQuote = useMemo(() => {
    if (!poolInfo) return null;
    try {
      const amountInRaw = parseTokenAmount(
        tradeAmountInput,
        DEFAULT_TOKEN_DECIMALS
      );
      if (amountInRaw <= 0n) return null;

      const isBuy = tradeSide === 'BUY';
      const reserveIn = isBuy
        ? poolInfo.totalReservesX
        : poolInfo.totalReservesY;
      const reserveOut = isBuy
        ? poolInfo.totalReservesY
        : poolInfo.totalReservesX;

      const amountOut = calculateSwapOutput(amountInRaw, reserveIn, reserveOut);
      const vaultAvailable = isBuy
        ? poolInfo.realReservesY
        : poolInfo.realReservesX;
      if (amountOut > vaultAvailable) {
        return null;
      }

      return {
        amountInRaw,
        amountOut,
        feeRaw: (amountInRaw * 3n) / 1000n,
      };
    } catch {
      return null;
    }
  }, [poolInfo, tradeAmountInput, tradeSide]);

  const handleExecuteSwap = async (): Promise<void> => {
    if (!poolInfo || !swapQuote) return;
    setErrorMessage(null);

    const activeUser = walletPubkey ?? ephemeralKeypair.publicKey;
    const activeConnection =
      executionMode === 'SANDBOX' ? sandboxConnection : devnetConnection;
    const sdk = new CustomDefiSDK(activeConnection, DEFAULT_AMM_PROGRAM_ID);

    try {
      if (
        tradeSide === 'SELL' &&
        executionMode === 'SANDBOX' &&
        swapQuote.amountInRaw > userTokenBalanceRaw
      ) {
        throw new Error(
          `Saldo ${ticker.toUpperCase()} Anda (${formatTokenAmount(userTokenBalanceRaw, 9, 2)}) tidak mencukupi`
        );
      }

      setStage('SWAPPING');
      const isBuy = tradeSide === 'BUY';
      setStatusBanner(
        isBuy
          ? `Swap ${tradeAmountInput} SOL -> $${ticker.toUpperCase()} (Token-2022 transfer_checked)...`
          : `Swap ${tradeAmountInput} $${ticker.toUpperCase()} -> SOL (Token-2022 transfer_checked)...`
      );

      const swapBuild = await sdk.buildSwapTx({
        user: activeUser,
        tokenX: poolInfo.tokenX,
        tokenY: poolInfo.tokenY,
        amountIn: swapQuote.amountInRaw,
        minAmountOut: swapQuote.amountOut,
        xToY: isBuy,
        tokenProgramX: poolInfo.tokenProgramX,
        tokenProgramY: poolInfo.tokenProgramY,
      });

      await signAndDispatch(swapBuild.transaction, [], activeConnection);

      if (executionMode === 'SANDBOX') {
        const nextRealX = isBuy
          ? poolInfo.realReservesX + swapQuote.amountInRaw
          : poolInfo.realReservesX - swapQuote.amountOut;
        const nextRealY = isBuy
          ? poolInfo.realReservesY - swapQuote.amountOut
          : poolInfo.realReservesY + swapQuote.amountInRaw;

        commitSandboxState({
          poolAddress: poolInfo.poolAddress,
          tokenX: poolInfo.tokenX,
          tokenY: poolInfo.tokenY,
          vaultX: poolInfo.vaultX,
          vaultY: poolInfo.vaultY,
          lpMint: poolInfo.lpMint,
          tokenProgramY: poolInfo.tokenProgramY,
          realX: nextRealX,
          realY: nextRealY,
          virtualX: poolInfo.virtualReservesX,
          virtualY: poolInfo.virtualReservesY,
          lpSupply: poolInfo.lpSupply,
          bump: poolInfo.bump,
        });

        setUserTokenBalanceRaw((prev) =>
          isBuy ? prev + swapQuote.amountOut : prev - swapQuote.amountInRaw
        );
      }

      const refreshed = await sdk.fetchPoolInfo(poolInfo.poolAddress);
      setPoolInfo(refreshed);
      setTelemetry((prev) =>
        prev
          ? {
              ...prev,
              lastSwapIxHex: swapBuild.serializedIxData.toString('hex'),
            }
          : prev
      );

      setStage('SUCCESS');
      setStatusBanner(
        `Swap Selesai! Vault X (SOL Riil): ${formatTokenAmount(refreshed.realReservesX, 9, 4)} SOL`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Swap gagal';
      setStage('SUCCESS');
      setErrorMessage(msg);
    }
  };

  const isBusy =
    stage === 'MINTING_TOKEN' ||
    stage === 'INITIALIZING_POOL' ||
    stage === 'INITIAL_SWAP' ||
    stage === 'FETCHING_POOL' ||
    stage === 'SWAPPING';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800/90 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 font-mono text-xs font-bold text-emerald-400">
              T22
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-zinc-100">
                Solana Token-2022 Launchpad &amp; Virtual Liquidity AMM
              </h1>
              <p className="font-mono text-xs text-zinc-400">
                Native <code className="text-emerald-400">TokenInterface</code>{' '}
                + <code className="text-cyan-300">transfer_checked</code> &bull;
                Zero External SDKs
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setExecutionMode('SANDBOX')}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  executionMode === 'SANDBOX'
                    ? 'bg-zinc-800 text-emerald-400 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Binary Sandbox
              </button>
              <button
                type="button"
                onClick={() => setExecutionMode('DEVNET')}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  executionMode === 'DEVNET'
                    ? 'bg-zinc-800 text-cyan-400 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Devnet RPC
              </button>
            </div>

            {walletPubkey ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="font-mono text-emerald-200">
                  {shortenAddress(walletPubkey.toBase58(), 5)}
                </span>
                <button
                  type="button"
                  onClick={handleDisconnectWallet}
                  className="ml-1 text-zinc-400 hover:text-zinc-100"
                >
                  &times;
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleConnectWallet(false)}
                  className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3.5 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/25"
                >
                  Connect Mock Keypair
                </button>
                {typeof window !== 'undefined' && window.solana && (
                  <button
                    type="button"
                    onClick={() => handleConnectWallet(true)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-600"
                  >
                    Phantom
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-7 lg:grid-cols-12">
        {/* Left Column: Unified Form */}
        <section className="lg:col-span-5">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">
                  1. Token-2022 &amp; Virtual Pool Setup
                </h2>
                <p className="text-xs text-zinc-400">
                  Self-Referential MetadataPointer + 0 Real SOL Init
                </p>
              </div>
              <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-950 p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setTokenStandard('TOKEN_2022')}
                  className={`rounded px-2 py-0.5 font-mono transition ${
                    tokenStandard === 'TOKEN_2022'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'text-zinc-500'
                  }`}
                >
                  Token-2022
                </button>
                <button
                  type="button"
                  onClick={() => setTokenStandard('SPL_LEGACY')}
                  className={`rounded px-2 py-0.5 font-mono transition ${
                    tokenStandard === 'SPL_LEGACY'
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'text-zinc-500'
                  }`}
                >
                  SPL
                </button>
              </div>
            </div>

            <form onSubmit={handleLaunchPlatform} className="space-y-3.5">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Token Name
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={64}
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Ticker
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={12}
                    value={ticker}
                    onChange={(e) => setTicker(e.target.value.toUpperCase())}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm uppercase text-zinc-100 outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-300">
                  Image URI (IPFS / HTTPS)
                </label>
                <input
                  type="url"
                  required
                  value={imageUri}
                  onChange={(e) => setImageUri(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Telegram (On-Chain TLV)
                  </label>
                  <input
                    type="text"
                    value={telegram}
                    onChange={(e) => setTelegram(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Twitter / X (On-Chain TLV)
                  </label>
                  <input
                    type="text"
                    value={twitter}
                    onChange={(e) => setTwitter(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-300">
                  Total Supply (`initial_real_token_y`)
                </label>
                <input
                  type="text"
                  required
                  value={totalSupply}
                  onChange={(e) => setTotalSupply(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Virtual SOL (`virtual_reserves_x`)
                  </label>
                  <input
                    type="text"
                    required
                    value={virtualSolLiquidity}
                    onChange={(e) => setVirtualSolLiquidity(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-cyan-300 outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Initial Buy SOL (Opsional)
                  </label>
                  <input
                    type="text"
                    required
                    value={initialBuySol}
                    onChange={(e) => setInitialBuySol(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-emerald-300 outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/70 p-3 font-mono text-[11px] text-zinc-400">
                <div className="flex justify-between">
                  <span>Token X Program (WSOL):</span>
                  <span className="text-zinc-200">
                    {shortenAddress(TOKEN_PROGRAM_ID.toBase58(), 6)}
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span>Token Y Program ({ticker.toUpperCase()}):</span>
                  <span className="text-emerald-400">
                    {shortenAddress(
                      (tokenStandard === 'TOKEN_2022'
                        ? TOKEN_2022_PROGRAM_ID
                        : TOKEN_PROGRAM_ID
                      ).toBase58(),
                      6
                    )}
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={isBusy}
                className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/10 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {stage === 'MINTING_TOKEN'
                  ? 'Minting Token-2022...'
                  : stage === 'INITIALIZING_POOL'
                    ? 'Initializing Pool...'
                    : stage === 'INITIAL_SWAP'
                      ? 'Executing Initial Swap...'
                      : stage === 'FETCHING_POOL'
                        ? 'Fetching PoolState...'
                        : 'Launch Token-2022 & Virtual Pool'}
              </button>
            </form>
          </div>
        </section>

        {/* Right Column: Pipeline, PoolState & Swap Terminal */}
        <section className="space-y-5 lg:col-span-7">
          {/* Pipeline Status */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    stage === 'SUCCESS'
                      ? 'bg-emerald-400'
                      : stage === 'ERROR'
                        ? 'bg-rose-500'
                        : isBusy
                          ? 'animate-pulse bg-amber-400'
                          : 'bg-zinc-600'
                  }`}
                />
                <span className="text-xs font-medium text-zinc-200">
                  {statusBanner}
                </span>
              </div>
              <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-400">
                {stage}
              </span>
            </div>

            {errorMessage && (
              <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {errorMessage}
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              {steps.map((s) => (
                <div
                  key={s.step}
                  className={`rounded-lg border px-3 py-2 transition ${
                    s.status === 'done'
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : s.status === 'active'
                        ? 'border-amber-400/40 bg-amber-400/5'
                        : s.status === 'error'
                          ? 'border-rose-500/40 bg-rose-500/5'
                          : 'border-zinc-800/80 bg-zinc-950/50'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate font-medium text-zinc-200">
                      <span className="mr-1.5 font-mono text-zinc-500">
                        0{s.step}
                      </span>
                      {s.label}
                    </span>
                    <span
                      className={`ml-2 font-mono text-[10px] uppercase ${
                        s.status === 'done'
                          ? 'text-emerald-400'
                          : s.status === 'active'
                            ? 'text-amber-300'
                            : s.status === 'error'
                              ? 'text-rose-400'
                              : 'text-zinc-600'
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  {s.detail && (
                    <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
                      {s.detail}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {poolInfo ? (
            <div className="space-y-5">
              {/* Deserialized PoolState & Vault Reserves */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      Deserialized <code className="text-emerald-400">PoolState</code> (185B) +{' '}
                      <code className="text-cyan-300">TokenInterface</code> Vaults
                    </h3>
                    <p className="font-mono text-[11px] text-zinc-400">
                      Saldo Dompet Anda:{' '}
                      {formatTokenAmount(userTokenBalanceRaw, 9, 2)}{' '}
                      {ticker.toUpperCase()} &bull; LP Supply:{' '}
                      {formatTokenAmount(poolInfo.lpSupply, 9, 2)}
                    </p>
                  </div>
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-0.5 font-mono text-[11px] text-emerald-300">
                    {telemetry?.tokenStandard ?? 'TOKEN_2022'}
                  </span>
                </div>

                <div className="grid gap-2.5 sm:grid-cols-2">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-[11px] text-zinc-400">
                      vault_x.amount (Real SOL) + virtual_reserves_x
                    </div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-emerald-400">
                      {formatTokenAmount(poolInfo.realReservesX, 9, 4)} +{' '}
                      {formatTokenAmount(poolInfo.virtualReservesX, 9, 1)} ={' '}
                      {formatTokenAmount(poolInfo.totalReservesX, 9, 4)} SOL
                    </div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-[11px] text-zinc-400">
                      vault_y.amount (Real {ticker.toUpperCase()})
                    </div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-zinc-100">
                      {formatTokenAmount(poolInfo.realReservesY, 9, 2)}{' '}
                      {ticker.toUpperCase()}
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px]">
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500">pool_state PDA (bump={poolInfo.bump}):</span>
                    <span className="truncate text-zinc-200">
                      {poolInfo.poolAddress.toBase58()}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500">token_x (WSOL / SPL):</span>
                    <span className="truncate text-zinc-200">
                      {poolInfo.tokenX.toBase58()}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500">token_y (Token-2022 Mint):</span>
                    <span className="truncate text-emerald-300">
                      {poolInfo.tokenY.toBase58()}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500">token_program_y:</span>
                    <span className="truncate text-cyan-300">
                      {poolInfo.tokenProgramY.toBase58()}
                    </span>
                  </div>
                  {telemetry && telemetry.additionalMetadata.length > 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-zinc-500">
                        On-Chain TokenMetadata TLV ({telemetry.allocatedMintBytes}B):
                      </span>
                      <span className="truncate text-zinc-300">
                        {telemetry.additionalMetadata
                          .map(([k, v]) => `${k}=${v}`)
                          .join(' | ')}
                      </span>
                    </div>
                  )}
                  {telemetry && (
                    <div className="pt-1 text-[10px] text-zinc-500">
                      initialize_pool (17B):{' '}
                      <span className="text-cyan-300">
                        0x{telemetry.createPoolIxHex}
                      </span>
                      {telemetry.lastSwapIxHex && (
                        <>
                          {' '}
                          | swap (18B):{' '}
                          <span className="text-emerald-300">
                            0x{telemetry.lastSwapIxHex}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Swap Terminal (`transfer_checked`) */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-zinc-100">
                    2. Swap Terminal (<code className="text-emerald-400">transfer_checked</code>, 0.3% Fee)
                  </h3>
                  <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setTradeSide('BUY');
                        setTradeAmountInput('5');
                      }}
                      className={`rounded-md px-3 py-1 font-semibold transition ${
                        tradeSide === 'BUY'
                          ? 'bg-emerald-500 text-zinc-950'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      Beli (SOL &rarr; {ticker.toUpperCase()})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTradeSide('SELL');
                        setTradeAmountInput('10000000');
                      }}
                      className={`rounded-md px-3 py-1 font-semibold transition ${
                        tradeSide === 'SELL'
                          ? 'bg-rose-500 text-zinc-950'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      Jual ({ticker.toUpperCase()} &rarr; SOL)
                    </button>
                  </div>
                </div>

                <div className="grid items-end gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">
                      Jumlah Input (
                      {tradeSide === 'BUY' ? 'SOL' : ticker.toUpperCase()})
                    </label>
                    <input
                      type="text"
                      value={tradeAmountInput}
                      onChange={(e) => setTradeAmountInput(e.target.value)}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
                    <div className="text-[11px] text-zinc-400">
                      Output Estimasi (Virtual + Real Curve)
                    </div>
                    <div className="font-mono text-sm font-semibold text-emerald-400">
                      {swapQuote
                        ? `${formatTokenAmount(
                            swapQuote.amountOut,
                            9,
                            4
                          )} ${tradeSide === 'BUY' ? ticker.toUpperCase() : 'SOL'}`
                        : '—'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!swapQuote || isBusy}
                  onClick={handleExecuteSwap}
                  className={`mt-3 w-full rounded-lg px-4 py-2 text-xs font-semibold transition disabled:opacity-50 ${
                    tradeSide === 'BUY'
                      ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
                      : 'bg-rose-500 text-zinc-950 hover:bg-rose-400'
                  }`}
                >
                  {stage === 'SWAPPING'
                    ? 'Memproses transfer_checked Swap...'
                    : tradeSide === 'BUY'
                      ? `Beli $${ticker.toUpperCase()} (Token-2022)`
                      : `Jual $${ticker.toUpperCase()} ke SOL`}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-center">
              <p className="font-mono text-xs text-zinc-400">
                Klik <strong>Launch Token-2022 &amp; Virtual Pool</strong> untuk
                membuat Mint Token-2022 dengan ekstensi{' '}
                <code className="text-zinc-200">MetadataPointer</code> +{' '}
                <code className="text-zinc-200">TokenMetadata</code> dan
                menginisialisasi Virtual Liquidity AMM.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
