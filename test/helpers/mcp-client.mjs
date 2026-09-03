import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SERVER = join(ROOT, "dist", "index.js");
export const AUTH_CLI = join(ROOT, "dist", "auth-cli.js");

/** Run the binary to completion and collect its output. */
export function run(args = [], env = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn("node", [SERVER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/**
 * A minimal MCP stdio client. The point of testing through the wire protocol
 * rather than importing the handlers is that packaging mistakes — a bad bin
 * entry, argv that never reaches the dispatcher — only show up out here.
 */
export async function connect(env = {}) {
  const child = spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  let buffer = "";
  let stderr = "";
  const pending = new Map();
  let exitCode;
  child.on("exit", (code) => (exitCode = code));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  let nextId = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, resolve);
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}`)),
        15000
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });

  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }) + "\n"
  );

  return {
    send,
    listTools: async () => (await send("tools/list", {})).result.tools,
    /** Returns { isError, text, json } so tests can assert on either shape. */
    call: async (name, args) => {
      const response = await send("tools/call", { name, arguments: args });
      const text = response.result.content[0].text;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: Boolean(response.result.isError), text, json };
    },
    stderr: () => stderr,
    alive: () => exitCode === undefined,
    close: () => child.kill(),
  };
}
