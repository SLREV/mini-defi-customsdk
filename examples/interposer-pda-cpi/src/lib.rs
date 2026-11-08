//! # Program perantara (interposer) — memanggil mini-amm lewat CPI dengan PDA
//!
//! Status: **referensi, belum dikompilasi di repo ini** (tidak ada Rust/SBF toolchain di
//! lingkungan penyusunan dokumen). Perlakukan seperti kode contoh: baca, sesuaikan,
//! lalu `anchor build` di workspace Anda sendiri.
//!
//! Cara kerja:
//!   transaksi (wallet pengguna) → program ini → CPI `swap` mini-amm (PDA jadi signer)
//!
//! Fakta yang dipakai (semua dari `programs/mini-amm/src/lib.rs`):
//!   - `swap` disc `u8 = 2`, payload 18 B: `[2, u64_le(amount_in), u64_le(min_amount_out), u8(x_to_y)]`
//!   - `swap` butuh 12 akun, urutan lihat `swap_metas()`
//!   - `user` = `Signer` → harus PDA kita, ditandatangani via `invoke_signed`
//!   - `claim_creator_fee` disc `u8 = 3`, payload 10 B, hanya boleh oleh `pool.creator`
//!
//! Dokumen pendamping: `docs/PDA-INTERPOSING-GUIDE.md`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    system_instruction,
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

/// GANTI dengan program ID program perantara Anda sendiri.
declare_id!("AZSaqNPMkGa2TJRinCjMELRLZvRJVHewCCmLeWNfGmAe");

/// Program AMM target (mainnet/devnet harus memakai binary yang sama).
pub const MINI_AMM_PROGRAM_ID: Pubkey = pubkey!("DnW4iMWC5gCjPZkk2kkdTrY5uybW3w6r6aLdS6meynMn");

/// Seed PDA otoritas program ini: `[b"otoritas_pda_anda"]`.
pub const OTORITAS_SEED: &[u8] = b"otoritas_pda_anda";
/// Seed pool mini-amm: `[b"amm_pool", mint_x, mint_y]` (program ID = mini-amm).
pub const AMM_POOL_SEED: &[u8] = b"amm_pool";

pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// Discriminator instruksi mini-amm (custom 1 byte, bukan 8 byte Anchor).
pub const IX_SWAP: u8 = 2;
pub const IX_CLAIM_CREATOR_FEE: u8 = 3;
/// SPL Token `SyncNative` (memperbarui `amount` WSOL dari lamport).
pub const IX_SYNC_NATIVE: u8 = 17;

pub const SWAP_IX_SIZE: usize = 18;
pub const CLAIM_CREATOR_FEE_IX_SIZE: usize = 10;

/// Anchor tipe program untuk `Program<'info, MiniAmm>` (cek ID + executable).
#[derive(Clone)]
pub struct MiniAmm;

impl anchor_lang::Id for MiniAmm {
    fn id() -> Pubkey {
        MINI_AMM_PROGRAM_ID
    }
}

#[program]
pub mod interposer_pda_cpi {
    use super::*;

    /// Swap memakai saldo yang **sudah ada** di ATA milik PDA.
    /// `x_to_y = true` menjual token X (mis. WSOL) untuk token Y, dan sebaliknya.
    pub fn swap_lewat_pda(
        ctx: Context<TumpangSwap>,
        amount_in: u64,
        min_amount_out: u64,
        x_to_y: bool,
    ) -> Result<()> {
        cpi_swap(&ctx, amount_in, min_amount_out, x_to_y)
    }

