import { CHANNEL_ID, HttpError, TOKEN, keys, object, text } from '../server/validation.js';
import { CHANNEL_MS, body, channelStub, checkOrigin, cookie, cookieToken, digest, errorResponse, internal, publicOrigin, randomToken, rate, requireSession, response, sessionStub, type Env } from './common.js';
export { EditorChannel } from './channel.js';
export { BrowserSession } from './session.js';
export type { Env } from './common.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const origin = publicOrigin(env);
      const path = new URL(request.url).pathname;
      const claim = /^\/api\/channels\/([A-Za-z0-9_-]{32})\/claim$/.exec(path);
      const state = /^\/api\/channels\/([A-Za-z0-9_-]{32})$/.exec(path);
      const socket = /^\/ws\/(server|editor)\/([A-Za-z0-9_-]{32})$/.exec(path);
      const api = ['/api/session', '/api/session/end', '/api/channels'].includes(path) || !!claim || !!state;
      if (socket) {
        if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'WebSocket upgrade required');
        const id = socket[2]!; const server = socket[1] === 'server';
        checkOrigin(request, origin, server);
        const headers = new Headers({ Upgrade: 'websocket' });
        if (server) {
          const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
          if (!bearer || !TOKEN.test(bearer[1]!)) throw new HttpError(403, 'Server Authorization header required');
          const hash = await digest(bearer[1]!);
          const verified = await channelStub(env, id).fetch(internal('/verify', { serverHash: hash }));
          if (!verified.ok) return verified;
          headers.set('x-verified-server-hash', hash);
        } else {
          headers.set('x-verified-session-hash', await requireSession(env, request));
        }
        // No public header is propagated. The private actor route is selected by
        // this code, not by the caller's path, query, cookie, or X-* headers.
        return channelStub(env, id).fetch(new Request(`https://actor.internal/${server ? 'server' : 'editor'}`, { headers }));
      }
      if (!api) {
        if (path === '/api' || path.startsWith('/api/') || path === '/ws' || path.startsWith('/ws/') || path === '/internal' || path.startsWith('/internal/') || path === '/actor.internal') return response({ error: 'Endpoint not found' }, 404);
        return env.ASSETS.fetch(request);
      }
      const ip = request.headers.get('cf-connecting-ip') ?? 'local';
      if (request.method === 'GET' && state) {
        checkOrigin(request, origin, true);
        return channelStub(env, state[1]!).fetch(internal('/state', { sessionHash: await requireSession(env, request) }));
      }
      if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405, { Allow: state ? 'GET' : 'POST' });
      // Creating a channel is a plugin bootstrap: no browser session or Origin
      // is available yet. Any supplied Origin must still match the deployment.
      checkOrigin(request, origin, path === '/api/channels');
      const value = object(await body(request));
      if (path === '/api/session') {
        keys(value, []); await rate(env, 'session-bootstrap', ip, 30);
        let token = cookieToken(request);
        if (token) {
          const reused = await sessionStub(env, await digest(token)).fetch(internal('/reuse', {}));
          if (!reused.ok) return reused;
          if (!(await reused.json() as { active: boolean }).active) token = undefined;
        }
        if (!token) {
          token = randomToken(); const hash = await digest(token);
          const created = await sessionStub(env, hash).fetch(internal('/create', { hash }));
          if (!created.ok || !(await created.json() as { active: boolean }).active) throw new HttpError(503, 'Browser session creation failed');
        }
        return response({ ready: true }, 200, { 'Set-Cookie': cookie(token, origin) });
      }
      if (path === '/api/session/end') {
        keys(value, []); await rate(env, 'session-end', ip, 20);
        const token = cookieToken(request);
        if (token) {
          const ended = await sessionStub(env, await digest(token)).fetch(internal('/end', {}));
          if (!ended.ok) return ended;
        }
        return response({ ended: true }, 200, { 'Set-Cookie': cookie('', origin, true) });
      }
      if (path === '/api/channels') {
        keys(value, ['name', 'platform', 'version']);
        const server = { name: text(value.name, 128), platform: text(value.platform, 64), version: text(value.version, 128) };
        await rate(env, 'channel-create', ip, 10);
        const id = randomToken(24), serverToken = randomToken(), joinKey = randomToken();
        if (!CHANNEL_ID.test(id)) throw new HttpError(503, 'Channel creation failed');
        const expiresAt = Date.now() + CHANNEL_MS;
        const result = await channelStub(env, id).fetch(internal('/create', { id, server, expiresAt, serverHash: await digest(serverToken), joinHash: await digest(joinKey) }));
        if (!result.ok) return result;
        return response({ channelId: id, serverToken, editorUrl: `${origin}/editor/${id}#key=${joinKey}`, expiresAt }, 201);
      }
      if (claim) {
        keys(value, [], ['joinKey']);
        const hash = await requireSession(env, request);
        await rate(env, 'channel-claim', `${hash}:${claim[1]}`, 20);
        let joinHash: string | undefined;
        if (value.joinKey !== undefined) {
          const join = text(value.joinKey, 43, 43);
          if (!TOKEN.test(join)) throw new HttpError(403, 'Invalid channel credential');
          joinHash = await digest(join);
        }
        return channelStub(env, claim[1]!).fetch(internal('/claim', { sessionHash: hash, ...(joinHash ? { joinHash } : {}) }));
      }
      return response({ error: 'Endpoint not found' }, 404);
    } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<Env>;
