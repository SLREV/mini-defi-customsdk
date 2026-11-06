import assert from 'node:assert/strict';
import {
  AccountInfo,
  Commitment,
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import {
  ADD_LIQUIDITY_IX_LAYOUT,
  CREATE_POOL_IX_LAYOUT,
  CustomDefiSDK,
  DEFAULT_AMM_PROGRAM_ID,
  DEFAULT_VIRTUAL_SOL_LAMPORTS,
  NATIVE_SOL_MINT,
  POOL_STATE_DISCRIMINATOR,
  POOL_STATE_SIZE,
  PoolStateLayout,
  SPL_MINT_ACCOUNT_LAYOUT,
  SPL_MINT_SIZE,
  SPL_TOKEN_ACCOUNT_LAYOUT,
  SPL_TOKEN_ACCOUNT_SIZE,
  SWAP_IX_LAYOUT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_METADATA_INITIALIZE_DISCRIMINATOR,
  TOKEN_METADATA_UPDATE_FIELD_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  calculateInitialLpTokens,
  calculateSwapOutput,
  formatTokenAmount,
  parseTokenAmount,
} from '../src/sdk/customSdk';

class MockConnection extends Connection {
  public readonly ledger = new Map<string, AccountInfo<Buffer>>();

  constructor() {
    super('http://127.0.0.1:8899', 'confirmed');
  }

  override async getMinimumBalanceForRentExemption(size: number): Promise<number> {
    return (128 + size) * 6960;
  }

  override async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    return {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1000,
    };
  }

  override async getAccountInfo(
    pubkey: PublicKey,
    _commitment?: Commitment
  ): Promise<AccountInfo<Buffer> | null> {
    return this.ledger.get(pubkey.toBase58()) ?? null;
  }

  override async getMultipleAccountsInfo(
    pubkeys: PublicKey[],
    _commitment?: Commitment
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    return pubkeys.map((p) => this.ledger.get(p.toBase58()) ?? null);
  }
}

