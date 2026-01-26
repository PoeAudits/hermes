/**
 * Node Registry Tests
 *
 * Tests for the NodeRegistry module including:
 * - Node registration/unregistration
 * - Node invoke flow with timeout and idempotency
 * - Disconnect handling during pending invokes
 * - Event broadcasting
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "node:events";
import {
  NodeRegistry,
  isNodeInvokeResponsePayload,
  type RegistryLogger,
  type NodeInvokeResponsePayload,
} from "./node-registry.js";
import type { ConnectedNode } from "./types.js";
import type { WebSocket } from "ws";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

/**
 * Creates a mock logger for testing.
 */
function createMockLogger(): RegistryLogger & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    info: (msg: string) => logs.push(`INFO: ${msg}`),
    warn: (msg: string) => logs.push(`WARN: ${msg}`),
    error: (msg: string) => logs.push(`ERROR: ${msg}`),
    debug: (msg: string) => logs.push(`DEBUG: ${msg}`),
  };
}

/**
 * Creates a mock WebSocket for testing.
 */
function createMockSocket(): WebSocket & {
  sentMessages: unknown[];
  closeCode?: number;
  closeReason?: string;
  isClosed: boolean;
} {
  const sentMessages: unknown[] = [];
  let isClosed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  const emitter = new EventEmitter();

  return {
    sentMessages,
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
    get isClosed() {
      return isClosed;
    },
    send: (data: unknown) => {
      if (isClosed) {
        throw new Error("Socket is closed");
      }
      sentMessages.push(JSON.parse(data as string));
    },
    close: (code?: number, reason?: string) => {
      isClosed = true;
      closeCode = code;
      closeReason = reason;
      emitter.emit("close", code, reason);
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    readyState: 1, // OPEN
  } as unknown as WebSocket & {
    sentMessages: unknown[];
    closeCode?: number;
    closeReason?: string;
    isClosed: boolean;
  };
}

/**
 * Creates a mock ConnectedNode for testing.
 */
function createMockNode(
  deviceId: string,
  hostname: string = "test-host"
): ConnectedNode & { mockSocket: ReturnType<typeof createMockSocket> } {
  const mockSocket = createMockSocket();
  return {
    deviceId,
    nodeInfo: {
      nodeId: `node-${deviceId}`,
      platform: "linux",
      hostname,
    },
    publicKey: `pk-${deviceId}`,
    socket: mockSocket,
    connectedAtMs: Date.now(),
    authState: "authenticated",
    mockSocket,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("NodeRegistry", () => {
  let registry: NodeRegistry;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    registry = new NodeRegistry(logger);
  });

  afterEach(() => {
    registry.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Registration Tests
  // ---------------------------------------------------------------------------

  describe("registerNode", () => {
    test("registers a new node", () => {
      const node = createMockNode("device-1", "host-1");

      const session = registry.registerNode(node);

      expect(session.deviceId).toBe("device-1");
      expect(session.nodeInfo.hostname).toBe("host-1");
      expect(registry.size()).toBe(1);
      expect(logger.logs).toContain("INFO: Node registered: device-1 (host-1)");
    });

    test("replaces existing node with same deviceId", () => {
      const node1 = createMockNode("device-1", "host-1");
      const node2 = createMockNode("device-1", "host-2");

      registry.registerNode(node1);
      registry.registerNode(node2);

      expect(registry.size()).toBe(1);
      const session = registry.getNode("device-1");
      expect(session?.nodeInfo.hostname).toBe("host-2");
      expect(node1.mockSocket.isClosed).toBe(true);
      expect(node1.mockSocket.closeReason).toBe("replaced by new connection");
    });

    test("registers multiple nodes", () => {
      const node1 = createMockNode("device-1");
      const node2 = createMockNode("device-2");
      const node3 = createMockNode("device-3");

      registry.registerNode(node1);
      registry.registerNode(node2);
      registry.registerNode(node3);

      expect(registry.size()).toBe(3);
    });
  });

  describe("unregisterNode", () => {
    test("removes a registered node", () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      const removed = registry.unregisterNode("device-1");

      expect(removed).toBe(true);
      expect(registry.size()).toBe(0);
      expect(registry.getNode("device-1")).toBeUndefined();
    });

    test("returns false for non-existent node", () => {
      const removed = registry.unregisterNode("non-existent");

      expect(removed).toBe(false);
    });
  });

  describe("getNode", () => {
    test("returns node session if exists", () => {
      const node = createMockNode("device-1", "host-1");
      registry.registerNode(node);

      const session = registry.getNode("device-1");

      expect(session).toBeDefined();
      expect(session?.deviceId).toBe("device-1");
      expect(session?.nodeInfo.hostname).toBe("host-1");
    });

    test("returns undefined for non-existent node", () => {
      const session = registry.getNode("non-existent");

      expect(session).toBeUndefined();
    });
  });

  describe("listNodes", () => {
    test("returns empty array when no nodes", () => {
      const nodes = registry.listNodes();

      expect(nodes).toEqual([]);
    });

    test("returns all nodes sorted by hostname", () => {
      registry.registerNode(createMockNode("device-3", "charlie"));
      registry.registerNode(createMockNode("device-1", "alpha"));
      registry.registerNode(createMockNode("device-2", "bravo"));

      const nodes = registry.listNodes();

      expect(nodes.length).toBe(3);
      expect(nodes[0]?.nodeInfo.hostname).toBe("alpha");
      expect(nodes[1]?.nodeInfo.hostname).toBe("bravo");
      expect(nodes[2]?.nodeInfo.hostname).toBe("charlie");
    });

    test("includes online status", () => {
      registry.registerNode(createMockNode("device-1"));

      const nodes = registry.listNodes();

      expect(nodes[0]?.online).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Invoke Tests
  // ---------------------------------------------------------------------------

  describe("invoke", () => {
    test("returns NOT_FOUND error for non-existent node", async () => {
      const result = await registry.invoke("non-existent", "test.method", {});

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("NOT_FOUND");
      expect(result.error?.message).toBe("node not connected");
    });

    test("sends invoke request event to target node", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      // Start invoke but don't await (we'll check the sent message)
      const invokePromise = registry.invoke("device-1", "test.method", {
        foo: "bar",
      });

      // Check that the event was sent
      expect(node.mockSocket.sentMessages.length).toBe(1);
      const sent = node.mockSocket.sentMessages[0] as {
        type: string;
        event: string;
        payload: { id: string; method: string; params: unknown };
      };
      expect(sent.type).toBe("event");
      expect(sent.event).toBe("node.invoke.request");
      expect(sent.payload.method).toBe("test.method");
      expect(sent.payload.params).toEqual({ foo: "bar" });
      expect(typeof sent.payload.id).toBe("string");

      // Simulate response
      const responsePayload: NodeInvokeResponsePayload = {
        id: sent.payload.id,
        ok: true,
        payload: { result: "success" },
      };
      registry.handleInvokeResponse("device-1", responsePayload);

      const result = await invokePromise;
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({ result: "success" });
    });

    test("times out after specified duration", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      const result = await registry.invoke(
        "device-1",
        "test.method",
        {},
        { timeoutMs: 50 }
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TIMEOUT");
      expect(result.error?.message).toContain("50ms");
    });

    test("returns cached result for duplicate idempotency key", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      // First invoke
      const invokePromise1 = registry.invoke(
        "device-1",
        "test.method",
        {},
        { idempotencyKey: "key-1" }
      );

      // Simulate response
      const sent = node.mockSocket.sentMessages[0] as {
        payload: { id: string };
      };
      registry.handleInvokeResponse("device-1", {
        id: sent.payload.id,
        ok: true,
        payload: { result: "first" },
      });

      await invokePromise1;

      // Second invoke with same key - should return cached result
      const result2 = await registry.invoke(
        "device-1",
        "test.method",
        {},
        { idempotencyKey: "key-1" }
      );

      expect(result2.ok).toBe(true);
      expect(result2.payload).toEqual({ result: "first" });
      // Should not have sent another message
      expect(node.mockSocket.sentMessages.length).toBe(1);
    });

    test("includes idempotency key in request payload", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      const invokePromise = registry.invoke(
        "device-1",
        "test.method",
        {},
        { idempotencyKey: "my-key" }
      );

      const sent = node.mockSocket.sentMessages[0] as {
        payload: { id: string; idempotencyKey?: string };
      };
      expect(sent.payload.idempotencyKey).toBe("my-key");

      // Clean up
      registry.handleInvokeResponse("device-1", {
        id: sent.payload.id,
        ok: true,
      });
      await invokePromise;
    });

    test("handles error response from node", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      const invokePromise = registry.invoke("device-1", "test.method", {});

      const sent = node.mockSocket.sentMessages[0] as {
        payload: { id: string };
      };
      registry.handleInvokeResponse("device-1", {
        id: sent.payload.id,
        ok: false,
        error: { code: "INVALID_PARAMS", message: "missing required field" },
      });

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("INVALID_PARAMS");
      expect(result.error?.message).toBe("missing required field");
    });
  });

  describe("handleInvokeResponse", () => {
    test("returns false for unknown request id", () => {
      const handled = registry.handleInvokeResponse("device-1", {
        id: "unknown-id",
        ok: true,
      });

      expect(handled).toBe(false);
    });

    test("returns false for response from wrong node", async () => {
      const node1 = createMockNode("device-1");
      const node2 = createMockNode("device-2");
      registry.registerNode(node1);
      registry.registerNode(node2);

      const invokePromise = registry.invoke(
        "device-1",
        "test.method",
        {},
        { timeoutMs: 100 }
      );

      const sent = node1.mockSocket.sentMessages[0] as {
        payload: { id: string };
      };

      // Try to respond from wrong node
      const handled = registry.handleInvokeResponse("device-2", {
        id: sent.payload.id,
        ok: true,
      });

      expect(handled).toBe(false);

      // Original invoke should still timeout
      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TIMEOUT");
    });
  });

  // ---------------------------------------------------------------------------
  // Disconnect Handling Tests
  // ---------------------------------------------------------------------------

  describe("disconnect during invoke", () => {
    test("rejects pending invokes when node disconnects", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      const invokePromise = registry.invoke(
        "device-1",
        "test.method",
        {},
        { timeoutMs: 5000 }
      );

      // Simulate disconnect
      registry.unregisterNode("device-1");

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("DISCONNECTED");
      expect(result.error?.message).toContain("node disconnected");
      expect(result.error?.message).toContain("test.method");
    });

    test("rejects pending invokes when node is replaced", async () => {
      const node1 = createMockNode("device-1", "host-1");
      const node2 = createMockNode("device-1", "host-2");
      registry.registerNode(node1);

      const invokePromise = registry.invoke(
        "device-1",
        "test.method",
        {},
        { timeoutMs: 5000 }
      );

      // Replace with new connection
      registry.registerNode(node2);

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("DISCONNECTED");
      expect(result.error?.message).toContain("connection replaced");
    });
  });

  // ---------------------------------------------------------------------------
  // Event Broadcasting Tests
  // ---------------------------------------------------------------------------

  describe("sendEvent", () => {
    test("sends event to specific node", () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      const sent = registry.sendEvent("device-1", "test.event", {
        data: "hello",
      });

      expect(sent).toBe(true);
      expect(node.mockSocket.sentMessages.length).toBe(1);
      const msg = node.mockSocket.sentMessages[0] as {
        type: string;
        event: string;
        payload: unknown;
      };
      expect(msg.type).toBe("event");
      expect(msg.event).toBe("test.event");
      expect(msg.payload).toEqual({ data: "hello" });
    });

    test("returns false for non-existent node", () => {
      const sent = registry.sendEvent("non-existent", "test.event", {});

      expect(sent).toBe(false);
    });
  });

  describe("broadcast", () => {
    test("sends event to all nodes", () => {
      const node1 = createMockNode("device-1");
      const node2 = createMockNode("device-2");
      const node3 = createMockNode("device-3");
      registry.registerNode(node1);
      registry.registerNode(node2);
      registry.registerNode(node3);

      const count = registry.broadcast("test.broadcast", { msg: "hello all" });

      expect(count).toBe(3);
      expect(node1.mockSocket.sentMessages.length).toBe(1);
      expect(node2.mockSocket.sentMessages.length).toBe(1);
      expect(node3.mockSocket.sentMessages.length).toBe(1);
    });

    test("returns 0 when no nodes connected", () => {
      const count = registry.broadcast("test.broadcast", {});

      expect(count).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Shutdown Tests
  // ---------------------------------------------------------------------------

  describe("shutdown", () => {
    test("rejects all pending invokes", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      const invokePromise = registry.invoke(
        "device-1",
        "test.method",
        {},
        { timeoutMs: 5000 }
      );

      registry.shutdown();

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("SHUTDOWN");
    });
  });

  // ---------------------------------------------------------------------------
  // Type Guard Tests
  // ---------------------------------------------------------------------------

  describe("isNodeInvokeResponsePayload", () => {
    test("returns true for valid payload", () => {
      expect(
        isNodeInvokeResponsePayload({
          id: "123",
          ok: true,
          payload: { data: "test" },
        })
      ).toBe(true);

      expect(
        isNodeInvokeResponsePayload({
          id: "123",
          ok: false,
          error: { code: "ERROR", message: "failed" },
        })
      ).toBe(true);
    });

    test("returns false for invalid payload", () => {
      expect(isNodeInvokeResponsePayload(null)).toBe(false);
      expect(isNodeInvokeResponsePayload({})).toBe(false);
      expect(isNodeInvokeResponsePayload({ id: "123" })).toBe(false);
      expect(isNodeInvokeResponsePayload({ ok: true })).toBe(false);
      expect(
        isNodeInvokeResponsePayload({
          id: 123,
          ok: true,
        })
      ).toBe(false);
      expect(
        isNodeInvokeResponsePayload({
          id: "123",
          ok: "true",
        })
      ).toBe(false);
      expect(
        isNodeInvokeResponsePayload({
          id: "123",
          ok: false,
          error: { code: 123, message: "test" },
        })
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency Cache Tests
  // ---------------------------------------------------------------------------

  describe("idempotency cache", () => {
    test("does not cache timeout results", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      // First invoke times out
      await registry.invoke(
        "device-1",
        "test.method",
        {},
        { timeoutMs: 10, idempotencyKey: "key-1" }
      );

      // Second invoke should send a new request (not return cached timeout)
      const invokePromise = registry.invoke(
        "device-1",
        "test.method",
        {},
        { timeoutMs: 100, idempotencyKey: "key-1" }
      );

      // Should have sent two messages
      expect(node.mockSocket.sentMessages.length).toBe(2);

      // Respond to second invoke
      const sent = node.mockSocket.sentMessages[1] as {
        payload: { id: string };
      };
      registry.handleInvokeResponse("device-1", {
        id: sent.payload.id,
        ok: true,
        payload: { result: "success" },
      });

      const result = await invokePromise;
      expect(result.ok).toBe(true);
    });

    test("does not cache error results", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      // First invoke returns error
      const invokePromise1 = registry.invoke(
        "device-1",
        "test.method",
        {},
        { idempotencyKey: "key-1" }
      );

      const sent1 = node.mockSocket.sentMessages[0] as {
        payload: { id: string };
      };
      registry.handleInvokeResponse("device-1", {
        id: sent1.payload.id,
        ok: false,
        error: { code: "ERROR", message: "failed" },
      });

      await invokePromise1;

      // Second invoke should send a new request
      const invokePromise2 = registry.invoke(
        "device-1",
        "test.method",
        {},
        { idempotencyKey: "key-1" }
      );

      expect(node.mockSocket.sentMessages.length).toBe(2);

      // Respond successfully this time
      const sent2 = node.mockSocket.sentMessages[1] as {
        payload: { id: string };
      };
      registry.handleInvokeResponse("device-1", {
        id: sent2.payload.id,
        ok: true,
        payload: { result: "success" },
      });

      const result = await invokePromise2;
      expect(result.ok).toBe(true);
    });

    test("tracks cache size", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      expect(registry.getIdempotencyCacheSize()).toBe(0);

      // Successful invoke with idempotency key
      const invokePromise = registry.invoke(
        "device-1",
        "test.method",
        {},
        { idempotencyKey: "key-1" }
      );

      const sent = node.mockSocket.sentMessages[0] as {
        payload: { id: string };
      };
      registry.handleInvokeResponse("device-1", {
        id: sent.payload.id,
        ok: true,
      });

      await invokePromise;

      expect(registry.getIdempotencyCacheSize()).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Pending Invoke Tracking Tests
  // ---------------------------------------------------------------------------

  describe("pending invoke tracking", () => {
    test("tracks pending invokes", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      expect(registry.getPendingInvokeCount()).toBe(0);

      const invokePromise = registry.invoke(
        "device-1",
        "test.method",
        {},
        { timeoutMs: 1000 }
      );

      expect(registry.getPendingInvokeCount()).toBe(1);

      // Respond
      const sent = node.mockSocket.sentMessages[0] as {
        payload: { id: string };
      };
      registry.handleInvokeResponse("device-1", {
        id: sent.payload.id,
        ok: true,
      });

      await invokePromise;

      expect(registry.getPendingInvokeCount()).toBe(0);
    });

    test("clears pending invoke on timeout", async () => {
      const node = createMockNode("device-1");
      registry.registerNode(node);

      await registry.invoke(
        "device-1",
        "test.method",
        {},
        { timeoutMs: 10 }
      );

      expect(registry.getPendingInvokeCount()).toBe(0);
    });
  });
});
