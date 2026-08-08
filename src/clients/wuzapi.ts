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

  async getWebhook(): Promise<{ webhook: string; events: string[] }> {
    const raw = await this.call<Record<string, unknown>>('/webhook');
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = raw?.[k];
        if (typeof v === 'string' && v) return v;
      }
      return '';
    };
    const events = raw?.['subscribe'] ?? raw?.['Events'] ?? raw?.['events'];
    return {
      webhook: pick('webhook', 'webhookurl', 'WebhookURL'),
      events: Array.isArray(events) ? (events as string[]) : [],
    };
  }

  /**
   * Verificado contra uma instancia real: o campo aceito e `webhookurl`, e nao
   * `webhook` como consta no OpenAPI. Com a chave errada a API responde
   * HTTP 200 / success:true e grava string vazia — falha silenciosa. Mandamos
   * as duas chaves para funcionar em qualquer uma das duas convencoes.
   */
  async setWebhook(webhook: string, events: string[]) {
    const result = await this.call('/webhook', {
      method: 'POST',
      json: { webhookurl: webhook, webhook, events },
    });

    // Confirma a gravacao: sem isto um 200 vazio passaria por sucesso.
    const applied = await this.getWebhook();
    if (applied.webhook !== webhook) {
      throw new Error(
        `WuzAPI aceitou o request mas nao gravou o webhook. ` +
          `Esperado "${webhook}", gravado "${applied.webhook}".`,
      );
    }
    return result;
  }

  /** Remove o webhook para o WuzAPI parar de enviar eventos ao HUB. */
  deleteWebhook() {
    return this.call('/webhook', { method: 'DELETE' });
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

  /** Grupos dos quais a conta participa, para montar a lista de permissao. */
  async listGroups(): Promise<Array<{ jid: string; nome: string; participantes: number }>> {
    const raw = await this.call<Record<string, unknown>>('/group/list');
    const lista = (raw?.['Groups'] ?? raw?.['groups'] ?? raw) as unknown;
    if (!Array.isArray(lista)) return [];

    return lista.map((g) => {
      const item = (g ?? {}) as Record<string, unknown>;
      const participantes = item['Participants'] ?? item['participants'];
      return {
        jid: String(item['JID'] ?? item['jid'] ?? ''),
        nome: String(item['Name'] ?? item['name'] ?? '(sem nome)'),
        participantes: Array.isArray(participantes) ? participantes.length : 0,
      };
    }).filter((g) => g.jid);
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
