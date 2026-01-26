/**
 * Device Pairing Module
 *
 * Manages device pairing approval flow where new devices require explicit
 * admin approval before they can connect and execute commands.
 *
 * Key features:
 * - Paired devices persisted to state/devices/paired.json
 * - Pending devices tracked in memory (last 10 or 1 hour TTL)
 * - Atomic writes for persistence
 * - Auto-approve mode for development/testing
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Information about a node for pairing purposes.
 */
export interface PairingNodeInfo {
  hostname: string;
  platform: string;
  nodeId: string;
}

/**
 * A paired (approved) device.
 */
export interface PairedDevice {
  deviceId: string;
  publicKey: string;
  nodeInfo: PairingNodeInfo;
  pairedAtMs: number;
  lastSeenAtMs?: number;
}

/**
 * A pending device awaiting approval.
 */
export interface PendingDevice {
  deviceId: string;
  publicKey: string;
  nodeInfo: PairingNodeInfo;
  requestedAtMs: number;
}

/**
 * Stored format for paired devices with version for future migrations.
 */
interface StoredPairedDevices {
  version: 1;
  devices: Record<string, PairedDevice>;
}

/**
 * Result of a pairing check.
 */
export type PairingCheckResult =
  | { status: "paired"; device: PairedDevice }
  | { status: "pending"; device: PendingDevice }
  | { status: "rejected"; reason: string };

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PAIRING_VERSION = 1;
const PAIRED_FILE_MODE = 0o600;
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const PENDING_MAX_COUNT = 10;

// -----------------------------------------------------------------------------
// Pairing Store
// -----------------------------------------------------------------------------

/**
 * Manages device pairing state with persistence.
 *
 * Thread-safety: This implementation is designed for single-threaded Node.js
 * execution. All async operations use Promises which execute on the event loop.
 */
export class PairingStore {
  private readonly statePath: string;
  private readonly autoApprove: boolean;
  private pairedDevices: Map<string, PairedDevice> = new Map();
  private pendingDevices: Map<string, PendingDevice> = new Map();
  private loaded: boolean = false;

  constructor(statePath: string, options: { autoApprove?: boolean } = {}) {
    this.statePath = statePath;
    this.autoApprove = options.autoApprove ?? false;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Loads paired devices from disk.
   * Must be called before using other methods.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const filePath = this.getPairedFilePath();

    try {
      const content = await fs.readFile(filePath, "utf8");
      const stored = JSON.parse(content) as unknown;

      if (isValidStoredPairedDevices(stored)) {
        for (const [deviceId, device] of Object.entries(stored.devices)) {
          this.pairedDevices.set(deviceId, device);
        }
      }
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if (!isNodeError(error) || error.code !== "ENOENT") {
        console.error("Failed to load paired devices, starting fresh:", error);
      }
    }

    this.loaded = true;
  }

  /**
   * Ensures the store is loaded before operations.
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  // ---------------------------------------------------------------------------
  // Pairing Check
  // ---------------------------------------------------------------------------

  /**
   * Checks if a device is paired (approved).
   *
   * @param deviceId - The device ID to check
   * @returns true if the device is paired, false otherwise
   */
  async isPaired(deviceId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.pairedDevices.has(deviceId);
  }

  /**
   * Gets a paired device by ID.
   *
   * @param deviceId - The device ID to look up
   * @returns The paired device if found, undefined otherwise
   */
  async getPairedDevice(deviceId: string): Promise<PairedDevice | undefined> {
    await this.ensureLoaded();
    return this.pairedDevices.get(deviceId);
  }

