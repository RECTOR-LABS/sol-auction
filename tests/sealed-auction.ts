import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolAuction } from "../target/types/sol_auction";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { keccak_256 } from "@noble/hashes/sha3";

// Helper: compute commitment hash (keccak256(amount_le_bytes || nonce))
function computeCommitment(amount: anchor.BN, nonce: Uint8Array): number[] {
  const amountBytes = amount.toArrayLike(Buffer, "le", 8);
  const data = Buffer.concat([amountBytes, Buffer.from(nonce)]);
  return Array.from(keccak_256(data));
}

describe("sealed_auction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  let housePda: anchor.web3.PublicKey;
  let mint: anchor.web3.PublicKey;
  let sellerAta: anchor.web3.PublicKey;
  let auctionPda: anchor.web3.PublicKey;
  const auctionId = new anchor.BN(300);

  // Bidder keypairs and nonces
  const bidder1 = anchor.web3.Keypair.generate();
  const bidder2 = anchor.web3.Keypair.generate();
  const nonce1 = anchor.web3.Keypair.generate()
    .publicKey.toBytes()
    .slice(0, 32);
  const nonce2 = anchor.web3.Keypair.generate()
    .publicKey.toBytes()
    .slice(0, 32);
  const bidAmount1 = new anchor.BN(5 * anchor.web3.LAMPORTS_PER_SOL); // 5 SOL
  const bidAmount2 = new anchor.BN(3 * anchor.web3.LAMPORTS_PER_SOL); // 3 SOL
  const minCollateral = new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL); // 2 SOL

  before(async () => {
    // Init house
    [housePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("house"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );
    try {
      await program.account.auctionHouse.fetch(housePda);
    } catch {
      await program.methods
        .initializeHouse(500)
        .accounts({
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }

    // Mint + ATA
    const payer = (provider.wallet as anchor.Wallet).payer;
    mint = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0
    );
    sellerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      provider.wallet.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      mint,
      sellerAta,
      provider.wallet.publicKey,
      1
    );

    // Create sealed-bid auction (start in past, end in 1 hour)
    const now = Math.floor(Date.now() / 1000);
    [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createAuction(
        auctionId,
        {
          sealedVickrey: {
            minCollateral,
            revealDuration: new anchor.BN(3600), // 1 hour reveal
          },
        },
        new anchor.BN(now - 60), // started 1 min ago
        new anchor.BN(now + 3600) // ends in 1 hour
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // Fund bidders
    for (const b of [bidder1, bidder2]) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          b.publicKey,
          20 * anchor.web3.LAMPORTS_PER_SOL
        )
      );
    }
  });

  it("submits sealed bid with valid commitment hash", async () => {
    const commitment = computeCommitment(bidAmount1, new Uint8Array(nonce1));
    const collateral = new anchor.BN(6 * anchor.web3.LAMPORTS_PER_SOL); // > min_collateral AND > bid amount

    await program.methods
      .submitSealedBid(commitment, collateral)
      .accounts({
        auctionConfig: auctionPda,
        bidder: bidder1.publicKey,
      })
      .signers([bidder1])
      .rpc();

    // Verify bid escrow
    const [bidPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), auctionPda.toBuffer(), bidder1.publicKey.toBuffer()],
      program.programId
    );
    const bid = await program.account.bidEscrow.fetch(bidPda);
    expect(bid.bidder.toBase58()).to.equal(bidder1.publicKey.toBase58());
    expect(bid.amount.toNumber()).to.equal(6 * anchor.web3.LAMPORTS_PER_SOL);
    expect(bid.revealed).to.be.false;
    expect(bid.revealedAmount.toNumber()).to.equal(0);
    expect(Array.from(bid.commitmentHash)).to.deep.equal(commitment);

    // Verify auction state
    const auction = await program.account.auctionConfig.fetch(auctionPda);
    expect(JSON.stringify(auction.status)).to.include("active");
    const sealedType = (auction.auctionType as any).sealedVickrey;
    expect(sealedType.bidCount).to.equal(1);
  });

  it("submits second sealed bid", async () => {
    const commitment = computeCommitment(bidAmount2, new Uint8Array(nonce2));
    const collateral = new anchor.BN(4 * anchor.web3.LAMPORTS_PER_SOL);

    await program.methods
      .submitSealedBid(commitment, collateral)
      .accounts({
        auctionConfig: auctionPda,
        bidder: bidder2.publicKey,
      })
      .signers([bidder2])
      .rpc();

    const auction = await program.account.auctionConfig.fetch(auctionPda);
    const sealedType = (auction.auctionType as any).sealedVickrey;
    expect(sealedType.bidCount).to.equal(2);
  });

  it("rejects insufficient collateral", async () => {
    const bidder3 = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        bidder3.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    const nonce3 = anchor.web3.Keypair.generate()
      .publicKey.toBytes()
      .slice(0, 32);
    const commitment = computeCommitment(
      new anchor.BN(1e9),
      new Uint8Array(nonce3)
    );

    try {
      await program.methods
        .submitSealedBid(
          commitment,
          new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL)
        ) // 1 SOL < 2 SOL min
        .accounts({ auctionConfig: auctionPda, bidder: bidder3.publicKey })
        .signers([bidder3])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InsufficientCollateral");
    }
  });

  it("rejects reveal when auction is still Active (not in reveal phase)", async () => {
    try {
      await program.methods
        .revealBid(bidAmount1, Array.from(nonce1))
        .accounts({
          auctionConfig: auctionPda,
          bidder: bidder1.publicKey,
        })
        .signers([bidder1])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("RevealPhaseNotStarted");
    }
  });

  it("rejects close_bidding before end_time", async () => {
    try {
      await program.methods
        .closeBidding()
        .accounts({
          auctionConfig: auctionPda,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("AuctionStillActive");
    }
  });
});

