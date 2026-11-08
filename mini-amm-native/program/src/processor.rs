//! Pemroses instruksi: `initialize_pool`, `fund_pool`, `swap`.
//!
//! Layout state pool — **81 byte** (rent ≈ 0.0015 SOL):
//! ```text
//!   0..1    discriminator [9]
//!   1..33   vault_x  Pubkey (sisi SOL / WSOL)
//!   33..65  vault_y  Pubkey (sisi token creator)
//!   65..73  virtual_reserves_x u64 (lamports)
//!   73      bump u8
//!   74..81  padding
//! ```
//!
//! Tidak ada dependency `spl-token-*`: `transfer_checked` dibangun manual
//! (`data = [12, amount_le, decimals]`, akun `[mint, source, destination, authority]`),
//! decimals dibaca dari akun mint. Inilah yang membuat `.so` tetap kecil.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
};

use crate::AmmError;

/// Seed PDA pool. Harus sama dengan `derivePoolState` di `src/sdk/nativePool.ts`.
pub const POOL_SEED: &[u8] = b"amm_pool";
pub const POOL_STATE_LEN: usize = 81;
pub const POOL_STATE_DISCRIMINATOR: u8 = 9;

const TOKEN_IX_TRANSFER_CHECKED: u8 = 12;
const TOKEN_ACCOUNT_AMOUNT_OFFSET: usize = 64;
const TOKEN_ACCOUNT_MINT_OFFSET: usize = 0;
const TOKEN_ACCOUNT_OWNER_OFFSET: usize = 32;
const MINT_DECIMALS_OFFSET: usize = 44;

const OFFSET_VAULT_X: usize = 1;
const OFFSET_VAULT_Y: usize = 33;
const OFFSET_VIRTUAL_X: usize = 65;
const OFFSET_BUMP: usize = 73;

pub const BPS_DENOMINATOR: u128 = 10_000;
pub const CREATOR_FEE_BPS: u128 = 6;
pub const LP_FEE_BPS: u128 = 24;

fn require(condition: bool, error: AmmError) -> ProgramResult {
    if condition {
        Ok(())
    } else {
        Err(error.into())
    }
}

fn read_u64_le(data: &[u8], offset: usize) -> Option<u64> {
    let end = offset.checked_add(8)?;
    let slice = data.get(offset..end)?;
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(slice);
    Some(u64::from_le_bytes(bytes))
}

fn write_u64_le(data: &mut [u8], offset: usize, value: u64) -> ProgramResult {
    let end = offset.checked_add(8).ok_or(AmmError::MathOverflow)?;
    let slice = data
        .get_mut(offset..end)
        .ok_or(AmmError::InvalidInstructionData)?;
    slice.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn token_mint(account: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let data = account.try_borrow_data()?;
    if data.len() < TOKEN_ACCOUNT_AMOUNT_OFFSET {
        return Err(AmmError::InvalidVault.into());
    }
    Pubkey::try_from(&data[TOKEN_ACCOUNT_MINT_OFFSET..TOKEN_ACCOUNT_MINT_OFFSET + 32])
        .map_err(|_| AmmError::InvalidVault.into())
}

fn token_owner(account: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let data = account.try_borrow_data()?;
    if data.len() < TOKEN_ACCOUNT_AMOUNT_OFFSET {
        return Err(AmmError::InvalidVault.into());
    }
    Pubkey::try_from(&data[TOKEN_ACCOUNT_OWNER_OFFSET..TOKEN_ACCOUNT_OWNER_OFFSET + 32])
        .map_err(|_| AmmError::InvalidVault.into())
}

fn token_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = account.try_borrow_data()?;
    read_u64_le(&data, TOKEN_ACCOUNT_AMOUNT_OFFSET).ok_or(AmmError::InvalidVault.into())
}

fn mint_decimals(account: &AccountInfo) -> Result<u8, ProgramError> {
    let data = account.try_borrow_data()?;
    data.get(MINT_DECIMALS_OFFSET)
        .copied()
        .ok_or(AmmError::InvalidMint.into())
}

