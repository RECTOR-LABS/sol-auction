# Sol-Auction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multi-type auction system (English, Dutch, Sealed-Bid Vickrey) as a single Solana Anchor program with full test suite, TypeScript CLI client, and devnet deployment — for Superteam bounty submission (deadline: March 16, 2026).

**Architecture:** Single Anchor program with enum-based dispatch across 3 auction types sharing a unified account model. PDA-based escrow for trustless fund holding, Keccak256 commit-reveal for sealed bids, Clock sysvar for time enforcement. TypeScript CLI client using @solana/kit. Tests via Bankrun with time-warping.

**Tech Stack:**
- Anchor 0.32.1, Solana CLI 3.0.13, Rust 1.93.0
- LiteSVM / Bankrun for testing (TS + time-warping)
- @solana/kit + @coral-xyz/anchor for CLI client
- Solana Devnet for deployment

**Design Doc:** `docs/plans/2026-02-28-sol-auction-design.md`

**Security Skill:** `@solana-dev/security.md` — consult for every instruction implementation.

---

## Task 1: Scaffold Anchor Project

**Files:**
- Create: `Anchor.toml`, `Cargo.toml`, `programs/sol-auction/Cargo.toml`, `programs/sol-auction/src/lib.rs`
- Create: `tests/sol-auction.ts`, `tsconfig.json`, `package.json`

**Step 1: Initialize Anchor workspace**

```bash
anchor init sol-auction --template single --force
```

Run from `/Users/rector/local-dev/sol-auction/`. The `--force` flag uses existing directory.

**Step 2: Verify scaffold builds**

```bash
anchor build
```

Expected: Successful build, `target/deploy/sol_auction.so` generated.

**Step 3: Verify default test passes**

```bash
anchor test
```

Expected: 1 passing test (the scaffold "Is initialized!" test).

**Step 4: Clean scaffold — replace default code with our module structure**

Replace `programs/sol-auction/src/lib.rs` with:

```rust
use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("SAuctGMuK9cqzaFnUoRbMCVi9sXo5q96PBRuXMGpump");

#[program]
pub mod sol_auction {
    use super::*;

    // --- Auction House ---
    pub fn initialize_house(
        ctx: Context<InitializeHouse>,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize_house(ctx, fee_bps)
    }

    // --- Auction Lifecycle ---
    pub fn create_auction(
        ctx: Context<CreateAuction>,
        auction_id: u64,
        auction_type: AuctionTypeInput,
        start_time: i64,
        end_time: i64,
    ) -> Result<()> {
        instructions::create_auction(ctx, auction_id, auction_type, start_time, end_time)
    }

    pub fn cancel_auction(ctx: Context<CancelAuction>) -> Result<()> {
        instructions::cancel_auction(ctx)
    }

    pub fn settle_auction(ctx: Context<SettleAuction>) -> Result<()> {
        instructions::settle_auction(ctx)
    }

    // --- English Auction ---
    pub fn place_bid(ctx: Context<PlaceBid>, amount: u64) -> Result<()> {
        instructions::place_bid(ctx, amount)
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        instructions::claim_refund(ctx)
    }

    // --- Dutch Auction ---
    pub fn buy_now(ctx: Context<BuyNow>) -> Result<()> {
        instructions::buy_now(ctx)
    }

    // --- Sealed-Bid Vickrey ---
    pub fn submit_sealed_bid(
        ctx: Context<SubmitSealedBid>,
        commitment_hash: [u8; 32],
        collateral: u64,
    ) -> Result<()> {
        instructions::submit_sealed_bid(ctx, commitment_hash, collateral)
    }

    pub fn reveal_bid(
        ctx: Context<RevealBid>,
        amount: u64,
        nonce: [u8; 32],
    ) -> Result<()> {
        instructions::reveal_bid(ctx, amount, nonce)
    }

    pub fn close_bidding(ctx: Context<CloseBidding>) -> Result<()> {
        instructions::close_bidding(ctx)
    }

    pub fn forfeit_unrevealed(ctx: Context<ForfeitUnrevealed>) -> Result<()> {
        instructions::forfeit_unrevealed(ctx)
    }
}
```

Note: `declare_id!` will use the generated keypair from `anchor build`. Replace the placeholder with the actual program ID from `target/deploy/sol_auction-keypair.json` after first build.

**Step 5: Create module files (stubs)**

Create `programs/sol-auction/src/state/mod.rs`:
```rust
pub mod auction;
pub mod bid;
pub mod house;

pub use auction::*;
pub use bid::*;
pub use house::*;
```

