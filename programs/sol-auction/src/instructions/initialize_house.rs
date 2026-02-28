use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeHouse {}

pub fn handler(_ctx: Context<InitializeHouse>, _fee_bps: u16) -> Result<()> {
  Ok(())
}
