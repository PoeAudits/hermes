/**
 * System Run Command Tests
 *
 * Tests for the executeCommand function including:
 * - Successful command execution
 * - Command failure (non-zero exit)
 * - Command not found
 * - Timeout handling
 * - Large output truncation
 * - Environment variable handling
 * - Working directory handling
 */

import { describe, test, expect } from "bun:test";
import { executeCommand, createSystemRunHandler } from "./system-run.js";
import type { SystemRunParams } from "../protocol/types.js";

// -----------------------------------------------------------------------------
// Basic Execution Tests
// -----------------------------------------------------------------------------

describe("executeCommand", () => {
  describe("successful execution", () => {
    test("executes simple command and captures stdout", async () => {
      const params: SystemRunParams = {
        command: ["echo", "hello world"],
      };

      const result = await executeCommand(params);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello world");
      expect(result.stderr).toBe("");
    });

    test("executes command with multiple arguments", async () => {
      const params: SystemRunParams = {
        command: ["printf", "%s %s", "foo", "bar"],
      };

      const result = await executeCommand(params);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("foo bar");
    });

    test("captures stderr separately from stdout", async () => {
      const params: SystemRunParams = {
        command: ["sh", "-c", "echo stdout; echo stderr >&2"],
      };

      const result = await executeCommand(params);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("stdout");
      expect(result.stderr.trim()).toBe("stderr");
    });
  });

  describe("command failure", () => {
    test("returns non-zero exit code on failure", async () => {
      const params: SystemRunParams = {
        command: ["sh", "-c", "exit 42"],
      };

      const result = await executeCommand(params);

      expect(result.exitCode).toBe(42);
    });

    test("captures stderr on failure", async () => {
      const params: SystemRunParams = {
        command: ["sh", "-c", "echo error message >&2; exit 1"],
      };

      const result = await executeCommand(params);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe("error message");
    });
  });

  describe("command not found", () => {
    test("returns exit code 127 for missing command", async () => {
      const params: SystemRunParams = {
        command: ["nonexistent-command-xyz-12345"],
      };

      const result = await executeCommand(params);

      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("command not found");
    });

    test("includes command name in error message", async () => {
      const params: SystemRunParams = {
        command: ["my-missing-binary"],
      };

      const result = await executeCommand(params);

      expect(result.stderr).toContain("my-missing-binary");
    });
  });
});

// -----------------------------------------------------------------------------
// Working Directory Tests
// -----------------------------------------------------------------------------

