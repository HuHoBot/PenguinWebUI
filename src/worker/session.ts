import { HttpError, object } from '../server/validation.js';
import { SESSION_MS, SerialActor, channelStub, errorResponse, internal, response, type Env } from './common.js';

interface SessionRecord { hash: string; expiresAt: number; revoked: boolean; reason?: string }
interface RateRecord { count: number; expiresAt: number }
const ENDED = 'Browser session ended; create a new pairing channel';
const EXPIRED = 'Browser pairing session expired; create a new pairing channel';

// A BrowserSession is a disposable capability, not a website user. The actor's
// name and record contain only a SHA-256 hash, never the browser cookie token.
export class BrowserSession extends SerialActor {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) { super(); }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const value = object(await request.json());
      if (path === '/end') {
        await this.serial(() => this.revoke(ENDED));
        // Revocation commits before notification. Do not keep the session queue
        // locked while a channel might be asking this actor to verify activity.
        await this.notify();
        return response({ ended: true });
      }
      return await this.serial(async () => {
        if (path === '/rate') {
          const limit = Number(value.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 600) throw new HttpError(400, 'Invalid rate limit');
          const allowed = await this.ctx.storage.transaction(async tx => {
            const now = Date.now(); const current = await tx.get<RateRecord>('rate');
            const record = current && current.expiresAt > now ? current : { count: 0, expiresAt: now + 60_000 };
            record.count++; await tx.put('rate', record); await tx.setAlarm(record.expiresAt);
            return record.count <= limit;
          });
          return allowed ? response({ allowed: true }) : response({ error: 'Too many attempts; try again later' }, 429);
        }
        if (path === '/create') {
          if (typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) throw new HttpError(400, 'Invalid session hash');
          const created = await this.ctx.storage.transaction(async tx => {
            if (await tx.get('session')) return false;
            const record: SessionRecord = { hash: value.hash as string, expiresAt: Date.now() + SESSION_MS, revoked: false };
            await tx.put('session', record); await tx.setAlarm(record.expiresAt); return true;
          });
          return response({ active: created });
        }
        const record = await this.ctx.storage.get<SessionRecord>('session');
        const active = Boolean(record && !record.revoked && record.expiresAt > Date.now());
        if (!active && record && !record.revoked) {
          await this.revoke(EXPIRED);
          this.ctx.waitUntil(this.notify());
        }
        if (path === '/active') return response({ active });
        if (path === '/reuse') {
          if (!active) return response({ active: false });
          record!.expiresAt = Date.now() + SESSION_MS;
          await this.ctx.storage.transaction(async tx => { await tx.put('session', record!); await tx.setAlarm(record!.expiresAt); });
          return response({ active: true });
        }
        if (path === '/register') {
          if (!active) throw new HttpError(401, 'Browser pairing session expired; open a new editor link');
          if (typeof value.channelId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.channelId)) throw new HttpError(400, 'Invalid channel ID');
          // Registration precedes channel ownership. If an end races a claim,
          // the channel is already on this durable notification list.
          await this.ctx.storage.put(`channel:${value.channelId}`, true);
          return response({ active: true });
        }
        return response({ error: 'Endpoint not found' }, 404);
      });
    } catch (error) { return errorResponse(error); }
  }

  private async revoke(reason: string): Promise<void> {
    await this.ctx.storage.transaction(async tx => {
      const record = await tx.get<SessionRecord>('session');
      if (!record) return;
      record.revoked = true; record.reason ??= reason;
      await tx.put('session', record);
      // An alarm also retries interrupted revocation notification after restart.
      await tx.setAlarm(Date.now() + 1000);
    });
  }

  private async notify(): Promise<void> {
    const record = await this.ctx.storage.get<SessionRecord>('session');
    if (!record?.revoked) return;
    const channels = await this.ctx.storage.list<boolean>({ prefix: 'channel:' });
    await Promise.all([...channels.keys()].map(async key => {
      const result = await channelStub(this.env, key.slice(8)).fetch(internal('/revoke', { sessionHash: record.hash, reason: record.reason ?? EXPIRED }));
      if (!result.ok) throw new Error('Channel revocation unavailable');
      await this.ctx.storage.delete(key);
    }));
    await this.serial(async () => {
      // A revoked capability cannot be reused. Keep its tombstone until its
      // cookie lifetime ends, then remove it; a missing actor also fails reuse.
      if ((await this.ctx.storage.list({ prefix: 'channel:', limit: 1 })).size === 0) {
        if (record.expiresAt > Date.now()) await this.ctx.storage.setAlarm(record.expiresAt);
        else await this.ctx.storage.deleteAll();
      }
    });
  }

  async alarm(): Promise<void> {
    await this.serial(async () => {
      const record = await this.ctx.storage.get<SessionRecord>('session');
      if (!record) {
        const limiter = await this.ctx.storage.get<RateRecord>('rate');
        if (limiter && limiter.expiresAt > Date.now()) await this.ctx.storage.setAlarm(limiter.expiresAt);
        else await this.ctx.storage.deleteAll();
        return;
      }
      if (!record.revoked && record.expiresAt > Date.now()) { await this.ctx.storage.setAlarm(record.expiresAt); return; }
      await this.revoke(record.reason ?? EXPIRED);
    });
    await this.notify();
  }
}
