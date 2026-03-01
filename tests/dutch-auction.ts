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

describe("dutch_auction", () => {
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

  it("buys Dutch auction at current price", async () => {
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

    const auctionId = new anchor.BN(200);
    const now = Math.floor(Date.now() / 1000);
    const startPrice = new anchor.BN(10 * anchor.web3.LAMPORTS_PER_SOL); // 10 SOL
    const reservePrice = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL); // 1 SOL

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

    // Create Dutch auction (started 1 min ago, ends in 1 hour)
    await program.methods
      .createAuction(
        auctionId,
        { dutch: { startPrice, reservePrice } },
        new anchor.BN(now - 60),
        new anchor.BN(now + 3540) // total 3600s = 1 hour
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // Buyer setup
    const buyer = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        buyer.publicKey,
        20 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    // Create buyer's token account for the item
    const buyerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      buyer.publicKey
    );

    // Get seller balance before
    const sellerBalanceBefore = await provider.connection.getBalance(
      provider.wallet.publicKey
    );

    // Buy now
    await program.methods
      .buyNow()
      .accounts({
        auctionConfig: auctionPda,
        itemVault: vaultPda,
        itemMint: mint,
        buyerItemAccount: buyerAta,
        seller: provider.wallet.publicKey,
        buyer: buyer.publicKey,
        auctionHouse: housePda,
        treasury: provider.wallet.publicKey,
      })
      .signers([buyer])
      .rpc();

    // Verify item transferred to buyer
    const buyerTokenAccount = await getAccount(provider.connection, buyerAta);
    expect(Number(buyerTokenAccount.amount)).to.equal(1);

    // Verify vault is empty
    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(0);

    // Verify auction is settled
    const auction = await program.account.auctionConfig.fetch(auctionPda);
    expect(JSON.stringify(auction.status)).to.include("settled");

    // Verify seller received SOL (should be > 0, exact amount depends on timing)
    const sellerBalanceAfter = await provider.connection.getBalance(
      provider.wallet.publicKey
    );
    expect(sellerBalanceAfter).to.be.gt(sellerBalanceBefore);
  });

  it("rejects buy after auction already settled", async () => {
    // Create a fresh Dutch auction, buy it, then try to buy again
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

    const auctionId = new anchor.BN(201);
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
          dutch: {
            startPrice: new anchor.BN(5e9),
            reservePrice: new anchor.BN(1e9),
          },
        },
        new anchor.BN(now - 60),
        new anchor.BN(now + 3540)
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // First buyer
    const buyer1 = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(buyer1.publicKey, 20e9)
    );
    const buyer1Ata = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      buyer1.publicKey
    );

    await program.methods
      .buyNow()
      .accounts({
        auctionConfig: auctionPda,
        itemVault: vaultPda,
        itemMint: mint,
        buyerItemAccount: buyer1Ata,
        seller: provider.wallet.publicKey,
        buyer: buyer1.publicKey,
        auctionHouse: housePda,
        treasury: provider.wallet.publicKey,
      })
      .signers([buyer1])
      .rpc();

    // Second buyer tries to buy settled auction
    const buyer2 = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(buyer2.publicKey, 20e9)
    );
    const buyer2Ata = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      buyer2.publicKey
    );

    try {
      await program.methods
        .buyNow()
        .accounts({
          auctionConfig: auctionPda,
          itemVault: vaultPda,
          itemMint: mint,
          buyerItemAccount: buyer2Ata,
          seller: provider.wallet.publicKey,
          buyer: buyer2.publicKey,
          auctionHouse: housePda,
          treasury: provider.wallet.publicKey,
        })
        .signers([buyer2])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("InvalidAuctionStatus");
    }
  });

  it("seller cannot buy own Dutch auction", async () => {
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

    const auctionId = new anchor.BN(202);
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
          dutch: {
            startPrice: new anchor.BN(5e9),
            reservePrice: new anchor.BN(1e9),
          },
        },
        new anchor.BN(now - 60),
        new anchor.BN(now + 3540)
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    try {
      await program.methods
        .buyNow()
        .accounts({
          auctionConfig: auctionPda,
          itemVault: vaultPda,
          itemMint: mint,
          buyerItemAccount: sellerAta,
          seller: provider.wallet.publicKey,
          buyer: provider.wallet.publicKey,
          auctionHouse: housePda,
          treasury: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("SellerCannotBid");
    }
  });
});
