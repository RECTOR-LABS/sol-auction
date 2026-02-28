# sol-auction

A multi-type auction system rebuilt as a Solana on-chain Rust program. Implements English (ascending), Dutch (descending), and Sealed-Bid Vickrey (second-price) auctions under a single unified program -- demonstrating how Web2 auction backend architecture translates to trustless, deterministic on-chain systems.

**Key innovation**: Three fundamentally different auction mechanisms share one program with a unified account model, enum-based dispatch, and type-specific state machines. No existing Solana implementation unifies all three under one program.

---

## Auction Types

### English Auction (Ascending Price)

Bidders compete by placing increasing bids. Each bid is escrowed in a PDA, and the previous highest bidder's funds become reclaimable. Anti-sniping logic extends the deadline when late bids arrive, preventing last-second sniping strategies.

**On-chain patterns**: PDA escrow per bidder, Clock sysvar deadline enforcement, automatic anti-snipe extension.

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

Price starts high and decays linearly toward a reserve floor. The first buyer to accept the current price wins instantly. No bid escrow accounts needed -- the entire purchase settles atomically in a single transaction.

**On-chain patterns**: Clock sysvar price calculation, pure math (no stored bids), atomic single-tx settlement.

```
Price decay formula:
  current = start_price - (elapsed * (start_price - reserve_price) / duration)

  Created ──[time passes, price drops]──> Active ──[buy_now]──> Settled
                                                                  |
                      price ───────────────────────               |
                        |  \                                      |
                        |   \  linear decay                       |
                        |    \                                    |
                        |     \_____ reserve_price                |
                        |                                         |
                        start                  end               time
```

### Sealed-Bid Vickrey (Second-Price)

A three-phase auction with cryptographic bid concealment. Bidders submit `Keccak256(bid_amount || nonce)` commitment hashes with escrowed collateral during the bidding phase. After bidding closes, a reveal window opens where bidders must prove their bids match their commitments. The highest bidder wins but pays the **second-highest price** (Vickrey mechanism), incentivizing truthful bidding. Unrevealed bids forfeit their collateral to the seller.

**On-chain patterns**: Keccak256 commit-reveal, phased state machine, collateral forfeiture, second-price settlement.

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

## Architecture

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
| `initialize_house` | -- | Create global AuctionHouse config with fee rate |
| `create_auction` | All | Create AuctionConfig PDA + deposit item into vault |
| `place_bid` | English | Escrow SOL bid, enforce min_increment, update highest bidder, anti-snipe |
| `buy_now` | Dutch | Purchase at current decaying price, atomic item + SOL transfer |
| `submit_sealed_bid` | Sealed | Submit Keccak256 commitment hash + escrow collateral |
| `reveal_bid` | Sealed | Reveal plaintext bid + nonce, verify hash, track 1st/2nd prices |
| `close_bidding` | Sealed | Transition from Active to BiddingClosed after end_time (permissionless crank) |
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

## Web2 vs Solana: Architecture Comparison