Create `programs/sol-auction/src/errors.rs`:
```rust
use anchor_lang::prelude::*;

#[error_code]
pub enum AuctionError {
    // Lifecycle
    #[msg("Auction has not started yet")]
    AuctionNotStarted,
    #[msg("Auction has already ended")]
    AuctionAlreadyEnded,
    #[msg("Auction is still active")]
    AuctionStillActive,
    #[msg("Auction has already been settled")]
    AuctionAlreadySettled,
    #[msg("Auction cannot be cancelled with existing bids")]
    CannotCancelWithBids,
    #[msg("Invalid auction status for this operation")]
    InvalidAuctionStatus,
    #[msg("Invalid time range: start must be before end")]
    InvalidTimeRange,

    // English
    #[msg("Bid amount is below minimum required")]
    BidTooLow,
    #[msg("Cannot bid on your own auction")]
    SellerCannotBid,

    // Dutch
    #[msg("Insufficient payment for current Dutch auction price")]
    InsufficientPayment,
    #[msg("Dutch auction price has decayed below reserve")]
    PriceBelowReserve,

    // Sealed-Bid
    #[msg("Bidding phase has ended")]
    BiddingPhaseEnded,
    #[msg("Reveal phase has not started")]
    RevealPhaseNotStarted,
    #[msg("Reveal phase has ended")]
    RevealPhaseEnded,
    #[msg("Commitment hash does not match revealed bid")]
    HashMismatch,
    #[msg("Bid has already been revealed")]
    AlreadyRevealed,
    #[msg("Bid has not been revealed — cannot claim refund")]
    BidNotRevealed,
    #[msg("Collateral must cover the bid amount")]
    InsufficientCollateral,

    // General
    #[msg("Unauthorized: you are not the auction authority")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Fee basis points must be <= 10000")]
    InvalidFeeBps,
    #[msg("No bids to settle")]
    NoBids,
    #[msg("Bid escrow not found for this bidder")]
    BidNotFound,
}
```

Create `programs/sol-auction/src/instructions/mod.rs`:
```rust
pub mod initialize_house;
pub mod create_auction;
pub mod cancel_auction;
pub mod settle_auction;
pub mod place_bid;
pub mod claim_refund;
pub mod buy_now;
pub mod submit_sealed_bid;
pub mod reveal_bid;
pub mod close_bidding;
pub mod forfeit_unrevealed;

pub use initialize_house::*;
pub use create_auction::*;
pub use cancel_auction::*;
pub use settle_auction::*;
pub use place_bid::*;
pub use claim_refund::*;
pub use buy_now::*;
pub use submit_sealed_bid::*;
pub use reveal_bid::*;
pub use close_bidding::*;
pub use forfeit_unrevealed::*;
```

Each instruction file is a stub returning `Ok(())` with empty context structs for now. Just enough to compile.

**Step 6: Add Anchor SPL dependencies to program Cargo.toml**

```toml
[dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
anchor-spl = { version = "0.32.1", features = ["token"] }
```

Note: We import `anchor-spl` but do NOT use `init-if-needed` in our code (security risk). The feature is for anchor-spl internals only.

**Step 7: Build and verify module structure compiles**

```bash
anchor build
```

Expected: Successful compilation with stub instructions.

**Step 8: Commit**

```bash
git add -A && git commit -m "feat: scaffold Anchor workspace with module structure"
```

---

## Task 2: Account State — AuctionHouse, AuctionConfig, BidEscrow

**Files:**
- Create: `programs/sol-auction/src/state/house.rs`
- Create: `programs/sol-auction/src/state/auction.rs`
- Create: `programs/sol-auction/src/state/bid.rs`

**Step 1: Implement AuctionHouse state**

`programs/sol-auction/src/state/house.rs`:
```rust
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct AuctionHouse {
    pub authority: Pubkey,
    pub fee_bps: u16,
    pub treasury: Pubkey,
    pub total_auctions: u64,
    pub bump: u8,
}
```

**Step 2: Implement AuctionConfig state with type enums**

`programs/sol-auction/src/state/auction.rs`:
```rust
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct AuctionConfig {
    pub seller: Pubkey,
    pub auction_id: u64,
    pub auction_type: AuctionType,
    pub status: AuctionStatus,
    pub item_mint: Pubkey,
    pub start_time: i64,
    pub end_time: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum AuctionStatus {
    Created,
    Active,
    BiddingClosed,
    RevealPhase,
    Settled,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub enum AuctionType {
    English {
        start_price: u64,
        min_increment: u64,
        anti_snipe_duration: i64,
        highest_bid: u64,
        highest_bidder: Option<Pubkey>,
        bid_count: u32,
    },
    Dutch {
        start_price: u64,
        reserve_price: u64,
    },
    SealedVickrey {
        min_collateral: u64,
        reveal_end_time: i64,
        highest_bid: u64,
        second_bid: u64,
        winner: Option<Pubkey>,
        bid_count: u32,
    },
}

/// Input enum for create_auction instruction (no runtime state fields).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum AuctionTypeInput {
    English {
        start_price: u64,
        min_increment: u64,
        anti_snipe_duration: i64,
    },
    Dutch {
        start_price: u64,
        reserve_price: u64,
    },
    SealedVickrey {
        min_collateral: u64,
        reveal_duration: i64,
    },
}

impl AuctionConfig {
    /// Max space for the largest enum variant (SealedVickrey).
    /// 8 (discriminator) + 32 (seller) + 8 (auction_id) + 1+8+8+8+8+33+4 (AuctionType::SealedVickrey)
    /// + 1+0 (AuctionStatus) + 32 (item_mint) + 8 (start_time) + 8 (end_time) + 1 (bump)
    /// We use InitSpace derive which calculates this automatically.
    pub fn get_current_price(&self, clock: &Clock) -> Option<u64> {
        match &self.auction_type {
            AuctionType::Dutch { start_price, reserve_price } => {
                let elapsed = clock.unix_timestamp.saturating_sub(self.start_time);
                let duration = self.end_time.saturating_sub(self.start_time);
                if duration == 0 {
                    return Some(*reserve_price);
                }
                let price_drop = (*start_price as i128)
                    .saturating_sub(*reserve_price as i128)
                    .saturating_mul(elapsed as i128)
                    / (duration as i128);
                let current = (*start_price as i128).saturating_sub(price_drop);
                Some(current.max(*reserve_price as i128) as u64)
            }
            AuctionType::English { highest_bid, start_price, .. } => {
                if *highest_bid > 0 {
                    Some(*highest_bid)
                } else {
                    Some(*start_price)
                }
            }
            AuctionType::SealedVickrey { .. } => None, // No public price
        }
    }
}
```