/// `transfer_checked` Token / Token-2022 tanpa crate SPL.
fn transfer_checked_ix(
    token_program: &Pubkey,
    mint: &Pubkey,
    source: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(TOKEN_IX_TRANSFER_CHECKED);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);

    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*source, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

fn pool_seeds<'a>(mint_x: &'a Pubkey, mint_y: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 4] {
    [POOL_SEED, mint_x.as_ref(), mint_y.as_ref(), bump]
}

struct PoolHeader {
    vault_x: Pubkey,
    vault_y: Pubkey,
    virtual_reserves_x: u64,
    bump: u8,
}

fn load_pool_header(
    program_id: &Pubkey,
    pool_state: &AccountInfo,
) -> Result<(PoolHeader, [u8; 1]), ProgramError> {
    require(pool_state.owner == program_id, AmmError::InvalidPool)?;
    let state = pool_state.try_borrow_data()?;
    require(state.len() >= POOL_STATE_LEN, AmmError::InvalidPool)?;
    require(state[0] == POOL_STATE_DISCRIMINATOR, AmmError::InvalidPool)?;
    let header = PoolHeader {
        vault_x: Pubkey::try_from(&state[OFFSET_VAULT_X..OFFSET_VAULT_X + 32])
            .map_err(|_| AmmError::InvalidPool)?,
        vault_y: Pubkey::try_from(&state[OFFSET_VAULT_Y..OFFSET_VAULT_Y + 32])
            .map_err(|_| AmmError::InvalidPool)?,
        virtual_reserves_x: read_u64_le(&state, OFFSET_VIRTUAL_X).ok_or(AmmError::InvalidPool)?,
        bump: state[OFFSET_BUMP],
    };
    let bump = header.bump;
    Ok((header, [bump]))
}

fn verify_pool_pda(
    program_id: &Pubkey,
    pool_state: &AccountInfo,
    mint_x: &Pubkey,
    mint_y: &Pubkey,
    bump: &[u8; 1],
) -> ProgramResult {
    let derived = Pubkey::create_program_address(&pool_seeds(mint_x, mint_y, bump), program_id)
        .map_err(|_| AmmError::InvalidPool)?;
    require(derived == *pool_state.key, AmmError::InvalidPool)
}

