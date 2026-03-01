use anchor_lang::prelude::*;

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionStatus, AuctionType};

pub fn handler(ctx: Context<CloseBidding>) -> Result<()> {
  let clock = Clock::get()?;
  let auction = &mut ctx.accounts.auction_config;

  require!(
    auction.status == AuctionStatus::Active,
    AuctionError::InvalidAuctionStatus
  );
  require!(
    clock.unix_timestamp >= auction.end_time,
    AuctionError::AuctionStillActive
  );

  // Only valid for sealed auctions
  match &auction.auction_type {
    AuctionType::SealedVickrey { .. } => {}
    _ => return Err(AuctionError::InvalidAuctionStatus.into()),
  }

  auction.status = AuctionStatus::BiddingClosed;
  Ok(())
}

#[derive(Accounts)]
pub struct CloseBidding<'info> {
  #[account(
    mut,
    seeds = [b"auction", auction_config.seller.as_ref(), &auction_config.auction_id.to_le_bytes()],
    bump = auction_config.bump,
  )]
  pub auction_config: Account<'info, AuctionConfig>,
  // Permissionless crank — anyone can call close_bidding
}