  /**
   * Checks pairing status and handles pending device registration.
   *
   * If auto-approve is enabled, automatically approves new devices.
   * Otherwise, adds unknown devices to the pending list.
   *
   * @param deviceId - The device ID to check
   * @param publicKey - The device's public key
   * @param nodeInfo - Information about the node
   * @returns The pairing check result
   */
  async checkPairing(
    deviceId: string,
    publicKey: string,
    nodeInfo: PairingNodeInfo
  ): Promise<PairingCheckResult> {
    await this.ensureLoaded();

    // Check if already paired
    const paired = this.pairedDevices.get(deviceId);
    if (paired !== undefined) {
      // Update last seen time
      paired.lastSeenAtMs = Date.now();
      await this.persist();
      return { status: "paired", device: paired };
    }

    // Auto-approve mode for development
    if (this.autoApprove) {
      const device = await this.approvePairing(deviceId, publicKey, nodeInfo);
      return { status: "paired", device };
    }

    // Add to pending list
    const pending = this.addPendingDevice(deviceId, publicKey, nodeInfo);
    return {
      status: "pending",
      device: pending,
    };
  }

  // ---------------------------------------------------------------------------
  // Pairing Management
  // ---------------------------------------------------------------------------

  /**
   * Approves a device for pairing.
   *
   * @param deviceId - The device ID to approve
   * @param publicKey - The device's public key
   * @param nodeInfo - Information about the node
   * @returns The newly paired device
   */
  async approvePairing(
    deviceId: string,
    publicKey: string,
    nodeInfo: PairingNodeInfo
  ): Promise<PairedDevice> {
    await this.ensureLoaded();

    const device: PairedDevice = {
      deviceId,
      publicKey,
      nodeInfo,
      pairedAtMs: Date.now(),
    };

    this.pairedDevices.set(deviceId, device);

    // Remove from pending if present
    this.pendingDevices.delete(deviceId);

    await this.persist();
    return device;
  }

  /**
   * Approves a pending device by device ID.
   *
   * @param deviceId - The device ID to approve
   * @returns The newly paired device, or undefined if not found in pending
   */
  async approvePendingDevice(deviceId: string): Promise<PairedDevice | undefined> {
    await this.ensureLoaded();

    const pending = this.pendingDevices.get(deviceId);
    if (pending === undefined) {
      return undefined;
    }

    return this.approvePairing(deviceId, pending.publicKey, pending.nodeInfo);
  }

  /**
   * Revokes pairing for a device.
   *
   * @param deviceId - The device ID to revoke
   * @returns true if the device was found and removed, false otherwise
   */
  async revokePairing(deviceId: string): Promise<boolean> {
    await this.ensureLoaded();

    if (!this.pairedDevices.has(deviceId)) {
      return false;
    }

    this.pairedDevices.delete(deviceId);
    await this.persist();
    return true;
  }

  /**
   * Lists all paired devices.
   *
   * @returns Array of paired devices sorted by pairing time (newest first)
   */
  async listPairedDevices(): Promise<PairedDevice[]> {
    await this.ensureLoaded();

    const devices = Array.from(this.pairedDevices.values());
    devices.sort((a, b) => b.pairedAtMs - a.pairedAtMs);
    return devices;
  }

  // ---------------------------------------------------------------------------
  // Pending Device Management
  // ---------------------------------------------------------------------------

  /**
   * Adds a device to the pending list.
   *
   * Enforces TTL and max count limits.
   */
  private addPendingDevice(
    deviceId: string,
    publicKey: string,
    nodeInfo: PairingNodeInfo
  ): PendingDevice {
    // Clean up expired pending devices
    this.cleanupPendingDevices();

    // Check if already pending
    const existing = this.pendingDevices.get(deviceId);
    if (existing !== undefined) {
      // Update request time
      existing.requestedAtMs = Date.now();
      return existing;
    }

    // Enforce max count by removing oldest
    if (this.pendingDevices.size >= PENDING_MAX_COUNT) {
      const oldest = this.getOldestPendingDevice();
      if (oldest !== undefined) {
        this.pendingDevices.delete(oldest.deviceId);
      }
    }

    const pending: PendingDevice = {
      deviceId,
      publicKey,
      nodeInfo,
      requestedAtMs: Date.now(),
    };

    this.pendingDevices.set(deviceId, pending);
    return pending;
  }

