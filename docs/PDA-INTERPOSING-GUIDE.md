# Panduan Terverifikasi: Lokal → Mainnet → CPI lewat PDA

Dokumen ini adalah versi **yang sudah dicek langsung terhadap kode** dari draf panduan
"PDA — jalankan lokal, deploy mainnet, panggil lewat PDA". Setiap klaim diberi status:
`✔ terverifikasi`, `⚠ perlu koreksi`, atau `✘ salah`.

- Basis: commit `1b531ae` (`programs/mini-amm/src/lib.rs` 974 baris, SDK 2090 baris).
- Yang benar-benar dijalankan saat dokumen ini dibuat:
  `npm install`, `npm test` (lulus semua), `npm run toolchain:check`, dan
  `npx tsx tests/verifyCpiPda.ts` (baru, lulus).
- Yang **tidak** bisa dijalankan di lingkungan ini: `anchor build` / `cargo` / deploy
  (tidak ada Rust + Agave/Solana CLI). Bagian yang bergantung itu ditandai jelas.
- Dokumen ini bukan audit. Program belum diaudit dan belum pernah diuji dengan transaksi
  mainnet sungguhan.

> **Jawaban singkat "apakah bisa jalan lewat PDA?": ya, untuk `swap` — tanpa mengubah program
> AMM sama sekali.** Rincian per instruksi, syarat, dan hal yang tidak mungkin ada di
> [§3.12](#312-kesiapan-repo-ini-untuk-jalur-pda-audit-otomatis), diperiksa otomatis oleh
> `tests/verifyPdaReadiness.ts`.

---

## 0. Hasil pemeriksaan draf (baca ini dulu)

| # | Klaim di draf | Status | Bukti / koreksi |
| :-- | :--- | :--- | :--- |
| 1 | Anchor 0.31+ dengan **custom discriminator 1 byte** | ✔ | `Anchor.toml:2` (`anchor_version = "0.31.1"`), `lib.rs:34,118,222,387` (`#[instruction(discriminator = [0..3])]`) |
| 2 | Biner murni `@solana/buffer-layout`, tanpa SDK pihak ketiga | ✔ | `src/sdk/customSdk.ts:230-300` (layout manual), `package.json` (tanpa `@coral-xyz/anchor`, tanpa `@solana/spl-token`) |
| 3 | Token-2022 dengan metadata self-referential | ✔ | `README.md:1-20`, `lib.rs` (`MetadataPointer` → mint sendiri) |
| 4 | `PoolState` 281 byte | ✔ | `lib.rs:594-606`, `POOL_STATE_SIZE = 281` (`customSdk.ts:100`) |
| 5 | Node.js disarankan ≥ 22 | ⚠ | `package.json` `engines.node >= 18`. Vite 6 memang butuh Node 18+, 22 LTS paling aman — bukan syarat keras. |
| 6 | `npm run toolchain:check` | ✔ | `package.json:18` → `scripts/toolchainDoctor.ts`. Di mesin tanpa SBF compiler keluarannya: `⚠ cargo-build-sbf tidak ada` (peringatan, exit 0). |
| 7 | `npm test` memvalidasi layout, AMM math, PDA | ✔ | Dijalankan di sini: semua suite lulus. Kini ditambah `tests/verifyCpiPda.ts`. |
| 8 | Frontend di `http://localhost:5173` | ✔ | `package.json:11` (`vite --host 0.0.0.0 --port 5173`), `vite.config.ts` (`server.port: 5173`) |
| 9 | "Pastikan `target/deploy/mini_amm-keypair.json` sudah ada, lalu `anchor keys sync`" | ✘ | Urutannya terbalik & berbahaya. Di clone baru keypair **belum ada**; `anchor keys sync` *membuat keypair baru* (Anchor: "Lazily initializes the keypair file with a new key if it doesn't exist"), lalu **menulis ulang `declare_id!` dan `Anchor.toml`** → program ID berubah, semua PDA pool lama tidak berlaku. Lihat §2.1. |
| 10 | `anchor deploy --provider.cluster mainnet` | ✔ | Anchor 0.31.1 `Cluster::from_str` menerima `m` dan `mainnet` (juga URL `http…`). **`mainnet-beta` justru DITOLAK** oleh parser itu. Kunci `[programs.*]` di `Anchor.toml` juga harus `mainnet`, bukan `mainnet-beta`. |
| 11 | `VITE_RPC_ENDPOINT=https://solana.com` | ✘ | `https://solana.com` adalah situs web, **bukan endpoint RPC JSON-RPC**. Default repo: `https://api.mainnet-beta.solana.com` (`src/App.tsx:92`), yang rate-limited. Pakai RPC milik sendiri (Helius/QuickNode/Triton). |
| 12 | Butuh `VITE_MAINNET_AMM_PROGRAM_ID` | ✔ | `src/App.tsx:94`; mode MAINNET juga dikunci sampai wallet Phantom terhubung + risiko disetujui (`src/App.tsx:387,408`) |
| 13 | `swap` butuh **12 akun**, urutan `user → token_x → token_y → pool_state → vault_x → vault_y → fee_vault_x → fee_vault_y → user_token_x → user_token_y → token_program_x → token_program_y` | ✔ | `lib.rs:793-873`; dicocokkan otomatis oleh `tests/verifyCpiPda.ts` (membaca struct langsung dari `lib.rs`, gagal bila struct berubah) |
| 14 | Payload swap 18 byte `[u8(2), u64_le, u64_le, u8]` | ✔ | `lib.rs:222-227`, `customSdk.ts:275-290`, diuji byte-per-byte |
| 15 | `pool_state` sebagai `AccountMeta::new` (writable) | ⚠ | Tidak salah, tapi berlebihan: `Swap<'info>` tidak menandai `pool_state` sebagai `mut` dan SDK mengirimnya **read-only** (`customSdk.ts:1786`). Pakai read-only agar cocok dengan referensi. |
| 16 | `let seeds = &[b"otoritas_pda_anda", &[pda_bump]];` | ✘ | **Tidak bisa dikompilasi**: elemen array bertipe beda (`&[u8; 18]` vs `&[u8; 1]`). Perbaikan di §3.5. |
| 17 | "hemat ~21 byte per transaksi" | ⚠ | Penghematannya **7 byte per instruksi** (8 → 1 byte). Angka 21 hanya berlaku untuk transaksi berisi 3 instruksi AMM. |
| 18 | Cukup 12 akun itu untuk swap lewat PDA | ⚠ | Itu hanya akun *CPI-nya*. Program Anda masih wajib: (a) memastikan ATA milik PDA **sudah ada**, (b) membungkus SOL → WSOL lebih dulu bila sisi input adalah SOL, (c) mengunci mint/pool, (d) menegakkan `min_amount_out` sendiri. Lihat §3.2, §3.7. |
| 19 | "Pakai PDA jadi tidak perlu sewa 1–3 SOL untuk deploy mainnet" | ✘ | Rent = `(128 + ukuran) × 6960` lamports per akun, berlaku juga untuk PDA; deploy membayar akun `ProgramData` milik loader (150 KB ≈ 1.07 SOL, puncak ~2.14 SOL). PDA justru menambah rent (2 ATA ≈ 0.0041 SOL). Lihat §2.6 + `npm run cost:deploy`. |
| 20 | "Zero rent: menumpang (menulis/realloc) PDA milik SDK publik" | ⚠/✘ | Stateless wrapper memang **benar-benar tanpa rent baru**. Tapi menulis/menambah data ke akun milik program lain **mustahil** — hanya program pemilik yang boleh mengubah data & lamport. mini-amm tidak punya `realloc`/`close`/`remaining_accounts` dan `PoolState` fixed 281 B. Lihat §3.13 + audit H1–H6. |

---

## 1. Menjalankan proyek di komputer lokal

```bash
cd mini-defi-customsdk
npm install            # Node >= 18; 22 LTS disarankan
npm run toolchain:check # diagnostik SBF/Agave — boleh dilewati bila belum ada Solana CLI
npm test               # layout biner, math AMM, PDA, Pinata, claim, network, CPI envelope
npm run typecheck      # tsc --noEmit (strict)
npm run dev            # http://localhost:5173 (bind 0.0.0.0)
```

Tanpa `solana-test-validator`: mode **Binary Sandbox** menjalankan seluruh pipeline pada
ledger in-memory dengan serialisasi instruksi yang sama seperti transaksi on-chain.
Klik **Connect Mock Keypair** → **Launch Token-2022 & Virtual Pool** → **Swap**.

Yang diuji `npm test` (8 suite): `verifySdk` (layout 281 B, math, PDA), `verifyPinata`,
`verifyPinataApi`, `verifyClaimCreator`, `verifyToolchain`, `verifyTradeUtils`,
`verifyNetwork`, plus `verifyCpiPda` (baru, lihat §3.9).

> Catatan lingkungan: `npm test` membaca **repo tempat ia dijalankan**. Bila
> `target/deploy/mini_amm-keypair.json` ada, ia harus menunjuk program ID yang sama dengan
> `declare_id!`; sebelum pernah build, keypair tidak ada dan tes tetap lulus
> (`toolchain:check` mencetak `deploy keypair: belum ada (dibuat saat build pertama)`).

---

## 2. Menuju mainnet (mainnet-beta)

### 2.1 Keypair program — urutan yang benar (ini bagian paling rawan)

Fakta dari source Anchor 0.31.1 (`cli/src/config.rs`, `Program::keypair_file`):
keypair di `target/deploy/<lib_name>-keypair.json` **dibuat otomatis bila belum ada**, dan
`anchor keys sync` menulis ulang `declare_id!` **serta** entri `[programs.*]` di `Anchor.toml`
mengikuti isi keypair itu. Program ID = public key keypair tersebut. Konsekuensinya:

```text
Program ID  ==  pubkey(target/deploy/mini_amm-keypair.json)
declare_id! harus sama, kalau tidak → DeclaredProgramIdMismatch (0x1004 / 4100)
semua PDA pool/vault/lp diturunkan dari Program ID → ganti ID = ganti semua alamat
```

Tiga skenario:

**A. Anda ingin tetap memakai ID repo `DnW4iMWC5gCjPZkk2kkdTrY5uybW3w6r6aLdS6meynMn`**
(mis. agar sama dengan devnet yang sudah ada) — keypair-nya **wajib** Anda punya. File itu
di-`.gitignore` (`target/`), jadi dari clone ZIP/baru ia tidak ada:

```bash
# WAJIB: pulihkan dulu dari backup Anda
ls -l target/deploy/mini_amm-keypair.json
solana-keygen pubkey target/deploy/mini_amm-keypair.json
#   harus mencetak DnW4iMWC5gCjPZkk2kkdTrY5uybW3w6r6aLdS6meynMn
```

Bila file itu hilang, ID tersebut **tidak bisa** dipakai lagi (tidak ada cara menurunkan
private key dari public key). Jangan jalankan `anchor keys sync` sebelum file itu ada.

**B. Anda membuat program mainnet baru (paling umum)** — buat keypair sendiri, sadar bahwa
ID-nya baru:

```bash
solana-keygen new -o target/deploy/mini_amm-keypair.json   # simpan & backup!
solana-keygen pubkey target/deploy/mini_amm-keypair.json   # catat ID baru
```

**C. Menyelaraskan setelah build** (bila `declare_id!`/`Anchor.toml` berbeda dari keypair):

```bash
# tambahkan dulu entri mainnet agar ikut disinkronkan (kunci harus "mainnet")
#   [programs.mainnet]
#   mini_amm = "<ID Anda>"
anchor keys sync
anchor build           # WAJIB rebuild: ID ditanam ke dalam binary
```

> `anchor keys sync` hanya memperbarui entri `[programs.*]` yang **sudah ada**. Kunci
> `[programs.mainnet-beta]` akan membuat `Anchor.toml` gagal di-parse (`Cluster` hanya
> mengenal `localnet`/`devnet`/`testnet`/`mainnet`/`m`/`d`/`t`/`l` atau URL `http…`).

### 2.2 Tambahkan cluster mainnet ke `Anchor.toml`

```toml
[programs.mainnet]
mini_amm = "<ID program mainnet Anda>"
```

Lalu build bersih:

```bash
anchor clean && anchor build
ls -l target/deploy/mini_amm.so
```

Build **wajib** dengan toolchain yang mendukung `edition2024`: `solana_version = "4.4.1"`
di `Anchor.toml`, Agave ≥ 4.0 (rustc ≥ 1.85). Kalau `npm run toolchain:check` masih
`⚠ cargo-build-sbf tidak ada`, `anchor build` akan gagal sebelum kompilasi.

### 2.3 Deploy dan biaya nyata

```bash
anchor deploy --provider.cluster mainnet
# alternatif eksplisit: --provider.cluster https://<rpc-anda>
# "mainnet-beta" DITOLAK oleh parser Anchor 0.31.1
```

`anchor deploy` memanggil `solana program deploy --program-id target/deploy/mini_amm-keypair.json`.
Biaya = rent-exempt akun `ProgramData`, rumus Solana `(128 + ukuran) × 6960 lamports`:

| Ukuran `.so` | Rent final | Perkiraan total saat deploy* |
| :--- | :--- | :--- |
| 100 KB | 0.714 SOL | ~1.43 SOL |
| 200 KB | 1.427 SOL | ~2.85 SOL |
| 300 KB | 2.139 SOL | ~4.28 SOL |
| 400 KB | 2.852 SOL | ~5.71 SOL |

\* `solana program deploy` membuat buffer account berukuran sama, jadi dana yang harus ada
sesaat deploy ≈ 2× rent final + fee. Ukur `.so` Anda, jangan pakai angka tabel:

```bash
npm run cost:deploy                 # membaca target/deploy/mini_amm.so
npm run cost:deploy -- --size 153600
```

### 2.6 Mitos "pakai PDA jadi tidak perlu sewa 1–3 SOL"

**Tidak benar.** Rent di Solana adalah **deposit per byte pada akun**, bukan biaya per
transaksi atau per tanda tangan:

```text
rent_exempt = (128 + ukuran_data_byte) × 3480 lamports/byte-tahun × 2 tahun
            = (128 + ukuran) × 6960 lamports
```

Rumus itu berlaku sama untuk akun milik keypair, akun **PDA**, maupun akun milik BPF loader.
PDA tidak mengecualikan apa pun.

Saat `anchor deploy`, yang dibayar adalah dua akun milik **loader** — bukan akun program Anda:

| Akun | Ukuran | Keterangan |
| :--- | :--- | :--- |
| `Program` | 36 B | 0.00114 SOL |
| `ProgramData` | ukuran `.so` + 45 B | ~0.00713 SOL per 1 KB binary |
| buffer deploy | = `ProgramData` | dipakai sementara, kembali saat sukses |

Angka nyata (`npm run cost:deploy`, sudah diuji di `tests/verifyDeployCost.ts`):

| Ukuran `.so` | Rent final (terkunci) | Puncak dana saat deploy |
| :--- | :--- | :--- |
| 100 KB | 0.7150 SOL | 1.4290 SOL |
| 150 KB | 1.0714 SOL | 2.1417 SOL |
| 250 KB | 1.7841 SOL | 3.5671 SOL |
| 400 KB | 2.8532 SOL | 5.7052 SOL |

Jadi estimasi Anda "1–3 SOL" memang wajar — **yang keliru hanya anggapan bahwa PDA
menghapusnya**. Rent itu deposit, bukan fee: secara teori bisa diambil lagi hanya dengan
`solana program close` (program mati dan tidak bisa dipakai lagi), jadi untuk produk yang
berjalan ia praktis menjadi modal terkunci.

**PDA justru menambah** kebutuhan rent, bukan mengurangi:

| Pos | Ukuran | Rent |
| :--- | :---: | :--- |
| Per pool (`initialize_pool`) | 289 + 82 + 4×165 + 165 B | **0.0146 SOL** |
| \+ 2 ATA milik PDA (untuk interposer) | 2×165 B | +0.0041 SOL → **0.0186 SOL** |
| Mint Token-2022 (MetadataPointer + metadata) | ~419 B | **0.0038 SOL** |

Repo ini **tidak punya** instruksi `close`/`remove_liquidity`, jadi rent pool/vault tidak
bisa diklaim kembali. Setiap pool uji-coba di mainnet = 0.0146 SOL yang hilang permanen.

#### Yang benar-benar menghemat modal

| Cara | Penghematan (angka nyata) |
| :--- | :--- |
| **Deploy sekali, banyak pool** (model repo ini) | biaya deploy tidak berulang; 10 pool tetap 1× deploy |
| **Uji di devnet dulu** | SOL devnet gratis lewat `solana airdrop` |
| **Kecilkan `.so`** (`opt-level = "z"`, `strip = true`, buang dependency tak terpakai) | setiap **10 KB ≈ 0.071 SOL** |
| **`--max-len` = ukuran `.so` sebenarnya** | hindari padding yang tidak dipakai |
| **Deploy gagal → `solana program close <BUFFER>`** | kembalikan rent buffer (bisa >1 SOL) |
| **Jangan bikin pool/mint uji di mainnet** | 0.0146 SOL per pool, 0.0038 SOL per mint |
| **Tidak ada akun IDL on-chain** | `anchor deploy` 0.31.1 hanya menulis `target/idl/*.json` lokal → 0 rent IDL |

PDA tetap berguna, hanya bukan untuk ini: ia menghilangkan keypair otoritas yang harus
dikelola, menghilangkan satu tanda tangan transaksi (5000 lamports/tanda tangan), dan memberi
alamat deterministik. Ia **tidak** menghapus rent — termasuk rent akun PDA itu sendiri kalau
PDA menyimpan data.

> Kalau target Anda semata-mata "hemat modal deploy": jangan deploy program AMM sendiri.
> Deploy sekali lalu pakai untuk semua token, atau bangun interposer di atas AMM yang sudah
> ada — konsekuensinya Anda mewarisi risiko dan biaya program pihak lain.

Wallet provider (`~/.config/solana/id.json`, lihat `Anchor.toml:32`) menjadi **upgrade
authority**. Untuk dana nyata, pertimbangkan memindahkan authority ke multisig
(`solana program set-upgrade-authority`) dan simpan keypair program di tempat aman.

### 2.4 Environment variable

```dotenv
# .env  (JANGAN commit; .gitignore sudah menutup .env)
VITE_RPC_ENDPOINT=https://api.devnet.solana.com
VITE_MAINNET_RPC_ENDPOINT=https://<RPC-mainnet-anda>      # bukan https://solana.com
VITE_MAINNET_AMM_PROGRAM_ID=<ID program mainnet Anda>
# VITE_DEVNET_AMM_PROGRAM_ID=   # opsional
```

Semua `VITE_*` ikut ter-bundle ke browser — jangan taruh secret. Restart Vite setelah
mengubah `.env`. Dashboard mengunci mode MAINNET sampai ID terisi, wallet Phantom
terhubung, dan centang persetujuan risiko aktif (`src/App.tsx:94,387,408`).

### 2.5 Verifikasi pasca-deploy (jangan dilewati)

```bash
solana program show <ID> --url https://<rpc-mainnet>
solana program dump <ID> /tmp/onchain.so --url https://<rpc-mainnet>
shasum -a 256 /tmp/onchain.so target/deploy/mini_amm.so   # harus sama
solana-keygen pubkey target/deploy/mini_amm-keypair.json   # == <ID>
grep -n 'declare_id!' programs/mini-amm/src/lib.rs         # == <ID>
```

Program devnet **tidak** otomatis ada di mainnet; pool, mint, dan saldo tidak ikut pindah.

---

### 2.7 Biaya membuat token (dan pool) lewat SDK ini

Dihitung dari jalur kode sebenarnya (`buildCloneTokenInstructions` → `buildCreatePoolTx`),
bukan perkiraan. Jalankan sendiri dengan nama/URI Anda: `npm run cost:launch`.

| Pos | Ukuran | Biaya |
| :--- | ---: | ---: |
| Mint Token-2022 (MetadataPointer + TokenMetadata, contoh 493 B) | 493 B | 0.004322 SOL |
| ATA token milik payer | 165 B | 0.002039 SOL |
| Fee tx#1 (2 tanda tangan: payer + keypair mint) | — | 0.000010 SOL |
| **Token saja** | | **0.006371 SOL** |
| PoolState | 289 B | 0.002902 SOL |
| LP mint | 82 B | 0.001462 SOL |
| vault_x, vault_y, fee_vault_x, fee_vault_y | 4×165 B | 0.008157 SOL |
| ATA LP + ATA token Y | 2×165 B | 0.004078 SOL |
| Fee tx#2 | — | 0.000005 SOL |
| **Token + pool** | | **0.022976 SOL** |

- Mode SPL legacy (tanpa metadata on-chain): token 0.003511 SOL → total 0.020115 SOL.
- Ukuran mint mengikuti panjang nama/simbol/URI/telegram/twitter; URI IPFS panjang
  menambah beberapa ratus byte (≈ 0.0007 SOL per 100 B).
- Priority fee tidak termasuk (tergantung jaringan); tambahkan
  `--cu-price 10000 --cu 200000` untuk mengikutsertakannya.
- Semua rent di atas **tidak bisa diklaim kembali** — program ini tidak punya `close`.

### 2.8 Memeriksa biaya wallet yang sudah bertransaksi

Sandbox pengembangan repo ini tidak punya akses RPC, jadi pemeriksaan riwayat harus
dijalankan di mesin Anda:

```bash
npm run cost:wallet -- --address <WALLET> --rpc https://<RPC-anda> --limit 50
npm run cost:wallet -- --address <WALLET> --rpc <RPC> --days 1        # 24 jam terakhir
```

Skrip menghitung `meta.fee` + lamports yang benar-benar dikunci pada akun yang **dibuat**
(`system.createAccount` top-level & inner, plus `associated-token-account` create — yang
idempoten hanya dihitung bila akunnya memang baru), lalu menandai transaksi yang memakai
Token-2022 / ATA / program mini-amm.

## 3. Menumpang (interposing) lewat PDA on-chain

### 3.1 Model mental tanda tangan

```text
Transaksi top-level        : ditandatangani wallet pengguna Anda
  └─ instruksi → program Anda        (ctx.accounts.pda_authority = AccountInfo PDA)
       └─ CPI → mini-amm             (invoke_signed → PDA menjadi SIGNER di frame ini)
            └─ CPI → token program   (mini-amm memakai `user`/PDA sebagai authority)
```

Kunci: mini-amm mendeklarasikan `user: Signer` (`lib.rs:794`). Anchor memeriksa
`is_signer` pada account info yang masuk **pada frame CPI**, dan `invoke_signed` yang
membuatnya benar. PDA tidak pernah menandatangani transaksi top-level — memang tidak bisa
(diuji di `tests/verifyCpiPda.ts` §4).

### 3.2 Prasyarat (yang tidak ada di draf, tapi wajib)

1. **ATA milik PDA sudah ada** untuk **kedua** mint (`CreateIdempotent`) — `swap` mewajibkan
   `user_token_x` dan `user_token_y` ada sekaligus, meskipun salah satunya tidak dipakai pada
   arah swap itu. Owner ATA = PDA, dan token program-nya harus benar. Bila belum ada,
   deserialisasi `InterfaceAccount<TokenAccount>` di sisi mini-amm gagal.
2. **Saldo**: PDA harus punya saldo token input. Untuk sisi X = WSOL, SOL harus dibungkus
   dulu (§3.7) — mini-amm hanya melakukan `transfer_checked`, tidak pernah wrap/unwrap.
3. **Mint & token program cocok**: `token_program_x` harus program pemilik mint X
   (WSOL → `Tokenkeg…`, token proyek → `TokenzQd…`). Anchor mini-amm memvalidasi ini
   (`mint::token_program`), salah program → error constraint.
4. **Pool sudah ada** (`initialize_pool`, 17 akun, hanya bisa sekali per pasangan mint).
5. **`min_amount_out`** dihitung dan ditegakkan oleh program Anda. Di dalam mini-amm nilainya
   hanya dibandingkan dengan hasil kurva; ia tidak tahu harga pasar Anda.
6. **Fee**: `amount_in` adalah nilai **gross**. 6 bps dipotong ke `fee_vault_*`, lalu sisanya
   masuk vault. Output = kurva konstanta produk dari `net_in` dengan fee LP 24 bps.

### 3.3 12 akun `swap` (urutannya tidak boleh diubah)

Sumber: `lib.rs:793-873`; flag dicocokkan dengan `customSdk.ts:1779-1800` dan diuji otomatis.

| # | Field di Rust | Isi | Signer | Writable | Divalidasi mini-amm |
| :-- | :--- | :--- | :---: | :---: | :--- |
| 0 | `user` | **PDA Anda** (pemilik ATA input/output) | ✅ | ✅ | `Signer`, `token::authority` ATA |
| 1 | `token_x` | Mint X (WSOL pada flow repo) | — | — | `address = pool.token_x` |
| 2 | `token_y` | Mint Y (Token-2022) | — | — | `address = pool.token_y` |
| 3 | `pool_state` | PDA `["amm_pool", mint_x, mint_y]` **program mini-amm** | — | — | seeds + `bump` tersimpan |
| 4 | `vault_x` | PDA `["vault_x", pool_state]` | — | ✅ | `has_one`, mint/authority |
| 5 | `vault_y` | PDA `["vault_y", pool_state]` | — | ✅ | `has_one`, mint/authority |
| 6 | `fee_vault_x` | PDA `["fee_vault_x", pool_state]` | — | ✅ | `has_one`, mint/authority |
| 7 | `fee_vault_y` | PDA `["fee_vault_y", pool_state]` | — | ✅ | `has_one`, mint/authority |
| 8 | `user_token_x` | ATA(PDA, mint X) | — | ✅ | `token::authority = user` |
| 9 | `user_token_y` | ATA(PDA, mint Y) | — | ✅ | `token::authority = user` |
| 10 | `token_program_x` | Program token sisi X | — | — | `Interface<TokenInterface>` |
| 11 | `token_program_y` | Program token sisi Y | — | — | `Interface<TokenInterface>` |

PDA vault **tidak** perlu diturunkan manual di program Anda — tapi menurunkannya
(`find_program_address`) lalu membandingkan lebih murah dan lebih aman daripada menerima
akun apa pun dari pemanggil. Setidaknya kunci `pool_state` (§3.6) dan mint.

Turunan PDA (semua dari **program ID mini-amm**, bukan program Anda):
`customSdk.ts:883-930`. Membuktikannya: `tests/verifyCpiPda.ts` §5.

### 3.4 Payload semua instruksi

| Instruksi | Disc | Byte | Layout |
| :--- | :---: | :---: | :--- |
| `initialize_pool` | 0 | 17 | `u8(0) + u64_le(initial_real_token_y) + u64_le(virtual_reserves_x)` |
| `add_liquidity` | 1 | 25 | `u8(1) + u64_le(amount_x) + u64_le(amount_y) + u64_le(min_lp_out)` |
| `swap` | 2 | 18 | `u8(2) + u64_le(amount_in) + u64_le(min_amount_out) + u8(x_to_y)` |
| `claim_creator_fee` | 3 | 10 | `u8(3) + u8(side) + u64_le(min_amount)` |

- Semua integer **little-endian**; `x_to_y` adalah Borsh `bool` = 1 byte, **hanya 0 atau 1**
  (nilai 2 → gagal deserialisasi).
- `side`: `0` = kedua sisi, `1` = X, `2` = Y.
- Discriminator 1 byte menghemat 7 byte/instruksi dibanding 8 byte standar.
- Jangan pernah mengirim 8 byte discriminator Anchor (`sha256("global:swap")[..8]`) — instruksi
  akan gagal didispatch.

### 3.5 Kode Rust: `invoke_signed` yang benar

Contoh lengkap & siap disalin: [`examples/interposer-pda-cpi/src/lib.rs`](../examples/interposer-pda-cpi/src/lib.rs).
Inti yang sering salah:

```rust
// ❌ draf lama: array dengan tipe elemen berbeda → error kompilasi
let seeds = &[b"otoritas_pda_anda", &[pda_bump]];

// ✅ benar: dua irisan &[u8]
let bump = [pda_bump];
let seeds: &[&[u8]] = &[b"otoritas_pda_anda", bump.as_slice()];
invoke_signed(&ix, &account_infos, &[seeds])?;
```

```rust
// Akun CPI (urutannya = 12 akun di §3.3). pool_state read-only seperti SDK.
let metas = vec![
    AccountMeta::new(ctx.accounts.pda_authority.key(), true),        // user = PDA, signer
    AccountMeta::new_readonly(ctx.accounts.mint_x.key(), false),
    AccountMeta::new_readonly(ctx.accounts.mint_y.key(), false),
    AccountMeta::new_readonly(ctx.accounts.pool_state.key(), false),
    AccountMeta::new(ctx.accounts.vault_x.key(), false),
    AccountMeta::new(ctx.accounts.vault_y.key(), false),
    AccountMeta::new(ctx.accounts.fee_vault_x.key(), false),
    AccountMeta::new(ctx.accounts.fee_vault_y.key(), false),
    AccountMeta::new(ctx.accounts.pda_token_in.key(), false),       // ATA PDA
    AccountMeta::new(ctx.accounts.pda_token_out.key(), false),      // ATA PDA
    AccountMeta::new_readonly(ctx.accounts.token_program_x.key(), false),
    AccountMeta::new_readonly(ctx.accounts.token_program_y.key(), false),
];
```

Catatan penting untuk tipe akun:

- Pakai `Program<'info, MiniAmm>` (dengan `impl anchor_lang::Id`) alih-alih `AccountInfo`
  supaya program ID & executable-nya diperiksa Anchor, dan akun program itu memang wajib ada
  di daftar akun instruksi Anda agar CPI diizinkan runtime.
- Pakai `InterfaceAccount<'info, Mint>` / `InterfaceAccount<'info, TokenAccount>` /
  `Interface<'info, TokenInterface>` supaya pemeriksaan mint/owner/program terjadi di sisi
  Anda juga, bukan hanya di mini-amm.
- `invoke_signed` **tidak** memerlukan akun program di dalam `account_infos`; cukup akun yang
  dirujuk instruksi (sama seperti `CpiContext::to_account_infos`).

### 3.6 Kunci pool & mint di sisi Anda (wajib)

mini-amm memvalidasi `pool_state` terhadap seed-nya sendiri, tetapi **tidak** tahu pool mana
yang seharusnya dipakai pengguna Anda. Tanpa pemeriksaan ini, pemanggil bisa mengarahkan dana
ke pool lain (mint palsu, harga ekstrem):

```rust
let (expected_pool, _) = Pubkey::find_program_address(
    &[b"amm_pool", mint_x.key().as_ref(), mint_y.key().as_ref()],
    &MINI_AMM_PROGRAM_ID,
);
require_keys_eq!(expected_pool, pool_state.key(), ErrorCode::InvalidPool);
```

Tambahkan juga `has_one`/`address` terhadap mint yang Anda izinkan, dan tolak bila
`min_amount_out` tidak memenuhi kebijakan Anda.

### 3.7 SOL (WSOL): bungkus sebelum swap, buka setelahnya

Mini-amm tidak pernah memindahkan lamport. Karena itu, untuk `x_to_y = true` dengan X = WSOL:

| Langkah | Instruksi | Akun |
| :--- | :--- | :--- |
| 1 | `SystemProgram::transfer` — lamport pengguna → **ATA WSOL milik PDA** | `from` (signer, user), `to` (ATA PDA) |
| 2 | `SyncNative` — `token_program_x`, data `[17]` | `[ATA WSOL PDA (writable)]` |
| 3 | `swap` disc 2, `x_to_y = 1` | 12 akun §3.3 |
| 4 (opsional) | `CloseAccount` — `token_program_x`, data `[9]` | `[ATA WSOL PDA (w), tujuan lamport, authority = PDA (signer)]` |

- Langkah 1–2 **tidak** butuh tanda tangan PDA; langkah 4 butuh (`invoke_signed`).
- Untuk `y → x`, output masuk ke ATA WSOL PDA; tutup ATA itu bila pengguna harus menerima SOL
  native, atau simpan sebagai WSOL.
- `SyncNative` hanya menyesuaikan `amount` token account dengan lamport di dalamnya — tanpa
  langkah ini saldo WSOL tetap 0 walaupun lamport sudah terkirim.

### 3.8 `claim_creator_fee` lewat PDA (hanya bila pool milik PDA)

`ClaimCreatorFee<'info>` menuntut `has_one = creator` + `creator: Signer` (`lib.rs:876-880`).
Artinya fee 0.06% hanya bisa ditarik oleh `pool_state.creator`, yaitu `payer` saat
`initialize_pool`.

- PDA bisa mengklaim **hanya jika PDA itu yang membuat pool** (program Anda yang memanggil
  `initialize_pool`). Untuk pool yang dibuat wallet biasa lewat dashboard, PDA tidak bisa.
- Envelope: 10 akun (`creator`, `pool_state`, `token_x`, `token_y`, `fee_vault_x`,
  `fee_vault_y`, `creator_token_x`, `creator_token_y`, `token_program_x`, `token_program_y`),
  payload 10 byte. ATA `creator_token_*` harus sudah ada.
- Kalau yang Anda butuhkan hanya routing swap, Anda tidak perlu instruksi ini.

### 3.9 Simulasi & pengujian dari TypeScript

`tests/verifyCpiPda.ts` (baru, masuk `npm test`) memverifikasi envelope CPI tanpa validator:

```text
✓ urutan & flag 12 akun swap == urutan field `Swap<'info>` (dibaca dari lib.rs)
✓ payload 18 byte, disc 2, little-endian, x_to_y 0/1
✓ `claim_creator_fee` 10 akun / 10 byte, creator = PDA & signer
✓ PDA pool diturunkan dari program ID mini-amm (bukan program perantara)
✓ memakai PDA sebagai `user` membuat transaksi top-level menuntut tanda tangan PDA
```

**Penting:** `buildSwapTx()` dari SDK repo ini dirancang untuk **EOA** (wallet). Kalau Anda
melewatkan PDA sebagai `user`, `transaction.sign()` tidak akan pernah bisa —
itulah alasan interposing harus lewat CPI. Yang bisa Anda pakai ulang dari SDK adalah
`instruction` (program ID + keys + data) sebagai **instruksi dalam**, bukan transaksi.

Untuk uji end-to-end sungguhan dibutuhkan validator lokal + program perantara ter-deploy
(folder `examples/` belum termasuk workspace, lihat README-nya).

### 3.10 Peta error

Custom error mini-amm mulai `6000` (`0x1770`), sesuai urutan `AmmError` di `lib.rs:938`:

| Kode | Error | Arti pada konteks PDA |
| :--- | :--- | :--- |
| 6001 | `ZeroLiquidityAmount` | `add_liquidity` dengan 0 |
| 6002 | `ZeroSwapAmount` | `amount_in = 0` (atau `net_in` jadi 0) |
| 6003 | `EmptyReserves` | cadangan efektif 0 |
| 6004 | `InsufficientVaultBalance` | output > saldo fisik vault |
| 6005 | `MathOverflow` | angka tidak wajar |
| 6007 | `InsufficientOutputAmount` | output dibulatkan 0 |
| 6008 | `SlippageExceeded` | `min_amount_out` tidak tercapai |
| 6009 | `InvalidTokenMint` | mint tidak sama dengan `pool.token_x/y` |
| 6010 | `InvalidVault` | vault bukan milik pool (`has_one`) |
| 6013 | `InvalidFeeVault` | fee vault salah |
| 6012 | `InvalidCreator` | PDA bukan creator pool |
| 6015/6016 | `NothingToClaim` / `ClaimBelowMinimum` | fee kosong / di bawah `min_amount` |

Framework/SPL yang sering muncul di jalur CPI:

| Kode | Error | Penyebab umum |
| :--- | :--- | :--- |
| 3006 | `AccountNotMutable` / 2000 `ConstraintMut` | akun dikirim read-only padahal ditulis (vault/ATA/lamport) |
| 3010 | `AccountNotSigner` | `invoke` dipakai, bukan `invoke_signed`; atau seeds/bump salah |
| 2006 | `ConstraintSeeds` | `pool_state`/vault dari program ID yang salah |
| 3007 | `AccountOwnedByWrongProgram` | `PoolState` bukan milik mini-amm, atau mint/ATA salah program token |
| 3003 | `AccountDidNotDeserialize` | akun yang dikirim bukan `PoolState` (281 B, disc 8 byte) |
| 0x1 | Token `InsufficientFunds` | ATA PDA belum didanai / WSOL belum `SyncNative` |
| 0x4 | Token `OwnerMismatch` | authority ATA bukan PDA Anda |
| 0x11 | Token `AccountFrozen` | Token-2022 dengan freeze authority aktif |

### 3.11 Checklist keamanan program perantara

- [ ] Kunci mint + pool PDA (§3.6). Jangan percaya `pool_state` dari pemanggil.
- [ ] Hitung `min_amount_out` sendiri dari harga/kebijakan Anda; jangan biarkan 0.
- [ ] Pastikan ATA yang dipakai benar-benar milik PDA Anda, bukan akun lain (owner + mint).
- [ ] Jangan pernah menutup ATA milik orang lain; `CloseAccount` hanya untuk ATA PDA sendiri.
- [ ] `amount_in` harus sama dengan jumlah token yang benar-benar masuk (jangan percaya argumen).
- [ ] Batasi CPI ke program ID AMM + program token yang diizinkan (cegah arbitrary CPI).
- [ ] Lamport milik PDA jangan bisa ditarik siapa pun; pakai seeds kanonik + `bump` tersimpan.
- [ ] Tidak ada `remove_liquidity` di program ini — jangan berasumsi ada jalan keluar likuiditas.
- [ ] Program belum diaudit; uji di devnet dengan dana kecil sebelum mainnet.

---

### 3.12 Kesiapan repo ini untuk jalur PDA (audit otomatis)

Jawaban singkat: **ya, untuk `swap` — tanpa mengubah satu baris pun program AMM.** Yang
membuatnya bisa adalah: `user` hanya `Signer` biasa (tidak ada constraint wallet manusia),
program tidak memakai `remaining_accounts`, dan `swap` sama sekali tidak menyentuh lamport.
Semua sifat itu diperiksa ulang setiap `npm test` oleh `tests/verifyPdaReadiness.ts`
(membaca `lib.rs` + `customSdk.ts`, 16 pemeriksaan).

| Instruksi | Akun | Bisa lewat PDA? | Syarat tambahan |
| :--- | :---: | :--- | :--- |
| `initialize_pool` | 17 | **BISA** | PDA harus punya SOL untuk rent ~0.0146 SOL + ATA, dan saldo token Y |
| `add_liquidity` | 13 | **BISA, dengan catatan** | LP + ATA X/Y milik PDA; **LP tidak bisa ditarik** (tidak ada `remove_liquidity`) |
| `swap` | 12 | **BISA (jalur utama)** | ATA X & Y milik PDA sudah ada; WSOL dibungkus di luar AMM |
| `claim_creator_fee` | 10 | **Hanya bila PDA = `pool.creator`** | Pool harus dibuat oleh PDA (`payer` = PDA) |

Lima hal yang khas repo ini dan harus Anda tangani:

1. **Token X default = WSOL, dan AMM tidak pernah menyentuh lamport** (`swap` murni
   `transfer_checked`). Membungkus SOL → WSOL **tidak butuh tanda tangan PDA**, jadi bisa
   dilakukan klien di transaksi yang sama, atau di dalam program Anda. Menutup ATA WSOL
   (`CloseAccount`) baru butuh `invoke_signed`.
2. **`pool.creator = payer`** (`lib.rs:60`). Artinya fee 0.06% mengikuti siapa yang membayar
   pool. PDA yang membuat pool = PDA yang menerima fee. Pool yang dibuat wallet lewat dashboard
   **tidak** bisa diklaim PDA (`has_one = creator`, `lib.rs:884`).
3. **Tidak ada `remove_liquidity`/`withdraw`.** Kalau PDA ikut `add_liquidity`, likuiditasnya
   terkunci. Untuk interposer routing, cukup pakai `swap` saja.
4. **Tidak ada `remaining_accounts` sama sekali.** Konsekuensi: mint Token-2022 dengan
   `TransferHook` tidak bisa di-swap (butuh akun hook tambahan). Mint buatan repo ini aman —
   hanya `MetadataPointer` + `TokenMetadata`, tanpa `TransferFee`/`TransferHook`.
5. **SDK & dashboard hanya untuk EOA.** `buildSwapTx` menjadikan `user` sebagai `feePayer`,
   signer, sekaligus pembayar ATA — mustahil untuk PDA, karena transaksi top-level tidak bisa
   ditandatangani PDA. Pakai SDK hanya sebagai **spesifikasi instruksi dalam**.

Kerangka satu transaksi (pengguna bayar SOL, menerima token Y, lewat PDA):

```text
tx (ditandatangani wallet pengguna):
  1. [sekali saja] CreateIdempotent ATA PDA-X (WSOL) + ATA PDA-Y
  2. SystemProgram.transfer : pengguna → ATA WSOL milik PDA   (amount_in)
  3. SyncNative             : ATA WSOL milik PDA              (token_program_x, data [17])
  4. instruksi program Anda → CPI `swap` 12 akun              (PDA signer via invoke_signed)
  5. [opsional] CloseAccount ATA WSOL PDA → pengguna          (butuh tanda tangan PDA)
```

Yang **tidak mungkin** dengan logika repo ini:

- PDA menjadi fee payer transaksi — biaya selalu dibayar wallet.
- PDA menandatangani transaksi top-level — hanya lewat CPI (`invoke_signed`).
- Mengendarai alur PDA dari dashboard (Sandbox/Devnet/Mainnet) — dashboard hanya wallet;
  jalur PDA sepenuhnya on-chain dari program perantara Anda.
- Menguji jalur PDA di **Binary Sandbox** — sandbox adalah ledger in-memory tanpa eksekusi CPI;
  perlu `solana-test-validator` + program perantara ter-deploy.

Kalau nanti butuh hal-hal ini, **baru** program AMM perlu diubah: dukungan `remaining_accounts`
untuk `TransferHook`, instruksi penarikan likuiditas, atau otorisasi pihak ketiga yang eksplisit
(mis. `authority` terpisah dari `user`). Untuk sekadar memanggil lewat PDA: tidak perlu.

### 3.13 "Menumpang tanpa rent" — mana yang benar, mana yang mustahil

Klaim intinya **benar**: kalau program Anda tidak membuat akun baru, tidak ada rent baru.
Itu persis pola di §3.7 — seluruh state (pool, vault, LP mint) sudah dibayar oleh pembuat
pool. Yang keliru adalah mekanismenya: Anda **tidak bisa** menulis, menambah, atau
`realloc` ruang milik program lain.

| Strategi di draf | Status | Alasan (aturan runtime Solana) |
| :--- | :---: | :--- |
| Logika stateless di instruction data + CPI | ✔ | Tidak membuat akun → tidak ada rent. Ini jalur repo ini. |
| Memakai PDA publik sebagai akun di CPI | ✔ (read-only) | Boleh dibaca/dipakai sebagai argumen; gratis bagi Anda karena rent-nya sudah dibayar pembuat pool (0.0146 SOL). |
| "Meminjam slot data" PDA publik untuk state kustom | ✘ | Hanya **program pemilik** akun yang boleh mengubah `data`/menarik lamport. `PoolState` milik mini-amm, vault & ATA milik token program. |
| `realloc` PDA milik SDK publik | ✘ | `realloc` harus dijalankan program pemilik lewat instruksinya sendiri. mini-amm tidak punya realloc; ruang dialokasikan **sekali** (`space = discriminator + INIT_SPACE`), field fixed-size (audit H1–H3). |
| Refund saat data dikecilkan | ✘ di repo ini | Butuh instruksi `close`/shrink dari pemilik akun. mini-amm tidak punya (audit H4); lamport akun hanya bisa dipindahkan pemiliknya. |
| "Rent ditanggung sistem" | ✘ | Rent selalu dibayar `payer` saat akun dibuat — di repo ini pembuat pool. |

#### Zero rent yang benar-benar bisa dicapai di repo ini

| Kebutuhan | Cara tanpa rent | Catatan |
| :--- | :--- | :--- |
| Routing/swap | pakai pool yang sudah ada | 0 rent baru. Satu-satunya akun baru: ATA PDA (0.0020 SOL × 2, sekali, dipakai selamanya) |
| Otoritas | PDA tanpa data, 0 lamport | Bisa jadi signer `invoke_signed` tanpa didanai; tapi tidak bisa menyimpan apa pun |
| Whitelist / referral | verifikasi **tanda tangan ed25519** atau **Merkle proof** di instruction data | root harus jadi konstanta program (upgrade) atau akun milik Anda (kena rent) |
| Mencatat referral untuk indexer | `emit!` / `msg!` (log transaksi) | Murah & tanpa rent, tapi **tidak bisa dibaca** program on-chain — hanya indexer/explorer |

> "Tanpa rent" ≠ "tanpa biaya": setiap transaksi tetap membayar 5000 lamports per tanda
> tangan + priority fee (Anchor 0.31 menambahkan `--with-compute-unit-price` saat deploy).
> Rent pool 0.0146 SOL itu juga sudah dibayar seseorang.

#### Koreksi pada contoh kode draf

```rust
// ❌ tidak bisa dikompilasi: `pub_cpi_program = ...` tanpa `let`
pub_cpi_program = ctx.accounts.program_publik.to_account_info();

// ✅
let program = ctx.accounts.mini_amm_program.to_account_info();
```

Selain itu: (a) `data_kustom: Vec<u8>` tidak bisa diteruskan apa adanya ke `swap` — payload
harus tepat 18 byte `[2, u64_le, u64_le, u8]`; (b) `InstruksiPublik` harus berisi **12 akun**
swap (§3.3), bukan 2; (c) untuk typed CPI dibutuhkan dependency
`mini-amm = { path = "...", features = ["cpi"] }` — atau pakai `invoke_signed` mentah seperti
§3.5 yang tidak menambah dependency apa pun.

## 4. Jawaban untuk dua pertanyaan penutup

**1. Salin modul instruksi biner, atau buat crate dependency internal?**

| Pendekatan | Kelebihan | Kekurangan | Kapan dipakai |
| :--- | :--- | :--- | :--- |
| **`invoke_signed` + modul kecil yang disalin** (disc 1 byte + tabel 12 `AccountMeta`) | Nol coupling; binary program Anda kecil; tidak tersentuh perubahan `anchor-spl`; aman terhadap perbedaan versi | Harus disiplin sinkron bila struct `Swap` berubah | **Disarankan** untuk interposer, terutama karena diskriminatornya custom 1 byte |
| `path`/`git` dependency: `mini-amm = { path = "../../programs/mini-amm", features = ["cpi"] }` lalu `mini_amm::cpi::swap(...)` | Tipe & urutan akun type-safe, compile-time | Menarik seluruh program + `anchor-spl` ke build Anda; `#[program]` ikut membawa IDL/entrypoint; versi harus cocok dengan binary yang ter-deploy; workspace/MSRV jadi berantai | Bila Anda juga memelihara mini-amm dan ingin refactor bersama |

Crate mini-amm memang sudah menyiapkan fitur `cpi = ["no-entrypoint"]`
(`programs/mini-amm/Cargo.toml`), jadi opsi kedua valid — bukan satu-satunya. Bagaimanapun
pilihannya, tambahkan **tes seperti `tests/verifyCpiPda.ts`** yang membaca `lib.rs`; itu yang
membuat penyalinan modul tidak pernah “diam-diam” melenceng.

**2. Butuh skrip tes TypeScript untuk mensimulasikan panggilan PDA ini?**

Sudah ada: `tests/verifyCpiPda.ts`, dan sudah masuk `npm test`. Ia memeriksa envelope
(payload, urutan akun, flag, PDA, bukti perlunya CPI) tanpa jaringan. Untuk simulasi
*eksekusi* penuh (ledger + CPI nyata) tetap perlu `solana-test-validator` + program perantara
ter-deploy; itu di luar cakupan tes ini dan belum dijalankan di repo ini.

---

## Lampiran: rujukan kode

| Topik | Lokasi |
| :--- | :--- |
| Discriminator instruksi | `programs/mini-amm/src/lib.rs:34,118,222,387` |
| `swap` + matematika fee | `lib.rs:222-385`, `lib.rs:496-560` |
| Struct `Swap<'info>` (12 akun) | `lib.rs:793-873` |
| Struct `ClaimCreatorFee<'info>` | `lib.rs:876-936` |
| Struct `AddLiquidity<'info>` (13 akun) | `lib.rs:714-790` |
| `PoolState` 281 B | `lib.rs:594-606` |
| Enum `AmmError` (6000+) | `lib.rs:938-974` |
| Layout & diskriminator SDK | `src/sdk/customSdk.ts:126-300` |
| Turunan PDA pool/vault | `src/sdk/customSdk.ts:883-930` |
| Envelope swap SDK (12 akun) | `src/sdk/customSdk.ts:1779-1800` |
| Envelope claim SDK (10 akun) | `src/sdk/customSdk.ts:1888-1902` |
| Envelope CPI (tes) | `tests/verifyCpiPda.ts` |
| Contoh program perantara | `examples/interposer-pda-cpi/` |
