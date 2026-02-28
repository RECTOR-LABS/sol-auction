import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolAuction } from "../target/types/sol_auction";
import { expect } from "chai";

describe("initialize_house", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solAuction as Program<SolAuction>;

  it("initializes auction house with correct state", async () => {
    const [housePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("house"), provider.wallet.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .initializeHouse(500) // 5% fee
      .accounts({
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const house = await program.account.auctionHouse.fetch(housePda);
    expect(house.authority.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(house.feeBps).to.equal(500);
    expect(house.treasury.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(house.totalAuctions.toNumber()).to.equal(0);
  });

  it("rejects fee_bps > 10000", async () => {
    try {
      // Use a different authority to avoid PDA collision with the first test
      const newAuthority = anchor.web3.Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        newAuthority.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(airdropSig);

      await program.methods
        .initializeHouse(10001)
        .accounts({
          authority: newAuthority.publicKey,
        })
        .signers([newAuthority])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      const anchorError = e as { error: { errorCode: { code: string } } };
      expect(anchorError.error.errorCode.code).to.equal("InvalidFeeBps");
    }
  });
});
