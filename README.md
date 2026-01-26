# Hermes

Cross-machine command execution system for the Overlord infrastructure.

## Overview

Hermes enables secure, bidirectional command execution between machines over WebSocket connections. It uses a Gateway + Node architecture with Ed25519 authentication and optional Tailscale integration for HTTPS within your tailnet.

**Key Features:**
- **Challenge-response authentication** - Ed25519 signatures prevent unauthorized access
- **Invoke pattern** - Request/response RPC with timeout and idempotency support
- **Tailscale Serve integration** - Automatic HTTPS exposure within tailnet
- **Automatic reconnection** - Nodes reconnect with exponential backoff
- **Command execution** - Run shell commands on remote machines via `system.run`

## Quick Start

### 1. Start the Gateway

The Gateway is the central coordinator that routes commands between nodes.

```bash
# Start on your main machine (e.g., desktop)
bun run start:gateway

# Gateway listens on ws://0.0.0.0:18789
# If Tailscale is available, also serves on https://<hostname>.tailnet.ts.net
```

### 2. Start Node Daemons

Run a Node daemon on each machine you want to control.

```bash
# Start on each machine (e.g., laptop, VPS)
bun run start:node

# Node connects to Gateway and authenticates
# Automatically registers system.run handler for command execution
```

**Configuration:**
- Set `GATEWAY_URL` environment variable to point to your Gateway
- Default: `ws://localhost:18789`
- Example: `GATEWAY_URL=ws://desktop.tailnet.ts.net:18789 bun run start:node`

### 3. Use the CLI

List connected nodes and execute commands remotely.

```bash
# List all connected nodes
bun run cli nodes

# Show Gateway status
bun run cli status

# Execute a command on a specific node
bun run cli run <nodeId> <command...>

# Examples
bun run cli run abc123 ls -la
bun run cli run abc123 echo "Hello from remote!"
bun run cli run abc123 uname -a

# Get JSON output for scripting
bun run cli nodes --json
bun run cli status --json
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Gateway                             │
│  - WebSocket server (port 18789)                            │
│  - Challenge-response authentication                        │
│  - Node registry (tracks connected nodes)                   │
│  - Invoke routing (routes commands to target nodes)         │
│  - Tailscale Serve (optional HTTPS exposure)                │
└─────────────────────────────────────────────────────────────┘
                    ▲                    ▲
                    │ WebSocket          │ WebSocket
                    │                    │
        ┌───────────┴──────┐   ┌────────┴──────────┐
        │   Node Daemon    │   │   Node Daemon     │
        │   (desktop)      │   │   (laptop)        │
        │                  │   │                   │
        │  - Auto-connect  │   │  - Auto-connect   │
        │  - Auth handshake│   │  - Auth handshake │
        │  - system.run    │   │  - system.run     │
        └──────────────────┘   └───────────────────┘
```

**Authentication Flow:**
1. Node connects to Gateway via WebSocket
2. Node sends `node.hello` with public key and node info
3. Gateway responds with random challenge
4. Node signs challenge with private key
5. Node sends `node.auth` with signature
6. Gateway verifies signature and registers node

**Command Execution Flow:**
1. CLI sends `node.invoke` request to Gateway
2. Gateway routes to target node via `node.invoke.request` event
3. Node executes command via registered handler
4. Node sends `node.invoke.response` back to Gateway
5. Gateway returns result to CLI

## Directory Structure

```
hermes/
├── src/
│   ├── gateway/              # Gateway server
│   │   ├── server.ts         # Main Gateway class
│   │   ├── node-registry.ts  # Node tracking and invoke routing
│   │   ├── ws-handler.ts     # WebSocket connection handler
│   │   ├── tailscale.ts      # Tailscale Serve automation
│   │   └── tailscale-auth.ts # Tailscale identity extraction
│   ├── node/                 # Node daemon
│   │   ├── daemon.ts         # Main NodeDaemon class
│   │   ├── client.ts         # WebSocket client with reconnection
│   │   └── system-run.ts     # Command execution handler
│   ├── protocol/             # Shared protocol types
│   │   └── types.ts          # Request/Response/Event types
│   ├── identity/             # Device identity
│   │   └── device.ts         # Ed25519 keypair management
│   └── cli/                  # CLI commands
│       └── index.ts          # nodes, run commands
├── bin/                      # Entry point scripts
│   ├── gateway.ts            # Gateway entry point
│   ├── node.ts               # Node daemon entry point
│   └── cli.ts                # CLI entry point
└── state/                    # Runtime state (gitignored)
    └── identity/             # Device keypairs
```

## Configuration

### Gateway

**Environment Variables:**
- `GATEWAY_PORT` - Port to listen on (default: 18789)
- `GATEWAY_HOST` - Host to bind to (default: 0.0.0.0)

**Tailscale Serve:**
- Automatically enabled if Tailscale is available and logged in
- Exposes Gateway as HTTPS within tailnet only (not public)
- Requires Serve feature enabled in Tailscale admin console

### Node Daemon

