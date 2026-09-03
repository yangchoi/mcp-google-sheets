import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./helpers/mcp-client.mjs";

/**
 * Validation happens before authorization, so these need credentials on disk
 * only to the extent that a *valid* call would get further. Every call here is
 * rejected by the validator first, which is the point.
 */
let configDir;
let client;

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "mcp-sheets-validate-"));
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({
      installed: { client_id: "test-id", client_secret: "test-secret" },
    })
  );
  client = await connect({ MCP_GOOGLE_SHEETS_CONFIG_DIR: configDir });
});

after(async () => {
  client?.close();
  await rm(configDir, { recursive: true, force: true });
});

/** A validation failure must name the argument, never reach the network. */
async function rejects(tool, args, pattern) {
  const result = await client.call(tool, args);
  assert.equal(result.isError, true, `${tool} should have rejected ${JSON.stringify(args)}`);
  assert.match(result.text, pattern);
  assert.doesNotMatch(result.text, /No stored token/,
    "should fail validation before authorizing");
  return result.text;
}

describe("argument validation", () => {
  test("a missing required string is named", async () => {
    await rejects("read_range", { spreadsheetId: "abc" }, /"range" is required/);
    await rejects("read_range", { range: "A1" }, /"spreadsheetId" is required/);
    await rejects("clear_range", {}, /"spreadsheetId" is required/);
  });

  test("a wrong-typed string says what it got", async () => {
    await rejects("read_range", { spreadsheetId: 42, range: "A1" },
      /"spreadsheetId" must be a non-empty string, got a number/);
    await rejects("read_range", { spreadsheetId: "", range: "A1" },
      /"spreadsheetId" must be a non-empty string/);
  });

  test("an out-of-range enum lists the allowed values", async () => {
    await rejects("read_range",
      { spreadsheetId: "abc", range: "A1", valueRenderOption: "PRETTY" },
      /"valueRenderOption" must be one of UNFORMATTED_VALUE, FORMATTED_VALUE, FORMULA/);
    await rejects("update_range",
      { spreadsheetId: "abc", range: "A1", values: [["x"]], valueInputOption: "raw" },
      /"valueInputOption" must be one of RAW, USER_ENTERED/);
  });

  // Regression: this used to reach Google and come back as "Invalid value at
  // 'data.values' (type.googleapis.com/google.protobuf.ListValue)".
  test("a non-2D values argument explains the shape", async () => {
    const text = await rejects("update_range",
      { spreadsheetId: "abc", range: "A1", values: "oops" },
      /"values" must be a 2D array of rows, got a string/);
    assert.match(text, /A single row still needs to be wrapped/);
  });

  test("a flat array is caught row by row", async () => {
    await rejects("update_range",
      { spreadsheetId: "abc", range: "A1", values: ["a", "b"] },
      /"values"\[0\] must be an array of cells, got a string/);
  });

  test("an unsupported cell type is located precisely", async () => {
    await rejects("update_range",
      { spreadsheetId: "abc", range: "A1", values: [["ok", { nested: true }]] },
      /"values"\[0\]\[1\] must be a string, number, boolean, or null, got an object/);
  });

  test("null is a legal cell", async () => {
    // Reaches authorization, which means validation let it through.
    const result = await client.call("update_range", {
      spreadsheetId: "abc",
      range: "A1",
      values: [[null, "x"]],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /No stored token/);
  });

  test("an empty grid is rejected", async () => {
    await rejects("update_range", { spreadsheetId: "abc", range: "A1", values: [] },
      /"values" must contain at least one row/);
  });

  test("batch_update_values checks each entry", async () => {
    await rejects("batch_update_values", { spreadsheetId: "abc", data: [] },
      /"data" must be a non-empty array/);
    await rejects("batch_update_values", { spreadsheetId: "abc", data: ["nope"] },
      /"data"\[0\] must be a \{range, values\} object, got a string/);
    await rejects("batch_update_values",
      { spreadsheetId: "abc", data: [{ range: "A1" }] },
      /"data"\[0\]\.values must contain at least one row/);
    await rejects("batch_update_values",
      { spreadsheetId: "abc", data: [{ range: "", values: [["x"]] }] },
      /"data"\[0\]\.range must be a non-empty string/);
  });

  test("the server survives every rejection", () => {
    assert.equal(client.alive(), true);
  });
});