describe("sealed_auction_close_and_reveal", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  let housePda: anchor.web3.PublicKey;
  let mint: anchor.web3.PublicKey;
  let sellerAta: anchor.web3.PublicKey;
  let auctionPda: anchor.web3.PublicKey;
  const auctionId = new anchor.BN(301);

  const bidder1 = anchor.web3.Keypair.generate();
  const bidder2 = anchor.web3.Keypair.generate();
  const nonce1 = anchor.web3.Keypair.generate()
    .publicKey.toBytes()
    .slice(0, 32);
  const nonce2 = anchor.web3.Keypair.generate()
    .publicKey.toBytes()
    .slice(0, 32);
  const bidAmount1 = new anchor.BN(5 * anchor.web3.LAMPORTS_PER_SOL); // 5 SOL
  const bidAmount2 = new anchor.BN(3 * anchor.web3.LAMPORTS_PER_SOL); // 3 SOL
  const minCollateral = new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL);

  before(async () => {
    // Init house (may already exist from previous describe block)
    [housePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("house"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );
    try {
      await program.account.auctionHouse.fetch(housePda);
    } catch {
      await program.methods
        .initializeHouse(500)
        .accounts({
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }

    // Mint + ATA for this auction
    const payer = (provider.wallet as anchor.Wallet).payer;
    mint = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0
    );
    sellerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      provider.wallet.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      mint,
      sellerAta,
      provider.wallet.publicKey,
      1
    );

    // Create sealed auction with end_time 3 seconds from now
    const now = Math.floor(Date.now() / 1000);
    [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createAuction(
        auctionId,
        {
          sealedVickrey: {
            minCollateral,
            revealDuration: new anchor.BN(3600), // 1 hour reveal window
          },
        },
        new anchor.BN(now - 60), // started 1 min ago
        new anchor.BN(now + 3) // ends in 3 seconds
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // Fund bidders
    for (const b of [bidder1, bidder2]) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          b.publicKey,
          20 * anchor.web3.LAMPORTS_PER_SOL
        )
      );
    }

    // Submit sealed bids immediately (within the 3-second window)
    const commitment1 = computeCommitment(bidAmount1, new Uint8Array(nonce1));
    await program.methods
      .submitSealedBid(
        commitment1,
        new anchor.BN(6 * anchor.web3.LAMPORTS_PER_SOL)
      )
      .accounts({ auctionConfig: auctionPda, bidder: bidder1.publicKey })
      .signers([bidder1])
      .rpc();

    const commitment2 = computeCommitment(bidAmount2, new Uint8Array(nonce2));
    await program.methods
      .submitSealedBid(
        commitment2,
        new anchor.BN(4 * anchor.web3.LAMPORTS_PER_SOL)
      )
      .accounts({ auctionConfig: auctionPda, bidder: bidder2.publicKey })
      .signers([bidder2])
      .rpc();

    // Wait for end_time to pass
    await new Promise((r) => setTimeout(r, 4000));

    // Close bidding
    await program.methods
      .closeBidding()
      .accounts({ auctionConfig: auctionPda })
      .rpc();
  });

  it("closes bidding after end_time", async () => {
    const auction = await program.account.auctionConfig.fetch(auctionPda);
    expect(JSON.stringify(auction.status)).to.include("biddingClosed");
  });

  it("reveals bid with correct hash after bidding closed", async () => {
    await program.methods
      .revealBid(bidAmount1, Array.from(nonce1))
      .accounts({
        auctionConfig: auctionPda,
        bidder: bidder1.publicKey,
      })
      .signers([bidder1])
      .rpc();

    // Verify bid escrow updated
    const [bidPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), auctionPda.toBuffer(), bidder1.publicKey.toBuffer()],
      program.programId
    );
    const bid = await program.account.bidEscrow.fetch(bidPda);
    expect(bid.revealed).to.be.true;
    expect(bid.revealedAmount.toNumber()).to.equal(
      5 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Verify auction tracks highest bid
    const auction = await program.account.auctionConfig.fetch(auctionPda);
    const sealedType = (auction.auctionType as any).sealedVickrey;
    expect(sealedType.highestBid.toNumber()).to.equal(
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    expect(sealedType.winner.toBase58()).to.equal(bidder1.publicKey.toBase58());

    // Status should transition to RevealPhase on first reveal
    expect(JSON.stringify(auction.status)).to.include("revealPhase");
  });

  it("rejects reveal with wrong nonce (hash mismatch)", async () => {
    const wrongNonce = new Uint8Array(32).fill(0xff);
    try {
      await program.methods
        .revealBid(bidAmount2, Array.from(wrongNonce))
        .accounts({
          auctionConfig: auctionPda,
          bidder: bidder2.publicKey,
        })
        .signers([bidder2])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("HashMismatch");
    }
  });

  it("rejects double reveal", async () => {
    // bidder1 already revealed in the "reveals bid with correct hash" test
    try {
      await program.methods
        .revealBid(bidAmount1, Array.from(nonce1))
        .accounts({
          auctionConfig: auctionPda,
          bidder: bidder1.publicKey,
        })
        .signers([bidder1])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("AlreadyRevealed");
    }
  });

  it("reveals second bid and tracks Vickrey second-price", async () => {
    await program.methods
      .revealBid(bidAmount2, Array.from(nonce2))
      .accounts({
        auctionConfig: auctionPda,
        bidder: bidder2.publicKey,
      })
      .signers([bidder2])
      .rpc();

    const auction = await program.account.auctionConfig.fetch(auctionPda);
    const sealedType = (auction.auctionType as any).sealedVickrey;
    // bidder1 = 5 SOL (highest), bidder2 = 3 SOL (second)
    expect(sealedType.highestBid.toNumber()).to.equal(
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    expect(sealedType.secondBid.toNumber()).to.equal(
      3 * anchor.web3.LAMPORTS_PER_SOL
    );
    expect(sealedType.winner.toBase58()).to.equal(bidder1.publicKey.toBase58());
  });
});

