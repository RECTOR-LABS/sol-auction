use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct AuctionConfig {
  pub seller: Pubkey,
  pub auction_id: u64,
  pub auction_type: AuctionType,
  pub status: AuctionStatus,
  pub item_mint: Pubkey,
  pub start_time: i64,
  pub end_time: i64,
  pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub enum AuctionStatus {
  Created,
  Active,
  BiddingClosed,
  RevealPhase,
  Settled,
  Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, Debug)]
pub enum AuctionType {
  English {
    start_price: u64,
    min_increment: u64,
    anti_snipe_duration: i64,
    highest_bid: u64,
    highest_bidder: Option<Pubkey>,
    bid_count: u32,
  },
  Dutch {
    start_price: u64,
    reserve_price: u64,
  },
  SealedVickrey {
    min_collateral: u64,
    reveal_end_time: i64,
    highest_bid: u64,
    second_bid: u64,
    winner: Option<Pubkey>,
    bid_count: u32,
  },
}

/// Input enum for create_auction -- no runtime state fields.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum AuctionTypeInput {
  English {
    start_price: u64,
    min_increment: u64,
    anti_snipe_duration: i64,
  },
  Dutch {
    start_price: u64,
    reserve_price: u64,
  },
  SealedVickrey {
    min_collateral: u64,
    reveal_duration: i64,
  },
}

impl AuctionConfig {
  /// Calculate current price for Dutch auctions (linear decay).
  pub fn get_current_price(&self, clock: &Clock) -> Option<u64> {
    match &self.auction_type {
      AuctionType::Dutch {
        start_price,
        reserve_price,
      } => {
        let elapsed = clock.unix_timestamp.saturating_sub(self.start_time);
        let duration = self.end_time.saturating_sub(self.start_time);
        if duration == 0 {
          return Some(*reserve_price);
        }
        let price_drop = (*start_price as i128)
          .saturating_sub(*reserve_price as i128)
          .saturating_mul(elapsed as i128)
          / (duration as i128);
        let current = (*start_price as i128).saturating_sub(price_drop);
        Some(current.max(*reserve_price as i128) as u64)
      }
      AuctionType::English {
        highest_bid,
        start_price,
        ..
      } => {
        if *highest_bid > 0 {
          Some(*highest_bid)
        } else {
          Some(*start_price)
        }
      }
      AuctionType::SealedVickrey { .. } => None,
    }
  }
}
