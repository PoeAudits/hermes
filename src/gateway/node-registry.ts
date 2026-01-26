/**
 * Node Registry
 *
 * Tracks connected nodes, their capabilities, and orchestrates the node.invoke
 * RPC pattern for routing commands to specific nodes.
 *
 * Key features:
 * - Register/unregister nodes with metadata
 * - Invoke commands on specific nodes with timeout and idempotency support
 * - Handle node disconnection during pending invokes
 * - Idempotency key cache with automatic expiration
 */

import crypto from "node:crypto";
import type { WebSocket } from "ws";
import type { NodeInfo, Event } from "../protocol/types.js";
import type { ConnectedNode } from "./types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;
const IDEMPOTENCY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60_000; // Clean up every minute
const MAX_IDEMPOTENCY_CACHE_SIZE = 10_000; // Prevent unbounded growth

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Extended node information tracked by the registry.
 */
export interface NodeSession {
  deviceId: string;
  nodeInfo: NodeInfo;
  publicKey: string;
  socket: WebSocket;
  connectedAtMs: number;
  capabilities: string[];
}

/**
 * Result of a node invoke operation.
 */
export interface NodeInvokeResult {
  ok: boolean;
  payload?: unknown;
  error?: NodeInvokeError;
}

/**
 * Error details from a failed invoke.
 */
export interface NodeInvokeError {
  code: string;
  message: string;
}

/**
 * Options for invoking a command on a node.
 */
export interface InvokeOptions {
  timeoutMs?: number;
  idempotencyKey?: string;
}

/**
 * Payload sent to target node for invoke request.
 */
export interface NodeInvokeRequestPayload {
  id: string;
  method: string;
  params: unknown;
  idempotencyKey?: string;
}

/**
 * Payload received from target node for invoke response.
 */
export interface NodeInvokeResponsePayload {
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: NodeInvokeError;
}

/**
 * Internal tracking for pending invoke operations.
 */
interface PendingInvoke {
  deviceId: string;
  method: string;
  resolve: (result: NodeInvokeResult) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAtMs: number;
}

/**
 * Cached idempotency result.
 */
interface IdempotencyEntry {
  result: NodeInvokeResult;
  expiresAtMs: number;
}

/**
 * Logger interface for registry operations.
 */
export interface RegistryLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

/**
 * Node status for listing.
 */
export interface NodeStatus {
  deviceId: string;
  nodeInfo: NodeInfo;
  connectedAtMs: number;
  capabilities: string[];
  online: boolean;
}

// -----------------------------------------------------------------------------
// Type Guards
// -----------------------------------------------------------------------------

/**
 * Type guard for NodeInvokeResponsePayload.
 */
export function isNodeInvokeResponsePayload(
  payload: unknown
): payload is NodeInvokeResponsePayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const p = payload as Record<string, unknown>;

  if (typeof p.id !== "string") {
    return false;
  }

  if (typeof p.ok !== "boolean") {
    return false;
  }

  // error is optional but must have correct shape if present
  if (p.error !== undefined && p.error !== null) {
    if (typeof p.error !== "object") {
      return false;
    }
    const err = p.error as Record<string, unknown>;
    if (typeof err.code !== "string" || typeof err.message !== "string") {
      return false;
    }
  }

  return true;
}

// -----------------------------------------------------------------------------
// Node Registry Implementation
// -----------------------------------------------------------------------------

/**
 * Registry for tracking connected nodes and routing commands.
 *
 * Thread-safety: This implementation is designed for single-threaded Node.js
 * execution. All async operations use Promises which execute on the event loop.
 */
export class NodeRegistry {
  private readonly nodes: Map<string, NodeSession> = new Map();
  private readonly pendingInvokes: Map<string, PendingInvoke> = new Map();
  private readonly idempotencyCache: Map<string, IdempotencyEntry> = new Map();
  private readonly logger: RegistryLogger;
  private eventSeq: number = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(logger: RegistryLogger) {
    this.logger = logger;
    this.startIdempotencyCleanup();
  }

