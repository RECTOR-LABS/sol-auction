use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ForfeitUnrevealed {}

pub fn handler(_ctx: Context<ForfeitUnrevealed>) -> Result<()> {
  Ok(())
}
