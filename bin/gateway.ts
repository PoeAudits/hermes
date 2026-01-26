#!/usr/bin/env bun
/**
 * Gateway entry point
 *
 * Starts the central gateway server that accepts WebSocket connections
 * from nodes and handles authentication.
 *
 * Usage:
 *   bun run bin/gateway.ts [options]
 *
 * Options:
 *   --tailscale-serve    Enable Tailscale Serve (HTTPS within tailnet)
 *   --help, -h           Show help message
 *
 * Environment:
 *   GATEWAY_PORT         Port to listen on (default: 18789)
 *   GATEWAY_HOST         Host to bind to (default: 0.0.0.0)
 */

import { Gateway } from "../src/gateway/index.js";
import {
  startTailscaleServe,
  getTailnetHostname,
  type TailscaleCleanup,
} from "../src/gateway/tailscale.js";

// -----------------------------------------------------------------------------
// CLI Argument Parsing
// -----------------------------------------------------------------------------

interface CliArgs {
  tailscaleServe: boolean;
  help: boolean;
}

function parseArgs(args: string[]): CliArgs {
  return {
    tailscaleServe: args.includes("--tailscale-serve"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

function printHelp(): void {
  console.log(`
Gateway - Central WebSocket server for node connections

Usage:
  bun run bin/gateway.ts [options]

Options:
  --tailscale-serve    Enable Tailscale Serve (HTTPS within tailnet)
  --help, -h           Show this help message

Environment:
  GATEWAY_PORT         Port to listen on (default: 18789)
  GATEWAY_HOST         Host to bind to (default: 0.0.0.0)

Examples:
  # Start gateway on default port
  bun run bin/gateway.ts

  # Start with Tailscale Serve enabled
  bun run bin/gateway.ts --tailscale-serve

  # Start on custom port
  GATEWAY_PORT=9000 bun run bin/gateway.ts
`);
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const PORT = parseInt(process.env.GATEWAY_PORT ?? "18789", 10);
const HOST = process.env.GATEWAY_HOST ?? "0.0.0.0";

// -----------------------------------------------------------------------------
// Logger
// -----------------------------------------------------------------------------

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function createLogger(prefix: string): Logger {
  const formatMessage = (level: string, message: string): string => {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${prefix}] [${level}] ${message}`;
  };

  return {
    info: (message: string) => console.log(formatMessage("INFO", message)),
    warn: (message: string) => console.warn(formatMessage("WARN", message)),
    error: (message: string) => console.error(formatMessage("ERROR", message)),
  };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const logger = createLogger("gateway");
  const gateway = new Gateway({ port: PORT, host: HOST });

  // Track cleanup functions for graceful shutdown
  let tailscaleCleanup: TailscaleCleanup | null = null;

  // Handle graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("\nShutting down gateway...");

    // Cleanup Tailscale Serve first
    if (tailscaleCleanup !== null) {
      await tailscaleCleanup();
    }

    await gateway.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    // Start the gateway
    await gateway.start();
    logger.info(`Gateway started on ${HOST}:${PORT}`);

    // Enable Tailscale Serve if requested
    if (args.tailscaleServe) {
      tailscaleCleanup = await startTailscaleServe({
        port: PORT,
        logger,
        resetOnExit: true,
      });
    }

    logger.info("Waiting for node connections...");
  } catch (error) {
    logger.error(`Failed to start gateway: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
