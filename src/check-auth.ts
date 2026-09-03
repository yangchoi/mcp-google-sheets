#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readTokenStatus, TESTING_MODE_LIFETIME_DAYS } from "./auth.js";

/**
 * Exit codes are meant for scripting:
 *   0  the token is fine
 *   1  it expires soon, reauthorize when convenient
 *   2  it is already unusable, reauthorize now
 */
const WARN_WITHIN_DAYS = 1.5;

function formatDays(days: number): string {
  return `${days.toFixed(1)} day${Math.abs(days - 1) < 0.05 ? "" : "s"}`;
}

export async function checkAuth(): Promise<number> {
  const status = await readTokenStatus();

  switch (status.state) {
    case "missing":
      console.log(`No token at ${status.tokenPath}.`);
      console.log("Run `npm run auth` to authorize.");
      return 2;

    case "unusable":
      console.log(`Cannot refresh: ${status.reason} (${status.tokenPath}).`);
      console.log("Run `npm run auth` to authorize.");
      return 2;

    case "unknown-age":
      console.log(`Token found at ${status.tokenPath}.`);
      console.log(
        "It predates consent-time tracking, so its remaining lifetime is unknown. " +
          "The next authorization will record it."
      );
      return 0;

    case "known": {
      // Local time: the reader is comparing this against their own clock.
      const pad = (value: number) => String(value).padStart(2, "0");
      const at = status.authorizedAt;
      const consented =
        `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
        `${pad(at.getHours())}:${pad(at.getMinutes())}`;
      console.log(`Last authorized: ${consented}`);

      if (status.daysLeft <= 0) {
        console.log(
          `Already past the ${TESTING_MODE_LIFETIME_DAYS}-day limit that applies while ` +
            `the OAuth app is in "Testing" mode. Run \`npm run auth\`.`
        );
        return 2;
      }

      console.log(
        `${formatDays(status.daysLeft)} left, if the OAuth app is still in "Testing" ` +
          `mode (published apps do not expire on this schedule).`
      );

      if (status.daysLeft <= WARN_WITHIN_DAYS) {
        console.log("Expiring soon — reauthorize with `npm run auth`.");
        return 1;
      }
      return 0;
    }
  }
}

// Also reachable as `mcp-google-sheets check-auth`; only self-execute when this
// file is the entry point, so the subcommand does not run it twice.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkAuth()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    });
}