**Step 3: Implement BidEscrow state**

`programs/sol-auction/src/state/bid.rs`:
```rust
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
    pub revealed_amount: u64,  // 0 if not revealed
    pub bump: u8,
}
```

**Step 4: Build to verify state structs compile**

```bash
anchor build
```

Expected: Successful compilation.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: define account state — AuctionHouse, AuctionConfig, BidEscrow"
```

---

## Task 3: Instruction — initialize_house

**Files:**
- Implement: `programs/sol-auction/src/instructions/initialize_house.rs`
- Create: `tests/initialize-house.ts`

**Step 1: Write the failing test**

`tests/initialize-house.ts`:
```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolAuction } from "../target/types/sol_auction";
import { expect } from "chai";

describe("initialize_house", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  it("initializes auction house with correct state", async () => {
    const [housePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("house"), provider.wallet.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .initializeHouse(500) // 5% fee
      .accounts({
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const house = await program.account.auctionHouse.fetch(housePda);
    expect(house.authority.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(house.feeBps).to.equal(500);
    expect(house.treasury.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(house.totalAuctions.toNumber()).to.equal(0);
  });

  it("rejects fee_bps > 10000", async () => {
    try {
      await program.methods
        .initializeHouse(10001)
        .accounts({
          authority: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidFeeBps");
    }
  });
});
```

**Step 2: Run test to verify it fails**

```bash
anchor test -- --grep "initialize_house"
```

Expected: FAIL (instruction not implemented).

**Step 3: Implement initialize_house instruction**

`programs/sol-auction/src/instructions/initialize_house.rs`:
```rust
use anchor_lang::prelude::*;
use crate::errors::AuctionError;
use crate::state::AuctionHouse;

pub fn initialize_house(ctx: Context<InitializeHouse>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= 10_000, AuctionError::InvalidFeeBps);

    let house = &mut ctx.accounts.auction_house;
    house.authority = ctx.accounts.authority.key();
    house.fee_bps = fee_bps;
    house.treasury = ctx.accounts.authority.key(); // Default: authority is treasury
    house.total_auctions = 0;
    house.bump = ctx.bumps.auction_house;

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeHouse<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + AuctionHouse::INIT_SPACE,
        seeds = [b"house", authority.key().as_ref()],
        bump,
    )]
    pub auction_house: Account<'info, AuctionHouse>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

**Step 4: Run test to verify it passes**

```bash
anchor test -- --grep "initialize_house"
```

Expected: 2 passing tests.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: implement initialize_house instruction with tests"
```

---

## Task 4: Instruction — create_auction

**Files:**
- Implement: `programs/sol-auction/src/instructions/create_auction.rs`
- Create: `tests/create-auction.ts`

**Step 1: Write the failing tests**

`tests/create-auction.ts`:
```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolAuction } from "../target/types/sol_auction";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("create_auction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  let mint: anchor.web3.PublicKey;
  let sellerAta: anchor.web3.PublicKey;
  let housePda: anchor.web3.PublicKey;

  before(async () => {
    // Initialize auction house
    [housePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("house"), provider.wallet.publicKey.toBuffer()],
      program.programId,
    );

    // Only init if not already initialized
    try {
      await program.account.auctionHouse.fetch(housePda);
    } catch {
      await program.methods.initializeHouse(500).accounts({
        authority: provider.wallet.publicKey,
      }).rpc();
    }

    // Create NFT mint + seller ATA + mint 1 token
    mint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      0,
    );

    sellerAta = await createAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      provider.wallet.publicKey,
    );

    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      sellerAta,
      provider.wallet.publicKey,
      1,
    );
  });

  it("creates English auction and deposits item into vault", async () => {
    const auctionId = new anchor.BN(1);
    const now = Math.floor(Date.now() / 1000);

    const [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), auctionPda.toBuffer()],
      program.programId,
    );

    await program.methods
      .createAuction(
        auctionId,
        {
          english: {
            startPrice: new anchor.BN(anchor.web3.LAMPORTS_PER_SOL),
            minIncrement: new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 10),
            antiSnipeDuration: new anchor.BN(300),
          },
        },
        new anchor.BN(now + 10),
        new anchor.BN(now + 3610),
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // Verify auction state
    const auction = await program.account.auctionConfig.fetch(auctionPda);
    expect(auction.seller.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(auction.auctionId.toNumber()).to.equal(1);
    expect(auction.status).to.deep.include({ created: {} });
    expect(auction.itemMint.toBase58()).to.equal(mint.toBase58());

    // Verify item transferred to vault
    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(1);
  });

  it("rejects invalid time range (start >= end)", async () => {
    const auctionId = new anchor.BN(99);
    const now = Math.floor(Date.now() / 1000);

    try {
      await program.methods
        .createAuction(
          auctionId,
          {
            english: {
              startPrice: new anchor.BN(1_000_000_000),
              minIncrement: new anchor.BN(100_000_000),
              antiSnipeDuration: new anchor.BN(300),
            },
          },
          new anchor.BN(now + 100),
          new anchor.BN(now + 50), // end before start
        )
        .accounts({
          seller: provider.wallet.publicKey,
          auctionHouse: housePda,
          itemMint: mint,
          sellerItemAccount: sellerAta,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidTimeRange");
    }
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
anchor test -- --grep "create_auction"
```

Expected: FAIL.

**Step 3: Implement create_auction instruction**

`programs/sol-auction/src/instructions/create_auction.rs`:
```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::errors::AuctionError;
use crate::state::{AuctionConfig, AuctionHouse, AuctionStatus, AuctionType, AuctionTypeInput};

pub fn create_auction(
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

    // Convert input to full auction type with zeroed runtime fields
    auction.auction_type = match auction_type {
        AuctionTypeInput::English { start_price, min_increment, anti_snipe_duration } => {
            AuctionType::English {
                start_price,
                min_increment,
                anti_snipe_duration,
                highest_bid: 0,
                highest_bidder: None,
                bid_count: 0,
            }
        }
        AuctionTypeInput::Dutch { start_price, reserve_price } => {
            AuctionType::Dutch { start_price, reserve_price }
        }
        AuctionTypeInput::SealedVickrey { min_collateral, reveal_duration } => {
            AuctionType::SealedVickrey {
                min_collateral,
                reveal_end_time: end_time.checked_add(reveal_duration)
                    .ok_or(AuctionError::Overflow)?,
                highest_bid: 0,
                second_bid: 0,
                winner: None,
                bid_count: 0,
            }
        }
    };

    // Transfer item from seller to vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.seller_item_account.to_account_info(),
        to: ctx.accounts.item_vault.to_account_info(),
        authority: ctx.accounts.seller.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, 1)?;

    // Increment house auction count
    let house = &mut ctx.accounts.auction_house;
    house.total_auctions = house.total_auctions.checked_add(1)
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

    #[account(mut, has_one = authority @ AuctionError::Unauthorized)]
    pub auction_house: Account<'info, AuctionHouse>,

    /// CHECK: Authority of the auction house — validated via has_one on auction_house.
    pub authority: UncheckedAccount<'info>,

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
    pub rent: Sysvar<'info, Rent>,
}
```

Note: The `authority` check on `auction_house` ensures only auctions created through a valid house are allowed. However, the seller doesn't need to BE the authority — any seller can create auctions via a valid house. We'll adjust constraints based on test feedback.

**Step 4: Run tests to verify they pass**

```bash
anchor test -- --grep "create_auction"
```

Expected: 2 passing tests.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: implement create_auction with item vault deposit"
```

---

## Task 5: Instruction — place_bid (English Auction)

**Files:**
- Implement: `programs/sol-auction/src/instructions/place_bid.rs`
- Create: `tests/english-auction.ts`

**Step 1: Write the failing tests**

`tests/english-auction.ts` — tests for `place_bid`:
```typescript
// Test suite covering:
// 1. "places valid first bid on English auction"
//    - Create auction, warp time past start, place bid at start_price
//    - Verify BidEscrow created, SOL escrowed, auction.highest_bid updated
// 2. "outbids previous bidder and refunds them"
//    - Place higher bid from second bidder
//    - Verify first bidder refunded, new bid escrowed, auction state updated
// 3. "rejects bid below start_price (first bid)"
//    - Bid below start_price → expect BidTooLow error
// 4. "rejects bid below highest_bid + min_increment"
//    - After first bid, try bidding less than highest + min_increment
// 5. "rejects bid before auction start"
//    - Auction with future start_time → expect AuctionNotStarted
// 6. "rejects bid after auction end"
//    - Warp time past end_time → expect AuctionAlreadyEnded
// 7. "extends auction on anti-snipe trigger"
//    - Bid within anti_snipe_duration of end → end_time extended
// 8. "seller cannot bid on own auction"
//    - Seller tries to bid → expect SellerCannotBid
```

Each test follows the pattern: setup → action → assert state. SOL bids use system program transfers to BidEscrow PDA.

**Step 2: Implement place_bid**

Key logic:
```rust
pub fn place_bid(ctx: Context<PlaceBid>, amount: u64) -> Result<()> {
    let clock = Clock::get()?;
    let auction = &mut ctx.accounts.auction_config;

    // Validate timing
    require!(clock.unix_timestamp >= auction.start_time, AuctionError::AuctionNotStarted);
    require!(clock.unix_timestamp < auction.end_time, AuctionError::AuctionAlreadyEnded);
    require!(auction.status == AuctionStatus::Created || auction.status == AuctionStatus::Active,
        AuctionError::InvalidAuctionStatus);

    // Auto-activate on first valid interaction
    if auction.status == AuctionStatus::Created {
        auction.status = AuctionStatus::Active;
    }

    // Seller cannot bid
    require!(ctx.accounts.bidder.key() != auction.seller, AuctionError::SellerCannotBid);

    // Validate bid amount
    match &mut auction.auction_type {
        AuctionType::English {
            start_price, min_increment, anti_snipe_duration,
            highest_bid, highest_bidder, bid_count,
        } => {
            if *bid_count == 0 {
                require!(amount >= *start_price, AuctionError::BidTooLow);
            } else {
                require!(
                    amount >= highest_bid.checked_add(*min_increment).ok_or(AuctionError::Overflow)?,
                    AuctionError::BidTooLow
                );
            }

            // Escrow SOL from bidder → bid PDA
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.bidder.to_account_info(),
                        to: ctx.accounts.bid_escrow.to_account_info(),
                    },
                ),
                amount,
            )?;

            // Set bid escrow state
            let bid = &mut ctx.accounts.bid_escrow;
            bid.auction = auction.key();
            bid.bidder = ctx.accounts.bidder.key();
            bid.amount = amount;
            bid.timestamp = clock.unix_timestamp;
            bid.bump = ctx.bumps.bid_escrow;

            // Refund previous highest bidder if exists
            // (handled via separate refund instruction or inline via remaining_accounts)

            // Update auction state
            *highest_bid = amount;
            *highest_bidder = Some(ctx.accounts.bidder.key());
            *bid_count = bid_count.checked_add(1).ok_or(AuctionError::Overflow)?;

            // Anti-snipe extension
            let time_remaining = auction.end_time.saturating_sub(clock.unix_timestamp);
            if time_remaining < *anti_snipe_duration {
                auction.end_time = clock.unix_timestamp
                    .checked_add(*anti_snipe_duration)
                    .ok_or(AuctionError::Overflow)?;
            }
        }
        _ => return Err(AuctionError::InvalidAuctionStatus.into()),
    }

    Ok(())
}
```

**Step 3: Run tests, iterate until all 8 pass**

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: implement place_bid for English auctions with anti-snipe"
```

---

## Task 6: Instruction — buy_now (Dutch Auction)

**Files:**
- Implement: `programs/sol-auction/src/instructions/buy_now.rs`
- Create: `tests/dutch-auction.ts`

**Step 1: Write the failing tests**

```typescript
// Test suite covering:
// 1. "buys at initial price (t=0)"
//    - Start Dutch auction, buy immediately → pays start_price
// 2. "buys at decayed price (t=halfway)"
//    - Warp to midpoint → pays (start_price + reserve_price) / 2
// 3. "buys at reserve price (t=end)"
//    - Warp to near end → pays reserve_price
// 4. "rejects buy before auction starts"
// 5. "rejects buy after auction already settled"
// 6. "seller cannot buy own Dutch auction"
// 7. "item transfers to buyer, SOL to seller, auction settles atomically"
```

**Step 2: Implement buy_now**

Key logic — Dutch auctions settle atomically in one instruction:
```rust
pub fn buy_now(ctx: Context<BuyNow>) -> Result<()> {
    let clock = Clock::get()?;
    let auction = &mut ctx.accounts.auction_config;

    require!(clock.unix_timestamp >= auction.start_time, AuctionError::AuctionNotStarted);
    require!(auction.status == AuctionStatus::Created || auction.status == AuctionStatus::Active,
        AuctionError::InvalidAuctionStatus);

    let price = auction.get_current_price(&clock).ok_or(AuctionError::PriceBelowReserve)?;

    // Transfer SOL: buyer → seller
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.seller.to_account_info(),
            },
        ),
        price,
    )?;

    // Transfer item: vault → buyer (PDA-signed)
    let auction_key = auction.key();
    let seeds = &[b"vault".as_ref(), auction_key.as_ref(), &[ctx.bumps.item_vault]];
    let signer = &[&seeds[..]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.item_vault.to_account_info(),
                to: ctx.accounts.buyer_item_account.to_account_info(),
                authority: ctx.accounts.item_vault.to_account_info(),
            },
            signer,
        ),
        1,
    )?;

    auction.status = AuctionStatus::Settled;
    Ok(())
}
```

Note: The vault PDA is the authority for the token transfer. The vault signs via PDA seeds.

Actually, we need the auction_config PDA as the vault authority (set during create_auction). Let me correct: the vault's authority is `auction_config`, not the vault itself. So we sign with auction_config seeds.

**Step 3: Run tests, iterate until all pass**

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: implement buy_now for Dutch auctions with linear price decay"
```

