/**
 * Device Identity Tests
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  generateKeyPair,
  deriveDeviceId,
  signMessage,
  verifySignature,
  getOrCreateIdentity,
} from "./device.js";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  const tempBase = path.join(os.tmpdir(), "hermes-identity-test");
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

// -----------------------------------------------------------------------------
// Key Generation Tests
// -----------------------------------------------------------------------------

describe("generateKeyPair", () => {
  test("produces valid keypair", () => {
    const { publicKey, privateKey } = generateKeyPair();

    // Keys should be non-empty base64 strings
    expect(publicKey).toBeTruthy();
    expect(privateKey).toBeTruthy();
    expect(typeof publicKey).toBe("string");
    expect(typeof privateKey).toBe("string");

    // Should be valid base64
    expect(() => Buffer.from(publicKey, "base64")).not.toThrow();
    expect(() => Buffer.from(privateKey, "base64")).not.toThrow();
  });

  test("produces unique keypairs on each call", () => {
    const keypair1 = generateKeyPair();
    const keypair2 = generateKeyPair();

    expect(keypair1.publicKey).not.toBe(keypair2.publicKey);
    expect(keypair1.privateKey).not.toBe(keypair2.privateKey);
  });

  test("produces keys that can be imported by crypto module", () => {
    const { publicKey, privateKey } = generateKeyPair();

    // Should be able to import as crypto keys
    const publicKeyObj = crypto.createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      type: "spki",
      format: "der",
    });

    const privateKeyObj = crypto.createPrivateKey({
      key: Buffer.from(privateKey, "base64"),
      type: "pkcs8",
      format: "der",
    });

    expect(publicKeyObj.asymmetricKeyType).toBe("ed25519");
    expect(privateKeyObj.asymmetricKeyType).toBe("ed25519");
  });
});

// -----------------------------------------------------------------------------
// Device ID Derivation Tests
// -----------------------------------------------------------------------------

describe("deriveDeviceId", () => {
  test("produces 8-character ID", () => {
    const { publicKey } = generateKeyPair();
    const deviceId = deriveDeviceId(publicKey);

    expect(deviceId.length).toBe(8);
  });

  test("produces consistent ID for same public key", () => {
    const { publicKey } = generateKeyPair();
    const deviceId1 = deriveDeviceId(publicKey);
    const deviceId2 = deriveDeviceId(publicKey);

    expect(deviceId1).toBe(deviceId2);
  });

  test("produces different IDs for different public keys", () => {
    const keypair1 = generateKeyPair();
    const keypair2 = generateKeyPair();

    const deviceId1 = deriveDeviceId(keypair1.publicKey);
    const deviceId2 = deriveDeviceId(keypair2.publicKey);

    expect(deviceId1).not.toBe(deviceId2);
  });

  test("produces URL-safe characters only", () => {
    const { publicKey } = generateKeyPair();
    const deviceId = deriveDeviceId(publicKey);

    // Should only contain alphanumeric, dash, and underscore
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// -----------------------------------------------------------------------------
// Sign/Verify Tests
// -----------------------------------------------------------------------------

describe("signMessage and verifySignature", () => {
  test("sign/verify round-trip succeeds", () => {
    const { publicKey, privateKey } = generateKeyPair();
    const message = "Hello, World!";

    const signature = signMessage(message, privateKey);
    const isValid = verifySignature(message, signature, publicKey);

    expect(isValid).toBe(true);
  });

  test("sign/verify works with Buffer message", () => {
    const { publicKey, privateKey } = generateKeyPair();
    const message = Buffer.from([0x01, 0x02, 0x03, 0x04]);

    const signature = signMessage(message, privateKey);
    const isValid = verifySignature(message, signature, publicKey);

    expect(isValid).toBe(true);
  });

  test("verify fails with wrong public key", () => {
    const keypair1 = generateKeyPair();
    const keypair2 = generateKeyPair();
    const message = "Hello, World!";

    const signature = signMessage(message, keypair1.privateKey);
    const isValid = verifySignature(message, signature, keypair2.publicKey);

    expect(isValid).toBe(false);
  });

  test("verify fails with modified message", () => {
    const { publicKey, privateKey } = generateKeyPair();
    const message = "Hello, World!";
    const modifiedMessage = "Hello, World?";

    const signature = signMessage(message, privateKey);
    const isValid = verifySignature(modifiedMessage, signature, publicKey);

    expect(isValid).toBe(false);
  });

  test("verify fails with invalid signature", () => {
    const { publicKey } = generateKeyPair();
    const message = "Hello, World!";
    const invalidSignature = Buffer.alloc(64).toString("base64");

    const isValid = verifySignature(message, invalidSignature, publicKey);

    expect(isValid).toBe(false);
  });

  test("verify fails with malformed public key", () => {
    const message = "Hello, World!";
    const invalidPublicKey = "not-a-valid-key";
    const signature = "some-signature";

    const isValid = verifySignature(message, signature, invalidPublicKey);

    expect(isValid).toBe(false);
  });

  test("signature is base64 encoded", () => {
    const { privateKey } = generateKeyPair();
    const message = "Hello, World!";

    const signature = signMessage(message, privateKey);

    // Should be valid base64
    expect(() => Buffer.from(signature, "base64")).not.toThrow();
    // Ed25519 signatures are 64 bytes
    expect(Buffer.from(signature, "base64").length).toBe(64);
  });
});

// -----------------------------------------------------------------------------
// Identity Persistence Tests
// -----------------------------------------------------------------------------

describe("getOrCreateIdentity", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  test("creates new identity on first run", async () => {
    const identity = await getOrCreateIdentity(tempDir);

    expect(identity.publicKey).toBeTruthy();
    expect(identity.privateKey).toBeTruthy();
    expect(identity.deviceId).toBeTruthy();
    expect(identity.deviceId.length).toBe(8);
  });

  test("loads existing identity on subsequent runs", async () => {
    const identity1 = await getOrCreateIdentity(tempDir);
    const identity2 = await getOrCreateIdentity(tempDir);

    expect(identity2.publicKey).toBe(identity1.publicKey);
    expect(identity2.privateKey).toBe(identity1.privateKey);
    expect(identity2.deviceId).toBe(identity1.deviceId);
  });

  test("creates identity directory if it does not exist", async () => {
    const nestedPath = path.join(tempDir, "nested", "state");
    const identity = await getOrCreateIdentity(nestedPath);

    expect(identity.publicKey).toBeTruthy();

    // Verify file was created
    const identityFile = path.join(nestedPath, "identity", "device.json");
    const stat = await fs.stat(identityFile);
    expect(stat.isFile()).toBe(true);
  });

  test("persists identity to correct file path", async () => {
    await getOrCreateIdentity(tempDir);

    const identityFile = path.join(tempDir, "identity", "device.json");
    const content = await fs.readFile(identityFile, "utf8");
    const stored = JSON.parse(content);

    expect(stored.version).toBe(1);
    expect(stored.publicKey).toBeTruthy();
    expect(stored.privateKey).toBeTruthy();
    expect(stored.deviceId).toBeTruthy();
    expect(stored.createdAtMs).toBeGreaterThan(0);
  });

  test("device ID matches derived ID from public key", async () => {
    const identity = await getOrCreateIdentity(tempDir);
    const derivedId = deriveDeviceId(identity.publicKey);

    expect(identity.deviceId).toBe(derivedId);
  });

  test("generated identity can sign and verify", async () => {
    const identity = await getOrCreateIdentity(tempDir);
    const message = "Test message for signing";

    const signature = signMessage(message, identity.privateKey);
    const isValid = verifySignature(message, signature, identity.publicKey);

    expect(isValid).toBe(true);
  });

  test("regenerates identity if file is corrupted", async () => {
    // Create a corrupted identity file
    const identityDir = path.join(tempDir, "identity");
    await fs.mkdir(identityDir, { recursive: true });
    await fs.writeFile(path.join(identityDir, "device.json"), "not valid json");

    // Should regenerate
    const identity = await getOrCreateIdentity(tempDir);

    expect(identity.publicKey).toBeTruthy();
    expect(identity.privateKey).toBeTruthy();
    expect(identity.deviceId).toBeTruthy();
  });

  test("regenerates identity if version is wrong", async () => {
    // Create an identity file with wrong version
    const identityDir = path.join(tempDir, "identity");
    await fs.mkdir(identityDir, { recursive: true });
    await fs.writeFile(
      path.join(identityDir, "device.json"),
      JSON.stringify({
        version: 999,
        publicKey: "test",
        privateKey: "test",
        deviceId: "test1234",
        createdAtMs: Date.now(),
      })
    );

    // Should regenerate
    const identity = await getOrCreateIdentity(tempDir);

    expect(identity.publicKey).not.toBe("test");
    expect(identity.deviceId).not.toBe("test1234");
  });

  test("sets restrictive file permissions", async () => {
    await getOrCreateIdentity(tempDir);

    const identityFile = path.join(tempDir, "identity", "device.json");
    const stat = await fs.stat(identityFile);

    // Check that only owner has read/write (0o600 = 384 in decimal)
    // Note: This may not work on all filesystems (e.g., Windows)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
