# Mini DeFi: Token-2022 & Virtual AMM

Dashboard React berjalan di komputer Anda, tetapi **menggunakan Solana Mainnet Beta dan SOL sungguhan**. Tidak ada mode simulator atau mock-wallet di dashboard. Kode program `programs/mini-amm` tidak diubah oleh migrasi ini: pool baru menerima seluruh suplai token dan memulai dengan **nol SOL riil** di vault serta cadangan SOL virtual untuk kurva. SOL virtual bukan dana nyata. Tidak ada remove liquidity. Tidak ada tombol baru untuk menambahkan SOL riil ke pool yang sudah ada; jangan anggap launch pool baru sebagai setoran ke pool lama.

## Sebelum menggunakan dana riil

- **Belum diaudit dan belum diuji end-to-end dengan wallet/mainnet di sini.** Tes otomatis menggunakan mock; jangan menganggapnya bukti keamanan atau keberhasilan mainnet.
- Program AMM harus sudah ada di **mainnet** dan harus diverifikasi secara independen bahwa binary dan program ID sesuai dengan kode yang Anda maksud, termasuk status upgrade authority. Program di devnet tidak otomatis ada di mainnet. Pemeriksaan dashboard hanya memastikan genesis mainnet dan akun executable; **bukan verifikasi binary atau audit**.
- Pahami risiko mint, freeze, metadata update, upgrade authority, biaya creator, penjualan dan likuiditas. Menonaktifkan authority tidak menjamin bebas rug pull. Authority OFF pada token baru permanen; URL metadata eksternal tetap dapat berubah kecuali penyimpanannya immutable.
- Pastikan Phantom dikonfigurasi untuk **Mainnet Beta** dan tinjau instruksi, biaya dan alamat di wallet sebelum menyetujui. RPC publik dapat membatasi permintaan; wallet dan RPC tepercaya tetap diperlukan.

## Menjalankan dashboard lokal

Prasyarat: Node.js dan npm yang kompatibel (lihat `package.json`), browser, Phantom, akses RPC mainnet, dan program AMM mainnet yang sudah diverifikasi. Dari folder proyek:

```bash
npm ci
cp .env.example .env
```

Edit `.env`:

```dotenv
VITE_MAINNET_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
VITE_MAINNET_AMM_PROGRAM_ID=<program-amm-mainnet-yang-diverifikasi>
```

Ganti nilai dalam tanda kurung dengan alamat program sebenarnya; tanpa ID yang valid transaksi diblokir. Jangan masukkan seed phrase, private key atau wallet JSON. Endpoint premium dapat digunakan; `https://solana.com` bukan endpoint RPC. Variabel `VITE_*` terlihat di browser, termasuk API key pada URL RPC.

```bash
npm run dev:private
```

Buka `http://127.0.0.1:5173` di komputer yang sama, hubungkan Phantom, konfirmasi peringatan mainnet, dan isi parameter token. `npm run dev` mendengarkan seluruh interface untuk preview; **jangan expose** server tersebut ke jaringan tidak tepercaya. API upload Pinata pada dev server tidak memiliki autentikasi pengguna dan memakai kredensial server; gunakan `dev:private` serta firewall. `npm run build` membangun bundle, sedangkan `npm run preview` tidak menyediakan endpoint upload Pinata.

## Launch dan swap

- Launch membuat mint Token-2022 dengan Metadata Pointer dan TokenMetadata, mencetak supply, mengatur authority, lalu menginisialisasi pool dalam **satu transaksi atomik**. Wallet menjadi fee payer/signer; keypair mint baru sementara disertakan sebagai signer tambahan. Aplikasi/SDK tidak membaca private key wallet dari file atau string.
- RPC dihitung untuk fee, rent mint/pool/akun token, dan cadangan 0,002 SOL; swap beli juga memperhitungkan SOL yang ditransfer. Ini estimasi konservatif, bukan jaminan biaya akhir. Transaksi diblokir bila saldo kurang atau RPC tidak dapat menghitung fee.
- Batas transaksi Solana legacy 1.232 byte. Nama/URI/Telegram/Twitter yang terlalu panjang dapat melewatinya; launch diblokir dan **tidak** dibagi diam-diam. Pendekkan input, lalu coba lagi. URL URI metadata on-chain sebaiknya menunjuk ke JSON metadata, bukan langsung ke gambar.
- Hubungkan wallet yang sama saat menyetujui. Setelah pengiriman, signature ditampilkan sebelum konfirmasi. Jika konfirmasi gagal atau RPC timeout, periksa signature di Explorer dan riwayat wallet sebelum mencoba lagi; jangan mengulang transaksi secara otomatis. Jika wallet tidak mengembalikan signature, hasil pengiriman juga bisa tidak pasti.
- Untuk swap pool yang ada, masukkan mint dan muat pool. Dashboard mendukung token dengan 9 desimal. **SELL ALL** mengisi jumlah persis dari ATA token aktif, bukan akun token lain; tetap perlu menekan tombol Jual dan mengonfirmasi di wallet. Swap dapat gagal karena perubahan harga atau cadangan SOL riil tidak cukup. Penjualan menutup ATA WSOL dan mencairkan seluruh saldo WSOL pada ATA tersebut.
- Claim fee hanya untuk wallet creator pool. Semua transaksi melalui wallet adapter `sendTransaction`; tidak ada CLI yang membaca private key atau mengirim transaksi langsung.

## Metadata dan Pinata

Isi Image URI dan URI JSON metadata. Jika memakai Pinata, isi `PINATA_JWT` di `.env` (tanpa prefix `VITE_`) lalu upload gambar di dashboard saat `npm run dev:private`, atau gunakan `npm run pinata:upload -- --help`. Handler Vite lokal menyimpan kredensial di sisi server, tetapi tidak cocok untuk server publik. URL image bukan pengganti JSON metadata standar; gunakan JSON dengan field `name`, `symbol`, dan `image` agar kompatibilitas wallet lebih baik. Mengubah isian setelah upload tidak otomatis memperbarui JSON yang sudah di-upload.

## Verifikasi lokal

```bash
npm run build
npm test
```

Tes menggunakan mock dan tidak mengirim transaksi ke jaringan. `npm audit` dapat melaporkan kerentanan dependensi; evaluasi dan perbaiki sebelum penggunaan dana riil. Build, tes mock, dan pemeriksaan executable saja tidak menyatakan sistem siap produksi. Program ini tetap menggunakan logika AMM yang tersedia di repositori; setiap deployment memerlukan verifikasi terpisah.
