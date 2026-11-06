# Solana Token-2022 Launchpad & Virtual Liquidity AMM (`TokenInterface` + `TransferChecked`)

Production-ready boilerplate untuk **DeFi Token-2022 Launchpad & Virtual Liquidity Constant Product AMM** menggunakan **Anchor 0.31+ (Rust)** + **Pure `@solana/web3.js` & `@solana/buffer-layout` (TypeScript)** + **Vite + React + TailwindCSS** — **tanpa SDK pihak ketiga**.

## Keunggulan Arsitektur Token-2022 & Virtual Liquidity

1. **Native Token-2022 Extensions (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)**:
   - Menginisialisasi `MetadataPointer` (`u8(39), u8(0)`) menunjuk langsung ke akun Mint itu sendiri (*self-referential metadata*).
   - Menyimpan `name`, `symbol`, dan `uri` via `spl_token_metadata_interface::initialize` serta menyimpan link sosial (`telegram`, `twitter`) **100% on-chain di dalam TLV Mint Token-2022** via `updating_field`!
   - Akun Mint didanai penuh untuk ukuran akhir (`234B + 4B TLV header + payload TokenMetadata`) **sebelum** `initialize` metadata dipanggil, sehingga proses realloc internal Token-2022 tidak gagal karena `InsufficientFundsForRent`.
2. **Hybrid Multi-Program `TokenInterface` (`token_program_x`, `token_program_y`, `token_program_lp`)**:
   - Memungkinkan pasangan lintas-program antara **WSOL (`Tokenkeg...` SPL Legacy)** dan **Token Proyek Baru (`TokenzQd...` Token-2022)** menggunakan `token_interface::transfer_checked`!
3. **Virtual Liquidity Sejak Detik ke-0**:
   - Kreator menyetor 100% token fisik ke `vault_y` tanpa perlu menyetor modal SOL awal (`vault_x.amount = 0`, `virtual_reserves_x = 30 SOL`).
   - Kurva AMM memakai **cadangan efektif** `vault.amount + virtual_reserves` yang dibaca langsung dari saldo vault on-chain (aman terhadap ekstensi `TransferFee` Token-2022).
   - **`virtual_reserves_y = 0` pada inisialisasi**: seluruh suplai token Y sudah berada di `vault_y`, sehingga token Y tidak dihitung dua kali. Dengan demikian `LP_awal = sqrt(virtual_reserves_x × initial_real_token_y) = sqrt(k_efektif)` konsisten dengan invariant `x · y = k`.

## Spesifikasi Biner (`@solana/buffer-layout`)

| Instruksi / Akun | Discriminator | Ukuran | Layout Biner |
| :--- | :--- | :--- | :--- |
| `Token-2022 MetadataPointer::Init` | `[39, 0]` | `66 B` | `[u8(39), u8(0), Pubkey(authority), Pubkey(metadataAddress)]` |
| `Token-2022 InitializeMint2` | `u8 = 20` | `67 B` | `[u8(20), u8(decimals), Pubkey(mintAuth), u8(freezeOpt), Pubkey(freezeAuth)]` |
| `Token-2022 TokenMetadata::Initialize` | `sha256[..8]` | Variabel | `8B disc + BorshString(name) + BorshString(symbol) + BorshString(uri)` |
| `Token-2022 TokenMetadata::UpdateField` | `sha256[..8]` | Variabel | `8B disc + u8(3 = Field::Key) + BorshString(key) + BorshString(value)` |
| `AMM initialize_pool` | `u8 = 0` | `17 B` | `[u8(0), u64_le(initial_real_token_y), u64_le(virtual_reserves_x)]` |
| `AMM add_liquidity` | `u8 = 1` | `25 B` | `[u8(1), u64_le(amount_x), u64_le(amount_y), u64_le(min_lp_out)]` |
| `AMM swap` | `u8 = 2` | `18 B` | `[u8(2), u64_le(amount_in), u64_le(min_amount_out), u8(x_to_y)]` |
| `Account: PoolState` | `sha256("account:PoolState")[..8]` | `185 B` | `8B disc + 5*32B Pubkey + 2*8B u64(virtualX, virtualY) + 1B bump` |

Anchor 0.31 mendukung **custom discriminator** 1 byte (`#[instruction(discriminator = [0])]`), sehingga payload instruksi AMM hanya 17/25/18 byte (bukan 24/32/25 byte) dan hemat ~21 byte per transaksi.

### Jumlah `AccountMeta` per Instruksi

