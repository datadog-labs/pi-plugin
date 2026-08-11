/**
 * Minimal JSON-RPC 2.0 wire types and a structural message classifier.
 *
 * JSON-RPC has no single tag field, so the three message shapes are
 * discriminated structurally, per the spec:
 *
 *   request       has `id` + `method`
 *   notification  has `method`, no `id`
 *   response      has `id` + (`result` | `error`), no `method`
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Any JSON-RPC message. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Tagged classification of a parsed message, for exhaustive dispatch. */
export type ClassifiedMessage =
  | { kind: 'request'; request: JsonRpcRequest }
  | { kind: 'notification'; notification: JsonRpcNotification }
  | { kind: 'response'; response: JsonRpcResponse }
  | { kind: 'invalid'; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isJsonRpcId = (value: unknown): value is JsonRpcId => typeof value === 'string' || typeof value === 'number';

/**
 * Classify an already-parsed JSON value into one of the JSON-RPC message kinds.
 * Discrimination follows the JSON-RPC 2.0 structure since no single field tags
 * the message type.
 */
export const classifyMessage = (value: unknown): ClassifiedMessage => {
  if (!isRecord(value)) return { kind: 'invalid', reason: 'not an object' };
  if (value['jsonrpc'] !== '2.0') return { kind: 'invalid', reason: 'missing "jsonrpc": "2.0"' };

  const hasMethod = typeof value['method'] === 'string';
  const hasId = isJsonRpcId(value['id']);

  if (hasMethod) {
    return hasId
      ? { kind: 'request', request: value as unknown as JsonRpcRequest }
      : { kind: 'notification', notification: value as unknown as JsonRpcNotification };
  }
  if (!hasId) return { kind: 'invalid', reason: 'response without id' };
  if (isRecord(value['error'])) return { kind: 'response', response: value as unknown as JsonRpcErrorResponse };
  if ('result' in value) return { kind: 'response', response: value as unknown as JsonRpcSuccessResponse };
  return { kind: 'invalid', reason: 'response missing result and error' };
};