    /// Beli token Y dengan SOL pengguna: bungkus SOL → WSOL milik PDA, lalu swap.
    /// Hanya untuk kasus token X = WSOL.
    pub fn swap_sol_lewat_pda(
        ctx: Context<TumpangSwap>,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        require!(amount_in > 0, ErrorCode::InvalidAmount);
        require_keys_eq!(ctx.accounts.mint_x.key(), WSOL_MINT, ErrorCode::NotWsol);

        // 1) Lamport pengguna -> ATA WSOL milik PDA (tidak perlu tanda tangan PDA).
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.pda_token_in.key(),
                amount_in,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.pda_token_in.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // 2) SyncNative: tanpa ini saldo WSOL tetap 0 walau lamport sudah masuk.
        let sync_native = Instruction {
            program_id: ctx.accounts.token_program_x.key(),
            accounts: vec![AccountMeta::new(ctx.accounts.pda_token_in.key(), false)],
            data: vec![IX_SYNC_NATIVE],
        };
        invoke(
            &sync_native,
            &[ctx.accounts.pda_token_in.to_account_info()],
        )?;

        // 3) Swap X -> Y memakai PDA sebagai `user`.
        cpi_swap(&ctx, amount_in, min_amount_out, true)
    }

    /// Klaim fee creator 0.06%. Hanya berhasil bila PDA ini adalah `pool.creator`
    /// (yaitu `payer` saat `initialize_pool`).
    pub fn claim_fee_lewat_pda(
        ctx: Context<TumpangClaim>,
        side: u8,
        min_amount: u64,
    ) -> Result<()> {
        require!(side <= 2, ErrorCode::InvalidSide);
        require_keys_eq!(
            ctx.accounts.creator_token_x.mint,
            ctx.accounts.mint_x.key(),
            ErrorCode::InvalidAta
        );
        require_keys_eq!(
            ctx.accounts.creator_token_y.mint,
            ctx.accounts.mint_y.key(),
            ErrorCode::InvalidAta
        );

        let (expected_pool, _) = Pubkey::find_program_address(
            &[
                AMM_POOL_SEED,
                ctx.accounts.mint_x.key().as_ref(),
                ctx.accounts.mint_y.key().as_ref(),
            ],
            &MINI_AMM_PROGRAM_ID,
        );
        require_keys_eq!(
            expected_pool,
            ctx.accounts.pool_state.key(),
            ErrorCode::InvalidPool
        );

        let mut data = Vec::with_capacity(CLAIM_CREATOR_FEE_IX_SIZE);
        data.push(IX_CLAIM_CREATOR_FEE);
        data.push(side);
        data.extend_from_slice(&min_amount.to_le_bytes());

        let ix = Instruction {
            program_id: MINI_AMM_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.pda_authority.key(), true), // creator (PDA)
                AccountMeta::new_readonly(ctx.accounts.pool_state.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint_x.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint_y.key(), false),
                AccountMeta::new(ctx.accounts.fee_vault_x.key(), false),
                AccountMeta::new(ctx.accounts.fee_vault_y.key(), false),
                AccountMeta::new(ctx.accounts.creator_token_x.key(), false),
                AccountMeta::new(ctx.accounts.creator_token_y.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program_x.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program_y.key(), false),
            ],
            data,
        };

        let infos = [
            ctx.accounts.pda_authority.to_account_info(),
            ctx.accounts.pool_state.to_account_info(),
            ctx.accounts.mint_x.to_account_info(),
            ctx.accounts.mint_y.to_account_info(),
            ctx.accounts.fee_vault_x.to_account_info(),
            ctx.accounts.fee_vault_y.to_account_info(),
            ctx.accounts.creator_token_x.to_account_info(),
            ctx.accounts.creator_token_y.to_account_info(),
            ctx.accounts.token_program_x.to_account_info(),
            ctx.accounts.token_program_y.to_account_info(),
        ];

        let bump = [ctx.bumps.pda_authority];
        let seeds: &[&[u8]] = &[OTORITAS_SEED, bump.as_slice()];
        invoke_signed(&ix, &infos, &[seeds])?;
        Ok(())
    }
}

