#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { getAuthorizedClient, resetAuthorizedClient } from "./auth.js";
import { explain } from "./errors.js";
import {
  requiredString,
  optionalEnum,
  requiredGrid,
  requiredRangeValues,
} from "./validate.js";
import {
  makeSheetsClient,
  readRange,
  updateRange,
  appendRow,
  clearRange,
  getSpreadsheetMetadata,
  batchUpdateValues,
} from "./sheets.js";

// Read the version rather than repeating it: a second copy here drifts from
// package.json on the first release where someone bumps only one of them.
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const server = new Server(
  { name: "mcp-google-sheets", version },
  { capabilities: { tools: {} } }
);

const VALUE_INPUT_OPTIONS = ["RAW", "USER_ENTERED"] as const;
const INSERT_DATA_OPTIONS = ["OVERWRITE", "INSERT_ROWS"] as const;
const VALUE_RENDER_OPTIONS = [
  "UNFORMATTED_VALUE",
  "FORMATTED_VALUE",
  "FORMULA",
] as const;
const DATE_TIME_RENDER_OPTIONS = ["FORMATTED_STRING", "SERIAL_NUMBER"] as const;

// A type array ("type": ["string", "number", ...]) is valid JSON Schema, but
// several MCP clients validate tool schemas with tooling that rejects it.
// anyOf expresses the same union and is accepted everywhere.
const CELL_SCHEMA = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
  description: "A cell value. null leaves the existing cell untouched.",
} as const;

const ROW_SCHEMA = { type: "array", items: CELL_SCHEMA } as const;

const TOOLS = [
  {
    name: "get_spreadsheet_metadata",
    description:
      "Get metadata about a Google Sheets spreadsheet: title and all sheet tabs with their row/column counts. Call this first to discover sheet names before reading or writing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: {
          type: "string",
          description:
            "The ID of the spreadsheet (found in the URL between /d/ and /edit).",
        },
      },
      required: ["spreadsheetId"],
    },
  },
  {
    name: "read_range",
    description:
      "Read cell values from a range in a Google Sheets spreadsheet. Returns a 2D array of values. Empty trailing rows/columns are omitted, so rows may be ragged. Numbers come back as numbers and dates as readable strings by default.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID." },
        range: {
          type: "string",
          description:
            "A1 notation range (e.g., 'Sheet1!A1:D10' or 'Sheet1' for the whole sheet).",
        },
        valueRenderOption: {
          type: "string",
          enum: ["UNFORMATTED_VALUE", "FORMATTED_VALUE", "FORMULA"],
          description:
            "UNFORMATTED_VALUE (default) returns raw typed values — use this for any calculation. FORMATTED_VALUE returns what the cell displays, as strings ('1,234,567', '$5.00'). FORMULA returns the formula text instead of its result.",
        },
        dateTimeRenderOption: {
          type: "string",
          enum: ["FORMATTED_STRING", "SERIAL_NUMBER"],
          description:
            "Only applies with UNFORMATTED_VALUE. FORMATTED_STRING (default) renders dates as readable text; SERIAL_NUMBER returns the underlying Sheets date serial for date arithmetic.",
        },
      },
      required: ["spreadsheetId", "range"],
    },
  },
  {
    name: "update_range",
    description:
      "Overwrite cell values in a specific range. Use this to edit existing cells. Values are parsed like user input by default (USER_ENTERED) — formulas, dates, and numbers are interpreted.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID." },
        range: {
          type: "string",
          description: "A1 notation range (e.g., 'Sheet1!A1:C3').",
        },
        values: {
          type: "array",
          description:
            "2D array of values. Outer array = rows, inner arrays = cells in that row.",
          items: ROW_SCHEMA,
        },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description:
            "How values are interpreted. RAW = stored as-is. USER_ENTERED = parsed like keyboard input (default).",
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  {
    name: "append_row",
    description:
      "Append one or more rows after the last row with data in a sheet. Ideal for logging, adding entries, tracking events.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID." },
        range: {
          type: "string",
          description:
            "A1 notation of the table range or a sheet name (e.g., 'Sheet1' or 'Sheet1!A:F').",
        },
        values: {
          type: "array",
          description: "2D array of rows to append.",
          items: ROW_SCHEMA,
        },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description: "How values are interpreted (default: USER_ENTERED).",
        },
        insertDataOption: {
          type: "string",
          enum: ["OVERWRITE", "INSERT_ROWS"],
          description:
            "OVERWRITE writes into existing rows; INSERT_ROWS shifts existing rows down (default).",
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  {
    name: "clear_range",
    description:
      "Clear all values in a range without deleting formatting or the cells themselves.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID." },
        range: { type: "string", description: "A1 notation range to clear." },
      },
      required: ["spreadsheetId", "range"],
    },
  },
  {
    name: "batch_update_values",
    description:
      "Update multiple ranges in a single request. More efficient than multiple update_range calls when writing to disparate ranges.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID." },
        data: {
          type: "array",
          description:
            "Array of {range, values} objects. Each entry writes its 2D values array to the specified A1 range.",
          items: {
            type: "object",
            properties: {
              range: { type: "string" },
              values: { type: "array", items: ROW_SCHEMA },
            },
            required: ["range", "values"],
          },
        },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description: "Applied to all ranges (default: USER_ENTERED).",
        },
      },
      required: ["spreadsheetId", "data"],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

type Sheets = ReturnType<typeof makeSheetsClient>;

