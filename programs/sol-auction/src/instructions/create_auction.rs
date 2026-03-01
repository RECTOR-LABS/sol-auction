use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionHouse, AuctionStatus, AuctionType, AuctionTypeInput};

pub fn handler(
  ctx: Context<CreateAuction>,
  auction_id: u64,
  auction_type: AuctionTypeInput,
  start_time: i64,
  end_time: i64,
) -> Result<()> {
  require!(start_time < end_time, AuctionError::InvalidTimeRange);

  let auction = &mut ctx.accounts.auction_config;
  auction.seller = ctx.accounts.seller.key();
  auction.auction_id = auction_id;
  auction.item_mint = ctx.accounts.item_mint.key();
  auction.start_time = start_time;
  auction.end_time = end_time;
  auction.status = AuctionStatus::Created;
  auction.bump = ctx.bumps.auction_config;

  auction.auction_type = match auction_type {
    AuctionTypeInput::English {
      start_price,
      min_increment,
      anti_snipe_duration,
    } => AuctionType::English {
      start_price,
      min_increment,
      anti_snipe_duration,
      highest_bid: 0,
      highest_bidder: None,
      bid_count: 0,
    },
    AuctionTypeInput::Dutch {
      start_price,
      reserve_price,
    } => AuctionType::Dutch {
      start_price,
      reserve_price,
    },
    AuctionTypeInput::SealedVickrey {
      min_collateral,
      reveal_duration,
    } => AuctionType::SealedVickrey {
      min_collateral,
      reveal_end_time: end_time
        .checked_add(reveal_duration)
        .ok_or(AuctionError::Overflow)?,
      highest_bid: 0,
      second_bid: 0,
      winner: None,
      bid_count: 0,
    },
  };

  // Transfer item from seller to vault
  let cpi_accounts = Transfer {
    from: ctx.accounts.seller_item_account.to_account_info(),
    to: ctx.accounts.item_vault.to_account_info(),
    authority: ctx.accounts.seller.to_account_info(),
  };
  let cpi_ctx = CpiContext::new(
    ctx.accounts.token_program.to_account_info(),
    cpi_accounts,
  );
  token::transfer(cpi_ctx, 1)?;

  // Increment house auction count
  let house = &mut ctx.accounts.auction_house;
  house.total_auctions = house
    .total_auctions
    .checked_add(1)
    .ok_or(AuctionError::Overflow)?;

  Ok(())
}

#[derive(Accounts)]
#[instruction(auction_id: u64)]
pub struct CreateAuction<'info> {
  #[account(
    init,
    payer = seller,
    space = 8 + AuctionConfig::INIT_SPACE,
    seeds = [b"auction", seller.key().as_ref(), &auction_id.to_le_bytes()],
    bump,
  )]
  pub auction_config: Account<'info, AuctionConfig>,

  #[account(
    init,
    payer = seller,
    token::mint = item_mint,
    token::authority = auction_config,
    seeds = [b"vault", auction_config.key().as_ref()],
    bump,
  )]
  pub item_vault: Account<'info, TokenAccount>,

  #[account(mut)]
  pub auction_house: Account<'info, AuctionHouse>,

  pub item_mint: Account<'info, Mint>,

  #[account(
    mut,
    associated_token::mint = item_mint,
    associated_token::authority = seller,
  )]
  pub seller_item_account: Account<'info, TokenAccount>,

  #[account(mut)]
  pub seller: Signer<'info>,

  pub token_program: Program<'info, Token>,
  pub system_program: Program<'info, System>,
}
