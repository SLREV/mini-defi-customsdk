/**
 * Prototipe kuotasi offline. Ini bukan program on-chain atau transaksi swap.
 * Jangan gunakan untuk memercayai saldo/harga tanpa validasi on-chain.
 */
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const BPS = 10_000n;

function u64(value, name) {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new RangeError(`${name} harus bigint u64`);
  }
  return value;
}
function checked128(value) {
  if (value > U128_MAX) throw new RangeError('overflow u128');
  return value;
}

/**
 * Hitung kuotasi sebelum swap: x = WSOL, y = token, semua angka dalam unit dasar.
 * Mengikuti rumus 6 bps creator + 24 bps LP program lama, termasuk batas u128.
 * Harga dan validasi final harus tetap dijalankan oleh program on-chain.
 */
export function quoteSwap({ amountIn, realX, realY, virtualX, xToY, minOut = 0n }) {
  u64(amountIn, 'amountIn');
  u64(realX, 'realX');
  u64(realY, 'realY');
  u64(virtualX, 'virtualX');
  u64(minOut, 'minOut');
  if (typeof xToY !== 'boolean') throw new TypeError('xToY harus boolean');
  if (amountIn === 0n) throw new RangeError('amountIn harus positif');
  const reserveX = realX + virtualX;
  u64(reserveX, 'reserveX');
  const reserveIn = xToY ? reserveX : realY;
  const reserveOut = xToY ? realY : reserveX;
  if (reserveIn === 0n || reserveOut === 0n) throw new RangeError('reserve kosong');
  const creatorFee = checked128(amountIn * 6n) / BPS;
  if (creatorFee >= amountIn) throw new RangeError('fee tidak valid');
  const netIn = amountIn - creatorFee;
  const netInWithFee = checked128(netIn * (BPS - 24n));
  const denominator = checked128(checked128(reserveIn * BPS) + netInWithFee);
  const amountOut = checked128(netInWithFee * reserveOut) / denominator;
  if (amountOut === 0n || amountOut >= reserveOut) throw new RangeError('output tidak valid');
  u64(amountOut, 'amountOut');
  if (amountOut < minOut) throw new RangeError('slippage');
  if (amountOut > (xToY ? realY : realX)) throw new RangeError('saldo vault tidak cukup');
  return { creatorFee, netIn, amountOut };
}
