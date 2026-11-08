import { defineConfig } from 'vite';
import { pinataDevApi } from './src/dev/pinataDevApi';

/**
 * `pinataDevApi()` hanya aktif di `vite dev` (apply: 'serve') dan membaca
 * PINATA_JWT dari `.env` di sisi Node — secret tidak pernah masuk bundle browser.
 * Untuk produksi, pindahkan handler yang sama ke backend Anda.
 */
export default defineConfig({
  plugins: [pinataDevApi()],
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['buffer', '@solana/web3.js', '@solana/buffer-layout'],
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4180,
    allowedHosts: true,
  },
});
