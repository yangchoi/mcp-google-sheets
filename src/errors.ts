/**
 * `invalid_grant` on its own says nothing about what to do, and it means two
 * different things depending on where it surfaced: during a tool call the
 * stored refresh token is dead, during `auth` the authorization code was
 * rejected. Spell out the right one at the point of failure.
 */
export type ErrorContext = "tool" | "auth";

export function explain(message: string, context: ErrorContext = "tool"): string {
  if (!/invalid_grant/i.test(message)) return message;

  if (context === "auth") {
    return (
      `${message}\n\n` +
      `Google rejected the authorization code. Common causes:\n` +
      `  - the consent screen was left open for a while before being completed\n` +
      `  - the same code was already exchanged once\n` +
      `  - the system clock is off\n\n` +
      `Run auth again and finish the consent screen promptly.`
    );
  }

  return (
    `${message}\n\n` +
    `The stored refresh token is no longer valid. Re-authorize:\n` +
    `  npx @heyyang/mcp-google-sheets auth\n\n` +
    `If this happens roughly every 7 days, the OAuth app is still in "Testing" mode ` +
    `in Google Cloud Console, which expires refresh tokens on that schedule. ` +
    `Publishing the app stops it.`
  );
}
