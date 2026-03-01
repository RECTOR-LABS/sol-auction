#!/usr/bin/env node

import { Command } from "commander";
import { registerCreateCommands } from "./commands/create.js";
import { registerBidCommands } from "./commands/bid.js";
import { registerSealedCommands } from "./commands/sealed.js";
import { registerManageCommands } from "./commands/manage.js";

const program = new Command();

program
  .name("sol-auction")
  .description("CLI client for the sol-auction Anchor program")
  .version("0.1.0");

registerCreateCommands(program);
registerBidCommands(program);
registerSealedCommands(program);
registerManageCommands(program);

program.parse();
