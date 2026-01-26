import { describe, test, expect } from "bun:test";
import type { IncomingHttpHeaders } from "node:http";
import {
  extractTailscaleIdentity,
  isTailscaleRequest,
  type TailscaleIdentity,
} from "./tailscale-auth.js";

describe("isTailscaleRequest", () => {
  test("returns true when Tailscale-User-Login header is present", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "user@example.com",
    };
    expect(isTailscaleRequest(headers)).toBe(true);
  });

  test("returns false when Tailscale-User-Login header is missing", () => {
    const headers: IncomingHttpHeaders = {
      "user-agent": "Mozilla/5.0",
    };
    expect(isTailscaleRequest(headers)).toBe(false);
  });

  test("returns false when Tailscale-User-Login header is empty string", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "",
    };
    expect(isTailscaleRequest(headers)).toBe(false);
  });

  test("returns false when Tailscale-User-Login header is whitespace only", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "   ",
    };
    expect(isTailscaleRequest(headers)).toBe(false);
  });

  test("handles array header values (takes first element)", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": ["user@example.com", "other@example.com"],
    };
    expect(isTailscaleRequest(headers)).toBe(true);
  });

  test("returns false when header array is empty", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": [],
    };
    expect(isTailscaleRequest(headers)).toBe(false);
  });
});

describe("extractTailscaleIdentity", () => {
  test("extracts full identity with all headers present", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "alice@example.com",
      "tailscale-user-name": "Alice Smith",
      "tailscale-user-profile-pic": "https://example.com/alice.jpg",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toEqual({
      login: "alice@example.com",
      name: "Alice Smith",
      profilePicUrl: "https://example.com/alice.jpg",
    } satisfies TailscaleIdentity);
  });

  test("returns null when login header is missing", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-name": "Alice Smith",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toBeNull();
  });

  test("returns null when login header is empty string", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "",
      "tailscale-user-name": "Alice Smith",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toBeNull();
  });

  test("returns null when login header is whitespace only", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "   ",
      "tailscale-user-name": "Alice Smith",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toBeNull();
  });

  test("defaults name to login when name header is missing", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "bob@example.com",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toEqual({
      login: "bob@example.com",
      name: "bob@example.com",
      profilePicUrl: undefined,
    } satisfies TailscaleIdentity);
  });

  test("defaults name to login when name header is empty string", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "bob@example.com",
      "tailscale-user-name": "",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toEqual({
      login: "bob@example.com",
      name: "bob@example.com",
      profilePicUrl: undefined,
    } satisfies TailscaleIdentity);
  });

  test("defaults name to login when name header is whitespace only", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "bob@example.com",
      "tailscale-user-name": "   ",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toEqual({
      login: "bob@example.com",
      name: "bob@example.com",
      profilePicUrl: undefined,
    } satisfies TailscaleIdentity);
  });

  test("omits profilePicUrl when header is missing", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "charlie@example.com",
      "tailscale-user-name": "Charlie Brown",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toEqual({
      login: "charlie@example.com",
      name: "Charlie Brown",
      profilePicUrl: undefined,
    } satisfies TailscaleIdentity);
  });

  test("omits profilePicUrl when header is empty string", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "charlie@example.com",
      "tailscale-user-name": "Charlie Brown",
      "tailscale-user-profile-pic": "",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toEqual({
      login: "charlie@example.com",
      name: "Charlie Brown",
      profilePicUrl: undefined,
    } satisfies TailscaleIdentity);
  });

  test("omits profilePicUrl when header is whitespace only", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "charlie@example.com",
      "tailscale-user-name": "Charlie Brown",
      "tailscale-user-profile-pic": "   ",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toEqual({
      login: "charlie@example.com",
      name: "Charlie Brown",
      profilePicUrl: undefined,
    } satisfies TailscaleIdentity);
  });

  test("trims whitespace from all fields", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": "  dave@example.com  ",
      "tailscale-user-name": "  Dave Jones  ",
      "tailscale-user-profile-pic": "  https://example.com/dave.jpg  ",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toEqual({
      login: "dave@example.com",
      name: "Dave Jones",
      profilePicUrl: "https://example.com/dave.jpg",
    } satisfies TailscaleIdentity);
  });

  test("handles array header values (takes first element)", () => {
    const headers: IncomingHttpHeaders = {
      "tailscale-user-login": ["eve@example.com", "other@example.com"],
      "tailscale-user-name": ["Eve Wilson", "Other Name"],
      "tailscale-user-profile-pic": [
        "https://example.com/eve.jpg",
        "https://example.com/other.jpg",
      ],
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toEqual({
      login: "eve@example.com",
      name: "Eve Wilson",
      profilePicUrl: "https://example.com/eve.jpg",
    } satisfies TailscaleIdentity);
  });

  test("handles empty header object", () => {
    const headers: IncomingHttpHeaders = {};
    const identity = extractTailscaleIdentity(headers);
    expect(identity).toBeNull();
  });

  test("handles headers with only unrelated fields", () => {
    const headers: IncomingHttpHeaders = {
      "user-agent": "Mozilla/5.0",
      "accept": "text/html",
      "host": "example.com",
    };

    const identity = extractTailscaleIdentity(headers);
    expect(identity).toBeNull();
  });
});
