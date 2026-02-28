use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct AuctionHouse {
  pub authority: Pubkey,
  pub fee_bps: u16,
  pub treasury: Pubkey,
  pub total_auctions: u64,
  pub bump: u8,
}