---

## Task 7: Instruction — submit_sealed_bid + reveal_bid (Sealed-Bid Vickrey)

**Files:**
- Implement: `programs/sol-auction/src/instructions/submit_sealed_bid.rs`
- Implement: `programs/sol-auction/src/instructions/reveal_bid.rs`
- Create: `tests/sealed-auction.ts`

**Step 1: Write the failing tests**

```typescript
// Tests covering:
// 1. "submits sealed bid with valid commitment hash"
//    - Hash = keccak256(amount || nonce), escrow collateral
//    - Verify BidEscrow state: commitment_hash set, revealed = false
// 2. "reveals bid with correct amount and nonce"
//    - After bidding closes, reveal with matching amount+nonce
//    - Verify hash match, revealed = true, revealed_amount set
// 3. "rejects reveal with wrong nonce (hash mismatch)"
// 4. "rejects reveal during bidding phase (too early)"
// 5. "rejects reveal after reveal period ended"
// 6. "rejects double-reveal"
// 7. "rejects sealed bid after bidding phase closed"
// 8. "rejects insufficient collateral"
// 9. "tracks highest and second-highest bids correctly after reveals"
```

Helper for client-side hash generation:
```typescript
import { keccak_256 } from "@noble/hashes/sha3";

function computeCommitmentHash(amount: anchor.BN, nonce: Uint8Array): Uint8Array {
  const amountBytes = amount.toArrayLike(Buffer, "le", 8);
  const data = Buffer.concat([amountBytes, nonce]);
  return keccak_256(data);
}
```

