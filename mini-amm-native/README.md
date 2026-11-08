# mini-amm-native

Program AMM **Native Rust (tanpa Anchor)** + dashboard minimal untuk launch token di mainnet
dengan biaya sekecil mungkin.

- Dashboard **tanpa React/Tailwind** — HTML + TS + CSS, satu halaman, ~92 KB gzip.
- Program tanpa dependency `spl-token-*`: `transfer_checked` disusun manual → `.so` kecil.
- State pool **81 byte** (0.001455 SOL), bukan 281 byte.
- Harga swap **dihitung on-chain**; `min_amount_out` dari klien hanya batas bawah.
- Swap **wire-compatible** dengan `customSdk.ts` repo induk: 18 byte, 12 akun.

```
mini-amm-native/
├── program/               # crate Rust native (declare_id! ada di src/lib.rs)
│   ├── Cargo.toml
│   └── src/{lib.rs,processor.rs}
├── src/
│   ├── main.ts            # dashboard (wallet, form, launch, beli, biaya)
│   ├── style.css
│   ├── sdk/nativePool.ts  # builder instruksi + PDA + matematika + decode state
│   ├── sdk/customSdk.ts   # salinan SDK induk: pembuat mint Token-2022 + metadata
│   └── dev/               # Pinata dev API (JSON + base64) — hanya untuk `npm run dev`
├── scripts/cost.ts        # ukuran .so → rent deploy + biaya launch
└── tests/verifyNativePool.ts
```

## 1. Jalankan dashboard

```bash
cd mini-amm-native
npm install
cp .env.example .env          # isi PINATA_JWT
npm run dev                   # http://localhost:5180
```

Dev server menjalankan middleware `POST /api/pinata/upload` (JSON `{ fileName, base64, name, symbol,
description, telegram?, twitter? }` → `{ imageUri, metadataUri }`). **Hanya aktif di `npm run dev`**;
untuk produksi pindahkan handler yang sama ke backend dan simpan `PINATA_JWT` di server.

## 2. Buat keypair, build, dan deploy program

`cargo build-sbf` tidak membuat keypair deploy. Untuk program **baru**, dari folder
`mini-amm-native` jalankan:

```bash
npm run program:keypair   # buat keypair jika belum ada; sinkronkan declare_id! dan .env
npm run program:build     # build setelah ID disinkronkan, ukur .so dan estimasi biaya
npm run program:size      # hanya ukur .so yang sudah ada (tanpa build)
```

Jika program sudah pernah di-deploy, **pulihkan keypair aslinya dari cadangan** ke
`program/target/deploy/mini_amm_native-keypair.json`. Keypair baru menghasilkan ID baru,
bukan ID lama. Skrip menggunakan keypair yang sudah ada dan tidak menimpanya. File ini
berisi private key: simpan cadangan di tempat aman, jangan dibagikan atau di-commit.
Perintah di atas membuat `.env` dari `.env.example` bila belum ada, tanpa menghapus
pengaturan `.env` yang sudah ada. Setelah mengubah ID, build ulang `.so`; restart
atau build ulang dashboard agar perubahan `.env` terbaca.

Uji di devnet sebelum mainnet. Setelah siap dan dana mencukupi, contoh deploy mainnet:

```bash
solana program deploy program/target/deploy/mini_amm_native.so \
  --program-id program/target/deploy/mini_amm_native-keypair.json \
  --url mainnet-beta
```

Pastikan wallet dan upgrade authority CLI benar, dan saldo cukup untuk biaya puncak
serta biaya transaksi. Proses deploy memerlukan SOL sungguhan.

Format keluaran (angka di bawah **hanya ilustrasi format** untuk 18 KB; ukuran sebenarnya
baru diketahui setelah build):

```
ukuran .so  : 18.432 byte (18.0 KB)
deploy final : 0.1306 SOL
puncak deploy: 0.2601 SOL
```

Manual, bila ingin dua langkah terpisah:

```bash
cd program && cargo build-sbf && ls -l target/deploy/mini_amm_native.so
cd .. && npm run cost -- --size <ukuran_byte>
```

### Tangga pengecilan ukuran `.so`

Ukur tiap langkah dengan `npm run program:size` — jangan menebak.

