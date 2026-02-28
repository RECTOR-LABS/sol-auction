use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClaimRefund {}

pub fn handler(_ctx: Context<ClaimRefund>) -> Result<()> {
  Ok(())
}
