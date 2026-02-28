use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelAuction {}

pub fn handler(_ctx: Context<CancelAuction>) -> Result<()> {
  Ok(())
}