| Langkah | Efek | Catatan |
| :--- | :--- | :--- |
| Tanpa `anchor-lang`/`anchor-spl` (sudah) | puluhan–ratusan KB | penyebab utama `.so` besar |
| Tanpa `spl-token-2022` (sudah) — `transfer_checked` manual | besar | yang tersisa hanya `solana-program` |
| `opt-level = "z"` + `lto = "fat"` + `codegen-units = 1` + `strip` (sudah) | beberapa KB | sudah aktif di `program/Cargo.toml` |
| `panic = "abort"` (sudah) | ~1–3 KB | menghapus tabel unwind |
| `msg!` di jalur error saja | puluhan byte/`msg!` | format string ikut tersimpan |
| Hapus `overflow-checks` | ~1–2 KB | **jangan** untuk program AMM |

Target realistis: **15–30 KB**. Setiap 1 KB ≈ **0,00713 SOL** rent.

- `[profile.release]` (opt-level `z`, LTO fat, strip, overflow-checks) ada di
  `program/Cargo.toml` yang juga root workspace-nya.

Referensi biaya (rumus `(128 + byte) × 6960`):

| Ukuran `.so` | Deploy final | Puncak saat deploy |
| ---: | ---: | ---: |
| 10 KB | 0.0736 SOL | 0.1461 SOL |
| 15 KB | 0.1093 SOL | 0.2174 SOL |
| 20 KB | 0.1449 SOL | 0.2886 SOL |

Launch token + pool (Token-2022, metadata ~400 B): **0.0173 SOL**
(mint 0.0036 + state pool 0.0015 + 4 akun token 0.0082 + 2 ATA user 0.0041 + fee).

## 3. Alur dashboard

1. **Hubungkan wallet** (Phantom/Solflare lewat `window.solana`).
2. **Isi form** → nama, simbol, deskripsi, Telegram/Twitter, supply, likuiditas virtual, token untuk pool.
3. **Unggah logo** → IPFS via Pinata (gambar + JSON metadata).
4. **Launch** → transaksi 1: mint Token-2022 + metadata on-chain; transaksi 2: 2 ATA vault +
   2 fee vault + `initialize_pool` + `fund_pool`.
5. **Beli** → bungkus SOL jadi WSOL (`SyncNative`) lalu `swap` x→y dengan `min_amount_out` 99%
   dari kuotasi.

## 4. Instruksi program

| Disc | Instruksi | Akun | Data |
| ---: | :--- | ---: | :--- |
| 0 | `initialize_pool` | 9 | `[0, u64_le virtual_reserves_x]` |
| 1 | `fund_pool` | 6 | `[1, u64_le amount]` |
| 2 | `swap` | 12 | `[2, u64_le amount_in, u64_le min_out, u8 x_to_y]` |

State pool (81 B): `disc[9] | vault_x(32) | vault_y(32) | virtual_reserves_x(8) | bump(1) | padding(7)`.

Matematika (sama dengan `computeSwapOut` di `src/sdk/nativePool.ts`):

```text
creator_fee = amount_in * 6 / 10_000
net_in      = amount_in - creator_fee
out         = net_in*9976 * R_out / (R_in*10_000 + net_in*9976)
R_in        = vault_in.amount + virtual_reserves_x ,  R_out = vault_out.amount
require!(out >= min_amount_out)   // klien hanya batas bawah
```

## 5. Uji

```bash
npm test        # layout instruksi, PDA, paritas matematika, decode state, biaya
npm run typecheck
```

Di repo induk, `npm test` juga menjalankan `tests/verifyNativeInvariant.ts` (paritas on-chain vs
SDK + dua skenario serangan: klien menentukan nominal keluar, dan `virtual_reserves_x` dipalsukan).

## 6. Belum ada (jangan diasumsikan)

- `remove_liquidity` / penarikan likuiditas — tidak ada.
- Klaim fee creator (`fee_vault_x/y` sudah menampung, belum ada instruksi klaim).
- LP token / share — `fund_pool` hanya menyetor, tanpa bukti kepemilikan proporsional.
- CPI: program ini belum tentu aman dipanggil program lain dengan PDA sebagai `user`; uji dulu.
- Program Rust ini **belum dikompilasi/diuji on-chain** di sandbox penyusunan (tidak ada
  `cargo-build-sbf`). Uji di devnet sebelum mainnet.
