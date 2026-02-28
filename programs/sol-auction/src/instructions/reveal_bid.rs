use anchor_lang::prelude::*;

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionStatus, AuctionType, BidEscrow};

pub fn handler(ctx: Context<RevealBid>, amount: u64, nonce: [u8; 32]) -> Result<()> {
  let clock = Clock::get()?;
  let auction = &mut ctx.accounts.auction_config;

  // Must be in BiddingClosed or RevealPhase status
  require!(
    auction.status == AuctionStatus::BiddingClosed
      || auction.status == AuctionStatus::RevealPhase,
    AuctionError::RevealPhaseNotStarted
  );

  match &mut auction.auction_type {
    AuctionType::SealedVickrey {
      reveal_end_time,
      highest_bid,
      second_bid,
      winner,
      ..
    } => {
      require!(
        clock.unix_timestamp <= *reveal_end_time,
        AuctionError::RevealPhaseEnded
      );

      let bid = &mut ctx.accounts.bid_escrow;
      require!(!bid.revealed, AuctionError::AlreadyRevealed);

      // Verify commitment hash: keccak256(amount_le_bytes || nonce)
      let mut hash_input = Vec::with_capacity(40);
      hash_input.extend_from_slice(&amount.to_le_bytes());
      hash_input.extend_from_slice(&nonce);
      let computed = solana_keccak_hasher::hash(&hash_input);
      require!(computed.0 == bid.commitment_hash, AuctionError::HashMismatch);

      // Collateral must cover the bid amount
      require!(bid.amount >= amount, AuctionError::InsufficientCollateral);

      bid.revealed = true;
      bid.revealed_amount = amount;

      // Track first and second highest bids (Vickrey mechanism)
      if amount > *highest_bid {
        *second_bid = *highest_bid;
        *highest_bid = amount;
        *winner = Some(ctx.accounts.bidder.key());
      } else if amount > *second_bid {
        *second_bid = amount;
      }

      // Transition to RevealPhase on first reveal
      if auction.status == AuctionStatus::BiddingClosed {
        auction.status = AuctionStatus::RevealPhase;
      }
    }
    _ => return Err(AuctionError::InvalidAuctionStatus.into()),
  }

  Ok(())
}

#[derive(Accounts)]
pub struct RevealBid<'info> {
  #[account(
    mut,
    seeds = [b"auction", auction_config.seller.as_ref(), &auction_config.auction_id.to_le_bytes()],
    bump = auction_config.bump,
  )]
  pub auction_config: Account<'info, AuctionConfig>,

  #[account(
    mut,
    seeds = [b"bid", auction_config.key().as_ref(), bidder.key().as_ref()],
    bump = bid_escrow.bump,
    constraint = bid_escrow.auction == auction_config.key() @ AuctionError::Unauthorized,
  )]
  pub bid_escrow: Account<'info, BidEscrow>,

  pub bidder: Signer<'info>,
}