| Instruksi | Akun | Keterangan |
| :--- | :--- | :--- |
| `initialize_pool` | 15 | `payer`, `token_x`, `token_y`, `pool_state`, `lp_mint`, `vault_x`, `vault_y`, `user_token_y`, `user_lp_token`, 3× token program, ATA program, system program, rent |
| `add_liquidity` | 13 | `user`, 2 mint, `pool_state`, `lp_mint`, 2 vault, 3 user token account, 3 token program |
| `swap` | 10 | `user`, 2 mint, `pool_state`, 2 vault, 2 user token account, 2 token program |

> `buildCreatePoolTx()` mengirim **2 instruksi** dalam satu transaksi: `CreateIdempotent` ATA token Y (wajib ada sebelum CPI `transfer_checked`) + `initialize_pool`. `buildAddLiquidityTx()` dan `buildSwapTx()` juga menyertakan pembuatan ATA idempotent (plus `SystemProgram.transfer` + `SyncNative` bila sisi input adalah WSOL).

## Struktur Proyek

```text
.
├── Anchor.toml                  # Konfigurasi Anchor (program mini_amm, devnet)
├── Cargo.toml                   # Workspace Rust (members = programs/*)
├── programs/
│   └── mini-amm/
│       ├── Cargo.toml
│       └── src/lib.rs           # Program AMM Token-2022 + Virtual Liquidity
├── src/
│   ├── App.tsx                  # Dashboard: launch token, pipeline, swap terminal
│   ├── main.tsx                 # Entry point Vite/React
│   ├── polyfills.ts             # Buffer polyfill (Browser)
│   ├── index.css                # Tailwind entry
│   └── sdk/customSdk.ts         # SDK biner murni (buffer-layout, tanpa SDK pihak ketiga)
├── tests/verifySdk.ts           # Uji layout biner, PDA, matematika AMM & deserialisasi
├── index.html
├── tailwind.config.js           # content: index.html + src/**/*.{ts,tsx}
├── tsconfig.json                # include: src, tests
└── vite.config.ts
```

## Perintah Menjalankan Proyek

```bash
npm install
npm test         # Uji seluruh layout biner Token-2022 & Virtual Liquidity AMM
npm run typecheck# Type-check ketat TypeScript (strict, noUnusedLocals)
npm run build    # Type-check + build produksi Vite (dist/)
npm run dev      # Dashboard interaktif di http://localhost:5173 (0.0.0.0)

anchor build     # Build smart contract Rust (butuh Solana + Anchor CLI 0.31.1)
anchor deploy    # Deploy program mini_amm ke devnet
```

Mode **Binary Sandbox** di dashboard menjalankan seluruh pipeline (mint Token-2022 → inisialisasi pool → swap → deserialisasi 185B `PoolState`) terhadap ledger in-memory dengan serialisasi instruksi yang **sama persis** seperti transaksi on-chain; mode **Devnet RPC** mengirim transaksi sungguhan melalui wallet (Phantom atau keypair ephemeral).

## Menjalankan di Devnet (Checklist)

Mode **Devnet RPC** hanya bisa dipakai setelah 3 hal ini terpenuhi:

1. **Program ter-deploy** pada program ID yang sama dengan `declare_id!` (`Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp`) di cluster devnet.
2. **Wallet punya SOL devnet** (minimal ~0.1 SOL untuk fee + rent ATA/mint/pool).
3. **RPC dapat diakses dari browser** (endpoint publik `api.devnet.solana.com` bisa kena rate-limit).

```bash
# 0. Toolchain
#    Solana CLI + Anchor CLI 0.31.1 (avm install 0.31.1 && avm use 0.31.1)

# 1. Wallet provider
solana-keygen new -o ~/.config/solana/id.json   # jika belum punya
solana config set --url devnet

# 2. Pastikan program ID di Anchor.toml & declare_id! sinkron dengan keypair program
anchor keys sync

# 3. Build & deploy program ke devnet
anchor build
anchor deploy --provider.cluster devnet

# 4. Verifikasi kesiapan devnet (RPC, program executable, saldo wallet)
npm run devnet:check
npm run devnet:check -- --airdrop     # minta 1 SOL devnet bila saldo kurang

# 5. Jalankan dashboard, pilih mode "Devnet RPC"
npm run dev
```

Tips pemakaian di dashboard:

