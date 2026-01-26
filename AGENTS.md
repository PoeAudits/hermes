# Hermes - Cross-Machine Command Execution System

A TypeScript/Bun-based WebSocket system for secure command execution across machines with Ed25519 authentication and Tailscale integration.

## Architecture Overview

Hermes is a layered system built around a Gateway + Node pattern with challenge-response authentication:

```
┌─────────────────────────────────────────────────────────────┐
│                    Gateway Layer                            │
│  - WebSocket Server (ws package)                            │
│  - Connection Registry (NodeRegistry)                       │
│  - Invoke Routing (RPC with timeout/idempotency)            │
│  - Tailscale Serve Automation                               │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │ WebSocket Protocol
                           │ (Request/Response/Event)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Node Layer                              │
│  - WebSocket Client (with reconnection)                     │
│  - Authentication Handshake                                 │
│  - Handler Registry (method → function)                     │
│  - Command Execution (system.run)                           │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │
┌─────────────────────────────────────────────────────────────┐
│                  Shared Layers                              │
│  - Protocol Types (Request/Response/Event)                  │
│  - Identity Management (Ed25519 keypairs)                   │
└─────────────────────────────────────────────────────────────┘
```

**Core Principles:**
- Gateway is the single source of truth for node registry
- All communication uses typed protocol messages
- Authentication is mandatory before any operations
- Nodes automatically reconnect with exponential backoff
- Invoke pattern provides request/response RPC over events
- Tailscale integration is optional and fails gracefully

## Directory Structure

```
hermes/
├── src/
│   ├── gateway/                    # Gateway server implementation
│   │   ├── server.ts               # Main Gateway class
│   │   ├── node-registry.ts        # Node tracking and invoke routing
│   │   ├── ws-handler.ts           # Per-connection WebSocket handler
│   │   ├── types.ts                # Gateway-specific types
│   │   ├── tailscale.ts            # Tailscale Serve automation
│   │   ├── tailscale-auth.ts       # Tailscale identity extraction
│   │   ├── *.test.ts               # Unit tests
│   │   └── index.ts                # Gateway exports
│   ├── node/                       # Node daemon implementation
│   │   ├── daemon.ts               # Main NodeDaemon class
│   │   ├── client.ts               # WebSocket client with reconnection
│   │   ├── system-run.ts           # Command execution handler
│   │   ├── *.test.ts               # Unit tests
│   │   └── index.ts                # Node exports
│   ├── protocol/                   # Shared protocol types
│   │   ├── types.ts                # Request/Response/Event types
│   │   └── index.ts                # Protocol exports
│   ├── identity/                   # Device identity management
│   │   ├── device.ts               # Ed25519 keypair generation
│   │   ├── device.test.ts          # Identity tests
│   │   └── index.ts                # Identity exports
│   └── cli/                        # CLI commands
│       ├── index.ts                # CLI implementation
│       └── integration.test.ts     # Integration tests
├── bin/                            # Entry point scripts
│   ├── gateway.ts                  # Gateway entry point
│   ├── node.ts                     # Node daemon entry point
│   └── cli.ts                      # CLI entry point
├── state/                          # Runtime state (gitignored)
│   └── identity/                   # Device keypairs
├── package.json                    # Dependencies and scripts
└── tsconfig.json                   # TypeScript configuration
```

### Key Conventions
- `src/` contains all source code organized by layer
- `bin/` contains only entry point scripts (minimal logic)
- Tests are co-located with source files (`*.test.ts`)
- Each layer has an `index.ts` for clean exports
- State is stored in `state/` (gitignored)

## Key Patterns

### Protocol Message Pattern

All WebSocket communication uses typed protocol messages with discriminated unions.

