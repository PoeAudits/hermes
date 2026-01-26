/**
 * Identity Module
 *
 * Exports device identity management functions for Ed25519 keypair
 * generation, signing, verification, and persistence.
 */

export {
  generateKeyPair,
  deriveDeviceId,
  signMessage,
  verifySignature,
  getOrCreateIdentity,
} from "./device.js";

export type { DeviceIdentity } from "./device.js";

export {
  PairingStore,
  createPairingStore,
} from "./pairing.js";

export type {
  PairedDevice,
  PendingDevice,
  PairingNodeInfo,
  PairingCheckResult,
} from "./pairing.js";
