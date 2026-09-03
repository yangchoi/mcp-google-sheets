import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_AUTH = join(ROOT, "dist", "check-auth.js");
const SERVER = join(ROOT, "dist", "index.js");
const DAY = 86_400_000;

let configDir;
let describeToken;
let TESTING_MODE_LIFETIME_DAYS;

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "mcp-sheets-checkauth-"));
  // Resolved at module load, so it has to be set before the import.
  process.env.MCP_GOOGLE_SHEETS_CONFIG_DIR = configDir;
  ({ describeToken, TESTING_MODE_LIFETIME_DAYS } = await import(
    join(ROOT, "dist", "auth.js")
  ));
});

after(async () => {
  await rm(configDir, { recursive: true, force: true });
});

/** Run the CLI against a config dir holding exactly this token (or none). */
function runCheck(token, argv = [CHECK_AUTH]) {
  return new Promise((resolve, reject) => {
    const dir = configDir;
    const write =
      token === undefined
        ? rm(join(dir, "token.json"), { force: true })
        : writeFile(join(dir, "token.json"), JSON.stringify(token));
    write.then(() => {
      const child = spawn("node", argv, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MCP_GOOGLE_SHEETS_CONFIG_DIR: dir },
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("exit", (code) => resolve({ code, stdout }));
      child.on("error", reject);
    }, reject);
  });
}

describe("describeToken", () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);

  test("no token file at all", () => {
    assert.equal(describeToken(null, now).state, "missing");
  });

  test("a token with no refresh_token cannot be refreshed", () => {
    const status = describeToken({ access_token: "a" }, now);
    assert.equal(status.state, "unusable");
    assert.match(status.reason, /no refresh_token/);
  });

  test("a token from before consent-time tracking", () => {
    assert.equal(
      describeToken({ refresh_token: "r" }, now).state,
      "unknown-age"
    );
  });

  test("a fresh token has the full window left", () => {
    const status = describeToken({ refresh_token: "r", authorized_at: now }, now);
    assert.equal(status.state, "known");
    assert.equal(status.daysLeft, TESTING_MODE_LIFETIME_DAYS);
    assert.equal(status.authorizedAt.getTime(), now);
  });

  test("the window shrinks with elapsed time", () => {
    const status = describeToken(
      { refresh_token: "r", authorized_at: now - 6 * DAY },
      now
    );
    assert.equal(status.daysLeft, 1);
  });

  test("an expired token reports a negative remainder", () => {
    const status = describeToken(
      { refresh_token: "r", authorized_at: now - 9 * DAY },
      now
    );
    assert.ok(status.daysLeft < 0, `expected a negative remainder, got ${status.daysLeft}`);
  });
});

// The exit codes are the scriptable part of this tool, so pin them.
describe("check-auth exit codes", () => {
  test("0 when there is plenty of time left", async () => {
    const { code, stdout } = await runCheck({
      refresh_token: "r",
      authorized_at: Date.now(),
    });
    assert.equal(code, 0);
    assert.match(stdout, /Last authorized:/);
    assert.match(stdout, /days left/);
  });

  test("1 when it expires soon", async () => {
    const { code, stdout } = await runCheck({
      refresh_token: "r",
      authorized_at: Date.now() - 6.5 * DAY,
    });
    assert.equal(code, 1);
    assert.match(stdout, /Expiring soon/);
  });

  test("2 when it is already past the limit", async () => {
    const { code, stdout } = await runCheck({
      refresh_token: "r",
      authorized_at: Date.now() - 8 * DAY,
    });
    assert.equal(code, 2);
    assert.match(stdout, /Already past the 7-day limit/);
  });

  test("2 when there is no token", async () => {
    const { code, stdout } = await runCheck(undefined);
    assert.equal(code, 2);
    assert.match(stdout, /No token at/);
  });

  test("2 when the token cannot be refreshed", async () => {
    const { code, stdout } = await runCheck({ access_token: "a" });
    assert.equal(code, 2);
    assert.match(stdout, /no refresh_token/);
  });

  // The file ships inside the package, so it has to be reachable without a
  // clone. It must also not run twice when reached through the subcommand.
  test("the check-auth subcommand matches the script", async () => {
    const token = { refresh_token: "r", authorized_at: Date.now() - 8 * DAY };
    const viaScript = await runCheck(token);
    const viaSubcommand = await runCheck(token, [SERVER, "check-auth"]);
    assert.equal(viaSubcommand.code, viaScript.code);
    assert.equal(viaSubcommand.stdout, viaScript.stdout);
    assert.equal(
      (viaSubcommand.stdout.match(/Last authorized:/g) ?? []).length,
      1,
      "the subcommand must not run the script a second time"
    );
  });

  test("never prints the token itself", async () => {
    const secret = "super-secret-refresh-token";
    const { stdout } = await runCheck({
      refresh_token: secret,
      access_token: "also-secret",
      authorized_at: Date.now(),
    });
    assert.doesNotMatch(stdout, new RegExp(secret));
    assert.doesNotMatch(stdout, /also-secret/);
  });
});