**Step 2: Implement submit_sealed_bid**

```rust
pub fn submit_sealed_bid(
    ctx: Context<SubmitSealedBid>,
    commitment_hash: [u8; 32],
    collateral: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let auction = &mut ctx.accounts.auction_config;

    require!(clock.unix_timestamp >= auction.start_time, AuctionError::AuctionNotStarted);
    require!(clock.unix_timestamp < auction.end_time, AuctionError::BiddingPhaseEnded);
    require!(
        auction.status == AuctionStatus::Created || auction.status == AuctionStatus::Active,
        AuctionError::InvalidAuctionStatus
    );

    if auction.status == AuctionStatus::Created {
        auction.status = AuctionStatus::Active;
    }

    match &mut auction.auction_type {
        AuctionType::SealedVickrey { min_collateral, bid_count, .. } => {
            require!(collateral >= *min_collateral, AuctionError::InsufficientCollateral);

            // Escrow collateral
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.bidder.to_account_info(),
                        to: ctx.accounts.bid_escrow.to_account_info(),
                    },
                ),
                collateral,
            )?;

            let bid = &mut ctx.accounts.bid_escrow;
            bid.auction = auction.key();
            bid.bidder = ctx.accounts.bidder.key();
            bid.amount = collateral;
            bid.commitment_hash = commitment_hash;
            bid.revealed = false;
            bid.revealed_amount = 0;
            bid.timestamp = clock.unix_timestamp;
            bid.bump = ctx.bumps.bid_escrow;

            *bid_count = bid_count.checked_add(1).ok_or(AuctionError::Overflow)?;
        }
        _ => return Err(AuctionError::InvalidAuctionStatus.into()),
    }

    Ok(())
}
```

