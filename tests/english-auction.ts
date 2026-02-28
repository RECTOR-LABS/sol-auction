import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolAuction } from "../target/types/sol_auction";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";

describe("english_auction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  let mint: anchor.web3.PublicKey;
  let sellerAta: anchor.web3.PublicKey;
  let housePda: anchor.web3.PublicKey;
  let auctionPda: anchor.web3.PublicKey;
  const auctionId = new anchor.BN(100);
  const startPrice = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL); // 1 SOL
  const minIncrement = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 10); // 0.1 SOL

  // Use short durations for testing. We'll set start_time in the past
  // so the auction is immediately active.
  let startTime: number;
  let endTime: number;

  before(async () => {
    // Init house (idempotent)
    [housePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("house"), provider.wallet.publicKey.toBuffer()],
      program.programId,
    );
    try {
      await program.account.auctionHouse.fetch(housePda);
    } catch {
      await program.methods.initializeHouse(500).accounts({
        authority: provider.wallet.publicKey,
      }).rpc();
    }

    // Create mint + seller ATA + mint 1 token
    const payer = (provider.wallet as anchor.Wallet).payer;
    mint = await createMint(provider.connection, payer, provider.wallet.publicKey, null, 0);
    sellerAta = await createAssociatedTokenAccount(provider.connection, payer, mint, provider.wallet.publicKey);
    await mintTo(provider.connection, payer, mint, sellerAta, provider.wallet.publicKey, 1);

    // Create auction with start_time in the past so it's immediately biddable
    const now = Math.floor(Date.now() / 1000);
    startTime = now - 60; // Started 1 min ago
    endTime = now + 3600; // Ends in 1 hour

    [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );

    await program.methods
      .createAuction(
        auctionId,
        {
          english: {
            startPrice,
            minIncrement,
            antiSnipeDuration: new anchor.BN(300), // 5 min anti-snipe
          },
        },
        new anchor.BN(startTime),
        new anchor.BN(endTime),
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();
  });

  it("places valid first bid at start_price", async () => {
    const bidder = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      bidder.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(airdropSig);

    const bidAmount = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL); // 1 SOL

    await program.methods
      .placeBid(bidAmount)
      .accounts({
        auctionConfig: auctionPda,
        bidder: bidder.publicKey,
      })
      .signers([bidder])
      .rpc();

    // Verify bid escrow
    const [bidEscrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), auctionPda.toBuffer(), bidder.publicKey.toBuffer()],
      program.programId,
    );
    const bid = await program.account.bidEscrow.fetch(bidEscrowPda);
    expect(bid.bidder.toBase58()).to.equal(bidder.publicKey.toBase58());
    expect(bid.amount.toNumber()).to.equal(anchor.web3.LAMPORTS_PER_SOL);

    // Verify auction state updated
    const auction = await program.account.auctionConfig.fetch(auctionPda);
    expect(JSON.stringify(auction.status)).to.include("active");
    const englishType = (auction.auctionType as any).english;
    expect(englishType.highestBid.toNumber()).to.equal(anchor.web3.LAMPORTS_PER_SOL);
    expect(englishType.highestBidder.toBase58()).to.equal(bidder.publicKey.toBase58());
    expect(englishType.bidCount).to.equal(1);
  });

  it("places second bid meeting min_increment", async () => {
    const bidder2 = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      bidder2.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Must be >= highest_bid + min_increment = 1.0 + 0.1 = 1.1 SOL
    const bidAmount = new anchor.BN(1.1 * anchor.web3.LAMPORTS_PER_SOL);

    await program.methods
      .placeBid(bidAmount)
      .accounts({
        auctionConfig: auctionPda,
        bidder: bidder2.publicKey,
      })
      .signers([bidder2])
      .rpc();

    const auction = await program.account.auctionConfig.fetch(auctionPda);
    const englishType = (auction.auctionType as any).english;
    expect(englishType.highestBid.toNumber()).to.equal(1.1 * anchor.web3.LAMPORTS_PER_SOL);
    expect(englishType.highestBidder.toBase58()).to.equal(bidder2.publicKey.toBase58());
    expect(englishType.bidCount).to.equal(2);
  });

  it("rejects bid below start_price (first bid scenario)", async () => {
    // Create a separate auction for this test
    const payer = (provider.wallet as anchor.Wallet).payer;
    const mint2 = await createMint(provider.connection, payer, provider.wallet.publicKey, null, 0);
    const ata2 = await createAssociatedTokenAccount(provider.connection, payer, mint2, provider.wallet.publicKey);
    await mintTo(provider.connection, payer, mint2, ata2, provider.wallet.publicKey, 1);

    const aid = new anchor.BN(101);
    const now = Math.floor(Date.now() / 1000);

    const [apda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), provider.wallet.publicKey.toBuffer(), aid.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );

    await program.methods
      .createAuction(aid, { english: { startPrice, minIncrement, antiSnipeDuration: new anchor.BN(300) } }, new anchor.BN(now - 60), new anchor.BN(now + 3600))
      .accounts({ seller: provider.wallet.publicKey, auctionHouse: housePda, itemMint: mint2, sellerItemAccount: ata2 })
      .rpc();

    const lowBidder = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(lowBidder.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL),
    );

    try {
      await program.methods
        .placeBid(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 2)) // 0.5 SOL < 1 SOL start
        .accounts({ auctionConfig: apda, bidder: lowBidder.publicKey })
        .signers([lowBidder])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("BidTooLow");
    }
  });

  it("rejects bid below highest + min_increment", async () => {
    // Use the main auction (already has bid at 1.1 SOL, min_increment 0.1 SOL)
    // Need >= 1.2 SOL
    const lowBidder = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(lowBidder.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL),
    );

    try {
      await program.methods
        .placeBid(new anchor.BN(1.15 * anchor.web3.LAMPORTS_PER_SOL)) // 1.15 < 1.2
        .accounts({ auctionConfig: auctionPda, bidder: lowBidder.publicKey })
        .signers([lowBidder])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("BidTooLow");
    }
  });

  it("seller cannot bid on own auction", async () => {
    // Create a fresh auction where wallet is both seller and would-be bidder
    const payer = (provider.wallet as anchor.Wallet).payer;
    const mint3 = await createMint(provider.connection, payer, provider.wallet.publicKey, null, 0);
    const ata3 = await createAssociatedTokenAccount(provider.connection, payer, mint3, provider.wallet.publicKey);
    await mintTo(provider.connection, payer, mint3, ata3, provider.wallet.publicKey, 1);

    const aid = new anchor.BN(102);
    const now = Math.floor(Date.now() / 1000);

    const [apda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), provider.wallet.publicKey.toBuffer(), aid.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );

    await program.methods
      .createAuction(aid, { english: { startPrice, minIncrement, antiSnipeDuration: new anchor.BN(300) } }, new anchor.BN(now - 60), new anchor.BN(now + 3600))
      .accounts({ seller: provider.wallet.publicKey, auctionHouse: housePda, itemMint: mint3, sellerItemAccount: ata3 })
      .rpc();

    try {
      await program.methods
        .placeBid(startPrice)
        .accounts({ auctionConfig: apda, bidder: provider.wallet.publicKey })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("SellerCannotBid");
    }
  });
});
