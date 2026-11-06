# Solana Token-2022 Launchpad & Virtual Liquidity AMM (`TokenInterface` + `TransferChecked`)

Production-ready boilerplate untuk **DeFi Token-2022 Launchpad & Virtual Liquidity Constant Product AMM** menggunakan **Anchor 0.31+ (Rust)** + **Pure `@solana/web3.js` & `@solana/buffer-layout` (TypeScript)** + **Vite + React + TailwindCSS** — **tanpa SDK pihak ketiga**.

## Keunggulan Arsitektur Token-2022 & Virtual Liquidity

1. **Native Token-2022 Extensions (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)**:
   - Menginisialisasi `MetadataPointer` (`u8(39), u8(0)`) menunjuk langsung ke akun Mint itu sendiri (*self-referential metadata*).
   - Menyimpan `name`, `symbol`, dan `uri` via `spl_token_metadata_interface::initialize` serta menyimpan link sosial (`telegram`, `twitter`) **100% on-chain di dalam TLV Mint Token-2022** via `updating_field`!
2. **Hybrid Multi-Program `TokenInterface` (`token_program_x`, `token_program_y`, `token_program_lp`)**:
   - Memungkinkan pasangan lintas-program antara **WSOL (`Tokenkeg...` SPL Legacy)** dan **Token Proyek Baru (`TokenzQd...` Token-2022)** menggunakan `token_interface::transfer_checked`!
3. **Virtual Liquidity Sejak Detik ke-0**:
   - Kreator menyetor 100% token fisik ke `vault_y` tanpa perlu menyetor modal SOL awal (`vault_x.amount = 0`, `virtual_reserves_x = 30 SOL`), sementara kurva AMM menghitung cadangan efektif `vault.amount + virtual_reserves` secara langsung dari saldo vault on-chain (aman terhadap ekstensi `TransferFee` Token-2022!).

## Spesifikasi Biner (`@solana/buffer-layout`)

| Instruksi / Akun | Discriminator | Ukuran | Layout Biner |
| :--- | :--- | :--- | :--- |
| `Token-2022 MetadataPointer::Init` | `[39, 0]` | `66 B` | `[u8(39), u8(0), Pubkey(authority), Pubkey(metadataAddress)]` |
| `Token-2022 InitializeMint2` | `u8 = 20` | `67 B` | `[u8(20), u8(decimals), Pubkey(mintAuth), u8(freezeOpt), Pubkey(freezeAuth)]` |
| `Token-2022 TokenMetadata::Init` | `sha256[..8]` | Variabel | `8B disc + BorshString(name) + BorshString(symbol) + BorshString(uri)` |
| `Token-2022 TokenMetadata::UpdateField` | `sha256[..8]` | Variabel | `8B disc + u8(3) + BorshString(key) + BorshString(value)` |
| `AMM initialize_pool` | `u8 = 0` | `17 B` | `[u8(0), u64_le(initial_real_token_y), u64_le(virtual_reserves_x)]` |
| `AMM add_liquidity` | `u8 = 1` | `25 B` | `[u8(1), u64_le(amount_x), u64_le(amount_y), u64_le(min_lp_out)]` |
| `AMM swap` | `u8 = 2` | `18 B` | `[u8(2), u64_le(amount_in), u64_le(min_amount_out), u8(x_to_y)]` |
| `Account: PoolState` | `sha256("account:PoolState")[..8]` | `185 B` | `8B disc + 5*32B Pubkey + 2*8B u64(virtualX, virtualY) + 1B bump` |

## Perintah Menjalankan Proyek

```bash
npm install
npm test        # Menguji seluruh layout biner Token-2022 & Virtual Liquidity AMM
npm run build   # Type-check ketat TypeScript & build produksi Vite
npm run dev     # Menjalankan dashboard interaktif
anchor build    # Build smart contract Rust (membutuhkan Solana + Anchor CLI)
```