**Structure:**
```typescript
type ProtocolMessage = Request | Response | Event;

interface Request {
  type: "req";
  id: string;        // UUID for matching responses
  method: string;    // RPC method name
  params: unknown;   // Method parameters
}

interface Response {
  type: "res";
  id: string;        // Matches request ID
  ok: boolean;       // Success/failure
  payload?: unknown; // Result data
  error?: string;    // Error message
}

interface Event {
  type: "event";
  event: string;     // Event name
  seq: number;       // Sequence number
  payload: unknown;  // Event data
}
```

**Location:** `src/protocol/types.ts`

**Rules:**
- All messages must have a `type` field for discrimination
- Request IDs are UUIDs generated by the sender
- Responses must match request IDs exactly
- Events are fire-and-forget (no response expected)
- Use type guards (`isRequest`, `isResponse`, `isEvent`) for runtime validation

### Challenge-Response Authentication Pattern

Authentication uses Ed25519 signatures to prove device identity.

**Flow:**
1. Node connects and sends `node.hello` with public key
2. Gateway generates random challenge (UUID)
3. Node signs challenge with private key
4. Node sends `node.auth` with signature
5. Gateway verifies signature against public key
6. Gateway registers node in registry

**Location:** `src/gateway/ws-handler.ts`, `src/node/daemon.ts`

**Rules:**
- Challenge is a random UUID (prevents replay attacks)
- Signature is Ed25519 (fast, secure, small keys)
- Device ID is derived from public key hash (8 chars, URL-safe base64)
- Authentication must complete before any other operations
- Failed authentication closes the connection

### Invoke Pattern (RPC over Events)

The invoke pattern provides request/response RPC on top of the event system.

**Flow:**
1. Caller sends `node.invoke` request to Gateway
2. Gateway sends `node.invoke.request` event to target node
3. Target node executes handler and sends `node.invoke.response` request
4. Gateway matches response to pending invoke and resolves promise

**Structure:**
```typescript
// Gateway API
async invoke(
  targetNodeId: string,
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; idempotencyKey?: string }
): Promise<NodeInvokeResult>

// Node handler registration
daemon.registerHandler("system.run", async (params) => {
  // Execute command
  return { stdout, stderr, exitCode };
});
```

**Location:** `src/gateway/node-registry.ts`, `src/node/daemon.ts`

**Rules:**
- Each invoke has a unique request ID (UUID)
- Timeout defaults to 60 seconds (configurable)
- Idempotency keys cache successful results for 5 minutes
- Late responses (after timeout) are ignored
- Node disconnection rejects all pending invokes
- Handlers can be sync or async functions

### Exponential Backoff Reconnection Pattern

Nodes automatically reconnect to Gateway with exponential backoff.

**Flow:**
1. Connection lost (close, error, or timeout)
2. Wait for backoff delay
3. Attempt reconnection
4. On failure, double the delay (up to max)
5. On success, reset delay to initial value

**Configuration:**
```typescript
{
  initialDelayMs: 1000,    // Start with 1 second
  maxDelayMs: 30000,       // Cap at 30 seconds
  backoffMultiplier: 2,    // Double each time
  maxRetries: Infinity     // Never give up
}
```

**Location:** `src/node/client.ts`

**Rules:**
- Reconnection is automatic (no manual intervention)
- Backoff prevents thundering herd
- Max delay prevents indefinite waiting
- Connection state is tracked (disconnected, connecting, connected, authenticated)
- Pending requests are rejected on disconnect

### Tailscale Serve Automation Pattern

Gateway automatically enables Tailscale Serve for HTTPS exposure within tailnet.

**Flow:**
1. Gateway starts
2. Check if Tailscale is available (`tailscale status`)
3. Check if Serve is enabled on tailnet
4. Enable Serve for Gateway port (`tailscale serve --bg --yes <port>`)
5. Log HTTPS URL (`https://<hostname>.tailnet.ts.net`)
6. On shutdown, reset Serve config (`tailscale serve reset`)

**Location:** `src/gateway/tailscale.ts`, `src/gateway/server.ts`