This section analyzes how traditional auction platforms (eBay, Sotheby's online, GovPlanet) architect each concern versus how Solana's programming model handles the same problem. The goal is not "Solana good, Web2 bad" -- each approach has genuine advantages depending on context.

### Trust Model

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Platform operator holds funds and mediates disputes. Users trust the company's reputation, legal agreements, and regulatory compliance. | Program logic enforces rules. Funds are held in PDAs controlled by deterministic code. No operator can alter outcomes. |
| **When Web2 wins** | When legal recourse matters (fraud recovery, chargebacks, consumer protection laws). When participants need human judgment for edge cases (item-not-as-described disputes). | |
| **When Solana wins** | When participants don't share a legal jurisdiction. When the operator is the potential adversary. When "code is law" eliminates platform risk entirely. | |

### Escrow

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | PayPal/Stripe holds funds in custodial accounts. Release requires multi-step confirmation (item shipped, received, dispute window closed). Chargebacks possible for weeks. | PDA escrow holds lamports with programmatic release conditions. Settlement is atomic -- item and payment transfer in the same transaction or neither does. |
| **Tradeoff** | Web2 escrow enables dispute resolution and reversibility, which protects buyers. Solana's PDA escrow is irreversible and instant, which eliminates counterparty risk but means there's no recourse for mistakes. In `sol-auction`, each bidder's funds sit in a unique `BidEscrow` PDA derived from `[b"bid", auction.key(), bidder.key()]` -- the program is the only authority that can release them. |

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
| **Mechanism** | Server-side cron jobs or event schedulers (Celery, Sidekiq, AWS Step Functions). Server clock is authoritative but controllable by the operator. | `Clock` sysvar provides consensus-enforced timestamps. Every validator agrees on the slot time. No single party controls it. |
| **Tradeoff** | Server clocks are precise (millisecond resolution) and support complex scheduling. Solana's Clock sysvar has ~400ms granularity and can drift slightly between slots. However, server clocks can be manipulated by a malicious operator to extend auctions for preferred bidders -- on-chain timestamps cannot. |

### Sealed Bids

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Bids stored in a database. The platform operator can see all bids in plaintext. Participants must trust the operator won't leak, front-run, or modify bids. | Keccak256 commit-reveal: bidders submit `hash(amount || nonce)` during bidding phase, then reveal the plaintext during the reveal phase. The program verifies the hash match. Even the program cannot see bid amounts until reveal. |
| **Tradeoff** | Web2 sealed bids are simpler (one-step submission) but require complete trust in the operator. Commit-reveal adds UX friction (two transactions, nonce management) but provides a cryptographic guarantee that no one -- not even the validator processing the transaction -- can see your bid amount before you choose to reveal. |

```rust
// Verify commitment: keccak256(amount_le_bytes || nonce)
let mut hash_input = Vec::with_capacity(40);
hash_input.extend_from_slice(&amount.to_le_bytes());
hash_input.extend_from_slice(&nonce);
let computed = solana_keccak_hasher::hash(&hash_input);
require!(computed.0 == bid.commitment_hash, AuctionError::HashMismatch);
```

### Settlement

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Multi-step: charge buyer -> notify seller -> ship item -> buyer confirms -> release funds. Each step can fail independently. Settlement takes days to weeks. | Atomic: item token transfer + SOL payment + fee deduction happen in a single transaction. Either all succeed or all revert. |
| **Tradeoff** | Web2 multi-step settlement enables physical goods workflows and buyer protection windows. Solana's atomicity is superior for digital assets where delivery is instant, but cannot handle physical delivery confirmation. For digital assets (NFTs, tokens), atomic settlement eliminates an entire class of "paid but never received" disputes. |

### Anti-Sniping

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Platform-specific rules implemented in application code. eBay uses a fixed end time (enabling sniping). Some platforms extend by N minutes on late bids, but the logic is opaque. | Deterministic, transparent extension logic stored on-chain. In `sol-auction`, bids placed within `anti_snipe_duration` of the deadline automatically extend `end_time`. Anyone can verify the rule and its execution. |
| **Tradeoff** | Web2 anti-sniping rules can be tuned per-auction and updated without redeployment. On-chain rules are rigid but transparent -- bidders can verify the exact extension logic before participating. The rule is the same for everyone, always. |

### Bid History & Auditability

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Stored in private databases. The platform decides what to show publicly. Historical data can be altered, deleted, or made unavailable. | Every bid is an on-chain transaction. Bid escrow accounts are publicly readable. The entire auction history is permissionlessly auditable by anyone, forever. |
| **Tradeoff** | Web2 databases are queryable, indexable, and can support complex analytics. On-chain data requires indexing infrastructure (Geyser, Helius, custom indexers) for equivalent query capabilities. However, on-chain data cannot be retroactively falsified -- useful for regulatory compliance and dispute resolution. |

### Concurrency

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Row-level locks, optimistic concurrency control, distributed locks (Redis). Race conditions are possible and must be handled at the application layer. | Solana's runtime locks all accounts touched by a transaction. Two transactions touching the same `AuctionConfig` are serialized by the validator. Race conditions are impossible at the account level. |
| **Tradeoff** | Web2 concurrency allows higher throughput through fine-grained locking strategies. Solana's account-level locking is coarser -- two bids on the same auction cannot execute in parallel even if they touch different data within the account. This limits throughput per auction but guarantees consistency without any application-level concurrency code. |

### Refunds

| | Web2 | Solana On-Chain |
|---|---|---|
| **Mechanism** | Manual process involving support tickets, payment processor API calls, and days-to-weeks of waiting. Chargebacks add another layer of complexity. | Automatic via PDA closure. In `sol-auction`, `claim_refund` closes the `BidEscrow` PDA with Anchor's `close = bidder` constraint, returning all lamports (escrow + rent) to the bidder instantly. |
| **Tradeoff** | Web2 refund processes can handle partial refunds, conditional refunds, and dispute mediation. On-chain refunds are all-or-nothing and instant -- simpler for the common case but inflexible for edge cases. The advantage is that refund logic is enforced by the program: no support ticket needed, no waiting period, no operator discretion. |

### Summary Matrix

| Dimension | Web2 Advantage | Solana Advantage |
|---|---|---|
| Trust | Legal recourse, dispute resolution | Trustless, no operator risk |
| Escrow | Reversible, buyer protection | Atomic, no counterparty risk |
| Timing | Millisecond precision, flexible scheduling | Consensus-enforced, tamper-proof |
| Sealed bids | Simple UX (one step) | Cryptographic privacy guarantee |
| Settlement | Physical goods support, protection windows | Atomic, instant for digital assets |
| Anti-sniping | Tunable, updatable rules | Transparent, verifiable, deterministic |
| Bid history | Rich queryability, analytics | Immutable, permissionless audit |
| Concurrency | Higher throughput, fine-grained locks | Guaranteed consistency, zero race conditions |
| Refunds | Flexible (partial, conditional) | Instant, automatic, no support needed |
| Auditability | Internal controls, compliance tooling | Permissionless, immutable record |

---

## Design Decisions & Tradeoffs

### Unified Program vs Separate Programs Per Type

All three auction types live in one program. This means a single deployment, shared `AuctionHouse` config, and consistent PDA derivation patterns. The tradeoff is that `AuctionConfig` account size accommodates the largest variant (`SealedVickrey` with its extra fields), so English and Dutch auctions pay slightly more rent than they would with a dedicated, minimal account layout. The benefit is operational simplicity and composability -- a client interacts with one program ID for any auction type.

### Enum Dispatch vs Trait Objects

`AuctionType` is a Rust enum with variant-specific data baked into each variant. This is idiomatic Anchor -- enums serialize/deserialize natively and keep all state in one account. Trait objects (`dyn Auctionable`) would require heap allocation and dynamic dispatch, neither of which is practical in Solana's BPF runtime. Enums give us compile-time exhaustiveness checking and zero-cost dispatch via `match`.

### SOL Bids (Not SPL Tokens)

Bids are denominated in native SOL (lamports) for simplicity. Supporting SPL token bids would require additional accounts per instruction (token accounts, token program), increase transaction size, and add a token mint parameter to every bid-related operation. For a bounty submission demonstrating architecture patterns, SOL-only keeps the instruction account counts manageable while still showcasing the full escrow and settlement flow. Extending to SPL tokens is straightforward but would roughly double the account count per bid instruction.

### One PDA Per Bidder (Not a Vector of Bids)

Each bidder gets their own `BidEscrow` PDA derived from `[b"bid", auction.key(), bidder.key()]`. The alternative -- storing a `Vec<Bid>` inside `AuctionConfig` -- would require account reallocation on every bid, hit Solana's 10KB account size limit quickly, and make refund logic complex (scanning a vector to find your bid). Separate PDAs scale to any number of bidders, enable parallel processing of refund claims, and keep each instruction's account set small and predictable.

### Account Size Considerations

`AuctionConfig` uses Anchor's `InitSpace` derive macro. The `AuctionType` enum takes space proportional to the largest variant. With `Option<Pubkey>` fields and u64 counters, the total `AuctionConfig` size stays well under 1KB. `BidEscrow` is fixed-size at approximately 150 bytes. Neither account approaches Solana's 10MB realloc limit, so zero-copy serialization was not required.

### Compute Unit Budget

All instructions stay well within the default 200k CU budget. The most expensive operation is `reveal_bid`, which performs a Keccak256 hash (~100 bytes input) and several account reads/writes. Dutch `buy_now` is the most account-heavy instruction (8 accounts) due to the atomic item transfer + SOL payment + fee deduction in one transaction. No instruction requires CU budget increases.

---

## Security Model

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
- Sealed-bid phase transitions are enforced: `Active` -> `BiddingClosed` -> `RevealPhase` -> `Settled`

### Escrow Safety
- PDA authority ensures only the program can move escrowed funds
- `claim_refund` explicitly checks that the bidder is NOT the winner before closing
- `forfeit_unrevealed` only executes after `reveal_end_time` has passed
- Anchor's `close` constraint returns rent + escrow to the correct recipient

### Error Specificity
20 custom error variants provide actionable feedback:

```
AuctionNotStarted, AuctionAlreadyEnded, AuctionStillActive,
AuctionAlreadySettled, CannotCancelWithBids, InvalidAuctionStatus,
InvalidTimeRange, BidTooLow, SellerCannotBid, InsufficientPayment,
PriceBelowReserve, BiddingPhaseEnded, RevealPhaseNotStarted,
RevealPhaseEnded, HashMismatch, AlreadyRevealed, BidNotRevealed,
InsufficientCollateral, Unauthorized, Overflow, InvalidFeeBps,
NoBids, BidNotFound
```

---

## Getting Started

```bash
# Clone
git clone https://github.com/RECTOR-LABS/sol-auction
cd sol-auction

# Install dependencies
yarn install

# Build
anchor build

# Test (runs all 33 tests across 6 test suites)
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

**Prerequisites**: Rust, Solana CLI, Anchor CLI (v0.30+), Node.js 18+, Yarn.

---

## CLI Usage

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

## Test Coverage

33 tests across 6 test suites covering all 11 instructions:

| Test Suite | Tests | Coverage |
|---|---|---|
| `sol-auction.ts` | 2 | `initialize_house`: valid init, invalid fee_bps rejection |
| `create-auction.ts` | 2 | `create_auction`: English creation + vault deposit, invalid time range rejection |
| `english-auction.ts` | 5 | `place_bid`: valid first bid, valid second bid with increment, below-start rejection, below-increment rejection, seller-cannot-bid |
| `dutch-auction.ts` | 3 | `buy_now`: successful purchase at decayed price, double-buy rejection, seller-cannot-buy |
| `sealed-auction.ts` | 13 | `submit_sealed_bid`: valid commitment, second bid, insufficient collateral. `close_bidding`: premature close rejection, valid close. `reveal_bid`: valid reveal, wrong nonce rejection, double reveal rejection, Vickrey second-price tracking. `forfeit_unrevealed`: premature forfeit rejection, valid forfeit (2 bids) |
| `settlement.ts` | 8 | `settle_auction`: English settlement with item + SOL transfer, fee_bps deduction verification, premature settle rejection. `claim_refund`: loser refund, winner refund rejection. `cancel_auction`: valid cancel, cancel-with-bids rejection, non-seller rejection |

**Per-instruction coverage**:
- `initialize_house`: happy path + validation
- `create_auction`: all 3 types + time validation
- `place_bid`: bid validation, increment enforcement, anti-snipe, seller guard
- `buy_now`: price decay, atomic settlement, status guard, seller guard
- `submit_sealed_bid`: commitment storage, collateral validation
- `reveal_bid`: hash verification, double-reveal guard, Vickrey tracking
- `close_bidding`: timing enforcement
- `forfeit_unrevealed`: reveal period enforcement, collateral transfer
- `settle_auction`: English + fee math, premature rejection
- `cancel_auction`: status guard, seller-only enforcement
- `claim_refund`: loser refund, winner rejection

---

## Devnet Deployment

**Program ID**: [`HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC`](https://explorer.solana.com/address/HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC?cluster=devnet)

**Deploy Tx**: [`3hSCcpWJRAY17itCGnK7oGtcWjqK6X8CNijx2AgiTzKB1LmnsTtQz6qZ9Z3BRpbKzqVeYTcEfo2frwoSwDBMn321`](https://explorer.solana.com/tx/3hSCcpWJRAY17itCGnK7oGtcWjqK6X8CNijx2AgiTzKB1LmnsTtQz6qZ9Z3BRpbKzqVeYTcEfo2frwoSwDBMn321?cluster=devnet)

### Run Demo

The demo script exercises all 3 auction types end-to-end on devnet:

```bash
# Set environment
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=/path/to/your/devnet-keypair.json

# Run full demo (English + Dutch + Sealed Vickrey + Cancel)
npx ts-node --esm scripts/devnet-demo.ts
```

The demo creates 4 auctions and generates Explorer links for every transaction:
1. **English** — create, bid (2 bidders), settle, refund
2. **Dutch** — create, buy at decayed price
3. **Sealed Vickrey** — create, submit 2 sealed bids, close bidding, reveal, settle at 2nd price, refund
4. **Cancel** — create and cancel (item returned)

---

## Tech Stack

- **Program**: Rust + Anchor Framework (v0.32.1)
- **Testing**: Anchor test framework with Mocha/Chai (33 tests)
- **Client**: TypeScript CLI (Commander.js)
- **Cryptography**: Keccak256 commit-reveal (solana-keccak-hasher on-chain, @noble/hashes client-side)
- **Network**: Solana Devnet
- **Program ID**: `HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC`

---

## License

MIT
