# Program Native "Tipis": mana yang realistis, mana yang berbahaya

Audit atas rencana "buang Anchor → biner < 15 KB → deploy 0.15 SOL, matematika pindah ke
frontend (stateless)". Setiap klaim diberi status `✔`, `⚠`, atau `✘`.

- Lingkungan penyusunan: **tidak ada Rust/SBF toolchain**, jadi ukuran biner tidak bisa
  diukur di sini. Semua angka rent dihitung dari rumus Solana dan bisa Anda ulang dengan
  `npm run cost:deploy -- --size <byte>`.
- Contoh program yang aman: [`examples/mini-amm-native/`](../examples/mini-amm-native/).
- Uji serangan/paritas matematika: `tests/verifyNativeInvariant.ts` (ikut `npm test`).

---

## 1. Verdict ringkas

| # | Klaim | Status | Penjelasan |
| :-- | :--- | :---: | :--- |
| 1 | Membuang Anchor membuat biner jauh lebih kecil | ✔ | Anchor menambah dispatch, IDL, `anchor-spl`, `borsh`, error-code; pada program AMM biasanya puluhan–ratusan KB. |
| 2 | Biner bisa di bawah **15 KB** | ⚠ | **Belum terbukti.** Dengan dependency `spl-token-2022` hampir pasti **tidak** (<15 KB tidak realistis: crate itu menarik `spl-token`, `spl-pod`, `bytemuck`, dsb). 15–40 KB baru masuk akal bila CPI `transfer_checked` **diserialisasi manual** tanpa crate SPL. Ukur sendiri setelah build. |
| 3 | Rent deploy ≈ 0.15 SOL | ✔/⚠ | 15 KB → **0.1093 SOL** final (puncak 0.2174 SOL saat buffer). 10 KB → 0.0736 SOL. Jadi 0.15 SOL lebih besar dari perlu, tetapi ordenya benar. |
| 4 | Matematika AMM dipindah ke frontend; program hanya mengeksekusi angka dari klien | ✘ **FATAL** | Vault bisa dikuras. Lihat §3. |
| 5 | Program bisa sepenuhnya *stateless* | ✘ | Virtual liquidity (`virtual_reserves_x`) **wajib** tersimpan on-chain. Kalau dikirim klien, penyerang memilih `virtual_x = 0` dan menukar 1 lamport dengan seluruh isi `vault_y`. |
| 6 | Kode `processor.rs` di draf bisa dipakai | ✘ | 8 bug, termasuk argumen `transfer_checked` tertukar dan bump diambil dari instruction data. Lihat §5. |
| 7 | Perlu membuat dashboard baru | ⚠ | Tidak perlu. Dashboard + upload logo Pinata **sudah ada** di repo ini (`src/App.tsx`, `scripts/pinataDevApi.ts`). Yang perlu diperhatikan: kontrak API-nya JSON, bukan `FormData`. Lihat §7. |
| 8 | Cukup `cargo build-sbf --release` | ✔/⚠ | Benar, tapi `[profile.release]` hanya berlaku bila Cargo.toml berada di **root workspace**; `strip`/`opt-level` di crate anggota saja bisa diabaikan. |

---

## 2. Ukuran biner: apa yang benar-benar menentukan

| Komponen | Dampak ukuran |
| :--- | :--- |
| `anchor-lang` + `anchor-spl` | besar (dispatch + IDL + borsh + spl-token) |
| `spl-token-2022` (untuk builder instruksi) | besar — membawa seluruh state & ekstensi token |
| `solana-program` saja | sedang |
| CPI `transfer_checked` **dibuat manual** (`data = [12, amount_le, decimals]`) | hampir gratis |
| `overflow-checks = true` | menambah sedikit (tetap disarankan untuk AMM) |
| `opt-level = "z"`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"` | mengecilkan |

Kesimpulan praktis: **target realistis 15–40 KB**, bukan janji 15 KB. Cara mengukur:

```bash
anchor build            # atau: cargo build-sbf --release --manifest-path programs/<x>/Cargo.toml
ls -l target/deploy/*.so
npm run cost:deploy -- --size <ukuran_byte>
```

Referensi rent (final = terkunci, puncak = kebutuhan dana saat deploy):

| Ukuran | Rent final | Puncak |
| ---: | ---: | ---: |
| 10 KB | 0.0736 SOL | 0.1461 SOL |
| 15 KB | 0.1093 SOL | 0.2174 SOL |
| 20 KB | 0.1449 SOL | 0.2886 SOL |
| 30 KB | 0.2162 SOL | 0.4312 SOL |

