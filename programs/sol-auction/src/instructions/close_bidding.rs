use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CloseBidding {}

pub fn handler(_ctx: Context<CloseBidding>) -> Result<()> {
  Ok(())
}
