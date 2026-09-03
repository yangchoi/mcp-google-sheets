import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import { OAuth2Client } from "google-auth-library";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, chmod, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import open from "open";

const CONFIG_DIR =
  process.env.MCP_GOOGLE_SHEETS_CONFIG_DIR ??
  join(homedir(), ".config", "mcp-google-sheets");

const CREDENTIALS_PATH =
  process.env.GOOGLE_SHEETS_CREDENTIALS_PATH ??
  join(CONFIG_DIR, "credentials.json");

const TOKEN_PATH =
  process.env.GOOGLE_SHEETS_TOKEN_PATH ?? join(CONFIG_DIR, "token.json");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const REDIRECT_PORT = 47319;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

interface OAuthCredentialsFile {
  installed?: OAuthClientCredentials;
  web?: OAuthClientCredentials;
}

interface OAuthClientCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

async function loadCredentials(): Promise<OAuthClientCredentials> {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at ${CREDENTIALS_PATH}. ` +
        `Download OAuth 2.0 client credentials from Google Cloud Console ` +
        `and save them to this path, or set GOOGLE_SHEETS_CREDENTIALS_PATH.`
    );
  }
  const raw = await readFile(CREDENTIALS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as OAuthCredentialsFile;
  const creds = parsed.installed ?? parsed.web;
  if (!creds) {
    throw new Error(
      "credentials.json must contain an 'installed' or 'web' OAuth client."
    );
  }
  return creds;
}

async function writeTokenFile(token: unknown): Promise<void> {
  // The refresh token stored here grants ongoing access to the user's
  // spreadsheets, so it must not be world-readable on a shared machine.
  await mkdir(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  // Write to a sibling and rename, so a crash mid-write cannot leave a
  // truncated token behind where a complete one used to be.
  const temporaryPath = `${TOKEN_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(token, null, 2), { mode: 0o600 });
  await rename(temporaryPath, TOKEN_PATH);
  // The mode above only applies to files being created. Tokens written by an
  // earlier version are already in place at 0644, so tighten unconditionally.
  await chmod(TOKEN_PATH, 0o600);
}

let pendingWrite: Promise<void> = Promise.resolve();

function saveToken(token: unknown): Promise<void> {
  // Serialised so two refreshes landing together cannot interleave.
  pendingWrite = pendingWrite.then(
    () => writeTokenFile(token),
    () => writeTokenFile(token)
  );
  return pendingWrite;
}

async function loadTokenIfPresent(): Promise<Record<string, unknown> | null> {
  if (!existsSync(TOKEN_PATH)) return null;
  const raw = await readFile(TOKEN_PATH, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function runOAuthFlow(client: OAuth2Client): Promise<void> {
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res
          .writeHead(400, { "Content-Type": "text/plain" })
          .end(`OAuth error: ${error}`);
        rejectCode(new Error(`OAuth error: ${error}`));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400).end("Missing code");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          "<h1>Authentication complete.</h1><p>You can close this tab and return to the terminal.</p>"
        );
      resolveCode(code);
    } catch (err) {
      rejectCode(err instanceof Error ? err : new Error(String(err)));
    }
  });

  // Bind before opening the browser. Opening first meant that on a port clash
  // the user got a consent screen redirecting to a port nothing was listening
  // on, while the clash itself surfaced as an unhandled 'error' event and a
  // raw stack trace rather than something actionable.
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `Port ${REDIRECT_PORT} is already in use, so the OAuth callback cannot be ` +
                `received. Find the process with 'lsof -i :${REDIRECT_PORT}', stop it, ` +
                `and run auth again.`
            )
          : err
      );
    });
    server.listen(REDIRECT_PORT, () => resolve());
  });

  const timeout = setTimeout(() => {
    rejectCode(
      new Error(
        `Timed out after ${CONSENT_TIMEOUT_MS / 60000} minutes waiting for the OAuth ` +
          `callback. If the consent screen never finished, run auth again.`
      )
    );
  }, CONSENT_TIMEOUT_MS);

  let code: string;
  try {
    console.error(`Opening browser for OAuth consent: ${authUrl}`);
    await open(authUrl);
    code = await codePromise;
  } finally {
    clearTimeout(timeout);
    server.close();
  }

  const { tokens } = await client.getToken(code);

  // Google omits refresh_token when it decides one is still valid on its side.
  // Keep the stored one in that case rather than writing a token we cannot refresh.
  const previous = await loadTokenIfPresent();
  const carriedOver =
    typeof previous?.refresh_token === "string" ? previous.refresh_token : undefined;
  const merged: Credentials & { authorized_at: number } = {
    ...tokens,
    refresh_token: tokens.refresh_token ?? carriedOver,
    // Consent time, not refresh time. While the OAuth app is in "Testing" mode
    // Google expires the refresh token 7 days after consent, and the file's mtime
    // moves on every silent refresh, so it cannot answer "how long do we have left".
    authorized_at: Date.now(),
  };

  client.setCredentials(merged);
  await saveToken(merged);
  console.error(`Token saved to ${TOKEN_PATH}`);
}

/**
 * Building a client re-reads two files off disk and registers another token
 * listener, and the MCP server did that on every single tool call. One client
 * is also what keeps concurrent refreshes from racing each other to the token
 * file, since google-auth-library dedupes refreshes per client.
 */
let cachedClient: OAuth2Client | null = null;

/**
 * Drop the cached client so the next call re-reads the token file. Called when
 * a request fails on credentials, which is what happens to a long-running
 * server after the user re-authorizes in another terminal.
 */
export function resetAuthorizedClient(): void {
  cachedClient = null;
}

export async function getAuthorizedClient(
  options: { interactive?: boolean } = {}
): Promise<OAuth2Client> {
  const { interactive = false } = options;
  if (!interactive && cachedClient) return cachedClient;

  const creds = await loadCredentials();
  const client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    REDIRECT_URI
  );

  const existing = await loadTokenIfPresent();

  // Interactive means the user explicitly asked to (re-)authorize, so always run
  // the consent flow. Returning a stored token here would make `auth` a no-op and
  // leave a dead refresh token in place with no way to replace it.
  if (interactive) {
    cachedClient = null;
    await runOAuthFlow(client);
    return client;
  }

  if (!existing) {
    throw new Error(
      `No stored token at ${TOKEN_PATH}. Run 'npx @yangchoi/mcp-google-sheets auth' first to authorize.`
    );
  }

  client.setCredentials(existing);
  client.on("tokens", (tokens) => {
    // A rejecting promise returned to an EventEmitter is unhandled, and Node
    // kills the process on an unhandled rejection. A failed write to the token
    // cache must not take down a server whose in-memory credentials are fine.
    saveToken({ ...existing, ...tokens }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: could not persist refreshed token to ${TOKEN_PATH}: ${message}`);
    });
  });
  cachedClient = client;
  return client;
}
