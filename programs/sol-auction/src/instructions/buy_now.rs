use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionStatus};

pub fn handler(ctx: Context<BuyNow>) -> Result<()> {
  let clock = Clock::get()?;
  let auction = &ctx.accounts.auction_config;

  // Validate timing and status
  require!(
    clock.unix_timestamp >= auction.start_time,
    AuctionError::AuctionNotStarted
  );
  require!(
    clock.unix_timestamp <= auction.end_time,
    AuctionError::AuctionAlreadyEnded
  );
  require!(
    auction.status == AuctionStatus::Created || auction.status == AuctionStatus::Active,
    AuctionError::InvalidAuctionStatus
  );

  // Seller cannot buy own auction
  require!(
    ctx.accounts.buyer.key() != auction.seller,
    AuctionError::SellerCannotBid
  );

  // Get current Dutch price (linear decay)
  let price = auction
    .get_current_price(&clock)
    .ok_or(AuctionError::InvalidAuctionStatus)?;

  // Extract PDA seeds before dropping immutable borrow
  let seller_key = auction.seller;
  let auction_id_bytes = auction.auction_id.to_le_bytes();
  let bump = auction.bump;

  // Transfer SOL: buyer -> seller
  anchor_lang::system_program::transfer(
    CpiContext::new(
      ctx.accounts.system_program.to_account_info(),
      anchor_lang::system_program::Transfer {
        from: ctx.accounts.buyer.to_account_info(),
        to: ctx.accounts.seller.to_account_info(),
      },
    ),
    price,
  )?;

  // Transfer item: vault -> buyer's token account (PDA-signed by auction_config)
  let seeds = &[
    b"auction".as_ref(),
    seller_key.as_ref(),
    auction_id_bytes.as_ref(),
    &[bump],
  ];
  let signer_seeds = &[&seeds[..]];

  token::transfer(
    CpiContext::new_with_signer(
      ctx.accounts.token_program.to_account_info(),
      SplTransfer {
        from: ctx.accounts.item_vault.to_account_info(),
        to: ctx.accounts.buyer_item_account.to_account_info(),
        authority: ctx.accounts.auction_config.to_account_info(),
      },
      signer_seeds,
    ),
    1,
  )?;

  // Mark as settled after all transfers complete
  ctx.accounts.auction_config.status = AuctionStatus::Settled;
  Ok(())
}

#[derive(Accounts)]
pub struct BuyNow<'info> {
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

  /// Buyer's token account for the item (must be initialized beforehand)
  #[account(
    mut,
    token::mint = item_mint,
    token::authority = buyer,
  )]
  pub buyer_item_account: Account<'info, TokenAccount>,

  /// CHECK: Seller receives SOL payment. Validated against auction_config.seller.
  #[account(
    mut,
    constraint = seller.key() == auction_config.seller @ AuctionError::Unauthorized,
  )]
  pub seller: UncheckedAccount<'info>,

  #[account(mut)]
  pub buyer: Signer<'info>,

  pub token_program: Program<'info, Token>,
  pub system_program: Program<'info, System>,
}
