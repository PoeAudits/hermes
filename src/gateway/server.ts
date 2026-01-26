/**
 * Gateway Server
 *
 * Central WebSocket server that accepts connections from nodes,
 * handles authentication, and maintains the connection registry.
 */

import type { IncomingMessage } from "node:http";
import path from "node:path";
import os from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import type { ConnectionRegistry, Logger, WsHandlerOptions } from "./ws-handler.js";
import { WsHandler } from "./ws-handler.js";
import type { NodeInvokeParams } from "./types.js";
import {
  DEFAULT_GATEWAY_CONFIG,
  type ConnectedNode,
  type GatewayConfig,
} from "./types.js";
import {
  NodeRegistry,
  isNodeInvokeResponsePayload,
  type InvokeOptions,
  type NodeInvokeResult,
  type NodeSession,
  type NodeStatus,
  type RegistryLogger,
} from "./node-registry.js";
import { extractTailscaleIdentity } from "./tailscale-auth.js";
import {
  PairingStore,
  type PairedDevice,
  type PendingDevice,
} from "../identity/pairing.js";

// -----------------------------------------------------------------------------
// Connection Registry Adapter
// -----------------------------------------------------------------------------

/**
 * Adapter that bridges the ConnectionRegistry interface used by WsHandler
 * with the new NodeRegistry implementation.
 */
class ConnectionRegistryAdapter implements ConnectionRegistry {
  private readonly nodeRegistry: NodeRegistry;

  constructor(nodeRegistry: NodeRegistry) {
    this.nodeRegistry = nodeRegistry;
  }

  add(node: ConnectedNode): void {
    this.nodeRegistry.registerNode(node);
  }

  remove(deviceId: string): void {
    this.nodeRegistry.unregisterNode(deviceId);
  }

  get(deviceId: string): ConnectedNode | undefined {
    const session = this.nodeRegistry.getNode(deviceId);
    if (session === undefined) {
      return undefined;
    }
    // Convert NodeSession back to ConnectedNode for compatibility
    return {
      deviceId: session.deviceId,
      nodeInfo: session.nodeInfo,
      publicKey: session.publicKey,
      socket: session.socket,
      connectedAtMs: session.connectedAtMs,
      authState: "authenticated",
    };
  }

  getAll(): ConnectedNode[] {
    const statuses = this.nodeRegistry.listNodes();
    return statuses.map((status) => {
      const session = this.nodeRegistry.getNode(status.deviceId);
      if (session === undefined) {
        // This shouldn't happen, but handle gracefully
        return {
          deviceId: status.deviceId,
          nodeInfo: status.nodeInfo,
          publicKey: "",
          socket: undefined as unknown as WebSocket,
          connectedAtMs: status.connectedAtMs,
          authState: "authenticated" as const,
        };
      }
      return {
        deviceId: session.deviceId,
        nodeInfo: session.nodeInfo,
        publicKey: session.publicKey,
        socket: session.socket,
        connectedAtMs: session.connectedAtMs,
        authState: "authenticated" as const,
      };
    });
  }

  size(): number {
    return this.nodeRegistry.size();
  }
}

// -----------------------------------------------------------------------------
// Console Logger Implementation
// -----------------------------------------------------------------------------

/**
 * Simple console logger with timestamps.
 */
class ConsoleLogger implements Logger, RegistryLogger {
  private readonly prefix: string;
  private readonly debugEnabled: boolean;

