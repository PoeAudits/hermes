# Heartbeat Implementation

## Overview

The Node daemon and Gateway now implement a robust ping/pong heartbeat mechanism to detect and recover from stale connections. This ensures the system survives network changes, sleep/wake cycles, and Gateway restarts.

## Architecture

### Node Client (src/node/client.ts)

**Heartbeat Sending:**
- Sends WebSocket ping every 30 seconds (HEARTBEAT_INTERVAL_MS)
- Starts immediately upon connection
- Continues until disconnect

**Pong Monitoring:**
- Expects pong response within 90 seconds (HEARTBEAT_TIMEOUT_MS)
- Tracks last pong timestamp
- Closes connection with code 4000 if timeout exceeded

**Reconnection:**
- Detects stale connections via heartbeat timeout
- Closes connection gracefully
- Triggers automatic reconnection with exponential backoff
- Restarts heartbeat after successful reconnection

**Backoff Reset:**
- Backoff resets after 60 seconds of stable connection (STABLE_CONNECTION_MS)
- Ensures fast reconnection after temporary issues
- Prevents excessive delays for stable connections

### Gateway Handler (src/gateway/ws-handler.ts)

**Heartbeat Receiving:**
- Listens for ping from Node clients
- Automatically responds with pong (handled by ws library)
- Tracks last ping/pong timestamps

**Ping Sending:**
- Sends WebSocket ping every 30 seconds
- Starts after successful authentication
- Continues until disconnect

**Stale Connection Detection:**
- Expects pong response within 90 seconds
- Closes connection with code 4000 if timeout exceeded
- Removes node from registry on timeout
- Logs warning with timing information

## Constants

```typescript
// Node Client & Gateway
const HEARTBEAT_INTERVAL_MS = 30000;  // Send ping every 30s
const HEARTBEAT_TIMEOUT_MS = 90000;   // Expect pong within 90s

// Node Client only
const STABLE_CONNECTION_MS = 60000;   // Reset backoff after 60s stable
```

## Message Flow

### Normal Operation

```
Node                    Gateway
 |                         |
 |--- ping -------------->|
 |<-- pong ---------------|
 |                         |
 (wait 30s)
 |                         |
 |--- ping -------------->|
 |<-- pong ---------------|
 |                         |
```

### Stale Connection Detection

```
Node                    Gateway
 |                         |
 |--- ping -------------->|
 |  (network issue)        |
 |                         |
 (wait 90s - no pong)
 |                         |
 |--- close(4000) -------->|
 |                         |
 (reconnect with backoff)
 |                         |
 |--- connect ----------->|
 |<-- handshake ----------|
 |--- ping -------------->|
 |<-- pong ---------------|
```

### Gateway Restart

```
Node                    Gateway
 |                         |
 |--- ping -------------->|
 |                         X (restart)
 |<-- close(1012) --------|
 |                         |
 (reconnect with backoff)
 |                         |
 |--- connect ----------->| (new instance)
 |<-- handshake ----------|
 |--- ping -------------->|
 |<-- pong ---------------|
```

## Close Codes

- **1000**: Normal closure (client shutdown)
- **1006**: Abnormal closure (no close frame, network issue)
- **1012**: Service restart (Gateway restart)
- **4000**: Heartbeat timeout (stale connection detected)
- **4001**: Device not paired (authentication issue)

## Logging

### Node Client

```
[NodeClient] Connection stable, backoff reset
[NodeClient] Heartbeat timeout - no pong received in 95000ms, closing connection
[NodeClient] Reconnecting in 2000ms...
```

### Gateway

```
[gateway] [INFO] Node authenticated: hostname (deviceId) from platform
[gateway] [WARN] Heartbeat timeout for deviceId - no pong received in 95000ms, closing connection
[gateway] [INFO] Node disconnected: deviceId (code=4000, reason=heartbeat timeout)
```

## Testing

### Unit Tests

