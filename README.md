# sol-auction

Multi-type auction system rebuilt as a Solana on-chain Rust program. Implements English, Dutch, and Sealed-Bid (Vickrey) auctions — demonstrating how Web2 backend auction architecture translates to decentralized, trustless on-chain systems.

## Auction Types

- **English Auction** — Ascending price, highest bidder wins. Anti-sniping protection.
- **Dutch Auction** — Descending price, first buyer wins at current price.
- **Sealed-Bid (Vickrey)** — Commit-reveal scheme using Keccak256. Winner pays second-highest price.

## Architecture

Built with Anchor framework on Solana. Each auction type shares a unified account model with type-specific behavior via Rust enums and trait-based dispatch.

### Key On-Chain Patterns
- PDA-based escrow (trustless fund holding)
- Keccak256 commit-reveal for sealed bids
- Clock sysvar for time enforcement
- Atomic settlement in single transactions
- State machine lifecycle management

## Web2 vs Solana

| Aspect | Web2 | Solana |
|--------|------|--------|
| Escrow | PayPal/Stripe holds funds | PDA escrow, trustless |
| Timing | Cron jobs | Clock sysvar, consensus-enforced |
| Sealed bids | Trust the server | Commit-reveal, cryptographic |
| Settlement | Multi-step | Atomic, single transaction |
| Bid history | Database queries | On-chain, publicly verifiable |

## Tech Stack

- **Program**: Rust + Anchor Framework
- **Client**: TypeScript CLI
- **Testing**: Bankrun / LiteSVM
- **Network**: Solana Devnet

## License

MIT
