# Contoh: program perantara (interposer) memakai PDA untuk memanggil mini-amm

Kode referensi untuk **Bagian 3** di [`docs/PDA-INTERPOSING-GUIDE.md`](../../docs/PDA-INTERPOSING-GUIDE.md).

> **Status: belum dikompilasi.** Lingkungan penyusunan dokumen tidak memiliki Rust/SBF
> toolchain (`npm run toolchain:check` → `cargo-build-sbf tidak ada`), jadi file di sini
> adalah contoh yang ditelaah manual, bukan binary teruji. Kompilasi dan uji di workspace
> Anda sendiri sebelum dipakai dengan dana nyata.

## Kenapa terpisah dari workspace

`Cargo.toml` di folder ini memuat `[workspace]` kosong, sehingga crate ini **tidak** ikut
`members = ["programs/*"]` milik repo dan tidak ikut `anchor build` / `anchor deploy` repo.
Folder `examples/` juga tidak dirujuk `Anchor.toml`.

## Memakai di program Anda sendiri

1. Buat project Anchor baru (`anchor init interposer`).
2. Salin `src/lib.rs` ke `programs/<nama>/src/lib.rs` project tersebut.
3. Ganti `declare_id!` dengan program ID Anda (`anchor keys sync`).
4. Sesuaikan `MINI_AMM_PROGRAM_ID` bila Anda memakai deployment mini-amm lain.
5. Pastikan dependency sama dengan mini-amm: `anchor-lang 0.31.1`, `anchor-spl 0.31.1`
   (`features = ["token", "token_2022"]`).

## Tiga instruksi

| Instruksi | Kegunaan | Catatan |
| :--- | :--- | :--- |
| `swap_lewat_pda` | Swap dari saldo yang sudah ada di ATA milik PDA | ATA PDA harus dibuat & didanai lebih dulu |
| `swap_sol_lewat_pda` | Pengguna bayar SOL → dibungkus jadi WSOL milik PDA → swap X→Y | Hanya bila token X = WSOL |
| `claim_fee_lewat_pda` | Tarik fee creator 0.06% | Hanya jika PDA adalah `pool.creator` |

## Akun yang harus dikirim pemanggil

`TumpangSwap` (13 akun, urutan mengikuti struct — Anchor memetakan berdasarkan **urutan**):

```text
payer, pda_authority, mint_x, mint_y, pool_state, vault_x, vault_y,
fee_vault_x, fee_vault_y, pda_token_in, pda_token_out,
token_program_x, token_program_y, mini_amm_program, system_program
```

(`mini_amm_program` dan `system_program` wajib ikut; System Program hanya terpakai pada
`swap_sol_lewat_pda`.)

## Yang TIDAK dilakukan contoh ini

- Tidak membuat ATA milik PDA. Buat sekali dengan `CreateIdempotent` ATA (payer sebaiknya
  wallet pengguna, bukan PDA) sebelum swap pertama.
- Tidak menghitung `min_amount_out`. Hitung dari kurva + toleransi slippage di klien atau
  di program Anda; jangan kirim 0.
- Tidak mengurus penutupan ATA WSOL (`CloseAccount`) untuk mencairkan SOL setelah swap.
- Tidak menangani Token-2022 `TransferFee`/`TransferHook` di sisi mint proyek.

## Menguji

- Envelope CPI (payload, urutan akun, PDA) tanpa validator:
  `npx tsx tests/verifyCpiPda.ts` di root repo.
- Eksekusi penuh: `solana-test-validator` + `anchor build && anchor deploy` untuk program
  ini dan mini-amm, lalu `anchor test`.
