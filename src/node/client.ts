/**
 * WebSocket Client for Node Daemon
 *
 * Handles WebSocket connection to Gateway with:
 * - Automatic reconnection with exponential backoff
 * - Message parsing and routing
 * - Connection state management
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Request, Response, Event, ProtocolMessage } from "../protocol/types.js";
import { isResponse, isEvent } from "../protocol/types.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Connection state for the WebSocket client.
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "authenticated";

/**
 * Configuration options for the WebSocket client.
 */
export interface ClientOptions {
  gatewayUrl: string;
  reconnect: boolean;
  backoffMs: number;
  backoffMax: number;
  backoffMultiplier: number;
  stableConnectionMs: number;
}

/**
 * Pending request awaiting response.
 */
interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Events emitted by the WebSocket client.
 */
export interface ClientEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  error: [error: Error];
  event: [event: Event];
  stateChange: [state: ConnectionState];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_OPTIONS: ClientOptions = {
  gatewayUrl: "ws://localhost:18789",
  reconnect: true,
  backoffMs: 1000,
  backoffMax: 60000,
  backoffMultiplier: 2,
  stableConnectionMs: 60000,
};

const REQUEST_TIMEOUT_MS = 30000;
const PENDING_REQUESTS_MAX = 1000;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 90000;

// -----------------------------------------------------------------------------
// WebSocket Client
// -----------------------------------------------------------------------------

/**
 * WebSocket client with automatic reconnection and exponential backoff.
 *
 * Usage:
 * ```typescript
 * const client = new NodeClient({ gatewayUrl: "ws://vps:18789" });
 * client.on("connected", () => console.log("Connected!"));
 * client.on("event", (evt) => console.log("Event:", evt));
 * client.connect();
 * ```
 */
export class NodeClient extends EventEmitter<ClientEvents> {
  private ws: WebSocket | undefined;
  private options: ClientOptions;
  private state: ConnectionState = "disconnected";
  private backoffCurrent: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private connectedAtMs: number | undefined;
  private pendingRequests = new Map<string, PendingRequest>();
  private closed = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
  private lastPongMs: number | undefined;

  constructor(options: Partial<ClientOptions> = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.backoffCurrent = this.options.backoffMs;
  }

  /**
   * Returns the current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Returns true if the client is connected and ready to send messages.
   */
  isConnected(): boolean {
    return this.state === "connected" || this.state === "authenticated";
  }

  /**
   * Initiates connection to the Gateway.
   * Will automatically reconnect on disconnect if reconnect option is enabled.
   */
  connect(): void {
    if (this.closed) {
      return;
    }

    if (this.ws !== undefined) {
      return;
    }

    this.setState("connecting");
    this.clearReconnectTimer();

    try {
      this.ws = new WebSocket(this.options.gatewayUrl, {
        maxPayload: 25 * 1024 * 1024,
      });

      this.ws.on("open", () => this.handleOpen());
      this.ws.on("message", (data) => this.handleMessage(data));
      this.ws.on("close", (code, reason) => this.handleClose(code, reason.toString("utf8")));
      this.ws.on("error", (error) => this.handleError(error));
      this.ws.on("pong", () => this.handlePong());
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Disconnects from the Gateway and stops reconnection attempts.
   */
  disconnect(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.clearHeartbeat();
    this.rejectAllPending(new Error("Client disconnected"));

    if (this.ws !== undefined) {
      try {
        this.ws.close(1000, "Client shutdown");
      } catch {
        // Ignore close errors
      }
      this.ws = undefined;
    }

    this.setState("disconnected");
  }

  /**
   * Sends a request to the Gateway and waits for a response.
   *
   * @param method - The method name to call
   * @param params - The parameters to send
   * @param timeoutMs - Optional timeout in milliseconds (default: 30000)
   * @returns Promise resolving to the response payload
   * @throws Error if not connected, timeout, or request fails
   */
  async request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.isConnected() || this.ws === undefined) {
      throw new Error("Not connected to Gateway");
    }

    if (this.pendingRequests.size >= PENDING_REQUESTS_MAX) {
      throw new Error("Too many pending requests");
    }

    const id = crypto.randomUUID();
    const timeout = timeoutMs ?? REQUEST_TIMEOUT_MS;

    const request: Request = {
      type: "req",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timeoutId,
      });

