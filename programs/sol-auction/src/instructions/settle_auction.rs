use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionHouse, AuctionStatus, AuctionType, BidEscrow};

pub fn handler(ctx: Context<SettleAuction>) -> Result<()> {
  let clock = Clock::get()?;
  let auction = &ctx.accounts.auction_config;

  // Extract needed values before mutable borrow
  let seller_key = auction.seller;
  let auction_id_bytes = auction.auction_id.to_le_bytes();
  let auction_bump = auction.bump;

  let fee_bps = ctx.accounts.auction_house.fee_bps;

  // Determine winner, payment amount based on auction type
  let (winner, payment_amount) = match &auction.auction_type {
    AuctionType::English {
      highest_bid,
      highest_bidder,
      bid_count,
      ..
    } => {
      require!(*bid_count > 0, AuctionError::NoBids);
      require!(
        clock.unix_timestamp >= auction.end_time,
        AuctionError::AuctionStillActive
      );
      require!(
        auction.status == AuctionStatus::Active,
        AuctionError::InvalidAuctionStatus
      );
      let winner = highest_bidder.ok_or(AuctionError::NoBids)?;
      (winner, *highest_bid)
    }
    AuctionType::SealedVickrey {
      highest_bid,
      second_bid,
      winner,
      bid_count,
      ..
    } => {
      require!(*bid_count > 0, AuctionError::NoBids);
      require!(
        auction.status == AuctionStatus::RevealPhase
          || auction.status == AuctionStatus::BiddingClosed,
        AuctionError::InvalidAuctionStatus
      );
      let w = winner.ok_or(AuctionError::NoBids)?;
      // Vickrey: pay second price. If second_bid is 0 (only one bidder), pay own bid
      let price = if *second_bid > 0 {
        *second_bid
      } else {
        *highest_bid
      };
      (w, price)
    }
    AuctionType::Dutch { .. } => {
      return Err(AuctionError::InvalidAuctionStatus.into()); // Dutch settles in buy_now
    }
  };

  // Verify the winner's bid escrow is correct
  require!(
    ctx.accounts.winner_bid_escrow.bidder == winner,
    AuctionError::Unauthorized
  );

  // Calculate fee
  let fee = payment_amount
    .checked_mul(fee_bps as u64)
    .ok_or(AuctionError::Overflow)?
    .checked_div(10_000)
    .ok_or(AuctionError::Overflow)?;
  let seller_receives = payment_amount
    .checked_sub(fee)
    .ok_or(AuctionError::Overflow)?;

  // Transfer item: vault -> winner's token account (PDA-signed by auction_config)
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
        to: ctx.accounts.winner_item_account.to_account_info(),
        authority: ctx.accounts.auction_config.to_account_info(),
      },
      signer_seeds,
    ),
    1,
  )?;

  // Transfer payment from bid escrow to seller via direct lamport manipulation
  // BidEscrow is a PDA owned by our program
  let bid_escrow_info = ctx.accounts.winner_bid_escrow.to_account_info();
  let seller_info = ctx.accounts.seller.to_account_info();
  let treasury_info = ctx.accounts.treasury.to_account_info();

  // Transfer seller_receives to seller
  **bid_escrow_info.try_borrow_mut_lamports()? -= seller_receives;
  **seller_info.try_borrow_mut_lamports()? += seller_receives;

  // Transfer fee to treasury
  if fee > 0 {
    **bid_escrow_info.try_borrow_mut_lamports()? -= fee;
    **treasury_info.try_borrow_mut_lamports()? += fee;
  }

  // For SealedVickrey: refund excess collateral to winner
  // collateral = bid_escrow.amount, payment = payment_amount
  // The remaining lamports beyond rent belong to the winner
  if matches!(
    ctx.accounts.auction_config.auction_type,
    AuctionType::SealedVickrey { .. }
  ) {
    let collateral = ctx.accounts.winner_bid_escrow.amount;
    if collateral > payment_amount {
      let excess = collateral
        .checked_sub(payment_amount)
        .ok_or(AuctionError::Overflow)?;
      let winner_info = ctx.accounts.winner.to_account_info();
      **bid_escrow_info.try_borrow_mut_lamports()? -= excess;
      **winner_info.try_borrow_mut_lamports()? += excess;
    }
  }

  // Set status to Settled
  let auction = &mut ctx.accounts.auction_config;
  auction.status = AuctionStatus::Settled;

  Ok(())
}

#[derive(Accounts)]
pub struct SettleAuction<'info> {
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

  /// Winner's token account for the auctioned item
  #[account(
    mut,
    token::mint = item_mint,
    token::authority = winner,
  )]
  pub winner_item_account: Account<'info, TokenAccount>,

  /// Winner's bid escrow (source of payment)
  #[account(
    mut,
    seeds = [b"bid", auction_config.key().as_ref(), winner_bid_escrow.bidder.as_ref()],
    bump = winner_bid_escrow.bump,
    constraint = winner_bid_escrow.auction == auction_config.key() @ AuctionError::Unauthorized,
  )]
  pub winner_bid_escrow: Account<'info, BidEscrow>,

  /// CHECK: Winner account for item transfer validation
  #[account(mut)]
  pub winner: UncheckedAccount<'info>,

  /// CHECK: Seller receives payment (minus fee)
  #[account(
    mut,
    constraint = seller.key() == auction_config.seller @ AuctionError::Unauthorized,
  )]
  pub seller: UncheckedAccount<'info>,

  #[account(
    seeds = [b"house", auction_house.authority.as_ref()],
    bump = auction_house.bump,
  )]
  pub auction_house: Account<'info, AuctionHouse>,

  /// CHECK: Treasury receives fee
  #[account(
    mut,
    constraint = treasury.key() == auction_house.treasury @ AuctionError::Unauthorized,
  )]
  pub treasury: UncheckedAccount<'info>,

  pub token_program: Program<'info, Token>,
}
