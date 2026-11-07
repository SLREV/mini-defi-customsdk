import assert from 'node:assert/strict';
import { AccountInfo, Commitment, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { CustomDefiSDK, parseTokenAmount, SPL_TOKEN_ACCOUNT_LAYOUT, SPL_TOKEN_ACCOUNT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/sdk/customSdk';
import { formatExactTokenAmount, readSwapTokenBalance } from '../src/tradeUtils';

class MockConnection extends Connection {
  address: PublicKey | null = null;
  account: AccountInfo<Buffer> | null = null;
  failure = false;
  constructor() { super('http://127.0.0.1:8899'); }
  override async getAccountInfo(address: PublicKey, _commitment?: Commitment): Promise<AccountInfo<Buffer> | null> {
    this.address = address;
    if (this.failure) throw new Error('RPC offline');
    return this.account;
  }
}

async function main() {
  for (const amount of [0n, 1n, 10n, 1_000_000_000n, 3_090_080_267_991n, 18_446_744_073_709_551_615n]) {
    assert.equal(parseTokenAmount(formatExactTokenAmount(amount)), amount);
  }
  assert.equal(formatExactTokenAmount(3_090_080_267_991n), '3090.080267991');
  assert.equal(formatExactTokenAmount(1n), '0.000000001');
  assert.equal(formatExactTokenAmount(123n, 0), '123');
  assert.throws(() => formatExactTokenAmount(-1n));

  const conn = new MockConnection();
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const sdk = new CustomDefiSDK(conn);
  assert.equal(await readSwapTokenBalance(conn, owner, mint, TOKEN_2022_PROGRAM_ID), 0n);
  assert(conn.address?.equals(sdk.deriveAssociatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM_ID)));

  const data = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE + 32); // token-2022 extensions
  SPL_TOKEN_ACCOUNT_LAYOUT.encode({ mint, owner, amount: 3_090_080_267_991n,
    delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0,
    isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  conn.account = { data, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1 };
  const balance = await readSwapTokenBalance(conn, owner, mint, TOKEN_2022_PROGRAM_ID);
  assert.equal(parseTokenAmount(formatExactTokenAmount(balance)), 3_090_080_267_991n);
  await assert.rejects(readSwapTokenBalance(conn, owner, mint, TOKEN_PROGRAM_ID), /tidak valid/);
  assert(conn.address?.equals(sdk.deriveAssociatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID)));
  const otherOwner = Keypair.generate().publicKey;
  await assert.rejects(readSwapTokenBalance(conn, otherOwner, mint, TOKEN_2022_PROGRAM_ID), /tidak aktif atau tidak sesuai/);
  conn.failure = true;
  await assert.rejects(readSwapTokenBalance(conn, owner, mint, TOKEN_2022_PROGRAM_ID), /RPC offline/);
  console.log('SELL ALL PRECISION AND TOKEN BALANCE TESTS PASSED!');
}
main().catch((err: unknown) => { console.error(err); process.exitCode = 1; });
