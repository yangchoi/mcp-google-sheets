import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { run, connect, AUTH_CLI } from "./helpers/mcp-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A config dir with no credentials and no token. */
let emptyDir;
/** A config dir with a syntactically valid but fake OAuth client. */
let fakeCredsDir;

before(async () => {
  emptyDir = await mkdtemp(join(tmpdir(), "mcp-sheets-empty-"));
  fakeCredsDir = await mkdtemp(join(tmpdir(), "mcp-sheets-fake-"));
  await writeFile(
    join(fakeCredsDir, "credentials.json"),
    JSON.stringify({
      installed: {
        client_id: "test-client-id.apps.googleusercontent.com",
        client_secret: "test-secret",
      },
    })
  );
});

after(async () => {
  await rm(emptyDir, { recursive: true, force: true });
  await rm(fakeCredsDir, { recursive: true, force: true });
});

describe("command line", () => {
  test("--help prints usage and exits 0", async () => {
    const { code, stdout } = await run(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /mcp-google-sheets auth/);
  });

  test("an unknown command exits 1 with usage", async () => {
    const { code, stderr } = await run(["bogus"]);
    assert.equal(code, 1);
    assert.match(stderr, /Unknown command: bogus/);
    assert.match(stderr, /Usage:/);
  });

  // Regression: `bin` used to map only the server entrypoint and argv was
  // ignored, so the documented `auth` command silently started the stdio
  // server and looked like a hang.
  test("`auth` runs the auth flow, not the server", async () => {
    const { code, stderr } = await run(["auth"], {
      MCP_GOOGLE_SHEETS_CONFIG_DIR: emptyDir,
    });
    assert.equal(code, 1, "should fail on the missing credentials file");
    assert.doesNotMatch(stderr, /running on stdio/);
    assert.match(stderr, /credentials\.json not found/);
  });

  test("no arguments starts the stdio server", async () => {
    const client = await connect({ MCP_GOOGLE_SHEETS_CONFIG_DIR: emptyDir });
    try {
      assert.match(client.stderr(), /running on stdio/);
    } finally {
      client.close();
    }
  });
});

