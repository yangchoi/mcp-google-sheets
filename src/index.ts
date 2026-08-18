#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAuthorizedClient } from "./auth.js";
import {
  makeSheetsClient,
  readRange,
  updateRange,
  appendRow,
  clearRange,
  getSpreadsheetMetadata,
  batchUpdateValues,
} from "./sheets.js";

const server = new Server(
  { name: "mcp-google-sheets", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

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
      "Read cell values from a range in a Google Sheets spreadsheet. Returns a 2D array of values. Empty trailing rows/columns are omitted.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID." },
        range: {
          type: "string",
          description:
            "A1 notation range (e.g., 'Sheet1!A1:D10' or 'Sheet1' for the whole sheet).",
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
          items: {
            type: "array",
            items: { type: ["string", "number", "boolean"] },
          },
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
          items: {
            type: "array",
            items: { type: ["string", "number", "boolean"] },
          },
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
              values: {
                type: "array",
                items: {
                  type: "array",
                  items: { type: ["string", "number", "boolean"] },
                },
              },
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const auth = await getAuthorizedClient();
  const sheets = makeSheetsClient(auth);
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (request.params.name) {
      case "get_spreadsheet_metadata": {
        const result = await getSpreadsheetMetadata(
          sheets,
          args.spreadsheetId as string
        );
        return textReply(result);
      }
      case "read_range": {
        const result = await readRange(sheets, {
          spreadsheetId: args.spreadsheetId as string,
          range: args.range as string,
        });
        return textReply({
          range: args.range,
          rowCount: result.length,
          values: result,
        });
      }
      case "update_range": {
        const result = await updateRange(sheets, {
          spreadsheetId: args.spreadsheetId as string,
          range: args.range as string,
          values: args.values as (string | number | boolean)[][],
          valueInputOption: args.valueInputOption as
            | "RAW"
            | "USER_ENTERED"
            | undefined,
        });
        return textReply(result);
      }
      case "append_row": {
        const result = await appendRow(sheets, {
          spreadsheetId: args.spreadsheetId as string,
          range: args.range as string,
          values: args.values as (string | number | boolean)[][],
          valueInputOption: args.valueInputOption as
            | "RAW"
            | "USER_ENTERED"
            | undefined,
          insertDataOption: args.insertDataOption as
            | "OVERWRITE"
            | "INSERT_ROWS"
            | undefined,
        });
        return textReply(result);
      }
      case "clear_range": {
        const result = await clearRange(sheets, {
          spreadsheetId: args.spreadsheetId as string,
          range: args.range as string,
        });
        return textReply(result);
      }
      case "batch_update_values": {
        const result = await batchUpdateValues(sheets, {
          spreadsheetId: args.spreadsheetId as string,
          data: args.data as {
            range: string;
            values: (string | number | boolean)[][];
          }[],
          valueInputOption: args.valueInputOption as
            | "RAW"
            | "USER_ENTERED"
            | undefined,
        });
        return textReply(result);
      }
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-google-sheets server running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
