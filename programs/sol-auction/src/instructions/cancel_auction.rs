use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionStatus};

pub fn handler(ctx: Context<CancelAuction>) -> Result<()> {
    let auction = &ctx.accounts.auction_config;

    // Can only cancel if no bids (status is still Created)
    require!(
        auction.status == AuctionStatus::Created,
        AuctionError::CannotCancelWithBids
    );

    // Only seller can cancel (enforced by Signer + constraint, but explicit check is clear)
    require!(
        ctx.accounts.seller.key() == auction.seller,
        AuctionError::Unauthorized
    );

    // Return item from vault to seller
    let seller_key = auction.seller;
    let auction_id_bytes = auction.auction_id.to_le_bytes();
    let auction_bump = auction.bump;
    let seeds = &[
        b"auction".as_ref(),
        seller_key.as_ref(),
        auction_id_bytes.as_ref(),
        &[auction_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.item_vault.to_account_info(),
                to: ctx.accounts.seller_item_account.to_account_info(),
                authority: ctx.accounts.auction_config.to_account_info(),
            },
            signer_seeds,
        ),
        1,
    )?;

    let auction = &mut ctx.accounts.auction_config;
    auction.status = AuctionStatus::Cancelled;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelAuction<'info> {
    #[account(
    mut,
    seeds = [b"auction", auction_config.seller.as_ref(), &auction_config.auction_id.to_le_bytes()],
    bump = auction_config.bump,
  )]
    pub auction_config: Account<'info, AuctionConfig>,

    #[account(
    mut,
    seeds = [b"vault", auction_config.key().as_ref()],
    bump,
    token::mint = item_mint,
    token::authority = auction_config,
  )]
    pub item_vault: Account<'info, TokenAccount>,

    pub item_mint: Account<'info, Mint>,

    #[account(
    mut,
    token::mint = item_mint,
    token::authority = seller,
  )]
    pub seller_item_account: Account<'info, TokenAccount>,

    #[account(
    mut,
    constraint = seller.key() == auction_config.seller @ AuctionError::Unauthorized,
  )]
    pub seller: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
