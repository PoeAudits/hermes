/**
 * WebSocket Connection Handler
 *
 * Handles individual WebSocket connections for the Gateway.
 * Manages the handshake/authentication flow for each node.
 */

import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { deriveDeviceId, verifySignature } from "../identity/device.js";
import {
  createErrorResponse,
  createSuccessResponse,
  isRequest,
  type Request,
} from "../protocol/types.js";
import {
  isNodeAuthParams,
  isNodeHelloParams,
  isNodeInvokeParams,
  type AuthState,
  type ConnectedNode,
  type NodeAuthResponse,
  type NodeHelloResponse,
  type NodeInvokeParams,
} from "./types.js";
import type { NodeRegistry } from "./node-registry.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const CHALLENGE_BYTES = 32;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

// -----------------------------------------------------------------------------
// Logger Interface
// -----------------------------------------------------------------------------

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// -----------------------------------------------------------------------------
// Connection Registry Interface
// -----------------------------------------------------------------------------

export interface ConnectionRegistry {
  add(node: ConnectedNode): void;
  remove(deviceId: string): void;
  get(deviceId: string): ConnectedNode | undefined;
  getAll(): ConnectedNode[];
}

/**
 * Handler for node.invoke requests - allows routing to NodeRegistry.
 */
export type InvokeHandler = (
  params: NodeInvokeParams
) => Promise<{ ok: boolean; payload?: unknown; error?: { code: string; message: string } }>;

/**
 * Handler for node.invoke.response from nodes.
 */
export type InvokeResponseHandler = (deviceId: string, payload: unknown) => boolean;

/**
 * Result of a pairing check.
 */
export type PairingCheckResult =
  | { status: "paired" }
  | { status: "pending"; message: string }
  | { status: "rejected"; reason: string };

/**
 * Handler for checking device pairing status.
 */
export type PairingChecker = (
  deviceId: string,
  publicKey: string,
  nodeInfo: { hostname: string; platform: string; nodeId: string }
) => Promise<PairingCheckResult>;

// -----------------------------------------------------------------------------
// WebSocket Handler
// -----------------------------------------------------------------------------

/**
 * Options for WsHandler construction.
 */
export interface WsHandlerOptions {
  socket: WebSocket;
  registry: ConnectionRegistry;
  logger: Logger;
  /** Handler for node.invoke requests (routes to NodeRegistry.invoke) */
  invokeHandler?: InvokeHandler;
  /** Handler for node.invoke.response from nodes */
  invokeResponseHandler?: InvokeResponseHandler;
  /** Handler for checking device pairing status */
  pairingChecker?: PairingChecker;
}

/**
 * Handles a single WebSocket connection through the authentication flow.
 */
export class WsHandler {
  private readonly socket: WebSocket;
  private readonly registry: ConnectionRegistry;
  private readonly logger: Logger;
  private readonly invokeHandler: InvokeHandler | undefined;
  private readonly invokeResponseHandler: InvokeResponseHandler | undefined;
  private readonly pairingChecker: PairingChecker | undefined;

  private authState: AuthState = "pending";
  private challenge: string | undefined;
  private publicKey: string | undefined;
  private nodeInfo: { nodeId: string; platform: string; hostname: string } | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private connectedAtMs: number;
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
  private lastPingMs: number | undefined;
  private lastPongMs: number | undefined;

  constructor(options: WsHandlerOptions);
  /** @deprecated Use options object instead */
  constructor(socket: WebSocket, registry: ConnectionRegistry, logger: Logger);
  constructor(
    socketOrOptions: WebSocket | WsHandlerOptions,
    registry?: ConnectionRegistry,
    logger?: Logger
  ) {
    // Handle both old and new constructor signatures
    if ("socket" in socketOrOptions) {
      this.socket = socketOrOptions.socket;
      this.registry = socketOrOptions.registry;
      this.logger = socketOrOptions.logger;
      this.invokeHandler = socketOrOptions.invokeHandler;
      this.invokeResponseHandler = socketOrOptions.invokeResponseHandler;
      this.pairingChecker = socketOrOptions.pairingChecker;
    } else {
      this.socket = socketOrOptions;
      this.registry = registry!;
      this.logger = logger!;
      this.invokeHandler = undefined;
      this.invokeResponseHandler = undefined;
      this.pairingChecker = undefined;
    }
    this.connectedAtMs = Date.now();

    this.setupHandlers();
    this.startHandshakeTimeout();
  }

