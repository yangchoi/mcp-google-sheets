/**
 * Hand-rolled argument checks. The MCP client is a language model, so bad
 * arguments are a routine occurrence rather than a programmer error, and the
 * raw API response for one ("Invalid value at 'data.values'
 * (type.googleapis.com/google.protobuf.ListValue)") does not say which
 * argument was wrong or what it should have been.
 */

import type { Cell } from "./sheets.js";

export type { Cell };

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
}

function fail(tool: string, message: string): never {
  throw new Error(`${tool}: ${message}`);
}

export function requiredString(
  tool: string,
  args: Record<string, unknown>,
  name: string
): string {
  const value = args[name];
  if (value === undefined) {
    fail(tool, `"${name}" is required.`);
  }
  if (typeof value !== "string" || value.length === 0) {
    fail(tool, `"${name}" must be a non-empty string, got ${describe(value)}.`);
  }
  return value;
}

export function optionalEnum<T extends string>(
  tool: string,
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[]
): T | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(
      tool,
      `"${name}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}.`
    );
  }
  return value as T;
}

function checkRow(tool: string, row: unknown, where: string): Cell[] {
  if (!Array.isArray(row)) {
    fail(tool, `${where} must be an array of cells, got ${describe(row)}.`);
  }
  row.forEach((cell, index) => {
    const type = typeof cell;
    if (cell !== null && type !== "string" && type !== "number" && type !== "boolean") {
      fail(
        tool,
        `${where}[${index}] must be a string, number, boolean, or null, got ${describe(cell)}.`
      );
    }
  });
  return row as Cell[];
}

/** A 2D array: outer entries are rows, inner entries are cells in that row. */
export function requiredGrid(
  tool: string,
  args: Record<string, unknown>,
  name: string
): Cell[][] {
  const value = args[name];
  if (value === undefined) {
    fail(tool, `"${name}" is required.`);
  }
  if (!Array.isArray(value)) {
    fail(
      tool,
      `"${name}" must be a 2D array of rows, got ${describe(value)}. ` +
        `A single row still needs to be wrapped: [["a", "b"]].`
    );
  }
  if (value.length === 0) {
    fail(tool, `"${name}" must contain at least one row.`);
  }
  return value.map((row, index) => checkRow(tool, row, `"${name}"[${index}]`));
}

export interface RangeValues {
  range: string;
  values: Cell[][];
}

export function requiredRangeValues(
  tool: string,
  args: Record<string, unknown>,
  name: string
): RangeValues[] {
  const value = args[name];
  if (value === undefined) {
    fail(tool, `"${name}" is required.`);
  }
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      tool,
      `"${name}" must be a non-empty array of {range, values} objects, got ${describe(value)}.`
    );
  }
  return value.map((entry, index) => {
    const where = `"${name}"[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(tool, `${where} must be a {range, values} object, got ${describe(entry)}.`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.range !== "string" || record.range.length === 0) {
      fail(tool, `${where}.range must be a non-empty string.`);
    }
    if (!Array.isArray(record.values) || record.values.length === 0) {
      fail(tool, `${where}.values must contain at least one row.`);
    }
    return {
      range: record.range,
      values: record.values.map((row, rowIndex) =>
        checkRow(tool, row, `${where}.values[${rowIndex}]`)
      ),
    };
  });
}
