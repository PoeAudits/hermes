/**
 * Tailscale Module Tests
 *
 * Tests for the Tailscale Serve integration using mocked CLI commands.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  clearBinaryCache,
  disableTailscaleServe,
  enableTailscaleServe,
  findTailscaleBinary,
  getTailnetHostname,
  isTailscaleAvailable,
  isServeEnabled,
  startTailscaleServe,
  type CommandExecutor,
  type TailscaleLogger,
} from "./tailscale.js";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

/**
 * Creates a mock executor that returns predefined results.
 */
function createMockExecutor(
  responses: Map<string, { stdout: string; stderr: string; exitCode: number }>
): CommandExecutor {
  return async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;

    // Check for exact match first
    if (responses.has(key)) {
      return responses.get(key)!;
    }

    // Check for command-only match (for version checks)
    const commandKey = `${command} ${args[0] ?? ""}`.trim();
    if (responses.has(commandKey)) {
      return responses.get(commandKey)!;
    }

    // Default: command not found
    throw new Error(`Command not found: ${command}`);
  };
}

/**
 * Creates a mock logger that captures messages.
 */
function createMockLogger(): TailscaleLogger & {
  messages: { level: string; message: string }[];
} {
  const messages: { level: string; message: string }[] = [];
  return {
    messages,
    info: (message: string) => messages.push({ level: "info", message }),
    warn: (message: string) => messages.push({ level: "warn", message }),
    error: (message: string) => messages.push({ level: "error", message }),
  };
}

/**
 * Sample Tailscale status JSON for a logged-in machine.
 */
const SAMPLE_STATUS_JSON = JSON.stringify({
  BackendState: "Running",
  Self: {
    DNSName: "my-machine.tailnet.ts.net.",
    TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
    HostName: "my-machine",
  },
});

/**
 * Sample Tailscale status JSON for a machine that needs login.
 */
const SAMPLE_STATUS_NEEDS_LOGIN = JSON.stringify({
  BackendState: "NeedsLogin",
  Self: null,
});

/**
 * Sample Tailscale status JSON with IP only (no DNS).
 */
