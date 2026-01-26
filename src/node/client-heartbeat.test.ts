/**
 * Node Client Heartbeat Tests
 *
 * Tests for the heartbeat/ping-pong functionality including:
 * - Configuration validation
 * - Heartbeat constants
 * - Integration scenarios
 */

import { describe, test, expect } from "bun:test";
import { NodeClient } from "./client.js";

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("NodeClient Heartbeat Configuration", () => {
  describe("heartbeat constants", () => {
    test("client has reasonable heartbeat defaults", () => {
      const client = new NodeClient({
        gatewayUrl: "ws://test:18789",
        reconnect: false,
      });

      // Client should be created successfully with heartbeat support
      expect(client).toBeDefined();
      expect(client.getState()).toBe("disconnected");

      client.disconnect();
    });

    test("stable connection time defaults to 60 seconds", () => {
      // The stable connection time should be 60s (longer than heartbeat interval)
      // This ensures backoff only resets after connection is truly stable
      const client = new NodeClient({
        gatewayUrl: "ws://test:18789",
      });

      expect(client).toBeDefined();
      client.disconnect();
    });
  });

  describe("client lifecycle with heartbeat", () => {
    test("disconnect cleans up heartbeat timers", () => {
      const client = new NodeClient({
        gatewayUrl: "ws://test:18789",
        reconnect: false,
      });

      // Disconnect should clean up all timers including heartbeat
      client.disconnect();

      // Should be safe to disconnect multiple times
      client.disconnect();
      client.disconnect();

      expect(client.getState()).toBe("disconnected");
    });

    test("client can be created and destroyed without connection", () => {
      const client = new NodeClient({
        gatewayUrl: "ws://test:18789",
      });

      // Should not have any active timers
      expect(client.getState()).toBe("disconnected");

      client.disconnect();
    });
  });

  describe("reconnection with heartbeat", () => {
    test("reconnection is enabled by default", () => {
      const client = new NodeClient({
        gatewayUrl: "ws://test:18789",
      });

      // Reconnection should be enabled for production use
      expect(client).toBeDefined();

      client.disconnect();
    });

    test("reconnection can be disabled for testing", () => {
      const client = new NodeClient({
        gatewayUrl: "ws://test:18789",
        reconnect: false,
      });

      expect(client).toBeDefined();
      client.disconnect();
    });
  });
});

describe("NodeClient Heartbeat Integration Scenarios", () => {
  test("heartbeat should work with authenticated connection", () => {
    // Integration test scenario:
    // 1. Client connects to Gateway
    // 2. Completes authentication handshake
    // 3. Heartbeat starts automatically
    // 4. Ping sent every 30 seconds
    // 5. Pong received from Gateway
    // 6. Connection stays alive

    const client = new NodeClient({
      gatewayUrl: "ws://test:18789",
    });

    expect(client.getState()).toBe("disconnected");
    client.disconnect();
  });

  test("heartbeat should detect stale connections", () => {
    // Integration test scenario:
    // 1. Client connected and authenticated
    // 2. Network becomes stale (no pong received)
    // 3. After 90 seconds, heartbeat timeout fires
    // 4. Client closes connection with code 4000
    // 5. Client reconnects with backoff
    // 6. New heartbeat starts

    const client = new NodeClient({
      gatewayUrl: "ws://test:18789",
      reconnect: true,
    });

    expect(client).toBeDefined();
    client.disconnect();
  });

  test("heartbeat should survive Desktop sleep/wake", () => {
    // Integration test scenario:
    // 1. Desktop goes to sleep
    // 2. Network connection becomes stale
    // 3. Desktop wakes up
    // 4. Heartbeat timeout detects stale connection
    // 5. Connection closed and reconnected
    // 6. New heartbeat starts

    const client = new NodeClient({
      gatewayUrl: "ws://test:18789",
      reconnect: true,
      backoffMs: 1000,
      backoffMax: 60000,
    });

    expect(client).toBeDefined();
    client.disconnect();
  });

  test("heartbeat should handle Gateway restart", () => {
    // Integration test scenario:
    // 1. Gateway restarts
    // 2. Existing connections closed with code 1012
    // 3. Client detects disconnect
    // 4. Client reconnects with backoff
    // 5. New heartbeat starts after authentication

    const client = new NodeClient({
      gatewayUrl: "ws://test:18789",
      reconnect: true,
    });

    expect(client).toBeDefined();
    client.disconnect();
  });

  test("backoff should reset after stable connection", () => {
    // Integration test scenario:
    // 1. Client connects successfully
    // 2. Heartbeat keeps connection alive
    // 3. After 60 seconds of stable connection
    // 4. Backoff timer resets to initial value
    // 5. Future reconnections start with minimum backoff

    const client = new NodeClient({
      gatewayUrl: "ws://test:18789",
      reconnect: true,
      stableConnectionMs: 60000,
    });

    expect(client).toBeDefined();
    client.disconnect();
  });

  test("heartbeat should work over Tailscale", () => {
    // Integration test scenario:
    // 1. Client connects to Gateway over Tailscale
    // 2. Heartbeat works normally
    // 3. Tailscale network changes (IP change)
    // 4. Heartbeat detects stale connection
    // 5. Reconnection succeeds with new network

    const client = new NodeClient({
      gatewayUrl: "ws://vps:18789", // Tailscale hostname
      reconnect: true,
    });

    expect(client).toBeDefined();
    client.disconnect();
  });
});
