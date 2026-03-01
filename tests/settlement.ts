import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolAuction } from "../target/types/sol_auction";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

// Helper: sleep for ms
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("settle_english_auction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  let housePda: anchor.web3.PublicKey;
  let mint: anchor.web3.PublicKey;
  let sellerAta: anchor.web3.PublicKey;
  let auctionPda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;
  const auctionId = new anchor.BN(400);
  const startPrice = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL);
  const minIncrement = new anchor.BN(0.1 * anchor.web3.LAMPORTS_PER_SOL);

  const bidder1 = anchor.web3.Keypair.generate();
  const bidder2 = anchor.web3.Keypair.generate();

  before(async () => {
    // Init house (idempotent)
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

    // Fund bidders
    for (const b of [bidder1, bidder2]) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          b.publicKey,
          20 * anchor.web3.LAMPORTS_PER_SOL
        )
      );
    }

    // Create mint + seller ATA + mint 1 token
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

    // Create English auction that ends in 3 seconds
    const now = Math.floor(Date.now() / 1000);

    [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), auctionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createAuction(
        auctionId,
        {
          english: {
            startPrice,
            minIncrement,
            antiSnipeDuration: new anchor.BN(0), // No anti-snipe to keep timing predictable
          },
        },
        new anchor.BN(now - 60), // Started 1 min ago
        new anchor.BN(now + 3) // Ends in 3 seconds
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // Place bids from both bidders (within the 3-second window)
    await program.methods
      .placeBid(new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL)) // 1 SOL
      .accounts({
        auctionConfig: auctionPda,
        bidder: bidder1.publicKey,
      })
      .signers([bidder1])
      .rpc();

    await program.methods
      .placeBid(new anchor.BN(1.5 * anchor.web3.LAMPORTS_PER_SOL)) // 1.5 SOL (winner)
      .accounts({
        auctionConfig: auctionPda,
        bidder: bidder2.publicKey,
      })
      .signers([bidder2])
      .rpc();

    // Wait for auction to end
    await sleep(4000);
  });

  it("settles English auction — item to winner, SOL to seller", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;

    // Create winner's (bidder2) token account for the item
    const winnerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      bidder2.publicKey
    );

    // Winner's bid escrow PDA
    const [winnerBidEscrow] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), auctionPda.toBuffer(), bidder2.publicKey.toBuffer()],
      program.programId
    );

    // Record balances before settlement
    const sellerBalanceBefore = await provider.connection.getBalance(
      provider.wallet.publicKey
    );
    const treasuryBalanceBefore = await provider.connection.getBalance(
      provider.wallet.publicKey
    ); // treasury = authority

    await program.methods
      .settleAuction()
      .accounts({
        auctionConfig: auctionPda,
        itemVault: vaultPda,
        itemMint: mint,
        winnerItemAccount: winnerAta,
        winnerBidEscrow: winnerBidEscrow,
        winner: bidder2.publicKey,
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        treasury: provider.wallet.publicKey, // treasury = authority for this house
      })
      .rpc();

    // Verify item transferred to winner
    const winnerTokenAccount = await getAccount(provider.connection, winnerAta);
    expect(Number(winnerTokenAccount.amount)).to.equal(1);

    // Verify vault is empty
    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(0);

    // Verify auction status is Settled
    const auction = await program.account.auctionConfig.fetch(auctionPda);
    expect(JSON.stringify(auction.status)).to.include("settled");

    // Verify seller received SOL (minus fee). Since treasury = seller here, both go to same account.
    const sellerBalanceAfter = await provider.connection.getBalance(
      provider.wallet.publicKey
    );
    expect(sellerBalanceAfter).to.be.gt(sellerBalanceBefore);
  });

  it("deducts fee_bps and sends to treasury", async () => {
    // We verify exact math with a fresh auction
    const payer = (provider.wallet as anchor.Wallet).payer;
    const mint2 = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0
    );
    const sellerAta2 = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint2,
      provider.wallet.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      mint2,
      sellerAta2,
      provider.wallet.publicKey,
      1
    );

    // Use a different seller so treasury != seller (cleaner fee verification)
    const seller = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        seller.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    // Create seller's mint + ATA (seller is mint authority, must sign mintTo)
    const sellerMint = await createMint(
      provider.connection,
      payer,
      seller.publicKey,
      null,
      0
    );
    const sellerMintAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      sellerMint,
      seller.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      sellerMint,
      sellerMintAta,
      seller,
      1
    );

    const aid = new anchor.BN(401);
    const now = Math.floor(Date.now() / 1000);

    const [apda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        seller.publicKey.toBuffer(),
        aid.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vpda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), apda.toBuffer()],
      program.programId
    );

    await program.methods
      .createAuction(
        aid,
        {
          english: {
            startPrice: new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL),
            minIncrement: new anchor.BN(0.1 * anchor.web3.LAMPORTS_PER_SOL),
            antiSnipeDuration: new anchor.BN(0),
          },
        },
        new anchor.BN(now - 60),
        new anchor.BN(now + 3)
      )
      .accounts({
        seller: seller.publicKey,
        auctionHouse: housePda,
        itemMint: sellerMint,
        sellerItemAccount: sellerMintAta,
      })
      .signers([seller])
      .rpc();

    // Single bidder bids exactly 1 SOL
    const bidder = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        bidder.publicKey,
        20 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    const bidAmount = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods
      .placeBid(bidAmount)
      .accounts({
        auctionConfig: apda,
        bidder: bidder.publicKey,
      })
      .signers([bidder])
      .rpc();

    // Wait for auction to end
    await sleep(4000);

    // Create winner's token account
    const winnerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      sellerMint,
      bidder.publicKey
    );

    const [bidEscrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), apda.toBuffer(), bidder.publicKey.toBuffer()],
      program.programId
    );

    // Record balances before settlement
    const sellerBalBefore = await provider.connection.getBalance(
      seller.publicKey
    );
    const treasuryBalBefore = await provider.connection.getBalance(
      provider.wallet.publicKey
    );

    await program.methods
      .settleAuction()
      .accounts({
        auctionConfig: apda,
        itemVault: vpda,
        itemMint: sellerMint,
        winnerItemAccount: winnerAta,
        winnerBidEscrow: bidEscrowPda,
        winner: bidder.publicKey,
        seller: seller.publicKey,
        auctionHouse: housePda,
        treasury: provider.wallet.publicKey,
      })
      .rpc();

    // fee_bps = 500 means 5%. 1 SOL * 500 / 10000 = 0.05 SOL fee
    // seller gets 0.95 SOL
    const expectedFee = Math.floor(
      (1 * anchor.web3.LAMPORTS_PER_SOL * 500) / 10000
    );
    const expectedSellerReceives =
      1 * anchor.web3.LAMPORTS_PER_SOL - expectedFee;

    const sellerBalAfter = await provider.connection.getBalance(
      seller.publicKey
    );
    const treasuryBalAfter = await provider.connection.getBalance(
      provider.wallet.publicKey
    );

    expect(sellerBalAfter - sellerBalBefore).to.equal(expectedSellerReceives);
    // Treasury also pays the tx fee for settle, so net change = fee_received - tx_fee.
    // We verify it's within a reasonable range (fee_received minus max ~10k lamports tx cost).
    const treasuryDelta = treasuryBalAfter - treasuryBalBefore;
    expect(treasuryDelta).to.be.greaterThan(expectedFee - 10_000);
    expect(treasuryDelta).to.be.lessThanOrEqual(expectedFee);
  });

  it("rejects settle before auction ends (English)", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const mint3 = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0
    );
    const sellerAta3 = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint3,
      provider.wallet.publicKey
    );
    await mintTo(
      provider.connection,
      payer,
      mint3,
      sellerAta3,
      provider.wallet.publicKey,
      1
    );

    const aid = new anchor.BN(402);
    const now = Math.floor(Date.now() / 1000);

    const [apda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        aid.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vpda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), apda.toBuffer()],
      program.programId
    );

    // Create auction ending in 1 hour
    await program.methods
      .createAuction(
        aid,
        {
          english: {
            startPrice: new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL),
            minIncrement: new anchor.BN(0.1 * anchor.web3.LAMPORTS_PER_SOL),
            antiSnipeDuration: new anchor.BN(0),
          },
        },
        new anchor.BN(now - 60),
        new anchor.BN(now + 3600) // Ends in 1 hour
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint3,
        sellerItemAccount: sellerAta3,
      })
      .rpc();

    // Place a bid so the auction is Active
    const bidder = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        bidder.publicKey,
        20 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    await program.methods
      .placeBid(new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ auctionConfig: apda, bidder: bidder.publicKey })
      .signers([bidder])
      .rpc();

    // Create winner token account + bid escrow PDA
    const winnerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint3,
      bidder.publicKey
    );
    const [bidEscrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), apda.toBuffer(), bidder.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .settleAuction()
        .accounts({
          auctionConfig: apda,
          itemVault: vpda,
          itemMint: mint3,
          winnerItemAccount: winnerAta,
          winnerBidEscrow: bidEscrowPda,
          winner: bidder.publicKey,
          seller: provider.wallet.publicKey,
          auctionHouse: housePda,
          treasury: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("AuctionStillActive");
    }
  });

  it("losing English bidder claims refund", async () => {
    // Use the first auction (id=400) which was already settled
    // bidder1 is the loser (bid 1 SOL), bidder2 won (bid 1.5 SOL)
    const [loserBidEscrow] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), auctionPda.toBuffer(), bidder1.publicKey.toBuffer()],
      program.programId
    );

    const loserBalanceBefore = await provider.connection.getBalance(
      bidder1.publicKey
    );

    await program.methods
      .claimRefund()
      .accounts({
        auctionConfig: auctionPda,
        bidEscrow: loserBidEscrow,
        bidder: bidder1.publicKey,
      })
      .signers([bidder1])
      .rpc();

    // Bid escrow should be closed
    const bidAccount = await provider.connection.getAccountInfo(loserBidEscrow);
    expect(bidAccount).to.be.null;

    // Bidder should have received their SOL back (bid amount + rent)
    const loserBalanceAfter = await provider.connection.getBalance(
      bidder1.publicKey
    );
    expect(loserBalanceAfter).to.be.gt(loserBalanceBefore);
  });

  it("rejects refund for winning bidder", async () => {
    // bidder2 is the winner of auction 400 — should not be able to claim refund
    const [winnerBidEscrow] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), auctionPda.toBuffer(), bidder2.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimRefund()
        .accounts({
          auctionConfig: auctionPda,
          bidEscrow: winnerBidEscrow,
          bidder: bidder2.publicKey,
        })
        .signers([bidder2])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("Unauthorized");
    }
  });
});