**Step 3: Implement reveal_bid**

```rust
pub fn reveal_bid(
    ctx: Context<RevealBid>,
    amount: u64,
    nonce: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let auction = &mut ctx.accounts.auction_config;

    require!(
        auction.status == AuctionStatus::BiddingClosed || auction.status == AuctionStatus::RevealPhase,
        AuctionError::RevealPhaseNotStarted
    );

    match &mut auction.auction_type {
        AuctionType::SealedVickrey { reveal_end_time, highest_bid, second_bid, winner, .. } => {
            require!(clock.unix_timestamp <= *reveal_end_time, AuctionError::RevealPhaseEnded);

            let bid = &mut ctx.accounts.bid_escrow;
            require!(!bid.revealed, AuctionError::AlreadyRevealed);

            // Verify commitment hash
            let mut hash_input = amount.to_le_bytes().to_vec();
            hash_input.extend_from_slice(&nonce);
            let computed = anchor_lang::solana_program::keccak::hash(&hash_input);
            require!(computed.0 == bid.commitment_hash, AuctionError::HashMismatch);

            // Verify collateral covers bid
            require!(bid.amount >= amount, AuctionError::InsufficientCollateral);

            bid.revealed = true;
            bid.revealed_amount = amount;

            // Update first/second price tracking
            if amount > *highest_bid {
                *second_bid = *highest_bid;
                *highest_bid = amount;
                *winner = Some(ctx.accounts.bidder.key());
            } else if amount > *second_bid {
                *second_bid = amount;
            }

            // Transition to reveal phase on first reveal
            if auction.status == AuctionStatus::BiddingClosed {
                auction.status = AuctionStatus::RevealPhase;
            }
        }
        _ => return Err(AuctionError::InvalidAuctionStatus.into()),
    }

    Ok(())
}
```

