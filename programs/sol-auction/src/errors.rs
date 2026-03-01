use anchor_lang::prelude::*;

#[error_code]
pub enum AuctionError {
  // Auction lifecycle
  #[msg("Auction has not started yet")]
  AuctionNotStarted,
  #[msg("Auction has already ended")]
  AuctionAlreadyEnded,
  #[msg("Auction is still active")]
  AuctionStillActive,
  #[msg("Auction has already been settled")]
  AuctionAlreadySettled,
  #[msg("Cannot cancel an auction that has bids")]
  CannotCancelWithBids,
  #[msg("Invalid auction status for this operation")]
  InvalidAuctionStatus,
  #[msg("End time must be after start time")]
  InvalidTimeRange,

  // Bidding
  #[msg("Bid amount is too low")]
  BidTooLow,
  #[msg("Seller cannot bid on their own auction")]
  SellerCannotBid,

  // Buy now
  #[msg("Insufficient payment for buy-now price")]
  InsufficientPayment,
  #[msg("Price is below the reserve")]
  PriceBelowReserve,

  // Sealed bid
  #[msg("Bidding phase has ended")]
  BiddingPhaseEnded,
  #[msg("Reveal phase has not started yet")]
  RevealPhaseNotStarted,
  #[msg("Reveal phase has ended")]
  RevealPhaseEnded,
  #[msg("Commitment hash does not match revealed bid")]
  HashMismatch,
  #[msg("Bid has already been revealed")]
  AlreadyRevealed,
  #[msg("Bid has not been revealed")]
  BidNotRevealed,
  #[msg("Insufficient collateral for sealed bid")]
  InsufficientCollateral,

  // General
  #[msg("Unauthorized access")]
  Unauthorized,
  #[msg("Arithmetic overflow")]
  Overflow,
  #[msg("Fee basis points must be <= 10000")]
  InvalidFeeBps,
  #[msg("No bids have been placed")]
  NoBids,
  #[msg("Bid not found")]
  BidNotFound,
}
