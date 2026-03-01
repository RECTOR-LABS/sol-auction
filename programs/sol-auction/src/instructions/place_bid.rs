use anchor_lang::prelude::*;

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionStatus, AuctionType, BidEscrow};

pub fn handler(ctx: Context<PlaceBid>, amount: u64) -> Result<()> {
    let clock = Clock::get()?;
    let auction = &mut ctx.accounts.auction_config;

    // 1. Validate timing
    require!(
        clock.unix_timestamp >= auction.start_time,
        AuctionError::AuctionNotStarted
    );
    require!(
        clock.unix_timestamp < auction.end_time,
        AuctionError::AuctionAlreadyEnded
    );
    require!(
        auction.status == AuctionStatus::Created || auction.status == AuctionStatus::Active,
        AuctionError::InvalidAuctionStatus
    );

    // 2. Auto-activate on first valid interaction
    if auction.status == AuctionStatus::Created {
        auction.status = AuctionStatus::Active;
    }

    // 3. Seller cannot bid
    require!(
        ctx.accounts.bidder.key() != auction.seller,
        AuctionError::SellerCannotBid
    );

    // Capture values before mutable borrow of auction_type
    let auction_key = auction.key();
    let end_time = auction.end_time;

    // 4. Validate bid amount & update state (English only)
    let anti_snipe_extension: Option<i64> = match &mut auction.auction_type {
        AuctionType::English {
            start_price,
            min_increment,
            anti_snipe_duration,
            highest_bid,
            highest_bidder,
            bid_count,
        } => {
            if *bid_count == 0 {
                require!(amount >= *start_price, AuctionError::BidTooLow);
            } else {
                let min_required = highest_bid
                    .checked_add(*min_increment)
                    .ok_or(AuctionError::Overflow)?;
                require!(amount >= min_required, AuctionError::BidTooLow);
            }

            // 5. Escrow SOL: bidder -> bid_escrow PDA
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.bidder.to_account_info(),
                        to: ctx.accounts.bid_escrow.to_account_info(),
                    },
                ),
                amount,
            )?;

            // 6. Set bid escrow state
            let bid = &mut ctx.accounts.bid_escrow;
            bid.auction = auction_key;
            bid.bidder = ctx.accounts.bidder.key();
            bid.amount = amount;
            bid.timestamp = clock.unix_timestamp;
            bid.commitment_hash = [0u8; 32]; // Not used for English
            bid.revealed = false;
            bid.revealed_amount = 0;
            bid.bump = ctx.bumps.bid_escrow;

            // 7. Update auction state
            *highest_bid = amount;
            *highest_bidder = Some(ctx.accounts.bidder.key());
            *bid_count = bid_count.checked_add(1).ok_or(AuctionError::Overflow)?;

            // 8. Calculate anti-snipe extension (applied after match to avoid borrow conflict)
            crate::helpers::calculate_anti_snipe_extension(
                clock.unix_timestamp,
                end_time,
                *anti_snipe_duration,
            )
        }
        _ => return Err(AuctionError::InvalidAuctionStatus.into()),
    };

    // Apply anti-snipe extension outside the match (no borrow conflict)
    if let Some(new_end) = anti_snipe_extension {
        auction.end_time = new_end;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct PlaceBid<'info> {
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
