use anchor_lang::prelude::*;

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionStatus, AuctionType, BidEscrow};

pub fn handler(
    ctx: Context<SubmitSealedBid>,
    commitment_hash: [u8; 32],
    collateral: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let auction = &mut ctx.accounts.auction_config;

    // Validate timing: must be within bidding phase
    require!(
        clock.unix_timestamp >= auction.start_time,
        AuctionError::AuctionNotStarted
    );
    require!(
        clock.unix_timestamp < auction.end_time,
        AuctionError::BiddingPhaseEnded
    );
    require!(
        auction.status == AuctionStatus::Created || auction.status == AuctionStatus::Active,
        AuctionError::InvalidAuctionStatus
    );

    // Seller cannot bid
    require!(
        ctx.accounts.bidder.key() != auction.seller,
        AuctionError::SellerCannotBid
    );

    // Auto-activate on first valid interaction
    if auction.status == AuctionStatus::Created {
        auction.status = AuctionStatus::Active;
    }

    // Capture auction key before mutable borrow of auction_type
    let auction_key = auction.key();

    match &mut auction.auction_type {
        AuctionType::SealedVickrey {
            min_collateral,
            bid_count,
            ..
        } => {
            require!(
                collateral >= *min_collateral,
                AuctionError::InsufficientCollateral
            );

            // Escrow collateral: bidder -> bid_escrow PDA
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.bidder.to_account_info(),
                        to: ctx.accounts.bid_escrow.to_account_info(),
                    },
                ),
                collateral,
            )?;

            // Set bid escrow state
            let bid = &mut ctx.accounts.bid_escrow;
            bid.auction = auction_key;
            bid.bidder = ctx.accounts.bidder.key();
            bid.amount = collateral;
            bid.commitment_hash = commitment_hash;
            bid.revealed = false;
            bid.revealed_amount = 0;
            bid.timestamp = clock.unix_timestamp;
            bid.bump = ctx.bumps.bid_escrow;

            *bid_count = bid_count.checked_add(1).ok_or(AuctionError::Overflow)?;
        }
        _ => return Err(AuctionError::InvalidAuctionStatus.into()),
    }

    Ok(())
}

#[derive(Accounts)]
pub struct SubmitSealedBid<'info> {
    #[account(
    mut,
    seeds = [b"auction", auction_config.seller.as_ref(), &auction_config.auction_id.to_le_bytes()],
    bump = auction_config.bump,
  )]
    pub auction_config: Account<'info, AuctionConfig>,

    #[account(
    init,
    payer = bidder,
    space = 8 + BidEscrow::INIT_SPACE,
    seeds = [b"bid", auction_config.key().as_ref(), bidder.key().as_ref()],
    bump,
  )]
    pub bid_escrow: Account<'info, BidEscrow>,

    #[account(mut)]
    pub bidder: Signer<'info>,

    pub system_program: Program<'info, System>,
}
