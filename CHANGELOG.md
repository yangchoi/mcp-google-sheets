# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-09-10

Documentation only. No behaviour change; `0.1.0` and `0.1.1` are functionally
identical.

### Added

- A parameter reference for all six tools: types, defaults, and what each option
  actually does. Previously the only description of `valueRenderOption`,
  `insertDataOption`, and friends lived in the MCP schema, which is not visible
  to anyone reading the package page.
- An explanation of the 2D `values` shape and of `null` cells, which leave the
  existing cell untouched rather than clearing it.
- A note that `read_range` omits trailing empties, so returned rows can be
  ragged rather than rectangular.
- Troubleshooting entries for `invalid_grant` and for the OAuth callback port
  already being in use.
- A prerequisites line (Node.js 18+) at the top of Setup.
- This changelog.

### Changed

- Step 3 of Setup now warns that leaving the OAuth app in `Testing` mode expires
  the refresh token every seven days, and points at **Publish app** as the fix.
  This is the most common way a working setup stops working, and it was only
  mentioned further down the page.
- The "tool doesn't appear in Claude" entry no longer assumes a cloned
  repository; it covers the published package first.

## [0.1.0] — 2026-09-10

First release.

### Added

- Six tools over MCP stdio: `get_spreadsheet_metadata`, `read_range`,
  `update_range`, `append_row`, `clear_range`, `batch_update_values`.
- OAuth 2.0 device-local flow with automatic token refresh. The token is stored
  at `0600` in a `0700` directory and written via a temporary file and rename,
  so an interrupted write cannot truncate it.
- `auth` and `check-auth` subcommands. `check-auth` reports how much of the
  seven-day `Testing`-mode window is left and exits `0`/`1`/`2` so it can gate a
  scheduled job.
- `read_range` returns typed values by default (`UNFORMATTED_VALUE` with
  `FORMATTED_STRING` dates). The API's own default returns every number as a
  locale-formatted string, which makes arithmetic on the result wrong.
- Argument validation ahead of authorization: errors name the argument, say what
  was received, and locate a bad cell by row and column.