describe("oauth callback port", () => {
  // Regression: the browser was opened before the callback port was bound, so
  // a clash produced a consent screen redirecting to nothing plus a raw
  // unhandled-'error' stack trace.
  test("a busy port fails with an explanation and no stack trace", async () => {
    const blocker = createServer(() => {});
    await new Promise((resolve) => blocker.listen(47319, resolve));
    try {
      const result = await new Promise((resolve) => {
        const child = spawn("node", [AUTH_CLI], {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            MCP_GOOGLE_SHEETS_CONFIG_DIR: fakeCredsDir,
          },
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => {
          child.kill();
          resolve({ code: null, stderr, timedOut: true });
        }, 15000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, stderr, timedOut: false });
        });
      });

      assert.equal(result.timedOut, false, "should not hang");
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Port 47319 is already in use/);
      assert.match(result.stderr, /lsof -i :47319/);
      assert.doesNotMatch(result.stderr, /at Server\./, "no stack trace");
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe("tool surface", () => {
  test("all six tools are advertised", async () => {
    const client = await connect({ MCP_GOOGLE_SHEETS_CONFIG_DIR: emptyDir });
    try {
      const names = (await client.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, [
        "append_row",
        "batch_update_values",
        "clear_range",
        "get_spreadsheet_metadata",
        "read_range",
        "update_range",
      ]);
    } finally {
      client.close();
    }
  });

  test("read_range exposes the value rendering options", async () => {
    const client = await connect({ MCP_GOOGLE_SHEETS_CONFIG_DIR: emptyDir });
    try {
      const readRange = (await client.listTools()).find(
        (t) => t.name === "read_range"
      );
      const props = readRange.inputSchema.properties;
      assert.deepEqual(props.valueRenderOption.enum, [
        "UNFORMATTED_VALUE",
        "FORMATTED_VALUE",
        "FORMULA",
      ]);
      assert.deepEqual(props.dateTimeRenderOption.enum, [
        "FORMATTED_STRING",
        "SERIAL_NUMBER",
      ]);
      assert.deepEqual(readRange.inputSchema.required, [
        "spreadsheetId",
        "range",
      ]);
    } finally {
      client.close();
    }
  });

  // Regression: the version was hardcoded here as well as in package.json,
  // so a release that bumped one left the other behind.
  test("the advertised version matches package.json", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const client = await connect({ MCP_GOOGLE_SHEETS_CONFIG_DIR: emptyDir });
    try {
      const { result } = await client.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "version-check", version: "0" },
      });
      assert.equal(result.serverInfo.version, pkg.version);
    } finally {
      client.close();
    }
  });

  // A type array is legal JSON Schema but several MCP clients validate tool
  // schemas with tooling that rejects it; anyOf says the same thing portably.
  test("no schema uses a JSON Schema type array", async () => {
    const client = await connect({ MCP_GOOGLE_SHEETS_CONFIG_DIR: emptyDir });
    try {
      const tools = await client.listTools();
      const typeArrays = [];
      const walk = (node, path) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node.type)) typeArrays.push(path);
        for (const [key, value] of Object.entries(node)) {
          if (value && typeof value === "object") walk(value, `${path}.${key}`);
        }
      };
      for (const tool of tools) walk(tool.inputSchema, tool.name);
      assert.deepEqual(typeArrays, []);

      const cell = tools.find((t) => t.name === "update_range")
        .inputSchema.properties.values.items.items;
      assert.deepEqual(
        cell.anyOf.map((entry) => entry.type),
        ["string", "number", "boolean", "null"]
      );
    } finally {
      client.close();
    }
  });

  test("a call without a stored token explains how to authorize", async () => {
    const client = await connect({
      MCP_GOOGLE_SHEETS_CONFIG_DIR: fakeCredsDir,
    });
    try {
      const result = await client.call("read_range", {
        spreadsheetId: "whatever",
        range: "A1",
      });
      assert.equal(result.isError, true, "must be a tool error, not a protocol error");
      assert.match(result.text, /No stored token/);
      assert.match(result.text, /auth/);
      assert.equal(
        client.alive(),
        true,
        "a failed call must not kill the server"
      );
    } finally {
      client.close();
    }
  });

  // The client is cached, so a failure must not be cached with it: a token
  // written by an `auth` run in another terminal has to be picked up without
  // restarting the server.
  test("a credentials failure is not cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-sheets-recover-"));
    try {
      await writeFile(
        join(dir, "credentials.json"),
        JSON.stringify({
          installed: { client_id: "test-id", client_secret: "test-secret" },
        })
      );
      const client = await connect({ MCP_GOOGLE_SHEETS_CONFIG_DIR: dir });
      try {
        const first = await client.call("get_spreadsheet_metadata", {
          spreadsheetId: "abc",
        });
        assert.match(first.text, /No stored token/);

        // Stand in for the user running `auth` in another terminal.
        await writeFile(
          join(dir, "token.json"),
          JSON.stringify({ refresh_token: "appeared-later", expiry_date: 1 })
        );

        const second = await client.call("get_spreadsheet_metadata", {
          spreadsheetId: "abc",
        });
        assert.doesNotMatch(
          second.text,
          /No stored token/,
          "the token file should be re-read after a credentials failure"
        );
      } finally {
        client.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // An unknown tool is rejected before authorizing, so it reports the real
  // problem instead of an unrelated credentials error.
  test("an unknown tool is an error, not a crash", async () => {
    const client = await connect({ MCP_GOOGLE_SHEETS_CONFIG_DIR: emptyDir });
    try {
      const result = await client.call("no_such_tool", {});
      assert.equal(result.isError, true);
      assert.match(result.text, /Unknown tool: no_such_tool/);
      assert.doesNotMatch(result.text, /credentials/);
      assert.equal(client.alive(), true);
    } finally {
      client.close();
    }
  });
});