/// 12 `AccountMeta` — urutan WAJIB sama dengan `Swap<'info>` mini-amm.
#[allow(clippy::too_many_arguments)]
fn swap_metas(
    user: Pubkey,
    mint_x: Pubkey,
    mint_y: Pubkey,
    pool_state: Pubkey,
    vault_x: Pubkey,
    vault_y: Pubkey,
    fee_vault_x: Pubkey,
    fee_vault_y: Pubkey,
    user_token_x: Pubkey,
    user_token_y: Pubkey,
    token_program_x: Pubkey,
    token_program_y: Pubkey,
) -> Vec<AccountMeta> {
    vec![
        // 0  user            = PDA kita (signer lewat invoke_signed)
        AccountMeta::new(user, true),
        // 1  token_x
        AccountMeta::new_readonly(mint_x, false),
        // 2  token_y
        AccountMeta::new_readonly(mint_y, false),
        // 3  pool_state     (read-only, sama seperti SDK)
        AccountMeta::new_readonly(pool_state, false),
        // 4  vault_x
        AccountMeta::new(vault_x, false),
        // 5  vault_y
        AccountMeta::new(vault_y, false),
        // 6  fee_vault_x
        AccountMeta::new(fee_vault_x, false),
        // 7  fee_vault_y
        AccountMeta::new(fee_vault_y, false),
        // 8  user_token_x   (ATA milik PDA)
        AccountMeta::new(user_token_x, false),
        // 9  user_token_y   (ATA milik PDA)
        AccountMeta::new(user_token_y, false),
        // 10 token_program_x
        AccountMeta::new_readonly(token_program_x, false),
        // 11 token_program_y
        AccountMeta::new_readonly(token_program_y, false),
    ]
}

fn cpi_swap(
    ctx: &Context<TumpangSwap>,
    amount_in: u64,
    min_amount_out: u64,
    x_to_y: bool,
) -> Result<()> {
    require!(amount_in > 0, ErrorCode::InvalidAmount);

    // 0) Kunci pool: harus PDA milik mini-amm untuk pasangan mint ini.
    let (expected_pool, _) = Pubkey::find_program_address(
        &[
            AMM_POOL_SEED,
            ctx.accounts.mint_x.key().as_ref(),
            ctx.accounts.mint_y.key().as_ref(),
        ],
        &MINI_AMM_PROGRAM_ID,
    );
    require_keys_eq!(
        expected_pool,
        ctx.accounts.pool_state.key(),
        ErrorCode::InvalidPool
    );

    // 1) Arah & kepemilikan ATA milik PDA.
    let (mint_in, mint_out) = if x_to_y {
        (ctx.accounts.mint_x.key(), ctx.accounts.mint_y.key())
    } else {
        (ctx.accounts.mint_y.key(), ctx.accounts.mint_x.key())
    };
    require_keys_eq!(
        ctx.accounts.pda_token_in.mint,
        mint_in,
        ErrorCode::InvalidAta
    );
    require_keys_eq!(
        ctx.accounts.pda_token_out.mint,
        mint_out,
        ErrorCode::InvalidAta
    );

    // 2) Payload 18 byte: [u8(2), u64_le, u64_le, u8]. `x_to_y` = Borsh bool (0/1).
    let mut data = Vec::with_capacity(SWAP_IX_SIZE);
    data.push(IX_SWAP);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_amount_out.to_le_bytes());
    data.push(u8::from(x_to_y));

    // 3) Instruksi + 12 akun.
    let ix = Instruction {
        program_id: MINI_AMM_PROGRAM_ID,
        accounts: swap_metas(
            ctx.accounts.pda_authority.key(),
            ctx.accounts.mint_x.key(),
            ctx.accounts.mint_y.key(),
            ctx.accounts.pool_state.key(),
            ctx.accounts.vault_x.key(),
            ctx.accounts.vault_y.key(),
            ctx.accounts.fee_vault_x.key(),
            ctx.accounts.fee_vault_y.key(),
            ctx.accounts.pda_token_in.key(),
            ctx.accounts.pda_token_out.key(),
            ctx.accounts.token_program_x.key(),
            ctx.accounts.token_program_y.key(),
        ),
        data,
    };

    // 4) Account info untuk CPI.
    let infos = [
        ctx.accounts.pda_authority.to_account_info(),
        ctx.accounts.mint_x.to_account_info(),
        ctx.accounts.mint_y.to_account_info(),
        ctx.accounts.pool_state.to_account_info(),
        ctx.accounts.vault_x.to_account_info(),
        ctx.accounts.vault_y.to_account_info(),
        ctx.accounts.fee_vault_x.to_account_info(),
        ctx.accounts.fee_vault_y.to_account_info(),
        ctx.accounts.pda_token_in.to_account_info(),
        ctx.accounts.pda_token_out.to_account_info(),
        ctx.accounts.token_program_x.to_account_info(),
        ctx.accounts.token_program_y.to_account_info(),
    ];

    // 5) Tanda tangan PDA. `bump.as_slice()` — jangan `&[bump]` di dalam array
    //    bertipe `&[&[u8]]` (itu error kompilasi: tipe elemen tidak sama).
    let bump = [ctx.bumps.pda_authority];
    let seeds: &[&[u8]] = &[OTORITAS_SEED, bump.as_slice()];
    invoke_signed(&ix, &infos, &[seeds])?;

    Ok(())
}

