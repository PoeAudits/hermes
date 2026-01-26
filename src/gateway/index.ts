/**
 * Gateway Module
 *
 * Exports the Gateway WebSocket server and related types.
 */

export { Gateway } from "./server.js";

export type {
  GatewayConfig,
  ConnectedNode,
  AuthState,
  NodeHelloParams,
  NodeHelloResponse,
  NodeAuthParams,
  NodeAuthResponse,
  NodeInvokeParams,
  NodeInvokeResponse,
} from "./types.js";

export {
  DEFAULT_GATEWAY_CONFIG,
  isNodeHelloParams,
  isNodeAuthParams,
  isNodeInvokeParams,
} from "./types.js";

export type {
  Logger,
  ConnectionRegistry,
  InvokeHandler,
  InvokeResponseHandler,
  WsHandlerOptions,
  PairingChecker,
  PairingCheckResult,
} from "./ws-handler.js";
export { WsHandler } from "./ws-handler.js";

export {
  NodeRegistry,
  isNodeInvokeResponsePayload,
} from "./node-registry.js";

export type {
  NodeSession,
  NodeInvokeResult,
  NodeInvokeError,
  InvokeOptions,
  NodeInvokeRequestPayload,
  NodeInvokeResponsePayload,
  RegistryLogger,
  NodeStatus,
} from "./node-registry.js";

export type { TailscaleIdentity } from "./tailscale-auth.js";
export {
  extractTailscaleIdentity,
  isTailscaleRequest,
} from "./tailscale-auth.js";

// Tailscale Serve integration
export type {
  CommandExecutor,
  TailscaleLogger,
  TailscaleServeOptions,
  TailscaleCleanup,
  EnableServeResult,
} from "./tailscale.js";
export {
  isTailscaleAvailable,
  getTailnetHostname,
  enableTailscaleServe,
  disableTailscaleServe,
  startTailscaleServe,
  isServeEnabled,
  findTailscaleBinary,
  clearBinaryCache,
} from "./tailscale.js";
