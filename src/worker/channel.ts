import type { EditorRequest, RelayToEditor, RelayToServer, ServerMessage } from '../shared/protocol.js';
import { HttpError, editorMessage, object, safeJson, serverMessage } from '../server/validation.js';
import { CODE_MS, LEASE_MS, REQUEST_MS, SerialActor, confirmation, digest, errorResponse, internal, randomToken, rate, response, sessionActive, sessionStub, type Env } from './common.js';

type StateMessage = Extract<RelayToEditor, { type: 'channel.state' }>;
type Snapshot = Extract<ServerMessage, { type: 'server.data' }>;
type Reply = Extract<RelayToEditor, { type: 'server.response' }>;
interface Pending { nonce: string; deadline: number }
interface ChannelRecord {
  id: string; state: StateMessage['state']; expiresAt: number;
  server: StateMessage['server']; serverHash?: string; joinHash?: string;
  owner?: string; codeHash?: string; codeExpiresAt?: number; authorizationRequestId?: string;
  nonce?: string; leaseUntil: number; reason?: string;
  requestCount: number; pending: Record<string, Pending>; recentResponses: string[];
}
interface RequestRecord { state: 'consumed' | 'complete'; nonce: string; deadline: number }
interface Attachment { role: 'server' | 'editor'; nonce: string; sessionHash?: string }
const CHANGED = 'Server connection changed; the request was not retried. Check the server before retrying manually.';
const DISCONNECTED = 'Server disconnected; the request was not retried. Check the server before retrying manually.';
const TIMED_OUT = 'Response timed out; the request was not retried. Check the server before retrying manually.';
const SESSION_ENDED = 'Browser pairing session expired or ended; create a new pairing channel';

