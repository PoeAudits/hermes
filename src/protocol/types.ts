/**
 * Core protocol message types for WebSocket communication between Gateway and Nodes.
 * 
 * Message flow:
 * - REQUEST: Client -> Server (expects response)
 * - RESPONSE: Server -> Client (reply to request)
 * - EVENT: Broadcast message (no response expected)
 */

// ============================================================================
// Base Message Envelopes
// ============================================================================

/**
 * Request message sent from client to server.
 * Server must respond with a Response message matching the request id.
 */
export interface Request {
  type: "req";
  id: string;
  method: string;
  params: unknown;
}

/**
 * Response message sent from server to client.
 * Must match the id of the corresponding Request.
 */
export interface Response {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/**
 * Event message broadcast to clients.
 * No response expected. Sequence number for ordering.
 */
export interface Event {
  type: "event";
  event: string;
  seq: number;
  payload: unknown;
}

/**
 * Union of all protocol message types.
 * Use discriminated union for type-safe message handling.
 */
export type ProtocolMessage = Request | Response | Event;

// ============================================================================
// Node Information
// ============================================================================

/**
 * Information about a connected node.
 */
export interface NodeInfo {
  nodeId: string;
  platform: string;
  hostname: string;
}

// ============================================================================
// System Commands
// ============================================================================

/**
 * Parameters for system.run command.
 * Executes a shell command on the target node.
 */
export interface SystemRunParams {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Result from system.run command execution.
 */
export interface SystemRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a message is a Request.
 */
export function isRequest(msg: unknown): msg is Request {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    msg.type === "req" &&
    "id" in msg &&
    typeof msg.id === "string" &&
    "method" in msg &&
    typeof msg.method === "string" &&
    "params" in msg
  );
}

/**
 * Type guard to check if a message is a Response.
 */
export function isResponse(msg: unknown): msg is Response {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    msg.type === "res" &&
    "id" in msg &&
    typeof msg.id === "string" &&
    "ok" in msg &&
    typeof msg.ok === "boolean"
  );
}

/**
 * Type guard to check if a message is an Event.
 */
export function isEvent(msg: unknown): msg is Event {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    msg.type === "event" &&
    "event" in msg &&
    typeof msg.event === "string" &&
    "seq" in msg &&
    typeof msg.seq === "number" &&
    "payload" in msg
  );
}

/**
 * Type guard to check if a message is a valid ProtocolMessage.
 */
export function isProtocolMessage(msg: unknown): msg is ProtocolMessage {
  return isRequest(msg) || isResponse(msg) || isEvent(msg);
}

/**
 * Type guard to check if params match SystemRunParams structure.
 */
export function isSystemRunParams(params: unknown): params is SystemRunParams {
  if (typeof params !== "object" || params === null) {
    return false;
  }

  const p = params as Record<string, unknown>;

  // command is required and must be string array
  if (!("command" in p) || !Array.isArray(p.command)) {
    return false;
  }

  if (!p.command.every((item) => typeof item === "string")) {
    return false;
  }

  // cwd is optional but must be string if present
  if ("cwd" in p && typeof p.cwd !== "string") {
    return false;
  }

  // env is optional but must be Record<string, string> if present
  if ("env" in p) {
    if (typeof p.env !== "object" || p.env === null) {
      return false;
    }
    const env = p.env as Record<string, unknown>;
    for (const [key, value] of Object.entries(env)) {
      if (typeof key !== "string" || typeof value !== "string") {
        return false;
      }
    }
  }

  return true;
}

/**
 * Type guard to check if result matches SystemRunResult structure.
 */
export function isSystemRunResult(result: unknown): result is SystemRunResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "stdout" in result &&
    typeof (result as SystemRunResult).stdout === "string" &&
    "stderr" in result &&
    typeof (result as SystemRunResult).stderr === "string" &&
    "exitCode" in result &&
    typeof (result as SystemRunResult).exitCode === "number"
  );
}

/**
 * Type guard to check if info matches NodeInfo structure.
 */
export function isNodeInfo(info: unknown): info is NodeInfo {
  return (
    typeof info === "object" &&
    info !== null &&
    "nodeId" in info &&
    typeof (info as NodeInfo).nodeId === "string" &&
    "platform" in info &&
    typeof (info as NodeInfo).platform === "string" &&
    "hostname" in info &&
    typeof (info as NodeInfo).hostname === "string"
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a Request message.
 */
export function createRequest(id: string, method: string, params: unknown): Request {
  return {
    type: "req",
    id,
    method,
    params,
  };
}

/**
 * Create a successful Response message.
 */
export function createSuccessResponse(id: string, payload?: unknown): Response {
  return {
    type: "res",
    id,
    ok: true,
    payload,
  };
}

/**
 * Create an error Response message.
 */
export function createErrorResponse(id: string, error: string): Response {
  return {
    type: "res",
    id,
    ok: false,
    error,
  };
}

/**
 * Create an Event message.
 */
export function createEvent(event: string, seq: number, payload: unknown): Event {
  return {
    type: "event",
    event,
    seq,
    payload,
  };
}
