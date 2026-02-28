use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct BuyNow {}

pub fn handler(_ctx: Context<BuyNow>) -> Result<()> {
  Ok(())
}
