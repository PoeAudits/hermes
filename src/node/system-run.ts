/**
 * System Run Command Handler
 *
 * Executes shell commands on the node and returns the result.
 * Uses spawn (not exec) for streaming and large output handling.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { SystemRunParams, SystemRunResult } from "../protocol/types.js";
import { isSystemRunParams } from "../protocol/types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Default timeout for command execution (120 seconds) */
const TIMEOUT_MS_DEFAULT = 120_000;

/** Maximum output size per stream (1MB) */
const OUTPUT_BYTES_MAX = 1024 * 1024;

/** Truncation message appended when output exceeds limit */
const TRUNCATION_MESSAGE = "\n... (output truncated)";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Options for command execution.
 */
interface ExecuteOptions {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

// -----------------------------------------------------------------------------
// Main Function
// -----------------------------------------------------------------------------

/**
 * Executes a shell command and returns the result.
 *
 * Features:
 * - Uses spawn for streaming output (handles large output)
 * - Configurable timeout with SIGTERM/SIGKILL escalation
 * - Output truncation if stdout/stderr exceed 1MB each
 * - Graceful handling of command not found
 * - Cross-platform support (Linux, macOS)
 *
 * @param params - Command parameters (command array, optional cwd, env)
 * @returns Promise resolving to SystemRunResult with stdout, stderr, exitCode
 * @throws Error if params are invalid
 *
 * @example
 * ```typescript
 * const result = await executeCommand({
 *   command: ["ls", "-la"],
 *   cwd: "/home/user",
 *   env: { NODE_ENV: "production" },
 * });
 * console.log(result.stdout);
 * ```
 */
export async function executeCommand(params: SystemRunParams): Promise<SystemRunResult> {
  // Validate params
  if (!isSystemRunParams(params)) {
    throw new Error("Invalid SystemRunParams: command must be a non-empty string array");
  }

  if (params.command.length === 0) {
    throw new Error("Invalid SystemRunParams: command array cannot be empty");
  }

  const options: ExecuteOptions = {
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    timeoutMs: TIMEOUT_MS_DEFAULT,
  };

  return executeCommandInternal(options);
}

/**
 * Internal command execution with full options.
 */
async function executeCommandInternal(options: ExecuteOptions): Promise<SystemRunResult> {
  const { command, cwd, env, timeoutMs } = options;

  // Command is validated to be non-empty before calling this function
  // This check satisfies TypeScript's type narrowing
  const executable = command[0];
  if (executable === undefined) {
    return {
      stdout: "",
      stderr: "command array is empty",
      exitCode: 1,
    };
  }
  const args = command.slice(1);

  return new Promise<SystemRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let resolved = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;

    // Merge env with process.env (params.env overrides)
    const mergedEnv = env !== undefined ? { ...process.env, ...env } : undefined;

    // Resolve cwd - use process.cwd() if not specified
    const resolvedCwd = cwd !== undefined && cwd.length > 0 ? cwd : process.cwd();

    try {
      child = spawn(executable, args, {
        cwd: resolvedCwd,
        env: mergedEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      // Spawn itself failed (e.g., invalid cwd)
      const errorMessage = error instanceof Error ? error.message : String(error);
      resolve({
        stdout: "",
        stderr: `spawn error: ${errorMessage}`,
        exitCode: 1,
      });
      return;
    }

    // Handle stdout
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) {
        return;
      }

      const remaining = OUTPUT_BYTES_MAX - stdoutBytes;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }

      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdout += slice.toString("utf8");
      stdoutBytes += slice.length;

      if (chunk.length > remaining) {
        stdoutTruncated = true;
      }
    });

    // Handle stderr
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrTruncated) {
        return;
      }

      const remaining = OUTPUT_BYTES_MAX - stderrBytes;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }

      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr += slice.toString("utf8");
      stderrBytes += slice.length;

      if (chunk.length > remaining) {
        stderrTruncated = true;
      }
    });

    // Finalize result
    const finalize = (exitCode: number): void => {
      if (resolved) {
        return;
      }
      resolved = true;

      // Clear timers
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }

      // Append truncation messages if needed
      if (stdoutTruncated) {
        stdout += TRUNCATION_MESSAGE;
      }
      if (stderrTruncated) {
        stderr += TRUNCATION_MESSAGE;
      }

      resolve({
        stdout,
        stderr,
        exitCode,
      });
    };

    // Handle process exit
    child.on("exit", (code, signal) => {
      // If killed by signal, use 128 + signal number convention
      // SIGTERM = 15, SIGKILL = 9
      let exitCode = code ?? 1;
      if (signal === "SIGTERM") {
        exitCode = 128 + 15;
      } else if (signal === "SIGKILL") {
        exitCode = 128 + 9;
      }
      finalize(exitCode);
    });

    // Handle spawn errors (e.g., command not found)
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (resolved) {
        return;
      }

      // ENOENT = command not found
      if (error.code === "ENOENT") {
        stderr = `command not found: ${executable}`;
        finalize(127);
        return;
      }

      // Other spawn errors
      stderr = `spawn error: ${error.message}`;
      finalize(1);
    });

    // Set up timeout
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (resolved) {
          return;
        }

        // First try SIGTERM for graceful shutdown
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }

        // If still running after 5 seconds, force kill with SIGKILL
        killTimer = setTimeout(() => {
          if (resolved) {
            return;
          }

          try {
            child.kill("SIGKILL");
          } catch {
            // Process may have already exited
          }

          // Force finalize if process doesn't respond to SIGKILL
          stderr += "\nprocess killed due to timeout";
          finalize(128 + 9);
        }, 5000);
      }, timeoutMs);
    }
  });
}

// -----------------------------------------------------------------------------
// Handler Factory
// -----------------------------------------------------------------------------

/**
 * Creates a handler function for the system.run command.
 * This handler can be registered with the NodeDaemon.
 *
 * @returns Handler function that takes params and returns SystemRunResult
 *
 * @example
 * ```typescript
 * const daemon = new NodeDaemon();
 * daemon.registerHandler("system.run", createSystemRunHandler());
 * ```
 */
export function createSystemRunHandler(): (params: unknown) => Promise<SystemRunResult> {
  return async (params: unknown): Promise<SystemRunResult> => {
    if (!isSystemRunParams(params)) {
      return {
        stdout: "",
        stderr: "invalid params: command must be a non-empty string array",
        exitCode: 1,
      };
    }

    if (params.command.length === 0) {
      return {
        stdout: "",
        stderr: "invalid params: command array cannot be empty",
        exitCode: 1,
      };
    }

    return executeCommand(params);
  };
}