const SAMPLE_STATUS_IP_ONLY = JSON.stringify({
  BackendState: "Running",
  Self: {
    DNSName: "",
    TailscaleIPs: ["100.64.0.2"],
  },
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Tailscale Module", () => {
  beforeEach(() => {
    // Clear cached binary path between tests
    clearBinaryCache();
  });

  describe("findTailscaleBinary", () => {
    test("finds tailscale in PATH", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);

      const binary = await findTailscaleBinary(exec);
      expect(binary).toBe("tailscale");
    });

    test("returns undefined when not found", async () => {
      const exec = createMockExecutor(new Map());

      const binary = await findTailscaleBinary(exec);
      expect(binary).toBeUndefined();
    });

    test("caches the binary path", async () => {
      let callCount = 0;
      const exec: CommandExecutor = async () => {
        callCount++;
        return { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 };
      };

      await findTailscaleBinary(exec);
      await findTailscaleBinary(exec);

      // Should only call once due to caching
      expect(callCount).toBe(1);
    });
  });

  describe("isTailscaleAvailable", () => {
    test("returns true when Tailscale is running", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_JSON, stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);

      const available = await isTailscaleAvailable(exec);
      expect(available).toBe(true);
    });

    test("returns false when Tailscale needs login", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_NEEDS_LOGIN, stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);

      const available = await isTailscaleAvailable(exec);
      expect(available).toBe(false);
    });

    test("returns false when binary not found", async () => {
      const exec = createMockExecutor(new Map());

      const available = await isTailscaleAvailable(exec);
      expect(available).toBe(false);
    });

    test("returns false when status command fails", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const exec = createMockExecutor(responses);

      const available = await isTailscaleAvailable(exec);
      expect(available).toBe(false);
    });
  });

  describe("getTailnetHostname", () => {
    test("returns DNS name without trailing dot", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_JSON, stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);

      const hostname = await getTailnetHostname(exec);
      expect(hostname).toBe("my-machine.tailnet.ts.net");
    });

    test("falls back to IP when no DNS name", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_IP_ONLY, stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);

      const hostname = await getTailnetHostname(exec);
      expect(hostname).toBe("100.64.0.2");
    });

    test("returns undefined when binary not found", async () => {
      const exec = createMockExecutor(new Map());

      const hostname = await getTailnetHostname(exec);
      expect(hostname).toBeUndefined();
    });

    test("returns undefined when status fails", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const exec = createMockExecutor(responses);

      const hostname = await getTailnetHostname(exec);
      expect(hostname).toBeUndefined();
    });

    test("handles noisy JSON output", async () => {
      const noisyOutput = `some warning message\n${SAMPLE_STATUS_JSON}\nmore output`;
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: noisyOutput, stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);

      const hostname = await getTailnetHostname(exec);
      expect(hostname).toBe("my-machine.tailnet.ts.net");
    });
  });

  describe("isServeEnabled", () => {
    test("returns true when serve status succeeds", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale serve status --json", { stdout: "{}", stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);

      const enabled = await isServeEnabled(exec);
      expect(enabled).toBe(true);
    });

    test("returns false when serve not enabled on tailnet", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale serve status --json", { stdout: "Serve is not enabled on your tailnet", stderr: "", exitCode: 1 }],
      ]);
      const exec = createMockExecutor(responses);

      const enabled = await isServeEnabled(exec);
      expect(enabled).toBe(false);
    });

    test("returns false when binary not found", async () => {
      const exec = createMockExecutor(new Map());

      const enabled = await isServeEnabled(exec);
      expect(enabled).toBe(false);
    });
  });

  describe("enableTailscaleServe", () => {
    test("enables serve successfully", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale serve --bg --yes 8080", { stdout: "Serving on https://...", stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);

      const result = await enableTailscaleServe(8080, exec);
      expect(result).toBe(true);
    });

    test("returns false when binary not found", async () => {
      const exec = createMockExecutor(new Map());

      const result = await enableTailscaleServe(8080, exec);
      expect(result).toBe(false);
    });

    test("returns false when serve fails", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale serve --bg --yes 8080", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const exec = createMockExecutor(responses);

      const result = await enableTailscaleServe(8080, exec);
      expect(result).toBe(false);
    });

    test("returns false when serve not enabled on tailnet", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale serve --bg --yes 8080", { stdout: "Serve is not enabled on your tailnet", stderr: "", exitCode: 1 }],
      ]);
      const exec = createMockExecutor(responses);

      const result = await enableTailscaleServe(8080, exec);
      expect(result).toBe(false);
    });

    test("retries with sudo on permission denied", async () => {
      let sudoCalled = false;
      const exec: CommandExecutor = async (command, args) => {
        if (command === "tailscale" && args[0] === "--version") {
          return { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 };
        }
        if (command === "tailscale" && args[0] === "serve") {
          return { stdout: "", stderr: "permission denied", exitCode: 1 };
        }
        if (command === "sudo") {
          sudoCalled = true;
          return { stdout: "Serving...", stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected command: ${command}`);
      };

      const result = await enableTailscaleServe(8080, exec);
      expect(result).toBe(true);
      expect(sudoCalled).toBe(true);
    });
  });

  describe("disableTailscaleServe", () => {
    test("disables serve successfully", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale serve reset", { stdout: "", stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);

      const result = await disableTailscaleServe(8080, exec);
      expect(result).toBe(true);
    });

    test("returns false when binary not found", async () => {
      const exec = createMockExecutor(new Map());

      const result = await disableTailscaleServe(8080, exec);
      expect(result).toBe(false);
    });
  });

  describe("startTailscaleServe", () => {
    test("starts serve and returns cleanup function", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_JSON, stderr: "", exitCode: 0 }],
        ["tailscale serve status --json", { stdout: "{}", stderr: "", exitCode: 0 }],
        ["tailscale serve --bg --yes 8080", { stdout: "Serving...", stderr: "", exitCode: 0 }],
        ["tailscale serve reset", { stdout: "", stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);
      const logger = createMockLogger();

      const cleanup = await startTailscaleServe({ port: 8080, logger }, exec);

      expect(cleanup).not.toBeNull();
      expect(logger.messages.some((m) => m.level === "info" && m.message.includes("enabled"))).toBe(true);

      // Call cleanup
      if (cleanup !== null) {
        await cleanup();
        expect(logger.messages.some((m) => m.level === "info" && m.message.includes("disabled"))).toBe(true);
      }
    });

    test("returns null when Tailscale not available", async () => {
      const exec = createMockExecutor(new Map());
      const logger = createMockLogger();

      const cleanup = await startTailscaleServe({ port: 8080, logger }, exec);

      expect(cleanup).toBeNull();
      expect(logger.messages.some((m) => m.level === "warn" && m.message.includes("not available"))).toBe(true);
    });

    test("returns null when serve not enabled on tailnet", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_JSON, stderr: "", exitCode: 0 }],
        ["tailscale serve status --json", { stdout: "Serve is not enabled on your tailnet", stderr: "", exitCode: 1 }],
      ]);
      const exec = createMockExecutor(responses);
      const logger = createMockLogger();

      const cleanup = await startTailscaleServe({ port: 8080, logger }, exec);

      expect(cleanup).toBeNull();
      expect(logger.messages.some((m) => m.level === "warn" && m.message.includes("not enabled on tailnet"))).toBe(true);
    });

    test("returns null when serve fails to enable", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_JSON, stderr: "", exitCode: 0 }],
        ["tailscale serve status --json", { stdout: "{}", stderr: "", exitCode: 0 }],
        ["tailscale serve --bg --yes 8080", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const exec = createMockExecutor(responses);
      const logger = createMockLogger();

      const cleanup = await startTailscaleServe({ port: 8080, logger }, exec);

      expect(cleanup).toBeNull();
      expect(logger.messages.some((m) => m.level === "warn" && m.message.includes("Failed to enable"))).toBe(true);
    });

    test("returns null when resetOnExit is false", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_JSON, stderr: "", exitCode: 0 }],
        ["tailscale serve status --json", { stdout: "{}", stderr: "", exitCode: 0 }],
        ["tailscale serve --bg --yes 8080", { stdout: "Serving...", stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);
      const logger = createMockLogger();

      const cleanup = await startTailscaleServe({ port: 8080, logger, resetOnExit: false }, exec);

      expect(cleanup).toBeNull();
      expect(logger.messages.some((m) => m.level === "info" && m.message.includes("enabled"))).toBe(true);
    });

    test("logs hostname when available", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_JSON, stderr: "", exitCode: 0 }],
        ["tailscale serve status --json", { stdout: "{}", stderr: "", exitCode: 0 }],
        ["tailscale serve --bg --yes 8080", { stdout: "Serving...", stderr: "", exitCode: 0 }],
      ]);
      const exec = createMockExecutor(responses);
      const logger = createMockLogger();

      await startTailscaleServe({ port: 8080, logger }, exec);

      expect(logger.messages.some((m) =>
        m.level === "info" && m.message.includes("https://my-machine.tailnet.ts.net")
      )).toBe(true);
    });

    test("cleanup handles errors gracefully", async () => {
      const responses = new Map([
        ["tailscale --version", { stdout: "tailscale 1.50.0", stderr: "", exitCode: 0 }],
        ["tailscale status --json", { stdout: SAMPLE_STATUS_JSON, stderr: "", exitCode: 0 }],
        ["tailscale serve status --json", { stdout: "{}", stderr: "", exitCode: 0 }],
        ["tailscale serve --bg --yes 8080", { stdout: "Serving...", stderr: "", exitCode: 0 }],
        ["tailscale serve reset", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const exec = createMockExecutor(responses);
      const logger = createMockLogger();

      const cleanup = await startTailscaleServe({ port: 8080, logger }, exec);

      expect(cleanup).not.toBeNull();

      // Cleanup should not throw
      if (cleanup !== null) {
        await cleanup();
        expect(logger.messages.some((m) => m.level === "warn" && m.message.includes("Failed to disable"))).toBe(true);
      }
    });
  });
});
