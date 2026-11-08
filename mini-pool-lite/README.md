# Mini Pool Lite — rancangan, belum bisa di-deploy

> **Status: rancangan saja.** Folder ini hanya berisi prototipe fungsi kuotasi offline; belum ada SDK transaksi
> atau program on-chain yang berfungsi. Jangan gunakan program `mini-amm-native` lama untuk dana nyata: ada
> masalah integrasi token dan vault yang dijelaskan di bawah. Ukuran `.so` baru
> dan biaya deploy belum dapat diukur.

## Tujuan

Gunakan token yang **sudah ada**, tanpa fitur membuat mint, metadata, atau logo:

1. Buat pool WSOL/token dengan parameter cadangan virtual.
2. Isi vault dengan token yang sudah dimiliki pengguna.
3. Swap dua arah (WSOL → token dan token → WSOL), dengan `min_amount_out`.

SDK klien menyusun transaksi; program on-chain memvalidasi akun dan menghitung harga.
Mengurangi SDK klien saja tidak mengecilkan `.so`. Kandidat implementasi program baru
adalah Rust dengan Pinocchio; ini hipotesis ukuran, bukan jaminan lebih kecil.
Versi library dan dukungan toolchain harus dipilih dan diuji sebelum diintegrasikan.
Pool baru tidak diasumsikan kompatibel dengan program lama: layout state, instruksi,
PDA, program ID, dan strategi migrasi harus diputuskan dan diuji bersama.

## Prototipe yang ada

`src/quote.mjs` menghitung kuotasi offline dengan integer, fee, slippage,
batas u64/u128, dan pengecekan saldo fisik. Ia **tidak** membaca saldo RPC,
membuat transaksi, atau menggantikan validasi dan perhitungan on-chain.
Jalankan `npm test` di folder ini (Node.js 18+, tanpa dependency npm).

## Hambatan yang ditemukan pada `mini-amm-native`

- `program/src/processor.rs:120–126`: `transfer_checked` mengurutkan akun mint,
  source, destination, authority. Spesifikasi SPL Token memerlukan **source, mint,
  destination, authority**. Instruksi `fund_pool` dan `swap` menggunakan builder ini.
- `src/sdk/nativePool.ts:177–185,225–231,289–299`: fee vault diturunkan sebagai PDA,
  tetapi `SystemProgram.createAccount` di transaksi klien memerlukan tanda tangan
  akun baru. PDA tidak memiliki private key; program pemilik PDA harus membuatnya
  melalui CPI dengan `invoke_signed`, atau rancangan vault harus diganti.
- `src/sdk/nativePool.ts:232–236`: `InitializeAccount3` hanya diberi akun token,
  padahal instruksi SPL juga memerlukan akun mint.
- `program/src/processor.rs:213–224,350–380`: pemeriksaan field mint dan authority
  akun token tidak dengan sendirinya membuktikan owner program akun adalah Token
  Program yang benar. Rancangan baru perlu memvalidasi program ID dan owner akun,
  serta membatasi ekstensi Token-2022 yang didukung.
- `mini-amm-native/README.md:155–159`: belum ada penarikan likuiditas atau klaim fee.
  Setoran/fee berisiko terkunci. Jangan menyetor dana yang dibutuhkan kembali.

Referensi bentuk instruksi SPL (Pinocchio upstream):
[`TransferChecked`](https://github.com/anza-xyz/pinocchio/blob/38a4ee4c6cfbc70c0f53f18fcfb6a88005fefd8b/programs/token/src/instructions/transfer_checked.rs#L40-L55),
[`InitializeAccount3`](https://github.com/anza-xyz/pinocchio/blob/38a4ee4c6cfbc70c0f53f18fcfb6a88005fefd8b/programs/token/src/instructions/initialize_account3.rs#L29-L39).
Temuan di atas merupakan pembacaan kode, belum diuji dengan transaksi on-chain.

## Persyaratan sebelum dipakai

- Putuskan desain akses penarikan likuiditas dan fee; tanpa instruksi penarikan,
  saldo pool/fee tidak dapat diambil lewat program. Hindari janji kemudahan mainnet.
- Validasi signer, owner program tiap akun, mint, vault, PDA, izin tulis,
  dan hubungan semua akun; tolak akun atau token program palsu.
- Harga dihitung on-chain dengan aritmetika checked, batas slippage, dan verifikasi
  saldo fisik vault. Uji token dengan ekstensi hanya setelah dukungannya dibuktikan.
- Uji create pool + fund + swap kedua arah di validator lokal/devnet, termasuk CPI
  SPL, transaksi gagal, dan serangan akun substitusi. Jangan hanya menguji builder.
- Build SBF, ukur byte aktual, bandingkan baseline 71.160 byte dengan toolchain dan
  fitur yang sama, lalu uji ukuran baru dan estimasi rent sebelum mempertimbangkan
  audit serta mainnet. Tidak tersedia Rust/SBF atau RPC pada saat rancangan ini ditulis.

## Acuan biaya

Pada rumus `scripts/program-build.mjs` yang lama, 71.160 byte menghasilkan estimasi
rent program **0,4976 SOL** dan kebutuhan puncak **0,9941 SOL**, di luar fee transaksi.
Setiap pengurangan 1 KiB menghemat sekitar **0,00713 SOL** rent program. Angka versi
baru tidak diketahui sampai `.so` selesai dibangun dan diukur; saldo pool, rent akun
vault, rent akun token user, dan fee transaksi merupakan biaya terpisah.
