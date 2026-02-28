use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RevealBid {}

pub fn handler(_ctx: Context<RevealBid>, _amount: u64, _nonce: [u8; 32]) -> Result<()> {
  Ok(())
}