**Node Client (src/node/client-heartbeat.test.ts):**
- Configuration validation
- Heartbeat constants verification
- Client lifecycle with heartbeat
- Reconnection scenarios
- Integration test scenarios

**Gateway (src/gateway/ws-handler-heartbeat.test.ts):**
- Heartbeat initialization
- Ping/pong handling
- Stale connection detection
- Connection cleanup
- Error handling

### Integration Test Scenarios

1. **Normal Operation**: Heartbeat keeps connection alive
2. **Stale Connection**: Timeout detected and connection reset
3. **Desktop Sleep/Wake**: Connection survives sleep cycle
4. **Gateway Restart**: Node reconnects after Gateway restart
5. **Network Changes**: Heartbeat detects and recovers from network changes
6. **Tailscale**: Works over Tailscale network

## Behavior

### Desktop Sleep/Wake

1. Desktop goes to sleep
2. Network connection becomes stale
3. Desktop wakes up
4. Node sends ping (no response - stale connection)
5. After 90s, heartbeat timeout fires
6. Node closes connection with code 4000
7. Node reconnects with exponential backoff
8. New heartbeat starts after authentication

### Gateway Restart

1. Gateway process restarts
2. Existing connections closed with code 1012
3. Node detects disconnect
4. Node reconnects with exponential backoff
5. Handshake completes
6. New heartbeat starts

### Network Change (Tailscale)

1. Tailscale network changes (IP change)
2. Existing TCP connection becomes stale
3. Node sends ping (no response)
4. After 90s, heartbeat timeout fires
5. Node closes connection with code 4000
6. Node reconnects with new network
7. New heartbeat starts

## Performance

### Network Overhead

- Ping message: ~10 bytes
- Pong message: ~10 bytes
- Total: ~20 bytes every 30 seconds
- Bandwidth: ~0.67 bytes/second per connection

### Latency Tolerance

- Normal latency: < 1s (no impact)
- High latency: 1-10s (no impact)
- Very high latency: 10-60s (no impact)
- Timeout: > 90s (connection reset)

### Reconnection Timing

- Initial backoff: 1 second
- Max backoff: 60 seconds
- Backoff multiplier: 2x
- Stable connection: 60 seconds (backoff reset)

## Configuration

### Node Client Options

```typescript
const client = new NodeClient({
  gatewayUrl: "ws://vps:18789",
  reconnect: true,              // Enable auto-reconnect
  backoffMs: 1000,              // Initial backoff: 1s
  backoffMax: 60000,            // Max backoff: 60s
  backoffMultiplier: 2,         // Exponential: 2x
  stableConnectionMs: 60000,    // Stable after: 60s
});
```

### Gateway Options

No configuration needed - heartbeat is automatic after authentication.

## Troubleshooting

### Connection keeps disconnecting

**Symptoms:**
- Frequent disconnects with code 4000
- "Heartbeat timeout" in logs

**Causes:**
- Network latency > 90s
- Firewall blocking WebSocket traffic
- Gateway overloaded

**Solutions:**
- Check network latency
- Verify firewall rules
- Check Gateway resource usage

### Reconnection too slow

**Symptoms:**
- Long delays between reconnection attempts
- Backoff at maximum (60s)

**Causes:**
- Connection not stable for 60s
- Frequent disconnects preventing backoff reset

**Solutions:**
- Fix underlying connection issues
- Check network stability
- Verify Gateway is running

### Heartbeat not working

**Symptoms:**
- No ping/pong in logs
- Connection stays open despite network issues

**Causes:**
- Heartbeat not started (authentication failed)
- WebSocket library issue

**Solutions:**
- Verify authentication succeeds
- Check WebSocket library version
- Review logs for errors

## Future Enhancements

1. **Configurable Timeouts**: Allow customizing heartbeat intervals
2. **Adaptive Timing**: Adjust intervals based on network conditions
3. **Metrics**: Track heartbeat latency and timeout frequency
4. **Health Checks**: Expose heartbeat status via API
5. **Graceful Degradation**: Handle partial network failures
