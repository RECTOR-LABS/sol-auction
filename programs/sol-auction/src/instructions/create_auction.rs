use anchor_lang::prelude::*;

use crate::state::AuctionTypeInput;

#[derive(Accounts)]
pub struct CreateAuction {}

pub fn handler(
  _ctx: Context<CreateAuction>,
  _auction_id: u64,
  _auction_type: AuctionTypeInput,
  _start_time: i64,
  _end_time: i64,
) -> Result<()> {
  Ok(())
}
