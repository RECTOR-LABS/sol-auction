use anchor_lang::prelude::*;

pub mod errors;
pub mod helpers;
pub mod instructions;
pub mod state;

use instructions::*;
use state::AuctionTypeInput;

declare_id!("HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC");

#[program]
pub mod sol_auction {
    use super::*;

    pub fn initialize_house(ctx: Context<InitializeHouse>, fee_bps: u16) -> Result<()> {
        instructions::initialize_house::handler(ctx, fee_bps)
    }

    pub fn create_auction(
        ctx: Context<CreateAuction>,
        auction_id: u64,
        auction_type: AuctionTypeInput,
        start_time: i64,
        end_time: i64,
    ) -> Result<()> {
        instructions::create_auction::handler(ctx, auction_id, auction_type, start_time, end_time)
    }

    pub fn cancel_auction(ctx: Context<CancelAuction>) -> Result<()> {
        instructions::cancel_auction::handler(ctx)
    }

    pub fn settle_auction(ctx: Context<SettleAuction>) -> Result<()> {
        instructions::settle_auction::handler(ctx)
    }

    pub fn place_bid(ctx: Context<PlaceBid>, amount: u64) -> Result<()> {
        instructions::place_bid::handler(ctx, amount)
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        instructions::claim_refund::handler(ctx)
    }

    pub fn buy_now(ctx: Context<BuyNow>) -> Result<()> {
        instructions::buy_now::handler(ctx)
    }

    pub fn submit_sealed_bid(
        ctx: Context<SubmitSealedBid>,
        commitment_hash: [u8; 32],
        collateral: u64,
    ) -> Result<()> {
        instructions::submit_sealed_bid::handler(ctx, commitment_hash, collateral)
    }

    pub fn reveal_bid(ctx: Context<RevealBid>, amount: u64, nonce: [u8; 32]) -> Result<()> {
        instructions::reveal_bid::handler(ctx, amount, nonce)
    }

    pub fn close_bidding(ctx: Context<CloseBidding>) -> Result<()> {
        instructions::close_bidding::handler(ctx)
    }

    pub fn forfeit_unrevealed(ctx: Context<ForfeitUnrevealed>) -> Result<()> {
        instructions::forfeit_unrevealed::handler(ctx)
    }
}