  /**
   * Sets up WebSocket event handlers.
   */
  private setupHandlers(): void {
    this.socket.on("message", (data) => {
      this.handleMessage(data);
    });

    this.socket.on("close", (code, reason) => {
      this.handleClose(code, reason.toString());
    });

    this.socket.on("error", (error) => {
      this.handleError(error);
    });

    this.socket.on("ping", () => {
      this.handlePing();
    });

    this.socket.on("pong", () => {
      this.handlePong();
    });
  }

  /**
   * Starts the handshake timeout timer.
   */
  private startHandshakeTimeout(): void {
    this.handshakeTimer = setTimeout(() => {
      if (this.authState !== "authenticated") {
        this.logger.warn("Handshake timeout - closing connection");
        this.close(1008, "handshake timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  /**
   * Clears the handshake timeout timer.
   */
  private clearHandshakeTimeout(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  /**
   * Handles incoming WebSocket messages.
   */
  private handleMessage(data: unknown): void {
    try {
      const text = typeof data === "string" ? data : data?.toString() ?? "";
      const parsed: unknown = JSON.parse(text);

      if (!isRequest(parsed)) {
        this.sendError("invalid", "invalid message format: expected request");
        return;
      }

      this.handleRequest(parsed);
    } catch (error) {
      this.logger.error(`Failed to parse message: ${String(error)}`);
      this.sendError("invalid", "invalid JSON");
    }
  }

  /**
   * Routes requests to appropriate handlers.
   */
  private handleRequest(req: Request): void {
    switch (req.method) {
      case "node.hello":
        this.handleNodeHello(req);
        break;
      case "node.auth":
        this.handleNodeAuth(req);
        break;
      case "node.invoke":
        if (this.authState !== "authenticated") {
          this.sendError(req.id, "authentication required");
          return;
        }
        void this.handleNodeInvoke(req);
        break;
      case "node.invoke.response":
        if (this.authState !== "authenticated") {
          this.sendError(req.id, "authentication required");
          return;
        }
        this.handleNodeInvokeResponse(req);
        break;
      case "node.list":
        if (this.authState !== "authenticated") {
          this.sendError(req.id, "authentication required");
          return;
        }
        this.handleNodeList(req);
        break;
      default:
        if (this.authState !== "authenticated") {
          this.sendError(req.id, "authentication required");
          return;
        }
        // For now, reject unknown methods
        this.sendError(req.id, `unknown method: ${req.method}`);
    }
  }

  /**
   * Handles node.hello request - first step of handshake.
   * Node sends its info and public key, gateway responds with challenge.
   */
  private handleNodeHello(req: Request): void {
    if (this.authState !== "pending") {
      this.sendError(req.id, "unexpected node.hello: handshake already in progress");
      return;
    }

    if (!isNodeHelloParams(req.params)) {
      this.sendError(req.id, "invalid node.hello params");
      return;
    }

    const { nodeInfo, publicKey } = req.params;

    // Validate public key format by attempting to derive device ID
    const deviceId = deriveDeviceId(publicKey);
    if (deviceId.length === 0) {
      this.sendError(req.id, "invalid public key format");
      return;
    }

    // Store node info for later
    this.publicKey = publicKey;
    this.nodeInfo = nodeInfo;

    // Generate cryptographically secure challenge
    this.challenge = crypto.randomBytes(CHALLENGE_BYTES).toString("base64");
    this.authState = "challenged";

    this.logger.info(
      `Node hello from ${nodeInfo.hostname} (${nodeInfo.nodeId}) - challenge issued`
    );

    const response: NodeHelloResponse = {
      challenge: this.challenge,
    };

    this.send(createSuccessResponse(req.id, response));
  }

  /**
   * Handles node.auth request - second step of handshake.
   * Node sends signed challenge, gateway verifies and completes auth.
   */
  private handleNodeAuth(req: Request): void {
    if (this.authState !== "challenged") {
      this.sendError(req.id, "unexpected node.auth: must send node.hello first");
      return;
    }

    if (!isNodeAuthParams(req.params)) {
      this.sendError(req.id, "invalid node.auth params");
      return;
    }

    const { signature } = req.params;

    // Verify we have the required state
    if (
      this.challenge === undefined ||
      this.publicKey === undefined ||
      this.nodeInfo === undefined
    ) {
      this.sendError(req.id, "internal error: missing handshake state");
      this.authState = "failed";
      return;
    }

    // Verify the signature
    const isValid = verifySignature(this.challenge, signature, this.publicKey);

    if (!isValid) {
      this.logger.warn(`Auth failed for ${this.nodeInfo.hostname}: invalid signature`);
      this.authState = "failed";
      this.sendError(req.id, "authentication failed: invalid signature");
      this.close(1008, "authentication failed");
      return;
    }

    const deviceId = deriveDeviceId(this.publicKey);

    // Check pairing if checker is configured
    if (this.pairingChecker !== undefined) {
      void this.handleNodeAuthWithPairing(req, deviceId);
      return;
    }

    // No pairing check - complete authentication
    this.completeAuthentication(req, deviceId);
  }

  /**
   * Handles node.auth with pairing check.
   */
  private async handleNodeAuthWithPairing(req: Request, deviceId: string): Promise<void> {
    if (this.publicKey === undefined || this.nodeInfo === undefined) {
      this.sendError(req.id, "internal error: missing handshake state");
      this.authState = "failed";
      return;
    }

    const pairingResult = await this.pairingChecker!(deviceId, this.publicKey, this.nodeInfo);

    switch (pairingResult.status) {
      case "paired":
        this.completeAuthentication(req, deviceId);
        break;

      case "pending":
        this.logger.warn(
          `Device ${deviceId} (${this.nodeInfo.hostname}) not paired - awaiting approval`
        );
        this.authState = "failed";
        this.sendError(req.id, `device not paired: ${pairingResult.message}`);
        this.close(4001, "device not paired");
        break;

      case "rejected":
        this.logger.warn(
          `Device ${deviceId} (${this.nodeInfo.hostname}) pairing rejected: ${pairingResult.reason}`
        );
        this.authState = "failed";
        this.sendError(req.id, `pairing rejected: ${pairingResult.reason}`);
        this.close(4002, "pairing rejected");
        break;
    }
  }

  /**
   * Completes authentication after signature and pairing checks pass.
   */
  private completeAuthentication(req: Request, deviceId: string): void {
    if (this.publicKey === undefined || this.nodeInfo === undefined) {
      this.sendError(req.id, "internal error: missing handshake state");
      this.authState = "failed";
      return;
    }

    // Authentication successful
    this.authState = "authenticated";
    this.clearHandshakeTimeout();

    // Register the node
    const connectedNode: ConnectedNode = {
      deviceId,
      nodeInfo: this.nodeInfo,
      publicKey: this.publicKey,
      socket: this.socket,
      connectedAtMs: this.connectedAtMs,
      authState: "authenticated",
      lastPingMs: undefined,
      lastPongMs: undefined,
    };

    this.registry.add(connectedNode);

    this.logger.info(
      `Node authenticated: ${this.nodeInfo.hostname} (${deviceId}) from ${this.nodeInfo.platform}`
    );

    // Start heartbeat monitoring after authentication
    this.startHeartbeat();

    const response: NodeAuthResponse = {
      deviceId,
      message: "authentication successful",
    };

    this.send(createSuccessResponse(req.id, response));
  }

  /**
   * Handles node.invoke request - routes command to target node.
   */
  private async handleNodeInvoke(req: Request): Promise<void> {
    if (!isNodeInvokeParams(req.params)) {
      this.sendError(req.id, "invalid node.invoke params");
      return;
    }

    if (this.invokeHandler === undefined) {
      this.sendError(req.id, "node.invoke not supported");
      return;
    }

    try {
      const result = await this.invokeHandler(req.params);
      this.send(createSuccessResponse(req.id, result));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.sendError(req.id, errorMsg);
    }
  }

  /**
   * Handles node.invoke.response from a node - routes to pending invoke.
   */
  private handleNodeInvokeResponse(req: Request): void {
    if (this.invokeResponseHandler === undefined) {
      this.sendError(req.id, "node.invoke.response not supported");
      return;
    }

    if (this.publicKey === undefined) {
      this.sendError(req.id, "internal error: no public key");
      return;
    }

    const deviceId = deriveDeviceId(this.publicKey);
    const matched = this.invokeResponseHandler(deviceId, req.params);

    if (matched) {
      this.send(createSuccessResponse(req.id, { ok: true }));
    } else {
      // Response didn't match any pending invoke (late response after timeout)
      this.send(createSuccessResponse(req.id, { ok: false, reason: "no matching invoke" }));
    }
  }

  /**
   * Handles node.list request - returns list of connected nodes.
   */
  private handleNodeList(req: Request): void {
    const nodes = this.registry.getAll();
    const nodeList = nodes.map((node) => ({
      deviceId: node.deviceId,
      nodeInfo: node.nodeInfo,
      connectedAtMs: node.connectedAtMs,
    }));
    this.send(createSuccessResponse(req.id, { nodes: nodeList }));
  }

  /**
   * Handles connection close.
   */
  private handleClose(code: number, reason: string): void {
    this.clearHandshakeTimeout();
    this.clearHeartbeat();

    if (this.authState === "authenticated" && this.publicKey !== undefined) {
      const deviceId = deriveDeviceId(this.publicKey);
      this.registry.remove(deviceId);
      this.logger.info(`Node disconnected: ${deviceId} (code=${code}, reason=${reason})`);
    } else {
      this.logger.info(`Connection closed before auth (code=${code}, reason=${reason})`);
    }
  }

  /**
   * Handles connection errors.
   */
  private handleError(error: Error): void {
    this.logger.error(`WebSocket error: ${error.message}`);
  }

  /**
   * Sends a message to the client.
   */
  private send(message: unknown): void {
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.logger.error(`Failed to send message: ${String(error)}`);
    }
  }

  /**
   * Sends an error response.
   */
  private sendError(id: string, error: string): void {
    this.send(createErrorResponse(id, error));
  }

  /**
   * Closes the connection.
   */
  private close(code: number, reason: string): void {
    this.clearHandshakeTimeout();
    this.clearHeartbeat();
    try {
      this.socket.close(code, reason);
    } catch {
      // Ignore close errors
    }
  }

  /**
   * Starts heartbeat monitoring for the connection.
   * Sends ping every 30 seconds and expects pong within 90 seconds.
   */
  private startHeartbeat(): void {
    this.clearHeartbeat();

    // Send ping every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.authState === "authenticated") {
        try {
          this.socket.ping();
          this.lastPingMs = Date.now();
          this.startHeartbeatTimeout();
        } catch (error) {
          this.logger.error(`Failed to send ping: ${String(error)}`);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Send initial ping
    try {
      this.socket.ping();
      this.lastPingMs = Date.now();
      this.startHeartbeatTimeout();
    } catch (error) {
      this.logger.error(`Failed to send initial ping: ${String(error)}`);
    }
  }

  /**
   * Starts the heartbeat timeout timer.
   * If no pong is received within 90 seconds, the connection is closed.
   */
  private startHeartbeatTimeout(): void {
    this.clearHeartbeatTimeout();

    this.heartbeatTimeout = setTimeout(() => {
      const timeSinceLastPong = this.lastPongMs !== undefined ? Date.now() - this.lastPongMs : 0;
      const deviceId = this.publicKey !== undefined ? deriveDeviceId(this.publicKey) : "unknown";

      this.logger.warn(
        `Heartbeat timeout for ${deviceId} - no pong received in ${timeSinceLastPong}ms, closing connection`
      );

      this.close(4000, "heartbeat timeout");
    }, HEARTBEAT_TIMEOUT_MS);
  }

  /**
   * Handles incoming ping from client.
   * Automatically sends pong (handled by ws library).
   */
  private handlePing(): void {
    // WebSocket library automatically sends pong
    // We just track that we received a ping
  }

  /**
   * Handles incoming pong from client.
   */
  private handlePong(): void {
    this.lastPongMs = Date.now();
    this.clearHeartbeatTimeout();
  }

  /**
   * Clears heartbeat timers.
   */
  private clearHeartbeat(): void {
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    this.clearHeartbeatTimeout();
  }

  /**
   * Clears the heartbeat timeout timer.
   */
  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout !== undefined) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }
  }
}
