export interface ServerStatus {
  name: string;
  platform: string;
  version: string;
  connection: string;
  online: string[];
  groups: string[];
}

export interface QrState {
  status: string;
  qrCodeUrl?: string | null;
  qrImageBase64?: string | null;
  message?: string | null;
}

export interface UpdateState {
  current: string;
  latest?: string | null;
  outdated: boolean;
  checked: boolean;
  enabled: boolean;
  checkedAt: number;
  releaseUrl?: string | null;
  error?: string | null;
  checking: boolean;
}

export type Configuration = Record<string, unknown>;
export const UNCHANGED_SECRET = '__HUHOBOT_SECRET_UNCHANGED__';
export interface EncryptedPayload { iv: string; ciphertext: string }
export interface EditorRequestPayload { values?: Configuration; groupId?: string | null; command?: string }
export type EditorAction = 'config.get' | 'config.save' | 'config.reload' | 'command.execute' | 'qr.start' | 'qr.cancel' | 'update.check';
export interface EditorRequest {
  type: 'request';
  requestId: string;
  action: EditorAction;
  encrypted: EncryptedPayload;
}

export type ServerMessage =
  | { type: 'server.data'; topic: 'status' | 'configuration' | 'qr' | 'update'; encrypted: EncryptedPayload }
  | { type: 'server.response'; requestId: string; ok: boolean; encrypted?: EncryptedPayload; error?: string }
  | { type: 'server.heartbeat' }
  | { type: 'server.disconnect' }
  | { type: 'server.close'; reason: string }
  | { type: 'server.authorize'; requestId: string; code: string };

export type RelayToServer =
  | EditorRequest
  | { type: 'channel.ready'; channelId: string }
  | { type: 'channel.authorized'; requestId: string }
  | { type: 'channel.authorizationFailed'; requestId: string; error: string }
  | { type: 'channel.closed'; reason: string };

export type RelayToEditor =
  | Exclude<ServerMessage, { type: 'server.authorize' | 'server.heartbeat' | 'server.disconnect' | 'server.close' }>
  | { type: 'channel.state'; channelId: string; state: 'pending' | 'authorized' | 'closed'; serverOnline: boolean; code?: string; codeExpiresAt?: number; expiresAt: number; server: Pick<ServerStatus, 'name' | 'platform' | 'version'>; reason?: string }
  | { type: 'channel.closed'; reason: string };

export interface CreateChannelResponse {
  channelId: string;
  serverToken: string;
  editorUrl: string;
  expiresAt: number;
}

