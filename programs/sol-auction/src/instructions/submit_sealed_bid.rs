use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SubmitSealedBid {}

pub fn handler(
  _ctx: Context<SubmitSealedBid>,
  _commitment_hash: [u8; 32],
  _collateral: u64,
) -> Result<()> {
  Ok(())
}
