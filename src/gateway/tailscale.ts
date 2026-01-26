/**
 * Tailscale Serve Module
 *
 * Provides functions to configure Tailscale Serve for exposing the Gateway
 * as HTTPS within the tailnet. Only accessible within the tailnet (not public).
 *
 * Key functions:
 * - isTailscaleAvailable() - Check if Tailscale CLI is present and logged in
 * - getTailnetHostname() - Get the machine's tailnet hostname
 * - enableTailscaleServe(port) - Configure Tailscale to serve the port
 * - disableTailscaleServe(port) - Remove the serve config
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Result of a command execution.
 */
interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Options for command execution.
 */
interface ExecOptions {
  timeoutMs?: number;
}

/**
 * Executor function type for dependency injection in tests.
 */
export type CommandExecutor = (
  command: string,
  args: string[],
  options?: ExecOptions
) => Promise<ExecResult>;

/**
 * Logger interface for Tailscale operations.
 */
export interface TailscaleLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Tailscale status JSON structure (partial).
 */
interface TailscaleStatus {
  Self?: {
    DNSName?: string;
    TailscaleIPs?: string[];
  };
  BackendState?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const TIMEOUT_MS_DEFAULT = 10000;
const TIMEOUT_MS_SERVE = 15000;

// Known Tailscale binary locations
const TAILSCALE_PATHS = [
  "tailscale", // PATH lookup
  "/usr/bin/tailscale", // Linux standard
  "/usr/local/bin/tailscale", // Linux alternative
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale", // macOS app
];

// -----------------------------------------------------------------------------
// Command Execution
// -----------------------------------------------------------------------------

/**
 * Default command executor using child_process.spawn.
 */
export async function execCommand(
  command: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS_DEFAULT;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

// -----------------------------------------------------------------------------
// Tailscale Binary Detection
// -----------------------------------------------------------------------------

let cachedBinaryPath: string | undefined;

/**
 * Finds the Tailscale binary path.
 * Caches the result for subsequent calls.
 *
 * @param exec - Command executor (for testing)
 * @returns Path to Tailscale binary or undefined if not found
 */
export async function findTailscaleBinary(
  exec: CommandExecutor = execCommand
): Promise<string | undefined> {
  if (cachedBinaryPath !== undefined) {
    return cachedBinaryPath;
  }

  for (const path of TAILSCALE_PATHS) {
    // Skip absolute paths that don't exist
    if (path.startsWith("/") && !existsSync(path)) {
      continue;
    }

    try {
      const result = await exec(path, ["--version"], { timeoutMs: 3000 });
      if (result.exitCode === 0) {
        cachedBinaryPath = path;
        return path;
      }
    } catch {
      // Continue to next path
    }
  }

  return undefined;
}

/**
 * Clears the cached binary path (for testing).
 */
export function clearBinaryCache(): void {
  cachedBinaryPath = undefined;
}

// -----------------------------------------------------------------------------
// Permission Handling
// -----------------------------------------------------------------------------

/**
 * Checks if an error indicates a permission denied issue.
 */
function isPermissionDenied(result: ExecResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    combined.includes("permission denied") ||
    combined.includes("access denied") ||
    combined.includes("operation not permitted") ||
    combined.includes("requires root") ||
    combined.includes("must be run as root") ||
    combined.includes("must be run with sudo") ||
    combined.includes("requires sudo") ||
    combined.includes("need sudo")
  );
}

/**
 * Executes a command with sudo fallback if permission denied.
 * First tries without sudo, then with sudo -n (non-interactive).
 *
 * @param exec - Command executor
 * @param binary - The binary to execute
 * @param args - Command arguments
 * @param options - Execution options
 * @returns Execution result
 */
async function execWithSudoFallback(
  exec: CommandExecutor,
  binary: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  // First try without sudo
  const result = await exec(binary, args, options);

  if (result.exitCode === 0) {
    return result;
  }

  // Check if it's a permission issue
  if (!isPermissionDenied(result)) {
    return result;
  }

  // Try with sudo -n (non-interactive, will fail if password required)
  try {
    const sudoResult = await exec("sudo", ["-n", binary, ...args], options);
    return sudoResult;
  } catch {
    // Sudo failed, return original result
    return result;
  }
}

// -----------------------------------------------------------------------------
// Tailscale Status Parsing
// -----------------------------------------------------------------------------

/**
 * Parses JSON that may have extra output before/after the JSON object.
 */
function parseNoisyJson(stdout: string): TailscaleStatus {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as TailscaleStatus;
  }