**Step 4: Run tests, iterate until all pass**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: implement sealed-bid with Keccak256 commit-reveal"
```

---

## Task 8: Instructions — close_bidding + forfeit_unrevealed (Sealed-Bid)

**Files:**
- Implement: `programs/sol-auction/src/instructions/close_bidding.rs`
- Implement: `programs/sol-auction/src/instructions/forfeit_unrevealed.rs`
- Add tests to: `tests/sealed-auction.ts`

**Step 1: Write failing tests**

```typescript
// Tests:
// 1. "transitions auction from Active to BiddingClosed after end_time"
// 2. "rejects close_bidding before end_time"
// 3. "forfeits unrevealed bid — collateral transferred to seller"
//    - After reveal_end_time, unrevealed bid's collateral goes to seller
// 4. "rejects forfeit before reveal period ends"
// 5. "rejects forfeit on already-revealed bid"
```

**Step 2: Implement close_bidding**

```rust
pub fn close_bidding(ctx: Context<CloseBidding>) -> Result<()> {
    let clock = Clock::get()?;
    let auction = &mut ctx.accounts.auction_config;

    require!(
        auction.status == AuctionStatus::Active,
        AuctionError::InvalidAuctionStatus
    );
    require!(clock.unix_timestamp >= auction.end_time, AuctionError::AuctionStillActive);

    auction.status = AuctionStatus::BiddingClosed;
    Ok(())
}
```

**Step 3: Implement forfeit_unrevealed**

```rust
pub fn forfeit_unrevealed(ctx: Context<ForfeitUnrevealed>) -> Result<()> {
    let clock = Clock::get()?;
    let auction = &ctx.accounts.auction_config;

    match &auction.auction_type {
        AuctionType::SealedVickrey { reveal_end_time, .. } => {
            require!(clock.unix_timestamp > *reveal_end_time, AuctionError::RevealPhaseNotStarted);
        }
        _ => return Err(AuctionError::InvalidAuctionStatus.into()),
    }

    let bid = &ctx.accounts.bid_escrow;
    require!(!bid.revealed, AuctionError::AlreadyRevealed);

    // Transfer collateral from bid escrow to seller (close account)
    // The bid_escrow account is closed, lamports go to seller
    Ok(())
}
```

Uses Anchor `close = seller` constraint on the bid_escrow account in the context struct.

**Step 4: Run tests, iterate**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: implement close_bidding and forfeit_unrevealed for sealed bids"
```

---

## Task 9: Instructions — settle_auction + cancel_auction + claim_refund

**Files:**
- Implement: `programs/sol-auction/src/instructions/settle_auction.rs`
- Implement: `programs/sol-auction/src/instructions/cancel_auction.rs`
- Implement: `programs/sol-auction/src/instructions/claim_refund.rs`
- Create: `tests/settlement.ts`

**Step 1: Write failing tests**

```typescript
// settle_auction tests:
// 1. "settles English auction — item to winner, SOL to seller"
// 2. "settles Sealed-Bid — winner pays second-highest price"
// 3. "deducts fee_bps and sends to treasury"
// 4. "rejects settle before auction ends"
// 5. "rejects settle with no bids"

// cancel_auction tests:
// 6. "cancels auction with no bids — item returned to seller"
// 7. "rejects cancel after bids placed"
// 8. "rejects cancel by non-seller"

// claim_refund tests:
// 9. "losing English bidder claims refund"
// 10. "losing sealed bidder claims refund (if revealed)"
// 11. "rejects refund for unrevealed sealed bid"
// 12. "rejects refund for winning bidder"
```

**Step 2: Implement settle_auction**

Key logic:
- English: Transfer highest_bid SOL (minus fees) to seller, item to highest_bidder
- SealedVickrey: Winner pays second_bid price (Vickrey mechanism), item to winner, refund difference
- Dutch: Already settled atomically in buy_now (this instruction is a no-op / error for Dutch)
- Fee calculation: `fee = amount * fee_bps / 10_000`
- All transfers are PDA-signed

**Step 3: Implement cancel_auction**

```rust
// Only allowed if:
// - Status is Created (no bids yet)
// - Caller is the seller
// Return item from vault to seller, close auction account
```

**Step 4: Implement claim_refund**

```rust
// For English: any non-winning bidder can reclaim their escrowed SOL
// For SealedVickrey: any revealed, non-winning bidder can reclaim
// Close the bid_escrow account, return lamports to bidder
```

**Step 5: Run tests, iterate until all 12 pass**

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: implement settle, cancel, and claim_refund instructions"
```

---

## Task 10: Integration Tests — Full Auction Lifecycles

**Files:**
- Create: `tests/lifecycle-english.ts`
- Create: `tests/lifecycle-dutch.ts`
- Create: `tests/lifecycle-sealed.ts`

**Step 1: Write English lifecycle test**

Full flow: create → bid1 → bid2 (outbid, refund bid1) → bid3 (anti-snipe trigger) → settle → claim_refund for bid2 → verify all balances.

**Step 2: Write Dutch lifecycle test**

Full flow: create → warp to midpoint → buy_now → verify item + SOL + settled status.

**Step 3: Write Sealed-Bid lifecycle test**

Full flow: create → submit 3 sealed bids → close_bidding → reveal all 3 → settle (winner pays second price) → claim_refund for losers → forfeit_unrevealed for any non-revealer.

**Step 4: Run full test suite**

```bash
anchor test
```

Expected: All tests passing, 90%+ instruction coverage.

**Step 5: Commit**

```bash
git add -A && git commit -m "test: add full lifecycle integration tests for all auction types"
```

---

## Task 11: TypeScript CLI Client

**Files:**
- Create: `cli/src/index.ts`
- Create: `cli/src/commands/create.ts`
- Create: `cli/src/commands/bid.ts`
- Create: `cli/src/commands/buy.ts`
- Create: `cli/src/commands/sealed.ts`
- Create: `cli/src/commands/manage.ts`
- Create: `cli/src/utils.ts`
- Create: `cli/package.json`, `cli/tsconfig.json`

**Step 1: Scaffold CLI with commander.js**

```bash
mkdir -p cli/src/commands
cd cli && pnpm init && pnpm add @coral-xyz/anchor @solana/web3.js @solana/spl-token commander chalk
```

**Step 2: Implement CLI commands**

Commands mapping to the design doc:
```
sol-auction create english --mint <MINT> --start-price 1.0 --duration 3600
sol-auction create dutch --mint <MINT> --start-price 10.0 --reserve 1.0 --duration 1800
sol-auction create sealed --mint <MINT> --min-collateral 5.0 --bid-duration 3600 --reveal-duration 1800
sol-auction bid <AUCTION_ID> --amount 2.5
sol-auction buy <AUCTION_ID>
sol-auction submit-sealed <AUCTION_ID> --amount 5.0 --nonce <NONCE>
sol-auction reveal <AUCTION_ID> --amount 5.0 --nonce <NONCE>
sol-auction settle <AUCTION_ID>
sol-auction cancel <AUCTION_ID>
sol-auction status <AUCTION_ID>
```

**Step 3: Test CLI locally against test validator**

```bash
anchor localnet &
cd cli && npx tsx src/index.ts create english --mint <TEST_MINT> --start-price 1.0 --duration 3600
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add TypeScript CLI client for all auction operations"
```

---

## Task 12: Devnet Deployment + Transaction Links

**Files:**
- Modify: `Anchor.toml` (add devnet cluster config)
- Create: `docs/devnet-deployment.md`

**Step 1: Configure Anchor.toml for devnet**

```toml
[programs.devnet]
sol_auction = "PROGRAM_ID_HERE"

