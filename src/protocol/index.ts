/**
 * Protocol module - Core message types and utilities for WebSocket communication.
 * 
 * Exports:
 * - Message envelope types (Request, Response, Event)
 * - Command parameter and result types (SystemRunParams, SystemRunResult)
 * - Node metadata types (NodeInfo)
 * - Type guards for runtime validation
 * - Helper functions for message creation
 */

export type {
  Request,
  Response,
  Event,
  ProtocolMessage,
  NodeInfo,
  SystemRunParams,
  SystemRunResult,
} from "./types.js";

export {
  isRequest,
  isResponse,
  isEvent,
  isProtocolMessage,
  isSystemRunParams,
  isSystemRunResult,
  isNodeInfo,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  createEvent,
} from "./types.js";
