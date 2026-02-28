use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct PlaceBid {}

pub fn handler(_ctx: Context<PlaceBid>, _amount: u64) -> Result<()> {
  Ok(())
}
