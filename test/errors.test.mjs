import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { explain } = await import(
  join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "errors.js")
);

describe("explain", () => {
  test("passes unrelated messages through untouched", () => {
    assert.equal(explain("Unable to parse range: A1"), "Unable to parse range: A1");
    assert.equal(explain("Requested entity was not found.", "auth"),
      "Requested entity was not found.");
  });

  // The same code means different things in the two places it surfaces, and
  // "re-run auth" is useless advice when auth is what just failed.
  test("blames the refresh token during a tool call", () => {
    const out = explain("invalid_grant", "tool");
    assert.match(out, /stored refresh token is no longer valid/);
    assert.match(out, /npx @heyyang\/mcp-google-sheets auth/);
    assert.match(out, /Testing" mode/);
  });

  test("blames the authorization code during auth", () => {
    const out = explain("invalid_grant", "auth");
    assert.match(out, /rejected the authorization code/);
    assert.doesNotMatch(out, /stored refresh token/);
  });

  test("defaults to the tool-call explanation", () => {
    assert.equal(explain("invalid_grant"), explain("invalid_grant", "tool"));
  });

  test("keeps the original message at the top", () => {
    assert.ok(explain("Error: invalid_grant here", "auth").startsWith("Error: invalid_grant here"));
  });
});
