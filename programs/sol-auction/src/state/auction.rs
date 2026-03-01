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

#[cfg(test)]
mod tests {
    use super::*;

    fn clock_at(ts: i64) -> Clock {
        Clock {
            unix_timestamp: ts,
            slot: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            epoch_start_timestamp: 0,
        }
    }

    fn dutch_auction(start_price: u64, reserve_price: u64, start: i64, end: i64) -> AuctionConfig {
        AuctionConfig {
            seller: Pubkey::default(),
            auction_id: 1,
            auction_type: AuctionType::Dutch {
                start_price,
                reserve_price,
            },
            status: AuctionStatus::Active,
            item_mint: Pubkey::default(),
            start_time: start,
            end_time: end,
            bump: 0,
        }
    }

    fn english_auction(start_price: u64, highest_bid: u64) -> AuctionConfig {
        AuctionConfig {
            seller: Pubkey::default(),
            auction_id: 1,
            auction_type: AuctionType::English {
                start_price,
                min_increment: 100,
                anti_snipe_duration: 0,
                highest_bid,
                highest_bidder: None,
                bid_count: if highest_bid > 0 { 1 } else { 0 },
            },
            status: AuctionStatus::Active,
            item_mint: Pubkey::default(),
            start_time: 0,
            end_time: 1000,
            bump: 0,
        }
    }

    // ── Dutch Price Decay ─────────────────────────────

    #[test]
    fn dutch_at_start_returns_start_price() {
        let a = dutch_auction(1000, 200, 100, 200);
        assert_eq!(a.get_current_price(&clock_at(100)), Some(1000));
    }

    #[test]
    fn dutch_midpoint() {
        let a = dutch_auction(1000, 0, 0, 100);
        assert_eq!(a.get_current_price(&clock_at(50)), Some(500));
    }

    #[test]
    fn dutch_at_end_returns_reserve() {
        let a = dutch_auction(1000, 200, 0, 100);
        assert_eq!(a.get_current_price(&clock_at(100)), Some(200));
    }

    #[test]
    fn dutch_past_end_clamps_to_reserve() {
        let a = dutch_auction(1000, 200, 0, 100);
        assert_eq!(a.get_current_price(&clock_at(999)), Some(200));
    }

    #[test]
    fn dutch_zero_duration_returns_reserve() {
        let a = dutch_auction(1000, 200, 100, 100);
        assert_eq!(a.get_current_price(&clock_at(100)), Some(200));
    }

    #[test]
    fn dutch_quarter_elapsed() {
        let a = dutch_auction(1000, 0, 0, 100);
        assert_eq!(a.get_current_price(&clock_at(25)), Some(750));
    }

    #[test]
    fn dutch_large_values_no_overflow() {
        let a = dutch_auction(u64::MAX, 0, 0, 1000);
        let price = a.get_current_price(&clock_at(500));
        assert!(price.is_some());
        // ~50% of u64::MAX
        let p = price.unwrap();
        assert!(p > u64::MAX / 3);
    }

    // ── English ───────────────────────────────────────

    #[test]
    fn english_no_bids_returns_start_price() {
        let a = english_auction(500, 0);
        assert_eq!(a.get_current_price(&clock_at(50)), Some(500));
    }

    #[test]
    fn english_with_bids_returns_highest() {
        let a = english_auction(500, 1200);
        assert_eq!(a.get_current_price(&clock_at(50)), Some(1200));
    }

    // ── Sealed ────────────────────────────────────────

    #[test]
    fn sealed_returns_none() {
        let a = AuctionConfig {
            seller: Pubkey::default(),
            auction_id: 1,
            auction_type: AuctionType::SealedVickrey {
                min_collateral: 1000,
                reveal_end_time: 2000,
                highest_bid: 0,
                second_bid: 0,
                winner: None,
                bid_count: 0,
            },
            status: AuctionStatus::Active,
            item_mint: Pubkey::default(),
            start_time: 0,
            end_time: 1000,
            bump: 0,
        };
        assert_eq!(a.get_current_price(&clock_at(50)), None);
    }
}
