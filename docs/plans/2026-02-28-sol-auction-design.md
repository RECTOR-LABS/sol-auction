# Sol-Auction: Multi-Type Auction System Design

**Date**: 2026-02-28
**Context**: Superteam Bounty — "Rebuild Production Backend Systems as On-Chain Rust Programs"
**Prize**: 1,000 USDC (700/200/100)
**Deadline**: March 16, 2026

---

## Decision: Why Auction?

Scored **8.70/10** weighted across bounty criteria — highest of all 9 options analyzed.

| Criterion (Weight) | Score | Why |
|---|---|---|
| Architecture & account modeling (30%) | 9/10 | 5+ account types, state machines, escrow, crypto primitives |
| Code quality & Rust patterns (25%) | 9/10 | Enums, traits, Keccak256, generics, time logic, zero-copy |
| Correctness & testing (20%) | 8/10 | Rich state machine = many test paths, bankrun time-warping |
| Web2→Solana analysis (15%) | 9/10 | Every aspect contrasts meaningfully (escrow, timing, sealed bids, settlement) |
| UX/client usability (10%) | 7/10 | Multiple tx types but clean CLI UX |

**Differentiation**: No existing Solana impl unifies English + Dutch + Sealed-Bid under one program with trait-based architecture and Web2 contrast analysis. Existing impls are single-type and NFT-specific.

**Eliminated alternatives**: Escrow (overdone, 30-50% of submissions), RBAC (Sol Cerberus exists, 8-15 submissions expected), Rate Limiter (strong but lower architecture ceiling), Subscription (strong but cranker complexity), Order Matching (completion risk too high), Leaderboard (SOAR exists), API Key Mgmt (full impl already on dev.to), Job Queue (TukTuk exists).

---

## Architecture Overview

### Auction Types

#### 1. English Auction (Ascending Price)
- Seller sets start price, min increment, duration
- Bidders place increasing bids, each escrowed in PDA
- Previous highest bidder auto-refunded on outbid
- Anti-sniping: late bids extend auction by configurable duration
- Settlement: winner gets asset, seller gets payment, atomically

#### 2. Dutch Auction (Descending Price)
- Seller sets start price, reserve price, duration
- Price decays linearly over time: `current = start - (elapsed * (start - reserve) / duration)`
- First buyer at current price wins instantly
- No bid accounts needed — single-tx purchase
- Pure math, Clock sysvar driven

#### 3. Sealed-Bid Vickrey (Second-Price)
- Three phases: Bidding → Reveal → Settlement
- **Bidding phase**: Bidders submit `Keccak256(bid_amount || nonce)` + escrowed collateral
- **Reveal phase**: Bidders reveal plaintext bid + nonce, program verifies hash match
- **Settlement**: Highest bidder wins, pays second-highest price (Vickrey mechanism)
- Unrevealed bids forfeit collateral (incentivizes honest participation)

### Account Model

```
AuctionConfig PDA: [b"auction", seller.key(), auction_id]
├── seller: Pubkey
├── auction_type: enum { English, Dutch, SealedVickrey }
├── status: enum { Created, Active, BiddingClosed, RevealPhase, Settled, Cancelled }
├── item_mint: Pubkey
├── start_time: i64
├── end_time: i64
├── config: AuctionTypeConfig (enum variant data)
│   ├── English { start_price, min_increment, anti_snipe_duration, highest_bid, highest_bidder, bid_count }
│   ├── Dutch { start_price, reserve_price }
│   └── SealedVickrey { reveal_end_time, highest_bid, second_bid, winner, bid_count }
└── bump: u8

ItemVault PDA: [b"vault", auction.key()]
└── Token account holding the auctioned asset (NFT/SPL)

BidEscrow PDA: [b"bid", auction.key(), bidder.key()]
├── bidder: Pubkey
├── amount: u64
├── timestamp: i64
└── For sealed: commitment_hash: [u8; 32], revealed: bool, revealed_amount: Option<u64>

AuctionHouse PDA: [b"house", authority.key()]  (optional, global config)
├── authority: Pubkey
├── fee_bps: u16
├── treasury: Pubkey
└── total_auctions: u64
```

### Instruction Set (~12 instructions)