  constructor(prefix: string = "gateway", debugEnabled: boolean = false) {
    this.prefix = prefix;
    this.debugEnabled = debugEnabled;
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${this.prefix}] [${level}] ${message}`;
  }

  info(message: string): void {
    console.log(this.formatMessage("INFO", message));
  }

  warn(message: string): void {
    console.warn(this.formatMessage("WARN", message));
  }

  error(message: string): void {
    console.error(this.formatMessage("ERROR", message));
  }

  debug(message: string): void {
    if (this.debugEnabled) {
      console.log(this.formatMessage("DEBUG", message));
    }
  }
}

// -----------------------------------------------------------------------------
// Gateway Server
// -----------------------------------------------------------------------------

/**
 * Gateway WebSocket server.
 *
 * Accepts connections from nodes, handles the authentication handshake,
 * and maintains a registry of connected nodes. Supports invoking commands
 * on specific nodes via the node.invoke pattern.
 */
export class Gateway {
  private readonly config: GatewayConfig;
  private readonly logger: ConsoleLogger;
  private readonly nodeRegistry: NodeRegistry;
  private readonly connectionAdapter: ConnectionRegistryAdapter;
  private readonly pairingStore: PairingStore;
  private wss: WebSocketServer | undefined;
  private isRunning: boolean = false;

  constructor(config: Partial<GatewayConfig> = {}, logger?: Logger) {
    this.config = { ...DEFAULT_GATEWAY_CONFIG, ...config };
    this.logger = (logger as ConsoleLogger) ?? new ConsoleLogger();
    this.nodeRegistry = new NodeRegistry(this.logger);
    this.connectionAdapter = new ConnectionRegistryAdapter(this.nodeRegistry);

    // Initialize pairing store
    const statePath = this.config.statePath ?? path.join(os.homedir(), ".config", "hermes-gateway");
    this.pairingStore = new PairingStore(statePath, {
      autoApprove: this.config.autoApprove ?? false,
    });
  }

  /**
   * Starts the gateway server.
   *
   * @returns Promise that resolves when the server is listening
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Gateway is already running");
    }

    // Load pairing store
    await this.pairingStore.load();

    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: this.config.port,
          host: this.config.host,
        });

        this.wss.on("listening", () => {
          this.isRunning = true;
          this.logger.info(
            `Gateway listening on ${this.config.host}:${this.config.port}`
          );
          resolve();
        });

        this.wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
          this.handleConnection(socket, request);
        });

        this.wss.on("error", (error: Error) => {
          this.logger.error(`Server error: ${error.message}`);
          if (!this.isRunning) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stops the gateway server.
   *
   * @returns Promise that resolves when the server is stopped
   */
  async stop(): Promise<void> {
    if (!this.isRunning || this.wss === undefined) {
      return;
    }

    // Shutdown the registry (rejects pending invokes)
    this.nodeRegistry.shutdown();

    // Close all client connections
    const nodes = this.connectionAdapter.getAll();
    for (const node of nodes) {
      try {
        node.socket.close(1001, "server shutting down");
      } catch {
        // Ignore close errors
      }
    }

    return new Promise<void>((resolve) => {
      const wss = this.wss;
      if (wss === undefined) {
        resolve();
        return;
      }

      // Set a timeout in case the close callback never fires
      const timeout = setTimeout(() => {
        this.isRunning = false;
        this.logger.info("Gateway stopped (timeout)");
        resolve();
      }, 1000);

      // Close the server
      wss.close(() => {
        clearTimeout(timeout);
        this.isRunning = false;
        this.logger.info("Gateway stopped");
        resolve();
      });
    });
  }

  /**
   * Handles a new WebSocket connection.
   */
  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    this.logger.info("New connection received");

    // Check for Tailscale identity (informational only, not used for auth)
    const tailscaleIdentity = extractTailscaleIdentity(request.headers);
    if (tailscaleIdentity !== null) {
      this.logger.info(
        `Tailscale user detected: ${tailscaleIdentity.login} (${tailscaleIdentity.name})`
      );
    }

    // Create a handler for this connection with invoke support
    const options: WsHandlerOptions = {
      socket,
      registry: this.connectionAdapter,
      logger: this.logger,
      invokeHandler: async (params: NodeInvokeParams) => {
        // Route node.invoke requests to the NodeRegistry
        const result = await this.nodeRegistry.invoke(
          params.targetNodeId,
          params.method,
          params.params,
          {
            timeoutMs: params.timeoutMs,
            idempotencyKey: params.idempotencyKey,
          }
        );
        return result;
      },
      invokeResponseHandler: (deviceId: string, payload: unknown) => {
        // Route node.invoke.response to the NodeRegistry
        return this.handleInvokeResponse(deviceId, payload);
      },
      pairingChecker: async (deviceId, publicKey, nodeInfo) => {
        // Check device pairing status
        const result = await this.pairingStore.checkPairing(deviceId, publicKey, nodeInfo);

        switch (result.status) {
          case "paired":
            return { status: "paired" };
          case "pending":
            return {
              status: "pending",
              message: `Device ${deviceId} is awaiting admin approval. Run 'hermes pair ${deviceId}' to approve.`,
            };
          case "rejected":
            return { status: "rejected", reason: result.reason };
        }
      },
    };

    new WsHandler(options);
  }

  // ---------------------------------------------------------------------------
  // Node Registry Methods
  // ---------------------------------------------------------------------------

  /**
   * Returns the number of connected nodes.
   */
  getConnectedNodeCount(): number {
    return this.nodeRegistry.size();
  }

  /**
   * Returns all connected nodes.
   */
  getConnectedNodes(): ConnectedNode[] {
    return this.connectionAdapter.getAll();
  }

  /**
   * Returns a specific connected node by device ID.
   */
  getNode(deviceId: string): ConnectedNode | undefined {
    return this.connectionAdapter.get(deviceId);
  }

  /**
   * Returns a NodeSession by device ID (includes capabilities).
   */
  getNodeSession(deviceId: string): NodeSession | undefined {
    return this.nodeRegistry.getNode(deviceId);
  }

  /**
   * Lists all connected nodes with their status.
   */
  listNodes(): NodeStatus[] {
    return this.nodeRegistry.listNodes();
  }

  // ---------------------------------------------------------------------------
  // Node Invoke Methods
  // ---------------------------------------------------------------------------

  /**
   * Invokes a method on a target node and waits for the response.
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
    options?: InvokeOptions
  ): Promise<NodeInvokeResult> {
    return this.nodeRegistry.invoke(targetNodeId, method, params, options);
  }

  /**
   * Handles an invoke response from a node.
   *
   * This should be called when a node sends a node.invoke.response event.
   *
   * @param deviceId - The device ID of the responding node
   * @param payload - The response payload
   * @returns true if the response was matched to a pending invoke
   */
  handleInvokeResponse(deviceId: string, payload: unknown): boolean {
    if (!isNodeInvokeResponsePayload(payload)) {
      this.logger.warn(
        `Invalid invoke response payload from ${deviceId}: ${JSON.stringify(payload)}`
      );
      return false;
    }
    return this.nodeRegistry.handleInvokeResponse(deviceId, payload);
  }

  /**
   * Sends an event to a specific node.
   *
   * @param deviceId - The device ID of the target node
   * @param event - The event name
   * @param payload - The event payload
   * @returns true if the event was sent
   */
  sendEvent(deviceId: string, event: string, payload: unknown): boolean {
    return this.nodeRegistry.sendEvent(deviceId, event, payload);
  }

  /**
   * Broadcasts an event to all connected nodes.
   *
   * @param event - The event name
   * @param payload - The event payload
   * @returns Number of nodes the event was sent to
   */
  broadcast(event: string, payload: unknown): number {
    return this.nodeRegistry.broadcast(event, payload);
  }

  // ---------------------------------------------------------------------------
  // Status Methods
  // ---------------------------------------------------------------------------

  /**
   * Returns whether the gateway is running.
   */
  isListening(): boolean {
    return this.isRunning;
  }

  /**
   * Returns the configured port.
   */
  getPort(): number {
    return this.config.port;
  }

  /**
   * Returns the configured host.
   */
  getHost(): string {
    return this.config.host;
  }

  /**
   * Returns the underlying NodeRegistry (for advanced use cases).
   */
  getRegistry(): NodeRegistry {
    return this.nodeRegistry;
  }

  // ---------------------------------------------------------------------------
  // Pairing Methods
  // ---------------------------------------------------------------------------

  /**
   * Returns the pairing store for direct access.
   */
  getPairingStore(): PairingStore {
    return this.pairingStore;
  }

  /**
   * Checks if a device is paired.
   *
   * @param deviceId - The device ID to check
   * @returns true if the device is paired
   */
  async isPaired(deviceId: string): Promise<boolean> {
    return this.pairingStore.isPaired(deviceId);
  }

  /**
   * Lists all paired devices.
   *
   * @returns Array of paired devices
   */
  async listPairedDevices(): Promise<PairedDevice[]> {
    return this.pairingStore.listPairedDevices();
  }

  /**
   * Lists pending devices awaiting approval.
   *
   * @returns Array of pending devices
   */
  async listPendingDevices(): Promise<PendingDevice[]> {
    return this.pairingStore.getPendingDevices();
  }

  /**
   * Approves a pending device for pairing.
   *
   * @param deviceId - The device ID to approve
   * @returns The paired device, or undefined if not found in pending
   */
  async approvePendingDevice(deviceId: string): Promise<PairedDevice | undefined> {
    return this.pairingStore.approvePendingDevice(deviceId);
  }

  /**
   * Revokes pairing for a device.
   *
   * @param deviceId - The device ID to revoke
   * @returns true if the device was found and removed
   */
  async revokePairing(deviceId: string): Promise<boolean> {
    return this.pairingStore.revokePairing(deviceId);
  }

  /**
   * Returns whether auto-approve mode is enabled.
   */
  isAutoApproveEnabled(): boolean {
    return this.pairingStore.isAutoApproveEnabled();
  }
}
