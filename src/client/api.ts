export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal,
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(response.status, response.ok ? '服务器返回了无法识别的响应。' : `请求失败（HTTP ${response.status}）。`);
  }
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
      ? data.error
      : typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string'
        ? data.message
        : `请求失败（HTTP ${response.status}）。`;
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

export interface EditorLocation {
  channelId: string | null;
  error: string | null;
}

let ephemeralKeys: { channelId: string; joinKey: string | null; cipherKey: string } | null = null;

export function readEditorLocation(): EditorLocation {
  const match = /^\/editor\/([^/]+)\/?$/.exec(window.location.pathname);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const incoming = fragment.get('key');
  const cipher = fragment.get('cipher');
  if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  if (!match) return { channelId: null, error: null };
  let channelId: string;
  try {
    channelId = decodeURIComponent(match[1]);
  } catch {
    return { channelId: null, error: '编辑链接格式无效。请从服务器重新获取链接。' };
  }
  let error: string | null = null;
  if (incoming !== null || cipher !== null) {
    if (incoming && cipher && /^[A-Za-z0-9_-]{43}$/.test(incoming) && /^[A-Za-z0-9_-]{43}$/.test(cipher)) {
      try {
        sessionStorage.setItem(`huhobot:join:${channelId}`, incoming);
        sessionStorage.setItem(`huhobot:cipher:${channelId}`, cipher);
      } catch { ephemeralKeys = { channelId, joinKey: incoming, cipherKey: cipher }; }
    } else {
      error = '编辑链接缺少有效的加入密钥或独立加密密钥。请从服务器重新获取完整链接。';
    }
  }
  return { channelId, error };
}

export function readJoinKey(channelId: string | null): string | null {
  if (!channelId) return null;
  if (ephemeralKeys?.channelId === channelId) return ephemeralKeys.joinKey;
  try { return sessionStorage.getItem(`huhobot:join:${channelId}`); }
  catch { return null; }
}

export function readCipherKey(channelId: string | null): string | null {
  if (!channelId) return null;
  if (ephemeralKeys?.channelId === channelId) return ephemeralKeys.cipherKey;
  try { return sessionStorage.getItem(`huhobot:cipher:${channelId}`); }
  catch { return null; }
}

export function forgetClaimKey(channelId: string | null): void {
  if (!channelId) return;
  if (ephemeralKeys?.channelId === channelId) ephemeralKeys.joinKey = null;
  try { sessionStorage.removeItem(`huhobot:join:${channelId}`); } catch { /* Storage may be unavailable. */ }
}

export function forgetEditorKeys(channelId: string | null): void {
  if (!channelId || ephemeralKeys?.channelId === channelId) ephemeralKeys = null;
  try {
    if (channelId) {
      sessionStorage.removeItem(`huhobot:join:${channelId}`);
      sessionStorage.removeItem(`huhobot:cipher:${channelId}`);
    } else {
      // Ending the browser session also removes keys left by earlier channels in this tab.
      for (let index = sessionStorage.length - 1; index >= 0; index--) {
        const key = sessionStorage.key(index);
        if (key?.startsWith('huhobot:join:') || key?.startsWith('huhobot:cipher:')) sessionStorage.removeItem(key);
      }
    }
  } catch { /* Storage may be unavailable. */ }
}
