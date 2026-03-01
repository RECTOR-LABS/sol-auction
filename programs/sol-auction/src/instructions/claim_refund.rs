use anchor_lang::prelude::*;

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionStatus, AuctionType, BidEscrow};

pub fn handler(ctx: Context<ClaimRefund>) -> Result<()> {
    let auction = &ctx.accounts.auction_config;
    let bid = &ctx.accounts.bid_escrow;

    // Auction must be settled or cancelled
    require!(
        auction.status == AuctionStatus::Settled || auction.status == AuctionStatus::Cancelled,
        AuctionError::AuctionStillActive
    );

    // For English: bidder must NOT be the winner (winner's escrow was used in settlement)
    // For SealedVickrey: bidder must have revealed, and must NOT be the winner
    match &auction.auction_type {
        AuctionType::English { highest_bidder, .. } => {
            if let Some(winner) = highest_bidder {
                require!(bid.bidder != *winner, AuctionError::Unauthorized);
            }
        }
        AuctionType::SealedVickrey { winner, .. } => {
            // Must have revealed to claim refund
            require!(bid.revealed, AuctionError::BidNotRevealed);
            if let Some(w) = winner {
                require!(bid.bidder != *w, AuctionError::Unauthorized);
            }
        }
        _ => return Err(AuctionError::InvalidAuctionStatus.into()),
    }

    // Close bid_escrow, return all lamports to bidder
    // Handled by Anchor's `close = bidder` constraint on the account
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(
    seeds = [b"auction", auction_config.seller.as_ref(), &auction_config.auction_id.to_le_bytes()],
    bump = auction_config.bump,
  )]
    pub auction_config: Account<'info, AuctionConfig>,

    #[account(
    mut,
    close = bidder,
    seeds = [b"bid", auction_config.key().as_ref(), bidder.key().as_ref()],
    bump = bid_escrow.bump,
    constraint = bid_escrow.auction == auction_config.key() @ AuctionError::Unauthorized,
  )]
    pub bid_escrow: Account<'info, BidEscrow>,

    #[account(mut)]
    pub bidder: Signer<'info>,
}
