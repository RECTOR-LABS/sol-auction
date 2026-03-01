use crate::errors::AuctionError;
use crate::state::AuctionHouse;
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<InitializeHouse>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= 10_000, AuctionError::InvalidFeeBps);

    let house = &mut ctx.accounts.auction_house;
    house.authority = ctx.accounts.authority.key();
    house.fee_bps = fee_bps;
    house.treasury = ctx.accounts.authority.key();
    house.total_auctions = 0;
    house.bump = ctx.bumps.auction_house;

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeHouse<'info> {
    #[account(
    init,
    payer = authority,
    space = 8 + AuctionHouse::INIT_SPACE,
    seeds = [b"house", authority.key().as_ref()],
    bump,
  )]
    pub auction_house: Account<'info, AuctionHouse>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