| Instruction | Auction Type | Description |
|---|---|---|
| `initialize_auction` | All | Create auction config + deposit item into vault |
| `place_bid` | English | Place bid, escrow funds, refund previous highest |
| `buy_now` | Dutch | Purchase at current descending price |
| `submit_sealed_bid` | Sealed | Submit commitment hash + escrow collateral |
| `reveal_bid` | Sealed | Reveal bid amount + nonce, verify hash |
| `settle_auction` | All | Transfer item to winner, payment to seller |
| `cancel_auction` | All | Cancel (only if no bids / before start) |
| `claim_refund` | English/Sealed | Losers reclaim escrowed funds |
| `extend_auction` | English | Anti-snipe extension (called internally) |
| `close_bidding` | Sealed | Transition from bidding to reveal phase |
| `forfeit_unrevealed` | Sealed | Claim collateral from unrevealed bids |
| `initialize_house` | — | Set up global auction house config |

### State Machine

```
Created → Active → (type-specific flow) → Settled
                 ↘ Cancelled

English:  Active → [bids, anti-snipe extensions] → Settled
Dutch:    Active → [price decay] → Settled (on first buy)
Sealed:   Active → BiddingClosed → RevealPhase → Settled
```

### Rust Patterns Showcased

- **Enum dispatch**: `AuctionType` and `AuctionStatus` enums with variant-specific logic
- **Trait abstraction**: `Auctionable` trait with per-type `validate_bid()`, `settle()`, `get_current_price()`
- **Keccak256**: `solana_program::keccak::hash()` for sealed bid commitments
- **Clock sysvar**: Time enforcement for deadlines, anti-sniping, price decay
- **PDA escrow**: Trustless fund holding via program-derived addresses
- **Zero-copy**: For larger accounts if needed (AuctionConfig with many bids)
- **Custom errors**: Granular error enum (`AuctionNotStarted`, `BidTooLow`, `HashMismatch`, `RevealPeriodEnded`, etc.)
- **Access control**: `has_one`, `constraint` macros for instruction-level auth

### Web2 → Solana Contrast (README Analysis Points)

| Dimension | Web2 (eBay/traditional) | Solana |
|---|---|---|
| **Trust** | Trust the platform operator | Trust the code (PDA escrow) |
| **Escrow** | PayPal/Stripe holds funds, disputes possible | PDA escrow, programmatic release, no disputes |
| **Timing** | Server-side cron, can be manipulated | Clock sysvar, consensus-enforced, deterministic |
| **Sealed bids** | Server sees all bids (trust operator) | Keccak256 commit-reveal, cryptographic guarantee |
| **Settlement** | Multi-step (charge → pay → ship → confirm) | Atomic in one transaction |
| **Anti-sniping** | Platform-specific rules, can be circumvented | On-chain, deterministic, transparent rules |
| **Bid history** | Private database, platform controls visibility | On-chain transactions, publicly verifiable forever |
| **Concurrency** | Row locks, optimistic concurrency, race conditions | Solana account locking, transaction-level atomicity |
| **Refunds** | Manual process, support tickets, days/weeks | Automatic via PDA escrow return, instant |
| **Auditability** | Internal logs, trust-based | Every bid = on-chain tx, permissionlessly auditable |

### Client (CLI)

TypeScript CLI using `@solana/kit` for all interactions:

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
sol-auction list --seller <PUBKEY>
```

### Testing Strategy

- **Unit tests**: Each instruction in isolation (Anchor test framework)
- **Integration tests**: Full auction lifecycle per type (Bankrun with time-warping)
- **Edge cases**: Bid at exact deadline, anti-snipe trigger, hash mismatch, double-reveal, cancel with bids, settle before end
- **State machine coverage**: Every valid and invalid transition tested
- **Target**: 90%+ coverage on program logic

### Deliverables (Bounty Requirements)

- [x] Rust implementation (Anchor)
- [ ] Deployed to Solana Devnet
- [ ] Public GitHub repository (RECTOR-LABS/sol-auction)
- [ ] README with Web2 vs Solana comparison, tradeoffs, constraints
- [ ] Devnet transaction links
- [ ] Testable client (TypeScript CLI)