async function main(): Promise<void> {
  const conn = new MockConnection();
  const sdk = new CustomDefiSDK(conn, DEFAULT_AMM_PROGRAM_ID);
  const payer = Keypair.generate();

  // 1. Verifikasi ukuran PoolStateLayout = 185 bytes
  assert.equal(PoolStateLayout.span, 185);
  assert.equal(POOL_STATE_SIZE, 185);

  // 2. Uji presisi 9 desimal BigInt (1 Milyar Token-2022 = 10^18 > MAX_SAFE_INTEGER)
  const supplyRaw = parseTokenAmount('1000000000', 9);
  assert.equal(supplyRaw, 1_000_000_000_000_000_000n);

  // 3. Uji Clone Token-2022 + Native MetadataPointer + TokenMetadata + UpdateField (Telegram & Twitter)
  const clone = await sdk.buildCloneTokenInstructions({
    payer: payer.publicKey,
    name: 'Nusantara Token 2022',
    symbol: 'NUSA',
    imageUri:
      'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
    telegram: 'https://t.me/nusa_2022',
    twitter: 'https://x.com/nusa_2022',
    decimals: 9,
    initialSupplyRaw: supplyRaw,
    tokenStandard: 'TOKEN_2022',
  });

  assert.equal(clone.tokenProgramId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(clone.metadataAddress.toBase58(), clone.mint.toBase58());
  // 8 instruksi: CreateAccount(234B) + InitMetadataPointer(39,0) + InitMint2(20) + InitMetadata + UpdateField(tg) + UpdateField(tw) + CreateATA + MintToChecked(14)
  assert.equal(clone.instructions.length, 8);
  assert.equal(clone.instructions[1].data.byteLength, 66);
  assert.equal(clone.instructions[1].data[0], 39); // MetadataPointerExtension
  assert.equal(clone.instructions[2].data.byteLength, 67);
  assert.equal(clone.instructions[2].data[0], 20); // InitializeMint2
  assert.deepEqual(
    Array.from(clone.instructions[3].data.subarray(0, 8)),
    Array.from(TOKEN_METADATA_INITIALIZE_DISCRIMINATOR)
  );
  assert.deepEqual(
    Array.from(clone.instructions[4].data.subarray(0, 8)),
    Array.from(TOKEN_METADATA_UPDATE_FIELD_DISCRIMINATOR)
  );
  assert.equal(clone.instructions[7].data.byteLength, 10);
  assert.equal(clone.instructions[7].data[0], 14); // MintToChecked

  // 4. Uji buildCreatePoolTx (Discriminator 0, 17B payload, 15 AccountMeta lintas TokenProgram)
  const createPool = await sdk.buildCreatePoolTx({
    payer: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
    initialRealTokenY: supplyRaw,
    virtualReservesX: DEFAULT_VIRTUAL_SOL_LAMPORTS,
    tokenProgramX: TOKEN_PROGRAM_ID,
    tokenProgramY: TOKEN_2022_PROGRAM_ID,
    tokenProgramLp: TOKEN_2022_PROGRAM_ID,
  });

  assert.equal(createPool.serializedIxData.byteLength, 17);
  assert.equal(createPool.instruction.keys.length, 15);
  // Pastikan token_program_x = SPL Legacy (WSOL) & token_program_y = Token-2022
  assert.equal(
    createPool.instruction.keys[9].pubkey.toBase58(),
    TOKEN_PROGRAM_ID.toBase58()
  );
  assert.equal(
    createPool.instruction.keys[10].pubkey.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58()
  );

  const decodedCreate = CREATE_POOL_IX_LAYOUT.decode(createPool.serializedIxData);
  assert.equal(decodedCreate.discriminator, 0);
  assert.equal(decodedCreate.initialRealTokenY, supplyRaw);
  assert.equal(decodedCreate.virtualReservesX, 30_000_000_000n);

  createPool.transaction.sign(payer);
  assert.ok(createPool.transaction.serialize().byteLength <= 1232);

  // 5. Uji buildAddLiquidityTx (Discriminator 1, 25B, 13 AccountMeta)
  const addLiq = await sdk.buildAddLiquidityTx({
    user: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
    amountX: 5_000_000_000n,
    amountY: 100_000_000_000_000_000n,
    minLpOut: 100n,
  });
  assert.equal(addLiq.serializedIxData.byteLength, 25);
  assert.equal(addLiq.instruction.keys.length, 13);
  assert.equal(
    ADD_LIQUIDITY_IX_LAYOUT.decode(addLiq.serializedIxData).discriminator,
    1
  );

  // 6. Uji buildSwapTx (Discriminator 2, 18B, 10 AccountMeta)
  const swapBuild = await sdk.buildSwapTx({
    user: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
    amountIn: 5_000_000_000n,
    minAmountOut: 1n,
    xToY: true,
  });
  assert.equal(swapBuild.serializedIxData.byteLength, 18);
  assert.equal(swapBuild.instruction.keys.length, 10);
  assert.equal(SWAP_IX_LAYOUT.decode(swapBuild.serializedIxData).discriminator, 2);

  // 7. Uji fetchPoolInfo() Deserialisasi Biner 185B + Vault Token-2022
  const initialLp = calculateInitialLpTokens(DEFAULT_VIRTUAL_SOL_LAMPORTS, supplyRaw);
  const swapOut5Sol = calculateSwapOutput(
    5_000_000_000n,
    DEFAULT_VIRTUAL_SOL_LAMPORTS,
    supplyRaw + supplyRaw
  );

  const poolBuf = Buffer.alloc(POOL_STATE_SIZE);
  PoolStateLayout.encode(
    {
      discriminator: POOL_STATE_DISCRIMINATOR,
      tokenX: NATIVE_SOL_MINT,
      tokenY: clone.mint,
      vaultX: createPool.addresses.vaultX,
      vaultY: createPool.addresses.vaultY,
      lpMint: createPool.addresses.lpMint,
      virtualReservesX: DEFAULT_VIRTUAL_SOL_LAMPORTS,
      virtualReservesY: supplyRaw,
      bump: createPool.addresses.poolBump,
    },
    poolBuf
  );
  conn.ledger.set(createPool.addresses.poolState.toBase58(), {
    data: poolBuf,
    executable: false,
    lamports: 2_150_000,
    owner: DEFAULT_AMM_PROGRAM_ID,
    rentEpoch: 0,
  });

  const vaultXBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
  SPL_TOKEN_ACCOUNT_LAYOUT.encode(
    {
      mint: NATIVE_SOL_MINT,
      owner: createPool.addresses.poolState,
      amount: 5_000_000_000n,
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
  conn.ledger.set(createPool.addresses.vaultX.toBase58(), {
    data: vaultXBuf,
    executable: false,
    lamports: 7_039_280,
    owner: TOKEN_PROGRAM_ID,
    rentEpoch: 0,
  });

  const vaultYBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
  SPL_TOKEN_ACCOUNT_LAYOUT.encode(
    {
      mint: clone.mint,
      owner: createPool.addresses.poolState,
      amount: supplyRaw - swapOut5Sol,
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
  conn.ledger.set(createPool.addresses.vaultY.toBase58(), {
    data: vaultYBuf,
    executable: false,
    lamports: 2_039_280,
    owner: TOKEN_2022_PROGRAM_ID,
    rentEpoch: 0,
  });

  const lpMintBuf = Buffer.alloc(SPL_MINT_SIZE);
  SPL_MINT_ACCOUNT_LAYOUT.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: createPool.addresses.poolState,
      supply: initialLp,
      decimals: 9,
      isInitialized: 1,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    lpMintBuf
  );
  conn.ledger.set(createPool.addresses.lpMint.toBase58(), {
    data: lpMintBuf,
    executable: false,
    lamports: 1_461_600,
    owner: TOKEN_2022_PROGRAM_ID,
    rentEpoch: 0,
  });

  const unpacked = await sdk.fetchPoolInfo(NATIVE_SOL_MINT, clone.mint);
  assert.equal(unpacked.tokenX.toBase58(), NATIVE_SOL_MINT.toBase58());
  assert.equal(unpacked.tokenY.toBase58(), clone.mint.toBase58());
  assert.equal(unpacked.tokenProgramX.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(unpacked.tokenProgramY.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(unpacked.realReservesX, 5_000_000_000n);
  assert.equal(unpacked.virtualReservesX, 30_000_000_000n);
  assert.equal(unpacked.totalReservesX, 35_000_000_000n);
  assert.equal(unpacked.lpSupply, initialLp);

  console.log('ALL TOKEN-2022 & VIRTUAL LIQUIDITY AMM BINARY TESTS PASSED!');
  console.log({
    token2022Mint: clone.mint.toBase58(),
    allocatedMintBytes: clone.allocatedMintBytes,
    poolPda: unpacked.poolAddress.toBase58(),
    totalEffectiveSol: formatTokenAmount(unpacked.totalReservesX, 9, 2) + ' SOL',
    remainingVaultToken2022: formatTokenAmount(unpacked.realReservesY, 9, 2),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
