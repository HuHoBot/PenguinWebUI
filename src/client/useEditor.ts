import { useCallback, useEffect, useRef, useState } from 'react';
import type { Configuration, EditorAction, EditorRequest, EditorRequestPayload, QrState, RelayToEditor, ServerStatus, UpdateState } from '../shared/protocol';
import { api, ApiError, errorText, forgetClaimKey, forgetEditorKeys, readJoinKey, readCipherKey, type EditorLocation } from './api';
import { decryptPayload, encryptPayload, importChannelKey } from './crypto';

export type ChannelState = Extract<RelayToEditor, { type: 'channel.state' }>;
type Connection = 'disconnected' | 'connecting' | 'connected' | 'retrying' | 'failed';
interface PendingRequest {
  action: EditorAction;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface EditorSession {
  sessionReady: boolean;
  sessionLoading: boolean;
  sessionEnding: boolean;
  endSession: () => Promise<void>;
  channel: ChannelState | null;
  channelLoading: boolean;
  accessError: string | null;
  notice: string | null;
  dismissNotice: () => void;
  connection: Connection;
  status: ServerStatus | null;
  configuration: { values: Configuration; revision: number } | null;
  qr: QrState | null;
  update: UpdateState | null;
  request: (action: EditorAction, payload?: EditorRequestPayload) => Promise<unknown>;
  canSend: boolean;
  reloadChannel: () => Promise<void>;
  reconnect: () => void;
}

// Share the cookie bootstrap across effect replays without aborting the first POST.
let sessionBootstrap: Promise<{ ready: true }> | null = null;
let documentSessionEnded = false;

export function useEditor(location: EditorLocation): EditorSession {
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionEnding, setSessionEnding] = useState(false);
  const [channel, setChannel] = useState<ChannelState | null>(null);
  const [channelLoading, setChannelLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(location.error);
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('disconnected');
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [configuration, setConfiguration] = useState<{ values: Configuration; revision: number } | null>(null);
  const [qr, setQr] = useState<QrState | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [reconnectVersion, setReconnectVersion] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const channelRef = useRef<ChannelState | null>(null);
  const sessionReadyRef = useRef(false);
  const sessionEndingRef = useRef(false);
  const joinKeyRef = useRef<string | null>(null);
  const cipherKeyRef = useRef<string | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const keyLoaded = useRef(false);
  if (!keyLoaded.current) {
    joinKeyRef.current = readJoinKey(location.channelId);
    cipherKeyRef.current = readCipherKey(location.channelId);
    keyLoaded.current = true;
  }
  const requests = useRef(new Map<string, PendingRequest>());
  const revision = useRef(0);
  const configurationFingerprint = useRef<string | null>(null);
  const lifetime = useRef(0);

  const rejectRequests = useCallback((message: string) => {
    for (const request of requests.current.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    requests.current.clear();
  }, []);

  const clearSnapshots = useCallback(() => {
    configurationFingerprint.current = null;
    setStatus(null);
    setConfiguration(null);
    setQr(null);
    setUpdate(null);
  }, []);

  const replaceChannel = useCallback((value: ChannelState | null) => {
    channelRef.current = value;
    setChannel(value);
  }, []);

  const loseSession = useCallback((message?: string) => {
    lifetime.current += 1;
    documentSessionEnded = true;
    sessionReadyRef.current = false;
    setSessionReady(false);
    setSessionLoading(false);
    replaceChannel(null);
    setChannelLoading(false);
    clearSnapshots();
    rejectRequests('此网页会话已结束。未收到响应的操作可能已经执行，请勿自动重试。');
    socketRef.current?.close(1000, 'Browser session ended');
    socketRef.current = null;
    setConnection('disconnected');
    forgetEditorKeys(null);
    joinKeyRef.current = null;
    cipherKeyRef.current = null;
    keyRef.current = null;
    setNotice(message ?? null);
  }, [clearSnapshots, rejectRequests, replaceChannel]);

  useEffect(() => {
    if (documentSessionEnded) {
      setSessionLoading(false);
      setNotice('此网页会话已结束。请在服务器重新执行 /huhobot webui 并打开新的完整链接。');
      return;
    }
    let active = true;
    const generation = lifetime.current;
    sessionBootstrap ??= api<{ ready: true }>('/api/session', { method: 'POST', body: {} });
    void sessionBootstrap
      .then(({ ready }) => {
        if (!active || generation !== lifetime.current || documentSessionEnded) return;
        if (ready !== true) throw new Error('服务器未能建立临时网页会话。');
        sessionReadyRef.current = true;
        setSessionReady(true);
      })
      .catch((error: unknown) => {
        if (active && generation === lifetime.current) setNotice(`无法建立此网页会话：${errorText(error)} 请重新打开服务器生成的完整链接。`);
      })
      .finally(() => { if (active && generation === lifetime.current) setSessionLoading(false); });
    return () => { active = false; };
  }, []);

  const endSession = useCallback(async () => {
    if (sessionEndingRef.current) return;
    sessionEndingRef.current = true;
    setSessionEnding(true);
    // Revoke this page immediately, even when the relay cannot be reached.
    loseSession('此网页会话已结束。请在服务器重新执行 /huhobot webui 并打开新的完整链接。');
    try {
      await api('/api/session/end', { method: 'POST', body: {} });
    } catch (error) {
      setNotice(`本标签页中的密钥、快照与待处理操作已清除，但结束会话请求失败：${errorText(error)} 请恢复网络后再次点击“结束会话”，以关闭服务器上的配对频道。`);
    } finally {
      sessionEndingRef.current = false;
      setSessionEnding(false);
    }
  }, [loseSession]);

  const loadChannel = useCallback(async (signal?: AbortSignal) => {
    if (!location.channelId || !sessionReadyRef.current || location.error) return;
    const generation = lifetime.current;
    setChannelLoading(true);
    setAccessError(null);
    try {
      if (!cipherKeyRef.current) throw new Error('本标签页缺少独立的端到端加密密钥。结束此网页会话后请从服务器重新获取完整编辑链接；仅频道地址不能恢复管理。');
      const key = keyRef.current ?? await importChannelKey(cipherKeyRef.current);
      if (signal?.aborted || generation !== lifetime.current) return;
      keyRef.current = key;
      const path = `/api/channels/${encodeURIComponent(location.channelId)}`;
      let result: ChannelState;
      if (joinKeyRef.current) {
        // An unclaimed channel has no owner yet; consume the entry key before owner-only GET.
        result = await api<ChannelState>(`${path}/claim`, { method: 'POST', body: { joinKey: joinKeyRef.current }, signal });
      } else {
        result = await api<ChannelState>(path, { signal });
        // The exact owning cookie session may refresh an expired, unconsumed pairing code.
        if (result.state === 'pending') {
          result = await api<ChannelState>(`${path}/claim`, { method: 'POST', body: {}, signal });
        }
      }
      if (signal?.aborted || generation !== lifetime.current) return;
      if (result.type !== 'channel.state' || result.channelId !== location.channelId) throw new Error('服务器返回了不匹配的编辑频道。');
      forgetClaimKey(location.channelId);
      joinKeyRef.current = null;
      replaceChannel(result);
      if (result.state === 'closed') {
        clearSnapshots();
        keyRef.current = null;
        joinKeyRef.current = null;
        cipherKeyRef.current = null;
        forgetEditorKeys(location.channelId);
        rejectRequests('编辑频道已关闭。未收到响应的操作可能已经执行，请先核对服务器。');
        socketRef.current?.close(1000, 'Channel closed');
      }
    } catch (error) {
      if (signal?.aborted || generation !== lifetime.current) return;
      if (error instanceof ApiError && [401, 403, 409, 404, 410].includes(error.status)) {
        const message = error.status === 401
          ? '此网页会话已过期。请在服务器重新执行 /huhobot webui 并打开新的完整链接。'
          : error.status === 403 || error.status === 409
            ? '此频道已绑定另一个网页会话，或当前网页会话没有访问权限。请从服务器重新获取链接。'
            : '编辑频道不存在、已关闭或已过期。请在服务器重新执行 /huhobot webui。';
        loseSession(message);
        setAccessError(`${message} ${errorText(error)}`);
      } else {
        setAccessError(`无法加入编辑频道。 ${errorText(error)}`);
      }
    } finally {
      if (!signal?.aborted && generation === lifetime.current) setChannelLoading(false);
    }
  }, [clearSnapshots, location.channelId, location.error, loseSession, rejectRequests, replaceChannel]);

  useEffect(() => {
    if (!sessionReady || !location.channelId) return;
    const controller = new AbortController();
    void loadChannel(controller.signal);
    return () => controller.abort();
  }, [sessionReady, loadChannel, location.channelId]);

  useEffect(() => {
    if (!sessionReady || !channel?.channelId || channel.state === 'closed') return;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let messageQueue: Promise<void> = Promise.resolve();
    let attempts = 0;
    const generation = lifetime.current;
    const channelId = channel.channelId;

    const connect = () => {
      const current = channelRef.current;
      if (stopped || generation !== lifetime.current || !sessionReadyRef.current || !current || current.state === 'closed' || current.expiresAt <= Date.now()) return;
      setConnection(attempts === 0 ? 'connecting' : 'retrying');
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${window.location.host}/ws/editor/${encodeURIComponent(channelId)}`);
      socketRef.current = socket;
      socket.onopen = () => {
        if (stopped || socketRef.current !== socket) { socket.close(); return; }
        setConnection('connected');
        stableTimer = setTimeout(() => { attempts = 0; }, 15_000);
      };
      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string' || event.data.length > 2_000_000) return;
        messageQueue = messageQueue.then(async () => {
          if (stopped || socketRef.current !== socket || generation !== lifetime.current || !sessionReadyRef.current) return;
          let message: RelayToEditor;
          try { message = JSON.parse(event.data) as RelayToEditor; } catch { return; }
          if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
          if (message.type === 'channel.state') {
            if (message.channelId !== channelId || !['pending', 'authorized', 'closed'].includes(message.state) || typeof message.expiresAt !== 'number' || !message.server) return;
            const previous = channelRef.current;
            // The pairing code is disclosed only by claim, not by subsequent state pushes.
            const pendingCode = message.state === 'pending' && previous?.state === 'pending' && !message.code
              ? { code: previous.code, codeExpiresAt: previous.codeExpiresAt } : {};
            replaceChannel({ ...message, ...pendingCode });
            if (message.state !== 'authorized') {
              clearSnapshots();
              rejectRequests('频道尚未授权或已关闭。未收到响应的操作不会自动重试。');
            }
            if (message.state === 'closed') {
              keyRef.current = null;
              joinKeyRef.current = null;
              cipherKeyRef.current = null;
              forgetEditorKeys(channelId);
              socket.close(1000, 'Channel closed');
            }
            return;
          }
          if (message.type === 'channel.closed') {
            const existing = channelRef.current;
            if (existing) replaceChannel({ ...existing, state: 'closed', serverOnline: false, code: undefined, reason: message.reason });
            clearSnapshots();
            keyRef.current = null;
            joinKeyRef.current = null;
            cipherKeyRef.current = null;
            forgetEditorKeys(channelId);
            rejectRequests('编辑频道已关闭。未收到响应的操作可能已经执行，请先核对服务器。');
            socket.close(1000, 'Channel closed');
            return;
          }
          if (channelRef.current?.state !== 'authorized' || !keyRef.current) return;
          const key = keyRef.current;
          if (message.type === 'server.data') {
            if (!['status', 'configuration', 'qr', 'update'].includes(message.topic)) return;
            const data = await decryptPayload(key, message.encrypted, `${channelId}\nserver.data\n${message.topic}`);
            if (stopped || socketRef.current !== socket || keyRef.current !== key || channelRef.current?.state !== 'authorized') return;
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('服务器快照格式无效。');
            switch (message.topic) {
              case 'status': {
                const value = data as ServerStatus;
                if (typeof value.name !== 'string' || !Array.isArray(value.online) || !Array.isArray(value.groups) || !value.online.every((entry) => typeof entry === 'string') || !value.groups.every((entry) => typeof entry === 'string')) throw new Error('服务器状态格式无效。');
                setStatus(value);
                break;
              }
              case 'configuration': {
                const fingerprint = JSON.stringify(data);
                if (configurationFingerprint.current !== fingerprint) {
                  configurationFingerprint.current = fingerprint;
                  setConfiguration({ values: data as Configuration, revision: ++revision.current });
                }
                break;
              }
              case 'qr': {
                const value = data as QrState;
                if (typeof value.status !== 'string') throw new Error('扫码状态格式无效。');
                setQr(value);
                break;
              }
              case 'update': {
                const value = data as UpdateState;
                if (typeof value.current !== 'string') throw new Error('版本状态格式无效。');
                setUpdate(value);
                break;
              }
            }
          } else if (message.type === 'server.response') {
            if (typeof message.requestId !== 'string' || typeof message.ok !== 'boolean') return;
            const pending = requests.current.get(message.requestId);
            if (!pending) return;
            const data = message.encrypted
              ? await decryptPayload(key, message.encrypted, `${channelId}\nserver.response\n${message.requestId}\n${message.ok ? 'true' : 'false'}`)
              : !message.ok && typeof message.error === 'string' ? { error: message.error } : null;
            if (stopped || socketRef.current !== socket || keyRef.current !== key || requests.current.get(message.requestId) !== pending) return;
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('服务器响应缺少有效加密数据。');
            const response = data as { result?: unknown; error?: string };
            requests.current.delete(message.requestId);
            clearTimeout(pending.timer);
            if (message.ok) {
              const result = response.result;
              if (result && typeof result === 'object') {
                if ((pending.action === 'qr.start' || pending.action === 'qr.cancel') && 'status' in result && typeof result.status === 'string') setQr(result as QrState);
                if (pending.action === 'update.check' && 'current' in result && typeof result.current === 'string') setUpdate(result as UpdateState);
              }
              pending.resolve(response.result);
            } else pending.reject(new Error(typeof response.error === 'string' ? response.error : '服务器拒绝了操作。'));
          }
        }).catch(() => {
          if (stopped || socketRef.current !== socket) return;
          clearSnapshots();
          rejectRequests('服务器数据解密或校验失败。操作不会自动重试，请先核对服务器。');
          setAccessError('端到端加密校验失败，已停止实时连接。请使用服务器生成的完整链接，并核对是否为正确的频道。');
          setConnection('failed');
          stopped = true;
          socketRef.current = null;
          socket.close(1008, 'Encrypted data verification failed');
        });
      };
      socket.onerror = () => { /* onclose handles retry; commands are never replayed. */ };
      socket.onclose = () => {
        clearTimeout(stableTimer);
        if (stopped || socketRef.current !== socket) return;
        socketRef.current = null;
        setConnection('disconnected');
        rejectRequests('连接已中断，未收到服务器响应。操作可能已经执行，请核对后再决定是否重新提交；系统不会自动重试。');
        const latest = channelRef.current;
        if (!latest || latest.state === 'closed' || latest.expiresAt <= Date.now()) return;
        // Resume only through the bound anonymous cookie, never the consumed entry key.
        void api<ChannelState>(`/api/channels/${encodeURIComponent(channelId)}`).then((current) => {
          if (stopped || generation !== lifetime.current || !sessionReadyRef.current) return;
          if (current.type !== 'channel.state' || current.channelId !== channelId) throw new Error('服务器返回了不匹配的编辑频道。');
          const previous = channelRef.current;
          const pendingCode = current.state === 'pending' && previous?.state === 'pending' && !current.code
            ? { code: previous.code, codeExpiresAt: previous.codeExpiresAt } : {};
          replaceChannel({ ...current, ...pendingCode });
          if (current.state !== 'authorized') clearSnapshots();
          if (current.state === 'closed') {
            keyRef.current = null;
            joinKeyRef.current = null;
            cipherKeyRef.current = null;
            forgetEditorKeys(channelId);
          }
        }).catch((error: unknown) => {
          if (stopped || generation !== lifetime.current) return;
          if (error instanceof ApiError && [401, 403, 409, 404, 410].includes(error.status)) {
            loseSession('此网页会话或编辑频道已失效，无法继续管理。请在服务器重新执行 /huhobot webui 并打开新的完整链接。未收到响应的操作不会自动重试。');
          }
        }).finally(() => {
          if (stopped || generation !== lifetime.current || !sessionReadyRef.current || channelRef.current?.state === 'closed') return;
          attempts += 1;
          if (attempts > 6) { setConnection('failed'); return; }
          setConnection('retrying');
          retryTimer = setTimeout(connect, Math.min(500 * 2 ** (attempts - 1), 8_000));
        });
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(stableTimer);
      rejectRequests('连接已关闭。未收到响应的操作不会自动重试。');
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close(1000, 'Leaving editor');
      setConnection('disconnected');
    };
  }, [sessionReady, channel?.channelId, channel?.state === 'closed', clearSnapshots, loseSession, reconnectVersion, rejectRequests, replaceChannel]);

  useEffect(() => {
    const timer = setInterval(() => {
      const current = channelRef.current;
      if (current && current.state !== 'closed' && current.expiresAt <= Date.now()) {
        replaceChannel({ ...current, state: 'closed', serverOnline: false, code: undefined, reason: '频道已达到有效期，请从服务器重新创建。' });
        clearSnapshots();
        keyRef.current = null;
        joinKeyRef.current = null;
        cipherKeyRef.current = null;
        forgetEditorKeys(location.channelId);
        rejectRequests('编辑频道已过期。未收到响应的操作可能已经执行，请在服务器核对。');
        socketRef.current?.close(1000, 'Channel expired');
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [clearSnapshots, location.channelId, rejectRequests, replaceChannel]);

  const request = useCallback(async (action: EditorAction, payload: EditorRequestPayload = {}): Promise<unknown> => {
    const current = channelRef.current;
    const socket = socketRef.current;
    const key = keyRef.current;
    const generation = lifetime.current;
    if (!sessionReadyRef.current || !current || current.state !== 'authorized' || current.expiresAt <= Date.now()) throw new Error('请先在目标服务器执行一次性验证码命令，确认此网页会话。');
    if (!key) throw new Error('本标签页缺少端到端加密密钥，请从服务器重新打开完整编辑链接。');
    if (!current.serverOnline || !socket || socket.readyState !== WebSocket.OPEN) throw new Error('服务器或实时通道已离线。请等待重新连接后手动提交；不会自动重试。');
    if (requests.current.size >= 8) throw new Error('待处理请求过多，请等待已有操作完成。');
    const requestId = crypto.randomUUID();
    const encrypted = await encryptPayload(key, payload, `${current.channelId}\nrequest\n${requestId}\n${action}`);
    if (generation !== lifetime.current || keyRef.current !== key || socketRef.current !== socket || socket.readyState !== WebSocket.OPEN || channelRef.current?.state !== 'authorized' || !channelRef.current.serverOnline || channelRef.current.expiresAt <= Date.now()) throw new Error('加密期间连接或授权已改变，请核对状态后手动提交。未发送此操作。');
    if (requests.current.size >= 8) throw new Error('待处理请求过多，此操作尚未发送。');
    // Executor form preserves compatibility with browsers without Promise.withResolvers.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.current.delete(requestId);
        reject(new Error('等待服务器响应超时。操作可能已经执行，请先核对服务器；系统不会自动重试。'));
      }, 25_000);
      requests.current.set(requestId, { action, resolve, reject, timer });
      try { socket.send(JSON.stringify({ type: 'request', requestId, action, encrypted } satisfies EditorRequest)); }
      catch (error) {
        clearTimeout(timer);
        requests.current.delete(requestId);
        reject(new Error(`发送失败：${errorText(error)} 操作不会自动重试。`));
      }
    });
  }, []);

  const canSend = sessionReady && keyRef.current !== null && channel?.state === 'authorized' && channel.serverOnline && connection === 'connected' && channel.expiresAt > Date.now();
  return {
    sessionReady, sessionLoading, sessionEnding, endSession, channel, channelLoading, accessError, notice,
    dismissNotice: () => setNotice(null), connection, status, configuration, qr, update, request, canSend,
    reloadChannel: () => loadChannel(), reconnect: () => setReconnectVersion((value) => value + 1),
  };
}