---

## 3. Kenapa "matematika di frontend" menguras vault

Draf menaruh `amount_out` dari klien langsung sebagai **jumlah transfer keluar**:

```rust
min_amount_out, // "Angka out ini sudah matang hasil hitungan sdk.ts"
```

Program hanya memeriksa `data.len()` dan beberapa akun. Siapa pun bisa mengirim payload
`amount_in = 1`, `amount_out = saldo seluruh vault_y` dan mengambil semuanya. Ini bukan bug
kecil: **vault adalah batas kepercayaan**, dan satu-satunya cara menjaganya adalah
menghitung ulang harga di on-chain.

Model yang benar (dipakai repo ini, dan dipertahankan di contoh):

```text
creator_fee = amount_in * 6 / 10_000            (6 bps)
net_in      = amount_in - creator_fee
out         = net_in * 9976 * R_out / (R_in * 10_000 + net_in * 9976)
R_in        = vault_in.amount  + virtual_x      (virtual_x dari STATE on-chain)
R_out       = vault_out.amount + virtual_y      (0 pada inisialisasi)
require!(out >= min_amount_out)                 (min_amount_out dari klien = batas, bukan nominal)
```

`min_amount_out` tetap dikirim klien — tetapi sebagai **batas bawah**, bukan nominal transfer.
Nominal keluar selalu hasil hitung program. Biaya tambahan di on-chain: ~30 baris aritmetika
`u128`, jauh di bawah 1 KB biner.

Uji serangan + paritas dengan `calculateSwapOutput` SDK: `tests/verifyNativeInvariant.ts`.

---

## 4. State minimal (tidak bisa nol, tapi sangat murah)

"Stateless" tidak mungkin untuk virtual liquidity. Yang bisa adalah state **kecil**:

| Layout state (81 B) | Offset | Ukuran |
| :--- | ---: | ---: |
| discriminator `[9]` | 0 | 1 |
| `vault_x: Pubkey` | 1 | 32 |
| `vault_y: Pubkey` | 33 | 32 |
| `virtual_reserves_x: u64` | 65 | 8 |
| `bump: u8` | 73 | 1 |
| sisa | 74..81 | 7 (padding) |

Rent: `(128 + 81) × 6960 = 1.454.640 lamports ≈ **0.0015 SOL**`. Jadi menghapus state tidak
menghemat banyak — yang mahal adalah **biner program**, bukan state pool.

PDA: `[b"pool", mint_x, mint_y]` milik program Anda; bump disimpan di state dan divalidasi
dengan `create_program_address` (jangan pernah menerima bump dari instruction data seperti
di draf).

---

## 5. Bug pada kode draf (semua harus diperbaiki)

| # | Masalah | Akibat |
| :-- | :--- | :--- |
| 1 | `declare_id!("Alamat_Program_Mainnet_AndaDisini")` | bukan base58 valid → tidak bisa dikompilasi |
| 2 | `amount_out` dari klien langsung ditransfer | **vault dikuras** (§3) |
| 3 | Hanya **satu** `transfer_checked` (komentar menyebut dua) | token masuk tidak pernah ditarik; saldo vault hanya berkurang |
| 4 | Urutan argumen `transfer_checked` tertukar | sumber/tujuan terbalik; `transfer_checked(token_program, source, mint, destination, authority, signers, amount, decimals)` |
| 5 | `signers` diisi `&[]` padahal authority = PDA | Token program menolak (`owner mismatch`) walau `invoke_signed` dipakai |
| 6 | `bump = data[16]` dari instruction data | penyerang memilih bump; PDA bisa salah alamat |
| 7 | `decimals = 9` hardcode; `amount_in` tidak dipakai | token ber-decimals lain salah total |
| 8 | `initialize_pool`/`add_liquidity` hanya `Ok(())` | pool tidak pernah ada; dashboard tidak bisa dipakai; lebih baik `Err(NotImplemented)` |

Tambahan: `transfer_checked` versi Token-2022 memakai urutan akun `[mint, source, destination, authority]`
(bukan `[source, destination, authority]` seperti `transfer`).

---

## 6. Wire format: biarkan tetap 18 byte / 12 akun

Contoh di `examples/mini-amm-native/` sengaja mempertahankan format yang sama dengan program
Anchor, sehingga `customSdk.ts` **tidak perlu ditulis ulang** — cukup ganti `programId`:

