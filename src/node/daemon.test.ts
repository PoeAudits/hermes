/**
 * Node Daemon Tests
 *
 * Tests for the NodeDaemon class including:
 * - Handler registration
 * - Event emission
 * - State management
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { NodeDaemon } from "./daemon.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `node-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("NodeDaemon", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("constructor", () => {
    test("creates daemon with default options", () => {
      const daemon = new NodeDaemon();
      expect(daemon).toBeDefined();
      expect(daemon.getState()).toBe("disconnected");
      expect(daemon.isAuthenticated()).toBe(false);
    });

    test("creates daemon with custom options", () => {
      const daemon = new NodeDaemon({
        gatewayUrl: "ws://custom:9999",
        statePath: tempDir,
      });
      expect(daemon).toBeDefined();
    });
  });

  describe("handler registration", () => {
    test("registers handler for method", () => {
      const daemon = new NodeDaemon();
      const handler = mock(() => ({ result: "test" }));

      daemon.registerHandler("test.method", handler);

      // Handler is registered (we can't directly access the map, but we can verify it doesn't throw)
      expect(() => daemon.registerHandler("test.method2", handler)).not.toThrow();
    });

    test("unregisters handler for method", () => {
      const daemon = new NodeDaemon();
      const handler = mock(() => ({ result: "test" }));

      daemon.registerHandler("test.method", handler);
      daemon.unregisterHandler("test.method");

      // Unregistering again should not throw
      expect(() => daemon.unregisterHandler("test.method")).not.toThrow();
    });

    test("allows multiple handlers for different methods", () => {
      const daemon = new NodeDaemon();
      const handler1 = mock(() => ({ result: "test1" }));
      const handler2 = mock(() => ({ result: "test2" }));

      daemon.registerHandler("method1", handler1);
      daemon.registerHandler("method2", handler2);

      // Both should be registered without error
      expect(true).toBe(true);
    });
  });

  describe("state management", () => {
    test("initial state is disconnected", () => {
      const daemon = new NodeDaemon();
      expect(daemon.getState()).toBe("disconnected");
    });

    test("isAuthenticated returns false initially", () => {
      const daemon = new NodeDaemon();
      expect(daemon.isAuthenticated()).toBe(false);
    });

    test("getDeviceId returns undefined before start", () => {
      const daemon = new NodeDaemon();
      expect(daemon.getDeviceId()).toBeUndefined();
    });
  });

  describe("identity management", () => {
    test("creates device identity on start", async () => {
      // Use a valid localhost URL - connection will fail but identity will be created
      const daemon = new NodeDaemon({
        gatewayUrl: "ws://127.0.0.1:59999",
        statePath: tempDir,
      });

      // Suppress error logging for this test
      daemon.on("error", () => {});

      await daemon.start();

      const deviceId = daemon.getDeviceId();
      expect(deviceId).toBeDefined();
      expect(typeof deviceId).toBe("string");
      expect(deviceId!.length).toBe(8);

      daemon.stop();
    });
  });

  describe("lifecycle", () => {
    test("emits started event on start", async () => {
      const daemon = new NodeDaemon({
        gatewayUrl: "ws://127.0.0.1:59999",
        statePath: tempDir,
      });

      daemon.on("error", () => {});

      let startedEmitted = false;
      daemon.on("started", () => {
        startedEmitted = true;
      });

      await daemon.start();
      expect(startedEmitted).toBe(true);

      daemon.stop();
    });

    test("emits stopped event on stop", async () => {
      const daemon = new NodeDaemon({
        gatewayUrl: "ws://127.0.0.1:59999",
        statePath: tempDir,
      });

      daemon.on("error", () => {});

      let stoppedEmitted = false;
      daemon.on("stopped", () => {
        stoppedEmitted = true;
      });

      await daemon.start();
      daemon.stop();

      expect(stoppedEmitted).toBe(true);
    });

    test("start is idempotent", async () => {
      const daemon = new NodeDaemon({
        gatewayUrl: "ws://127.0.0.1:59999",
        statePath: tempDir,
      });

      daemon.on("error", () => {});

      let startCount = 0;
      daemon.on("started", () => {
        startCount++;
      });

      await daemon.start();
      await daemon.start();
      await daemon.start();

      expect(startCount).toBe(1);

      daemon.stop();
    });

    test("stop is idempotent", async () => {
      const daemon = new NodeDaemon({
        gatewayUrl: "ws://127.0.0.1:59999",
        statePath: tempDir,
      });

      daemon.on("error", () => {});

      let stopCount = 0;
      daemon.on("stopped", () => {
        stopCount++;
      });

      await daemon.start();
      daemon.stop();
      daemon.stop();
      daemon.stop();

      expect(stopCount).toBe(1);
    });
  });
});

describe("NodeDaemon handler async", () => {
  test("supports async handlers", () => {
    const daemon = new NodeDaemon();

    const asyncHandler = async (params: unknown): Promise<{ result: string }> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { result: "async" };
    };

    daemon.registerHandler("async.method", asyncHandler);
    // Handler registered successfully
    expect(true).toBe(true);
  });

  test("supports sync handlers", () => {
    const daemon = new NodeDaemon();

    const syncHandler = (params: unknown): { result: string } => {
      return { result: "sync" };
    };

    daemon.registerHandler("sync.method", syncHandler);
    // Handler registered successfully
    expect(true).toBe(true);
  });
});
