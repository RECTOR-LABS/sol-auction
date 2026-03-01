# CLAUDE.md — sol-auction

Project-specific instructions for Claude Code sessions.

## Project Overview

Multi-type auction engine on Solana. Three auction mechanisms (English, Dutch, Sealed-Bid Vickrey) unified under one Anchor program with shared account model and enum-based dispatch.

**Program ID**: `HQvAj4GGwhw4cGkxNXX22vz2NnXe5rok4n5Yyqq3WtMC` (devnet)

## Tech Stack

- **Program**: Rust + Anchor 0.32.1 (`programs/sol-auction/src/`)
- **Tests**: Anchor integration tests (TypeScript, `tests/`) + Rust unit tests (`cargo test --lib`)
- **CLI**: TypeScript + Commander.js (`cli/`)
- **Toolchain**: Rust 1.89.0 (pinned `rust-toolchain.toml`), Solana CLI 2.2.12, Node 22, Yarn
- **CI**: GitHub Actions (`.github/workflows/ci.yml`) — 3 parallel jobs

## Project Structure

```
programs/sol-auction/src/
├── lib.rs                  # Program entrypoint, 11 instructions
├── errors.rs               # 20 custom error variants
├── helpers.rs              # Pure functions (fee calc, hash, Vickrey ranking, anti-snipe)
├── state/
│   ├── mod.rs
│   ├── auction.rs          # AuctionConfig, AuctionType enum, AuctionStatus
│   ├── auction_house.rs    # AuctionHouse (global config)
│   └── bid.rs              # BidEscrow
└── instructions/
    ├── mod.rs
    ├── initialize_house.rs
    ├── create_auction.rs
    ├── place_bid.rs         # English: escrow + anti-snipe
    ├── buy_now.rs           # Dutch: atomic purchase
    ├── submit_sealed_bid.rs # Sealed: Keccak256 commitment
    ├── reveal_bid.rs        # Sealed: verify hash + Vickrey ranking
    ├── close_bidding.rs     # Sealed: permissionless crank
    ├── settle_auction.rs    # English/Sealed: item + payment + fee
    ├── cancel_auction.rs
    ├── claim_refund.rs
    └── forfeit_unrevealed.rs
tests/                       # 33 integration tests (6 suites)
cli/                         # TypeScript CLI client
scripts/devnet-demo.ts       # End-to-end devnet demo (all 3 types)
```

## Build & Test Commands

```bash
anchor build                      # Build program
anchor test                       # Integration tests (local validator)
cargo test --lib                  # Unit tests (30 tests, no validator)
cargo fmt --all -- --check        # Format check
cargo clippy --lib -- -D warnings # Lint (--lib only, not --all-targets)
yarn lint                         # Prettier check
```

## Critical Notes

### Clippy: Use `--lib` Only

`cargo clippy --all-targets` fails because Anchor's `#[derive(Accounts)]` macro expands to code referencing `solana_program` which isn't resolvable outside the BPF target. Always use `cargo clippy --lib`.

### Anchor Constraints

- `init-if-needed` feature is intentionally omitted — it enables account re-initialization attacks
- All instructions use explicit status checks (no implicit state transitions)
- PDA seeds are deterministic: `[b"auction", seller.key(), &id.to_le_bytes()]`

### Pure Helpers Pattern

`helpers.rs` contains extracted pure functions that have zero Anchor/runtime dependencies. All auction math lives here with comprehensive unit tests. When adding new logic, prefer extracting pure functions into `helpers.rs` over embedding logic in instruction handlers.

### Account Model

- `AuctionHouse`: Global config (fee rate, treasury)
- `AuctionConfig`: Per-auction state with `AuctionType` enum dispatch
- `ItemVault`: SPL Token PDA holding auctioned asset
- `BidEscrow`: Per-bidder PDA (one per bidder per auction, not a vector)

### State Machine

```
Created → Active → {English: Settled, Dutch: Settled, Sealed: BiddingClosed → RevealPhase → Settled}
Created → Cancelled (only if no bids)
```

Status transitions are one-way. No reversal from `Settled` or `Cancelled`.

## Code Conventions

- 4-space indentation (Rust, enforced by `cargo fmt`)
- 2-space indentation (TypeScript, enforced by Prettier)
- All arithmetic uses checked operations (`checked_add`, `checked_sub`, etc.)
- Fee calculations use `u128` intermediate to prevent overflow
- Custom errors are specific and actionable (20 variants in `errors.rs`)
- `#[allow(ambiguous_glob_reexports)]` in `instructions/mod.rs` (all modules export `handler`)

## Devnet

- Shared devnet wallet: `~/Documents/secret/solana-devnet.json`
- Demo script: `npx tsx scripts/devnet-demo.ts`
- Requires `ANCHOR_PROVIDER_URL` and `ANCHOR_WALLET` env vars
