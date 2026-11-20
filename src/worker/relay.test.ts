import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare, WebSocket, type V4MiniflareOptions } from 'miniflare';
import type { CreateChannelResponse, EditorRequest, EncryptedPayload, RelayToEditor, RelayToServer } from '../shared/protocol.js';
import { SESSION_COOKIE, SESSION_MS, LEASE_MS } from './common.js';

type WireMessage = RelayToEditor | RelayToServer;
const ORIGIN = 'https://editor.example.test';
const metadata = { name: 'Workerd test server', platform: 'Paper', version: '1' };
const key = randomBytes(32);
const sourceRoot = fileURLToPath(new URL('.', import.meta.url));

// Only storage/clock inspection is added in this test bundle. All public HTTP,
// pairing, WebSocket, alarm, transaction, and hibernation handlers are the real
// production classes in workerd; neither Durable Objects nor sockets are mocked.
const fixtureSource = `
import worker, { EditorChannel as Channel, BrowserSession as Session } from './index.ts';
export default worker;
function controls(Base) {
  return class extends Base {
    constructor(ctx, env) { super(ctx, env); this.testStorage = ctx.storage; this.testCtx = ctx; }
    async fetch(request) {
      if (new URL(request.url).pathname !== '/__test') return super.fetch(request);
      const { operation, key, patch, alarm } = await request.json();
      if (operation === 'read') return Response.json(await this.testStorage.get(key) ?? null);
      if (operation === 'list') return Response.json(Object.fromEntries(await this.testStorage.list()));
      if (operation === 'patch') {
        const record = await this.testStorage.get(key);
        await this.testStorage.put(key, { ...record, ...patch });
        if (alarm !== undefined) await this.testStorage.setAlarm(alarm);
        return Response.json({ patched: true });
      }
      if (operation === 'alarm') { await super.alarm(); return Response.json({ alarm: true }); }
      return new Response(null, { status: 400 });
    }
  };
}
export class EditorChannel extends controls(Channel) {}
export class BrowserSession extends controls(Session) {}
`;

interface Inbox {
  socket: WebSocket; all: WireMessage[]; closed: Promise<void>;
  next(predicate: (message: WireMessage) => boolean, after?: number): Promise<WireMessage>;
  send(message: unknown): void;
}
function inbox(socket: WebSocket): Inbox {
  const all: WireMessage[] = [];
  const waiters: { predicate: (message: WireMessage) => boolean; resolve: (message: WireMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  const closeGate = Promise.withResolvers<void>();
  socket.addEventListener('close', () => {
    try { socket.close(); } catch { /* Close handshake already completed. */ }
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Socket closed before expected message')); }
    waiters.length = 0; closeGate.resolve();
  });
  socket.addEventListener('message', event => {
    assert.equal(typeof event.data, 'string');
    const message = JSON.parse(event.data as string) as WireMessage; all.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]!;
      if (waiter.predicate(message)) { clearTimeout(waiter.timer); waiters.splice(index, 1); waiter.resolve(message); }
    }
  });
  socket.addEventListener('error', () => {
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('WebSocket transport failed')); }
    waiters.length = 0;
  });
  socket.accept();
  return {
    socket, all, closed: closeGate.promise,
    send(message) { socket.send(JSON.stringify(message)); },
    next(predicate, after = 0) {
      const found = all.slice(after).find(predicate); if (found) return Promise.resolve(found);
      const { promise, resolve, reject } = Promise.withResolvers<WireMessage>();
      // This is a failure deadline for a real workerd event, not a sleep or a
      // fake Node clock: successful network completion resolves immediately.
      const timer = setTimeout(() => {
        const index = waiters.findIndex(waiter => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for workerd relay message'));
      }, 8000);
      waiters.push({ predicate, resolve, reject, timer });
      return promise;
    },
  };
}
function encrypt(value: unknown, aad: string): EncryptedPayload {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}
function decrypt(value: EncryptedPayload, aad: string): unknown {
  const data = Buffer.from(value.ciphertext, 'base64url'); const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64url'));
  cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString());
}
function command(id: string, requestId = randomUUID()): EditorRequest {
  return { type: 'request', requestId, action: 'command.execute', encrypted: encrypt({ command: 'say workerd-private-command' }, `${id}\nrequest\n${requestId}\ncommand.execute`) };
}