[provider]
cluster = "devnet"
wallet = "~/.config/solana/id.json"
```

**Step 2: Deploy to devnet**

```bash
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

Note: Ask RECTOR to fund the deploy wallet if needed (per CLAUDE.md — devnet SOL from treasury).

**Step 3: Run demo transactions and capture tx links**

Run each auction type end-to-end via CLI on devnet, capture Solana Explorer links:
- English auction: create → bid → bid → settle
- Dutch auction: create → buy_now
- Sealed-bid: create → submit → close → reveal → settle

Document all tx links in `docs/devnet-deployment.md`.

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: deploy to devnet with demo transaction links"
```

---

## Task 13: README — Web2 vs Solana Analysis + Final Polish

**Files:**
- Modify: `README.md`

**Step 1: Expand README with full bounty deliverables**

Structure:
1. Overview (what this is, why it matters)
2. Auction Types (English, Dutch, Sealed-Bid) with diagrams
3. Architecture (account model, state machine, PDA layout)
4. Web2 vs Solana comparison table (from design doc, expanded with implementation insights)
5. Design tradeoffs and constraints encountered
6. Getting Started (build, test, deploy)
7. CLI Usage with examples
8. Devnet deployment links
9. Test coverage report
10. License

**Step 2: Generate test coverage stats**

```bash
anchor test 2>&1 | tail -20
```

Include passing test count and instruction coverage in README.

**Step 3: Final review pass**

- All links work
- Code examples in README match actual CLI
- Devnet links are live
- Architecture diagrams are accurate

**Step 4: Commit**

```bash
git add -A && git commit -m "docs: comprehensive README with Web2 vs Solana analysis"
```

---

## Task 14: Security Review + Final Audit

**Files:**
- Review all `programs/sol-auction/src/instructions/*.rs`

**Step 1: Run through @solana-dev security checklist**

For every instruction, verify:
- [ ] Account owners validated (typed accounts or explicit checks)
- [ ] Signer requirements explicit
- [ ] PDA seeds canonical and unique
- [ ] No arbitrary CPI targets
- [ ] Checked arithmetic throughout
- [ ] No reinitialization possible
- [ ] Close accounts properly (discriminator + drain)
- [ ] No duplicate mutable account vulnerabilities
- [ ] Token mint ↔ token account relationships validated

**Step 2: Edge case review**

- What happens if settle is called twice?
- What happens if claim_refund is called by the winner?
- What happens if bid amount exactly equals highest_bid (not > min_increment)?
- What happens if anti_snipe_duration > remaining time?
- What happens if reveal_end_time overflows i64?
- What happens if collateral < bid amount in sealed bid?

**Step 3: Fix any issues found**

**Step 4: Commit**

```bash
git add -A && git commit -m "fix: security hardening from audit checklist"
```

---

## Execution Summary

| Task | Description | Est. Commits |
|------|-------------|-------------|
| 1 | Scaffold Anchor workspace | 1 |
| 2 | Account state definitions | 1 |
| 3 | initialize_house instruction | 1 |
| 4 | create_auction instruction | 1 |
| 5 | place_bid (English) | 1 |
| 6 | buy_now (Dutch) | 1 |
| 7 | submit_sealed_bid + reveal_bid | 1 |
| 8 | close_bidding + forfeit_unrevealed | 1 |
| 9 | settle + cancel + claim_refund | 1 |
| 10 | Full lifecycle integration tests | 1 |
| 11 | TypeScript CLI client | 1 |
| 12 | Devnet deployment | 1 |
| 13 | README + Web2 vs Solana analysis | 1 |
| 14 | Security review + hardening | 1 |

**Total: ~14 commits, 14 tasks**

**Critical path**: Tasks 1-9 are sequential (each builds on previous). Tasks 10-14 can partially parallelize after Task 9.
