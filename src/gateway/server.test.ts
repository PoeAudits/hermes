/**
 * Gateway Server Tests
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { WebSocket } from "ws";
import { Gateway } from "./server.js";
import { generateKeyPair, signMessage, deriveDeviceId } from "../identity/device.js";
import type { Request, Response } from "../protocol/types.js";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

// Use a unique port for tests to avoid conflicts
const TEST_PORT = 18790 + Math.floor(Math.random() * 100);

function createTestRequest(id: string, method: string, params: unknown): Request {
  return { type: "req", id, method, params };
}

/**
 * Creates a message collector that queues incoming messages.
 */
function createMessageCollector(ws: WebSocket): {
  nextMessage: () => Promise<Response>;
  cleanup: () => void;
} {
  const messages: Response[] = [];
  const waiters: Array<(msg: Response) => void> = [];

  const handler = (data: unknown): void => {
    try {
      const text = typeof data === "string" ? data : (data as Buffer).toString();
      const parsed = JSON.parse(text) as Response;
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(parsed);
      } else {
        messages.push(parsed);
      }
    } catch {
      // Ignore parse errors
    }
  };

  ws.on("message", handler);

  return {
    nextMessage: (): Promise<Response> => {
      return new Promise((resolve, reject) => {
        const queued = messages.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }

        const timeout = setTimeout(() => {
          const idx = waiters.indexOf(resolve);
          if (idx >= 0) {
            waiters.splice(idx, 1);
          }
          reject(new Error("Timeout waiting for message"));
        }, 5000);

        waiters.push((msg) => {
          clearTimeout(timeout);
          resolve(msg);
        });
      });
    },
    cleanup: (): void => {
      ws.off("message", handler);
    },
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for connection"));
    }, 5000);

    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      resolve(); // Don't fail on timeout, just continue
    }, 1000);
    ws.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Gateway", () => {
  let gateway: Gateway;

  beforeAll(async () => {
    // Use auto-approve mode for tests to avoid pairing requirements
    gateway = new Gateway({ port: TEST_PORT, host: "127.0.0.1", autoApprove: true });
    await gateway.start();
  });

  afterAll(async () => {
    await gateway.stop();
    // Give time for port to be released
    await new Promise((resolve) => setTimeout(resolve, 100));
  }, 10000);

  test("starts and stops correctly", () => {
    expect(gateway.isListening()).toBe(true);
    expect(gateway.getPort()).toBe(TEST_PORT);
    expect(gateway.getHost()).toBe("127.0.0.1");
  });

  test("accepts WebSocket connections", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await waitForOpen(ws);

    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await waitForClose(ws);
  });

  test("rejects invalid message format", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await waitForOpen(ws);
    const collector = createMessageCollector(ws);

    // Send invalid message (not a request)
    ws.send(JSON.stringify({ foo: "bar" }));
    const response = await collector.nextMessage();

    expect(response.ok).toBe(false);
    expect(response.error).toContain("invalid message format");

    collector.cleanup();
    ws.close();
    await waitForClose(ws);
  });

  test("rejects unknown methods before auth", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await waitForOpen(ws);
    const collector = createMessageCollector(ws);

    const req = createTestRequest("1", "unknown.method", {});
    ws.send(JSON.stringify(req));
    const response = await collector.nextMessage();

    expect(response.ok).toBe(false);
    expect(response.error).toContain("authentication required");

    collector.cleanup();
    ws.close();
    await waitForClose(ws);
  });

  test("node.hello returns challenge", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await waitForOpen(ws);
    const collector = createMessageCollector(ws);

    const { publicKey } = generateKeyPair();
    const req = createTestRequest("1", "node.hello", {
      nodeInfo: {
        nodeId: "test-node",
        platform: "linux",
        hostname: "test-host",
      },
      publicKey,
    });

    ws.send(JSON.stringify(req));
    const response = await collector.nextMessage();

    expect(response.ok).toBe(true);
    expect(response.id).toBe("1");
    expect(response.payload).toBeDefined();

    const payload = response.payload as { challenge: string };
    expect(typeof payload.challenge).toBe("string");
    expect(payload.challenge.length).toBeGreaterThan(0);

    collector.cleanup();
    ws.close();
    await waitForClose(ws);
  });

  test("node.hello rejects invalid params", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await waitForOpen(ws);
    const collector = createMessageCollector(ws);

    const req = createTestRequest("1", "node.hello", {
      // Missing nodeInfo and publicKey
    });

    ws.send(JSON.stringify(req));
    const response = await collector.nextMessage();

    expect(response.ok).toBe(false);
    expect(response.error).toContain("invalid node.hello params");

    collector.cleanup();
    ws.close();
    await waitForClose(ws);
  });

  test("node.auth before node.hello fails", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await waitForOpen(ws);
    const collector = createMessageCollector(ws);

    const req = createTestRequest("1", "node.auth", {
      signature: "fake-signature",
    });

    ws.send(JSON.stringify(req));
    const response = await collector.nextMessage();

    expect(response.ok).toBe(false);
    expect(response.error).toContain("must send node.hello first");

    collector.cleanup();
    ws.close();
    await waitForClose(ws);
  });

  test("complete handshake succeeds with valid signature", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await waitForOpen(ws);
    const collector = createMessageCollector(ws);

    const { publicKey, privateKey } = generateKeyPair();
    const deviceId = deriveDeviceId(publicKey);

    // Step 1: Send node.hello
    const helloReq = createTestRequest("1", "node.hello", {
      nodeInfo: {
        nodeId: "test-node",
        platform: "linux",
        hostname: "test-host",
      },
      publicKey,
    });

    ws.send(JSON.stringify(helloReq));
    const helloResponse = await collector.nextMessage();
    expect(helloResponse.ok).toBe(true);

    const { challenge } = helloResponse.payload as { challenge: string };

    // Step 2: Sign challenge and send node.auth
    const signature = signMessage(challenge, privateKey);
    const authReq = createTestRequest("2", "node.auth", { signature });

    ws.send(JSON.stringify(authReq));
    const authResponse = await collector.nextMessage();

    expect(authResponse.ok).toBe(true);
    expect(authResponse.id).toBe("2");

    const authPayload = authResponse.payload as { deviceId: string; message: string };
    expect(authPayload.deviceId).toBe(deviceId);
    expect(authPayload.message).toBe("authentication successful");

    // Verify node is registered
    expect(gateway.getConnectedNodeCount()).toBeGreaterThanOrEqual(1);
    const node = gateway.getNode(deviceId);
    expect(node).toBeDefined();
    expect(node?.nodeInfo.hostname).toBe("test-host");

    collector.cleanup();
    ws.close();
    await waitForClose(ws);

    // Wait for disconnect to be processed
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("node.auth with invalid signature fails", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await waitForOpen(ws);
    const collector = createMessageCollector(ws);

    const { publicKey } = generateKeyPair();

    // Step 1: Send node.hello
    const helloReq = createTestRequest("1", "node.hello", {
      nodeInfo: {
        nodeId: "test-node",
        platform: "linux",
        hostname: "test-host",
      },
      publicKey,
    });

    ws.send(JSON.stringify(helloReq));
    const helloResponse = await collector.nextMessage();
    expect(helloResponse.ok).toBe(true);

    // Step 2: Send invalid signature
    const authReq = createTestRequest("2", "node.auth", {
      signature: "invalid-signature",
    });

    ws.send(JSON.stringify(authReq));
    const authResponse = await collector.nextMessage();

    expect(authResponse.ok).toBe(false);
    expect(authResponse.error).toContain("invalid signature");

    collector.cleanup();

    // Connection should be closed
    await waitForClose(ws);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  test("tracks connected nodes and removes on disconnect", async () => {
    const initialCount = gateway.getConnectedNodeCount();

    // Connect and authenticate a node
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await waitForOpen(ws);
    const collector = createMessageCollector(ws);

    const { publicKey, privateKey } = generateKeyPair();
    const deviceId = deriveDeviceId(publicKey);

    const helloReq = createTestRequest("1", "node.hello", {
      nodeInfo: {
        nodeId: "test-node-track",
        platform: "linux",
        hostname: "test-host-track",
      },
      publicKey,
    });

    ws.send(JSON.stringify(helloReq));
    const helloResponse = await collector.nextMessage();
    const { challenge } = helloResponse.payload as { challenge: string };

    const signature = signMessage(challenge, privateKey);
    const authReq = createTestRequest("2", "node.auth", { signature });
    ws.send(JSON.stringify(authReq));
    await collector.nextMessage();

    expect(gateway.getConnectedNodeCount()).toBe(initialCount + 1);
    expect(gateway.getNode(deviceId)).toBeDefined();

    collector.cleanup();
    ws.close();
    await waitForClose(ws);

    // Wait for disconnect to be processed
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(gateway.getNode(deviceId)).toBeUndefined();
  });
});