      try {
        this.ws?.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Sends a message without waiting for a response.
   * Used for fire-and-forget messages.
   */
  send(message: Request): void {
    if (!this.isConnected() || this.ws === undefined) {
      throw new Error("Not connected to Gateway");
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Updates the connection state to authenticated.
   * Called by the daemon after successful handshake.
   */
  setAuthenticated(): void {
    if (this.state === "connected") {
      this.setState("authenticated");
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit("stateChange", state);
    }
  }

  private handleOpen(): void {
    this.connectedAtMs = Date.now();
    this.lastPongMs = Date.now();
    this.setState("connected");
    this.emit("connected");
    this.startStableTimer();
    this.startHeartbeat();
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const text = data.toString("utf8");
      const message = JSON.parse(text) as unknown;

      if (isResponse(message)) {
        this.handleResponse(message);
        return;
      }

      if (isEvent(message)) {
        this.emit("event", message);
        return;
      }

      // Unknown message type - ignore
    } catch (error) {
      console.error("[NodeClient] Failed to parse message:", error);
    }
  }

  private handleResponse(response: Response): void {
    const pending = this.pendingRequests.get(response.id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(response.id);

    if (response.ok) {
      pending.resolve(response.payload);
    } else {
      pending.reject(new Error(response.error ?? "Unknown error"));
    }
  }

  private handleClose(code: number, reason: string): void {
    this.ws = undefined;
    this.clearStableTimer();
    this.clearHeartbeat();
    this.rejectAllPending(new Error(`Connection closed: ${code} ${reason}`));
    this.setState("disconnected");
    this.emit("disconnected", code, reason);

    if (!this.closed && this.options.reconnect) {
      this.scheduleReconnect();
    }
  }

  private handleError(error: Error): void {
    console.error("[NodeClient] WebSocket error:", error.message);
    this.emit("error", error);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) {
      return;
    }

    const delay = this.backoffCurrent;
    console.log(`[NodeClient] Reconnecting in ${delay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);

    // Increase backoff for next attempt
    this.backoffCurrent = Math.min(
      this.backoffCurrent * this.options.backoffMultiplier,
      this.options.backoffMax
    );
  }

  private startStableTimer(): void {
    this.clearStableTimer();

    this.stableTimer = setTimeout(() => {
      // Connection has been stable - reset backoff
      this.backoffCurrent = this.options.backoffMs;
      console.log("[NodeClient] Connection stable, backoff reset");
    }, this.options.stableConnectionMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();

    // Send ping every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.ws !== undefined && this.isConnected()) {
        try {
          this.ws.ping();
          this.startHeartbeatTimeout();
        } catch (error) {
          console.error("[NodeClient] Failed to send ping:", error);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Send initial ping
    if (this.ws !== undefined) {
      try {
        this.ws.ping();
        this.startHeartbeatTimeout();
      } catch (error) {
        console.error("[NodeClient] Failed to send initial ping:", error);
      }
    }
  }

  private startHeartbeatTimeout(): void {
    this.clearHeartbeatTimeout();

    this.heartbeatTimeout = setTimeout(() => {
      const timeSinceLastPong = this.lastPongMs !== undefined ? Date.now() - this.lastPongMs : 0;
      console.warn(
        `[NodeClient] Heartbeat timeout - no pong received in ${timeSinceLastPong}ms, closing connection`
      );

      if (this.ws !== undefined) {
        try {
          this.ws.close(4000, "heartbeat timeout");
        } catch {
          // Ignore close errors
        }
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private handlePong(): void {
    this.lastPongMs = Date.now();
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout !== undefined) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }
  }
}