async function fixture(t: TestContext, origin = ORIGIN) {
  const root = await mkdtemp(join(tmpdir(), 'penguin-worker-test-'));
  const scriptPath = join(root, 'worker.mjs');
  await build({ stdin: { contents: fixtureSource, resolveDir: sourceRoot, sourcefile: 'fixture.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: scriptPath, external: ['cloudflare:workers'], logLevel: 'silent' });
  const options: V4MiniflareOptions = {
    name: 'relay-test', modules: true, scriptPath, modulesRoot: root, compatibilityDate: '2026-11-20', compatibilityFlags: ['nodejs_compat'],
    resourcePersistencePath: join(root, 'storage'),
    bindings: { PUBLIC_ORIGIN: origin },
    durableObjects: { CHANNELS: { className: 'EditorChannel', useSQLite: true }, SESSIONS: { className: 'BrowserSession', useSQLite: true } },
    serviceBindings: { ASSETS: () => new Response('<!doctype html><title>Static editor</title>', { headers: { 'Content-Type': 'text/html' } }) },
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options)); const sockets: Inbox[] = [];
  t.after(async () => { for (const socket of sockets) try { socket.socket.close(); } catch { /* Already closed. */ } await mf.dispose(); await rm(root, { recursive: true, force: true }); });
  await mf.ready;
  const ip = randomUUID();
  const setup = {
    get mf() { return mf; }, origin,
    async http(path: string, value?: unknown, cookie?: string, suppliedOrigin: string | null = origin, extra: Record<string, string> = {}) {
      const headers: Record<string, string> = { 'cf-connecting-ip': ip, ...extra };
      if (suppliedOrigin) headers.origin = suppliedOrigin;
      if (cookie) headers.cookie = cookie;
      if (value !== undefined) headers['content-type'] = 'application/json';
      return mf.dispatchFetch(origin + path, { method: value === undefined ? 'GET' : 'POST', headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    },
    async bootstrap(existing?: string): Promise<string> {
      const result = await setup.http('/api/session', {}, existing); assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { ready: true });
      return result.headers.get('set-cookie')!.split(';')[0]!;
    },
    async create(): Promise<CreateChannelResponse> {
      const result = await setup.http('/api/channels', metadata, undefined, null); assert.equal(result.status, 201);
      return await result.json() as CreateChannelResponse;
    },
    async claim(channel: CreateChannelResponse, cookie: string, withKey = true) {
      const joinKey = new URLSearchParams(new URL(channel.editorUrl).hash.slice(1)).get('key');
      return setup.http(`/api/channels/${channel.channelId}/claim`, withKey ? { joinKey } : {}, cookie);
    },
    async connect(channel: CreateChannelResponse, browserCookie?: string): Promise<Inbox> {
      const editor = browserCookie !== undefined;
      const headers: Record<string, string> = { Upgrade: 'websocket' };
      if (editor) { headers.origin = origin; headers.cookie = browserCookie; }
      else headers.authorization = `Bearer ${channel.serverToken}`;
      const result = await mf.dispatchFetch(`${origin}/ws/${editor ? 'editor' : 'server'}/${channel.channelId}`, { headers });
      if (result.status !== 101) assert.fail(`WebSocket upgrade rejected (${result.status}): ${await result.text()}`);
      assert.ok(result.webSocket);
      const socket = inbox(result.webSocket); sockets.push(socket); return socket;
    },
    async control(binding: 'CHANNELS' | 'SESSIONS', name: string, value: unknown): Promise<any> {
      const namespace = await mf.getDurableObjectNamespace(binding);
      const result = await namespace.get(namespace.idFromName(name)).fetch('https://actor.internal/__test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
      assert.equal(result.status, 200); return result.json();
    },
    async paired() {
      const cookie = await setup.bootstrap(); const channel = await setup.create();
      const claimed = await setup.claim(channel, cookie); assert.equal(claimed.status, 200);
      const state = await claimed.json() as Extract<RelayToEditor, { type: 'channel.state' }>;
      assert.match(state.code!, /^[A-Z2-7]{8}$/);
      const plugin = await setup.connect(channel); await plugin.next(message => message.type === 'channel.ready');
      const browser = await setup.connect(channel, cookie); await browser.next(message => message.type === 'channel.state');
      return { cookie, channel, code: state.code!, plugin, browser };
    },
    async authorized() {
      const item = await setup.paired(); item.plugin.send({ type: 'server.authorize', requestId: 'first-approval', code: item.code });
      await item.plugin.next(message => message.type === 'channel.authorized' && message.requestId === 'first-approval');
      await item.browser.next(message => message.type === 'channel.state' && message.state === 'authorized');
      return item;
    },
    async restart() { await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready; },
  };
  return setup;
}
function sessionName(cookie: string): string { return `session:${createHash('sha256').update(cookie.slice(SESSION_COOKIE.length + 1)).digest('hex')}`; }

// Each test uses its own SQLite-backed workerd process and persistence directory.
test('anonymous bootstrap atomically reuses cookies, validates origins/headers, and preserves fixed routes and limits', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const result = await f.http('/api/session', {}); assert.equal(result.status, 200);
  const fullCookie = result.headers.get('set-cookie')!; const cookie = fullCookie.split(';')[0]!;
  assert.match(fullCookie, /HttpOnly/); assert.match(fullCookie, /SameSite=Strict/); assert.match(fullCookie, /Secure/); assert.match(fullCookie, /Max-Age=2700/);
  const race = await Promise.all(Array.from({ length: 8 }, () => f.bootstrap(cookie)));
  assert.ok(race.every(value => value === cookie));
  const record = await f.control('SESSIONS', sessionName(cookie), { operation: 'read', key: 'session' });
  assert.equal(record.hash, sessionName(cookie).slice(8)); assert.equal(record.revoked, false);
  assert.ok(record.expiresAt <= Date.now() + SESSION_MS); assert.ok(record.expiresAt > Date.now() + SESSION_MS - 10_000);
  assert.ok(!JSON.stringify(record).includes(cookie.slice(SESSION_COOKIE.length + 1)));
  assert.equal((await f.http('/api/session', {}, undefined, 'https://evil.test')).status, 403);
  assert.equal((await f.http('/api/session', {}, undefined, null)).status, 403);
  assert.equal((await f.http('/api/session', {}, undefined, ORIGIN, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.http('/api/channels', metadata, undefined, 'https://evil.test')).status, 403);
  assert.equal((await f.http('/api/session', { username: 'alice', password: 'wrong-contract' })).status, 400);
  assert.equal((await f.http('/api/session', {}, `${cookie}; ${cookie}`)).status, 200);
  const channel = await f.create();
  const fabricated = { 'x-session': record.hash, 'x-verified-session-hash': record.hash, 'x-verified-server-hash': record.hash };
  assert.equal((await f.http(`/api/channels/${channel.channelId}/claim`, { joinKey: new URLSearchParams(new URL(channel.editorUrl).hash.slice(1)).get('key') }, undefined, ORIGIN, fabricated)).status, 401);
  const forgedServer = await f.mf.dispatchFetch(`${ORIGIN}/ws/server/${channel.channelId}`, { headers: { Upgrade: 'websocket', ...fabricated } }); assert.equal(forgedServer.status, 403);
  const forgedEditor = await f.mf.dispatchFetch(`${ORIGIN}/ws/editor/${channel.channelId}`, { headers: { Upgrade: 'websocket', origin: ORIGIN, ...fabricated } }); assert.equal(forgedEditor.status, 401);
  for (const path of ['/api/unknown', '/ws/unknown', '/internal/active', '/api/auth/login']) assert.equal((await f.http(path)).status, 404);
  assert.equal((await f.http('/editor/anything')).status, 200);
  const creates = await Promise.all(Array.from({ length: 10 }, () => f.http('/api/channels', metadata, undefined, null)));
  assert.equal(creates.filter(value => value.status === 201).length, 9); assert.equal(creates.filter(value => value.status === 429).length, 1);
  const createdChannels = await Promise.all(creates.filter(value => value.status === 201).map(async value => (await value.json() as CreateChannelResponse).channelId));
  assert.equal(new Set(createdChannels).size, createdChannels.length);
  const bootstrap = await Promise.all(Array.from({ length: 31 }, () => f.http('/api/session', {}, undefined, ORIGIN, { 'cf-connecting-ip': 'bootstrap-limit' })));
  assert.equal(bootstrap.filter(value => value.status === 200).length, 30); assert.equal(bootstrap.filter(value => value.status === 429).length, 1);
  const local = await fixture(t, 'http://127.0.0.1:8088');
  assert.doesNotMatch((await local.http('/api/session', {})).headers.get('set-cookie')!, /Secure/);
  const bad = await fixture(t, 'http://not-loopback.test'); assert.equal((await bad.http('/api/session', {})).status, 503);
});

test('concurrent claims consume one join key; code rotation, successful ACK duplicates and changed request IDs remain atomic', { timeout: 60_000 }, async t => {
  const f = await fixture(t); const channel = await f.create(); const left = await f.bootstrap(), right = await f.bootstrap();
  const claims = await Promise.all([f.claim(channel, left), f.claim(channel, right)]); assert.deepEqual(claims.map(value => value.status).sort(), [200, 409]);
  const cookie = claims[0]!.status === 200 ? left : right; const loser = cookie === left ? right : left;
  const first = await claims.find(value => value.status === 200)!.json() as { code: string };
  const stored = await f.control('CHANNELS', channel.channelId, { operation: 'read', key: 'channel' });
  assert.equal(stored.owner, sessionName(cookie).slice(8)); assert.equal(stored.joinHash, undefined); assert.equal(stored.code, undefined);
  assert.equal(stored.codeHash, createHash('sha256').update(first.code).digest('hex'));
  assert.ok(stored.codeExpiresAt <= Date.now() + 300_000);
  const plugin = await f.connect(channel); await plugin.next(value => value.type === 'channel.ready');
  const rotated = await f.claim(channel, cookie, false); assert.equal(rotated.status, 200); const fresh = await rotated.json() as { code: string }; assert.notEqual(fresh.code, first.code);
  plugin.send({ type: 'server.authorize', requestId: 'old-code', code: first.code }); await plugin.next(value => value.type === 'channel.authorizationFailed' && value.requestId === 'old-code');
  plugin.send({ type: 'server.authorize', requestId: 'approve-a', code: fresh.code }); plugin.send({ type: 'server.authorize', requestId: 'approve-b', code: fresh.code });
  await plugin.next(value => value.type === 'channel.authorizationFailed' && value.requestId === 'approve-b');
  assert.equal(plugin.all.filter(value => value.type === 'channel.authorized').length, 1);
  const marker = plugin.all.length;
  plugin.send({ type: 'server.authorize', requestId: 'approve-a', code: 'AAAAAAAA' }); await plugin.next(value => value.type === 'channel.authorized' && value.requestId === 'approve-a', marker);
  plugin.send({ type: 'server.authorize', requestId: 'new-replay', code: fresh.code }); await plugin.next(value => value.type === 'channel.authorizationFailed' && value.requestId === 'new-replay');
  const approved = await f.control('CHANNELS', channel.channelId, { operation: 'read', key: 'channel' }); assert.equal(approved.codeHash, undefined); assert.equal(approved.codeExpiresAt, undefined);
  assert.equal((await f.http(`/api/channels/${channel.channelId}`, undefined, loser)).status, 409);
  const claimAgain = await f.claim(channel, cookie, false); assert.equal((await claimAgain.json() as { state: string }).state, 'authorized');
  const read = await f.http(`/api/channels/${channel.channelId}`, undefined, cookie, 'https://evil.test'); assert.equal(read.status, 403);
});

test('pending channels reject requests and snapshots; expired codes and plaintext plugin errors never reveal private data', { timeout: 60_000 }, async t => {
  const f = await fixture(t); const { channel, cookie, code, plugin, browser } = await f.paired(); const id = channel.channelId;
  const pending = command(id, 'preauth-command'); browser.send(pending);
  const rejected = await browser.next(value => value.type === 'server.response' && value.requestId === pending.requestId);
  assert.equal(rejected.type, 'server.response'); if (rejected.type === 'server.response') assert.equal(rejected.ok, false);
  assert.ok(!plugin.all.some(value => value.type === 'request'));
  plugin.send({ type: 'server.data', topic: 'configuration', encrypted: encrypt({ password: 'private-preauth-config' }, `${id}\nserver.data\nconfiguration`) }); await plugin.closed;
  assert.equal(await f.control('CHANNELS', id, { operation: 'read', key: 'snapshot:configuration' }), null);
  assert.ok(!browser.all.some(value => value.type === 'server.data'));
  const resumed = await f.connect(channel); await resumed.next(value => value.type === 'channel.ready');
  await f.control('CHANNELS', id, { operation: 'patch', key: 'channel', patch: { codeExpiresAt: Date.now() - 1 } });
  resumed.send({ type: 'server.authorize', requestId: 'expired-code', code }); await resumed.next(value => value.type === 'channel.authorizationFailed' && value.requestId === 'expired-code');
  const refreshed = await f.claim(channel, cookie, false); const valid = await refreshed.json() as { code: string };
  resumed.send({ type: 'server.authorize', requestId: 'fresh-code', code: valid.code }); await resumed.next(value => value.type === 'channel.authorized');
  resumed.send({ type: 'server.response', requestId: 'untrusted-error', ok: false, error: 'plaintext-plugin-password' }); await resumed.closed;
  assert.ok(!JSON.stringify(browser.all).includes('plaintext-plugin-password'));
  assert.equal(await f.control('CHANNELS', id, { operation: 'read', key: 'request:untrusted-error' }), null);
});

test('hibernation restores attachments and durable dedup; reconnect/replacement fences old requests, snapshots and late results', { timeout: 60_000 }, async t => {
  const f = await fixture(t); const { channel, cookie, plugin, browser } = await f.authorized(); const id = channel.channelId;
  const item = command(id, 'once-only'); browser.send(item); assert.deepEqual(await plugin.next(value => value.type === 'request'), item);
  const response = { type: 'server.response', requestId: item.requestId, ok: true, encrypted: encrypt({ output: 'private-result' }, `${id}\nserver.response\n${item.requestId}\ntrue`) };
  plugin.send(response); const reply = await browser.next(value => value.type === 'server.response' && value.requestId === item.requestId);
  if (reply.type !== 'server.response') assert.fail('No encrypted response'); assert.deepEqual(decrypt(reply.encrypted!, `${id}\nserver.response\n${item.requestId}\ntrue`), { output: 'private-result' });
  const twin = await f.connect(channel, cookie); await twin.next(value => value.type === 'channel.state');
  const concurrent = command(id, 'concurrent-request-id'); browser.send(concurrent); twin.send(concurrent);
  await plugin.next(value => value.type === 'request' && value.requestId === concurrent.requestId);
  const duplicateSide = await Promise.race([
    browser.next(value => value.type === 'server.response' && value.requestId === concurrent.requestId),
    twin.next(value => value.type === 'server.response' && value.requestId === concurrent.requestId),
  ]);
  if (duplicateSide.type === 'server.response') assert.match(duplicateSide.error!, /already used/);
  plugin.send({ type: 'server.response', requestId: concurrent.requestId, ok: true, encrypted: encrypt({ output: 'once' }, `${id}\nserver.response\n${concurrent.requestId}\ntrue`) });
  await browser.next(value => value.type === 'server.response' && value.requestId === concurrent.requestId && !!value.encrypted);
  assert.equal(plugin.all.filter(value => value.type === 'request' && value.requestId === concurrent.requestId).length, 1);
  const snapshot = { type: 'server.data', topic: 'configuration', encrypted: encrypt({ password: 'private-snapshot' }, `${id}\nserver.data\nconfiguration`) };
  plugin.send(snapshot); await browser.next(value => value.type === 'server.data');
  const before = await f.control('CHANNELS', id, { operation: 'read', key: 'channel' });
  await f.mf.unsafeEvictDurableObject('relay-test', 'EditorChannel', { name: id, webSockets: 'hibernate' });
  plugin.send({ type: 'server.heartbeat' });
  const after = await f.http(`/api/channels/${id}`, undefined, cookie); assert.equal((await after.json() as { serverOnline: boolean }).serverOnline, true);
  const hibernated = command(id, '__proto__'); browser.send(hibernated); await plugin.next(value => value.type === 'request' && value.requestId === '__proto__');
  const abandoned = command(id, 'abandoned'); browser.send(abandoned); await plugin.next(value => value.type === 'request' && value.requestId === 'abandoned');
  const replacement = await f.connect(channel); await replacement.next(value => value.type === 'channel.authorized' && value.requestId === 'resume'); await plugin.closed;
  const failed = await browser.next(value => value.type === 'server.response' && value.requestId === abandoned.requestId); if (failed.type === 'server.response') assert.match(failed.error!, /not retried/);
  const current = await f.control('CHANNELS', id, { operation: 'read', key: 'channel' }); assert.notEqual(current.nonce, before.nonce); assert.deepEqual(current.pending, {});
  assert.equal(await f.control('CHANNELS', id, { operation: 'read', key: 'snapshot:configuration' }), null);
  assert.ok(!replacement.all.some(value => value.type === 'request'));
  const duplicateMarker = browser.all.length; browser.send(item);
  const duplicate = await browser.next(value => value.type === 'server.response' && value.requestId === item.requestId, duplicateMarker); if (duplicate.type === 'server.response') assert.match(duplicate.error!, /already used/);
  const lostMarker = browser.all.length; browser.send(abandoned);
  await browser.next(value => value.type === 'server.response' && value.requestId === abandoned.requestId, lostMarker);
  replacement.send({ ...response, requestId: abandoned.requestId });
  const barrier = command(id, 'after-late-result'); browser.send(barrier); await replacement.next(value => value.type === 'request' && value.requestId === barrier.requestId);
  const old = await f.control('CHANNELS', id, { operation: 'read', key: `reply:${abandoned.requestId}` }); assert.match(old.error, /not retried/); assert.equal(old.encrypted, undefined);
  const reconnect = await f.connect(channel, cookie); await reconnect.next(value => value.type === 'channel.state'); assert.ok(!reconnect.all.some(value => value.type === 'server.data'));
});

test('request timeouts, six-second leases and inflight limits use alarms rather than connection lifetime timers', { timeout: 60_000 }, async t => {
  const f = await fixture(t); const { channel, cookie, plugin, browser } = await f.authorized(); const id = channel.channelId;
  const initial = await f.control('CHANNELS', id, { operation: 'read', key: 'channel' });
  assert.ok(initial.leaseUntil <= Date.now() + LEASE_MS); assert.equal(initial.connectionDeadline, undefined);
  const timed = command(id, 'timeout'); browser.send(timed); await plugin.next(value => value.type === 'request' && value.requestId === timed.requestId);
  const record = await f.control('CHANNELS', id, { operation: 'read', key: 'channel' }); record.pending['request:timeout'].deadline = Date.now() - 1;
  await f.control('CHANNELS', id, { operation: 'patch', key: 'channel', patch: { pending: record.pending } });
  await f.control('CHANNELS', id, { operation: 'alarm' });
  const timeout = await browser.next(value => value.type === 'server.response' && value.requestId === timed.requestId); if (timeout.type === 'server.response') assert.match(timeout.error!, /timed out.*not retried/);
  for (let index = 0; index < 16; index++) { const item = command(id, `inflight-${index}`); browser.send(item); await plugin.next(value => value.type === 'request' && value.requestId === item.requestId); }
  browser.send(command(id, 'overflow')); const overflow = await browser.next(value => value.type === 'server.response' && value.requestId === 'overflow'); if (overflow.type === 'server.response') assert.match(overflow.error!, /Too many requests/);
  // These two short platform-clock checks await actual alarm/close events.
  // Node fake timers cannot advance the independent workerd alarm scheduler.
  await f.control('CHANNELS', id, { operation: 'patch', key: 'channel', patch: { leaseUntil: Date.now() + 30 }, alarm: Date.now() + 35 });
  await plugin.closed; await browser.next(value => value.type === 'channel.state' && !value.serverOnline);
  const offline = await f.http(`/api/channels/${id}`, undefined, cookie); assert.equal((await offline.json() as { serverOnline: boolean }).serverOnline, false);
  const replacement = await f.connect(channel); await replacement.next(value => value.type === 'channel.authorized'); assert.ok(!replacement.all.some(value => value.type === 'request'));
  const bounded = await f.control('CHANNELS', id, { operation: 'read', key: 'channel' });
  await f.control('CHANNELS', id, { operation: 'patch', key: 'channel', patch: { requestCount: 2048 } });
  browser.send(command(id, 'used-id-cap')); const cap = await browser.next(value => value.type === 'server.response' && value.requestId === 'used-id-cap'); if (cap.type === 'server.response') assert.match(cap.error!, /Too many requests/);
  assert.equal(bounded.pending['request:timeout'], undefined);
});

test('ending and expiring one anonymous session revokes every owned channel and all concurrent privileged traffic', { timeout: 60_000 }, async t => {
  const f = await fixture(t); const first = await f.authorized(); const second = await f.create();
  const claimed = await f.claim(second, first.cookie); const code = (await claimed.json() as { code: string }).code;
  const plugin = await f.connect(second); await plugin.next(value => value.type === 'channel.ready');
  plugin.send({ type: 'server.authorize', requestId: 'second-approval', code }); await plugin.next(value => value.type === 'channel.authorized');
  const browser = await f.connect(second, first.cookie); await browser.next(value => value.type === 'channel.state');
  const result = await f.http('/api/session/end', {}, first.cookie); assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie')!, /Max-Age=0/);
  await Promise.all([first.plugin.closed, first.browser.closed, plugin.closed, browser.closed]);
  const ended = await f.control('SESSIONS', sessionName(first.cookie), { operation: 'read', key: 'session' }); assert.equal(ended.revoked, true);
  for (const channel of [first.channel, second]) {
    const stored = await f.control('CHANNELS', channel.channelId, { operation: 'list' }); assert.equal(stored.channel.state, 'closed'); assert.equal(stored.channel.serverHash, undefined); assert.equal(stored.channel.pending && Object.keys(stored.channel.pending).length, 0);
    assert.ok(!Object.keys(stored).some(key => key.startsWith('request:') || key.startsWith('snapshot:') || key.startsWith('reply:')));
    assert.equal((await f.http(`/api/channels/${channel.channelId}`, undefined, first.cookie)).status, 401);
  }
  const fresh = await f.authorized();
  await f.control('SESSIONS', sessionName(fresh.cookie), { operation: 'patch', key: 'session', patch: { expiresAt: Date.now() - 1 } });
  fresh.browser.send(command(fresh.channel.channelId, 'expired-owner-command'));
  await Promise.all([fresh.plugin.closed, fresh.browser.closed]);
  assert.ok(!fresh.plugin.all.some(value => value.type === 'request' && value.requestId === 'expired-owner-command'));
  const another = await f.authorized();
  const id = another.channel.channelId;
  const endedRace = f.http('/api/session/end', {}, another.cookie);
  for (let index = 0; index < 4; index++) another.browser.send(command(id, `end-race-${index}`));
  const finished = await endedRace; assert.equal(finished.status, 200); await Promise.all([another.plugin.closed, another.browser.closed]);
  assert.equal((await f.http(`/api/channels/${id}`, undefined, another.cookie)).status, 401);
  const closed = await f.control('CHANNELS', id, { operation: 'read', key: 'channel' }); assert.equal(closed.state, 'closed'); assert.deepEqual(closed.pending, {});
});

test('SQLite persistence survives a complete runtime restart without resurrecting authorization codes or used command IDs', { timeout: 60_000 }, async t => {
  const f = await fixture(t); const { channel, cookie, plugin, browser, code } = await f.authorized(); const id = channel.channelId;
  const request = command(id, 'persistent-used-id'); browser.send(request); await plugin.next(value => value.type === 'request' && value.requestId === request.requestId);
  const raw = await f.control('CHANNELS', id, { operation: 'list' });
  const persisted = JSON.stringify(raw);
  for (const secret of [key.toString('base64url'), channel.serverToken, new URLSearchParams(new URL(channel.editorUrl).hash.slice(1)).get('key')!, code, 'workerd-private-command']) assert.ok(!persisted.includes(secret));
  assert.equal(raw['request:persistent-used-id'].state, 'consumed');
  await f.restart(); assert.equal(await f.bootstrap(cookie), cookie);
  const resumed = await f.connect(channel); await resumed.next(value => value.type === 'channel.authorized' && value.requestId === 'resume'); assert.ok(!resumed.all.some(value => value.type === 'request'));
  const browserAgain = await f.connect(channel, cookie); await browserAgain.next(value => value.type === 'channel.state');
  const interrupted = await browserAgain.next(value => value.type === 'server.response' && value.requestId === request.requestId);
  assert.equal(interrupted.type, 'server.response'); if (interrupted.type === 'server.response') { assert.equal(interrupted.ok, false); assert.equal(interrupted.encrypted, undefined); }
  const marker = browserAgain.all.length; browserAgain.send(request);
  const duplicate = await browserAgain.next(value => value.type === 'server.response' && value.requestId === request.requestId, marker);
  assert.equal(duplicate.type, 'server.response'); if (duplicate.type === 'server.response') { assert.equal(duplicate.ok, false); assert.equal(duplicate.encrypted, undefined); }
  const barrier = command(id, 'fresh-after-restart'); browserAgain.send(barrier); await resumed.next(value => value.type === 'request' && value.requestId === barrier.requestId);
  assert.ok(!resumed.all.some(value => value.type === 'request' && value.requestId === request.requestId));
  resumed.send({ type: 'server.authorize', requestId: 'old-code-after-restart', code }); await resumed.next(value => value.type === 'channel.authorizationFailed' && value.requestId === 'old-code-after-restart');
  const restored = await f.control('CHANNELS', id, { operation: 'read', key: 'channel' }); assert.equal(restored.authorizationRequestId, 'first-approval'); assert.equal(restored.codeHash, undefined);
  // Exercise real platform alarm delivery; await closure rather than sleeping.
  await f.control('CHANNELS', id, { operation: 'patch', key: 'channel', patch: { expiresAt: Date.now() + 30 }, alarm: Date.now() + 35 });
  await Promise.all([resumed.closed, browserAgain.closed]);
  assert.equal((await f.http(`/api/channels/${id}`, undefined, cookie)).status, 404);
});

test('claim, authorization and editor rate limits remain durable without allowing preauthorization traffic', { timeout: 60_000 }, async t => {
  const f = await fixture(t); const item = await f.paired(); const id = item.channel.channelId;
  const invalidCode = (item.code[0] === 'A' ? 'B' : 'A') + item.code.slice(1);
  for (let index = 0; index < 6; index++) {
    item.plugin.send({ type: 'server.authorize', requestId: `invalid-code-${index}`, code: invalidCode });
    const failed = await item.plugin.next(value => value.type === 'channel.authorizationFailed' && value.requestId === `invalid-code-${index}`);
    if (failed.type === 'channel.authorizationFailed' && index === 5) assert.match(failed.error, /Too many code attempts/);
  }
  const claims = await Promise.all(Array.from({ length: 20 }, () => f.claim(item.channel, item.cookie, false)));
  assert.equal(claims.filter(value => value.status === 200).length, 19);
  assert.equal(claims.filter(value => value.status === 429).length, 1);
  for (let index = 0; index < 121; index++) {
    const request = command(id, `editor-limit-${index}`); item.browser.send(request);
    const response = await item.browser.next(value => value.type === 'server.response' && value.requestId === request.requestId);
    if (response.type === 'server.response') assert.match(response.error!, index === 120 ? /Too many attempts/ : /Confirm this browser session/);
  }
  assert.ok(!item.plugin.all.some(value => value.type === 'request'));
  assert.equal((await f.control('CHANNELS', id, { operation: 'read', key: 'channel' })).requestCount, 0);
});

test('evicting old encrypted display replies never evicts their command-ID tombstones', { timeout: 60_000 }, async t => {
  const f = await fixture(t); const { channel, cookie, plugin, browser } = await f.authorized(); const id = channel.channelId;
  for (let index = 0; index < 33; index++) {
    // Renew using actual plugin messages; no test timer impersonates presence.
    plugin.send({ type: 'server.heartbeat' });
    const request = command(id, `cache-${index}`); browser.send(request);
    await plugin.next(value => value.type === 'request' && value.requestId === request.requestId);
    plugin.send({ type: 'server.response', requestId: request.requestId, ok: true, encrypted: encrypt({ output: index }, `${id}\nserver.response\n${request.requestId}\ntrue`) });
    await browser.next(value => value.type === 'server.response' && value.requestId === request.requestId);
  }
  assert.equal(await f.control('CHANNELS', id, { operation: 'read', key: 'reply:cache-0' }), null);
  assert.equal((await f.control('CHANNELS', id, { operation: 'read', key: 'request:cache-0' })).state, 'complete');
  const marker = browser.all.length; browser.send(command(id, 'cache-0'));
  const rejected = await browser.next(value => value.type === 'server.response' && value.requestId === 'cache-0', marker);
  if (rejected.type === 'server.response') assert.match(rejected.error!, /already used/);
  assert.equal(plugin.all.filter(value => value.type === 'request' && value.requestId === 'cache-0').length, 1);
  const saved = await f.control('CHANNELS', id, { operation: 'list' });
  assert.equal(Object.keys(saved).filter(key => key.startsWith('request:')).length, 33);
  assert.equal(Object.keys(saved).filter(key => key.startsWith('reply:')).length, 32);
  await f.http('/api/session/end', {}, cookie); await plugin.closed;
  const cleared = await f.control('CHANNELS', id, { operation: 'list' });
  assert.deepEqual(Object.keys(cleared), ['channel']);
});