/// `initialize_pool`
///
/// Akun: `payer(signer,mut)`, `mint_x`, `mint_y`, `pool_state(mut)`,
///       `vault_x`, `vault_y`, `fee_vault_x`, `fee_vault_y`, `system_program`
/// Data: `u64_le virtual_reserves_x` (lamports) — nilai virtual sisi SOL.
pub fn process_initialize_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let payer = next_account_info(accounts_iter)?;
    let mint_x = next_account_info(accounts_iter)?;
    let mint_y = next_account_info(accounts_iter)?;
    let pool_state = next_account_info(accounts_iter)?;
    let vault_x = next_account_info(accounts_iter)?;
    let vault_y = next_account_info(accounts_iter)?;
    let fee_vault_x = next_account_info(accounts_iter)?;
    let fee_vault_y = next_account_info(accounts_iter)?;
    let system_program_info = next_account_info(accounts_iter)?;

    require(payer.is_signer, AmmError::SignerRequired)?;
    require(
        system_program_info.key == &system_program::ID,
        AmmError::InvalidInstructionData,
    )?;
    require(data.len() >= 8, AmmError::InvalidInstructionData)?;
    let virtual_reserves_x =
        read_u64_le(data, 0).ok_or(AmmError::InvalidInstructionData)?;
    require(virtual_reserves_x > 0, AmmError::ZeroVirtualReserves)?;

    let (expected_pool, bump) = Pubkey::find_program_address(
        &[POOL_SEED, mint_x.key.as_ref(), mint_y.key.as_ref()],
        program_id,
    );
    require(expected_pool == *pool_state.key, AmmError::InvalidPool)?;
    require(pool_state.data_is_empty(), AmmError::AlreadyInitialized)?;

    // Semua vault harus sudah dibuat klien sebagai ATA milik PDA pool.
    for (vault, expected_mint) in [
        (vault_x, mint_x.key),
        (vault_y, mint_y.key),
        (fee_vault_x, mint_x.key),
        (fee_vault_y, mint_y.key),
    ] {
        require(
            token_owner(vault)? == expected_pool,
            AmmError::InvalidVault,
        )?;
        require(token_mint(vault)? == *expected_mint, AmmError::InvalidVault)?;
    }

    let lamports = Rent::default().minimum_balance(POOL_STATE_LEN);
    let bump_bytes = [bump];
    let seeds = pool_seeds(mint_x.key, mint_y.key, &bump_bytes);

    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            pool_state.key,
            lamports,
            POOL_STATE_LEN as u64,
            program_id,
        ),
        &[
            payer.clone(),
            pool_state.clone(),
            system_program_info.clone(),
        ],
        &[&seeds],
    )?;

    let mut state = pool_state.try_borrow_mut_data()?;
    state[0] = POOL_STATE_DISCRIMINATOR;
    state[OFFSET_VAULT_X..OFFSET_VAULT_X + 32].copy_from_slice(vault_x.key.as_ref());
    state[OFFSET_VAULT_Y..OFFSET_VAULT_Y + 32].copy_from_slice(vault_y.key.as_ref());
    write_u64_le(&mut state, OFFSET_VIRTUAL_X, virtual_reserves_x)?;
    state[OFFSET_BUMP] = bump;
    Ok(())
}

/// `fund_pool` — creator menyetor token Y (sisi token) ke vault_y.
/// Tanpa LP token: kepemilikan likuiditas cukup ditandai oleh pool state.
///
/// Akun: `creator(signer)`, `pool_state`, `mint_y`, `creator_token_y(mut)`,
///       `vault_y(mut)`, `token_program_y`
/// Data: `u64_le amount`
pub fn process_fund_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let creator = next_account_info(accounts_iter)?;
    let pool_state = next_account_info(accounts_iter)?;
    let mint_y = next_account_info(accounts_iter)?;
    let creator_token_y = next_account_info(accounts_iter)?;
    let vault_y = next_account_info(accounts_iter)?;
    let token_program_y = next_account_info(accounts_iter)?;

    require(creator.is_signer, AmmError::SignerRequired)?;
    require(data.len() >= 8, AmmError::InvalidInstructionData)?;
    let amount = read_u64_le(data, 0).ok_or(AmmError::InvalidInstructionData)?;
    require(amount > 0, AmmError::ZeroAmount)?;

    let (header, _bump) = load_pool_header(program_id, pool_state)?;
    require(header.vault_y == *vault_y.key, AmmError::InvalidVault)?;
    require(token_mint(vault_y)? == *mint_y.key, AmmError::InvalidVault)?;
    require(token_owner(vault_y)? == *pool_state.key, AmmError::InvalidVault)?;
    require(
        token_mint(creator_token_y)? == *mint_y.key,
        AmmError::InvalidUserAta,
    )?;
    require(
        token_owner(creator_token_y)? == *creator.key,
        AmmError::InvalidUserAta,
    )?;

    let decimals = mint_decimals(mint_y)?;
    let ix = transfer_checked_ix(
        token_program_y.key,
        mint_y.key,
        creator_token_y.key,
        vault_y.key,
        creator.key,
        amount,
        decimals,
    );
    invoke(
        &ix,
        &[
            creator_token_y.clone(),
            vault_y.clone(),
            creator.clone(),
            mint_y.clone(),
            token_program_y.clone(),
        ],
    )?;
    Ok(())
}

