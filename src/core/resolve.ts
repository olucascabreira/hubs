import { config } from '../config';
import { logger } from '../logger';
import type { ChatwootClient } from '../clients/chatwoot';
import type { WuzapiClient } from '../clients/wuzapi';
import {
  getContactLink,
  upsertContactLink,
  getConversationLink,
  upsertConversationLink,
  dropConversationLink,
  type Tenant,
} from '../db/repo';
import { isGroupJid, jidToE164, jidToPhone } from './jid';

export function identifierFor(waJid: string): string {
  return `${config.CONTACT_IDENTIFIER_PREFIX}${waJid}`;
}

/**
 * Marca o contato como grupo no proprio nome. Sem isso, na lista de conversas
 * do Chatwoot um grupo e indistinguivel de uma pessoa.
 */
export function comSufixoDeGrupo(assunto: string): string {
  const sufixo = config.GROUP_NAME_SUFFIX;
  const limpo = assunto.trim();
  if (!sufixo) return limpo;
  // Evita "Vendas (Grupo) (Grupo)" quando o assunto ja veio marcado.
  return limpo.endsWith(sufixo.trim()) ? limpo : `${limpo}${sufixo}`;
}

export interface ResolvedContact {
  contactId: number;
  sourceId: string;
}

/**
 * Encontra (ou cria) o contato do Chatwoot correspondente ao JID, garantindo
 * um contact_inbox cujo source_id e o proprio JID. O source_id deterministico
 * e o que permite o caminho de volta Chatwoot -> WhatsApp.
 */
export async function resolveContact(
  tenant: Tenant,
  cw: ChatwootClient,
  wuz: WuzapiClient,
  waJid: string,
  displayName: string | null,
): Promise<ResolvedContact> {
  const inboxId = tenant.chatwoot_inbox_id;
  if (!inboxId) {
    throw new Error(`Tenant ${tenant.slug} nao tem chatwoot_inbox_id. Rode o provisionamento.`);
  }

  const isGroup = isGroupJid(waJid);
  const cached = await getContactLink(tenant.id, waJid);

  if (cached) {
    // Grupo cadastrado antes do sufixo existir: corrige uma vez, sem
    // consultar o WhatsApp de novo.
    const nomeCorrigido =
      isGroup && cached.display_name ? comSufixoDeGrupo(cached.display_name) : null;

    // Nome do WhatsApp pode ter mudado depois do primeiro contato.
    const novoNome = displayName?.trim() || nomeCorrigido;

    if (novoNome && novoNome !== cached.display_name) {
      await cw.updateContact(cached.chatwoot_contact_id, { name: novoNome });
      await upsertContactLink({ ...cached, display_name: novoNome });
    }
    return { contactId: cached.chatwoot_contact_id, sourceId: cached.source_id };
  }

  const identifier = identifierFor(waJid);

  let name: string;
  if (isGroup) {
    const assunto =
      displayName?.trim() || (await wuz.groupName(waJid)) || `Grupo ${waJid.split('@')[0]}`;
    name = comSufixoDeGrupo(assunto);
  } else {
    name = displayName?.trim() || jidToE164(waJid) || waJid;
  }

  const phone = isGroup ? undefined : (jidToE164(waJid) ?? undefined);

  let contact = await cw.findContactByIdentifier(identifier);

  // Contas que ja tinham WhatsApp por outro caminho costumam ter contatos com
  // `identifier` vazio. Procurar pelo telefone antes de criar evita tanto o
  // 422 de telefone duplicado quanto um contato repetido para a mesma pessoa.
  if (!contact && phone) {
    contact = await cw.findContactByPhone(phone);
    if (contact) {
      logger.info(
        { tenant: tenant.slug, contactId: contact.id, waJid },
        'contato existente reaproveitado pelo telefone',
      );
    }
  }

  if (!contact) {
    const avatarUrl = isGroup ? null : await wuz.avatarUrl(jidToPhone(waJid) ?? waJid);

    contact = await cw.createContact({
      inbox_id: inboxId,
      name,
      identifier,
      ...(phone ? { phone_number: phone } : {}),
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      additional_attributes: {
        wa_jid: waJid,
        wa_is_group: isGroup,
        source: 'wuzapi-chatwoot-hub',
      },
    });
  }

  const sourceId = await cw.ensureContactInbox(contact.id, inboxId, waJid);

  await upsertContactLink({
    tenant_id: tenant.id,
    wa_jid: waJid,
    chatwoot_contact_id: contact.id,
    source_id: sourceId,
    display_name: name,
  });

  return { contactId: contact.id, sourceId };
}

/**
 * Encontra (ou cria) a conversa do Chatwoot para o chat do WhatsApp.
 * Um chat = uma conversa; se a anterior foi resolvida, ela e reaberta em vez
 * de gerar uma thread nova a cada mensagem.
 */
export async function resolveConversation(
  tenant: Tenant,
  cw: ChatwootClient,
  waJid: string,
  contact: ResolvedContact,
): Promise<number> {
  const inboxId = tenant.chatwoot_inbox_id!;

  const cached = await getConversationLink(tenant.id, waJid);
  if (cached) {
    const conversation = await cw.getConversation(cached.chatwoot_conversation_id);
    if (conversation) {
      if (tenant.reopen_resolved && conversation.status === 'resolved') {
        await cw.toggleStatus(conversation.id, 'open');
      }
      return conversation.id;
    }
    // Conversa apagada no Chatwoot: descarta o vinculo e recria.
    await dropConversationLink(tenant.id, waJid);
  }

  // Pode existir uma conversa criada fora do HUB (import, outro bridge...).
  const existing = (await cw.listContactConversations(contact.contactId)).find(
    (c) => c.inbox_id === inboxId && c.contact_inbox?.source_id === contact.sourceId,
  );

  const conversationId =
    existing?.id ??
    (
      await cw.createConversation({
        source_id: contact.sourceId,
        inbox_id: inboxId,
        contact_id: contact.contactId,
        additional_attributes: { wa_jid: waJid },
      })
    ).id;

  if (existing && tenant.reopen_resolved && existing.status === 'resolved') {
    await cw.toggleStatus(existing.id, 'open');
  }

  await upsertConversationLink({
    tenant_id: tenant.id,
    wa_jid: waJid,
    chatwoot_conversation_id: conversationId,
    chatwoot_contact_id: contact.contactId,
  });

  return conversationId;
}
