//! # mini-amm-native — AMM virtual liquidity, versi Native Rust (tanpa Anchor)
//!
//! Tujuan: biner `.so` sekecil mungkin supaya rent deploy mainnet murah.
//!
//! Aturan emas: **harga dihitung di on-chain**, bukan dikirim klien.
//! `min_amount_out` dari klien hanya batas bawah; nominal keluar selalu hasil hitung
//! program dari saldo vault + `virtual_reserves_x` yang tersimpan di state.
//!
//! Wire format (18 byte) identik dengan program Anchor repo induk, jadi SDK/dashboard
//! yang sudah ada bisa dipakai dengan mengganti `programId`.

use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError,
    pubkey::Pubkey,
};

pub mod processor;

/// GANTI dengan program ID hasil build Anda (`target/deploy/mini_amm_native-keypair.json`).
solana_program::declare_id!("A73BhxKr2bktNx7tgZUubMgXrumng17jYfKm5cTdWbXv");

pub const IX_INITIALIZE_POOL: u8 = 0;
pub const IX_FUND_POOL: u8 = 1;
pub const IX_SWAP: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum AmmError {
    InvalidInstructionData = 0,
    /// 1..9 sengaja kosong agar tidak bertabrakan dengan kode error program lama.
    NotImplemented = 10,
    InvalidPool = 11,
    InvalidVault = 12,
    InvalidMint = 13,
    InvalidUserAta = 14,
    EmptyReserves = 15,
    SlippageExceeded = 16,
    InsufficientVaultBalance = 17,
    MathOverflow = 18,
    ZeroAmount = 19,
    ZeroVirtualReserves = 20,
    SignerRequired = 21,
    AlreadyInitialized = 22,
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
        IX_FUND_POOL => processor::process_fund_pool(program_id, accounts, rest),
        IX_SWAP => processor::process_swap(program_id, accounts, rest),
        // Instruksi yang belum ada WAJIB error, bukan Ok(()): klien tidak boleh
        // mengira sesuatu berhasil padahal tidak terjadi apa-apa.
        _ => Err(AmmError::NotImplemented.into()),
    }
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);
