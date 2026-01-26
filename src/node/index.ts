/**
 * Node Module
 *
 * Exports the Node daemon and client for connecting to Gateway.
 * The daemon handles authentication, reconnection, and invoke request dispatch.
 */

export { NodeDaemon } from "./daemon.js";
export type { DaemonOptions, DaemonEvents, InvokeHandler } from "./daemon.js";

export { NodeClient } from "./client.js";
export type { ClientOptions, ClientEvents, ConnectionState } from "./client.js";

export { executeCommand, createSystemRunHandler } from "./system-run.js";

// CLI is exported separately via src/cli/index.ts