  /**
   * Gets pending devices that tried to connect but aren't approved.
   *
   * @returns Array of pending devices sorted by request time (newest first)
   */
  async getPendingDevices(): Promise<PendingDevice[]> {
    await this.ensureLoaded();

    // Clean up expired first
    this.cleanupPendingDevices();

    const devices = Array.from(this.pendingDevices.values());
    devices.sort((a, b) => b.requestedAtMs - a.requestedAtMs);
    return devices;
  }

  /**
   * Rejects a pending device (removes from pending list).
   *
   * @param deviceId - The device ID to reject
   * @returns true if the device was found and removed, false otherwise
   */
  async rejectPendingDevice(deviceId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.pendingDevices.delete(deviceId);
  }

  /**
   * Cleans up expired pending devices.
   */
  private cleanupPendingDevices(): void {
    const now = Date.now();
    const expiredThreshold = now - PENDING_TTL_MS;

    for (const [deviceId, pending] of this.pendingDevices.entries()) {
      if (pending.requestedAtMs < expiredThreshold) {
        this.pendingDevices.delete(deviceId);
      }
    }
  }

  /**
   * Gets the oldest pending device.
   */
  private getOldestPendingDevice(): PendingDevice | undefined {
    let oldest: PendingDevice | undefined;

    for (const pending of this.pendingDevices.values()) {
      if (oldest === undefined || pending.requestedAtMs < oldest.requestedAtMs) {
        oldest = pending;
      }
    }

    return oldest;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Persists paired devices to disk with atomic write.
   */
  private async persist(): Promise<void> {
    const filePath = this.getPairedFilePath();
    const dir = path.dirname(filePath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const stored: StoredPairedDevices = {
      version: PAIRING_VERSION,
      devices: Object.fromEntries(this.pairedDevices),
    };

    const content = JSON.stringify(stored, null, 2) + "\n";

    // Atomic write: write to temp file then rename
    const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;

    try {
      await fs.writeFile(tempPath, content, { mode: PAIRED_FILE_MODE });

      // Ensure permissions are set
      try {
        await fs.chmod(tempPath, PAIRED_FILE_MODE);
      } catch {
        // Best effort
      }

      await fs.rename(tempPath, filePath);
    } catch (error) {
      // Clean up temp file on failure
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Gets the path to the paired devices file.
   */
  private getPairedFilePath(): string {
    return path.join(this.statePath, "devices", "paired.json");
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /**
   * Returns whether auto-approve mode is enabled.
   */
  isAutoApproveEnabled(): boolean {
    return this.autoApprove;
  }
}

// -----------------------------------------------------------------------------
// Type Guards
// -----------------------------------------------------------------------------

function isValidStoredPairedDevices(value: unknown): value is StoredPairedDevices {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (obj.version !== PAIRING_VERSION) {
    return false;
  }

  if (typeof obj.devices !== "object" || obj.devices === null) {
    return false;
  }

  // Validate each device entry
  const devices = obj.devices as Record<string, unknown>;
  for (const device of Object.values(devices)) {
    if (!isValidPairedDevice(device)) {
      return false;
    }
  }

  return true;
}

function isValidPairedDevice(value: unknown): value is PairedDevice {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    typeof obj.deviceId === "string" &&
    typeof obj.publicKey === "string" &&
    typeof obj.pairedAtMs === "number" &&
    isValidPairingNodeInfo(obj.nodeInfo)
  );
}

function isValidPairingNodeInfo(value: unknown): value is PairingNodeInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    typeof obj.hostname === "string" &&
    typeof obj.platform === "string" &&
    typeof obj.nodeId === "string"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// -----------------------------------------------------------------------------
// Convenience Functions
// -----------------------------------------------------------------------------

/**
 * Creates a new PairingStore instance.
 *
 * @param statePath - Base path for state storage
 * @param options - Optional configuration
 * @returns A new PairingStore instance
 */
export function createPairingStore(
  statePath: string,
  options: { autoApprove?: boolean } = {}
): PairingStore {
  return new PairingStore(statePath, options);
}
