#!/usr/bin/env node
import { getAuthorizedClient } from "./auth.js";
import { explain } from "./errors.js";

async function main() {
  await getAuthorizedClient({ interactive: true });
  console.error("Authorization complete. Token saved.");
}

main().catch((err) => {
  console.error(explain(err instanceof Error ? err.message : String(err), "auth"));
  process.exit(1);
});
