<div align="center">

<pre>
███████╗ ██████╗ ██╗            █████╗ ██╗   ██╗ ██████╗████████╗██╗ ██████╗ ███╗   ██╗
██╔════╝██╔═══██╗██║           ██╔══██╗██║   ██║██╔════╝╚══██╔══╝██║██╔═══██╗████╗  ██║
███████╗██║   ██║██║     █████╗███████║██║   ██║██║        ██║   ██║██║   ██║██╔██╗ ██║
╚════██║██║   ██║██║     ╚════╝██╔══██║██║   ██║██║        ██║   ██║██║   ██║██║╚██╗██║
███████║╚██████╔╝███████╗      ██║  ██║╚██████╔╝╚██████╗   ██║   ██║╚██████╔╝██║ ╚████║
╚══════╝ ╚═════╝ ╚══════╝      ╚═╝  ╚═╝ ╚═════╝  ╚═════╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
</pre>

### Multi-Type Auction Engine on Solana

**English (ascending) · Dutch (descending) · Sealed-Bid Vickrey (second-price)**

Three fundamentally different auction mechanisms unified under one on-chain program with a shared account model, enum-based dispatch, and type-specific state machines.

[![CI](https://github.com/RECTOR-LABS/sol-auction/actions/workflows/ci.yml/badge.svg)](https://github.com/RECTOR-LABS/sol-auction/actions/workflows/ci.yml)
[![Anchor](https://img.shields.io/badge/Anchor-0.32.1-blueviolet)](https://www.anchor-lang.com/)
[![Solana](https://img.shields.io/badge/Solana-Devnet-14F195?logo=solana)](https://explorer.solana.com/address/HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC?cluster=devnet)
[![Rust](https://img.shields.io/badge/Rust-1.89-orange?logo=rust)](https://www.rust-lang.org/)
[![Tests](https://img.shields.io/badge/Tests-63%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Getting Started](#-getting-started) · [Architecture](#-architecture) · [Devnet Proof](#-devnet-deployment) · [Web2 vs Solana](#-web2-vs-solana-architecture-comparison)

</div>

---

## 📚 Table of Contents

- [Auction Types](#-auction-types)
- [Architecture](#-architecture)
- [Web2 vs Solana Comparison](#-web2-vs-solana-architecture-comparison)
- [Design Decisions](#-design-decisions--tradeoffs)
- [Security Model](#-security-model)
- [Getting Started](#-getting-started)
- [CLI Usage](#-cli-usage)
- [Test Coverage](#-test-coverage)
- [Devnet Deployment](#-devnet-deployment)
- [Tech Stack](#-tech-stack)

---

## 🏛️ Auction Types

### English Auction (Ascending Price)

Bidders compete by placing increasing bids. Each bid is escrowed in a PDA, and the previous highest bidder's funds become reclaimable. Anti-sniping logic extends the deadline when late bids arrive.

> **On-chain patterns**: PDA escrow per bidder, Clock sysvar deadline enforcement, automatic anti-snipe extension.

```
Seller sets: start_price, min_increment, anti_snipe_duration, duration

  Created ──[first bid]──> Active ──[bids accumulate]──> Active
                                                           |
                             [late bid within anti_snipe] ─┤─> end_time extended
                                                           |
                                      [end_time reached] ──┴──> Settled
                                                                   |
                                              [losers claim_refund]┘
```

### Dutch Auction (Descending Price)

Price starts high and decays linearly toward a reserve floor. The first buyer to accept the current price wins instantly — no bid escrow needed, the entire purchase settles atomically in one transaction.

> **On-chain patterns**: Clock sysvar price calculation, pure math (no stored bids), atomic single-tx settlement.

```
Price decay: current = start - (elapsed × (start - reserve) / duration)

  Created ──[time passes, price drops]──> Active ──[buy_now]──> Settled

  price ─────────────
    |  \
    |   \  linear decay
    |    \
    |     \_____ reserve_price
    |
    start                  end                                 time
```

### Sealed-Bid Vickrey (Second-Price)

Three-phase auction with cryptographic bid concealment. Bidders submit `Keccak256(bid_amount || nonce)` commitment hashes with escrowed collateral. After bidding closes, a reveal window opens where bidders prove their bids match their commitments. The highest bidder wins but pays the **second-highest price** (Vickrey mechanism), incentivizing truthful bidding.

> **On-chain patterns**: Keccak256 commit-reveal, phased state machine, collateral forfeiture, second-price settlement.

```
  Created ──[sealed bids]──> Active ──[end_time]──> BiddingClosed
                                                         |
                                              [reveals]──┴──> RevealPhase
                                                                  |
                                            [reveal_end_time] ───┘
                                                                  |
                                        [settle: winner pays 2nd price]
                                                                  |
                                        [forfeit_unrevealed: collateral -> seller]
                                        [claim_refund: losers reclaim collateral]
```

---

## 🏗️ Architecture

### Account Model

Four PDA types with deterministic derivation:

```
AuctionHouse PDA: seeds = [b"house", authority.key()]
├── authority: Pubkey           // House operator
├── fee_bps: u16               // Fee in basis points (e.g., 500 = 5%)
├── treasury: Pubkey           // Fee recipient
├── total_auctions: u64        // Global counter
└── bump: u8

AuctionConfig PDA: seeds = [b"auction", seller.key(), &auction_id.to_le_bytes()]
├── seller: Pubkey
├── auction_id: u64
├── auction_type: AuctionType  // Enum with variant-specific data
│   ├── English { start_price, min_increment, anti_snipe_duration,
│   │            highest_bid, highest_bidder, bid_count }
│   ├── Dutch { start_price, reserve_price }
│   └── SealedVickrey { min_collateral, reveal_end_time,
│                       highest_bid, second_bid, winner, bid_count }
├── status: AuctionStatus      // Created | Active | BiddingClosed |
│                               // RevealPhase | Settled | Cancelled
├── item_mint: Pubkey
├── start_time: i64
├── end_time: i64
└── bump: u8

ItemVault PDA: seeds = [b"vault", auction_config.key()]
└── SPL Token account holding the auctioned asset (authority = AuctionConfig PDA)

BidEscrow PDA: seeds = [b"bid", auction_config.key(), bidder.key()]
├── auction: Pubkey
├── bidder: Pubkey
├── amount: u64                // Escrowed lamports (bid or collateral)
├── timestamp: i64
├── commitment_hash: [u8; 32]  // Sealed-bid only
├── revealed: bool             // Sealed-bid only
├── revealed_amount: u64       // Sealed-bid only (0 if not revealed)
└── bump: u8
```

### Instruction Set (11 instructions)

| Instruction | Auction Type | Description |
|---|---|---|
| `initialize_house` | — | Create global AuctionHouse config with fee rate |
| `create_auction` | All | Create AuctionConfig PDA + deposit item into vault |
| `place_bid` | English | Escrow SOL bid, enforce min_increment, update highest bidder, anti-snipe |
| `buy_now` | Dutch | Purchase at current decaying price, atomic item + SOL transfer |
| `submit_sealed_bid` | Sealed | Submit Keccak256 commitment hash + escrow collateral |
| `reveal_bid` | Sealed | Reveal plaintext bid + nonce, verify hash, track 1st/2nd prices |
| `close_bidding` | Sealed | Transition Active → BiddingClosed after end_time (permissionless crank) |
| `settle_auction` | English/Sealed | Transfer item to winner, payment to seller, fee to treasury |
| `cancel_auction` | All | Cancel (only pre-bid), return item to seller |
| `claim_refund` | English/Sealed | Losers reclaim escrowed funds after settlement |
| `forfeit_unrevealed` | Sealed | Claim collateral from unrevealed bids after reveal period |

### State Machine

```
                  ┌─────────────────────────────────────────────────┐
                  │                    Created                       │
                  └────────┬──────────────┬──────────────────────────┘
                           │              │
                  [cancel] │    [first bid/sealed bid]
                           v              v
                     Cancelled          Active
                                          │
                    ┌─────────────────────┤────────────────────┐
                    │                     │                    │
                English              Dutch               Sealed
                    │                     │                    │
            [bids, snipe ext]      [buy_now]        [end_time reached]
                    │                     │                    │
            [end_time]                    │           BiddingClosed
                    │                     │                    │
                    │                     │             [reveals]
                    │                     │                    │
                    │                     │            RevealPhase
                    │                     │                    │
                    └─────────────────────┴────────────────────┘
                                          │
                                       Settled
                                          │
                              [claim_refund / forfeit_unrevealed]
```

---

## ⚖️ Web2 vs Solana: Architecture Comparison

How traditional auction platforms (eBay, Sotheby's, GovPlanet) architect each concern versus Solana's on-chain model.

### Trust Model

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Platform operator holds funds and mediates disputes. Users trust the company's reputation and legal agreements. | Program logic enforces rules. Funds are held in PDAs controlled by deterministic code. No operator can alter outcomes. |
| **When Web2 wins** | Legal recourse matters (fraud recovery, chargebacks). Human judgment needed for edge cases. | |
| **When Solana wins** | Participants don't share a legal jurisdiction. The operator is the potential adversary. | |

### Escrow

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | PayPal/Stripe holds funds in custodial accounts. Release requires multi-step confirmation. Chargebacks possible for weeks. | PDA escrow holds lamports with programmatic release. Settlement is atomic — item and payment transfer in the same transaction or neither does. |
| **Tradeoff** | Web2 enables dispute resolution and reversibility (buyer protection). Solana's PDA escrow is irreversible and instant (eliminates counterparty risk but no recourse for mistakes). |

```rust
// PDA escrow: funds held by program-derived address
#[account(
  init,
  payer = bidder,
  space = 8 + BidEscrow::INIT_SPACE,
  seeds = [b"bid", auction_config.key().as_ref(), bidder.key().as_ref()],
  bump,
)]
pub bid_escrow: Account<'info, BidEscrow>,
```

### Timing & Deadlines

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Server-side cron jobs (Celery, Sidekiq, AWS Step Functions). Server clock is authoritative but controllable by the operator. | `Clock` sysvar provides consensus-enforced timestamps. Every validator agrees on the slot time. No single party controls it. |
| **Tradeoff** | Server clocks offer millisecond precision. Solana's Clock has ~400ms granularity but cannot be manipulated by a malicious operator. |

### Sealed Bids

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Bids stored in a database. The platform can see all bids in plaintext. Participants must trust the operator won't leak or front-run. | Keccak256 commit-reveal: bidders submit `hash(amount || nonce)`, then reveal the plaintext. Even the program cannot see bid amounts until reveal. |
| **Tradeoff** | Web2 is simpler (one step) but requires complete trust. Commit-reveal adds UX friction but provides a cryptographic guarantee against front-running. |

```rust
// Verify commitment: keccak256(amount_le_bytes || nonce)
let mut hash_input = Vec::with_capacity(40);
hash_input.extend_from_slice(&amount.to_le_bytes());
hash_input.extend_from_slice(&nonce);
let computed = solana_keccak_hasher::hash(&hash_input);
require!(computed.0 == bid.commitment_hash, AuctionError::HashMismatch);
```

### Settlement · Anti-Sniping · Refunds

| Dimension | Web2 | Solana |
|---|---|---|
| **Settlement** | Multi-step over days/weeks (charge → ship → confirm → release). | Atomic: item + payment + fee in one transaction. |
| **Anti-sniping** | Platform-specific, opaque rules. eBay allows sniping by design. | Deterministic, transparent on-chain extension logic. Verifiable before participating. |
| **Refunds** | Support tickets, days of waiting, chargebacks. | Automatic via PDA closure — `claim_refund` returns all lamports instantly. |
| **Bid history** | Private database, alterable. | On-chain transactions — immutable, permissionless audit. |
| **Concurrency** | Row-level locks, race conditions possible. | Account-level locking by runtime — race conditions impossible. |

### Summary Matrix

| Dimension | Web2 Advantage | Solana Advantage |
|---|---|---|
| Trust | Legal recourse, dispute resolution | Trustless, no operator risk |
| Escrow | Reversible, buyer protection | Atomic, no counterparty risk |
| Timing | Millisecond precision | Consensus-enforced, tamper-proof |
| Sealed bids | Simple UX (one step) | Cryptographic privacy guarantee |
| Settlement | Physical goods support | Atomic, instant for digital assets |
| Anti-sniping | Tunable, updatable rules | Transparent, verifiable, deterministic |
| Bid history | Rich queryability | Immutable, permissionless audit |
| Concurrency | Higher throughput | Guaranteed consistency, zero race conditions |
| Refunds | Flexible (partial, conditional) | Instant, automatic, no support needed |

---

## 🧠 Design Decisions & Tradeoffs

<details>
<summary><b>Unified Program vs Separate Programs Per Type</b></summary>

All three auction types live in one program — single deployment, shared `AuctionHouse` config, consistent PDA derivation. The tradeoff: `AuctionConfig` account size accommodates the largest variant (`SealedVickrey`), so English and Dutch auctions pay slightly more rent. The benefit is operational simplicity and composability — one program ID for any auction type.
</details>

<details>
<summary><b>Enum Dispatch vs Trait Objects</b></summary>

`AuctionType` is a Rust enum with variant-specific data. Trait objects (`dyn Auctionable`) would require heap allocation and dynamic dispatch — impractical in BPF. Enums give compile-time exhaustiveness checking and zero-cost dispatch via `match`.
</details>

<details>
<summary><b>SOL Bids (Not SPL Tokens)</b></summary>

Bids use native SOL (lamports) for simplicity. SPL token support would require additional accounts per instruction, increase transaction size, and add a token mint parameter to every bid operation. Extending to SPL tokens is straightforward but would roughly double account counts per bid instruction.
</details>

<details>
<summary><b>One PDA Per Bidder (Not a Vector of Bids)</b></summary>

Each bidder gets a `BidEscrow` PDA from `[b"bid", auction.key(), bidder.key()]`. A `Vec<Bid>` inside `AuctionConfig` would require reallocation on every bid, hit size limits quickly, and complicate refund logic. Separate PDAs scale to any number of bidders and enable parallel refund claims.
</details>

<details>
<summary><b>Account Size & Compute Budget</b></summary>

`AuctionConfig` uses Anchor's `InitSpace` derive — total stays well under 1KB. `BidEscrow` is ~150 bytes fixed. All instructions stay within the default 200k CU budget. The most expensive is `reveal_bid` (Keccak256 hash + account reads/writes). No instruction requires CU budget increases.
</details>

---

## 🔒 Security Model

### Access Control
- Seller identity enforced via PDA seeds (`auction_config` seeds include `seller.key()`)
- Seller-only operations guarded by `Signer` + `constraint` checks
- Bidder-only operations guarded by `Signer` + bid escrow PDA derivation
- `close_bidding` is permissionless (anyone can crank the state transition after `end_time`)

### Arithmetic Safety
- All arithmetic uses `checked_add`, `checked_sub`, `checked_mul`, `checked_div`
- Fee calculations use `u128` intermediate to prevent overflow on large payments
- Custom `AuctionError::Overflow` for all arithmetic failures

### State Machine Integrity
- Each instruction validates `AuctionStatus` before proceeding
- Status transitions are one-way (no reversal from `Settled` or `Cancelled`)
- Sealed-bid phase transitions enforced: `Active` → `BiddingClosed` → `RevealPhase` → `Settled`

### Escrow Safety
- PDA authority ensures only the program can move escrowed funds
- `claim_refund` checks bidder is NOT the winner before closing
- `forfeit_unrevealed` only executes after `reveal_end_time`
- Anchor's `close` constraint returns rent + escrow to the correct recipient

### Error Specificity

20 custom error variants with actionable feedback:

```
AuctionNotStarted · AuctionAlreadyEnded · AuctionStillActive
AuctionAlreadySettled · CannotCancelWithBids · InvalidAuctionStatus
InvalidTimeRange · BidTooLow · SellerCannotBid · InsufficientPayment
PriceBelowReserve · BiddingPhaseEnded · RevealPhaseNotStarted
RevealPhaseEnded · HashMismatch · AlreadyRevealed · BidNotRevealed
InsufficientCollateral · Unauthorized · Overflow · InvalidFeeBps · NoBids
```

---

## 🚀 Getting Started

### Prerequisites

- **Rust** 1.89+ (pinned via `rust-toolchain.toml`)
- **Solana CLI** 2.2.12+
- **Anchor CLI** 0.32.1
- **Node.js** 22+ with Yarn

### Build & Test

```bash
# Clone
git clone https://github.com/RECTOR-LABS/sol-auction
cd sol-auction

# Install dependencies
yarn install

# Build
anchor build

# Run all tests (33 integration + 30 unit)
anchor test        # integration tests (local validator)
cargo test --lib   # unit tests (no validator needed)

# Lint & format checks
cargo fmt --all -- --check
cargo clippy --lib -- -D warnings
yarn lint
```

### Deploy to Devnet

```bash
anchor deploy --provider.cluster devnet
```

---

## 💻 CLI Usage

A TypeScript CLI client for all auction operations:

```bash
# Create auctions
sol-auction create english --mint <MINT> --start-price 1.0 --duration 3600
sol-auction create dutch --mint <MINT> --start-price 10.0 --reserve 1.0 --duration 1800
sol-auction create sealed --mint <MINT> --min-collateral 5.0 --bid-duration 3600 --reveal-duration 1800

# Bid on English auction
sol-auction bid <AUCTION_ID> --amount 2.5

# Buy Dutch auction at current price
sol-auction buy <AUCTION_ID>

# Sealed-bid flow
sol-auction submit-sealed <AUCTION_ID> --amount 5.0 --nonce <NONCE>
sol-auction reveal <AUCTION_ID> --amount 5.0 --nonce <NONCE>

# Settlement and lifecycle
sol-auction settle <AUCTION_ID>
sol-auction cancel <AUCTION_ID>

# Queries
sol-auction status <AUCTION_ID>
sol-auction list --seller <PUBKEY>
```

---

## 🧪 Test Coverage

<div align="center">

**63 tests** · 30 unit tests + 33 integration tests · 6 test suites · 11 instructions covered

</div>

### Unit Tests (30 tests — `cargo test --lib`)

Pure logic tests with zero runtime dependencies:

| Module | Tests | Coverage |
|---|---|---|
| `helpers.rs` | 18 | Fee calculation (6), commitment hash (4), Vickrey ranking (5), anti-snipe extension (3) |
| `state/auction.rs` | 12 | Dutch price decay (7), English current price (2), Sealed returns None (1), program ID (1), auxiliary (1) |

### Integration Tests (33 tests — `anchor test`)

Full on-chain tests against local validator:

| Test Suite | Tests | Coverage |
|---|---|---|
| `sol-auction.ts` | 2 | `initialize_house`: valid init, invalid fee_bps rejection |
| `create-auction.ts` | 2 | `create_auction`: English creation + vault deposit, invalid time range rejection |
| `english-auction.ts` | 5 | `place_bid`: valid bids, increment enforcement, anti-snipe, seller guard |
| `dutch-auction.ts` | 3 | `buy_now`: decayed price purchase, double-buy rejection, seller guard |
| `sealed-auction.ts` | 13 | Full commit-reveal lifecycle: submit, close, reveal, Vickrey tracking, forfeit |
| `settlement.ts` | 8 | Settlement with fee deduction, refund claims, cancel guards |

### Per-Instruction Coverage

| Instruction | Tested Scenarios |
|---|---|
| `initialize_house` | Happy path + validation |
| `create_auction` | All 3 types + time validation |
| `place_bid` | Bid validation, increment enforcement, anti-snipe, seller guard |
| `buy_now` | Price decay, atomic settlement, status guard, seller guard |
| `submit_sealed_bid` | Commitment storage, collateral validation |
| `reveal_bid` | Hash verification, double-reveal guard, Vickrey tracking |
| `close_bidding` | Timing enforcement |
| `forfeit_unrevealed` | Reveal period enforcement, collateral transfer |
| `settle_auction` | English + fee math, premature rejection |
| `cancel_auction` | Status guard, seller-only enforcement |
| `claim_refund` | Loser refund, winner rejection |

---

## 🌐 Devnet Deployment

<div align="center">

**Program ID**: [`HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC`](https://explorer.solana.com/address/HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC?cluster=devnet)

**Deploy Tx**: [`3hSCcpWJRAY...SwDBMn321`](https://explorer.solana.com/tx/3hSCcpWJRAY17itCGnK7oGtcWjqK6X8CNijx2AgiTzKB1LmnsTtQz6qZ9Z3BRpbKzqVeYTcEfo2frwoSwDBMn321?cluster=devnet)

</div>

### Devnet Transaction Proof (17 transactions)

All three auction types exercised end-to-end on devnet:

#### English Auction — Full Lifecycle

| Step | Transaction |
|---|---|
| Create auction | [`7FP3xL...nNjEH`](https://explorer.solana.com/tx/7FP3xLhTWwnn8oBKqM1vZgxjaDcW8iVDGy99KzniL3u8i41R5CYq5thcxkRkVArx6Q4CN5fhJT5tB3ytQ7nNjEH?cluster=devnet) |
| Place bid (Bidder 1: 0.005 SOL) | [`2ACmQK...xPxS`](https://explorer.solana.com/tx/2ACmQK2zcqzoDgkBw6xHuQKErAbr9tajNNsfv9932fRRuH5ijkWyXSootgCfkTS5sA2hrkqSvX9H2iX6pfUpxPxS?cluster=devnet) |
| Place bid (Bidder 2: 0.008 SOL) | [`5piRXK...86tY`](https://explorer.solana.com/tx/5piRXKuZq8US2odpp1PfqoJyWioZxPYLe65QBs1gDgcWSsUVb84MhqK2GNgWD4bBYG41yseXUgcgKyBxoKxk86tY?cluster=devnet) |
| Settle auction (winner: Bidder 2) | [`K4BrRL...EXPN`](https://explorer.solana.com/tx/K4BrRLS9oUodoPncoGDMEvgcqbwH17gSJL4NpZLRDzz6R3zjv3cVHjRfdL1fEAG27tgqDX8TjemAbG7uAtiEXPN?cluster=devnet) |
| Claim refund (Bidder 1) | [`2iaRfK...aH7Q`](https://explorer.solana.com/tx/2iaRfKEN6YLk6kjgRkUsZjZSFSYtw185JojjQawoqoUNy14hbBdoW7u54GiaJqVw181u16MUY5HC8sSycKVUaH7Q?cluster=devnet) |

#### Dutch Auction — Buy Now

| Step | Transaction |
|---|---|
| Create auction (start: 0.02 SOL, reserve: 0.005 SOL) | [`5YJgR6...3bTq`](https://explorer.solana.com/tx/5YJgR6fp9RFTZPouZN2EjFqaRgsYhEYpFJHxnaZwjebYrXzQyD343qh3E8aBAtiVipaBVKjrQoZJEB1oDcmj3bTq?cluster=devnet) |
| Buy now at decayed price | [`23DEWr...urmU`](https://explorer.solana.com/tx/23DEWrhQ7bUDHMQwKKy7praFf3B8uRszj24mu3a3yarZPMKKLEDNuVrW6aX4ASKFKzZeLFvvNyxfE7NWWF8AurmU?cluster=devnet) |

#### Sealed-Bid Vickrey — Commit-Reveal + Second-Price

| Step | Transaction |
|---|---|
| Create auction | [`5h5cQs...55sa`](https://explorer.solana.com/tx/5h5cQsipoz6oqc5JxQzoDwj5M97VbkSnQg9hFkTZvjSn3xuUdLxgXKqM4vNSzxAjYqdTjARUcmExRTYZWVr555sa?cluster=devnet) |
| Submit sealed bid (Bidder 1) | [`5BvDgC...k9JY`](https://explorer.solana.com/tx/5BvDgCVkzG5Ex9fFbFdULsPX3gzyuhFFnxPC2xAfakPYkmuUqezfXwU5JhM3D9NYoEiK4QyFasjkkMLvjK8vk9JY?cluster=devnet) |
| Submit sealed bid (Bidder 2) | [`3V75XK...244b`](https://explorer.solana.com/tx/3V75XKZsotJK9gmarie1DdpK96drmPSK2451zJVUtnNeB7izaFYJj9jUbqruN2H1rJjRc1ZUuXFeC6aKUiXb244b?cluster=devnet) |
| Close bidding (permissionless crank) | [`59QWCh...BVxP`](https://explorer.solana.com/tx/59QWChpeUqNPFkmKRsjJK12PjrSAWUKLUuPASr8DGipZZ6ZXm8esXYHJgnzCBDDVDuLhVmhmnSDF8HRzTdrwBVxP?cluster=devnet) |
| Reveal bid (Bidder 1: 0.015 SOL) | [`XhGYLH...6bP`](https://explorer.solana.com/tx/XhGYLHE5sKUngzWPvZhVLCiAcAvsc9ADzBZw1dbJyEYNAqas1EbKAZq1fAMrmAojWBhuiaAmGaAE1x3C16Da6bP?cluster=devnet) |
| Reveal bid (Bidder 2: 0.01 SOL) | [`3bbKiQ...ZUvz`](https://explorer.solana.com/tx/3bbKiQCfVX8WoG98ENAmE2DRk2SWytPeM8HgWwumLoPts1i3eiHT2ybChpuZ6ctt5jU1aK6Rm2KaXsidARgKZUvz?cluster=devnet) |
| Settle (winner pays 2nd price: 0.01 SOL) | [`4KXkap...8NBJ`](https://explorer.solana.com/tx/4KXkapCwP3b7g2vjW3rJtS3eJtYVw1Fdw1AmJFDBqabKiU6nMZQWjVMNqj7scaPXsdTUVkhbPabHcKXVFMwX8NBJ?cluster=devnet) |
| Claim refund (losing Bidder 2) | [`p1Rxo1...LnB8`](https://explorer.solana.com/tx/p1Rxo1rQ8CxgmptLjRiDJ6opAwVL2hcQTeDH7FtNNtqMQtBqirbAqcQ18EtN6vYUTjgNHZvYwP9DVhrQvkWLnB8?cluster=devnet) |

#### Cancel Auction

| Step | Transaction |
|---|---|
| Create auction | [`3eupPp...EBEj`](https://explorer.solana.com/tx/3eupPpRrWpXosNCwYVKxrpM4rZNfg7HKqoomBpkBenAh96vfeS48bQpUcUyeEsLrxBcMtTQbmfH6H2as7DZ9EBEj?cluster=devnet) |
| Cancel (item returned to seller) | [`2dLvUw...m7XN`](https://explorer.solana.com/tx/2dLvUw36MFqSkMt19ZdzUa4zkB8RrKHwZgj6yhqWzDBnrphBbbMUT8YF72ss9SL2PnDggYKkpb6gAx4batASm7XN?cluster=devnet) |

### Run Demo Yourself

```bash
# Set environment
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=/path/to/your/devnet-keypair.json

# Run full demo (English + Dutch + Sealed Vickrey + Cancel)
npx tsx scripts/devnet-demo.ts
```

---

## 🛠️ Tech Stack

| Component | Technology |
|---|---|
| **Program** | Rust + Anchor Framework (v0.32.1) |
| **Testing** | 30 Rust unit tests + 33 Anchor integration tests |
| **Client** | TypeScript CLI (Commander.js) |
| **Cryptography** | Keccak256 commit-reveal (`solana-keccak-hasher` on-chain, `@noble/hashes` client-side) |
| **CI** | GitHub Actions (3 parallel jobs: Rust checks, Anchor tests, Lint + CLI) |
| **Network** | Solana Devnet |
| **Program ID** | `HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC` |

---

<div align="center">

**MIT License** · Built by [RECTOR-LABS](https://github.com/RECTOR-LABS)

</div>
