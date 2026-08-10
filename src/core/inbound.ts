import { config } from '../config';
import { logger, type Logger } from '../logger';
import { ChatwootClient, type OutgoingAttachment } from '../clients/chatwoot';
import { WuzapiClient } from '../clients/wuzapi';
import {
  attachChatwootMessageId,
  claimMessage,
  dropContactLink,
  dropConversationLink,
  findChatwootMessageIdByWaId,
  findPhoneForLid,
  rekeyContactLink,
  upsertLidLink,
  type Tenant,
} from '../db/repo';
import { HttpError } from '../clients/http';
import { isBroadcastJid, isLidJid, isNewsletterJid, jidToE164, normalizeJid } from './jid';
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

/**
 * Resolve o endereçamento por LID.
 *
 * Quando o evento traz LID e telefone juntos, guarda o par. Quando traz so o
 * LID, consulta o que ja foi aprendido — e, se o contato ja existia sob a
 * identidade LID, migra o vinculo para a de telefone, evitando o mesmo
 * contato duplicado no Chatwoot.
 *
 * Se o par nunca foi visto, segue com o LID: o WhatsApp simplesmente nao
 * revelou o numero, e nao ha de onde inventa-lo.
 */
async function resolverLid(
  tenant: Tenant,
  event: NormalizedEvent,
  log: Logger,
): Promise<string> {
  if (event.isGroup) return event.chatJid;

  // Caso 1: os dois vieram juntos — aprende.
  if (event.chatLid && !isLidJid(event.chatJid)) {
    await upsertLidLink(tenant.id, event.chatLid, event.chatJid);
    return event.chatJid;
  }
  if (event.senderLid && !isLidJid(event.senderJid)) {
    await upsertLidLink(tenant.id, event.senderLid, event.senderJid);
  }

  // Caso 2: veio so o LID — usa o que ja foi aprendido.
  if (isLidJid(event.chatJid)) {
    const telefone = await findPhoneForLid(tenant.id, event.chatJid);
    if (telefone) {
      const migrou = await rekeyContactLink(tenant.id, event.chatJid, telefone);
      log.info(
        { lid: event.chatJid, telefone, migrou },
        'LID resolvido para telefone a partir do historico',
      );
      return telefone;
    }
  }

  return event.chatJid;
}

/**
 * Um 404/422 do Chatwoot ao usar um ID em cache quase sempre significa que o
 * registro foi apagado de la — apagar conversas e contatos e operacao comum
 * na interface, e o HUB nao e avisado.
 */
function vinculoPodeEstarObsoleto(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || err.status === 422 || err.status === 400);
}

/**
 * Lista vazia = todos os grupos. Com itens = so os JIDs listados.
 *
 * A conta pode participar de dezenas de grupos que nao sao atendimento;
 * sem o filtro, cada um deles viraria contato e conversa no Chatwoot.
 */
export function grupoPermitido(
  tenant: Pick<Tenant, 'group_allowlist'>,
  chatJid: string,
): boolean {
  const lista = tenant.group_allowlist ?? [];
  if (lista.length === 0) return true;
  return lista.some((permitido) => normalizeJid(permitido) === chatJid);
}

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
  if (event.isGroup && !grupoPermitido(tenant, event.chatJid)) {
    return skip(`grupo ${event.chatJid} fora da lista de permissao`);
  }
  if (event.isFromMe && !tenant.mirror_own_messages) return skip('espelhamento de saida desligado');

  const direction = event.isFromMe ? 'out' : 'in';

  // Trava de idempotencia: bloqueia reentrega do webhook e o eco das mensagens
  // que o proprio HUB enviou (o WuzAPI devolve o mesmo Id com IsFromMe=true).
  // O JID do autor fica guardado: e o que permite citar esta mensagem depois
  // (o WhatsApp exige ContextInfo.Participant para desenhar a citacao).
  const claimed = await claimMessage(tenant.id, event.waMessageId, direction, event.senderJid);
  if (!claimed) return skip('mensagem ja processada');

  const cw = new ChatwootClient(tenant);
  const wuz = new WuzapiClient(tenant);

  // Aprende o par LID <-> telefone sempre que o WhatsApp entrega os dois, e
  // usa o que ja aprendeu quando o evento vem so com o LID.
  const chatJidResolvido = await resolverLid(tenant, event, log);

  // O conteudo e resolvido ANTES de tocar no Chatwoot. Eventos sem nada a
  // exibir — mensagem de protocolo, enquete, chamada — criariam contato e
  // conversa vazios se a ordem fosse inversa.
  const attachments = await buildAttachments(wuz, event, log);
  const mediaFailed = Boolean(event.media) && attachments.length === 0;
  const content = buildContent(tenant, event, attachments.length > 0, mediaFailed);

  if (!content && attachments.length === 0) {
    return skip('mensagem sem conteudo suportado');
  }

  // Em grupo o "contato" do Chatwoot e o proprio grupo; o autor real vai no
  // prefixo do conteudo e em content_attributes.
  const contactJid = chatJidResolvido;
  // Em mensagem enviada por nos, `PushName` e o nome do DONO da conta, nao o
  // do destinatario. Usa-lo aqui batizaria o contato com o nome errado.
  const displayName = event.isGroup || event.isFromMe ? null : event.pushName;

  // Contato e conversa podem ter sido apagados no Chatwoot depois que o
  // vinculo foi gravado aqui. Nesse caso o ID em cache aponta para nada e o
  // Chatwoot recusa a operacao. Uma segunda tentativa com o cache limpo
  // reconstroi tudo, em vez de a mensagem sumir.
  let contact: Awaited<ReturnType<typeof resolveContact>>;
  let conversationId: number;
  try {
    contact = await resolveContact(tenant, cw, wuz, contactJid, displayName);
    conversationId = await resolveConversation(tenant, cw, contactJid, contact);
  } catch (err) {
    if (!vinculoPodeEstarObsoleto(err)) throw err;

    log.warn({ err, waJid: contactJid }, 'vinculo obsoleto; limpando cache e refazendo');
    await dropContactLink(tenant.id, contactJid);
    await dropConversationLink(tenant.id, contactJid);

    contact = await resolveContact(tenant, cw, wuz, contactJid, displayName);
    conversationId = await resolveConversation(tenant, cw, contactJid, contact);
  }

  // Se a mensagem cita outra que ja replicamos, encadeia no Chatwoot para o
  // agente ver a resposta no contexto certo.
  const citadaNoChatwoot = event.quotedWaMessageId
    ? await findChatwootMessageIdByWaId(tenant.id, event.quotedWaMessageId)
    : null;

  const message = await cw.createMessage(conversationId, {
    content: content ?? '',
    message_type: event.isFromMe ? 'outgoing' : 'incoming',
    private: false,
    source_id: event.waMessageId,
    content_attributes: {
      ...(citadaNoChatwoot ? { in_reply_to: citadaNoChatwoot } : {}),
      ...(event.quotedWaMessageId ? { in_reply_to_external_id: event.quotedWaMessageId } : {}),
      wa_message_id: event.waMessageId,
      wa_chat_jid: event.chatJid,
      wa_sender_jid: event.senderJid,
      ...(event.senderLid ? { wa_sender_lid: event.senderLid } : {}),
      ...(event.chatLid ? { wa_chat_lid: event.chatLid } : {}),
      ...(event.isGroup
        ? { wa_group: true, wa_sender_name: event.pushName, wa_sender_phone: jidToE164(event.senderJid) }
        : {}),
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