export class EditorChannel extends SerialActor {
  private queuedMessages = 0;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) { super(); }

  async fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      try {
        const path = new URL(request.url).pathname;
        if (path === '/server' || path === '/editor') return await this.upgrade(request, path === '/server');
        const value = object(await request.json());
        if (path === '/create') {
          if (await this.ctx.storage.get('channel')) throw new HttpError(409, 'Channel already exists');
          const record: ChannelRecord = { id: value.id as string, state: 'pending', expiresAt: value.expiresAt as number, server: value.server as StateMessage['server'], serverHash: value.serverHash as string, joinHash: value.joinHash as string, leaseUntil: 0, requestCount: 0, pending: {}, recentResponses: [] };
          await this.persist(record); return response({ expiresAt: record.expiresAt });
        }
        const record = await this.ctx.storage.get<ChannelRecord>('channel');
        if (path === '/revoke') {
          // Session actors may register before the claim commits. A notification
          // must not close a channel owned by another session (or still unowned).
          if (record && record.owner === value.sessionHash && record.state !== 'closed') await this.closeChannel(record, typeof value.reason === 'string' ? value.reason : SESSION_ENDED);
          return response({ closed: true });
        }
        if (!record) throw new HttpError(404, 'Channel not found or expired');
        await this.sweep(record);
        if (path === '/verify') {
          this.live(record);
          if (record.serverHash !== value.serverHash) throw new HttpError(403, 'Invalid server credential');
          await this.ownerActive(record); return response({ valid: true });
        }
        if (path === '/claim') {
          this.live(record);
          const hash = value.sessionHash as string;
          if (record.owner && record.owner !== hash) throw new HttpError(409, 'Channel is paired with another browser session');
          if (!record.owner && (!value.joinHash || value.joinHash !== record.joinHash)) throw new HttpError(403, 'Invalid channel credential');
          const registered = await sessionStub(this.env, hash).fetch(internal('/register', { channelId: record.id }));
          if (!registered.ok) throw new HttpError(401, 'Browser pairing session expired; open a new editor link');
          record.owner = hash; delete record.joinHash;
          let code: string | undefined;
          if (record.state === 'pending') {
            code = confirmation(); record.codeHash = await digest(code); record.codeExpiresAt = Math.min(Date.now() + CODE_MS, record.expiresAt);
          }
          await this.persist(record);
          await this.ownerActive(record);
          await this.publishState(record);
          return response({ ...this.state(record), ...(code ? { code } : {}) });
        }
        if (path === '/state') {
          this.present(record);
          this.owner(record, value.sessionHash as string);
          await this.ownerActive(record);
          return response(this.state(record));
        }
        return response({ error: 'Endpoint not found' }, 404);
      } catch (error) { return errorResponse(error); }
    });
  }

  private present(record: ChannelRecord): void {
    if (record.expiresAt <= Date.now()) throw new HttpError(404, 'Channel not found or expired');
  }
  private live(record: ChannelRecord): void {
    this.present(record);
    if (record.state === 'closed') throw new HttpError(410, 'Channel is closed');
  }
  private owner(record: ChannelRecord, hash: string): void {
    if (!hash || record.owner !== hash) throw new HttpError(409, 'Channel is paired with another browser session');
  }
  private online(record: ChannelRecord): boolean { return record.state !== 'closed' && !!record.nonce && record.leaseUntil > Date.now() && record.expiresAt > Date.now(); }
  private fenced(record: ChannelRecord, nonce: string): void {
    this.live(record);
    if (record.nonce !== nonce || !this.online(record)) throw new HttpError(409, 'Server connection was replaced or its lease expired');
  }
  private async ownerActive(record: ChannelRecord): Promise<void> {
    if (record.owner && !await sessionActive(this.env, record.owner)) {
      if (record.state !== 'closed') await this.closeChannel(record, SESSION_ENDED);
      throw new HttpError(401, 'Browser pairing session expired; open a new editor link');
    }
  }
  private state(record: ChannelRecord): StateMessage {
    return { type: 'channel.state', channelId: record.id, state: record.state, serverOnline: this.online(record), expiresAt: record.expiresAt, server: record.server, ...(record.state === 'pending' && record.codeExpiresAt ? { codeExpiresAt: record.codeExpiresAt } : {}), ...(record.state === 'closed' ? { reason: record.reason ?? 'Channel closed' } : {}) };
  }
  private sockets(role?: Attachment['role']): WebSocket[] {
    return this.ctx.getWebSockets().filter(socket => !role || this.attachment(socket)?.role === role);
  }
  private attachment(socket: WebSocket): Attachment | undefined { return socket.deserializeAttachment() as Attachment | undefined; }
  private send(socket: WebSocket, value: RelayToEditor | RelayToServer): boolean {
    try { socket.send(JSON.stringify(value)); return true; } catch { this.stop(socket, 1011, 'Transport unavailable; requests are never replayed'); return false; }
  }
  private stop(socket: WebSocket, code = 1000, reason = 'Connection closed'): void {
    try { socket.close(code, reason); } catch { /* The transport may already be closed. */ }
  }
  private async publishState(record: ChannelRecord): Promise<void> {
    await this.ownerActive(record);
    const state = this.state(record);
    for (const socket of this.sockets('editor')) if (this.attachment(socket)?.sessionHash === record.owner) this.send(socket, state);
  }
  private async publish(record: ChannelRecord, messages: RelayToEditor[]): Promise<void> {
    if (record.state !== 'authorized') return;
    await this.ownerActive(record);
    this.live(record);
    for (const socket of this.sockets('editor')) {
      if (this.attachment(socket)?.sessionHash !== record.owner) continue;
      for (const message of messages) {
        if ((message.type === 'server.data' || (message.type === 'server.response' && message.encrypted)) && !this.online(record)) continue;
        this.send(socket, message);
      }
    }
  }

  private alarmAt(record: ChannelRecord): number {
    let deadline = record.expiresAt;
    if (record.state !== 'closed') {
      if (record.nonce) deadline = Math.min(deadline, record.leaseUntil);
      if (record.codeExpiresAt) deadline = Math.min(deadline, record.codeExpiresAt);
      for (const pending of Object.values(record.pending)) deadline = Math.min(deadline, pending.deadline);
    }
    return Math.max(Date.now() + 1, deadline);
  }
  private async persist(record: ChannelRecord, writes: Record<string, unknown> = {}, deletes: string[] = []): Promise<void> {
    await this.ctx.storage.transaction(async tx => {
      await tx.put('channel', record);
      if (Object.keys(writes).length) await tx.put(writes);
      for (let index = 0; index < deletes.length; index += 128) await tx.delete(deletes.slice(index, index + 128));
      await tx.setAlarm(this.alarmAt(record));
    });
  }
  private async saveResponses(record: ChannelRecord, replies: Reply[], tombstones: Record<string, RequestRecord>): Promise<void> {
    const writes: Record<string, unknown> = { ...tombstones };
    const deletes: string[] = [];
    for (const reply of replies) {
      record.recentResponses.push(reply.requestId);
      writes[`reply:${reply.requestId}`] = reply;
    }
    // Only the refresh display cache is bounded. Request-ID tombstones remain
    // durable for the entire channel lifetime and can never become replayable.
    while (record.recentResponses.length > 32) deletes.push(`reply:${record.recentResponses.shift()!}`);
    await this.persist(record, writes, deletes);
  }
  private async finish(record: ChannelRecord, ids: string[], error: string): Promise<Reply[]> {
    const replies: Reply[] = []; const writes: Record<string, RequestRecord> = {};
    for (const id of ids) {
      const pending = record.pending[`request:${id}`]; if (!pending) continue;
      const reply: Reply = { type: 'server.response', requestId: id, ok: false, error };
      writes[`request:${id}`] = { state: 'complete', ...pending };
      replies.push(reply); delete record.pending[`request:${id}`];
    }
    await this.saveResponses(record, replies, writes); return replies;
  }
  private async clearSnapshots(): Promise<string[]> { return [...(await this.ctx.storage.list({ prefix: 'snapshot:' })).keys()]; }
  private async offline(record: ChannelRecord, error: string): Promise<void> {
    const oldNonce = record.nonce;
    delete record.nonce; record.leaseUntil = 0;
    const replies = await this.finish(record, Object.keys(record.pending).map(key => key.slice(8)), error);
    await this.persist(record, {}, await this.clearSnapshots());
    for (const socket of this.sockets('server')) if (this.attachment(socket)?.nonce === oldNonce) this.stop(socket, 1000, 'Server connection ended; requests are never replayed');
    await this.publish(record, replies); await this.publishState(record);
  }
  private async closeChannel(record: ChannelRecord, reason: string): Promise<void> {
    record.state = 'closed'; record.reason = reason; record.leaseUntil = 0; record.pending = {}; record.recentResponses = [];
    delete record.nonce; delete record.serverHash; delete record.joinHash; delete record.codeHash; delete record.codeExpiresAt; delete record.authorizationRequestId;
    const keys = [...(await this.ctx.storage.list()).keys()].filter(key => key !== 'channel');
    await this.persist(record, {}, keys);
    for (const socket of this.sockets()) { this.send(socket, { type: 'channel.closed', reason }); this.stop(socket, 1000, 'Channel closed'); }
  }
  private async sweep(record: ChannelRecord): Promise<void> {
    if (record.expiresAt <= Date.now()) {
      if (record.state !== 'closed') await this.closeChannel(record, 'Channel expired; create a new pairing channel');
      return;
    }
    if (record.state === 'closed') return;
    await this.ownerActive(record);
    if (record.nonce && record.leaseUntil <= Date.now()) await this.offline(record, DISCONNECTED);
    const expired = Object.entries(record.pending).filter(([, entry]) => entry.deadline <= Date.now()).map(([key]) => key.slice(8));
    if (expired.length) await this.publish(record, await this.finish(record, expired, TIMED_OUT));
    if (record.codeExpiresAt && record.codeExpiresAt <= Date.now()) {
      delete record.codeHash; delete record.codeExpiresAt; await this.persist(record); await this.publishState(record);
    }
  }

  private async upgrade(request: Request, server: boolean): Promise<Response> {
    const record = await this.ctx.storage.get<ChannelRecord>('channel');
    if (!record) throw new HttpError(404, 'Channel not found or expired');
    await this.sweep(record); this.live(record);
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'WebSocket upgrade required');
    let attachment: Attachment;
    if (server) {
      if (record.serverHash !== request.headers.get('x-verified-server-hash')) throw new HttpError(403, 'Invalid server credential');
      const nonce = randomToken();
      const replies = await this.finish(record, Object.keys(record.pending).map(key => key.slice(8)), CHANGED);
      record.nonce = nonce; record.leaseUntil = Math.min(Date.now() + LEASE_MS, record.expiresAt);
      await this.persist(record, {}, await this.clearSnapshots());
      // The durable nonce fences old handlers before their transport closes.
      for (const socket of this.sockets('server')) this.stop(socket, 1000, 'Server connection replaced');
      await this.publish(record, replies);
      attachment = { role: 'server', nonce };
    } else {
      const hash = request.headers.get('x-verified-session-hash') ?? '';
      this.owner(record, hash); await this.ownerActive(record);
      if (this.sockets('editor').length >= 8) throw new HttpError(429, 'Too many editor connections');
      attachment = { role: 'editor', nonce: randomToken(), sessionHash: hash };
    }
    const pair = new WebSocketPair(); const client = pair[0], socket = pair[1];
    this.ctx.acceptWebSocket(socket, [attachment.role]);
    socket.serializeAttachment(attachment);
    await this.ownerActive(record);
    if (server) {
      this.fenced(record, attachment.nonce);
      this.send(socket, { type: 'channel.ready', channelId: record.id });
      if (record.state === 'authorized') this.send(socket, { type: 'channel.authorized', requestId: 'resume' });
      await this.publishState(record);
    } else {
      const saved = record.state === 'authorized' && this.online(record) ? await this.ctx.storage.list<Snapshot>({ prefix: 'snapshot:' }) : new Map<string, Snapshot>();
      // A storage read can yield; recheck the session before sending ciphertext.
      await this.ownerActive(record); this.live(record);
      this.send(socket, this.state(record));
      if (record.state === 'authorized' && this.online(record)) {
        for (const snapshot of saved.values()) this.send(socket, snapshot);
        const replies = await this.ctx.storage.list<Reply>({ prefix: 'reply:' });
        await this.ownerActive(record); this.live(record);
        for (const reply of replies.values()) if (!reply.encrypted || this.online(record)) this.send(socket, reply);
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (++this.queuedMessages > 64) { this.queuedMessages--; this.stop(socket, 1008, 'Too many queued messages'); return; }
    try {
      await this.serial(async () => {
        const attachment = this.attachment(socket);
        try {
          if (!attachment || typeof raw !== 'string') throw new HttpError(400, 'Text JSON messages required');
          const record = await this.ctx.storage.get<ChannelRecord>('channel');
          if (!record) throw new HttpError(404, 'Channel not found or expired');
          await this.sweep(record); this.live(record);
          if (attachment.role === 'server') {
            this.fenced(record, attachment.nonce);
            const message = serverMessage(safeJson(raw));
            await rate(this.env, 'server-messages', record.id, 600);
            await this.ownerActive(record); this.fenced(record, attachment.nonce);
            await this.receive(record, socket, attachment, message);
          } else {
            const message = editorMessage(safeJson(raw));
            try { await this.accept(record, attachment, message); }
            catch (error) {
              this.send(socket, { type: 'server.response', requestId: message.requestId, ok: false, error: error instanceof HttpError ? error.message : 'Relay unavailable; this request was not automatically retried' });
              if (error instanceof HttpError && [401, 404, 410].includes(error.status)) this.stop(socket, 1008, 'Session or channel expired');
            }
          }
        } catch (error) {
          const invalid = error instanceof HttpError && error.status < 500;
          this.stop(socket, invalid ? 1008 : 1013, invalid ? 'Session, connection, or message is no longer valid' : 'Relay unavailable; reconnect without replaying commands');
        }
      });
    } finally { this.queuedMessages--; }
  }

  private async accept(record: ChannelRecord, attachment: Attachment, message: EditorRequest): Promise<void> {
    this.owner(record, attachment.sessionHash ?? '');
    await rate(this.env, 'editor-requests', `${record.id}:${attachment.sessionHash}`, 120);
    await this.ownerActive(record); this.live(record);
    if (record.state !== 'authorized') throw new HttpError(403, 'Confirm this browser session from the game server first');
    if (!this.online(record)) throw new HttpError(409, 'Game server is offline');
    const nonce = record.nonce!;
    const server = this.sockets('server').find(socket => this.attachment(socket)?.nonce === nonce);
    if (!server) throw new HttpError(409, 'Game server is offline');
    if (await this.ctx.storage.get(`request:${message.requestId}`)) throw new HttpError(409, 'Request ID was already used; the request was not executed again');
    if (Object.keys(record.pending).length >= 16 || record.requestCount >= 2048) throw new HttpError(429, 'Too many requests for this channel');
    const pending: Pending = { nonce, deadline: Math.min(Date.now() + REQUEST_MS, record.expiresAt) };
    record.pending[`request:${message.requestId}`] = pending; record.requestCount++;
    // Consumption is final, durable, and bound to one nonce BEFORE send. The
    // envelope is never queued or persisted for a future server connection.
    await this.persist(record, { [`request:${message.requestId}`]: { state: 'consumed', ...pending } satisfies RequestRecord });
    await this.ownerActive(record); this.fenced(record, nonce);
    if (!this.send(server, message)) {
      await this.publish(record, await this.finish(record, [message.requestId], DISCONNECTED));
      await this.offline(record, DISCONNECTED);
    }
  }

  private async receive(record: ChannelRecord, socket: WebSocket, attachment: Attachment, message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'server.heartbeat':
        record.leaseUntil = Math.min(Date.now() + LEASE_MS, record.expiresAt); await this.persist(record); return;
      case 'server.disconnect': await this.offline(record, DISCONNECTED); return;
      case 'server.close': await this.closeChannel(record, 'Server closed the editor channel'); return;
      case 'server.authorize': {
        const acknowledged = record.state === 'authorized' && record.authorizationRequestId === message.requestId;
        let error = 'Confirmation code is invalid or expired';
        let valid = acknowledged;
        if (record.state !== 'authorized') {
          try { await rate(this.env, 'authorize', record.id, 5); }
          catch (failure) { if (!(failure instanceof HttpError) || failure.status !== 429) throw failure; error = 'Too many code attempts; wait one minute'; }
          if (error !== 'Too many code attempts; wait one minute') {
            const suppliedHash = await digest(message.code);
            valid = !!record.owner && !!record.codeHash && (record.codeExpiresAt ?? 0) > Date.now() && suppliedHash === record.codeHash;
          }
        }
        if (valid && !acknowledged) {
          record.state = 'authorized'; record.authorizationRequestId = message.requestId;
          delete record.codeHash; delete record.codeExpiresAt; await this.persist(record);
        }
        await this.ownerActive(record); this.fenced(record, attachment.nonce);
        this.send(socket, valid ? { type: 'channel.authorized', requestId: message.requestId } : { type: 'channel.authorizationFailed', requestId: message.requestId, error });
        if (valid) await this.publishState(record);
        return;
      }
      case 'server.data':
        if (record.state !== 'authorized') throw new HttpError(403, 'Confirm this browser session from the game server first');
        await this.persist(record, { [`snapshot:${message.topic}`]: message });
        await this.publish(record, [message]); return;
      case 'server.response': {
        if (record.state !== 'authorized') throw new HttpError(403, 'Confirm this browser session from the game server first');
        const pending = record.pending[`request:${message.requestId}`];
        // A duplicate, old-nonce, unknown, or expired result cannot replace a
        // completed response. Validation already rejected plaintext plugin errors.
        if (!pending || pending.nonce !== attachment.nonce || pending.deadline <= Date.now()) return;
        delete record.pending[`request:${message.requestId}`];
        await this.saveResponses(record, [message], { [`request:${message.requestId}`]: { state: 'complete', ...pending } });
        await this.publish(record, [message]); return;
      }
    }
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.serial(async () => {
      const attachment = this.attachment(socket); const record = await this.ctx.storage.get<ChannelRecord>('channel');
      if (record && record.state !== 'closed' && attachment?.role === 'server' && record.nonce === attachment.nonce) {
        try { await this.sweep(record); if (record.nonce === attachment.nonce) await this.offline(record, DISCONNECTED); }
        catch { /* Session revocation closes transports; otherwise the alarm fences the lease. */ }
      }
    });
  }
  async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    this.stop(socket, 1011, 'Transport error'); await this.webSocketClose(socket, 1011, 'Transport error', false);
  }
  async alarm(): Promise<void> {
    await this.serial(async () => {
      const record = await this.ctx.storage.get<ChannelRecord>('channel');
      if (!record) return;
      await this.sweep(record);
      if (record.expiresAt <= Date.now()) { await this.ctx.storage.deleteAll(); return; }
      await this.ctx.storage.setAlarm(this.alarmAt(record));
    });
  }
}