- Tanpa Phantom, klik **Connect Mock Keypair** lalu **Airdrop 1 SOL** (chip saldo di header menampilkan saldo `SOL` live).
- Saldo < `0.05 SOL` akan ditolak lebih awal dengan pesan jelas, bukan gagal di tengah pipeline.
- Transaksi mint Token-2022 dikirim dengan `ComputeBudgetProgram.setComputeUnitLimit` eksplisit (600k CU) karena alokasi + realloc TLV metadata bisa melewati default 200k CU.
- Setiap transaksi diverifikasi dengan `confirmTransaction` yang memakai blockhash **yang sama** dengan yang ditandatangani, dan `err` hasil konfirmasi selalu dicek — transaksi gagal tidak akan dilaporkan sukses.
- Saat menjual token, ATA WSOL ditutup (`CloseAccount`) sehingga Anda menerima **SOL native**, bukan WSOL.

### Troubleshooting Devnet

| Gejala | Penyebab & solusi |
| :--- | :--- |
| `Attempt to load a program that does not exist` | Program belum ter-deploy di devnet / program ID tidak sama dengan `declare_id!`. Jalankan `anchor keys sync` lalu `anchor deploy --provider.cluster devnet`. |
| `Saldo SOL wallet tidak cukup…` | Klik **Airdrop 1 SOL** (mock keypair) atau hubungkan Phantom berisi SOL devnet, atau faucet.solana.com. |
| `RPC … menolak karena rate-limit (429)` | Isi `VITE_RPC_ENDPOINT` di file `.env` (salin dari `.env.example`) dengan RPC devnet lain (Helius/QuickNode). |
| `Airdrop gagal` | Rate limit faucet RPC publik — pakai faucet.solana.com atau RPC berbayar. |
| `Blockhash kedaluwarsa` | Kirim ulang; pipeline selalu mengambil blockhash baru sebelum tanda tangan. |
| Transaksi sukses tapi saldo token 0 | Cek `Telemetry → initialize_pool (17B)` dan pastikan program yang dipanggil adalah versi terbaru (`anchor upgrade` bila perlu). |

## Catatan Perbaikan Terakhir

- Struktur file dipulihkan ke layout yang diharapkan tooling (`src/`, `tests/`, `programs/mini-amm/`) sehingga `tsc`, `npm test`, `npm run build`, dan `anchor build` berjalan.
- `index.html` sebelumnya memuat bundle hashed (`/assets/index-*.js`) yang tidak ada di repo (halaman blank); sekarang memuat `/src/main.tsx`. Artefak build lama di root dihapus (di-generate ulang ke `dist/`, sudah di-.gitignore).
- `Cargo.toml` root kini workspace Rust dan konfigurasi program dipindah ke `programs/mini-amm/Cargo.toml`; `Anchor.toml` diperbarui (fitur `resolution` yang sudah usang dihapus, script test ditambahkan).
- `virtual_reserves_y` diset **0** (sebelumnya `initial_real_token_y`, membuat token Y terhitung dua kali dan suplai LP tidak konsisten dengan `k`).
- Constraint vault diperketat (`token::mint`, `token::authority = pool_state`) pada `add_liquidity` dan `swap`.
- `buildCreatePoolTx()` kini membuat ATA token Y lebih dulu (sebelumnya transaksi gagal `AccountNotInitialized` bila pengguna belum punya ATA).
- Dashboard: kegagalan swap tidak lagi ditandai `SUCCESS`, dan estimasi quote pembelian awal memakai cadangan efektif yang benar.
- Uji tambahan: edge-case parser/matematika, ukuran transaksi, dan konsistensi `LP_awal = sqrt(k)`.

### Perbaikan jalur Devnet

- `signAndDispatch` sebelumnya mengambil blockhash **baru setelah** transaksi dikirim dan **tidak pernah memeriksa** `confirmation.value.err` → transaksi gagal dilaporkan sukses. Sekarang blockhash dipakai konsisten untuk sign + confirm dan `err` selalu dicek.
- Pesan error RPC/preflight diterjemahkan (`program belum ter-deploy`, saldo kurang, rate-limit, blockhash kedaluwarsa, ditolak wallet) termasuk 3 log terakhir program.
- Compute unit limit eksplisit untuk transaksi clone (600k CU) dan AMM (300k CU).
- Guard saldo devnet (< 0.05 SOL ditolak lebih awal) + chip saldo + tombol **Airdrop 1 SOL** untuk wallet mock.
- Endpoint RPC bisa dioverride via `VITE_RPC_ENDPOINT` (`.env.example`), host RPC ditampilkan di header.
- Swap jual sekarang meng-unwrap WSOL → SOL native (`CloseAccount`, opsi `unwrapWsol` di SDK).
- `scripts/devnetPreflight.ts` (`npm run devnet:check`): cek RPC, status program executable, saldo wallet, airdrop opsional, dan artefak `target/deploy/mini_amm.so`.
