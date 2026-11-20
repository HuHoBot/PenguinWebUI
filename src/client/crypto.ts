import type { EncryptedPayload } from '../shared/protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function decodeBase64Url(value: string, maxLength: number): Uint8Array<ArrayBuffer> {
  if (!value || value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('加密数据格式无效。');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function importChannelKey(cipherKey: string): Promise<CryptoKey> {
  if (!window.crypto?.subtle) throw new Error('端到端加密需要 HTTPS（本地开发可用 localhost）。请使用安全地址打开网站。');
  const raw = decodeBase64Url(cipherKey, 43);
  if (raw.byteLength !== 32) throw new Error('编辑链接中的加密密钥无效。请从服务器重新获取完整链接。');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptPayload(key: CryptoKey, value: unknown, additionalData: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(additionalData), tagLength: 128 }, key, plaintext);
  return { iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(new Uint8Array(ciphertext)) };
}

export async function decryptPayload(key: CryptoKey, encrypted: EncryptedPayload, additionalData: string): Promise<unknown> {
  if (!encrypted || typeof encrypted.iv !== 'string' || typeof encrypted.ciphertext !== 'string') throw new Error('服务器缺少端到端加密数据。');
  const iv = decodeBase64Url(encrypted.iv, 16);
  const ciphertext = decodeBase64Url(encrypted.ciphertext, 2_000_000);
  if (iv.byteLength !== 12 || ciphertext.byteLength < 16) throw new Error('服务器加密数据格式无效。');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(additionalData), tagLength: 128 }, key, ciphertext);
  return JSON.parse(decoder.decode(plaintext)) as unknown;
}
