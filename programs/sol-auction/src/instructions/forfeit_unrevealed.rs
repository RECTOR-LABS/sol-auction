use anchor_lang::prelude::*;

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionType, BidEscrow};

pub fn handler(ctx: Context<ForfeitUnrevealed>) -> Result<()> {
    let clock = Clock::get()?;
    let auction = &ctx.accounts.auction_config;

    match &auction.auction_type {
        AuctionType::SealedVickrey {
            reveal_end_time, ..
        } => {
            require!(
                clock.unix_timestamp > *reveal_end_time,
                AuctionError::RevealPhaseNotStarted
            );
        }
        _ => return Err(AuctionError::InvalidAuctionStatus.into()),
    }

    let bid = &ctx.accounts.bid_escrow;
    require!(!bid.revealed, AuctionError::AlreadyRevealed);

    // The bid_escrow account is closed via Anchor's `close = seller` constraint.
    // All lamports (rent + escrowed collateral) transfer to the seller.
    Ok(())
}

#[derive(Accounts)]
pub struct ForfeitUnrevealed<'info> {
    #[account(
    seeds = [b"auction", auction_config.seller.as_ref(), &auction_config.auction_id.to_le_bytes()],
    bump = auction_config.bump,
  )]
    pub auction_config: Account<'info, AuctionConfig>,

    #[account(
    mut,
    close = seller,
    seeds = [b"bid", auction_config.key().as_ref(), bid_escrow.bidder.as_ref()],
    bump = bid_escrow.bump,
    constraint = bid_escrow.auction == auction_config.key() @ AuctionError::Unauthorized,
  )]
    pub bid_escrow: Account<'info, BidEscrow>,

    /// CHECK: Seller receives forfeited collateral. Validated against auction_config.
    #[account(
    mut,
    constraint = seller.key() == auction_config.seller @ AuctionError::Unauthorized,
  )]
    pub seller: UncheckedAccount<'info>,
}
