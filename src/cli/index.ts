/**
 * Hermes CLI
 *
 * Command-line interface for managing the hermes system.
 * Connects to Gateway as a client to list nodes, execute commands, and manage pairings.
 *
 * Architecture:
 * - CLI connects to Gateway via WebSocket as a regular client
 * - CLI authenticates like a node (using device identity)
 * - CLI sends node.list to get connected nodes
 * - CLI sends node.invoke to execute commands on nodes
 *
 * Commands:
 * - hermes nodes                      - List connected nodes with status
 * - hermes run <nodeId> <command...>  - Execute command on node
 * - hermes status                     - Show Gateway status
 * - hermes pair <deviceId>            - Approve pending device (requires pairing module)
 * - hermes unpair <deviceId>          - Revoke device (requires pairing module)
 * - hermes pending                    - List devices awaiting approval (requires pairing module)
 */

import path from "node:path";
import os from "node:os";
import { NodeClient } from "../node/client.js";
import { getOrCreateIdentity, signMessage } from "../identity/device.js";
import type { NodeInfo, Response } from "../protocol/types.js";
import {
  handlePairCommand as handlePairLocal,
  handleUnpairCommand as handleUnpairLocal,
  handlePendingCommand as handlePendingLocal,
  handlePairedCommand as handlePairedLocal,
} from "./pairing.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface CliOptions {
  gatewayUrl: string;
  statePath: string;
  timeoutMs: number;
  json: boolean;
}

interface NodeListResponse {
  nodes: Array<{
    deviceId: string;
    nodeInfo: NodeInfo;
    connectedAtMs: number;
  }>;
}

interface InvokeResponse {
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

interface GatewayStatusResponse {
  listening: boolean;
  host: string;
  port: number;
  nodesConnected: number;
  tailscaleEnabled: boolean;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_OPTIONS: CliOptions = {
  gatewayUrl: process.env.GATEWAY_URL ?? "ws://localhost:18789",
  statePath: process.env.STATE_PATH ?? path.join(os.homedir(), ".config", "hermes-cli"),
  timeoutMs: 120_000,
  json: false,
};

// -----------------------------------------------------------------------------
// ANSI Color Codes
// -----------------------------------------------------------------------------

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

/**
 * Formats text with ANSI color codes.
 */
function colorize(text: string, color: keyof typeof COLORS): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

/**
 * Formats a header with separator line.
 */
function formatHeader(text: string): string {
  return `${colorize(text, "bold")}\n${colorize("─".repeat(80), "gray")}`;
}

/**
 * Formats a key-value pair with aligned columns.
 */
function formatKeyValue(key: string, value: string, keyWidth: number = 16): string {
  return `  ${colorize(key.padEnd(keyWidth), "cyan")} ${value}`;
}

/**
 * Formats an error message.
 */
function formatError(message: string): string {
  return `${colorize("✗", "red")} ${colorize(message, "red")}`;
}

/**
 * Formats a success message.
 */
function formatSuccess(message: string): string {
  return `${colorize("✓", "green")} ${message}`;
}

/**
 * Formats a warning message.
 */
function formatWarning(message: string): string {
  return `${colorize("⚠", "yellow")} ${colorize(message, "yellow")}`;
}

// -----------------------------------------------------------------------------
// CLI Client
// -----------------------------------------------------------------------------

/**
 * CLI client that connects to Gateway and executes commands.
 */
class CliClient {
  private readonly options: CliOptions;
  private client: NodeClient | undefined;