```text
swap (disc u8 = 2): [2, u64_le(amount_in), u64_le(min_amount_out), u8(x_to_y)]   = 18 B
akun: user, mint_x, mint_y, pool_state, vault_x, vault_y,
      fee_vault_x, fee_vault_y, user_token_x, user_token_y,
      token_program_x, token_program_y                                          = 12 akun
```

`processor.rs` membaca `amount` vault langsung dari data akun (offset 64..72) sehingga tidak
butuh crate SPL sama sekali — ini yang membuat biner bisa tetap kecil.

---

## 7. Dashboard: sudah ada, tinggal dipakai

Form yang diminta (nama, simbol, deskripsi, **upload logo**, virtual SOL) **sudah ada** di
`src/App.tsx` + `scripts/pinataDevApi.ts`. Dua hal yang perlu diketahui:

1. **Kontrak API berbeda dari contoh draf.** Draf mengirim `FormData`:

   ```ts
   const formData = new FormData();
   formData.append('file', logoFile);
   await fetch('/api/pinata/upload', { method: 'POST', body: formData }); // ✘ 400/415
   ```

   Endpoint di repo ini menerima **JSON** (`scripts/pinataDevApi.ts:44-46,114`):

   ```ts
   const base64 = await fileToBase64(logoFile); // tanpa prefix "data:image/...;base64,"
   const res = await fetch('/api/pinata/upload', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       fileName: logoFile.name,
       base64,
       name: tokenName,
       symbol: tokenSymbol,
       description,
     }),
   });
   const { imageUri, metadataUri } = await res.json();
   ```

   Kode status: `400` input tidak valid, `405` method salah, `413` body terlalu besar,
   `502` Pinata menolak, `503` kredensial belum diset.

2. **Middleware hanya hidup di `npm run dev`.** `npm run build` + `preview` tidak membawa
   `/api/pinata/*`. Untuk produksi, pindahkan handler yang sama ke backend dan simpan
   `PINATA_JWT` di sisi server (jangan pernah berprefix `VITE_`).

---

## 8. Kalau tetap ingin folder proyek baru

Yang **perlu** disalin (dan yang tidak):

| Perlu | Tidak perlu |
| :--- | :--- |
| `src/sdk/customSdk.ts` (layout, builder instruksi, deserializer) | `programs/mini-amm/` (Anchor) |
| `src/sdk` rumus AMM untuk estimasi tampilan | `.anchor/`, `Anchor.toml`, IDL |
| `src/App.tsx`, `main.tsx`, `index.css`, `tailwind.config.js`, `vite.config.ts` | `node_modules`, `dist`, `target` |
| `scripts/pinataUpload.ts`, `scripts/pinataDevApi.ts` | dependency `@coral-xyz/anchor` (tidak dipakai) |
| `tests/` (verifikasi layout & math) | — |
| `scripts/deployCost.ts`, `launchCost.ts`, `walletCost.ts` | — |

Langkah minimal:

```bash
mkdir mini-amm-native && cd mini-amm-native
# salin file frontend + sdk + scripts seperti tabel di atas
# lalu buat crate native:
mkdir -p programs/mini-amm-native/src
# salin examples/mini-amm-native/{Cargo.toml,src/*} -> programs/mini-amm-native/
cargo build-sbf --release --manifest-path programs/mini-amm-native/Cargo.toml
ls -l target/deploy/*.so            # ukur dulu, baru hitung rent
```

Jangan mencampur `declare_id!` lama dengan program baru: program ID baru = PDA pool baru =
pool lama tidak bisa dipakai lagi.

---

## 9. Checklist sebelum deploy native

- [ ] Matematika dihitung **on-chain** dari saldo vault + `virtual_reserves_x` di state.
- [ ] `min_amount_out` dari klien hanya sebagai batas bawah.
- [ ] Bump diambil dari state dan divalidasi `create_program_address` (bukan dari data).
- [ ] Vault diverifikasi: owner = program Anda, mint cocok, authority = PDA pool.
- [ ] Program token diverifikasi = Token-2022 / Tokenkeg sesuai mint.
- [ ] `require_keys_eq!` pada `pool_state` = PDA `[b"pool", mint_x, mint_y]`.
- [ ] `transfer_checked` dipanggil **dua kali** (masuk & keluar) dengan `signers` berisi PDA.
- [ ] Instruksi yang belum diimplementasikan mengembalikan error, bukan `Ok(())`.
- [ ] Ukur `.so` dan hitung rent sebelum menyebut angka "0.15 SOL" ke siapa pun.
- [ ] Uji di devnet dengan dana kecil; tidak ada `remove_liquidity` di desain ini.