/// `swap` — 18 byte data, 12 akun (identik dengan program Anchor repo induk).
///
/// Akun: `user(signer)`, `mint_x`, `mint_y`, `pool_state`, `vault_x(mut)`,
///       `vault_y(mut)`, `fee_vault_x(mut)`, `fee_vault_y(mut)`,
///       `user_token_x(mut)`, `user_token_y(mut)`, `token_program_x`, `token_program_y`
pub fn process_swap(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 17 {
        return Err(AmmError::InvalidInstructionData.into());
    }
    let amount_in = read_u64_le(data, 0).ok_or(AmmError::InvalidInstructionData)?;
    let min_amount_out = read_u64_le(data, 8).ok_or(AmmError::InvalidInstructionData)?;
    require(data[16] <= 1, AmmError::InvalidInstructionData)?;
    let x_to_y = data[16] != 0;
    require(amount_in > 0, AmmError::ZeroAmount)?;

    let accounts_iter = &mut accounts.iter();
    let user = next_account_info(accounts_iter)?;
    let mint_x = next_account_info(accounts_iter)?;
    let mint_y = next_account_info(accounts_iter)?;
    let pool_state = next_account_info(accounts_iter)?;
    let vault_x = next_account_info(accounts_iter)?;
    let vault_y = next_account_info(accounts_iter)?;
    let fee_vault_x = next_account_info(accounts_iter)?;
    let fee_vault_y = next_account_info(accounts_iter)?;
    let user_token_x = next_account_info(accounts_iter)?;
    let user_token_y = next_account_info(accounts_iter)?;
    let token_program_x = next_account_info(accounts_iter)?;
    let token_program_y = next_account_info(accounts_iter)?;

    require(user.is_signer, AmmError::SignerRequired)?;

    let (header, bump) = load_pool_header(program_id, pool_state)?;
    verify_pool_pda(program_id, pool_state, mint_x.key, mint_y.key, &bump)?;

    require(header.vault_x == *vault_x.key, AmmError::InvalidVault)?;
    require(header.vault_y == *vault_y.key, AmmError::InvalidVault)?;

    // Mint & kepemilikan setiap akun token.
    require(token_mint(vault_x)? == *mint_x.key, AmmError::InvalidVault)?;
    require(token_mint(vault_y)? == *mint_y.key, AmmError::InvalidVault)?;
    require(token_owner(vault_x)? == *pool_state.key, AmmError::InvalidVault)?;
    require(token_owner(vault_y)? == *pool_state.key, AmmError::InvalidVault)?;
    require(
        token_mint(fee_vault_x)? == *mint_x.key,
        AmmError::InvalidVault,
    )?;
    require(
        token_mint(fee_vault_y)? == *mint_y.key,
        AmmError::InvalidVault,
    )?;
    require(
        token_owner(fee_vault_x)? == *pool_state.key,
        AmmError::InvalidVault,
    )?;
    require(
        token_owner(fee_vault_y)? == *pool_state.key,
        AmmError::InvalidVault,
    )?;
    require(
        token_mint(user_token_x)? == *mint_x.key,
        AmmError::InvalidUserAta,
    )?;
    require(
        token_mint(user_token_y)? == *mint_y.key,
        AmmError::InvalidUserAta,
    )?;
    require(
        token_owner(user_token_x)? == *user.key,
        AmmError::InvalidUserAta,
    )?;
    require(
        token_owner(user_token_y)? == *user.key,
        AmmError::InvalidUserAta,
    )?;

    // --- harga dihitung di on-chain ------------------------------------
    let real_x = token_amount(vault_x)?;
    let real_y = token_amount(vault_y)?;
    let reserve_x = real_x
        .checked_add(header.virtual_reserves_x)
        .ok_or(AmmError::MathOverflow)?;
    // virtual_reserves_y = 0: seluruh supply token ada di vault_y.
    let reserve_y = real_y;

    let (reserve_in, reserve_out) = if x_to_y {
        (reserve_x, reserve_y)
    } else {
        (reserve_y, reserve_x)
    };
    require(
        reserve_in > 0 && reserve_out > 0,
        AmmError::EmptyReserves,
    )?;

    let creator_fee = mul_div_u128(amount_in as u128, CREATOR_FEE_BPS, BPS_DENOMINATOR)?;
    require(creator_fee < amount_in as u128, AmmError::ZeroAmount)?;
    let net_in = amount_in - creator_fee as u64;

    let net_in_with_fee = (net_in as u128)
        .checked_mul(BPS_DENOMINATOR - LP_FEE_BPS)
        .ok_or(AmmError::MathOverflow)?;
    let denominator = (reserve_in as u128)
        .checked_mul(BPS_DENOMINATOR)
        .and_then(|value| value.checked_add(net_in_with_fee))
        .ok_or(AmmError::MathOverflow)?;
    let amount_out = mul_div_u128(net_in_with_fee, reserve_out as u128, denominator)?;

    require(amount_out > 0, AmmError::EmptyReserves)?;
    require(
        amount_out < reserve_out as u128,
        AmmError::InsufficientVaultBalance,
    )?;
    let amount_out = u64::try_from(amount_out).map_err(|_| AmmError::MathOverflow)?;

    // Klien hanya menentukan BATAS BAWAH.
    require(amount_out >= min_amount_out, AmmError::SlippageExceeded)?;

    let physical_out = if x_to_y { real_y } else { real_x };
    require(amount_out <= physical_out, AmmError::InsufficientVaultBalance)?;

    let (program_in, program_out, in_mint, out_mint) = if x_to_y {
        (token_program_x, token_program_y, mint_x, mint_y)
    } else {
        (token_program_y, token_program_x, mint_y, mint_x)
    };
    let (user_in, user_out, vault_in, vault_out, fee_vault) = if x_to_y {
        (user_token_x, user_token_y, vault_x, vault_y, fee_vault_x)
    } else {
        (user_token_y, user_token_x, vault_y, vault_x, fee_vault_y)
    };

    let decimals_in = mint_decimals(in_mint)?;
    let decimals_out = mint_decimals(out_mint)?;

    // 1) fee creator: user -> fee vault
    if creator_fee > 0 {
        let ix_fee = transfer_checked_ix(
            program_in.key,
            in_mint.key,
            user_in.key,
            fee_vault.key,
            user.key,
            creator_fee as u64,
            decimals_in,
        );
        invoke(
            &ix_fee,
            &[
                user_in.clone(),
                fee_vault.clone(),
                user.clone(),
                in_mint.clone(),
                program_in.clone(),
            ],
        )?;
    }

    // 2) token masuk: user -> vault
    let ix_in = transfer_checked_ix(
        program_in.key,
        in_mint.key,
        user_in.key,
        vault_in.key,
        user.key,
        net_in,
        decimals_in,
    );
    invoke(
        &ix_in,
        &[
            user_in.clone(),
            vault_in.clone(),
            user.clone(),
            in_mint.clone(),
            program_in.clone(),
        ],
    )?;

    // 3) token keluar: vault -> user (authority = PDA pool)
    let ix_out = transfer_checked_ix(
        program_out.key,
        out_mint.key,
        vault_out.key,
        user_out.key,
        pool_state.key,
        amount_out,
        decimals_out,
    );
    invoke_signed(
        &ix_out,
        &[
            vault_out.clone(),
            user_out.clone(),
            pool_state.clone(),
            out_mint.clone(),
            program_out.clone(),
        ],
        &[&pool_seeds(mint_x.key, mint_y.key, &bump)],
    )?;

    Ok(())
}

/// `a * b / d` dengan u128, truncating — identik dengan `mulDiv` di TS.
fn mul_div_u128(a: u128, b: u128, denominator: u128) -> Result<u128, ProgramError> {
    if denominator == 0 {
        return Err(AmmError::MathOverflow.into());
    }
    let product = a.checked_mul(b).ok_or(AmmError::MathOverflow)?;
    Ok(product / denominator)
}