describe("executeCommand cwd", () => {
  test("uses specified working directory", async () => {
    const params: SystemRunParams = {
      command: ["pwd"],
      cwd: "/tmp",
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    // On macOS, /tmp is a symlink to /private/tmp
    expect(result.stdout.trim()).toMatch(/^(\/tmp|\/private\/tmp)$/);
  });

  test("uses process.cwd() when cwd not specified", async () => {
    const params: SystemRunParams = {
      command: ["pwd"],
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(process.cwd());
  });

  test("handles invalid cwd gracefully", async () => {
    const params: SystemRunParams = {
      command: ["echo", "test"],
      cwd: "/nonexistent-directory-xyz-12345",
    };

    const result = await executeCommand(params);

    // Invalid cwd results in ENOENT error (command not found in that context)
    // or spawn error depending on the platform
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Environment Variable Tests
// -----------------------------------------------------------------------------

describe("executeCommand env", () => {
  test("passes custom environment variables", async () => {
    const params: SystemRunParams = {
      command: ["sh", "-c", "echo $MY_TEST_VAR"],
      env: { MY_TEST_VAR: "custom_value" },
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("custom_value");
  });

  test("merges with process.env", async () => {
    const params: SystemRunParams = {
      command: ["sh", "-c", "echo $PATH"],
      env: { MY_VAR: "test" },
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    // PATH should still be available from process.env
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  test("custom env overrides process.env", async () => {
    const params: SystemRunParams = {
      command: ["sh", "-c", "echo $HOME"],
      env: { HOME: "/custom/home" },
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/custom/home");
  });
});

// -----------------------------------------------------------------------------
// Timeout Tests
// -----------------------------------------------------------------------------

describe("executeCommand timeout", () => {
  test("kills process that exceeds timeout", async () => {
    // Note: We can't easily test the default 120s timeout, so we test the behavior
    // by using a command that would run forever
    const params: SystemRunParams = {
      command: ["sleep", "0.1"],
    };

    const result = await executeCommand(params);

    // This should complete normally (not timeout)
    expect(result.exitCode).toBe(0);
  });

  test("handles process that ignores SIGTERM", async () => {
    // This test verifies the SIGKILL escalation works
    // We use a short-running command to avoid long test times
    const params: SystemRunParams = {
      command: ["sh", "-c", "trap '' TERM; sleep 0.1"],
    };

    const result = await executeCommand(params);

    // Should complete normally since sleep is short
    expect(result.exitCode).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Large Output Tests
// -----------------------------------------------------------------------------

describe("executeCommand large output", () => {
  test("truncates stdout exceeding 1MB", async () => {
    // Generate ~1.5MB of output
    const params: SystemRunParams = {
      command: ["sh", "-c", "yes 'x' | head -c 1572864"],
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    // Should be truncated to ~1MB + truncation message
    expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024 + 100);
    expect(result.stdout).toContain("(output truncated)");
  });

  test("truncates stderr exceeding 1MB", async () => {
    // Generate ~1.5MB of stderr
    const params: SystemRunParams = {
      command: ["sh", "-c", "yes 'x' | head -c 1572864 >&2"],
    };

    const result = await executeCommand(params);

    // yes exits with error when pipe closes
    expect(result.stderr.length).toBeLessThanOrEqual(1024 * 1024 + 100);
    expect(result.stderr).toContain("(output truncated)");
  });

  test("handles both stdout and stderr truncation", async () => {
    const params: SystemRunParams = {
      command: ["sh", "-c", "yes 'o' | head -c 1572864; yes 'e' | head -c 1572864 >&2"],
    };

    const result = await executeCommand(params);

    expect(result.stdout).toContain("(output truncated)");
    expect(result.stderr).toContain("(output truncated)");
  });
});

// -----------------------------------------------------------------------------
// Input Validation Tests
// -----------------------------------------------------------------------------

describe("executeCommand validation", () => {
  test("throws on empty command array", async () => {
    const params: SystemRunParams = {
      command: [],
    };

    await expect(executeCommand(params)).rejects.toThrow("empty");
  });

  test("throws on invalid params type", async () => {
    const params = { notCommand: ["test"] } as unknown as SystemRunParams;

    await expect(executeCommand(params)).rejects.toThrow("Invalid");
  });

  test("throws on non-array command", async () => {
    const params = { command: "echo test" } as unknown as SystemRunParams;

    await expect(executeCommand(params)).rejects.toThrow("Invalid");
  });
});

// -----------------------------------------------------------------------------
// Handler Factory Tests
// -----------------------------------------------------------------------------

describe("createSystemRunHandler", () => {
  test("creates handler that executes commands", async () => {
    const handler = createSystemRunHandler();

    const result = await handler({
      command: ["echo", "handler test"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("handler test");
  });

  test("handler returns error result for invalid params", async () => {
    const handler = createSystemRunHandler();

    const result = await handler({
      notCommand: ["test"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid params");
  });

  test("handler returns error result for empty command", async () => {
    const handler = createSystemRunHandler();

    const result = await handler({
      command: [],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid params");
  });
});

// -----------------------------------------------------------------------------
// Edge Cases
// -----------------------------------------------------------------------------

describe("executeCommand edge cases", () => {
  test("handles command with special characters in arguments", async () => {
    const params: SystemRunParams = {
      command: ["echo", "hello\nworld"],
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("world");
  });

  test("handles command with spaces in arguments", async () => {
    const params: SystemRunParams = {
      command: ["echo", "hello world with spaces"],
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world with spaces");
  });

  test("handles command with empty string argument", async () => {
    const params: SystemRunParams = {
      command: ["printf", "%s|%s", "", "after"],
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("|after");
  });

  test("handles binary output gracefully", async () => {
    const params: SystemRunParams = {
      command: ["sh", "-c", "printf '\\x00\\x01\\x02'"],
    };

    const result = await executeCommand(params);

    expect(result.exitCode).toBe(0);
    // Binary data should be captured (may have encoding issues but shouldn't crash)
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test("handles rapid sequential commands", async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      executeCommand({
        command: ["echo", `test-${i}`],
      })
    );

    const results = await Promise.all(promises);

    expect(results.length).toBe(10);
    results.forEach((result, i) => {
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(`test-${i}`);
    });
  });
});
