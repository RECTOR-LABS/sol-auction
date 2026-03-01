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

describe("create_auction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  let mint: anchor.web3.PublicKey;
  let sellerAta: anchor.web3.PublicKey;
  let housePda: anchor.web3.PublicKey;

  before(async () => {
    // Initialize auction house (idempotent)
    [housePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("house"), provider.wallet.publicKey.toBuffer()],
      program.programId,
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

    // Create NFT mint (0 decimals) + seller ATA + mint 1 token
    const payer = (provider.wallet as anchor.Wallet).payer;
    mint = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0,
    );
    sellerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      provider.wallet.publicKey,
    );
    await mintTo(
      provider.connection,
      payer,
      mint,
      sellerAta,
      provider.wallet.publicKey,
      1,
    );
  });

  it("creates English auction and deposits item into vault", async () => {
    const auctionId = new anchor.BN(1);
    const now = Math.floor(Date.now() / 1000);

    const [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("auction"),
        provider.wallet.publicKey.toBuffer(),
        auctionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), auctionPda.toBuffer()],
      program.programId,
    );

    await program.methods
      .createAuction(
        auctionId,
        {
          english: {
            startPrice: new anchor.BN(anchor.web3.LAMPORTS_PER_SOL),
            minIncrement: new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 10),
            antiSnipeDuration: new anchor.BN(300),
          },
        },
        new anchor.BN(now + 10),
        new anchor.BN(now + 3610),
      )
      .accounts({
        seller: provider.wallet.publicKey,
        auctionHouse: housePda,
        itemMint: mint,
        sellerItemAccount: sellerAta,
      })
      .rpc();

    // Verify auction state
    const auction = await program.account.auctionConfig.fetch(auctionPda);
    expect(auction.seller.toBase58()).to.equal(
      provider.wallet.publicKey.toBase58(),
    );
    expect(auction.auctionId.toNumber()).to.equal(1);
    expect(JSON.stringify(auction.status)).to.include("created");
    expect(auction.itemMint.toBase58()).to.equal(mint.toBase58());

    // Verify item transferred to vault
    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(1);

    // Verify house counter incremented
    const house = await program.account.auctionHouse.fetch(housePda);
    expect(house.totalAuctions.toNumber()).to.be.gte(1);
  });

  it("rejects invalid time range (start >= end)", async () => {
    // Need a new mint since the first one's token is already in the vault
    const payer = (provider.wallet as anchor.Wallet).payer;
    const mint2 = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      0,
    );
    const sellerAta2 = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint2,
      provider.wallet.publicKey,
    );
    await mintTo(
      provider.connection,
      payer,
      mint2,
      sellerAta2,
      provider.wallet.publicKey,
      1,
    );

    const auctionId = new anchor.BN(99);
    const now = Math.floor(Date.now() / 1000);

    try {
      await program.methods
        .createAuction(
          auctionId,
          {
            english: {
              startPrice: new anchor.BN(1_000_000_000),
              minIncrement: new anchor.BN(100_000_000),
              antiSnipeDuration: new anchor.BN(300),
            },
          },
          new anchor.BN(now + 100),
          new anchor.BN(now + 50), // end before start
        )
        .accounts({
          seller: provider.wallet.publicKey,
          auctionHouse: housePda,
          itemMint: mint2,
          sellerItemAccount: sellerAta2,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      const anchorError = e as { error: { errorCode: { code: string } } };
      expect(anchorError.error.errorCode.code).to.equal("InvalidTimeRange");
    }
  });
});
