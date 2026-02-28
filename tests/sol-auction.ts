import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolAuction } from "../target/types/sol_auction";

describe("sol-auction", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.solAuction as Program<SolAuction>;

  it("Is initialized!", async () => {
    // Placeholder — real tests come in subsequent tasks
  });
});
