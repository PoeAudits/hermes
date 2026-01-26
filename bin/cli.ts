#!/usr/bin/env bun
/**
 * CLI entry point
 * Command-line interface for hermes operations
 */

import { main } from "../src/cli/index.js";

main(process.argv.slice(2)).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
