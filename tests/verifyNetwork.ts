import assert from 'node:assert/strict';
import { AccountInfo, Keypair, PublicKey } from '@solana/web3.js';
import { assertMainnetWallet, assertRpcNetwork, assertRpcReady, NETWORK_GENESIS, resolveProgramId } from '../src/network';

async function main(): Promise<void> {
  const program = Keypair.generate().publicKey;
  const fallback = Keypair.generate().publicKey;
  assert.equal(resolveProgramId('MAINNET', undefined, fallback), null);
  assert(resolveProgramId('LOCAL', undefined, fallback)?.equals(fallback));
  assert.equal(resolveProgramId('LOCAL', 'invalid!', fallback), null);
  assert.equal(resolveProgramId('MAINNET', 'invalid!', fallback), null);
  assert(resolveProgramId('MAINNET', program.toBase58(), fallback)?.equals(program));
  assert(resolveProgramId('DEVNET', undefined, fallback)?.equals(fallback));
  assert.equal(resolveProgramId('DEVNET', 'invalid!', fallback), null);

  let genesis = NETWORK_GENESIS.DEVNET;
  let lookedUp = false;
  let account: AccountInfo<Buffer> | null = { data: Buffer.alloc(0), owner: program, executable: true, lamports: 1 };
  const rpc = {
    async getGenesisHash() { return genesis; },
    async getAccountInfo(id: PublicKey) { lookedUp = true; assert(id.equals(program)); return account; },
  };
  await assertRpcReady(rpc, 'DEVNET', program);
  lookedUp = false;
  await assert.rejects(assertRpcReady(rpc, 'MAINNET', program), /bukan jaringan MAINNET/);
  assert.equal(lookedUp, false);
  await assert.rejects(assertRpcReady(rpc, 'MAINNET', null), /belum dikonfigurasi/);
  genesis = NETWORK_GENESIS.MAINNET;
  await assertRpcNetwork(rpc, 'MAINNET');
  await assert.rejects(assertRpcNetwork(rpc, 'LOCAL'), /cluster publik/);
  await assert.rejects(assertRpcNetwork(rpc, 'DEVNET'), /bukan jaringan DEVNET/);
  account = null;
  await assert.rejects(assertRpcReady(rpc, 'MAINNET', program), /tidak ditemukan/);
  account = { data: Buffer.alloc(0), owner: program, executable: false, lamports: 1 };
  await assert.rejects(assertRpcReady(rpc, 'MAINNET', program), /tidak executable/);
  account.executable = true;
  await assertRpcReady(rpc, 'MAINNET', program);
  genesis = NETWORK_GENESIS.DEVNET;
  await assert.rejects(assertRpcNetwork(rpc, 'LOCAL'), /cluster publik/);
  genesis = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z';
  await assert.rejects(assertRpcNetwork(rpc, 'LOCAL'), /cluster publik/);
  genesis = Keypair.generate().publicKey.toBase58();
  await assertRpcReady(rpc, 'LOCAL', program);
  await assert.rejects(assertRpcNetwork(rpc, 'MAINNET'), /bukan jaringan MAINNET/);

  const wallet = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  assert.doesNotThrow(() => assertMainnetWallet(true, 'INJECTED', wallet, wallet, wallet));
  assert.throws(() => assertMainnetWallet(false, 'INJECTED', wallet, wallet, wallet), /persetujuan/);
  assert.throws(() => assertMainnetWallet(true, 'EPHEMERAL', wallet, wallet, wallet), /wallet/);
  assert.throws(() => assertMainnetWallet(true, 'INJECTED', wallet, other, wallet), /wallet/);
  assert.throws(() => assertMainnetWallet(true, 'INJECTED', wallet, wallet, other), /wallet/);
  console.log('NETWORK AND MAINNET SAFETY TESTS PASSED!');
}
main().catch((err: unknown) => { console.error(err); process.exitCode = 1; });
