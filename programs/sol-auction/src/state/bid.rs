use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct BidEscrow {
    pub auction: Pubkey,
    pub bidder: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    /// Sealed-bid fields
    pub commitment_hash: [u8; 32],
    pub revealed: bool,
    pub revealed_amount: u64, // 0 if not revealed
    pub bump: u8,
}
