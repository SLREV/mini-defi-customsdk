#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BINARY="$ROOT/target/deploy/mini_amm.so"
BASE="$ROOT/.local-validator"
LEDGER="$BASE/ledger"
MAINNET_RPC="${LOCAL_VALIDATOR_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
WSOL="So11111111111111111111111111111111111111112"
TOKEN_2022="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

for cmd in solana solana-test-validator; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd tidak ditemukan. Instal toolchain Solana/Agave terlebih dahulu." >&2
    exit 1
  fi
done
if [[ ! -f "$BINARY" ]]; then
  echo "Error: $BINARY tidak ditemukan. Jalankan anchor build dari root proyek." >&2
  exit 1
fi
PROGRAM_ID="$(sed -nE 's/^[[:space:]]*declare_id!\("([^"]+)"\);.*/\1/p' "$ROOT/programs/mini-amm/src/lib.rs")"
if [[ -z "$PROGRAM_ID" || "$PROGRAM_ID" == *$'\n'* ]]; then
  echo 'Error: tidak dapat menentukan satu declare_id! di programs/mini-amm/src/lib.rs.' >&2
  exit 1
fi
if [[ -L "$BASE" || -L "$LEDGER" ]]; then
  echo "Error: direktori ledger tidak boleh symlink: $BASE atau $LEDGER" >&2
  exit 1
fi
GENESIS="$(solana genesis-hash --url "$MAINNET_RPC")"
if [[ "$GENESIS" != "$MAINNET_GENESIS" ]]; then
  echo 'Error: RPC sumber bukan mainnet-beta. Kloning dibatalkan.' >&2
  exit 1
fi
mkdir -p "$BASE"
printf '%s\n' \
  'PERINGATAN: --reset akan menghapus seluruh isi ledger lokal berikut:' \
  "  $LEDGER" \
  'Hanya akun yang ditentukan dikloning; transaksi dan SOL di sini bukan mainnet asli.' \
  "Program ID: $PROGRAM_ID" \
  'Validator dan faucet harus dilindungi firewall dari akses jaringan lain.'

# Token-2022 adalah upgradeable: clone-upgradeable-program mengambil akun program
# DAN ProgramData-nya; --clone saja tidak menyalin bytecode ProgramData.
exec solana-test-validator \
  --ledger "$LEDGER" \
  --reset \
  --bind-address 127.0.0.1 \
  --url "$MAINNET_RPC" \
  --clone "$WSOL" \
  --clone-upgradeable-program "$TOKEN_2022" \
  --bpf-program "$PROGRAM_ID" "$BINARY"
