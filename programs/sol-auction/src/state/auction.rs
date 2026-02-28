use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum AuctionTypeInput {
  English,
  Dutch,
  SealedBid,
}
