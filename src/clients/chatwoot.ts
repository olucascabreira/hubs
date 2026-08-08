import { request, fetchBinary, HttpError } from './http';
import type { Tenant } from '../db/repo';

export interface CwContact {
  id: number;
  name?: string;
  phone_number?: string | null;
  identifier?: string | null;
  contact_inboxes?: Array<{ source_id: string; inbox?: { id: number } }>;
}

export interface CwConversation {
  id: number;
  inbox_id?: number;
  status?: string;
  contact_inbox?: { source_id?: string };
  meta?: { sender?: CwContact };
}

export interface CwMessage {
  id: number;
  content?: string | null;
  message_type?: number | string;
  private?: boolean;
}

export interface CwInbox {
  id: number;
  name?: string;
  channel_type?: string;
  inbox_identifier?: string;
  webhook_url?: string;
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

export class ChatwootClient {
  private readonly baseUrl: string;
  private readonly accountId: number;
  private readonly token: string;

  constructor(tenant: Pick<Tenant, 'chatwoot_base_url' | 'chatwoot_account_id' | 'chatwoot_api_token'>) {
    this.baseUrl = tenant.chatwoot_base_url.replace(/\/+$/, '');
    this.accountId = tenant.chatwoot_account_id;
    this.token = tenant.chatwoot_api_token;
  }

  private acc(path: string): string {
    return `${this.baseUrl}/api/v1/accounts/${this.accountId}${path}`;
  }

  private get headers(): Record<string, string> {
    return { api_access_token: this.token };
  }

  /* ------------------------------- inboxes ------------------------------ */

  async createApiInbox(name: string, webhookUrl: string): Promise<CwInbox> {
    const res = await request<CwInbox>(this.acc('/inboxes'), {
      method: 'POST',
      headers: this.headers,
      json: { name, channel: { type: 'api', webhook_url: webhookUrl } },
    });
    return res.data;
  }

  async getInbox(inboxId: number): Promise<CwInbox | null> {
    const res = await request<CwInbox>(this.acc(`/inboxes/${inboxId}`), {
      headers: this.headers,
      tolerate: [404],
    });
    return res.status === 404 ? null : res.data;
  }

  async updateInboxWebhook(inboxId: number, webhookUrl: string): Promise<CwInbox> {
    const res = await request<CwInbox>(this.acc(`/inboxes/${inboxId}`), {
      method: 'PATCH',
      headers: this.headers,
      json: { channel: { webhook_url: webhookUrl } },
    });
    return res.data;
  }

  /* ------------------------------ contatos ------------------------------ */

  private async findContactByAttribute(
    attributeKey: 'identifier' | 'phone_number',
    value: string,
  ): Promise<CwContact | null> {
    const res = await request<{ payload?: CwContact[] }>(this.acc('/contacts/filter'), {
      method: 'POST',
      headers: this.headers,
      json: {
        payload: [
          {
            attribute_key: attributeKey,
            filter_operator: 'equal_to',
            values: [value],
            query_operator: null,
          },
        ],
      },
    });
    return res.data?.payload?.[0] ?? null;
  }

  findContactByIdentifier(identifier: string): Promise<CwContact | null> {
    return this.findContactByAttribute('identifier', identifier);
  }

  findContactByPhone(phoneE164: string): Promise<CwContact | null> {
    return this.findContactByAttribute('phone_number', phoneE164);
  }

  async createContact(input: {
    inbox_id: number;
    name: string;
    identifier: string;
    phone_number?: string;
    avatar_url?: string;
    additional_attributes?: Record<string, unknown>;
  }): Promise<CwContact> {
    try {
      const res = await request<{ payload?: { contact?: CwContact } } & { id?: number }>(
        this.acc('/contacts'),
        { method: 'POST', headers: this.headers, json: input },
      );
      const contact = res.data?.payload?.contact ?? (res.data as unknown as CwContact);
      if (contact?.id) return contact;
      throw new Error(`Resposta inesperada ao criar contato: ${JSON.stringify(res.data)}`);
    } catch (err) {
      if (!(err instanceof HttpError) || (err.status !== 422 && err.status !== 400)) throw err;

      // Corrida entre dois workers para o mesmo contato.
      const sameIdentifier = await this.findContactByIdentifier(input.identifier);
      if (sameIdentifier) return sameIdentifier;

      // O Chatwoot exige telefone unico por conta. Se o numero ja pertence a
      // um contato — tipicamente criado por outra integracao de WhatsApp na
      // mesma conta — reaproveitamos aquele contato. Um contato pode servir
      // varios inboxes, entao isso e a modelagem correta e nao um remendo.
      //
      // Nao gravamos `identifier` no contato existente: seria escrita em dado
      // que nao e nosso. O vinculo fica em contact_links, e este caminho por
      // telefone reconstroi o mapeamento se o banco do HUB for perdido.
      if (input.phone_number) {
        const samePhone = await this.findContactByPhone(input.phone_number);
        if (samePhone) return samePhone;

        // Numero ocupado mas nao localizavel: segue sem telefone para nao
        // travar a mensagem. Gera um contato a mais, e o mal menor.
        const { phone_number: _ocupado, ...semTelefone } = input;
        return this.createContact(semTelefone);
      }

      throw err;
    }
  }

