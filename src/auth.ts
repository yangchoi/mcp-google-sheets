import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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

async function saveToken(token: unknown): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2));
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

  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", REDIRECT_URI);
        if (url.pathname !== "/oauth2callback") {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) {
          res
            .writeHead(400, { "Content-Type": "text/plain" })
            .end(`OAuth error: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400).end("Missing code");
          return;
        }
        res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            "<h1>Authentication complete.</h1><p>You can close this tab and return to the terminal.</p>"
          );
        server.close();
        resolve(code);
      } catch (err) {
        server.close();
        reject(err);
      }
    });
    server.listen(REDIRECT_PORT);
  });

  console.error(`Opening browser for OAuth consent: ${authUrl}`);
  await open(authUrl);

  const code = await codePromise;
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  await saveToken(tokens);
  console.error(`Token saved to ${TOKEN_PATH}`);
}

export async function getAuthorizedClient(
  options: { interactive?: boolean } = {}
): Promise<OAuth2Client> {
  const { interactive = false } = options;
  const creds = await loadCredentials();
  const client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    REDIRECT_URI
  );

  const existing = await loadTokenIfPresent();
  if (existing) {
    client.setCredentials(existing);
    client.on("tokens", async (tokens) => {
      const merged = { ...existing, ...tokens };
      await saveToken(merged);
    });
    return client;
  }

  if (!interactive) {
    throw new Error(
      `No stored token at ${TOKEN_PATH}. Run 'npx mcp-google-sheets auth' first to authorize.`
    );
  }

  await runOAuthFlow(client);
  return client;
}
