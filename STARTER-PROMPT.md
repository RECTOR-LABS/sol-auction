# Starter Prompt for Next Session

Copy-paste this into a new Claude Code session from `~/local-dev/sol-auction/`:

---

```
Read `docs/plans/2026-02-28-sol-auction-design.md` — this is our validated design for a Superteam bounty submission (deadline: March 16, 2026, prize: 1000 USDC).

We're building sol-auction: a multi-type auction system (English, Dutch, Sealed-Bid Vickrey) as a Solana on-chain Rust program using Anchor framework.

Use /superpowers:writing-plans to create a detailed implementation plan from the design doc, then we execute. Key deliverables:

1. Anchor program with ~12 instructions across 3 auction types
2. Account model: AuctionConfig, ItemVault, BidEscrow, AuctionHouse PDAs
3. Keccak256 commit-reveal for sealed bids
4. Full test suite (Bankrun/LiteSVM with time-warping) targeting 90%+ coverage
5. TypeScript CLI client using @solana/kit
6. Deploy to Solana devnet with tx links
7. Comprehensive README with Web2 vs Solana architecture comparison

Scoring criteria (what judges care about):
- Architecture & account modeling: 30%
- Code quality & Rust patterns: 25%
- Correctness & testing: 20%
- Web2→Solana design analysis: 15%
- UX/client usability: 10%

Use /solana-dev skill for Solana best practices. Start with writing-plans, then execute with TDD.
```
