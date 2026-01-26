#!/usr/bin/env bun
/**
 * Node Entry Point
 *
 * Starts the node daemon on this machine.
 * Connects to Gateway and handles incoming invoke requests.
 *
 * Usage:
 *   bun run bin/node.ts [--gateway ws://host:port] [--state ./state]
 *
 * Environment variables:
 *   GATEWAY_URL - Gateway WebSocket URL (default: ws://localhost:18789)
 *   STATE_PATH  - Path for state storage (default: ./state)
 */

import path from "node:path";
import { NodeDaemon } from "../src/node/index.js";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

function parseArgs(): { gatewayUrl: string; statePath: string } {
  const args = process.argv.slice(2);
  let gatewayUrl = process.env.GATEWAY_URL ?? "ws://localhost:18789";
  let statePath = process.env.STATE_PATH ?? "./state";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if ((arg === "--gateway" || arg === "-g") && nextArg !== undefined) {
      gatewayUrl = nextArg;
      i++;
    } else if ((arg === "--state" || arg === "-s") && nextArg !== undefined) {
      statePath = nextArg;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  // Resolve state path to absolute
  statePath = path.resolve(statePath);

  return { gatewayUrl, statePath };
}

function printUsage(): void {
  console.log(`
Node Daemon - Connects to Gateway and handles invoke requests

Usage:
  bun run bin/node.ts [options]

Options:
  -g, --gateway <url>   Gateway WebSocket URL (default: ws://localhost:18789)
  -s, --state <path>    Path for state storage (default: ./state)
  -h, --help            Show this help message

Environment Variables:
  GATEWAY_URL           Gateway WebSocket URL
  STATE_PATH            Path for state storage

Examples:
  bun run bin/node.ts
  bun run bin/node.ts --gateway ws://vps:18789
  bun run bin/node.ts --gateway wss://secure.example.com:18789 --state /var/lib/node
`);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const { gatewayUrl, statePath } = parseArgs();

  console.log("=".repeat(60));
  console.log("Node Daemon");
  console.log("=".repeat(60));
  console.log(`Gateway URL: ${gatewayUrl}`);
  console.log(`State Path:  ${statePath}`);
  console.log(`Platform:    ${process.platform}`);
  console.log(`Hostname:    ${(await import("node:os")).hostname()}`);
  console.log("=".repeat(60));

  const daemon = new NodeDaemon({
    gatewayUrl,
    statePath,
    // system.run is auto-registered by default
  });

  // Register additional handlers
  daemon.registerHandler("ping", () => {
    return { pong: true, timestamp: Date.now() };
  });

  // Setup event listeners for logging
  daemon.on("authenticated", () => {
    console.log("[Main] Authenticated with Gateway");
  });

  daemon.on("authFailed", (error) => {
    console.error(`[Main] Authentication failed: ${error}`);
  });

  daemon.on("invoke", (method, params) => {
    console.log(`[Main] Received invoke: ${method}`);
  });

  daemon.on("error", (error) => {
    console.error(`[Main] Error: ${error.message}`);
  });

  // Setup signal handlers for clean shutdown
  const shutdown = (): void => {
    console.log("\n[Main] Shutting down...");
    daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start the daemon
  await daemon.start();

  console.log("[Main] Node daemon running. Press Ctrl+C to stop.");

  // Keep the process running
  await new Promise(() => {
    // Never resolves - daemon runs until signal
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