  async updateContact(contactId: number, patch: Record<string, unknown>): Promise<void> {
    await request(this.acc(`/contacts/${contactId}`), {
      method: 'PUT',
      headers: this.headers,
      json: patch,
      tolerate: [422],
    });
  }

  async getContact(contactId: number): Promise<CwContact | null> {
    const res = await request<{ payload?: CwContact }>(this.acc(`/contacts/${contactId}`), {
      headers: this.headers,
      tolerate: [404],
    });
    if (res.status === 404) return null;
    return res.data?.payload ?? (res.data as unknown as CwContact);
  }

  /**
   * Garante um contact_inbox com o source_id deterministico (o JID do WhatsApp).
   * E o que permite reencontrar a conversa e responder pelo canal certo.
   */
  async ensureContactInbox(
    contactId: number,
    inboxId: number,
    sourceId: string,
  ): Promise<string> {
    const contact = await this.getContact(contactId);
    const existing = contact?.contact_inboxes?.find(
      (ci) => ci.inbox?.id === inboxId && ci.source_id === sourceId,
    );
    if (existing) return existing.source_id;

    const res = await request<{ payload?: { source_id?: string }; source_id?: string }>(
      this.acc(`/contacts/${contactId}/contact_inboxes`),
      {
        method: 'POST',
        headers: this.headers,
        json: { inbox_id: inboxId, source_id: sourceId },
        tolerate: [422],
      },
    );

    if (res.status === 422) {
      const refreshed = await this.getContact(contactId);
      const found = refreshed?.contact_inboxes?.find((ci) => ci.inbox?.id === inboxId);
      if (found) return found.source_id;
      throw new Error(`Nao foi possivel garantir contact_inbox para contato ${contactId}`);
    }

    return res.data?.payload?.source_id ?? res.data?.source_id ?? sourceId;
  }

  /* ----------------------------- conversas ------------------------------ */

  async createConversation(input: {
    source_id: string;
    inbox_id: number;
    contact_id: number;
    additional_attributes?: Record<string, unknown>;
    custom_attributes?: Record<string, unknown>;
  }): Promise<CwConversation> {
    const res = await request<CwConversation>(this.acc('/conversations'), {
      method: 'POST',
      headers: this.headers,
      json: { status: 'open', ...input },
    });
    return res.data;
  }

  async getConversation(conversationId: number): Promise<CwConversation | null> {
    const res = await request<CwConversation>(this.acc(`/conversations/${conversationId}`), {
      headers: this.headers,
      tolerate: [404],
    });
    return res.status === 404 ? null : res.data;
  }

  async listContactConversations(contactId: number): Promise<CwConversation[]> {
    const res = await request<{ payload?: CwConversation[] } | CwConversation[]>(
      this.acc(`/contacts/${contactId}/conversations`),
      { headers: this.headers, tolerate: [404] },
    );
    if (res.status === 404) return [];
    const data = res.data;
    if (Array.isArray(data)) return data;
    return data?.payload ?? [];
  }

  async toggleStatus(conversationId: number, status: 'open' | 'resolved' | 'pending'): Promise<void> {
    await request(this.acc(`/conversations/${conversationId}/toggle_status`), {
      method: 'POST',
      headers: this.headers,
      json: { status },
      tolerate: [404],
    });
  }

  /* ----------------------------- mensagens ------------------------------ */

  async createMessage(
    conversationId: number,
    input: {
      content?: string;
      message_type: 'incoming' | 'outgoing';
      private?: boolean;
      content_attributes?: Record<string, unknown>;
      source_id?: string;
      attachments?: OutgoingAttachment[];
    },
  ): Promise<CwMessage> {
    const url = this.acc(`/conversations/${conversationId}/messages`);

    if (!input.attachments?.length) {
      const res = await request<CwMessage>(url, {
        method: 'POST',
        headers: this.headers,
        json: {
          content: input.content ?? '',
          message_type: input.message_type,
          private: input.private ?? false,
          content_attributes: input.content_attributes,
          source_id: input.source_id,
        },
      });
      return res.data;
    }

    const form = new FormData();
    form.append('content', input.content ?? '');
    form.append('message_type', input.message_type);
    form.append('private', String(input.private ?? false));
    if (input.source_id) form.append('source_id', input.source_id);
    if (input.content_attributes) {
      form.append('content_attributes', JSON.stringify(input.content_attributes));
    }
    for (const att of input.attachments) {
      form.append(
        'attachments[]',
        new Blob([new Uint8Array(att.buffer)], { type: att.contentType }),
        att.filename,
      );
    }

    const res = await request<CwMessage>(url, {
      method: 'POST',
      headers: this.headers,
      body: form,
      timeoutMs: 120_000,
    });
    return res.data;
  }

  /* ------------------------------- anexos ------------------------------- */

  /** Baixa um anexo do Chatwoot (data_url pode vir relativo). */
  async downloadAttachment(dataUrl: string, maxBytes: number) {
    const absolute = dataUrl.startsWith('http')
      ? dataUrl
      : `${this.baseUrl}/${dataUrl.replace(/^\/+/, '')}`;

    const sameHost = absolute.startsWith(this.baseUrl);
    return fetchBinary(absolute, {
      headers: sameHost ? this.headers : undefined,
      maxBytes,
    });
  }
}