  constructor(options: Partial<CliOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Connects to Gateway and authenticates.
   */
  async connect(): Promise<void> {
    const identity = await getOrCreateIdentity(this.options.statePath);

    this.client = new NodeClient({
      gatewayUrl: this.options.gatewayUrl,
      reconnect: false, // CLI doesn't need reconnection
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 10_000);

      this.client!.on("connected", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.client!.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.client!.connect();
    });

    // Perform authentication handshake
    const nodeInfo: NodeInfo = {
      nodeId: identity.deviceId,
      platform: process.platform,
      hostname: os.hostname(),
    };

    // Step 1: Send node.hello
    const helloResponse = await this.client.request<{ challenge: string }>("node.hello", {
      nodeInfo,
      publicKey: identity.publicKey,
    });

    if (typeof helloResponse?.challenge !== "string") {
      throw new Error("Invalid challenge received from Gateway");
    }

    // Step 2: Sign challenge and send node.auth
    const signature = signMessage(helloResponse.challenge, identity.privateKey);
    const authResponse = await this.client.request<{ deviceId: string }>("node.auth", {
      signature,
    });

    if (typeof authResponse?.deviceId !== "string") {
      throw new Error("Authentication failed");
    }

    this.client.setAuthenticated();
  }

  /**
   * Disconnects from Gateway.
   */
  disconnect(): void {
    this.client?.disconnect();
  }

  /**
   * Lists connected nodes.
   */
  async listNodes(): Promise<NodeListResponse> {
    if (this.client === undefined) {
      throw new Error("Not connected");
    }

    const response = await this.client.request<NodeListResponse>("node.list", {});
    return response;
  }

  /**
   * Gets Gateway status information.
   */
  async getStatus(): Promise<GatewayStatusResponse> {
    if (this.client === undefined) {
      throw new Error("Not connected");
    }

    const response = await this.client.request<GatewayStatusResponse>("gateway.status", {});
    return response;
  }

  /**
   * Invokes a command on a target node.
   */
  async invoke(targetNodeId: string, method: string, params: unknown): Promise<InvokeResponse> {
    if (this.client === undefined) {
      throw new Error("Not connected");
    }

    const response = await this.client.request<InvokeResponse>(
      "node.invoke",
      {
        targetNodeId,
        method,
        params,
        timeoutMs: this.options.timeoutMs,
      },
      this.options.timeoutMs + 5000 // Add buffer for network latency
    );

    return response;
  }
}

// -----------------------------------------------------------------------------
// Command Handlers
// -----------------------------------------------------------------------------

/**
 * Handles the 'nodes' command - lists connected nodes.
 */
async function handleNodesCommand(options: Partial<CliOptions>): Promise<void> {
  const client = new CliClient(options);

  try {
    await client.connect();
    const response = await client.listNodes();

    // JSON output
    if (options.json === true) {
      console.log(JSON.stringify(response.nodes, null, 2));
      return;
    }

    // Human-readable output
    if (response.nodes.length === 0) {
      console.log(formatWarning("No nodes connected"));
      return;
    }

    console.log(formatHeader(`Connected Nodes (${response.nodes.length})`));
    console.log("");

    for (const node of response.nodes) {
      const connectedAt = new Date(node.connectedAtMs);
      const uptime = formatUptime(Date.now() - node.connectedAtMs);
      
      console.log(colorize(`● ${node.nodeInfo.hostname}`, "bold"));
      console.log(formatKeyValue("Device ID:", node.deviceId));
      console.log(formatKeyValue("Platform:", node.nodeInfo.platform));
      console.log(formatKeyValue("Status:", colorize("online", "green")));
      console.log(formatKeyValue("Connected:", `${connectedAt.toLocaleString()} (${uptime})`));
      console.log("");
    }
  } catch (error) {
    handleConnectionError(error, options.json === true);
  } finally {
    client.disconnect();
  }
}

/**
 * Handles the 'status' command - shows Gateway status.
 */
async function handleStatusCommand(options: Partial<CliOptions>): Promise<void> {
  const client = new CliClient(options);

  try {
    await client.connect();
    const response = await client.getStatus();

    // JSON output
    if (options.json === true) {
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    // Human-readable output
    console.log(formatHeader("Gateway Status"));
    console.log("");
    console.log(formatKeyValue("Listening:", response.listening ? colorize("yes", "green") : colorize("no", "red")));
    console.log(formatKeyValue("Address:", `${response.host}:${response.port}`));
    console.log(formatKeyValue("Nodes Connected:", String(response.nodesConnected)));
    console.log(formatKeyValue("Tailscale:", response.tailscaleEnabled ? colorize("enabled", "green") : colorize("disabled", "gray")));
    console.log("");
  } catch (error) {
    handleConnectionError(error, options.json === true);
  } finally {
    client.disconnect();
  }
}

/**
 * Handles the 'run' command - executes a command on a node.
 */
async function handleRunCommand(
  nodeId: string,
  command: string[],
  options: Partial<CliOptions>
): Promise<void> {
  if (command.length === 0) {
    if (options.json === true) {
      console.log(JSON.stringify({ error: "No command specified" }));
    } else {
      console.error(formatError("No command specified"));
      console.error(`Usage: hermes run <nodeId> <command...>`);
    }
    process.exit(1);
  }

  const client = new CliClient(options);

  try {
    await client.connect();

    // Show execution header (not in JSON mode)
    if (options.json !== true) {
      console.log(colorize(`Executing on ${nodeId}:`, "dim"));
      console.log(colorize(`  ${command.join(" ")}`, "cyan"));
      console.log(colorize("─".repeat(80), "gray"));
      console.log("");
    }

    const response = await client.invoke(nodeId, "system.run", { command });

    if (!response.ok) {
      const errorMsg = response.error?.message ?? "Unknown error";
      const errorCode = response.error?.code ?? "UNKNOWN";
      
      if (options.json === true) {
        console.log(JSON.stringify({ error: errorMsg, code: errorCode }));
      } else {
        console.error(formatError(`[${errorCode}] ${errorMsg}`));
        
        // Provide helpful hints for common errors
        if (errorCode === "NOT_FOUND") {
          console.error(colorize("\nHint: Check that the node ID is correct using 'hermes nodes'", "dim"));
        } else if (errorCode === "TIMEOUT") {
          console.error(colorize("\nHint: Try increasing timeout with --timeout <ms>", "dim"));
        }
      }
      process.exit(1);
    }

    const payload = response.payload as { stdout?: string; stderr?: string; exitCode?: number } | undefined;

    // JSON output
    if (options.json === true) {
      console.log(JSON.stringify({
        stdout: payload?.stdout ?? "",
        stderr: payload?.stderr ?? "",
        exitCode: payload?.exitCode ?? 0,
      }));
      process.exit(payload?.exitCode ?? 0);
    }

    // Human-readable output
    if (payload?.stdout !== undefined && payload.stdout.length > 0) {
      process.stdout.write(payload.stdout);
      if (!payload.stdout.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }

    if (payload?.stderr !== undefined && payload.stderr.length > 0) {
      process.stderr.write(payload.stderr);
      if (!payload.stderr.endsWith("\n")) {
        process.stderr.write("\n");
      }
    }

    const exitCode = payload?.exitCode ?? 0;
    if (exitCode !== 0) {
      console.log("");
      console.log(colorize(`Exit code: ${exitCode}`, "red"));
    }

    process.exit(exitCode);
  } catch (error) {
    handleConnectionError(error, options.json === true);
    process.exit(1);
  } finally {
    client.disconnect();
  }
}

/**
 * Handles the 'pair' command - approves a pending device.
 * Uses local pairing store (must be run on Gateway machine).
 */
async function handlePairCommand(deviceId: string, options: Partial<CliOptions>): Promise<void> {
  await handlePairLocal(deviceId, { json: options.json });
}

/**
 * Handles the 'unpair' command - revokes a device.
 * Uses local pairing store (must be run on Gateway machine).
 */
async function handleUnpairCommand(deviceId: string, options: Partial<CliOptions>): Promise<void> {
  await handleUnpairLocal(deviceId, { json: options.json });
}

/**
 * Handles the 'pending' command - lists devices awaiting approval.
 * Uses local pairing store (must be run on Gateway machine).
 */
async function handlePendingCommand(options: Partial<CliOptions>): Promise<void> {
  await handlePendingLocal({ json: options.json });
}

/**
 * Handles the 'paired' command - lists all paired devices.
 * Uses local pairing store (must be run on Gateway machine).
 */
async function handlePairedCommand(options: Partial<CliOptions>): Promise<void> {
  await handlePairedLocal({ json: options.json });
}

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

/**
 * Formats uptime duration in human-readable format.
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Handles connection errors with helpful messages.
 */
function handleConnectionError(error: unknown, jsonMode: boolean): void {
  const errorMsg = error instanceof Error ? error.message : String(error);
  
  if (jsonMode) {
    console.log(JSON.stringify({ error: errorMsg }));
    return;
  }

  console.error(formatError(errorMsg));
  
  // Provide helpful hints for common connection errors
  if (errorMsg.includes("ECONNREFUSED")) {
    console.error(colorize("\nHint: Gateway may not be running. Start it with 'hermes-gateway'", "dim"));
  } else if (errorMsg.includes("timeout") || errorMsg.includes("Connection timeout")) {
    console.error(colorize("\nHint: Gateway is not responding. Check network connectivity", "dim"));
  } else if (errorMsg.includes("Authentication failed")) {
    console.error(colorize("\nHint: Authentication failed. Try removing ~/.config/hermes-cli and reconnecting", "dim"));
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
${colorize("Hermes CLI", "bold")} - Manage the hermes system

${colorize("USAGE:", "bold")}
  hermes <command> [options] [args...]

${colorize("COMMANDS:", "bold")}
  ${colorize("nodes", "cyan")}                              List connected nodes with status
  ${colorize("run", "cyan")} <nodeId> <command...>          Execute command on a node
  ${colorize("status", "cyan")}                             Show Gateway status
  ${colorize("pair", "cyan")} <deviceId>                    Approve pending device
  ${colorize("unpair", "cyan")} <deviceId>                  Revoke device access
  ${colorize("pending", "cyan")}                            List devices awaiting approval
  ${colorize("paired", "cyan")}                             List all paired devices

${colorize("OPTIONS:", "bold")}
  --gateway <url>                    Gateway WebSocket URL (default: ws://localhost:18789)
  --timeout <ms>                     Command timeout in milliseconds (default: 120000)
  --json                             Output in JSON format
  --help, -h                         Show this help message

${colorize("ENVIRONMENT VARIABLES:", "bold")}
  GATEWAY_URL                        Gateway WebSocket URL
  STATE_PATH                         Path for CLI state storage

${colorize("EXAMPLES:", "bold")}
  ${colorize("# List all connected nodes", "dim")}
  hermes nodes

  ${colorize("# Execute a command on a node", "dim")}
  hermes run abc123 ls -la
  hermes run abc123 echo "Hello, World!"

  ${colorize("# Check Gateway status", "dim")}
  hermes status

  ${colorize("# Connect to a different Gateway", "dim")}
  hermes --gateway ws://vps:18789 nodes

  ${colorize("# Get JSON output for scripting", "dim")}
  hermes nodes --json

  ${colorize("# Approve a pending device", "dim")}
  hermes pair abc123

  ${colorize("# List pending devices", "dim")}
  hermes pending
`);
}

function parseArgs(args: string[]): {
  command: string;
  nodeId?: string;
  commandArgs: string[];
  options: Partial<CliOptions>;
} {
  const options: Partial<CliOptions> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--gateway" || arg === "-g") {
      const nextArg = args[++i];
      if (nextArg !== undefined) {
        options.gatewayUrl = nextArg;
      }
    } else if (arg === "--timeout" || arg === "-t") {
      const nextArg = args[++i];
      if (nextArg !== undefined) {
        const parsed = parseInt(nextArg, 10);
        if (isNaN(parsed) || parsed <= 0) {
          console.error(formatError(`Invalid timeout value: ${nextArg}`));
          process.exit(1);
        }
        options.timeoutMs = parsed;
      }
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg?.startsWith("-")) {
      console.error(formatError(`Unknown option: ${arg}`));
      console.error(colorize("Run 'hermes --help' for usage information", "dim"));
      process.exit(1);
    } else {
      positional.push(arg ?? "");
    }

    i++;
  }

  const command = positional[0] ?? "";
  const nodeId = positional[1];
  const commandArgs = positional.slice(2);

  return { command, nodeId, commandArgs, options };
}

/**
 * Main entry point for the CLI.
 */
export async function main(args: string[]): Promise<void> {
  const { command, nodeId, commandArgs, options } = parseArgs(args);

  try {
    switch (command) {
      case "nodes":
        await handleNodesCommand(options);
        break;

      case "status":
        await handleStatusCommand(options);
        break;

      case "run":
        if (nodeId === undefined) {
          if (options.json === true) {
            console.log(JSON.stringify({ error: "Node ID required" }));
          } else {
            console.error(formatError("Node ID required"));
            console.error(colorize("Usage: hermes run <nodeId> <command...>", "dim"));
          }
          process.exit(1);
        }
        await handleRunCommand(nodeId, commandArgs, options);
        break;

      case "pair":
        if (nodeId === undefined) {
          if (options.json === true) {
            console.log(JSON.stringify({ error: "Device ID required" }));
          } else {
            console.error(formatError("Device ID required"));
            console.error(colorize("Usage: hermes pair <deviceId>", "dim"));
          }
          process.exit(1);
        }
        await handlePairCommand(nodeId, options);
        break;

      case "unpair":
        if (nodeId === undefined) {
          if (options.json === true) {
            console.log(JSON.stringify({ error: "Device ID required" }));
          } else {
            console.error(formatError("Device ID required"));
            console.error(colorize("Usage: hermes unpair <deviceId>", "dim"));
          }
          process.exit(1);
        }
        await handleUnpairCommand(nodeId, options);
        break;

      case "pending":
        await handlePendingCommand(options);
        break;

      case "paired":
        await handlePairedCommand(options);
        break;

      case "":
      case "help":
        printUsage();
        break;

      default:
        if (options.json === true) {
          console.log(JSON.stringify({ error: `Unknown command: ${command}` }));
        } else {
          console.error(formatError(`Unknown command: ${command}`));
          console.error(colorize("Run 'hermes --help' for usage information", "dim"));
        }
        process.exit(1);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (options.json === true) {
      console.log(JSON.stringify({ error: errorMsg }));
    } else {
      console.error(formatError(errorMsg));
    }
    process.exit(1);
  }
}
