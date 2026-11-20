import type { EditorAction, EditorRequest, ServerMessage } from '../shared/protocol.js';

export const MAX_BODY_BYTES = 128 * 1024;
export const ID = /^[A-Za-z0-9_-]{1,80}$/;
export const CHANNEL_ID = /^[A-Za-z0-9_-]{32}$/;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const actions: Record<EditorAction, true> = { 'config.get': true, 'config.save': true, 'config.reload': true, 'command.execute': true, 'qr.start': true, 'qr.cancel': true, 'update.check': true };
const forbidden: Record<string, true> = { ['__proto__']: true, prototype: true, constructor: true } as const;

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function invalid(message = 'Invalid request'): never { throw new HttpError(400, message); }

export function safeJson(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large');
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid('Invalid JSON'); }
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 12000 || depth > 16) invalid('JSON is too complex');
    if (typeof item === 'number' && !Number.isFinite(item)) invalid();
    if (item && typeof item === 'object') {
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) invalid();
      for (const [key, child] of Object.entries(item)) {
        if (Object.hasOwn(forbidden, key)) invalid('Unsafe JSON key');
        visit(child, depth + 1);
      }
    }
  }
  visit(value, 0);
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
export function text(value: unknown, max = 256, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid();
  return value;
}
export function encryptedPayload(value: unknown): void {
  const item = object(value); keys(item, ['iv', 'ciphertext']);
  if (typeof item.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(item.iv)) invalid('Invalid encryption IV');
  if (typeof item.ciphertext !== 'string' || item.ciphertext.length < 22 || item.ciphertext.length > 125000 || !/^[A-Za-z0-9_-]+$/.test(item.ciphertext) || item.ciphertext.length % 4 === 1) invalid('Invalid encrypted payload');
  try {
    const decoded = atob(item.ciphertext.replace(/-/g, '+').replace(/_/g, '/'));
    if (btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== item.ciphertext) invalid('Invalid ciphertext encoding');
  } catch { invalid('Invalid ciphertext encoding'); }
}
export function editorMessage(value: unknown): EditorRequest {
  const item = object(value);
  keys(item, ['type', 'requestId', 'action', 'encrypted']);
  if (item.type !== 'request' || !ID.test(text(item.requestId, 80)) || typeof item.action !== 'string' || !Object.hasOwn(actions, item.action)) invalid('Invalid editor message');
  encryptedPayload(item.encrypted);
  return item as unknown as EditorRequest;
}
export function serverMessage(value: unknown): ServerMessage {
  const item = object(value);
  switch (item.type) {
    case 'server.data':
      keys(item, ['type', 'topic', 'encrypted']);
      if (!['status', 'configuration', 'qr', 'update'].includes(item.topic as string)) invalid('Invalid data topic');
      encryptedPayload(item.encrypted); break;
    case 'server.response':
      // Plugin errors, like results, must be end-to-end encrypted. Only the relay
      // generates clear, fixed error strings; server-supplied plaintext is rejected.
      keys(item, ['type', 'requestId', 'ok', 'encrypted']);
      if (!ID.test(text(item.requestId, 80)) || typeof item.ok !== 'boolean') invalid();
      encryptedPayload(item.encrypted); break;
    case 'server.authorize': keys(item, ['type', 'requestId', 'code']); if (!ID.test(text(item.requestId, 80)) || !/^[A-Z2-7]{8}$/.test(text(item.code, 8))) invalid(); break;
    case 'server.heartbeat': case 'server.disconnect': keys(item, ['type']); break;
    case 'server.close': keys(item, ['type', 'reason']); text(item.reason, 512, 0); break;
    default: invalid('Invalid server message');
  }
  return item as unknown as ServerMessage;
}