#[derive(Accounts)]
pub struct TumpangSwap<'info> {
    /// Wallet pengguna Anda. Hanya dipakai untuk membungkus SOL (mode `swap_sol_lewat_pda`).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// PDA program ini. Anchor memvalidasi alamatnya lewat seeds; bump tersimpan di
    /// `ctx.bumps.pda_authority` dan dipakai untuk `invoke_signed`.
    #[account(seeds = [OTORITAS_SEED], bump)]
    pub pda_authority: UncheckedAccount<'info>,

    #[account(mint::token_program = token_program_x)]
    pub mint_x: InterfaceAccount<'info, Mint>,

    #[account(mint::token_program = token_program_y)]
    pub mint_y: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA pool milik mini-amm; dikunci dengan `find_program_address` di `cpi_swap`.
    pub pool_state: UncheckedAccount<'info>,

    #[account(mut)]
    pub vault_x: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub vault_y: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub fee_vault_x: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub fee_vault_y: InterfaceAccount<'info, TokenAccount>,

    /// ATA milik PDA untuk mint input.
    #[account(mut, token::authority = pda_authority)]
    pub pda_token_in: InterfaceAccount<'info, TokenAccount>,

    /// ATA milik PDA untuk mint output.
    #[account(mut, token::authority = pda_authority)]
    pub pda_token_out: InterfaceAccount<'info, TokenAccount>,

    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,

    /// Akun program mini-amm (wajib ada di daftar akun agar CPI diizinkan).
    pub mini_amm_program: Program<'info, MiniAmm>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TumpangClaim<'info> {
    /// PDA program ini, sekaligus `pool.creator` (lihat catatan di dokumen).
    #[account(seeds = [OTORITAS_SEED], bump)]
    pub pda_authority: UncheckedAccount<'info>,

    /// CHECK: PDA pool mini-amm; dikunci dengan `find_program_address`.
    pub pool_state: UncheckedAccount<'info>,

    #[account(mint::token_program = token_program_x)]
    pub mint_x: InterfaceAccount<'info, Mint>,

    #[account(mint::token_program = token_program_y)]
    pub mint_y: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub fee_vault_x: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub fee_vault_y: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::authority = pda_authority)]
    pub creator_token_x: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::authority = pda_authority)]
    pub creator_token_y: InterfaceAccount<'info, TokenAccount>,

    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,

    pub mini_amm_program: Program<'info, MiniAmm>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("amount_in harus lebih besar dari 0")]
    InvalidAmount,
    #[msg("PoolState bukan PDA mini-amm untuk pasangan mint ini")]
    InvalidPool,
    #[msg("ATA yang diberikan bukan milik PDA ini atau mint-nya tidak cocok")]
    InvalidAta,
    #[msg("Instruksi ini hanya untuk pool dengan token X = WSOL")]
    NotWsol,
    #[msg("side harus 0 (kedua), 1 (X), atau 2 (Y)")]
    InvalidSide,
}
