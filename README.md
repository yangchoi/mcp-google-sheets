# MCP Google Sheets Server

**Read, write, and manage Google Sheets from Claude Desktop, Claude Code, and any Model Context Protocol (MCP) compatible AI client.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-purple.svg)](https://modelcontextprotocol.io)

A lightweight, production-ready **Model Context Protocol (MCP)** server that exposes the Google Sheets API to Claude and other LLM agents. Automate spreadsheet workflows, build AI agent tools that log to sheets, sync data pipelines with your team's spreadsheets, or let Claude edit a doc for you — all with a single MCP server.

## Table of contents

- [Why](#why)
- [Features](#features)
- [Quick start](#quick-start)
- [Setup](#setup)
  - [1. Create a Google Cloud project](#1-create-a-google-cloud-project)
  - [2. Enable the Sheets API](#2-enable-the-sheets-api)
  - [3. Create OAuth 2.0 credentials](#3-create-oauth-20-credentials)
  - [4. Install the server](#4-install-the-server)
  - [5. Authorize](#5-authorize)
- [Register with your MCP client](#register-with-your-mcp-client)
  - [Claude Desktop](#claude-desktop)
  - [Claude Code](#claude-code)
- [Available tools](#available-tools)
- [Usage examples](#usage-examples)
- [Configuration](#configuration)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Why

If you've wanted Claude to update a Google Sheet — a job-tracker, a habit log, a project dashboard — without switching windows, this server gives you the missing tool. It's the natural counterpart to Anthropic's official Google Drive MCP connector (which reads files but cannot write cells).

**Common workflows:**

- Let Claude append rows to a job-application tracker sheet as you apply
- Sync a research reading list, weekly retro, or IELTS study log
- Give an AI agent structured, auditable output to a spreadsheet
- Automate financial or ops dashboards from natural-language prompts

## Features

- ✅ **Read** any range in A1 notation
- ✅ **Update** cell values with `RAW` or `USER_ENTERED` parsing
- ✅ **Append** rows to any sheet (ideal for logging)
- ✅ **Clear** ranges without deleting formatting
- ✅ **Batch update** multiple ranges in one call
- ✅ **Inspect** spreadsheet metadata (sheet tabs, dimensions)
- 🔐 **OAuth 2.0** with local token storage and automatic refresh
- 📦 **TypeScript**, ES modules, minimal dependencies
- 🖥️ Works with **Claude Desktop**, **Claude Code**, and any MCP client over stdio

## Quick start

```bash
# 1. Put your Google Cloud OAuth credentials.json here
#    (how to obtain it: see Setup steps 1-3 below)
mkdir -p ~/.config/mcp-google-sheets
cp /path/to/downloaded-credentials.json ~/.config/mcp-google-sheets/credentials.json

# 2. Authorize (opens browser once)
npx @yangchoi/mcp-google-sheets auth

# 3. Register with Claude
claude mcp add --scope user google-sheets -- npx -y @yangchoi/mcp-google-sheets
```

## Setup

### 1. Create a Google Cloud project

- Open [Google Cloud Console](https://console.cloud.google.com/).
- Click **New Project** → give it any name (e.g., `mcp-sheets`).

### 2. Enable the Sheets API

- In your project, open [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com).
- Click **Enable**.

> ⚠️ **Check the project selector before you click Enable.** That link opens in whatever project the console last had selected — which is often *not* the project you just created. Enabling the API on the wrong project still shows a success screen, so this failure is silent: steps 3–5 will all succeed, and you won't find out until your first real tool call returns `Google Sheets API has not been used in project ... or it is disabled`.

Verify the API is enabled on the right project before moving on:

```bash
gcloud services list --enabled --project=YOUR_PROJECT_ID | grep sheets
# expected: sheets.googleapis.com   Google Sheets API
```

No output means it is not enabled. Enable it from the CLI instead:

```bash
gcloud services enable sheets.googleapis.com --project=YOUR_PROJECT_ID
```

Only the Sheets API is required — this server requests the `spreadsheets` scope alone, so you do not need to enable the Drive API.

### 3. Create OAuth 2.0 credentials

- Open [Credentials](https://console.cloud.google.com/apis/credentials).
- Click **Create Credentials → OAuth client ID**.
- If prompted, configure the OAuth consent screen first:
  - User type: **External** (unless you're on a Workspace with Internal available)
  - Add yourself as a **test user** while the app is in `Testing` mode
  - Scopes can be left empty at the consent screen; the app will request them at runtime
- Back at Create OAuth client ID:
  - Application type: **Desktop app**
  - Name: anything (e.g., `mcp-google-sheets`)
- Click **Download JSON** and save it. This is your `credentials.json`.

Move the file to the default config directory:

```bash
mkdir -p ~/.config/mcp-google-sheets
mv ~/Downloads/client_secret_*.json ~/.config/mcp-google-sheets/credentials.json
```

(Or set `GOOGLE_SHEETS_CREDENTIALS_PATH` to point somewhere else — see [Configuration](#configuration).)

### 4. Install the server

Nothing to install if you run it with `npx` — the commands below fetch the
published package on demand. To pin a copy instead:

```bash
npm install -g @yangchoi/mcp-google-sheets
```

<details>
<summary>Or build from source</summary>

```bash
git clone https://github.com/yangchoi/mcp-google-sheets.git
cd mcp-google-sheets
npm install
npm run build
```

Then substitute `node /absolute/path/to/mcp-google-sheets/dist/index.js` for
`npx -y @yangchoi/mcp-google-sheets` everywhere below, and `npm run auth` for
the `auth` command.
</details>

### 5. Authorize

Run the one-time OAuth flow. Your browser will open, you approve access to your own Sheets, and the resulting token is stored at `~/.config/mcp-google-sheets/token.json`.

```bash
npx @yangchoi/mcp-google-sheets auth
```

You should see `Authorization complete. Token saved.` in the terminal. The token
is written with `0600` permissions so other accounts on the machine cannot read
your refresh token.

The flow needs port `47319` free for the OAuth callback; if something else holds
it, the command says so and exits without opening a browser.

## Register with your MCP client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add:

```json
{
  "mcpServers": {
    "google-sheets": {
      "command": "npx",
      "args": ["-y", "@yangchoi/mcp-google-sheets"]
    }
  }
}
```

Restart Claude Desktop. The Sheets tools will appear in the tool picker.

### Claude Code

Register the server with the CLI:

```bash
claude mcp add --scope user google-sheets -- npx -y @yangchoi/mcp-google-sheets
```

`--scope user` makes the server available in **every** project on your machine. Without it the server is added at *local* scope, which loads only in the directory you ran the command from — a common surprise when a scheduled job or a session started elsewhere suddenly has no sheet tools. Check what you got with:

```bash
claude mcp get google-sheets   # look for "Scope: User config"
```

> ⚠️ Do **not** put `mcpServers` in `~/.claude/settings.json`. Claude Code does not read MCP servers from that file, so the block is silently ignored. MCP configuration lives in `~/.claude.json` (local and user scope, written by `claude mcp add`) or in a project's `.mcp.json`.

Restart Claude Code. Confirm the tools load via `/mcp`.

## Tests

```bash
npm test            # builds, then runs the suite
npm run test:offline   # only the tests that need no credentials
```

The offline tests cover the CLI surface, the OAuth callback port handling, the
advertised tool schemas, and the error shapes. They need no Google account.

The live tests exercise the real Sheets API and are skipped unless you point
them at a scratch spreadsheet — **they write to it**:

```bash
MCP_TEST_SPREADSHEET_ID=<id> npm test

# if the first tab is not called "Sheet1"
MCP_TEST_SPREADSHEET_ID=<id> MCP_TEST_SHEET_NAME=Data npm test
```

## Available tools

| Tool | Purpose |
|---|---|
| `get_spreadsheet_metadata` | List sheet tabs and their dimensions. Call first to discover sheet names. |
| `read_range` | Read cell values in A1 notation. Returns typed values (numbers as numbers) by default; pass `valueRenderOption` for display strings or formulas. |
| `update_range` | Overwrite cells in a specific range. |
| `append_row` | Append one or more rows after the last row with data. |
| `clear_range` | Clear values in a range without deleting formatting. |
| `batch_update_values` | Update multiple ranges in a single API call. |

All tools take `spreadsheetId` (found in the sheet URL between `/d/` and `/edit`).

## Usage examples

Prompt Claude:

> "Look at the spreadsheet `1abcXYZ...` and add a new row to the `Applications` sheet: `Legora, Stockholm, Legal AI, 2026-08-18, pending`."

Claude will call `get_spreadsheet_metadata` to find the sheet, then `append_row` with the values.

Or read + summarize:

> "Read the first 20 rows of sheet `Applications` in `1abcXYZ...` and tell me how many are still pending."

Claude calls `read_range` on `Applications!A1:F20`, then reasons over the returned array.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_SHEETS_CREDENTIALS_PATH` | `~/.config/mcp-google-sheets/credentials.json` | OAuth client credentials file. |
| `GOOGLE_SHEETS_TOKEN_PATH` | `~/.config/mcp-google-sheets/token.json` | Where the refresh token is stored. |
| `MCP_GOOGLE_SHEETS_CONFIG_DIR` | `~/.config/mcp-google-sheets` | Base directory used when the two paths above are unset. |

## Security

- `credentials.json` and `token.json` are **local only** and never transmitted anywhere except to Google's OAuth servers.
- Both files are covered by `.gitignore`; do not commit them to version control.
- The server only requests the `spreadsheets` scope — no Drive-wide access, no Gmail, no calendar.
- Token refresh happens automatically; no long-lived access token is exposed.
- Running the server does not require any network listening port at steady state (the temporary port `47319` is used only during the initial OAuth callback and is closed immediately after).

## Troubleshooting

**`Google Sheets API has not been used in project <number> before or it is disabled`** — [step 2](#2-enable-the-sheets-api) never took effect on the project your credentials belong to. This is the most common failure, and it survives restarts: reauthorizing, rebuilding, or restarting your MCP client will not fix it, because OAuth succeeds independently of whether the API is enabled.

Find the project your credentials actually use, then enable the API on *that* project:

```bash
# the project_id in your OAuth client file is the one that matters
python3 -c "import json;print(json.load(open('$HOME/.config/mcp-google-sheets/credentials.json'))['installed']['project_id'])"

gcloud services enable sheets.googleapis.com --project=THAT_PROJECT_ID
gcloud services list --enabled --project=THAT_PROJECT_ID | grep sheets   # confirm
```

The project number in the error message is the same project as that `project_id`, just in numeric form. If `gcloud projects describe THAT_PROJECT_ID` says the project does not exist, you are logged into `gcloud` with a different Google account than the one that created it — run `gcloud auth login` and pick the right account.

**`credentials.json not found`** — you missed [step 3–4](#3-create-oauth-20-credentials). Check the path.

**`Error: access_denied`** during OAuth — your Google account is not listed as a test user on the OAuth consent screen. Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent) → add your email under **Test users**.

**`insufficient permission`** when calling a tool — the token was created with a smaller scope. Delete `token.json` and re-run `npx @yangchoi/mcp-google-sheets auth`.

**Tool doesn't appear in Claude** — confirm the path in your MCP config is absolute and points to `dist/index.js` (not `src/index.ts`). Ensure you ran `npm run build`.

**Tools appear in one directory but not another** — the server was registered at *local* scope, which binds it to a single project path. Run `claude mcp get google-sheets`; if the scope is not `User config`, re-register it:

```bash
claude mcp remove google-sheets
claude mcp add --scope user google-sheets -- npx -y @yangchoi/mcp-google-sheets
```

This matters most for unattended runs (cron, `launchd`, `claude -p`), where the working directory is often `/` rather than your project. Without the tools an agent may fall back to calling the Sheets API another way and report success without touching your sheet.

**`No stored token` at server startup** — you skipped [step 5](#5-authorize). Run `npx @yangchoi/mcp-google-sheets auth`.

## Development

```bash
npm install
npm run dev      # tsc --watch
npm run build    # produces dist/
npm run start    # runs dist/index.js on stdio
```

Contributions welcome. This is a minimal core; PRs for structural updates (`spreadsheets.batchUpdate` for formatting, sheet-add, filters, protected ranges) are appreciated.

## License

MIT
