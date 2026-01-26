/**
 * Device Identity Module
 *
 * Manages Ed25519 keypair generation and persistence for device authentication.
 * Each machine gets a unique device ID derived from its public key.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Device identity containing keypair and derived device ID.
 * Keys are base64 encoded for JSON storage.
 */
export interface DeviceIdentity {
  publicKey: string;
  privateKey: string;
  deviceId: string;
}

/**
 * Stored identity format with version for future migrations.
 */
interface StoredIdentity {
  version: 1;
  publicKey: string;
  privateKey: string;
  deviceId: string;
  createdAtMs: number;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const IDENTITY_VERSION = 1;
const DEVICE_ID_LENGTH = 8;
const IDENTITY_FILE_MODE = 0o600;

// -----------------------------------------------------------------------------
// Key Generation
// -----------------------------------------------------------------------------

/**
 * Generates a new Ed25519 keypair.
 * Returns keys as base64-encoded raw bytes.
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  // Export as raw bytes (DER format) and encode as base64
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" });

  return {
    publicKey: publicKeyDer.toString("base64"),
    privateKey: privateKeyDer.toString("base64"),
  };
}

// -----------------------------------------------------------------------------
// Device ID Derivation
// -----------------------------------------------------------------------------

/**
 * Derives a short, readable device ID from a public key.
 * Uses first 8 characters of base64-encoded public key hash.
 *
 * @param publicKey - Base64-encoded public key (SPKI DER format)
 * @returns Short device ID (8 characters, alphanumeric)
 */
export function deriveDeviceId(publicKey: string): string {
  const publicKeyBuffer = Buffer.from(publicKey, "base64");
  const hash = crypto.createHash("sha256").update(publicKeyBuffer).digest("base64");

  // Use URL-safe base64 characters for the ID
  const urlSafe = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return urlSafe.slice(0, DEVICE_ID_LENGTH);
}

// -----------------------------------------------------------------------------
// Signing and Verification
// -----------------------------------------------------------------------------

/**
 * Signs a message using the private key.
 *
 * @param message - Message to sign (string or Buffer)
 * @param privateKey - Base64-encoded private key (PKCS8 DER format)
 * @returns Base64-encoded signature
 */
export function signMessage(message: string | Buffer, privateKey: string): string {
  const privateKeyBuffer = Buffer.from(privateKey, "base64");
  const key = crypto.createPrivateKey({
    key: privateKeyBuffer,
    type: "pkcs8",
    format: "der",
  });

  const messageBuffer = typeof message === "string" ? Buffer.from(message, "utf8") : message;
  const signature = crypto.sign(null, messageBuffer, key);

  return signature.toString("base64");
}

/**
 * Verifies a signature against a message and public key.
 *
 * @param message - Original message (string or Buffer)
 * @param signature - Base64-encoded signature
 * @param publicKey - Base64-encoded public key (SPKI DER format)
 * @returns true if signature is valid, false otherwise
 */
export function verifySignature(
  message: string | Buffer,
  signature: string,
  publicKey: string
): boolean {
  try {
    const publicKeyBuffer = Buffer.from(publicKey, "base64");
    const key = crypto.createPublicKey({
      key: publicKeyBuffer,
      type: "spki",
      format: "der",
    });

    const messageBuffer = typeof message === "string" ? Buffer.from(message, "utf8") : message;
    const signatureBuffer = Buffer.from(signature, "base64");

    return crypto.verify(null, messageBuffer, key, signatureBuffer);
  } catch {
    // Invalid key format or signature
    return false;
  }
}

// -----------------------------------------------------------------------------
// Identity Persistence
// -----------------------------------------------------------------------------

/**
 * Loads existing identity or generates a new one.
 * Identity is persisted to `{statePath}/identity/device.json`.
 *
 * @param statePath - Base path for state storage (e.g., "./state")
 * @returns Device identity with keypair and device ID
 * @throws Error if file operations fail (permissions, disk full, etc.)
 */
export async function getOrCreateIdentity(statePath: string): Promise<DeviceIdentity> {
  const identityDir = path.join(statePath, "identity");
  const identityFile = path.join(identityDir, "device.json");

  // Try to load existing identity
  const existingIdentity = await loadIdentity(identityFile);
  if (existingIdentity !== undefined) {
    return existingIdentity;
  }

  // Generate new identity
  const { publicKey, privateKey } = generateKeyPair();
  const deviceId = deriveDeviceId(publicKey);

  const identity: DeviceIdentity = {
    publicKey,
    privateKey,
    deviceId,
  };

  // Persist to disk
  await saveIdentity(identityFile, identity);

  return identity;
}

/**
 * Loads identity from file if it exists and is valid.
 */
async function loadIdentity(filePath: string): Promise<DeviceIdentity | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const stored = JSON.parse(content) as unknown;

    if (!isValidStoredIdentity(stored)) {
      return undefined;
    }

    // Verify device ID matches public key
    const derivedId = deriveDeviceId(stored.publicKey);
    if (derivedId !== stored.deviceId) {
      // Device ID mismatch - regenerate to fix
      return undefined;
    }

    return {
      publicKey: stored.publicKey,
      privateKey: stored.privateKey,
      deviceId: stored.deviceId,
    };
  } catch (error) {
    // File doesn't exist or is invalid
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    // Log other errors but continue with regeneration
    console.error("Failed to load identity, will regenerate:", error);
    return undefined;
  }
}

/**
 * Saves identity to file with restricted permissions.
 */
async function saveIdentity(filePath: string, identity: DeviceIdentity): Promise<void> {
  const dir = path.dirname(filePath);

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const stored: StoredIdentity = {
    version: IDENTITY_VERSION,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    deviceId: identity.deviceId,
    createdAtMs: Date.now(),
  };

  const content = JSON.stringify(stored, null, 2) + "\n";

  // Write with restricted permissions (owner read/write only)
  await fs.writeFile(filePath, content, { mode: IDENTITY_FILE_MODE });

  // Ensure permissions are set (writeFile mode may be affected by umask)
  try {
    await fs.chmod(filePath, IDENTITY_FILE_MODE);
  } catch {
    // Best effort - some filesystems don't support chmod
  }
}

// -----------------------------------------------------------------------------
// Type Guards
// -----------------------------------------------------------------------------

function isValidStoredIdentity(value: unknown): value is StoredIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    obj.version === IDENTITY_VERSION &&
    typeof obj.publicKey === "string" &&
    typeof obj.privateKey === "string" &&
    typeof obj.deviceId === "string" &&
    typeof obj.createdAtMs === "number"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
