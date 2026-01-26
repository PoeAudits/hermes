/**
 * Tailscale Identity Extraction
 *
 * Extracts Tailscale user identity from HTTP headers when requests
 * come through Tailscale Serve. This provides information about which
 * Tailscale user/device is connecting.
 *
 * Headers added by Tailscale Serve:
 * - Tailscale-User-Login: User's login email
 * - Tailscale-User-Name: User's display name
 * - Tailscale-User-Profile-Pic: URL to user's profile picture
 */

import type { IncomingHttpHeaders } from "node:http";

export type TailscaleIdentity = {
  login: string;
  name: string;
  profilePicUrl?: string;
};

/**
 * Extracts a single header value from IncomingHttpHeaders.
 * Headers can be string | string[] | undefined, this normalizes to string | undefined.
 */
function getHeaderValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Checks if a request came through Tailscale Serve by looking for
 * Tailscale-specific headers.
 *
 * @param headers - HTTP request headers
 * @returns true if Tailscale headers are present
 */
export function isTailscaleRequest(headers: IncomingHttpHeaders): boolean {
  const login = getHeaderValue(headers, "tailscale-user-login");
  return typeof login === "string" && login.trim().length > 0;
}

/**
 * Extracts Tailscale user identity from HTTP headers.
 *
 * @param headers - HTTP request headers
 * @returns TailscaleIdentity if headers are present, null otherwise
 *
 * @example
 * ```typescript
 * const identity = extractTailscaleIdentity(req.headers);
 * if (identity) {
 *   console.log(`Request from Tailscale user: ${identity.login}`);
 * }
 * ```
 */
export function extractTailscaleIdentity(
  headers: IncomingHttpHeaders,
): TailscaleIdentity | null {
  const login = getHeaderValue(headers, "tailscale-user-login");
  
  // Login is required - if not present, not a Tailscale request
  if (typeof login !== "string" || login.trim().length === 0) {
    return null;
  }

  const nameRaw = getHeaderValue(headers, "tailscale-user-name");
  const profilePicRaw = getHeaderValue(headers, "tailscale-user-profile-pic");

  // Name defaults to login if not provided
  const name =
    typeof nameRaw === "string" && nameRaw.trim().length > 0
      ? nameRaw.trim()
      : login.trim();

  // Profile pic is optional
  const profilePicUrl =
    typeof profilePicRaw === "string" && profilePicRaw.trim().length > 0
      ? profilePicRaw.trim()
      : undefined;

  return {
    login: login.trim(),
    name,
    profilePicUrl,
  };
}
