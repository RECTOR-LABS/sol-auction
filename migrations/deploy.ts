// Migrations are an early feature. Currently, they're nothing more than this
// temporary script that wraps some Anchor commands.

const anchor = require("@coral-xyz/anchor");

module.exports = async function (provider) {
  anchor.setProvider(provider);
};