  return JSON.parse(trimmed) as TailscaleStatus;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Checks if Tailscale CLI is available and the daemon is running.
 *
 * @param exec - Command executor (for testing)
 * @returns true if Tailscale is available and logged in
 */
export async function isTailscaleAvailable(
  exec: CommandExecutor = execCommand
): Promise<boolean> {
  const binary = await findTailscaleBinary(exec);
  if (binary === undefined) {
    return false;
  }

  try {
    const result = await exec(binary, ["status", "--json"], { timeoutMs: 5000 });
    if (result.exitCode !== 0) {
      return false;
    }

    const status = parseNoisyJson(result.stdout);

    // Check if backend is running (not "Stopped" or "NeedsLogin")
    const backendState = status.BackendState ?? "";
    if (backendState === "Stopped" || backendState === "NeedsLogin") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the machine's tailnet hostname (e.g., "machine.tailnet.ts.net").
 *
 * @param exec - Command executor (for testing)
 * @returns The tailnet hostname or undefined if not available
 */
export async function getTailnetHostname(
  exec: CommandExecutor = execCommand
): Promise<string | undefined> {
  const binary = await findTailscaleBinary(exec);
  if (binary === undefined) {
    return undefined;
  }

  try {
    const result = await exec(binary, ["status", "--json"], { timeoutMs: 5000 });
    if (result.exitCode !== 0) {
      return undefined;
    }

    const status = parseNoisyJson(result.stdout);
    const self = status.Self;

    if (self === undefined) {
      return undefined;
    }

    // Prefer DNS name over IP
    if (typeof self.DNSName === "string" && self.DNSName.length > 0) {
      // Remove trailing dot if present
      return self.DNSName.replace(/\.$/, "");
    }

    // Fall back to first Tailscale IP
    if (Array.isArray(self.TailscaleIPs) && self.TailscaleIPs.length > 0) {
      return self.TailscaleIPs[0];
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Result of enableTailscaleServe with detailed status.
 */
export interface EnableServeResult {
  success: boolean;
  notEnabled?: boolean; // Serve feature not enabled on tailnet
  message?: string;
}

/**
 * Checks if the output indicates Serve is not enabled on the tailnet.
 */
function isServeNotEnabled(result: ExecResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    combined.includes("serve is not enabled") ||
    combined.includes("funnel is not enabled") ||
    combined.includes("not enabled on your tailnet")
  );
}

/**
 * Enables Tailscale Serve for the specified port.
 * This exposes the port as HTTPS within the tailnet only.
 *
 * @param port - The local port to serve
 * @param exec - Command executor (for testing)
 * @returns true if successful, false otherwise
 */
export async function enableTailscaleServe(
  port: number,
  exec: CommandExecutor = execCommand
): Promise<boolean> {
  const binary = await findTailscaleBinary(exec);
  if (binary === undefined) {
    return false;
  }

  try {
    // Use --bg to run in background, --yes to skip confirmation
    const result = await execWithSudoFallback(
      exec,
      binary,
      ["serve", "--bg", "--yes", `${port}`],
      { timeoutMs: TIMEOUT_MS_SERVE }
    );

    // Check if serve is not enabled on the tailnet
    // This happens when the command times out or returns with the "not enabled" message
    if (isServeNotEnabled(result)) {
      return false;
    }

    return result.exitCode === 0;
  } catch (error) {
    // Timeout errors may still have partial output captured
    // The command hangs when serve is not enabled, so timeout is expected
    return false;
  }
}

/**
 * Disables Tailscale Serve for the specified port.
 *
 * @param port - The port to stop serving (used to construct the URL to remove)
 * @param exec - Command executor (for testing)
 * @returns true if successful, false otherwise
 */
export async function disableTailscaleServe(
  port: number,
  exec: CommandExecutor = execCommand
): Promise<boolean> {
  const binary = await findTailscaleBinary(exec);
  if (binary === undefined) {
    return false;
  }

  try {
    // Reset removes all serve configurations
    // We use reset because it's simpler and the gateway typically owns the serve config
    const result = await execWithSudoFallback(
      exec,
      binary,
      ["serve", "reset"],
      { timeoutMs: TIMEOUT_MS_SERVE }
    );

    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Gateway Integration
// -----------------------------------------------------------------------------

/**
 * Options for starting Tailscale Serve with the gateway.
 */
export interface TailscaleServeOptions {
  port: number;
  logger: TailscaleLogger;
  resetOnExit?: boolean;
}

/**
 * Cleanup function type returned by startTailscaleServe.
 */
export type TailscaleCleanup = () => Promise<void>;

/**
 * Checks if Tailscale Serve is enabled on the tailnet.
 * Note: This is a best-effort check. The serve status command may succeed
 * even when serve is not enabled on the tailnet. The definitive check
 * happens when actually trying to enable serve.
 *
 * @param exec - Command executor (for testing)
 * @returns true if serve appears to be available
 */
export async function isServeEnabled(
  exec: CommandExecutor = execCommand
): Promise<boolean> {
  const binary = await findTailscaleBinary(exec);
  if (binary === undefined) {
    return false;
  }

  try {
    // Check serve status - this returns quickly and shows if serve is configured
    const result = await exec(binary, ["serve", "status", "--json"], { timeoutMs: 5000 });

    // If the command fails with "not enabled", serve is not available on the tailnet
    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (combined.includes("not enabled")) {
        return false;
      }
    }

    // Note: Even if this returns true, the actual serve command may still fail
    // if serve is not enabled on the tailnet (the status command doesn't check this)
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts Tailscale Serve for the gateway.
 * Returns a cleanup function to disable serve on shutdown.
 *
 * This function is designed to fail gracefully - if Tailscale is not available
 * or serve fails to enable, it logs a warning and returns null instead of throwing.
 *
 * @param options - Configuration options
 * @param exec - Command executor (for testing)
 * @returns Cleanup function or null if Tailscale not available/failed
 */
export async function startTailscaleServe(
  options: TailscaleServeOptions,
  exec: CommandExecutor = execCommand
): Promise<TailscaleCleanup | null> {
  const { port, logger, resetOnExit = true } = options;

  // Check if Tailscale is available
  const available = await isTailscaleAvailable(exec);
  if (!available) {
    logger.warn("Tailscale not available - serve not enabled");
    return null;
  }

  // Check if serve is enabled on the tailnet first (quick check)
  const serveEnabled = await isServeEnabled(exec);
  if (!serveEnabled) {
    logger.warn("Tailscale Serve not enabled on tailnet - visit admin console to enable");
    return null;
  }

  // Enable serve
  // Note: This may fail with a timeout if serve is not actually enabled on the tailnet
  // (the status check above doesn't catch all cases)
  const enabled = await enableTailscaleServe(port, exec);
  if (!enabled) {
    logger.warn("Failed to enable Tailscale Serve (may not be enabled on tailnet) - continuing without");
    return null;
  }

  // Get hostname for logging
  const hostname = await getTailnetHostname(exec);
  if (hostname !== undefined) {
    logger.info(`Tailscale Serve enabled: https://${hostname}`);
  } else {
    logger.info("Tailscale Serve enabled");
  }

  // Return cleanup function if requested
  if (!resetOnExit) {
    return null;
  }

  return async (): Promise<void> => {
    try {
      const disabled = await disableTailscaleServe(port, exec);
      if (disabled) {
        logger.info("Tailscale Serve disabled");
      } else {
        logger.warn("Failed to disable Tailscale Serve");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Tailscale Serve cleanup failed: ${message}`);
    }
  };
}
