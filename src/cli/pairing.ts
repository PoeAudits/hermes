/**
 * Pairing CLI
 *
 * Local command-line interface for managing device pairing.
 * This CLI works directly with the pairing store on the Gateway machine.
 *
 * Commands:
 * - hermes pair <deviceId>    - Approve pending device
 * - hermes unpair <deviceId>  - Revoke device access
 * - hermes pending            - List devices awaiting approval
 * - hermes paired             - List all paired devices
 */

import path from "node:path";
import os from "node:os";
import { PairingStore } from "../identity/pairing.js";
import type { PairedDevice, PendingDevice } from "../identity/pairing.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface PairingCliOptions {
  statePath: string;
  json: boolean;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_OPTIONS: PairingCliOptions = {
  statePath: process.env.STATE_PATH ?? path.join(os.homedir(), ".config", "hermes-gateway"),
  json: false,
};

// -----------------------------------------------------------------------------
// ANSI Color Codes
// -----------------------------------------------------------------------------

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

function colorize(text: string, color: keyof typeof COLORS): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function formatHeader(text: string): string {
  return `${colorize(text, "bold")}\n${colorize("─".repeat(80), "gray")}`;
}

function formatKeyValue(key: string, value: string, keyWidth: number = 16): string {
  return `  ${colorize(key.padEnd(keyWidth), "cyan")} ${value}`;
}

function formatError(message: string): string {
  return `${colorize("✗", "red")} ${colorize(message, "red")}`;
}

function formatSuccess(message: string): string {
  return `${colorize("✓", "green")} ${message}`;
}

function formatWarning(message: string): string {
  return `${colorize("⚠", "yellow")} ${colorize(message, "yellow")}`;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// -----------------------------------------------------------------------------
// Command Handlers
// -----------------------------------------------------------------------------

/**
 * Handles the 'pair' command - approves a pending device.
 */
export async function handlePairCommand(
  deviceId: string,
  options: Partial<PairingCliOptions>
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const store = new PairingStore(opts.statePath);

  try {
    await store.load();

    // Check if already paired
    const isPaired = await store.isPaired(deviceId);
    if (isPaired) {
      if (opts.json) {
        console.log(JSON.stringify({ error: "Device already paired", deviceId }));
      } else {
        console.log(formatWarning(`Device ${deviceId} is already paired`));
      }
      return;
    }

    // Try to approve from pending
    const device = await store.approvePendingDevice(deviceId);

    if (device !== undefined) {
      if (opts.json) {
        console.log(JSON.stringify({ success: true, device }));
      } else {
        console.log(formatSuccess(`Device ${deviceId} approved`));
        console.log("");
        console.log(formatKeyValue("Hostname:", device.nodeInfo.hostname));
        console.log(formatKeyValue("Platform:", device.nodeInfo.platform));
        console.log(formatKeyValue("Paired at:", new Date(device.pairedAtMs).toLocaleString()));
      }
      return;
    }

    // Device not in pending list - show error with helpful message
    if (opts.json) {
      console.log(JSON.stringify({ error: "Device not found in pending list", deviceId }));
    } else {
      console.error(formatError(`Device ${deviceId} not found in pending list`));
      console.error("");
      console.error(colorize("The device must attempt to connect first before it can be approved.", "dim"));
      console.error(colorize("Run 'hermes pending' to see devices awaiting approval.", "dim"));
    }
    process.exit(1);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      console.log(JSON.stringify({ error: errorMsg }));
    } else {
      console.error(formatError(errorMsg));
    }
    process.exit(1);
  }
}

/**
 * Handles the 'unpair' command - revokes a device.
 */
export async function handleUnpairCommand(
  deviceId: string,
  options: Partial<PairingCliOptions>
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const store = new PairingStore(opts.statePath);

  try {
    await store.load();

    const revoked = await store.revokePairing(deviceId);

    if (revoked) {
      if (opts.json) {
        console.log(JSON.stringify({ success: true, deviceId }));
      } else {
        console.log(formatSuccess(`Device ${deviceId} revoked`));
      }
      return;
    }

    // Device not found
    if (opts.json) {
      console.log(JSON.stringify({ error: "Device not found", deviceId }));
    } else {
      console.error(formatError(`Device ${deviceId} not found in paired devices`));
      console.error("");
      console.error(colorize("Run 'hermes paired' to see all paired devices.", "dim"));
    }
    process.exit(1);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      console.log(JSON.stringify({ error: errorMsg }));
    } else {
      console.error(formatError(errorMsg));
    }
    process.exit(1);
  }
}

/**
 * Handles the 'pending' command - lists devices awaiting approval.
 */
export async function handlePendingCommand(
  options: Partial<PairingCliOptions>
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const store = new PairingStore(opts.statePath);

  try {
    await store.load();

    const devices = await store.getPendingDevices();

    // JSON output
    if (opts.json) {
      console.log(JSON.stringify(devices, null, 2));
      return;
    }

    // Human-readable output
    if (devices.length === 0) {
      console.log(formatWarning("No pending devices"));
      return;
    }

    console.log(formatHeader(`Pending Devices (${devices.length})`));
    console.log("");

    for (const device of devices) {
      const requestedAt = new Date(device.requestedAtMs);
      const ago = formatUptime(Date.now() - device.requestedAtMs);

      console.log(colorize(`○ ${device.deviceId}`, "yellow"));
      console.log(formatKeyValue("Hostname:", device.nodeInfo.hostname));
      console.log(formatKeyValue("Platform:", device.nodeInfo.platform));
      console.log(formatKeyValue("Requested:", `${requestedAt.toLocaleString()} (${ago} ago)`));
      console.log(formatKeyValue("Approve:", colorize(`hermes pair ${device.deviceId}`, "cyan")));
      console.log("");
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      console.log(JSON.stringify({ error: errorMsg }));
    } else {
      console.error(formatError(errorMsg));
    }
    process.exit(1);
  }
}

/**
 * Handles the 'paired' command - lists all paired devices.
 */
export async function handlePairedCommand(
  options: Partial<PairingCliOptions>
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const store = new PairingStore(opts.statePath);

  try {
    await store.load();

    const devices = await store.listPairedDevices();

    // JSON output
    if (opts.json) {
      console.log(JSON.stringify(devices, null, 2));
      return;
    }

    // Human-readable output
    if (devices.length === 0) {
      console.log(formatWarning("No paired devices"));
      return;
    }

    console.log(formatHeader(`Paired Devices (${devices.length})`));
    console.log("");

    for (const device of devices) {
      const pairedAt = new Date(device.pairedAtMs);
      const lastSeen = device.lastSeenAtMs !== undefined
        ? new Date(device.lastSeenAtMs).toLocaleString()
        : "never";

      console.log(colorize(`● ${device.deviceId}`, "green"));
      console.log(formatKeyValue("Hostname:", device.nodeInfo.hostname));
      console.log(formatKeyValue("Platform:", device.nodeInfo.platform));
      console.log(formatKeyValue("Paired:", pairedAt.toLocaleString()));
      console.log(formatKeyValue("Last seen:", lastSeen));
      console.log(formatKeyValue("Revoke:", colorize(`hermes unpair ${device.deviceId}`, "cyan")));
      console.log("");
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      console.log(JSON.stringify({ error: errorMsg }));
    } else {
      console.error(formatError(errorMsg));
    }
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// Exports for CLI integration
// -----------------------------------------------------------------------------

export type { PairingCliOptions };
