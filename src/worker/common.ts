import { HttpError, MAX_BODY_BYTES, TOKEN, safeJson } from '../server/validation.js';

export const SESSION_MS = 45 * 60_000;
export const CHANNEL_MS = SESSION_MS;
export const CODE_MS = 5 * 60_000;
export const LEASE_MS = 6_000;
export const REQUEST_MS = 20_000;
export const SESSION_COOKIE = 'penguin_editor_session';
export interface Env {
  CHANNELS: DurableObjectNamespace;
  SESSIONS: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
  ASSETS: Fetcher;
}
export function response(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
}
export function errorResponse(error: unknown): Response {
  return error instanceof HttpError ? response({ error: error.message }, error.status) : response({ error: 'Service unavailable; no request has been automatically retried' }, 503);
}
export function publicOrigin(env: Env): string {
  let url: URL;
  try { url = new URL(env.PUBLIC_ORIGIN); } catch { throw new HttpError(503, 'PUBLIC_ORIGIN is required'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== env.PUBLIC_ORIGIN || url.username || url.password || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) throw new HttpError(503, 'PUBLIC_ORIGIN must be the HTTPS site origin');
  return url.origin;
}
export function checkOrigin(request: Request, origin: string, allowAbsent = false): void {
  const supplied = request.headers.get('origin');
  if ((!supplied && !allowAbsent) || (supplied && supplied !== origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Same-origin request required');
}
export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function confirmation(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => alphabet[byte & 31]).join('');
}
export async function digest(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function cookieToken(request: Request): string | undefined {
  const parts = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (parts.length !== 1) return;
  const token = parts[0]!.slice(SESSION_COOKIE.length + 1);
  return TOKEN.test(token) ? token : undefined;
}
export function cookie(token: string, origin: string, clear = false): string {
  return `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
export async function body(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'Content-Type must be application/json');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new HttpError(413, 'Request is too large');
  if (!request.body) throw new HttpError(400, 'JSON body required');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0, result = '';
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new HttpError(413, 'Request is too large'); }
      result += decoder.decode(part.value, { stream: true });
    }
    result += decoder.decode();
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid UTF-8 JSON'); }
  finally { reader.releaseLock(); }
  return safeJson(result);
}
// These Requests are constructed from verified values, never cloned from a public
// request. Neither actor has an externally addressable route or trusts X-Session.
export function internal(path: string, value: unknown): Request {
  return new Request(`https://actor.internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}
export function sessionStub(env: Env, hash: string): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName(`session:${hash}`));
}
export function channelStub(env: Env, id: string): DurableObjectStub {
  return env.CHANNELS.get(env.CHANNELS.idFromName(id));
}
export async function sessionActive(env: Env, hash: string): Promise<boolean> {
  const result = await sessionStub(env, hash).fetch(internal('/active', {}));
  if (!result.ok) throw new HttpError(503, 'Browser session verification unavailable');
  return (await result.json() as { active: boolean }).active;
}
export async function requireSession(env: Env, request: Request): Promise<string> {
  const token = cookieToken(request);
  if (!token) throw new HttpError(401, 'Browser pairing session required');
  const hash = await digest(token);
  if (!await sessionActive(env, hash)) throw new HttpError(401, 'Browser pairing session expired; open a new editor link');
  return hash;
}
export async function rate(env: Env, kind: string, identity: string, limit: number): Promise<void> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(`rate:${kind}:${await digest(identity)}`));
  const result = await stub.fetch(internal('/rate', { limit }));
  if (result.status === 429) throw new HttpError(429, 'Too many attempts; try again later');
  if (!result.ok) throw new HttpError(503, 'Rate limiter unavailable');
}
export class SerialActor {
  private chain: Promise<unknown> = Promise.resolve();
  protected serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => {});
    return next;
  }
}
