/**
 * Gateway Types
 *
 * Type definitions for the Gateway WebSocket server.
 */

import type { WebSocket } from "ws";
import type { NodeInfo } from "../protocol/types.js";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/**
 * Gateway server configuration.
 */
export interface GatewayConfig {
  port: number;
  host: string;
  /** Path for state storage (paired devices, etc.) */
  statePath?: string;
  /** Auto-approve new devices (for development/testing) */
  autoApprove?: boolean;
}

/**
 * Default gateway configuration.
 */
export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  port: 18789,
  host: "0.0.0.0",
  autoApprove: false,
};

// -----------------------------------------------------------------------------
// Connection State
// -----------------------------------------------------------------------------

/**
 * Authentication state for a connection.
 */
export type AuthState = "pending" | "challenged" | "authenticated" | "failed";

/**
 * Connected node information tracked by the gateway.
 */
export interface ConnectedNode {
  deviceId: string;
  nodeInfo: NodeInfo;
  publicKey: string;
  socket: WebSocket;
  connectedAtMs: number;
  authState: AuthState;
  challenge?: string;
  lastPingMs?: number;
  lastPongMs?: number;
}

// -----------------------------------------------------------------------------
// Handshake Messages
// -----------------------------------------------------------------------------

/**
 * Parameters for node.hello request.
 */
export interface NodeHelloParams {
  nodeInfo: NodeInfo;
  publicKey: string;
}

/**
 * Response payload for node.hello.
 */
export interface NodeHelloResponse {
  challenge: string;
}

/**
 * Parameters for node.auth request.
 */
export interface NodeAuthParams {
  signature: string;
}

/**
 * Response payload for node.auth.
 */
export interface NodeAuthResponse {
  deviceId: string;
  message: string;
}

// -----------------------------------------------------------------------------
// Type Guards
// -----------------------------------------------------------------------------

/**
 * Type guard for NodeHelloParams.
 */
export function isNodeHelloParams(params: unknown): params is NodeHelloParams {
  if (typeof params !== "object" || params === null) {
    return false;
  }

  const p = params as Record<string, unknown>;

  if (!("nodeInfo" in p) || typeof p.nodeInfo !== "object" || p.nodeInfo === null) {
    return false;
  }

  const nodeInfo = p.nodeInfo as Record<string, unknown>;
  if (
    typeof nodeInfo.nodeId !== "string" ||
    typeof nodeInfo.platform !== "string" ||
    typeof nodeInfo.hostname !== "string"
  ) {
    return false;
  }

  if (!("publicKey" in p) || typeof p.publicKey !== "string") {
    return false;
  }

  return true;
}

/**
 * Type guard for NodeAuthParams.
 */
export function isNodeAuthParams(params: unknown): params is NodeAuthParams {
  if (typeof params !== "object" || params === null) {
    return false;
  }

  const p = params as Record<string, unknown>;

  return "signature" in p && typeof p.signature === "string";
}

// -----------------------------------------------------------------------------
// Node Invoke Types
// -----------------------------------------------------------------------------

/**
 * Parameters for node.invoke request.
 */
export interface NodeInvokeParams {
  targetNodeId: string;
  method: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}

/**
 * Response payload for node.invoke.
 */
export interface NodeInvokeResponse {
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Type guard for NodeInvokeParams.
 */
export function isNodeInvokeParams(params: unknown): params is NodeInvokeParams {
  if (typeof params !== "object" || params === null) {
    return false;
  }

  const p = params as Record<string, unknown>;

  if (typeof p.targetNodeId !== "string" || p.targetNodeId.length === 0) {
    return false;
  }

  if (typeof p.method !== "string" || p.method.length === 0) {
    return false;
  }

  // timeoutMs is optional but must be a positive number if present
  if (p.timeoutMs !== undefined) {
    if (typeof p.timeoutMs !== "number" || p.timeoutMs <= 0) {
      return false;
    }
  }

  // idempotencyKey is optional but must be a non-empty string if present
  if (p.idempotencyKey !== undefined) {
    if (typeof p.idempotencyKey !== "string" || p.idempotencyKey.length === 0) {
      return false;
    }
  }

  return true;
}