**Rules:**
- Tailscale integration is optional (fails gracefully)
- Serve is only enabled if Tailscale is logged in
- Serve requires feature enabled in Tailscale admin console
- Uses `--bg` flag to run in background
- Uses `--yes` flag to skip confirmation
- Automatically tries sudo if permission denied
- Cleanup is best-effort (logs warning on failure)

### Command Execution Pattern

The `system.run` handler executes shell commands using `spawn` (not `exec`).

**Structure:**
```typescript
interface SystemRunParams {
  command: string[];           // Command and args
  cwd?: string;                // Working directory
  env?: Record<string, string>; // Environment variables
}

interface SystemRunResult {
  stdout: string;   // Standard output
  stderr: string;   // Standard error
  exitCode: number; // Exit code
}
```

**Location:** `src/node/system-run.ts`

**Rules:**
- Use `spawn` not `exec` (handles large output, streaming)
- Timeout defaults to 120 seconds
- Output is truncated at 1MB per stream (prevents memory exhaustion)
- SIGTERM sent on timeout, SIGKILL after 5 seconds
- Exit codes: 0 = success, 127 = command not found, 128+N = killed by signal N
- Environment variables are merged with `process.env`
- Working directory defaults to `process.cwd()`

## Coding Conventions

### Naming Conventions

| Thing | Convention | Example |
|-------|------------|---------|
| Files | kebab-case | `node-registry.ts`, `system-run.ts` |
| Test files | `*.test.ts` | `server.test.ts` |
| Classes | PascalCase | `Gateway`, `NodeDaemon`, `NodeRegistry` |
| Interfaces | PascalCase | `NodeInfo`, `SystemRunParams` |
| Functions | camelCase | `getOrCreateIdentity`, `signMessage` |
| Constants | SCREAMING_SNAKE | `DEFAULT_TIMEOUT_MS`, `MAX_RETRIES` |
| Type guards | `is*` prefix | `isRequest`, `isSystemRunParams` |

### File Organization

- One primary class per file (e.g., `server.ts` has `Gateway` class)
- Related types in same file or separate `types.ts`
- Tests co-located: `server.ts` → `server.test.ts`
- Each directory has `index.ts` for exports

### Error Handling

