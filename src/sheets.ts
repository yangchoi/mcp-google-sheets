import { google, sheets_v4 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export function makeSheetsClient(auth: OAuth2Client): sheets_v4.Sheets {
  return google.sheets({ version: "v4", auth });
}

export type ValueInputOption = "RAW" | "USER_ENTERED";

/**
 * A single cell being written. null is accepted by the API and leaves the
 * existing cell untouched, which is not the same as writing an empty string.
 */
export type Cell = string | number | boolean | null;

export type ValueRenderOption =
  | "FORMATTED_VALUE"
  | "UNFORMATTED_VALUE"
  | "FORMULA";

export type DateTimeRenderOption = "SERIAL_NUMBER" | "FORMATTED_STRING";

export interface ReadRangeParams {
  spreadsheetId: string;
  range: string;
  valueRenderOption?: ValueRenderOption;
  dateTimeRenderOption?: DateTimeRenderOption;
}

export async function readRange(
  sheets: sheets_v4.Sheets,
  params: ReadRangeParams
): Promise<(string | number | boolean)[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: params.spreadsheetId,
    range: params.range,
    // The API defaults to FORMATTED_VALUE, which returns locale-formatted
    // strings: 1234567 comes back as "1,234,567" and every number is a string,
    // so any arithmetic on the result is wrong. UNFORMATTED_VALUE keeps numbers
    // numeric; it also turns dates into serial numbers, which FORMATTED_STRING
    // undoes without re-stringifying the numbers.
    valueRenderOption: params.valueRenderOption ?? "UNFORMATTED_VALUE",
    dateTimeRenderOption: params.dateTimeRenderOption ?? "FORMATTED_STRING",
  });
  return (res.data.values as (string | number | boolean)[][]) ?? [];
}

export interface UpdateRangeParams {
  spreadsheetId: string;
  range: string;
  values: Cell[][];
  valueInputOption?: ValueInputOption;
}

export async function updateRange(
  sheets: sheets_v4.Sheets,
  params: UpdateRangeParams
): Promise<{ updatedRange: string; updatedCells: number }> {
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId: params.spreadsheetId,
    range: params.range,
    valueInputOption: params.valueInputOption ?? "USER_ENTERED",
    requestBody: { values: params.values },
  });
  return {
    updatedRange: res.data.updatedRange ?? params.range,
    updatedCells: res.data.updatedCells ?? 0,
  };
}

export interface AppendRowParams {
  spreadsheetId: string;
  range: string;
  values: Cell[][];
  valueInputOption?: ValueInputOption;
  insertDataOption?: "OVERWRITE" | "INSERT_ROWS";
}

export async function appendRow(
  sheets: sheets_v4.Sheets,
  params: AppendRowParams
): Promise<{ updatedRange: string; updatedRows: number }> {
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: params.spreadsheetId,
    range: params.range,
    valueInputOption: params.valueInputOption ?? "USER_ENTERED",
    insertDataOption: params.insertDataOption ?? "INSERT_ROWS",
    requestBody: { values: params.values },
  });
  return {
    updatedRange: res.data.updates?.updatedRange ?? params.range,
    updatedRows: res.data.updates?.updatedRows ?? 0,
  };
}

export interface ClearRangeParams {
  spreadsheetId: string;
  range: string;
}

export async function clearRange(
  sheets: sheets_v4.Sheets,
  params: ClearRangeParams
): Promise<{ clearedRange: string }> {
  const res = await sheets.spreadsheets.values.clear({
    spreadsheetId: params.spreadsheetId,
    range: params.range,
  });
  return { clearedRange: res.data.clearedRange ?? params.range };
}

export interface SheetMetadata {
  spreadsheetId: string;
  title: string;
  sheets: {
    sheetId: number;
    title: string;
    rowCount: number;
    columnCount: number;
  }[];
}

export async function getSpreadsheetMetadata(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string
): Promise<SheetMetadata> {
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  return {
    spreadsheetId,
    title: res.data.properties?.title ?? "",
    sheets: (res.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title: s.properties?.title ?? "",
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    })),
  };
}

export interface BatchUpdateParams {
  spreadsheetId: string;
  data: {
    range: string;
    values: Cell[][];
  }[];
  valueInputOption?: ValueInputOption;
}

export async function batchUpdateValues(
  sheets: sheets_v4.Sheets,
  params: BatchUpdateParams
): Promise<{ totalUpdatedCells: number }> {
  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: params.spreadsheetId,
    requestBody: {
      valueInputOption: params.valueInputOption ?? "USER_ENTERED",
      data: params.data,
    },
  });
  return { totalUpdatedCells: res.data.totalUpdatedCells ?? 0 };
}
