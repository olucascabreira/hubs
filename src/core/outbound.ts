import { createHash } from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';
import { ChatwootClient } from '../clients/chatwoot';
import { WuzapiClient } from '../clients/wuzapi';
import {
  attachChatwootMessageId,
  claimMessage,
  findWaMessageIdByChatwootId,
  getConversationLinkByChatwootId,
  type Tenant,
} from '../db/repo';
import { normalizeJid, jidToWuzapiTarget } from './jid';
import { guessFilename, outboundKindFor, toDataUri, audioSendMode } from './media';

export interface OutboundResult {
  status: 'sent' | 'skipped';
  reason?: string;
  waMessageIds?: string[];
}

const skip = (reason: string): OutboundResult => ({ status: 'skipped', reason });

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

interface CwAttachment {
  file_type?: string;
  data_url?: string;
  extension?: string | null;
}

/**
 * IDs deterministicos: um reprocessamento do mesmo job reutiliza o mesmo
 * stanza ID, entao a mensagem nunca sai duas vezes no WhatsApp.
 */
export function deterministicWaId(tenantId: string, chatwootMessageId: number, index = 0): string {
  const digest = createHash('sha1')
    .update(`${tenantId}:${chatwootMessageId}:${index}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `3EB0${digest}`;
}

export function extractChatwootMessage(body: unknown): Dict | null {
  if (!isDict(body)) return null;
  const nested = body['message'];
  if (isDict(nested) && nested['id'] !== undefined) return { ...nested, ...pickTopLevel(body) };
  return body;
}

function pickTopLevel(body: Dict): Dict {
  const out: Dict = {};
  for (const k of ['event', 'conversation', 'account', 'inbox', 'attachments', 'sender']) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

function isOutgoing(message: Dict): boolean {
  const t = message['message_type'];
  return t === 'outgoing' || t === 1;
}

/** Descobre o JID de destino a partir do payload ou do vinculo salvo. */
async function resolveTargetJid(tenant: Tenant, message: Dict): Promise<string | null> {
  const conversation = isDict(message['conversation']) ? (message['conversation'] as Dict) : {};

  const contactInbox = isDict(conversation['contact_inbox'])
    ? (conversation['contact_inbox'] as Dict)
    : {};
  const fromSource = contactInbox['source_id'];
  if (typeof fromSource === 'string' && fromSource) return normalizeJid(fromSource);

  const meta = isDict(conversation['meta']) ? (conversation['meta'] as Dict) : {};
  const sender = isDict(meta['sender']) ? (meta['sender'] as Dict) : {};

  const identifier = sender['identifier'];
  if (typeof identifier === 'string' && identifier) {
    return normalizeJid(identifier.replace(config.CONTACT_IDENTIFIER_PREFIX, ''));
  }

  const conversationId = Number(conversation['id']);
  if (Number.isFinite(conversationId)) {
    const link = await getConversationLinkByChatwootId(tenant.id, conversationId);
    if (link) return link.wa_jid;
  }

  const phone = sender['phone_number'];
  if (typeof phone === 'string' && phone) return normalizeJid(phone);

  return null;
}

/** Chatwoot -> WhatsApp. Idempotente por chatwoot_message_id. */
export async function handleOutboundEvent(tenant: Tenant, body: unknown): Promise<OutboundResult> {
  const message = extractChatwootMessage(body);
  if (!message) return skip('payload nao reconhecido');

  const eventName = String(message['event'] ?? '');
  if (eventName && eventName !== 'message_created') return skip(`evento ${eventName} ignorado`);

  const chatwootMessageId = Number(message['id']);
  if (!Number.isFinite(chatwootMessageId)) return skip('mensagem sem id');

  const log = logger.child({ tenant: tenant.slug, chatwootMessageId });

  if (!isOutgoing(message)) return skip('mensagem nao e outgoing');
  if (message['private'] === true) return skip('nota privada nao vai para o WhatsApp');

  // Mensagens espelhadas do WhatsApp chegam aqui como outgoing e carregam o
  // stanza ID original em source_id — reenviar geraria loop infinito.
  if (typeof message['source_id'] === 'string' && message['source_id']) {
    return skip('mensagem originada no WhatsApp (source_id preenchido)');
  }

  const conversation = isDict(message['conversation']) ? (message['conversation'] as Dict) : {};
  const inboxId = Number(conversation['inbox_id'] ?? (isDict(message['inbox']) ? (message['inbox'] as Dict)['id'] : NaN));
  if (tenant.chatwoot_inbox_id && Number.isFinite(inboxId) && inboxId !== tenant.chatwoot_inbox_id) {
    return skip(`inbox ${inboxId} nao pertence ao tenant ${tenant.slug}`);
  }

  const already = await findWaMessageIdByChatwootId(tenant.id, chatwootMessageId);
  if (already) return skip('mensagem ja enviada');

  const targetJid = await resolveTargetJid(tenant, message);
  if (!targetJid) return skip('nao foi possivel resolver o destino no WhatsApp');

  const phone = jidToWuzapiTarget(targetJid);
  const content = typeof message['content'] === 'string' ? message['content'].trim() : '';
  const attachments = Array.isArray(message['attachments'])
    ? (message['attachments'] as CwAttachment[])
    : [];

  if (!content && attachments.length === 0) return skip('mensagem vazia');

  const wuz = new WuzapiClient(tenant);
  const cw = new ChatwootClient(tenant);
  const sentIds: string[] = [];

  if (attachments.length === 0) {
    const waId = deterministicWaId(tenant.id, chatwootMessageId, 0);
    await claimMessage(tenant.id, waId, 'out');
    await wuz.sendText({ Phone: phone, Body: content, Id: waId });
    sentIds.push(waId);
  } else {
    for (let i = 0; i < attachments.length; i += 1) {
      const attachment = attachments[i]!;
      if (!attachment.data_url) {
        log.warn({ index: i }, 'anexo sem data_url; ignorado');
        continue;
      }

      const waId = deterministicWaId(tenant.id, chatwootMessageId, i);
      const { buffer, contentType } = await cw.downloadAttachment(
        attachment.data_url,
        config.MAX_MEDIA_BYTES,
      );

      const mimetype = contentType ?? 'application/octet-stream';
      const kind = outboundKindFor(attachment.file_type, mimetype);
      const dataUri = toDataUri(mimetype, buffer.toString('base64'));
      // A legenda acompanha apenas o primeiro anexo.
      const caption = i === 0 ? content : '';
      const nameFromUrl = decodeURIComponent(
        (attachment.data_url.split('?')[0] ?? '').split('/').pop() ?? '',
      );
      const filename = guessFilename(nameFromUrl || undefined, mimetype, `anexo-${chatwootMessageId}-${i}`);

      await claimMessage(tenant.id, waId, 'out');

      switch (kind) {
        case 'image':
          await wuz.sendImage({ Phone: phone, Image: dataUri, Caption: caption, Id: waId });
          break;
        case 'video':
          await wuz.sendVideo({ Phone: phone, Video: dataUri, Caption: caption, Id: waId });
          break;
        case 'audio': {
          // PTT so para OGG/Opus: mp3 marcado como nota de voz chega quebrado.
          const ptt = audioSendMode(mimetype) === 'ptt';
          await wuz.sendAudio({
            Phone: phone,
            Audio: dataUri,
            Id: waId,
            MimeType: mimetype,
            PTT: ptt,
          });
          if (caption) await wuz.sendText({ Phone: phone, Body: caption });
          break;
        }
        default:
          await wuz.sendDocument({ Phone: phone, Document: dataUri, FileName: filename, Id: waId });
          if (caption) await wuz.sendText({ Phone: phone, Body: caption });
          break;
      }

      sentIds.push(waId);
    }
  }

  if (sentIds.length === 0) return skip('nenhum conteudo enviavel');

  // Vincula apenas o primeiro ID: e o que o Chatwoot conhece como a mensagem.
  await attachChatwootMessageId(tenant.id, sentIds[0]!, chatwootMessageId);

  log.info({ targetJid, sent: sentIds.length }, 'mensagem entregue ao WhatsApp');
  return { status: 'sent', waMessageIds: sentIds };
}
