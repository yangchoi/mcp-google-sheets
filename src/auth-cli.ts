#!/usr/bin/env node
import { getAuthorizedClient } from "./auth.js";

async function main() {
  await getAuthorizedClient({ interactive: true });
  console.error("Authorization complete. Token saved.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
