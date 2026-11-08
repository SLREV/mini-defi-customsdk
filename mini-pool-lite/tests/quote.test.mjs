import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteSwap } from '../src/quote.mjs';

const base = { amountIn: 100_000_000n, realX: 1_000_000_000n, realY: 800_000_000_000n, virtualX: 30_000_000_000n, xToY: true };
test('kuotasi memakai cadangan virtual, fee, dan pembulatan integer', () => {
  const q = quoteSwap(base);
  const fee = base.amountIn * 6n / 10000n;
  const net = base.amountIn - fee;
  assert.deepEqual(q, { creatorFee: fee, netIn: net, amountOut: net * 9976n * base.realY / ((base.realX + base.virtualX) * 10000n + net * 9976n) });
});
test('swap sebaliknya dibatasi saldo fisik, bukan saldo virtual', () => {
  assert.throws(() => quoteSwap({ ...base, realX: 0n, xToY: false }), /saldo vault/);
  assert.ok(quoteSwap({ ...base, xToY: false }).amountOut <= base.realX);
});
test('menolak slippage, input invalid dan overflow seperti aritmetika on-chain', () => {
  const q = quoteSwap(base);
  assert.throws(() => quoteSwap({ ...base, minOut: q.amountOut + 1n }), /slippage/);
  assert.throws(() => quoteSwap({ ...base, amountIn: 0n }), /positif/);
  assert.throws(() => quoteSwap({ ...base, amountIn: 1 }), /bigint/);
  assert.throws(() => quoteSwap({ ...base, realX: (1n << 64n) - 1n, virtualX: 1n }), /u64/);
  assert.throws(() => quoteSwap({ ...base, amountIn: (1n << 64n) - 1n, realY: (1n << 64n) - 1n }), /overflow u128/);
});
