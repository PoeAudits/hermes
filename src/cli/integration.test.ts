/**
 * Integration Tests for Hermes System
 *
 * Tests the complete flow:
 * - Gateway starts and accepts connections
 * - Node daemon connects and authenticates
 * - CLI can list nodes and invoke commands
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Gateway } from "../gateway/index.js";
import { NodeDaemon } from "../node/index.js";
import { NodeClient } from "../node/client.js";
import { getOrCreateIdentity, signMessage } from "../identity/device.js";
import type { NodeInfo } from "../protocol/types.js";

// -----------------------------------------------------------------------------
// Test Setup
// -----------------------------------------------------------------------------

const TEST_PORT = 18899;
const TEST_HOST = "127.0.0.1";
const TEST_GATEWAY_URL = `ws://${TEST_HOST}:${TEST_PORT}`;

let gateway: Gateway;
let nodeDaemon: NodeDaemon;
let tempDir: string;
let nodeStatePath: string;
let cliStatePath: string;

beforeAll(async () => {
  // Create temp directories for state
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-integration-"));
  nodeStatePath = path.join(tempDir, "node-state");
  cliStatePath = path.join(tempDir, "cli-state");

  await fs.mkdir(nodeStatePath, { recursive: true });
  await fs.mkdir(cliStatePath, { recursive: true });

  // Start Gateway with auto-approve for testing
  gateway = new Gateway({ port: TEST_PORT, host: TEST_HOST, autoApprove: true });
  await gateway.start();

  // Start Node Daemon
  nodeDaemon = new NodeDaemon({
    gatewayUrl: TEST_GATEWAY_URL,
    statePath: nodeStatePath,
    registerSystemRun: true,
  });

  // Wait for authentication
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Node authentication timeout"));
    }, 10_000);

    nodeDaemon.on("authenticated", () => {
      clearTimeout(timeout);
      resolve();
    });

    nodeDaemon.on("authFailed", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Auth failed: ${error}`));
    });

    nodeDaemon.start().catch(reject);
  });
});

afterAll(async () => {
  // Stop daemon and gateway
  nodeDaemon?.stop();
  await gateway?.stop();

  // Clean up temp directory
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Helper: Create authenticated CLI client
// -----------------------------------------------------------------------------

async function createAuthenticatedClient(): Promise<NodeClient> {
  const identity = await getOrCreateIdentity(cliStatePath);

  const client = new NodeClient({
    gatewayUrl: TEST_GATEWAY_URL,
    reconnect: false,
  });

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Connection timeout"));
    }, 5_000);

    client.on("connected", () => {
      clearTimeout(timeout);
      resolve();
    });

    client.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    client.connect();
  });

  // Authenticate
  const nodeInfo: NodeInfo = {
    nodeId: identity.deviceId,
    platform: process.platform,
    hostname: "test-cli",
  };

  const helloResponse = await client.request<{ challenge: string }>("node.hello", {
    nodeInfo,
    publicKey: identity.publicKey,
  });

  const signature = signMessage(helloResponse.challenge, identity.privateKey);
  await client.request<{ deviceId: string }>("node.auth", { signature });

  client.setAuthenticated();
  return client;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Integration: Gateway + Node + CLI", () => {
  test("node daemon registers and is visible in node list", async () => {
    const client = await createAuthenticatedClient();

    try {
      const response = await client.request<{ nodes: Array<{ deviceId: string; nodeInfo: NodeInfo }> }>(
        "node.list",
        {}
      );

      expect(response.nodes).toBeDefined();
      expect(response.nodes.length).toBeGreaterThanOrEqual(1);

      // Find our node daemon (not the CLI client)
      const nodeDeviceId = nodeDaemon.getDeviceId();
      const foundNode = response.nodes.find((n) => n.deviceId === nodeDeviceId);
      expect(foundNode).toBeDefined();
      expect(foundNode?.nodeInfo.platform).toBe(process.platform);
    } finally {
      client.disconnect();
    }
  });

  test("can invoke system.run on node and get output", async () => {
    const client = await createAuthenticatedClient();
    const nodeDeviceId = nodeDaemon.getDeviceId();

    expect(nodeDeviceId).toBeDefined();

    try {
      const response = await client.request<{
        ok: boolean;
        payload?: { stdout: string; stderr: string; exitCode: number };
        error?: { code: string; message: string };
      }>(
        "node.invoke",
        {
          targetNodeId: nodeDeviceId,
          method: "system.run",
          params: { command: ["echo", "Hello from integration test"] },
          timeoutMs: 10_000,
        },
        15_000
      );

      expect(response.ok).toBe(true);
      expect(response.payload).toBeDefined();
      expect(response.payload?.stdout).toContain("Hello from integration test");
      expect(response.payload?.exitCode).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  test("invoke returns error for unknown method", async () => {
    const client = await createAuthenticatedClient();
    const nodeDeviceId = nodeDaemon.getDeviceId();

    expect(nodeDeviceId).toBeDefined();

    try {
      const response = await client.request<{
        ok: boolean;
        payload?: unknown;
        error?: { code: string; message: string };
      }>(
        "node.invoke",
        {
          targetNodeId: nodeDeviceId,
          method: "unknown.method",
          params: {},
          timeoutMs: 5_000,
        },
        10_000
      );

      expect(response.ok).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain("Unknown method");
    } finally {
      client.disconnect();
    }
  });

  test("invoke returns error for non-existent node", async () => {
    const client = await createAuthenticatedClient();

    try {
      const response = await client.request<{
        ok: boolean;
        payload?: unknown;
        error?: { code: string; message: string };
      }>(
        "node.invoke",
        {
          targetNodeId: "non-existent-node-id",
          method: "system.run",
          params: { command: ["echo", "test"] },
          timeoutMs: 5_000,
        },
        10_000
      );

      expect(response.ok).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe("NOT_FOUND");
    } finally {
      client.disconnect();
    }
  });

  test("can invoke command with working directory", async () => {
    const client = await createAuthenticatedClient();
    const nodeDeviceId = nodeDaemon.getDeviceId();

    expect(nodeDeviceId).toBeDefined();

    try {
      const response = await client.request<{
        ok: boolean;
        payload?: { stdout: string; stderr: string; exitCode: number };
        error?: { code: string; message: string };
      }>(
        "node.invoke",
        {
          targetNodeId: nodeDeviceId,
          method: "system.run",
          params: {
            command: ["pwd"],
            cwd: "/tmp",
          },
          timeoutMs: 10_000,
        },
        15_000
      );

      expect(response.ok).toBe(true);
      expect(response.payload?.stdout?.trim()).toBe("/tmp");
      expect(response.payload?.exitCode).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  test("handles command that returns non-zero exit code", async () => {
    const client = await createAuthenticatedClient();
    const nodeDeviceId = nodeDaemon.getDeviceId();

    expect(nodeDeviceId).toBeDefined();

    try {
      const response = await client.request<{
        ok: boolean;
        payload?: { stdout: string; stderr: string; exitCode: number };
        error?: { code: string; message: string };
      }>(
        "node.invoke",
        {
          targetNodeId: nodeDeviceId,
          method: "system.run",
          params: { command: ["false"] }, // 'false' command always exits with 1
          timeoutMs: 10_000,
        },
        15_000
      );

      expect(response.ok).toBe(true);
      expect(response.payload?.exitCode).toBe(1);
    } finally {
      client.disconnect();
    }
  });
});