describe("cancel_auction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  let housePda: anchor.web3.PublicKey;

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
  });

  it("cancels auction with no bids — item returned to seller", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const mint = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0
    );
    const sellerAta = await createAssociatedTokenAccount(
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

    const auctionId = new anchor.BN(500);
    const now = Math.floor(Date.now() / 1000);

    const [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), auctionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createAuction(
        auctionId,
        {
          english: {
            startPrice: new anchor.BN(1e9),
            minIncrement: new anchor.BN(0.1e9),
            antiSnipeDuration: new anchor.BN(0),
          },
        },
        new anchor.BN(now - 60),
        new anchor.BN(now + 3600)
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // Verify item is in vault before cancel
    const vaultBefore = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBefore.amount)).to.equal(1);
    const sellerAtaBefore = await getAccount(provider.connection, sellerAta);
    expect(Number(sellerAtaBefore.amount)).to.equal(0);

    // Cancel the auction
    await program.methods
      .cancelAuction()
      .accounts({
        auctionConfig: auctionPda,
        itemVault: vaultPda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
        seller: provider.wallet.publicKey,
      })
      .rpc();

    // Verify item returned to seller
    const sellerAtaAfter = await getAccount(provider.connection, sellerAta);
    expect(Number(sellerAtaAfter.amount)).to.equal(1);

    // Verify vault is empty
    const vaultAfter = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAfter.amount)).to.equal(0);

    // Verify auction status is Cancelled
    const auction = await program.account.auctionConfig.fetch(auctionPda);
    expect(JSON.stringify(auction.status)).to.include("cancelled");
  });

  it("rejects cancel after bids placed", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const mint = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0
    );
    const sellerAta = await createAssociatedTokenAccount(
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

    const auctionId = new anchor.BN(501);
    const now = Math.floor(Date.now() / 1000);

    const [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), auctionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createAuction(
        auctionId,
        {
          english: {
            startPrice: new anchor.BN(1e9),
            minIncrement: new anchor.BN(0.1e9),
            antiSnipeDuration: new anchor.BN(0),
          },
        },
        new anchor.BN(now - 60),
        new anchor.BN(now + 3600)
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // Place a bid (transitions status to Active)
    const bidder = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        bidder.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    await program.methods
      .placeBid(new anchor.BN(1e9))
      .accounts({ auctionConfig: auctionPda, bidder: bidder.publicKey })
      .signers([bidder])
      .rpc();

    // Try to cancel — should fail because status is now Active
    try {
      await program.methods
        .cancelAuction()
        .accounts({
          auctionConfig: auctionPda,
          itemVault: vaultPda,
          itemMint: mint,
          sellerItemAccount: sellerAta,
          seller: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("CannotCancelWithBids");
    }
  });

  it("rejects cancel by non-seller", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const mint = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0
    );
    const sellerAta = await createAssociatedTokenAccount(
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

    const auctionId = new anchor.BN(502);
    const now = Math.floor(Date.now() / 1000);

    const [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), auctionPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createAuction(
        auctionId,
        {
          english: {
            startPrice: new anchor.BN(1e9),
            minIncrement: new anchor.BN(0.1e9),
            antiSnipeDuration: new anchor.BN(0),
          },
        },
        new anchor.BN(now - 60),
        new anchor.BN(now + 3600)
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // Non-seller tries to cancel
    const imposter = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        imposter.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    // The imposter needs a token account for the item too (to pass as sellerItemAccount)
    const imposterAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      imposter.publicKey
    );

    try {
      await program.methods
        .cancelAuction()
        .accounts({
          auctionConfig: auctionPda,
          itemVault: vaultPda,
          itemMint: mint,
          sellerItemAccount: imposterAta,
          seller: imposter.publicKey,
        })
        .signers([imposter])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      // Will fail because seller constraint checks auction_config.seller != imposter
      expect(e.error?.errorCode?.code || e.message).to.satisfy(
        (v: string) =>
          v === "Unauthorized" ||
          v.includes("Unauthorized") ||
          v.includes("ConstraintRaw") ||
          v.includes("constraint")
      );
    }
  });
});
