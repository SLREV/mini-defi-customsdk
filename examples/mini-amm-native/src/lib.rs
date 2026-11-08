//! # Mini AMM — versi Native Rust (tanpa Anchor), wire-compatible dengan `customSdk.ts`
//!
//! Status: **contoh referensi, belum dikompilasi di repo ini** (tidak ada Rust/SBF toolchain).
//!
//! Beda penting dengan draf "stateless router":
//!   - Matematika AMM **dihitung di on-chain** dari saldo vault + `virtual_reserves_x` yang
//!     tersimpan di state. Klien hanya mengirim `min_amount_out` sebagai batas bawah.
//!   - Bump PDA diambil dari state dan divalidasi `create_program_address`, **bukan** dari
//!     instruction data.
//!   - `transfer_checked` dibangun manual (`data = [12, amount_le, decimals]`) sehingga tidak
//!     perlu crate `spl-token-2022` — inilah yang membuat biner tetap kecil.
//!
//! Dokumen: `docs/NATIVE-SLIM-PROGRAM.md`.

use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError,
    pubkey::Pubkey,
};

pub mod processor;

/// GANTI dengan program ID program native Anda (bukan ID Anchor lama).
solana_program::declare_id!("A73BhxKr2bktNx7tgZUubMgXrumng17jYfKm5cTdWbXv");

/// Discriminator instruksi — sama dengan program Anchor (custom 1 byte).
pub const IX_INITIALIZE_POOL: u8 = 0;
pub const IX_ADD_LIQUIDITY: u8 = 1;
pub const IX_SWAP: u8 = 2;
pub const IX_CLAIM_CREATOR_FEE: u8 = 3;

/// Error program (`ProgramError::Custom`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum AmmError {
    InvalidInstructionData = 0,
    // 1..9 sengaja tidak dipakai agar tidak bertabrakan dengan kode Anchor lama.
    NotImplemented = 10,
    InvalidPool = 11,
    InvalidVault = 12,
    InvalidMint = 13,
    InvalidUserAta = 14,
    EmptyReserves = 15,
    SlippageExceeded = 16,
    InsufficientVaultBalance = 17,
    MathOverflow = 18,
    ZeroSwapAmount = 19,
    ZeroVirtualReserves = 20,
    SignerRequired = 21,
}

impl From<AmmError> for ProgramError {
    fn from(error: AmmError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (discriminator, rest) = instruction_data
        .split_first()
        .ok_or(ProgramError::from(AmmError::InvalidInstructionData))?;

    match *discriminator {
        IX_INITIALIZE_POOL => processor::process_initialize_pool(program_id, accounts, rest),
        IX_SWAP => processor::process_swap(program_id, accounts, rest),
        // Jangan mengembalikan Ok(()) untuk instruksi yang belum ada: klien akan
        // mengira likuiditas/fee berhasil diproses padahal tidak terjadi apa-apa.
        IX_ADD_LIQUIDITY | IX_CLAIM_CREATOR_FEE => Err(AmmError::NotImplemented.into()),
        _ => Err(AmmError::InvalidInstructionData.into()),
    }
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);
