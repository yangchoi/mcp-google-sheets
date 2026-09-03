/**
 * Exercises the real Google Sheets API. Skipped unless both a credential store
 * and a throwaway spreadsheet are provided:
 *
 *   MCP_TEST_SPREADSHEET_ID=<id> npm test
 *
 * The sheet is written to, so point this at a scratch spreadsheet. Set
 * MCP_TEST_SHEET_NAME if the first tab is not called "Sheet1".
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, writeFile, readFile, stat, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { connect } from "./helpers/mcp-client.mjs";

const SPREADSHEET_ID = process.env.MCP_TEST_SPREADSHEET_ID;
const TAB = process.env.MCP_TEST_SHEET_NAME ?? "Sheet1";
const CONFIG_DIR =
  process.env.MCP_GOOGLE_SHEETS_CONFIG_DIR ??
  join(homedir(), ".config", "mcp-google-sheets");

const hasCredentials =
  existsSync(join(CONFIG_DIR, "credentials.json")) &&
  existsSync(join(CONFIG_DIR, "token.json"));

const skip = !SPREADSHEET_ID
  ? "set MCP_TEST_SPREADSHEET_ID to a scratch spreadsheet"
  : !hasCredentials
    ? `no credentials.json / token.json in ${CONFIG_DIR}`
    : false;

describe("live sheets api", { skip }, () => {
  let client;
  const range = (a1) => `${TAB}!${a1}`;

  before(async () => {
    client = await connect();
  });

  // Without this the child process outlives the suite and the runner hangs.
  after(() => {
    client?.close();
  });

  test("get_spreadsheet_metadata lists tabs", async () => {
    const { isError, json } = await client.call("get_spreadsheet_metadata", {
      spreadsheetId: SPREADSHEET_ID,
    });
    assert.equal(isError, false);
    assert.equal(json.spreadsheetId, SPREADSHEET_ID);
    assert.ok(Array.isArray(json.sheets) && json.sheets.length > 0);
    assert.ok(json.sheets.some((s) => s.title === TAB),
      `expected a tab named "${TAB}"; got ${json.sheets.map((s) => s.title).join(", ")}`);
  });

  test("update_range writes and reports the cells touched", async () => {
    const { isError, json } = await client.call("update_range", {
      spreadsheetId: SPREADSHEET_ID,
      range: range("A1:D1"),
      values: [[1234567, "=A1/2", "2026-09-03", true]],
    });
    assert.equal(isError, false);
    assert.equal(json.updatedCells, 4);
  });

  // Regression: the API default is FORMATTED_VALUE, which returned every
  // number as a locale-formatted string ("1,234,567"), so arithmetic on a
  // read result was silently wrong.
  test("read_range returns typed values by default", async () => {
    const { json } = await client.call("read_range", {
      spreadsheetId: SPREADSHEET_ID,
      range: range("A1:D1"),
    });
    const [number, formulaResult, date, boolean] = json.values[0];
    assert.equal(typeof number, "number");
    assert.equal(number, 1234567);
    assert.equal(typeof formulaResult, "number");
    assert.equal(formulaResult, 617283.5);
    assert.equal(typeof date, "string", "dates stay readable, not serial numbers");
    assert.equal(typeof boolean, "boolean");
  });

  test("FORMATTED_VALUE still returns display strings", async () => {
    const { json } = await client.call("read_range", {
      spreadsheetId: SPREADSHEET_ID,
      range: range("A1:D1"),
      valueRenderOption: "FORMATTED_VALUE",
    });
    assert.ok(json.values[0].every((v) => typeof v === "string"));
  });

  test("FORMULA returns the formula text", async () => {
    const { json } = await client.call("read_range", {
      spreadsheetId: SPREADSHEET_ID,
      range: range("A1:D1"),
      valueRenderOption: "FORMULA",
    });
    assert.equal(json.values[0][1], "=A1/2");
  });

  test("SERIAL_NUMBER returns dates as numbers", async () => {
    const { json } = await client.call("read_range", {
      spreadsheetId: SPREADSHEET_ID,
      range: range("A1:D1"),
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    assert.equal(typeof json.values[0][2], "number");
  });

  test("append_row adds rows after the last one with data", async () => {
    const { isError, json } = await client.call("append_row", {
      spreadsheetId: SPREADSHEET_ID,
      range: TAB,
      values: [["appended", 1], ["appended", 2]],
    });
    assert.equal(isError, false);
    assert.equal(json.updatedRows, 2);
  });

  test("batch_update_values writes several ranges at once", async () => {
    const { isError, json } = await client.call("batch_update_values", {
      spreadsheetId: SPREADSHEET_ID,
      data: [
        { range: range("F1"), values: [["x"]] },
        { range: range("G1"), values: [["y"]] },
      ],
    });
    assert.equal(isError, false);
    assert.equal(json.totalUpdatedCells, 2);
  });

  test("clear_range empties cells", async () => {
    const { isError, json } = await client.call("clear_range", {
      spreadsheetId: SPREADSHEET_ID,
      range: range("F1:G1"),
    });
    assert.equal(isError, false);
    assert.match(json.clearedRange, /F1:G1/);
  });

  describe("error paths return isError instead of crashing", () => {
    test("unknown spreadsheet", async () => {
      const { isError, text } = await client.call("read_range", {
        spreadsheetId: "NOPE_NOT_A_SPREADSHEET",
        range: "A1",
      });
      assert.equal(isError, true);
      assert.match(text, /not found/i);
    });

    test("unknown tab", async () => {
      const { isError, text } = await client.call("read_range", {
        spreadsheetId: SPREADSHEET_ID,
        range: "NoSuchTab!A1",
      });
      assert.equal(isError, true);
      assert.match(text, /Unable to parse range/);
    });

    test("missing required argument", async () => {
      const { isError, text } = await client.call("read_range", {
        spreadsheetId: SPREADSHEET_ID,
      });
      assert.equal(isError, true);
      assert.match(text, /range/);
    });

    test("the server survives all of them", () => {
      assert.equal(client.alive(), true);
    });
  });
});

// Regression: the refresh token was written world-readable.
describe("token file permissions", { skip }, () => {
  test("a refreshed token is tightened to 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-sheets-perms-"));
    try {
      await copyFile(join(CONFIG_DIR, "credentials.json"), join(dir, "credentials.json"));
      const token = JSON.parse(await readFile(join(CONFIG_DIR, "token.json"), "utf8"));
      // Force the client to refresh on the first call, which triggers a write.
      token.expiry_date = 1;
      const tokenPath = join(dir, "token.json");
      await writeFile(tokenPath, JSON.stringify(token));
      // Start from the old, permissive mode to prove it gets tightened.
      await chmod(tokenPath, 0o644);

      const client = await connect({ MCP_GOOGLE_SHEETS_CONFIG_DIR: dir });
      const { isError } = await client.call("get_spreadsheet_metadata", {
        spreadsheetId: SPREADSHEET_ID,
      });
      assert.equal(isError, false);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      client.close();

      const mode = (await stat(tokenPath)).mode & 0o777;
      assert.equal(mode.toString(8), "600");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
