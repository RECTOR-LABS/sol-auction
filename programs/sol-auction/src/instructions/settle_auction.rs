use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SettleAuction {}

pub fn handler(_ctx: Context<SettleAuction>) -> Result<()> {
  Ok(())
}