/**
 * Each entry validates its arguments and returns a closure that performs the
 * call. Splitting it this way keeps argument checking ahead of authorization:
 * a malformed call should say what is wrong with it rather than demanding
 * credentials first, and it should never trigger an OAuth refresh for a
 * request that cannot succeed anyway.
 */
const HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => (sheets: Sheets) => Promise<unknown>
> = {
  get_spreadsheet_metadata: (args) => {
    const tool = "get_spreadsheet_metadata";
    const spreadsheetId = requiredString(tool, args, "spreadsheetId");
    return (sheets) => getSpreadsheetMetadata(sheets, spreadsheetId);
  },

  read_range: (args) => {
    const tool = "read_range";
    const params = {
      spreadsheetId: requiredString(tool, args, "spreadsheetId"),
      range: requiredString(tool, args, "range"),
      valueRenderOption: optionalEnum(tool, args, "valueRenderOption", VALUE_RENDER_OPTIONS),
      dateTimeRenderOption: optionalEnum(
        tool,
        args,
        "dateTimeRenderOption",
        DATE_TIME_RENDER_OPTIONS
      ),
    };
    return async (sheets) => {
      const values = await readRange(sheets, params);
      return { range: params.range, rowCount: values.length, values };
    };
  },

  update_range: (args) => {
    const tool = "update_range";
    const params = {
      spreadsheetId: requiredString(tool, args, "spreadsheetId"),
      range: requiredString(tool, args, "range"),
      values: requiredGrid(tool, args, "values"),
      valueInputOption: optionalEnum(tool, args, "valueInputOption", VALUE_INPUT_OPTIONS),
    };
    return (sheets) => updateRange(sheets, params);
  },

  append_row: (args) => {
    const tool = "append_row";
    const params = {
      spreadsheetId: requiredString(tool, args, "spreadsheetId"),
      range: requiredString(tool, args, "range"),
      values: requiredGrid(tool, args, "values"),
      valueInputOption: optionalEnum(tool, args, "valueInputOption", VALUE_INPUT_OPTIONS),
      insertDataOption: optionalEnum(tool, args, "insertDataOption", INSERT_DATA_OPTIONS),
    };
    return (sheets) => appendRow(sheets, params);
  },

  clear_range: (args) => {
    const tool = "clear_range";
    const params = {
      spreadsheetId: requiredString(tool, args, "spreadsheetId"),
      range: requiredString(tool, args, "range"),
    };
    return (sheets) => clearRange(sheets, params);
  },

  batch_update_values: (args) => {
    const tool = "batch_update_values";
    const params = {
      spreadsheetId: requiredString(tool, args, "spreadsheetId"),
      data: requiredRangeValues(tool, args, "data"),
      valueInputOption: optionalEnum(tool, args, "valueInputOption", VALUE_INPUT_OPTIONS),
    };
    return (sheets) => batchUpdateValues(sheets, params);
  },
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const tool = request.params.name;

  try {
    const prepare = HANDLERS[tool];
    if (!prepare) {
      throw new Error(`Unknown tool: ${tool}`);
    }

    // Validation first: no credentials needed to tell someone their range is
    // missing, and no point refreshing a token for a call that cannot run.
    const execute = prepare(args);

    // Authorizing inside the try matters. Outside it, a missing or dead token
    // escaped the handler and came back as a JSON-RPC protocol error, so the
    // guidance in explain() never reached the caller and the failure looked
    // nothing like every other error this server returns.
    const auth = await getAuthorizedClient();

    return textReply(await execute(makeSheetsClient(auth)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A credentials failure sticks to the cached client, so drop it. The next
    // call then picks up a token written by an `auth` run in another terminal
    // instead of failing until the server is restarted.
    if (/invalid_grant|No stored token|credentials\.json/i.test(message)) {
      resetAuthorizedClient();
    }
    return {
      content: [{ type: "text" as const, text: `Error: ${explain(message)}` }],
      isError: true,
    };
  }
});

function textReply(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

const USAGE = `Usage:
  mcp-google-sheets              Run the MCP server on stdio (default)
  mcp-google-sheets auth         Run the OAuth consent flow and store a token
  mcp-google-sheets check-auth   Report how much of the token's lifetime is left
  mcp-google-sheets --help       Show this message`;

async function main() {
  const [subcommand] = process.argv.slice(2);

  // The README and the invalid_grant hint both tell users to run `auth`, so the
  // binary has to answer to it. Without this branch every argument was ignored
  // and `... auth` silently started the stdio server, which looks like a hang.
  if (subcommand === "auth") {
    await getAuthorizedClient({ interactive: true });
    console.error("Authorization complete. Token saved.");
    return;
  }

  if (subcommand === "check-auth") {
    const { checkAuth } = await import("./check-auth.js");
    process.exit(await checkAuth());
  }

  if (subcommand === "--help" || subcommand === "-h") {
    console.log(USAGE);
    return;
  }

  if (subcommand !== undefined && subcommand !== "serve") {
    console.error(`Unknown command: ${subcommand}\n\n${USAGE}`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-google-sheets server running on stdio");
}

main().catch((err) => {
  // Startup and auth failures are explained in the thrown message (missing
  // credentials, a busy callback port). A stack trace on top of that is noise.
  const message = err instanceof Error ? err.message : String(err);
  const context = process.argv[2] === "auth" ? "auth" : "tool";
  console.error(explain(message, context));
  process.exit(1);
});
