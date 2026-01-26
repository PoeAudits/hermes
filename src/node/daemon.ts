/**
 * Node Daemon
 *
 * Main daemon class that:
 * - Connects to Gateway via WebSocket
 * - Completes authentication handshake
 * - Handles incoming invoke requests
 * - Manages registered command handlers
 */

import crypto from "node:crypto";
import os from "node:os";
import { EventEmitter } from "node:events";
import type { DeviceIdentity } from "../identity/device.js";
import { getOrCreateIdentity, signMessage } from "../identity/device.js";
import type { Event, NodeInfo, Request } from "../protocol/types.js";
import { NodeClient, type ConnectionState } from "./client.js";
import { createSystemRunHandler } from "./system-run.js";

/**
 * Payload for node.invoke.response event sent back to Gateway.
 */
interface InvokeResponsePayload {
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Configuration options for the Node daemon.
 */
export interface DaemonOptions {
  gatewayUrl: string;
  statePath: string;
  /** If true, auto-register the system.run handler on startup (default: true) */
  registerSystemRun: boolean;
}

/**
 * Handler function for invoke requests.
 * Returns the result payload or throws an error.
 */
export type InvokeHandler = (params: unknown) => Promise<unknown> | unknown;

/**
 * Payload for node.invoke.request events from Gateway.
 * Matches NodeInvokeRequestPayload from node-registry.ts
 */
interface InvokeRequestPayload {
  id: string;
  method: string;
  params: unknown;
  idempotencyKey?: string;
}

/**
 * Payload for node.hello request to Gateway.
 */
interface HelloPayload {
  nodeInfo: NodeInfo;
  publicKey: string;
}

/**
 * Response from node.hello containing challenge.
 */
interface HelloResponse {
  challenge: string;
}

/**
 * Payload for node.auth request to Gateway.
 */
interface AuthPayload {
  signature: string;
}

/**
 * Response from node.auth.
 */
interface AuthResponse {
  deviceId: string;
  message: string;
}

/**
 * Events emitted by the Node daemon.
 */
export interface DaemonEvents {
  started: [];
  stopped: [];
  connected: [];
  disconnected: [code: number, reason: string];
  authenticated: [];
  authFailed: [error: string];
  error: [error: Error];
  invoke: [method: string, params: unknown];
  stateChange: [state: ConnectionState];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_OPTIONS: DaemonOptions = {
  gatewayUrl: "ws://localhost:18789",
  statePath: "./state",
  registerSystemRun: true,
};

// -----------------------------------------------------------------------------
// Node Daemon
// -----------------------------------------------------------------------------

/**
 * Node daemon that connects to Gateway and handles invoke requests.
 *
 * Usage:
 * ```typescript
 * const daemon = new NodeDaemon({
 *   gatewayUrl: "ws://vps:18789",
 *   statePath: "./state",
 * });
 *
 * daemon.registerHandler("system.run", async (params) => {
 *   // Handle system.run command
 *   return { stdout: "...", stderr: "", exitCode: 0 };
 * });
 *
 * await daemon.start();
 * ```
 */
export class NodeDaemon extends EventEmitter<DaemonEvents> {
  private options: DaemonOptions;
  private client: NodeClient;
  private identity: DeviceIdentity | undefined;
  private handlers = new Map<string, InvokeHandler>();
  private running = false;
  private authenticated = false;

  constructor(options: Partial<DaemonOptions> = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.client = new NodeClient({
      gatewayUrl: this.options.gatewayUrl,
    });

    this.setupClientListeners();
  }

  /**
   * Returns the device ID for this node.
   * Only available after start() is called.
   */
  getDeviceId(): string | undefined {
    return this.identity?.deviceId;
  }

  /**
   * Returns true if the daemon is running and authenticated.
   */
  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Returns the current connection state.
   */
  getState(): ConnectionState {
    return this.client.getState();
  }

  /**
   * Registers a handler for a specific method.
   * When the Gateway sends a node.invoke.request with this method,
   * the handler will be called with the params.
   *
   * @param method - The method name to handle (e.g., "system.run")
   * @param handler - The handler function
   */
  registerHandler(method: string, handler: InvokeHandler): void {
    this.handlers.set(method, handler);
    console.log(`[NodeDaemon] Registered handler: ${method}`);
  }

  /**
   * Unregisters a handler for a specific method.
   *
   * @param method - The method name to unregister
   */
  unregisterHandler(method: string): void {
    this.handlers.delete(method);
    console.log(`[NodeDaemon] Unregistered handler: ${method}`);
  }

