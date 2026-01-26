/**
 * Device Pairing Tests
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PairingStore, createPairingStore } from "./pairing.js";
import type { PairingNodeInfo } from "./pairing.js";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  const tempBase = path.join(os.tmpdir(), "hermes-pairing-test");
  await fs.mkdir(tempBase, { recursive: true });
  return fs.mkdtemp(path.join(tempBase, "test-"));
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function createTestNodeInfo(hostname: string = "test-host"): PairingNodeInfo {
  return {
    hostname,
    platform: "linux",
    nodeId: "test-node-id",
  };
}

// -----------------------------------------------------------------------------
// PairingStore Tests
// -----------------------------------------------------------------------------

describe("PairingStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("initialization", () => {
    test("creates store with default options", () => {
      const store = new PairingStore(tempDir);
      expect(store.isAutoApproveEnabled()).toBe(false);
    });

    test("creates store with auto-approve enabled", () => {
      const store = new PairingStore(tempDir, { autoApprove: true });
      expect(store.isAutoApproveEnabled()).toBe(true);
    });

    test("loads empty state when no file exists", async () => {
      const store = new PairingStore(tempDir);
      await store.load();

      const paired = await store.listPairedDevices();
      expect(paired).toEqual([]);
    });
  });

  describe("isPaired", () => {
    test("returns false for unknown device", async () => {
      const store = new PairingStore(tempDir);
      const result = await store.isPaired("unknown-device");
      expect(result).toBe(false);
    });

    test("returns true for paired device", async () => {
      const store = new PairingStore(tempDir);
      await store.approvePairing("device-1", "public-key-1", createTestNodeInfo());

      const result = await store.isPaired("device-1");
      expect(result).toBe(true);
    });
  });

  describe("approvePairing", () => {
    test("adds device to paired list", async () => {
      const store = new PairingStore(tempDir);
      const nodeInfo = createTestNodeInfo("my-host");

      const device = await store.approvePairing("device-1", "public-key-1", nodeInfo);

      expect(device.deviceId).toBe("device-1");
      expect(device.publicKey).toBe("public-key-1");
      expect(device.nodeInfo.hostname).toBe("my-host");
      expect(device.pairedAtMs).toBeGreaterThan(0);
    });

    test("persists paired device to disk", async () => {
      const store = new PairingStore(tempDir);
      await store.approvePairing("device-1", "public-key-1", createTestNodeInfo());

      // Create new store and load
      const store2 = new PairingStore(tempDir);
      await store2.load();

      const isPaired = await store2.isPaired("device-1");
      expect(isPaired).toBe(true);
    });

    test("removes device from pending when approved", async () => {
      const store = new PairingStore(tempDir);
      const nodeInfo = createTestNodeInfo();

      // Add to pending first
      await store.checkPairing("device-1", "public-key-1", nodeInfo);
      let pending = await store.getPendingDevices();
      expect(pending.length).toBe(1);

      // Approve
      await store.approvePairing("device-1", "public-key-1", nodeInfo);

      pending = await store.getPendingDevices();
      expect(pending.length).toBe(0);
    });
  });

  describe("revokePairing", () => {
    test("removes device from paired list", async () => {
      const store = new PairingStore(tempDir);
      await store.approvePairing("device-1", "public-key-1", createTestNodeInfo());

      const result = await store.revokePairing("device-1");
      expect(result).toBe(true);

      const isPaired = await store.isPaired("device-1");
      expect(isPaired).toBe(false);
    });

    test("returns false for unknown device", async () => {
      const store = new PairingStore(tempDir);
      const result = await store.revokePairing("unknown-device");
      expect(result).toBe(false);
    });

    test("persists removal to disk", async () => {
      const store = new PairingStore(tempDir);
      await store.approvePairing("device-1", "public-key-1", createTestNodeInfo());
      await store.revokePairing("device-1");

      // Create new store and load
      const store2 = new PairingStore(tempDir);
      await store2.load();

      const isPaired = await store2.isPaired("device-1");
      expect(isPaired).toBe(false);
    });
  });

  describe("listPairedDevices", () => {
    test("returns empty array when no devices paired", async () => {
      const store = new PairingStore(tempDir);
      const devices = await store.listPairedDevices();
      expect(devices).toEqual([]);
    });

    test("returns all paired devices sorted by time (newest first)", async () => {
      const store = new PairingStore(tempDir);

      await store.approvePairing("device-1", "key-1", createTestNodeInfo("host-1"));
      await new Promise((r) => setTimeout(r, 10)); // Small delay
      await store.approvePairing("device-2", "key-2", createTestNodeInfo("host-2"));

      const devices = await store.listPairedDevices();
      expect(devices.length).toBe(2);
      expect(devices[0]?.deviceId).toBe("device-2"); // Newest first
      expect(devices[1]?.deviceId).toBe("device-1");
    });
  });

  describe("checkPairing", () => {
    test("returns paired status for known device", async () => {
      const store = new PairingStore(tempDir);
      const nodeInfo = createTestNodeInfo();
      await store.approvePairing("device-1", "public-key-1", nodeInfo);

      const result = await store.checkPairing("device-1", "public-key-1", nodeInfo);

      expect(result.status).toBe("paired");
      if (result.status === "paired") {
        expect(result.device.deviceId).toBe("device-1");
      }
    });

    test("updates lastSeenAtMs for paired device", async () => {
      const store = new PairingStore(tempDir);
      const nodeInfo = createTestNodeInfo();
      await store.approvePairing("device-1", "public-key-1", nodeInfo);

      const before = Date.now();
      await store.checkPairing("device-1", "public-key-1", nodeInfo);
      const after = Date.now();

      const device = await store.getPairedDevice("device-1");
      expect(device?.lastSeenAtMs).toBeGreaterThanOrEqual(before);
      expect(device?.lastSeenAtMs).toBeLessThanOrEqual(after);
    });

    test("returns pending status for unknown device", async () => {
      const store = new PairingStore(tempDir);
      const nodeInfo = createTestNodeInfo();

      const result = await store.checkPairing("device-1", "public-key-1", nodeInfo);

      expect(result.status).toBe("pending");
      if (result.status === "pending") {
        expect(result.device.deviceId).toBe("device-1");
      }
    });

    test("auto-approves when autoApprove is enabled", async () => {
      const store = new PairingStore(tempDir, { autoApprove: true });
      const nodeInfo = createTestNodeInfo();

      const result = await store.checkPairing("device-1", "public-key-1", nodeInfo);

      expect(result.status).toBe("paired");
      if (result.status === "paired") {
        expect(result.device.deviceId).toBe("device-1");
      }

      // Should be persisted
      const isPaired = await store.isPaired("device-1");
      expect(isPaired).toBe(true);
    });
  });

  describe("getPendingDevices", () => {
    test("returns empty array when no pending devices", async () => {
      const store = new PairingStore(tempDir);
      const pending = await store.getPendingDevices();
      expect(pending).toEqual([]);
    });

    test("returns pending devices sorted by time (newest first)", async () => {
      const store = new PairingStore(tempDir);

      await store.checkPairing("device-1", "key-1", createTestNodeInfo("host-1"));
      await new Promise((r) => setTimeout(r, 10)); // Small delay
      await store.checkPairing("device-2", "key-2", createTestNodeInfo("host-2"));

      const pending = await store.getPendingDevices();
      expect(pending.length).toBe(2);
      expect(pending[0]?.deviceId).toBe("device-2"); // Newest first
      expect(pending[1]?.deviceId).toBe("device-1");
    });

    test("updates request time for existing pending device", async () => {
      const store = new PairingStore(tempDir);
      const nodeInfo = createTestNodeInfo();

      await store.checkPairing("device-1", "key-1", nodeInfo);
      const pending1 = await store.getPendingDevices();
      expect(pending1.length).toBe(1);
      const firstTime = pending1[0]!.requestedAtMs;

      await new Promise((r) => setTimeout(r, 10)); // Small delay
      await store.checkPairing("device-1", "key-1", nodeInfo);

      const pending2 = await store.getPendingDevices();
      expect(pending2.length).toBe(1);
      expect(pending2[0]!.requestedAtMs).toBeGreaterThan(firstTime);
    });

    test("enforces max pending count", async () => {
      const store = new PairingStore(tempDir);

      // Add 11 pending devices (max is 10)
      for (let i = 0; i < 11; i++) {
        await store.checkPairing(`device-${i}`, `key-${i}`, createTestNodeInfo(`host-${i}`));
      }

      const pending = await store.getPendingDevices();
      expect(pending.length).toBe(10);

      // Oldest should be removed (device-0)
      const deviceIds = pending.map((p) => p.deviceId);
      expect(deviceIds).not.toContain("device-0");
      expect(deviceIds).toContain("device-10");
    });
  });

  describe("approvePendingDevice", () => {
    test("approves pending device", async () => {
      const store = new PairingStore(tempDir);
      await store.checkPairing("device-1", "key-1", createTestNodeInfo());

      const device = await store.approvePendingDevice("device-1");

      expect(device).toBeDefined();
      expect(device?.deviceId).toBe("device-1");

      const isPaired = await store.isPaired("device-1");
      expect(isPaired).toBe(true);

      const pending = await store.getPendingDevices();
      expect(pending.length).toBe(0);
    });

    test("returns undefined for unknown device", async () => {
      const store = new PairingStore(tempDir);
      const device = await store.approvePendingDevice("unknown");
      expect(device).toBeUndefined();
    });
  });

  describe("rejectPendingDevice", () => {
    test("removes device from pending list", async () => {
      const store = new PairingStore(tempDir);
      await store.checkPairing("device-1", "key-1", createTestNodeInfo());

      const result = await store.rejectPendingDevice("device-1");
      expect(result).toBe(true);

      const pending = await store.getPendingDevices();
      expect(pending.length).toBe(0);
    });

    test("returns false for unknown device", async () => {
      const store = new PairingStore(tempDir);
      const result = await store.rejectPendingDevice("unknown");
      expect(result).toBe(false);
    });
  });

  describe("persistence", () => {
    test("creates devices directory if it does not exist", async () => {
      const nestedPath = path.join(tempDir, "nested", "state");
      const store = new PairingStore(nestedPath);
      await store.approvePairing("device-1", "key-1", createTestNodeInfo());

      const pairedFile = path.join(nestedPath, "devices", "paired.json");
      const stat = await fs.stat(pairedFile);
      expect(stat.isFile()).toBe(true);
    });

    test("sets restrictive file permissions", async () => {
      const store = new PairingStore(tempDir);
      await store.approvePairing("device-1", "key-1", createTestNodeInfo());

      const pairedFile = path.join(tempDir, "devices", "paired.json");
      const stat = await fs.stat(pairedFile);

      // Check that only owner has read/write (0o600 = 384 in decimal)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    test("handles corrupted file gracefully", async () => {
      // Create corrupted file
      const devicesDir = path.join(tempDir, "devices");
      await fs.mkdir(devicesDir, { recursive: true });
      await fs.writeFile(path.join(devicesDir, "paired.json"), "not valid json");

      const store = new PairingStore(tempDir);
      await store.load();

      // Should start fresh
      const devices = await store.listPairedDevices();
      expect(devices).toEqual([]);
    });

    test("handles wrong version gracefully", async () => {
      // Create file with wrong version
      const devicesDir = path.join(tempDir, "devices");
      await fs.mkdir(devicesDir, { recursive: true });
      await fs.writeFile(
        path.join(devicesDir, "paired.json"),
        JSON.stringify({ version: 999, devices: {} })
      );

      const store = new PairingStore(tempDir);
      await store.load();

      // Should start fresh
      const devices = await store.listPairedDevices();
      expect(devices).toEqual([]);
    });
  });
});

// -----------------------------------------------------------------------------
// createPairingStore Tests
// -----------------------------------------------------------------------------

describe("createPairingStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  test("creates store with default options", () => {
    const store = createPairingStore(tempDir);
    expect(store).toBeInstanceOf(PairingStore);
    expect(store.isAutoApproveEnabled()).toBe(false);
  });

  test("creates store with auto-approve enabled", () => {
    const store = createPairingStore(tempDir, { autoApprove: true });
    expect(store.isAutoApproveEnabled()).toBe(true);
  });
});