describe("forfeit_unrevealed", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  let housePda: anchor.web3.PublicKey;

  // Auction 302: short reveal window (expires fast) — two bidders, one reveals, one doesn't
  let mint302: anchor.web3.PublicKey;
  let sellerAta302: anchor.web3.PublicKey;
  let auctionPda302: anchor.web3.PublicKey;
  const auctionId302 = new anchor.BN(302);
  const bidder1 = anchor.web3.Keypair.generate();
  const bidder2 = anchor.web3.Keypair.generate();
  const nonce1 = anchor.web3.Keypair.generate()
    .publicKey.toBytes()
    .slice(0, 32);
  const nonce2 = anchor.web3.Keypair.generate()
    .publicKey.toBytes()
    .slice(0, 32);
  const bidAmount1 = new anchor.BN(5 * anchor.web3.LAMPORTS_PER_SOL);
  const bidAmount2 = new anchor.BN(3 * anchor.web3.LAMPORTS_PER_SOL);
  const minCollateral = new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL);

  // Auction 303: long reveal window — for "too early" rejection test
  let mint303: anchor.web3.PublicKey;
  let sellerAta303: anchor.web3.PublicKey;
  let auctionPda303: anchor.web3.PublicKey;
  const auctionId303 = new anchor.BN(303);
  const bidder3 = anchor.web3.Keypair.generate();
  const nonce3 = anchor.web3.Keypair.generate()
    .publicKey.toBytes()
    .slice(0, 32);
  const bidAmount3 = new anchor.BN(4 * anchor.web3.LAMPORTS_PER_SOL);

  before(async () => {
    [housePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("house"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );
    try {
      await program.account.auctionHouse.fetch(housePda);
    } catch {
      await program.methods
        .initializeHouse(500)
        .accounts({
          authority: provider.wallet.publicKey,
        })
        .rpc();
    }

    const payer = (provider.wallet as anchor.Wallet).payer;

    // Fund all bidders FIRST (airdrops take time)
    for (const b of [bidder1, bidder2, bidder3]) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          b.publicKey,
          20 * anchor.web3.LAMPORTS_PER_SOL
        )
      );
    }

    // Capture fresh timestamp AFTER airdrops to minimize timing drift
    const now = Math.floor(Date.now() / 1000);

    // --- Auction 302: ends in 8s, reveal_duration = 3s ---
    // reveal_end_time = now + 8 + 3 = now + 11 (expires ~11s from creation)
    mint302 = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0
    );
    sellerAta302 = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint302,
      provider.wallet.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      mint302,
      sellerAta302,
      provider.wallet.publicKey,
      1
    );

    [auctionPda302] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId302.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createAuction(
        auctionId302,
        {
          sealedVickrey: {
            minCollateral,
            revealDuration: new anchor.BN(3), // 3 second reveal window
          },
        },
        new anchor.BN(now - 60),
        new anchor.BN(now + 8) // ends in 8 seconds (generous bidding window)
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint302,
        sellerItemAccount: sellerAta302,
      })
      .rpc();

    // --- Auction 303: ends in 8s, reveal_duration = 3600s (long reveal) ---
    // reveal_end_time = now + 8 + 3600 (far in the future)
    mint303 = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0
    );
    sellerAta303 = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint303,
      provider.wallet.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      mint303,
      sellerAta303,
      provider.wallet.publicKey,
      1
    );

    [auctionPda303] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId303.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createAuction(
        auctionId303,
        {
          sealedVickrey: {
            minCollateral,
            revealDuration: new anchor.BN(3600), // 1 hour reveal window
          },
        },
        new anchor.BN(now - 60),
        new anchor.BN(now + 8) // ends in 8 seconds
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint303,
        sellerItemAccount: sellerAta303,
      })
      .rpc();

    // Submit bids on auction 302 (two bidders) — within the 8-second window
    const commitment1 = computeCommitment(bidAmount1, new Uint8Array(nonce1));
    await program.methods
      .submitSealedBid(
        commitment1,
        new anchor.BN(6 * anchor.web3.LAMPORTS_PER_SOL)
      )
      .accounts({ auctionConfig: auctionPda302, bidder: bidder1.publicKey })
      .signers([bidder1])
      .rpc();

    const commitment2 = computeCommitment(bidAmount2, new Uint8Array(nonce2));
    await program.methods
      .submitSealedBid(
        commitment2,
        new anchor.BN(4 * anchor.web3.LAMPORTS_PER_SOL)
      )
      .accounts({ auctionConfig: auctionPda302, bidder: bidder2.publicKey })
      .signers([bidder2])
      .rpc();

    // Submit bid on auction 303
    const commitment3 = computeCommitment(bidAmount3, new Uint8Array(nonce3));
    await program.methods
      .submitSealedBid(
        commitment3,
        new anchor.BN(5 * anchor.web3.LAMPORTS_PER_SOL)
      )
      .accounts({ auctionConfig: auctionPda303, bidder: bidder3.publicKey })
      .signers([bidder3])
      .rpc();

    // Wait for end_time + reveal_duration of auction 302 to pass
    // end_time = now + 8, reveal_end = now + 11. Need to wait until now + 12 at least.
    // Account for ~3-4s already spent on setup above.
    await new Promise((r) => setTimeout(r, 13000));

    // Close bidding on both auctions (both are past end_time)
    await program.methods
      .closeBidding()
      .accounts({ auctionConfig: auctionPda302 })
      .rpc();
    await program.methods
      .closeBidding()
      .accounts({ auctionConfig: auctionPda303 })
      .rpc();

    // Reveal bidder3's bid on auction 303 (reveal window still open: 1 hour)
    // Auction 302's reveal window has already expired — bids stay unrevealed (for forfeit test)
    await program.methods
      .revealBid(bidAmount3, Array.from(nonce3))
      .accounts({
        auctionConfig: auctionPda303,
        bidder: bidder3.publicKey,
      })
      .signers([bidder3])
      .rpc();
  });

  it("rejects forfeit before reveal period ends", async () => {
    // Auction 303 has reveal_end_time ~1 hour from now — reveal period NOT over
    const [bidPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("bid"),
        auctionPda303.toBuffer(),
        bidder3.publicKey.toBuffer(),
      ],
      program.programId
    );

    try {
      await program.methods
        .forfeitUnrevealed()
        .accounts({
          auctionConfig: auctionPda303,
          bidEscrow: bidPda,
          seller: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      // RevealPhaseNotStarted is reused to mean "reveal period not over yet"
      // OR AlreadyRevealed since this bid was revealed
      // The handler checks reveal_end_time first, then revealed flag
      // Since reveal_end_time hasn't passed, we get RevealPhaseNotStarted
      expect(e.error.errorCode.code).to.equal("RevealPhaseNotStarted");
    }
  });

  it("forfeits unrevealed bid to seller after reveal period", async () => {
    // Auction 302: reveal period has expired, bidder2 never revealed
    const sellerBalanceBefore = await provider.connection.getBalance(
      provider.wallet.publicKey
    );

    const [bidPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("bid"),
        auctionPda302.toBuffer(),
        bidder2.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Bid escrow exists and is NOT revealed
    const bidBefore = await program.account.bidEscrow.fetch(bidPda);
    expect(bidBefore.revealed).to.be.false;

    await program.methods
      .forfeitUnrevealed()
      .accounts({
        auctionConfig: auctionPda302,
        bidEscrow: bidPda,
        seller: provider.wallet.publicKey,
      })
      .rpc();

    // Bid escrow account should be closed
    const bidAccount = await provider.connection.getAccountInfo(bidPda);
    expect(bidAccount).to.be.null;

    // Seller received the lamports (rent + collateral)
    const sellerBalanceAfter = await provider.connection.getBalance(
      provider.wallet.publicKey
    );
    expect(sellerBalanceAfter).to.be.greaterThan(sellerBalanceBefore);
  });

  it("forfeits second unrevealed bid on same auction", async () => {
    // Auction 302: bidder1 also never revealed — forfeit their bid too
    const sellerBalanceBefore = await provider.connection.getBalance(
      provider.wallet.publicKey
    );

    const [bidPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("bid"),
        auctionPda302.toBuffer(),
        bidder1.publicKey.toBuffer(),
      ],
      program.programId
    );

    const bidBefore = await program.account.bidEscrow.fetch(bidPda);
    expect(bidBefore.revealed).to.be.false;

    await program.methods
      .forfeitUnrevealed()
      .accounts({
        auctionConfig: auctionPda302,
        bidEscrow: bidPda,
        seller: provider.wallet.publicKey,
      })
      .rpc();

    const bidAccount = await provider.connection.getAccountInfo(bidPda);
    expect(bidAccount).to.be.null;

    const sellerBalanceAfter = await provider.connection.getBalance(
      provider.wallet.publicKey
    );
    expect(sellerBalanceAfter).to.be.greaterThan(sellerBalanceBefore);
  });
});