  /**
   * Starts the daemon.
   * Loads or creates device identity and connects to Gateway.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    console.log("[NodeDaemon] Starting...");

    // Auto-register system.run handler if enabled
    if (this.options.registerSystemRun) {
      this.registerHandler("system.run", createSystemRunHandler());
      console.log("[NodeDaemon] Auto-registered system.run handler");
    }

    // Load or create device identity
    this.identity = await getOrCreateIdentity(this.options.statePath);
    console.log(`[NodeDaemon] Device ID: ${this.identity.deviceId}`);

    this.running = true;
    this.client.connect();
    this.emit("started");
  }

  /**
   * Stops the daemon.
   * Disconnects from Gateway and cleans up resources.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    console.log("[NodeDaemon] Stopping...");

    this.running = false;
    this.authenticated = false;
    this.client.disconnect();
    this.emit("stopped");
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private setupClientListeners(): void {
    this.client.on("connected", () => {
      console.log("[NodeDaemon] Connected to Gateway");
      this.emit("connected");
      void this.performHandshake();
    });

    this.client.on("disconnected", (code, reason) => {
      console.log(`[NodeDaemon] Disconnected: ${code} ${reason}`);
      this.authenticated = false;
      this.emit("disconnected", code, reason);
    });

    this.client.on("error", (error) => {
      console.error("[NodeDaemon] Error:", error.message);
      this.emit("error", error);
    });

    this.client.on("event", (event) => {
      this.handleEvent(event);
    });

    this.client.on("stateChange", (state) => {
      this.emit("stateChange", state);
    });
  }

  /**
   * Performs the authentication handshake with Gateway.
   *
   * Flow:
   * 1. Send node.hello with nodeInfo and publicKey
   * 2. Receive challenge from Gateway
   * 3. Sign challenge with private key
   * 4. Send node.auth with signature
   * 5. Receive auth success/failure
   */
  private async performHandshake(): Promise<void> {
    if (this.identity === undefined) {
      console.error("[NodeDaemon] Cannot handshake: no identity");
      return;
    }

    try {
      console.log("[NodeDaemon] Starting handshake...");

      // Step 1: Send node.hello
      const nodeInfo: NodeInfo = {
        nodeId: this.identity.deviceId,
        platform: process.platform,
        hostname: os.hostname(),
      };

      const helloPayload: HelloPayload = {
        nodeInfo,
        publicKey: this.identity.publicKey,
      };

      console.log(`[NodeDaemon] Sending hello: nodeId=${nodeInfo.nodeId}, platform=${nodeInfo.platform}, hostname=${nodeInfo.hostname}`);

      const helloResponse = await this.client.request<HelloResponse>("node.hello", helloPayload);

      // Step 2: Receive challenge
      if (typeof helloResponse?.challenge !== "string" || helloResponse.challenge.length === 0) {
        throw new Error("Invalid challenge received from Gateway");
      }

      console.log("[NodeDaemon] Received challenge, signing...");

      // Step 3: Sign challenge
      const signature = signMessage(helloResponse.challenge, this.identity.privateKey);

      // Step 4: Send node.auth
      const authPayload: AuthPayload = {
        signature,
      };

      const authResponse = await this.client.request<AuthResponse>("node.auth", authPayload);

      // Step 5: Check auth result - success is indicated by receiving deviceId
      if (typeof authResponse?.deviceId !== "string" || authResponse.deviceId.length === 0) {
        const errorMsg = "Authentication failed: no deviceId received";
        console.error(`[NodeDaemon] Auth failed: ${errorMsg}`);
        this.emit("authFailed", errorMsg);
        return;
      }

      console.log("[NodeDaemon] Authentication successful");
      this.authenticated = true;
      this.client.setAuthenticated();
      this.emit("authenticated");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[NodeDaemon] Handshake failed: ${errorMsg}`);
      this.emit("authFailed", errorMsg);
    }
  }

  /**
   * Handles incoming events from Gateway.
   */
  private handleEvent(event: Event): void {
    if (event.event === "node.invoke.request") {
      void this.handleInvokeRequest(event.payload);
      return;
    }

    // Log other events for debugging
    console.log(`[NodeDaemon] Received event: ${event.event}`);
  }

  /**
   * Handles an invoke request from Gateway.
   * Dispatches to registered handler and sends result back.
   */
  private async handleInvokeRequest(payload: unknown): Promise<void> {
    const request = this.parseInvokePayload(payload);
    if (request === undefined) {
      console.error("[NodeDaemon] Invalid invoke request payload");
      return;
    }

    console.log(`[NodeDaemon] Invoke request: ${request.method} (id=${request.id})`);
    this.emit("invoke", request.method, request.params);

    const handler = this.handlers.get(request.method);
    if (handler === undefined) {
      console.warn(`[NodeDaemon] No handler for method: ${request.method}`);
      this.sendInvokeResponse(request.id, {
        ok: false,
        error: {
          code: "HANDLER_ERROR",
          message: `Unknown method: ${request.method}`,
        },
      });
      return;
    }

    try {
      const result = await handler(request.params);
      this.sendInvokeResponse(request.id, {
        ok: true,
        payload: result,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[NodeDaemon] Handler error for ${request.method}: ${errorMsg}`);
      this.sendInvokeResponse(request.id, {
        ok: false,
        error: {
          code: "HANDLER_ERROR",
          message: errorMsg,
        },
      });
    }
  }

  /**
   * Parses and validates an invoke request payload.
   */
  private parseInvokePayload(payload: unknown): InvokeRequestPayload | undefined {
    if (typeof payload !== "object" || payload === null) {
      return undefined;
    }

    const obj = payload as Record<string, unknown>;

    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const method = typeof obj.method === "string" ? obj.method.trim() : "";

    if (id.length === 0 || method.length === 0) {
      return undefined;
    }

    return {
      id,
      method,
      params: obj.params,
      idempotencyKey: typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : undefined,
    };
  }

  /**
   * Sends an invoke response back to Gateway as an event.
   * The Gateway's NodeRegistry.handleInvokeResponse expects this format.
   */
  private sendInvokeResponse(
    id: string,
    result: { ok: boolean; payload?: unknown; error?: { code: string; message: string } }
  ): void {
    try {
      const responsePayload: InvokeResponsePayload = {
        id,
        ok: result.ok,
        payload: result.payload,
      };

      if (!result.ok && result.error !== undefined) {
        responsePayload.error = result.error;
      }

      // Send as a request that the Gateway will route to handleInvokeResponse
      // The Gateway's WsHandler needs to be updated to handle this
      const request: Request = {
        type: "req",
        id: crypto.randomUUID(),
        method: "node.invoke.response",
        params: responsePayload,
      };

      this.client.send(request);
    } catch (error) {
      // Best effort - log but don't throw
      console.error("[NodeDaemon] Failed to send invoke response:", error);
    }
  }
}
