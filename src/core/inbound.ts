import { config } from '../config';
import { logger, type Logger } from '../logger';
import { ChatwootClient, type OutgoingAttachment } from '../clients/chatwoot';
import { WuzapiClient } from '../clients/wuzapi';
import { attachChatwootMessageId, claimMessage, type Tenant } from '../db/repo';
import { isBroadcastJid, isNewsletterJid, jidToE164 } from './jid';
import { filenameForInbound } from './media';
import { normalizeWuzapiEvent, type NormalizedEvent } from './normalize';
import { resolveContact, resolveConversation } from './resolve';

export interface InboundResult {
  status: 'created' | 'skipped';
  reason?: string;
  chatwootMessageId?: number;
  conversationId?: number;
}

const skip = (reason: string): InboundResult => ({ status: 'skipped', reason });

/** WhatsApp -> Chatwoot. Idempotente por (tenant, wa_message_id). */
export async function handleInboundEvent(tenant: Tenant, body: unknown): Promise<InboundResult> {
  const event = normalizeWuzapiEvent(body);
  if (!event) return skip('payload nao reconhecido');

  const log = logger.child({ tenant: tenant.slug, waId: event.waMessageId, type: event.type });

  if (event.type !== 'Message') return skip(`evento ${event.type} nao tratado`);
  if (!event.waMessageId) return skip('evento sem ID de mensagem');
  if (!event.chatJid) return skip('evento sem JID de chat');
  if (isBroadcastJid(event.chatJid)) return skip('status/broadcast ignorado');
  if (isNewsletterJid(event.chatJid)) return skip('newsletter ignorada');
  if (event.reaction) return skip('reacao ignorada');
  if (event.isGroup && !tenant.handle_groups) return skip('grupos desabilitados neste tenant');
  if (event.isFromMe && !tenant.mirror_own_messages) return skip('espelhamento de saida desligado');

  const direction = event.isFromMe ? 'out' : 'in';

  // Trava de idempotencia: bloqueia reentrega do webhook e o eco das mensagens
  // que o proprio HUB enviou (o WuzAPI devolve o mesmo Id com IsFromMe=true).
  const claimed = await claimMessage(tenant.id, event.waMessageId, direction);
  if (!claimed) return skip('mensagem ja processada');

  const cw = new ChatwootClient(tenant);
  const wuz = new WuzapiClient(tenant);

  // Em grupo o "contato" do Chatwoot e o proprio grupo; o autor real vai no
  // prefixo do conteudo e em content_attributes.
  const contactJid = event.chatJid;
  const displayName = event.isGroup ? null : event.pushName;

  const contact = await resolveContact(tenant, cw, wuz, contactJid, displayName);
  const conversationId = await resolveConversation(tenant, cw, contactJid, contact);

  const attachments = await buildAttachments(wuz, event, log);
  const mediaFailed = Boolean(event.media) && attachments.length === 0;
  const content = buildContent(tenant, event, attachments.length > 0, mediaFailed);

  if (!content && attachments.length === 0) {
    return skip('mensagem sem conteudo suportado');
  }

  const message = await cw.createMessage(conversationId, {
    content: content ?? '',
    message_type: event.isFromMe ? 'outgoing' : 'incoming',
    private: false,
    source_id: event.waMessageId,
    content_attributes: {
      wa_message_id: event.waMessageId,
      wa_chat_jid: event.chatJid,
      wa_sender_jid: event.senderJid,
      ...(event.isGroup
        ? { wa_group: true, wa_sender_name: event.pushName, wa_sender_phone: jidToE164(event.senderJid) }
        : {}),
      ...(event.quotedWaMessageId ? { wa_quoted_message_id: event.quotedWaMessageId } : {}),
    },
    attachments,
  });

  await attachChatwootMessageId(tenant.id, event.waMessageId, message.id);

  log.info(
    { conversationId, chatwootMessageId: message.id, attachments: attachments.length },
    'mensagem replicada no Chatwoot',
  );

  return { status: 'created', chatwootMessageId: message.id, conversationId };
}

/**
 * Em grupo, o Chatwoot ve um unico "contato" (o grupo). Sem o prefixo, o
 * agente nao sabe qual participante escreveu.
 */
function buildContent(
  tenant: Tenant,
  event: NormalizedEvent,
  hasAttachment: boolean,
  mediaFailed: boolean,
): string | null {
  let text = event.text?.trim() ?? '';

  if (mediaFailed) {
    const label = `_[${event.media?.kind ?? 'midia'} recebida no WhatsApp — download indisponivel]_`;
    text = text ? `${text}\n\n${label}` : label;
  }

  if (!text && !hasAttachment) return null;

  if (event.isGroup && tenant.group_sender_prefix && !event.isFromMe) {
    const who = event.pushName?.trim() || jidToE164(event.senderJid) || 'Participante';
    return text ? `*${who}*:\n${text}` : `*${who}*:`;
  }

  return text || null;
}

async function buildAttachments(
  wuz: WuzapiClient,
  event: NormalizedEvent,
  log: Logger,
): Promise<OutgoingAttachment[]> {
  const media = event.media;
  if (!media) return [];

  try {
    let base64 = media.inlineBase64;
    let mimetype = media.mimetype;

    if (!base64) {
      const downloaded = await wuz.downloadMedia(media.kind, media.ref);
      base64 = downloaded.base64;
      mimetype = downloaded.mimetype || mimetype;
    }

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.byteLength) throw new Error('midia vazia apos decodificar');
    if (buffer.byteLength > config.MAX_MEDIA_BYTES) {
      log.warn({ bytes: buffer.byteLength }, 'midia acima do limite; enviando so o texto');
      return [];
    }

    return [
      {
        filename: filenameForInbound({ ...media, mimetype }, event.waMessageId),
        contentType: mimetype,
        buffer,
      },
    ];
  } catch (err) {
    // Falha de midia nao pode derrubar a mensagem: o texto ainda tem valor.
    log.error({ err, kind: media.kind }, 'falha ao baixar midia do WhatsApp');
    return [];
  }
}

export { normalizeWuzapiEvent };
