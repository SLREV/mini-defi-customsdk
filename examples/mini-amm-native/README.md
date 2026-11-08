# Mini AMM versi Native Rust (tanpa Anchor)

Contoh referensi untuk menjawab rencana "buang Anchor → biner < 15 KB → matematika di frontend".
Dokumen audit lengkap: [`docs/NATIVE-SLIM-PROGRAM.md`](../../docs/NATIVE-SLIM-PROGRAM.md).

> **Status: belum dikompilasi.** Sandbox penyusunan tidak punya Rust/SBF toolchain, jadi ukuran
> `.so` belum terukur dan kode ini belum diuji on-chain. Perlakukan sebagai acuan desain.

## Apa yang beda dari draf "stateless router"

| Draf | Contoh ini |
| :--- | :--- |
| `amount_out` dari klien langsung ditransfer | Harga dihitung **on-chain**; `min_amount_out` hanya batas bawah |
| Tanpa state (virtual reserves dari klien) | State pool 81 B (~0.0015 SOL) menyimpan `vault_x`, `vault_y`, `virtual_reserves_x`, `bump` |
| Bump dibaca dari instruction data | Bump dari state + divalidasi `create_program_address` |
| `Ok(())` untuk instruksi kosong | `Err(NotImplemented)` agar klien tidak salah paham |
| `spl-token-2022` sebagai dependency | `transfer_checked` dibangun manual (`data = [12, amount_le, decimals]`) → biner lebih kecil |
| Decimals hardcode 9 | Dibaca dari akun mint (offset 44) |

## Kompatibel dengan SDK yang sudah ada

Format `swap` identik dengan program Anchor repo ini, jadi `src/sdk/customSdk.ts` bisa dipakai
apa adanya — cukup ganti `programId`:

```text
data : [u8(2), u64_le(amount_in), u64_le(min_amount_out), u8(x_to_y)]   18 B
akun : user, mint_x, mint_y, pool_state, vault_x, vault_y,
       fee_vault_x, fee_vault_y, user_token_x, user_token_y,
       token_program_x, token_program_y                              12 akun
```

`initialize_pool` di contoh ini **belum** kompatibel dengan `buildCreatePoolTx` (SDK membuat
17 akun termasuk LP mint, 4 vault, ATA LP). Contoh hanya membuat akun state pool; vault harus
sudah ada sebagai ATA milik PDA pool.

## Yang belum diimplementasikan

- `add_liquidity` dan `claim_creator_fee` → `Err(NotImplemented)`.
- Pembuatan vault/ATA (dilakukan klien atau instruksi terpisah).
- Metadata Token-2022 (tetap dibuat oleh SDK di sisi klien — tidak perlu di program).
- `close`/`remove_liquidity` — tidak ada, sama seperti program Anchor.

## Membangun

```bash
cargo build-sbf --release --manifest-path examples/mini-amm-native/Cargo.toml
ls -l target/deploy/mini_amm_native.so
npm run cost:deploy -- --size <ukuran_byte>     # hitung rent dari ukuran nyata
```

Catatan `Cargo.toml`: `[profile.release]` hanya berlaku bila file itu root workspace. Bila crate
ini dipindah ke dalam project lain, pastikan profilnya ada di root project tersebut.

## Sebelum dipakai dengan dana nyata

1. Audit on-chain math & validasi akun (checklist di dokumen §9).
2. Uji di devnet: swap X→Y dan Y→X, token dengan decimals berbeda, saldo tidak cukup,
   slippage, dan pool yang dipalsukan.
3. Ukur ukuran `.so`, hitung rent, baru bicara angka ke pengguna.
