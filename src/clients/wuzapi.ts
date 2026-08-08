import { request, HttpError } from './http';
import type { Tenant } from '../db/repo';

/** Envelope padrao do WuzAPI: { code, data, success }. */
interface Envelope<T> {
  code?: number;
  data?: T;
  success?: boolean;
  error?: string;
}

export interface WuzMediaRef {
  Url?: string;
  DirectPath?: string;
  MediaKey?: string;
  Mimetype?: string;
  FileEncSHA256?: string;
  FileSHA256?: string;
  FileLength?: number;
}

export type WuzMediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

const DOWNLOAD_PATH: Record<WuzMediaKind, string> = {
  image: '/chat/downloadimage',
  video: '/chat/downloadvideo',
  audio: '/chat/downloadaudio',
  document: '/chat/downloaddocument',
  sticker: '/chat/downloadsticker',
};

export class WuzapiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(tenant: Pick<Tenant, 'wuzapi_base_url' | 'wuzapi_token'>) {
    this.baseUrl = tenant.wuzapi_base_url.replace(/\/+$/, '');
    this.token = tenant.wuzapi_token;
  }

  private url(path: string, qs?: Record<string, string>): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(qs ?? {})) u.searchParams.set(k, v);
    return u.toString();
  }

  private async call<T>(
    path: string,
    opts: { method?: string; json?: unknown; qs?: Record<string, string> } = {},
  ): Promise<T> {
    const res = await request<Envelope<T>>(this.url(path, opts.qs), {
      method: opts.method ?? 'GET',
      headers: { token: this.token },
      json: opts.json,
    });

    const payload = res.data;
    if (payload && typeof payload === 'object' && 'success' in payload && payload.success === false) {
      throw new HttpError(res.status, path, payload.error ?? JSON.stringify(payload));
    }
    return (payload?.data ?? payload) as T;
  }

  /* ------------------------------ sessao ------------------------------- */

  status() {
    return this.call<{ Connected?: boolean; LoggedIn?: boolean; jid?: string }>('/session/status');
  }

  connect(events: string[]) {
    return this.call('/session/connect', {
      method: 'POST',
      json: { Subscribe: events, Immediate: true },
    });
  }

  qr() {
    return this.call<{ QRCode?: string }>('/session/qr');
  }

  /* ------------------------------ webhook ------------------------------ */

  getWebhook() {
    return this.call<{ webhook?: string; subscribe?: string[] }>('/webhook');
  }

  setWebhook(webhook: string, events: string[]) {
    return this.call('/webhook', { method: 'POST', json: { webhook, events } });
  }

  /* ------------------------------- envio ------------------------------- */

  sendText(input: { Phone: string; Body: string; Id?: string; LinkPreview?: boolean }) {
    return this.call<{ Id?: string; Timestamp?: string }>('/chat/send/text', {
      method: 'POST',
      json: { LinkPreview: true, ...input },
    });
  }

  sendImage(input: { Phone: string; Image: string; Caption?: string; Id?: string }) {
    return this.call<{ Id?: string }>('/chat/send/image', { method: 'POST', json: input });
  }

  sendVideo(input: { Phone: string; Video: string; Caption?: string; Id?: string }) {
    return this.call<{ Id?: string }>('/chat/send/video', { method: 'POST', json: input });
  }

  sendAudio(input: {
    Phone: string;
    Audio: string;
    Id?: string;
    PTT?: boolean;
    MimeType?: string;
  }) {
    return this.call<{ Id?: string }>('/chat/send/audio', { method: 'POST', json: input });
  }

  sendDocument(input: { Phone: string; Document: string; FileName: string; Id?: string }) {
    return this.call<{ Id?: string }>('/chat/send/document', { method: 'POST', json: input });
  }

  markRead(input: { Id: string[]; Chat: string; Sender?: string }) {
    return this.call('/chat/markread', { method: 'POST', json: input });
  }

  /* ------------------------------ download ----------------------------- */

  /**
   * Baixa e descriptografa a midia. O WuzAPI devolve `Data` como data-URI
   * (`data:image/jpeg;base64,...`) ou como base64 puro, dependendo da versao.
   */
  async downloadMedia(kind: WuzMediaKind, ref: WuzMediaRef): Promise<{ base64: string; mimetype: string }> {
    const raw = await this.call<Record<string, unknown>>(DOWNLOAD_PATH[kind], {
      method: 'POST',
      json: ref,
    });

    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const found = Object.entries(raw ?? {}).find(
          ([rk]) => rk.toLowerCase() === k.toLowerCase(),
        );
        if (found && typeof found[1] === 'string' && found[1]) return found[1];
      }
      return undefined;
    };

    const data = pick('Data', 'data', 'base64', 'Base64');
    if (!data) {
      throw new Error(`WuzAPI nao retornou conteudo em ${DOWNLOAD_PATH[kind]}`);
    }

    const mimetype = pick('Mimetype', 'MimeType', 'mimetype') ?? ref.Mimetype ?? 'application/octet-stream';
    const base64 = data.startsWith('data:') ? (data.split(',', 2)[1] ?? '') : data;

    return { base64, mimetype };
  }

  /* ------------------------------ contatos ----------------------------- */

  async avatarUrl(phone: string): Promise<string | null> {
    try {
      const res = await this.call<{ URL?: string; url?: string }>('/user/avatar', {
        method: 'POST',
        json: { Phone: phone, Preview: true },
      });
      return res?.URL ?? res?.url ?? null;
    } catch {
      // Contato sem foto ou com privacidade restrita — nao e erro fatal.
      return null;
    }
  }

  async groupName(groupJid: string): Promise<string | null> {
    try {
      const res = await this.call<{ Name?: string; name?: string }>('/group/info', {
        qs: { groupJID: groupJid },
      });
      return res?.Name ?? res?.name ?? null;
    } catch {
      return null;
    }
  }
}