- Return errors in result objects (don't throw for expected failures)
- Use `try/catch` for unexpected errors (network, filesystem)
- Log errors with context (include device ID, method name)
- Graceful degradation (Tailscale failure doesn't stop Gateway)

### Async Patterns

- Use `async/await` for all async operations
- Use `Promise.race` for timeouts
- Use `EventEmitter` for event-driven patterns
- Clean up timers and listeners on shutdown

## Key Abstractions

### Gateway

**Purpose:** Central WebSocket server that routes commands between nodes  
**Location:** `src/gateway/server.ts`  
**Key Methods:**
- `start()` - Start WebSocket server and Tailscale Serve
- `stop()` - Shutdown server and cleanup
- `invoke(nodeId, method, params, options)` - Invoke command on node
- `getConnectedNodes()` - List all connected nodes
- `broadcast(event, payload)` - Send event to all nodes

**Dependencies:**
- `NodeRegistry` - Tracks nodes and routes invokes
- `WsHandler` - Handles individual connections
- `Tailscale` - Optional HTTPS exposure

### NodeRegistry

**Purpose:** Tracks connected nodes and orchestrates invoke RPC pattern  
**Location:** `src/gateway/node-registry.ts`  
**Key Methods:**
- `registerNode(node)` - Add node to registry
- `unregisterNode(deviceId)` - Remove node from registry
- `invoke(nodeId, method, params, options)` - Send invoke request
- `handleInvokeResponse(deviceId, payload)` - Match response to pending invoke
- `listNodes()` - Get all connected nodes with status

**Features:**
- Pending invoke tracking with timeout
- Idempotency cache (5 minute TTL, 10k max entries)
- Automatic cleanup on node disconnect
- Sequence numbers for events

### NodeDaemon

**Purpose:** Client daemon that connects to Gateway and executes commands  
**Location:** `src/node/daemon.ts`  
**Key Methods:**
- `start()` - Connect to Gateway and authenticate
- `stop()` - Disconnect and cleanup
- `registerHandler(method, handler)` - Register command handler
- `unregisterHandler(method)` - Remove handler

**Features:**
- Automatic reconnection with exponential backoff
- Challenge-response authentication
- Handler registry (method → function)
- Auto-registers `system.run` handler by default

### NodeClient

**Purpose:** WebSocket client with reconnection and request/response handling  
**Location:** `src/node/client.ts`  
**Key Methods:**
- `connect()` - Establish WebSocket connection
- `disconnect()` - Close connection
- `request(method, params, timeout)` - Send request and wait for response
- `send(message)` - Send raw protocol message

**Features:**
- Exponential backoff reconnection
- Request/response matching (UUID-based)
- Connection state tracking
- Event emission for state changes

### DeviceIdentity

**Purpose:** Ed25519 keypair generation and persistence  
**Location:** `src/identity/device.ts`  
**Key Functions:**
- `getOrCreateIdentity(statePath)` - Load or generate identity
- `generateKeyPair()` - Generate Ed25519 keypair
- `deriveDeviceId(publicKey)` - Derive 8-char device ID
- `signMessage(message, privateKey)` - Sign with Ed25519
- `verifySignature(message, signature, publicKey)` - Verify signature

**Storage:**
- Location: `{statePath}/identity/device.json`
- Format: JSON with version, keys (base64), device ID, timestamp
- Permissions: 0600 (owner read/write only)

### SystemRunHandler

**Purpose:** Execute shell commands on nodes  
**Location:** `src/node/system-run.ts`  
**Key Functions:**
- `executeCommand(params)` - Execute command with spawn
- `createSystemRunHandler()` - Factory for handler function

**Features:**
- Streaming output (handles large output)
- Timeout with SIGTERM/SIGKILL escalation
- Output truncation (1MB per stream)
- Environment variable merging
- Working directory support

## Dependencies

### External Dependencies

| Package | Purpose | Usage |
|---------|---------|-------|
| `ws` | WebSocket server/client | Gateway and Node communication |
| `@types/ws` | TypeScript types for ws | Type safety |
| `@types/node` | Node.js types | Built-in module types |

### Internal Dependencies

```
Gateway
  └── NodeRegistry
        └── WebSocket (ws)
  └── WsHandler
        └── WebSocket (ws)
  └── Tailscale
        └── child_process (spawn)

NodeDaemon
  └── NodeClient
        └── WebSocket (ws)
  └── SystemRunHandler
        └── child_process (spawn)
  └── DeviceIdentity
        └── crypto (Ed25519)

CLI
  └── NodeClient
        └── WebSocket (ws)
  └── DeviceIdentity
        └── crypto (Ed25519)

Protocol (shared by all)
  └── Type guards and helpers
```

## Common Tasks

### Adding a New Command Handler

1. Define params and result types in `src/protocol/types.ts`:
   ```typescript
   export interface MyCommandParams {
     arg1: string;
     arg2: number;
   }
   
   export interface MyCommandResult {
     output: string;
   }
   ```

2. Add type guard in `src/protocol/types.ts`:
   ```typescript
   export function isMyCommandParams(params: unknown): params is MyCommandParams {
     // Validate structure
   }
   ```

3. Create handler in `src/node/` (e.g., `my-command.ts`):
   ```typescript
   export function createMyCommandHandler(): (params: unknown) => Promise<MyCommandResult> {
     return async (params: unknown): Promise<MyCommandResult> => {
       if (!isMyCommandParams(params)) {
         throw new Error("Invalid params");
       }
       // Execute command
       return { output: "..." };
     };
   }
   ```

4. Register handler in `src/node/daemon.ts` or user code:
   ```typescript
   daemon.registerHandler("my.command", createMyCommandHandler());
   ```

5. Invoke from CLI or Gateway:
   ```typescript
   const result = await gateway.invoke(nodeId, "my.command", { arg1: "...", arg2: 42 });
   ```

### Adding a New CLI Command

1. Add command handler in `src/cli/index.ts`:
   ```typescript
   async function handleMyCommand(options: Partial<CliOptions>): Promise<void> {
     const client = new CliClient(options);
     try {
       await client.connect();
       // Execute command
     } finally {
       client.disconnect();
     }
   }
   ```

2. Add command to switch statement in `main()`:
   ```typescript
   switch (command) {
     case "my-command":
       await handleMyCommand(options);
       break;
   }
   ```

3. Update usage in `printUsage()`:
   ```typescript
   console.log(`
     hermes my-command <args>    Description
   `);
   ```

4. Add script to `package.json`:
   ```json
   "scripts": {
     "cli:my-command": "bun run bin/cli.ts my-command"
   }
   ```

### Adding Tailscale Identity to Authentication

The Tailscale identity headers are already extracted but not used for authentication. To use them:

1. Update `WsHandler` to pass Tailscale identity to registry:
   ```typescript
   const tailscaleIdentity = extractTailscaleIdentity(request.headers);
   // Store in node session
   ```

2. Update `NodeSession` type to include Tailscale identity:
   ```typescript
   export interface NodeSession {
     // ... existing fields
     tailscaleIdentity?: TailscaleIdentity;
   }
   ```

3. Use Tailscale identity for authorization checks:
   ```typescript
   if (session.tailscaleIdentity?.login !== expectedLogin) {
     throw new Error("Unauthorized");
   }
   ```

## Do NOT

### Architecture
- Do NOT skip authentication (all operations require auth)
- Do NOT use `exec` for command execution (use `spawn` for streaming)
- Do NOT store sensitive data in protocol messages (use encryption if needed)
- Do NOT assume Tailscale is available (fail gracefully)

### Code Style
- Do NOT use `any` type (use `unknown` and type guards)
- Do NOT throw errors for expected failures (return error objects)
- Do NOT forget to clean up timers and listeners
- Do NOT mutate function parameters (return new objects)

### Protocol
- Do NOT reuse request IDs (always generate new UUIDs)
- Do NOT send responses without matching request
- Do NOT forget to validate message types with type guards
- Do NOT assume message order (use sequence numbers for events)

### Security
- Do NOT skip signature verification
- Do NOT log private keys or signatures
- Do NOT expose Gateway to public internet (use Tailscale)
- Do NOT trust client-provided device IDs (derive from public key)

### Testing
- Do NOT skip type guards in tests
- Do NOT use real WebSocket connections in unit tests (mock)
- Do NOT forget to clean up test resources (close connections)
- Do NOT test implementation details (test public API)

## Testing Patterns

### Unit Tests

- Co-located with source files (`*.test.ts`)
- Use Bun's built-in test runner
- Mock external dependencies (WebSocket, child_process)
- Test both success and error cases

### Integration Tests

- Located in `src/cli/integration.test.ts`
- Start real Gateway and Node instances
- Test full authentication and invoke flow
- Clean up resources in `afterEach`

### Type Guard Tests

- Test valid and invalid inputs
- Test edge cases (null, undefined, wrong types)
- Test nested object validation

## Performance Considerations

### Idempotency Cache

- Max size: 10,000 entries
- TTL: 5 minutes
- Eviction: Remove oldest 10% when full
- Cleanup: Every 60 seconds

### Output Truncation

- Max per stream: 1MB
- Prevents memory exhaustion
- Appends truncation message

### Connection Limits

- No hard limit on connections
- Each connection uses ~1MB memory
- Consider load balancing for >1000 nodes

### Timeout Tuning

- Default invoke timeout: 60 seconds
- Default command timeout: 120 seconds
- Adjust based on expected command duration
