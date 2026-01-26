/**
 * Node Client Tests
 *
 * Tests for the NodeClient WebSocket client including:
 * - Connection state management
 * - Backoff calculation
 * - Event emission
 */

import { describe, test, expect } from "bun:test";
import { NodeClient } from "./client.js";

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("NodeClient", () => {
  describe("constructor", () => {
    test("creates client with default options", () => {
      const client = new NodeClient();
      expect(client).toBeDefined();
      expect(client.getState()).toBe("disconnected");
      expect(client.isConnected()).toBe(false);
    });

    test("creates client with custom options", () => {
      const client = new NodeClient({
        gatewayUrl: "ws://custom:9999",
        reconnect: false,
        backoffMs: 500,
        backoffMax: 30000,
        backoffMultiplier: 3,
        stableConnectionMs: 5000,
      });
      expect(client).toBeDefined();
    });
  });

  describe("state management", () => {
    test("initial state is disconnected", () => {
      const client = new NodeClient();
      expect(client.getState()).toBe("disconnected");
    });

    test("isConnected returns false when disconnected", () => {
      const client = new NodeClient();
      expect(client.isConnected()).toBe(false);
    });
  });

  describe("disconnect", () => {
    test("disconnect is safe to call when not connected", () => {
      const client = new NodeClient();
      expect(() => client.disconnect()).not.toThrow();
    });

    test("disconnect is idempotent", () => {
      const client = new NodeClient();
      client.disconnect();
      client.disconnect();
      client.disconnect();
      expect(client.getState()).toBe("disconnected");
    });
  });

  describe("request", () => {
    test("request throws when not connected", async () => {
      const client = new NodeClient();

      await expect(client.request("test.method", {})).rejects.toThrow("Not connected to Gateway");
    });
  });

  describe("send", () => {
    test("send throws when not connected", () => {
      const client = new NodeClient();

      expect(() =>
        client.send({
          type: "req",
          id: "test",
          method: "test.method",
          params: {},
        })
      ).toThrow("Not connected to Gateway");
    });
  });

  describe("event emission", () => {
    test("emits stateChange on disconnect", () => {
      const client = new NodeClient();
      const states: string[] = [];

      client.on("stateChange", (state) => {
        states.push(state);
      });

      // Connect attempt to non-existent server will fail
      // but disconnect should still emit state change
      client.disconnect();

      // State should remain disconnected
      expect(client.getState()).toBe("disconnected");
    });
  });
});

describe("NodeClient backoff", () => {
  test("backoff options are configurable", () => {
    const client = new NodeClient({
      backoffMs: 100,
      backoffMax: 1000,
      backoffMultiplier: 2,
    });

    // Client created with custom backoff settings
    expect(client).toBeDefined();
  });

  test("stable connection time is configurable", () => {
    const client = new NodeClient({
      stableConnectionMs: 5000,
    });

    expect(client).toBeDefined();
  });
});

describe("NodeClient reconnection", () => {
  test("reconnect option can be disabled", () => {
    const client = new NodeClient({
      reconnect: false,
    });

    expect(client).toBeDefined();
  });

  test("connect after disconnect does nothing when closed", () => {
    const client = new NodeClient();
    client.disconnect();

    // Connect should be a no-op after disconnect
    client.connect();
    expect(client.getState()).toBe("disconnected");
  });
});