**Environment Variables:**
- `GATEWAY_URL` - Gateway WebSocket URL (default: ws://localhost:18789)
- `STATE_PATH` - Path for identity storage (default: ./state)

**Reconnection:**
- Automatic reconnection with exponential backoff
- Initial delay: 1 second
- Max delay: 30 seconds
- Backoff multiplier: 2x

### CLI

**Environment Variables:**
- `GATEWAY_URL` - Gateway WebSocket URL (default: ws://localhost:18789)
- `STATE_PATH` - Path for CLI identity storage (default: ~/.config/hermes-cli)

**Command Timeout:**
- Default: 120 seconds
- Override with `--timeout <ms>` flag

**Available Commands:**
- `hermes nodes` - List connected nodes with status (online/offline, platform, uptime)
- `hermes status` - Show Gateway status (listening, address, connected nodes, Tailscale)
- `hermes run <nodeId> <command...>` - Execute command on a node
- `hermes pair <deviceId>` - Approve pending device (requires pairing module)
- `hermes unpair <deviceId>` - Revoke device access (requires pairing module)
- `hermes pending` - List devices awaiting approval (requires pairing module)

**Output Formats:**
- Human-readable (default) - Colored, formatted output for terminal use
- JSON (`--json` flag) - Machine-readable output for scripting

## Usage Examples

### List Connected Nodes

```bash
$ bun run cli nodes

Connected Nodes (2)
────────────────────────────────────────────────────────────────────────────────

● desktop-machine
  Device ID:       abc123de
  Platform:        linux
  Status:          online
  Connected:       1/25/2026, 10:30:00 AM (2h 15m)

● laptop
  Device ID:       xyz789fg
  Platform:        darwin
  Status:          online
  Connected:       1/25/2026, 10:35:00 AM (2h 10m)
```

### Show Gateway Status

```bash
$ bun run cli status

Gateway Status
────────────────────────────────────────────────────────────────────────────────

  Listening:       yes
  Address:         0.0.0.0:18789
  Nodes Connected: 2
  Tailscale:       enabled
```

### Execute Commands

```bash
# Simple command
$ bun run cli run abc123de uname -a
Executing on abc123de:
  uname -a
────────────────────────────────────────────────────────────────────────────────

Linux desktop-machine 6.1.0 #1 SMP x86_64 GNU/Linux

# Command with arguments
$ bun run cli run abc123de ls -la /home/user
Executing on abc123de:
  ls -la /home/user
────────────────────────────────────────────────────────────────────────────────

total 48
drwxr-xr-x 12 user user 4096 Jan 25 10:00 .
drwxr-xr-x  3 root root 4096 Jan 01 00:00 ..
...

# Command with pipes (quote the entire command)
$ bun run cli run abc123de "ps aux | grep node"
user     1234  0.5  1.2  ...  node daemon.ts

# JSON output for scripting
$ bun run cli run abc123de uname -a --json
{"stdout":"Linux desktop-machine 6.1.0 #1 SMP x86_64 GNU/Linux\n","stderr":"","exitCode":0}
```

### Custom Gateway URL

```bash
# Connect to remote Gateway
$ bun run cli --gateway ws://vps.tailnet.ts.net:18789 nodes

# Or set environment variable
$ export GATEWAY_URL=ws://vps.tailnet.ts.net:18789
$ bun run cli nodes
```

### Device Pairing (Optional)

If the Gateway has the pairing module enabled, you can manage device approvals:

```bash
# List pending devices
$ bun run cli pending

Pending Devices (1)
────────────────────────────────────────────────────────────────────────────────

○ new-device-123
  Requested:       1/25/2026, 2:45:00 PM (5m ago)
  Approve:         hermes pair new-device-123

# Approve a device
$ bun run cli pair new-device-123
✓ Device new-device-123 approved

# Revoke a device
$ bun run cli unpair old-device-456
✓ Device old-device-456 revoked
```

**Note:** Pairing commands require the pairing module to be enabled in the Gateway configuration. If not available, you'll see a helpful error message.

## Development

### Install Dependencies

```bash
bun install
```

### Run Tests

```bash
# All tests
bun test

# Integration tests
bun test:integration

# Type checking
bun run typecheck
```

### Build

```bash
# Build all entry points
bun run build

# Output: dist/gateway.js, dist/node.js, dist/cli.js
```

## Requirements

- **Bun runtime** - v1.0 or later
- **Tailscale** (optional) - For HTTPS exposure within tailnet
- **Network connectivity** - Nodes must be able to reach Gateway via WebSocket

## Security

- **Ed25519 authentication** - Each device has a unique keypair
- **Challenge-response** - Prevents replay attacks
- **Device ID derivation** - Short, readable IDs derived from public keys
- **Private key protection** - Stored with 0600 permissions
- **Tailscale integration** - HTTPS within tailnet only (not public)

## Troubleshooting

### Node won't connect

1. Check Gateway is running: `curl http://localhost:18789` (should fail with WebSocket error)
2. Check `GATEWAY_URL` environment variable
3. Check network connectivity: `ping <gateway-host>`
4. Check Gateway logs for authentication errors

### Tailscale Serve not working

1. Check Tailscale is logged in: `tailscale status`
2. Enable Serve in Tailscale admin console
3. Check Gateway logs for Tailscale errors
4. Try manual serve: `tailscale serve 18789`

### Command execution fails

1. Check node is connected: `bun run cli nodes`
2. Check command syntax (use quotes for complex commands)
3. Check command timeout (increase with `--timeout`)
4. Check node logs for handler errors

### CLI shows connection errors

The CLI provides helpful hints for common errors:

- **ECONNREFUSED** - Gateway may not be running. Start it with `bun run start:gateway`
- **Connection timeout** - Gateway is not responding. Check network connectivity
- **Authentication failed** - Try removing `~/.config/hermes-cli` and reconnecting
- **NOT_FOUND** - Node ID is incorrect. Use `hermes nodes` to see available nodes
- **TIMEOUT** - Command took too long. Increase timeout with `--timeout <ms>`