  /**
   * Starts the periodic cleanup of expired idempotency entries.
   */
  private startIdempotencyCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredIdempotencyEntries();
    }, IDEMPOTENCY_CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    if (this.cleanupTimer.unref !== undefined) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stops the cleanup timer. Call when shutting down.
   */
  shutdown(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Reject all pending invokes
    for (const [id, pending] of this.pendingInvokes.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        error: { code: "SHUTDOWN", message: "registry shutting down" },
      });
      this.pendingInvokes.delete(id);
    }
  }

  /**
   * Removes expired entries from the idempotency cache.
   */
  private cleanupExpiredIdempotencyEntries(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.idempotencyCache.entries()) {
      if (entry.expiresAtMs <= now) {
        this.idempotencyCache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug?.(`Cleaned up ${removed} expired idempotency entries`);
    }
  }

  // ---------------------------------------------------------------------------
  // Node Registration
  // ---------------------------------------------------------------------------

  /**
   * Registers a node in the registry.
   *
   * If a node with the same deviceId is already registered, the old connection
   * is closed and replaced with the new one.
   *
   * @param node - The connected node to register
   * @returns The created NodeSession
   */
  registerNode(node: ConnectedNode): NodeSession {
    const existing = this.nodes.get(node.deviceId);
    if (existing !== undefined) {
      this.logger.warn(
        `Replacing existing connection for device ${node.deviceId}`
      );
      // Close the old connection
      try {
        existing.socket.close(1000, "replaced by new connection");
      } catch {
        // Ignore close errors
      }
      // Reject pending invokes for the old connection
      this.rejectPendingInvokesForNode(node.deviceId, "connection replaced");
    }

    const session: NodeSession = {
      deviceId: node.deviceId,
      nodeInfo: node.nodeInfo,
      publicKey: node.publicKey,
      socket: node.socket,
      connectedAtMs: node.connectedAtMs,
      capabilities: [], // Can be extended later with capability negotiation
    };

    this.nodes.set(node.deviceId, session);
    this.logger.info(
      `Node registered: ${node.deviceId} (${node.nodeInfo.hostname})`
    );

    return session;
  }

  /**
   * Unregisters a node from the registry.
   *
   * Also rejects any pending invokes for this node.
   *
   * @param deviceId - The device ID to unregister
   * @returns true if the node was found and removed, false otherwise
   */
  unregisterNode(deviceId: string): boolean {
    const node = this.nodes.get(deviceId);
    if (node === undefined) {
      return false;
    }

    this.nodes.delete(deviceId);
    this.rejectPendingInvokesForNode(deviceId, "node disconnected");
    this.logger.info(`Node unregistered: ${deviceId}`);

    return true;
  }

  /**
   * Gets a node by device ID if it's online.
   *
   * @param deviceId - The device ID to look up
   * @returns The NodeSession if found and online, undefined otherwise
   */
  getNode(deviceId: string): NodeSession | undefined {
    return this.nodes.get(deviceId);
  }

  /**
   * Lists all connected nodes with their status.
   *
   * @returns Array of NodeStatus objects
   */
  listNodes(): NodeStatus[] {
    const result: NodeStatus[] = [];

    for (const session of this.nodes.values()) {
      result.push({
        deviceId: session.deviceId,
        nodeInfo: session.nodeInfo,
        connectedAtMs: session.connectedAtMs,
        capabilities: session.capabilities,
        online: true,
      });
    }

    // Sort by hostname for consistent ordering
    result.sort((a, b) =>
      a.nodeInfo.hostname.localeCompare(b.nodeInfo.hostname)
    );

    return result;
  }

  /**
   * Returns the number of connected nodes.
   */
  size(): number {
    return this.nodes.size;
  }

  // ---------------------------------------------------------------------------
  // Node Invoke
  // ---------------------------------------------------------------------------

  /**
   * Invokes a method on a target node and waits for the response.
   *
   * The invoke flow:
   * 1. Check if node is connected
   * 2. Check idempotency cache for duplicate request
   * 3. Send node.invoke.request event to target node
   * 4. Wait for node.invoke.response event or timeout
   * 5. Cache result if idempotency key provided
   *
   * @param targetNodeId - The device ID of the target node
   * @param method - The method to invoke
   * @param params - Parameters to pass to the method
   * @param options - Optional timeout and idempotency settings
   * @returns Promise resolving to the invoke result
   */
  async invoke(
    targetNodeId: string,
    method: string,
    params: unknown,
    options: InvokeOptions = {}
  ): Promise<NodeInvokeResult> {
    const { timeoutMs = DEFAULT_INVOKE_TIMEOUT_MS, idempotencyKey } = options;

    // Check idempotency cache first
    if (idempotencyKey !== undefined) {
      const cached = this.idempotencyCache.get(idempotencyKey);
      if (cached !== undefined && cached.expiresAtMs > Date.now()) {
        this.logger.debug?.(
          `Returning cached result for idempotency key: ${idempotencyKey}`
        );
        return cached.result;
      }
    }

    // Check if node is connected
    const node = this.nodes.get(targetNodeId);
    if (node === undefined) {
      const result: NodeInvokeResult = {
        ok: false,
        error: { code: "NOT_FOUND", message: "node not connected" },
      };
      return result;
    }

    // Generate unique request ID
    const requestId = crypto.randomUUID();

    // Create the invoke request payload
    const invokePayload: NodeInvokeRequestPayload = {
      id: requestId,
      method,
      params,
    };

    if (idempotencyKey !== undefined) {
      invokePayload.idempotencyKey = idempotencyKey;
    }

    // Send the invoke request event to the target node
    const sent = this.sendEventToNode(
      node,
      "node.invoke.request",
      invokePayload
    );

    if (!sent) {
      const result: NodeInvokeResult = {
        ok: false,
        error: { code: "SEND_FAILED", message: "failed to send invoke request" },
      };
      return result;
    }

    // Wait for response with timeout
    return new Promise<NodeInvokeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        const result: NodeInvokeResult = {
          ok: false,
          error: { code: "TIMEOUT", message: `invoke timed out after ${timeoutMs}ms` },
        };

        // Don't cache timeout results - they might succeed on retry
        resolve(result);
      }, timeoutMs);

      const pending: PendingInvoke = {
        deviceId: targetNodeId,
        method,
        resolve: (result: NodeInvokeResult) => {
          // Cache successful results if idempotency key provided
          if (idempotencyKey !== undefined && result.ok) {
            this.cacheIdempotencyResult(idempotencyKey, result);
          }
          resolve(result);
        },
        timer,
        createdAtMs: Date.now(),
      };

      this.pendingInvokes.set(requestId, pending);
    });
  }

  /**
   * Handles an invoke response from a node.
   *
   * Called when a node sends a node.invoke.response event.
   *
   * @param deviceId - The device ID of the responding node
   * @param payload - The response payload
   * @returns true if the response was matched to a pending invoke, false otherwise
   */
  handleInvokeResponse(
    deviceId: string,
    payload: NodeInvokeResponsePayload
  ): boolean {
    const pending = this.pendingInvokes.get(payload.id);

    if (pending === undefined) {
      // Late response after timeout - ignore
      this.logger.debug?.(
        `Ignoring late invoke response: ${payload.id} from ${deviceId}`
      );
      return false;
    }

    // Verify the response is from the expected node
    if (pending.deviceId !== deviceId) {
      this.logger.warn(
        `Invoke response from wrong node: expected ${pending.deviceId}, got ${deviceId}`
      );
      return false;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timer);
    this.pendingInvokes.delete(payload.id);

    // Resolve the pending invoke
    const result: NodeInvokeResult = {
      ok: payload.ok,
      payload: payload.payload,
      error: payload.error,
    };

    pending.resolve(result);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Event Sending
  // ---------------------------------------------------------------------------

  /**
   * Sends an event to a specific node.
   *
   * @param deviceId - The device ID of the target node
   * @param event - The event name
   * @param payload - The event payload
   * @returns true if the event was sent, false if node not found or send failed
   */
  sendEvent(deviceId: string, event: string, payload: unknown): boolean {
    const node = this.nodes.get(deviceId);
    if (node === undefined) {
      return false;
    }
    return this.sendEventToNode(node, event, payload);
  }

  /**
   * Broadcasts an event to all connected nodes.
   *
   * @param event - The event name
   * @param payload - The event payload
   * @returns Number of nodes the event was sent to
   */
  broadcast(event: string, payload: unknown): number {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (this.sendEventToNode(node, event, payload)) {
        count++;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Sends an event to a node session.
   */
  private sendEventToNode(
    node: NodeSession,
    event: string,
    payload: unknown
  ): boolean {
    try {
      const seq = ++this.eventSeq;
      const message: Event = {
        type: "event",
        event,
        seq,
        payload,
      };
      node.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send event to ${node.deviceId}: ${String(error)}`
      );
      return false;
    }
  }

  /**
   * Rejects all pending invokes for a specific node.
   */
  private rejectPendingInvokesForNode(deviceId: string, reason: string): void {
    for (const [id, pending] of this.pendingInvokes.entries()) {
      if (pending.deviceId !== deviceId) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pendingInvokes.delete(id);

      pending.resolve({
        ok: false,
        error: {
          code: "DISCONNECTED",
          message: `${reason} during invoke of ${pending.method}`,
        },
      });
    }
  }

  /**
   * Caches an idempotency result.
   */
  private cacheIdempotencyResult(key: string, result: NodeInvokeResult): void {
    // Enforce cache size limit
    if (this.idempotencyCache.size >= MAX_IDEMPOTENCY_CACHE_SIZE) {
      // Remove oldest entries by expiration time (first 10%)
      const toRemove = Math.floor(MAX_IDEMPOTENCY_CACHE_SIZE * 0.1);
      
      // Sort entries by expiration time (oldest first)
      const sortedEntries = Array.from(this.idempotencyCache.entries()).sort(
        (a, b) => a[1].expiresAtMs - b[1].expiresAtMs
      );
      
      // Remove the oldest entries
      for (let i = 0; i < toRemove && i < sortedEntries.length; i++) {
        const entry = sortedEntries[i];
        if (entry !== undefined) {
          this.idempotencyCache.delete(entry[0]);
        }
      }
      
      this.logger.warn(
        `Idempotency cache full, removed ${toRemove} oldest entries`
      );
    }

    this.idempotencyCache.set(key, {
      result,
      expiresAtMs: Date.now() + IDEMPOTENCY_CACHE_TTL_MS,
    });
  }

  // ---------------------------------------------------------------------------
  // Testing Helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the number of pending invokes (for testing).
   */
  getPendingInvokeCount(): number {
    return this.pendingInvokes.size;
  }

  /**
   * Returns the idempotency cache size (for testing).
   */
  getIdempotencyCacheSize(): number {
    return this.idempotencyCache.size;
  }
}
