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
  const nonce1 = anchor.web3.Keypair.generate().publicKey.toBytes().slice(0, 32);
  const nonce2 = anchor.web3.Keypair.generate().publicKey.toBytes().slice(0, 32);
  const bidAmount1 = new anchor.BN(5 * anchor.web3.LAMPORTS_PER_SOL); // 5 SOL
  const bidAmount2 = new anchor.BN(3 * anchor.web3.LAMPORTS_PER_SOL); // 3 SOL
  const minCollateral = new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL); // 2 SOL

  before(async () => {
    // Init house
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

    // Mint + ATA
    const payer = (provider.wallet as anchor.Wallet).payer;
    mint = await createMint(provider.connection, payer, provider.wallet.publicKey, null, 0);
    sellerAta = await createAssociatedTokenAccount(provider.connection, payer, mint, provider.wallet.publicKey);
    await mintTo(provider.connection, payer, mint, sellerAta, provider.wallet.publicKey, 1);

    // Create sealed-bid auction (start in past, end in 1 hour)
    const now = Math.floor(Date.now() / 1000);
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
          sealedVickrey: {
            minCollateral,
            revealDuration: new anchor.BN(3600), // 1 hour reveal
          },
        },
        new anchor.BN(now - 60), // started 1 min ago
        new anchor.BN(now + 3600), // ends in 1 hour
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
        await provider.connection.requestAirdrop(b.publicKey, 20 * anchor.web3.LAMPORTS_PER_SOL),
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
      program.programId,
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
      await provider.connection.requestAirdrop(bidder3.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL),
    );

    const nonce3 = anchor.web3.Keypair.generate().publicKey.toBytes().slice(0, 32);
    const commitment = computeCommitment(new anchor.BN(1e9), new Uint8Array(nonce3));

    try {
      await program.methods
        .submitSealedBid(commitment, new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL)) // 1 SOL < 2 SOL min
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
});
