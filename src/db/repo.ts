import { query, queryOne } from './pool';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  active: boolean;

  wuzapi_base_url: string;
  wuzapi_token: string;
  wuzapi_webhook_secret: string | null;

  chatwoot_base_url: string;
  chatwoot_account_id: number;
  chatwoot_api_token: string;
  chatwoot_inbox_id: number | null;
  chatwoot_inbox_identifier: string | null;
  chatwoot_webhook_secret: string | null;

  handle_groups: boolean;
  mirror_own_messages: boolean;
  reopen_resolved: boolean;
  group_sender_prefix: boolean;
  /** Vazia = todos os grupos. Com itens = somente esses JIDs. */
  group_allowlist: string[];

  created_at: Date;
  updated_at: Date;
}

export interface ContactLink {
  tenant_id: string;
  wa_jid: string;
  chatwoot_contact_id: number;
  source_id: string;
  display_name: string | null;
}

export interface ConversationLink {
  tenant_id: string;
  wa_jid: string;
  chatwoot_conversation_id: number;
  chatwoot_contact_id: number;
}

/* ------------------------------- tenants -------------------------------- */

const TENANT_COLUMNS = `
  id, slug, name, active,
  wuzapi_base_url, wuzapi_token, wuzapi_webhook_secret,
  chatwoot_base_url, chatwoot_account_id, chatwoot_api_token,
  chatwoot_inbox_id, chatwoot_inbox_identifier, chatwoot_webhook_secret,
  handle_groups, mirror_own_messages, reopen_resolved, group_sender_prefix,
  group_allowlist,
  created_at, updated_at
`;

export async function listTenants(): Promise<Tenant[]> {
  return query<Tenant>(`SELECT ${TENANT_COLUMNS} FROM tenants ORDER BY created_at ASC`);
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  return queryOne<Tenant>(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE slug = $1`, [slug]);
}

export type TenantInput = {
  slug: string;
  name: string;
  wuzapi_base_url: string;
  wuzapi_token: string;
  wuzapi_webhook_secret?: string | null;
  chatwoot_base_url: string;
  chatwoot_account_id: number;
  chatwoot_api_token: string;
  chatwoot_inbox_id?: number | null;
  chatwoot_inbox_identifier?: string | null;
  chatwoot_webhook_secret?: string | null;
  handle_groups?: boolean;
  mirror_own_messages?: boolean;
  reopen_resolved?: boolean;
  group_sender_prefix?: boolean;
  group_allowlist?: string[];
};

export async function createTenant(input: TenantInput): Promise<Tenant> {
  const row = await queryOne<Tenant>(
    `INSERT INTO tenants (
       slug, name,
       wuzapi_base_url, wuzapi_token, wuzapi_webhook_secret,
       chatwoot_base_url, chatwoot_account_id, chatwoot_api_token,
       chatwoot_inbox_id, chatwoot_inbox_identifier, chatwoot_webhook_secret,
       handle_groups, mirror_own_messages, reopen_resolved, group_sender_prefix,
       group_allowlist
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               COALESCE($12,true), COALESCE($13,true), COALESCE($14,true), COALESCE($15,true),
               COALESCE($16,'{}'::text[]))
     RETURNING ${TENANT_COLUMNS}`,
    [
      input.slug,
      input.name,
      input.wuzapi_base_url,
      input.wuzapi_token,
      input.wuzapi_webhook_secret ?? null,
      input.chatwoot_base_url,
      input.chatwoot_account_id,
      input.chatwoot_api_token,
      input.chatwoot_inbox_id ?? null,
      input.chatwoot_inbox_identifier ?? null,
      input.chatwoot_webhook_secret ?? null,
      input.handle_groups ?? null,
      input.mirror_own_messages ?? null,
      input.reopen_resolved ?? null,
      input.group_sender_prefix ?? null,
      input.group_allowlist ?? null,
    ],
  );
  return row!;
}

const UPDATABLE = new Set([
  'name',
  'active',
  'wuzapi_base_url',
  'wuzapi_token',
  'wuzapi_webhook_secret',
  'chatwoot_base_url',
  'chatwoot_account_id',
  'chatwoot_api_token',
  'chatwoot_inbox_id',
  'chatwoot_inbox_identifier',
  'chatwoot_webhook_secret',
  'handle_groups',
  'mirror_own_messages',
  'reopen_resolved',
  'group_sender_prefix',
  'group_allowlist',
]);

export async function updateTenant(
  slug: string,
  patch: Record<string, unknown>,
): Promise<Tenant | null> {
  const entries = Object.entries(patch).filter(([k, v]) => UPDATABLE.has(k) && v !== undefined);
  if (!entries.length) return getTenantBySlug(slug);

  const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
  sets.push('updated_at = now()');

  return queryOne<Tenant>(
    `UPDATE tenants SET ${sets.join(', ')} WHERE slug = $1 RETURNING ${TENANT_COLUMNS}`,
    [slug, ...entries.map(([, v]) => v)],
  );
}

export async function deleteTenant(slug: string): Promise<boolean> {
  const rows = await query<{ id: string }>('DELETE FROM tenants WHERE slug = $1 RETURNING id', [
    slug,
  ]);
  return rows.length > 0;
}

/* ----------------------------- contact links ---------------------------- */

export async function getContactLink(
  tenantId: string,
  waJid: string,
): Promise<ContactLink | null> {
  return queryOne<ContactLink>(
    `SELECT tenant_id, wa_jid, chatwoot_contact_id, source_id, display_name
       FROM contact_links WHERE tenant_id = $1 AND wa_jid = $2`,
    [tenantId, waJid],
  );
}

export async function upsertContactLink(link: ContactLink): Promise<ContactLink> {
  const row = await queryOne<ContactLink>(
    `INSERT INTO contact_links (tenant_id, wa_jid, chatwoot_contact_id, source_id, display_name)
       VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, wa_jid) DO UPDATE
       SET chatwoot_contact_id = EXCLUDED.chatwoot_contact_id,
           source_id           = EXCLUDED.source_id,
           display_name        = COALESCE(EXCLUDED.display_name, contact_links.display_name),
           updated_at          = now()
     RETURNING tenant_id, wa_jid, chatwoot_contact_id, source_id, display_name`,
    [link.tenant_id, link.wa_jid, link.chatwoot_contact_id, link.source_id, link.display_name],
  );
  return row!;
}

/* ------------------------------ lid <-> telefone ------------------------- */

/** Registra o par quando o WhatsApp entrega LID e telefone no mesmo evento. */
export async function upsertLidLink(
  tenantId: string,
  waLid: string,
  waPhoneJid: string,
): Promise<void> {
  await query(
    `INSERT INTO lid_links (tenant_id, wa_lid, wa_phone_jid)
       VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, wa_lid) DO UPDATE SET wa_phone_jid = EXCLUDED.wa_phone_jid`,
    [tenantId, waLid, waPhoneJid],
  );
}

/** Telefone ja aprendido para um LID, quando o evento atual nao o traz. */
export async function findPhoneForLid(tenantId: string, waLid: string): Promise<string | null> {
  const row = await queryOne<{ wa_phone_jid: string }>(
    'SELECT wa_phone_jid FROM lid_links WHERE tenant_id = $1 AND wa_lid = $2',
    [tenantId, waLid],
  );
  return row?.wa_phone_jid ?? null;
}

/**
 * Move o vinculo de contato do LID para o JID de telefone, agora que ele e
 * conhecido. Sem isso o mesmo contato existiria duas vezes no Chatwoot: uma
 * sob a identidade LID e outra sob a de telefone.
 */
export async function rekeyContactLink(
  tenantId: string,
  deJid: string,
  paraJid: string,
): Promise<boolean> {
  const rows = await query(
    `UPDATE contact_links SET wa_jid = $3, updated_at = now()
       WHERE tenant_id = $1 AND wa_jid = $2
         AND NOT EXISTS (
           SELECT 1 FROM contact_links c2 WHERE c2.tenant_id = $1 AND c2.wa_jid = $3
         )
     RETURNING id`,
    [tenantId, deJid, paraJid],
  );
  if (rows.length) {
    await query(
      `UPDATE conversation_links SET wa_jid = $3, updated_at = now()
         WHERE tenant_id = $1 AND wa_jid = $2
           AND NOT EXISTS (
             SELECT 1 FROM conversation_links c2 WHERE c2.tenant_id = $1 AND c2.wa_jid = $3
           )`,
      [tenantId, deJid, paraJid],
    );
  }
  return rows.length > 0;
}

export async function dropContactLink(tenantId: string, waJid: string): Promise<void> {
  await query('DELETE FROM contact_links WHERE tenant_id = $1 AND wa_jid = $2', [tenantId, waJid]);
}

/* --------------------------- conversation links -------------------------- */

export async function getConversationLink(
  tenantId: string,
  waJid: string,
): Promise<ConversationLink | null> {
  return queryOne<ConversationLink>(
    `SELECT tenant_id, wa_jid, chatwoot_conversation_id, chatwoot_contact_id
       FROM conversation_links WHERE tenant_id = $1 AND wa_jid = $2`,
    [tenantId, waJid],
  );
}

export async function getConversationLinkByChatwootId(
  tenantId: string,
  chatwootConversationId: number,
): Promise<ConversationLink | null> {
  return queryOne<ConversationLink>(
    `SELECT tenant_id, wa_jid, chatwoot_conversation_id, chatwoot_contact_id
       FROM conversation_links WHERE tenant_id = $1 AND chatwoot_conversation_id = $2`,
    [tenantId, chatwootConversationId],
  );
}

export async function upsertConversationLink(link: ConversationLink): Promise<ConversationLink> {
  const row = await queryOne<ConversationLink>(
    `INSERT INTO conversation_links (tenant_id, wa_jid, chatwoot_conversation_id, chatwoot_contact_id)
       VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, wa_jid) DO UPDATE
       SET chatwoot_conversation_id = EXCLUDED.chatwoot_conversation_id,
           chatwoot_contact_id      = EXCLUDED.chatwoot_contact_id,
           updated_at               = now()
     RETURNING tenant_id, wa_jid, chatwoot_conversation_id, chatwoot_contact_id`,
    [link.tenant_id, link.wa_jid, link.chatwoot_conversation_id, link.chatwoot_contact_id],
  );
  return row!;
}

export async function dropConversationLink(tenantId: string, waJid: string): Promise<void> {
  await query('DELETE FROM conversation_links WHERE tenant_id = $1 AND wa_jid = $2', [
    tenantId,
    waJid,
  ]);
}

/* ----------------------------- message links ---------------------------- */

/**
 * Registra a mensagem de forma atomica. Retorna false se ja existia — usado
 * como trava de idempotencia contra reentregas de webhook e contra o eco de
 * mensagens que o proprio HUB enviou (IsFromMe).
 */
export async function claimMessage(
  tenantId: string,
  waMessageId: string,
  direction: 'in' | 'out',
  waSenderJid: string | null = null,
): Promise<boolean> {
  const rows = await query(
    `INSERT INTO message_links (tenant_id, wa_message_id, direction, wa_sender_jid)
       VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, wa_message_id) DO NOTHING
     RETURNING id`,
    [tenantId, waMessageId, direction, waSenderJid],
  );
  return rows.length > 0;
}

export interface CitacaoAlvo {
  wa_message_id: string;
  wa_sender_jid: string | null;
}

/** Localiza a mensagem do WhatsApp que o Chatwoot está citando. */
export async function findQuoteTargetByChatwootId(
  tenantId: string,
  chatwootMessageId: number,
): Promise<CitacaoAlvo | null> {
  return queryOne<CitacaoAlvo>(
    `SELECT wa_message_id, wa_sender_jid FROM message_links
       WHERE tenant_id = $1 AND chatwoot_message_id = $2 LIMIT 1`,
    [tenantId, chatwootMessageId],
  );
}

export async function findQuoteTargetByWaId(
  tenantId: string,
  waMessageId: string,
): Promise<CitacaoAlvo | null> {
  return queryOne<CitacaoAlvo>(
    `SELECT wa_message_id, wa_sender_jid FROM message_links
       WHERE tenant_id = $1 AND wa_message_id = $2 LIMIT 1`,
    [tenantId, waMessageId],
  );
}

/** Mensagem do Chatwoot equivalente a uma do WhatsApp — para citar na entrada. */
export async function findChatwootMessageIdByWaId(
  tenantId: string,
  waMessageId: string,
): Promise<number | null> {
  const row = await queryOne<{ chatwoot_message_id: number | null }>(
    `SELECT chatwoot_message_id FROM message_links
       WHERE tenant_id = $1 AND wa_message_id = $2 LIMIT 1`,
    [tenantId, waMessageId],
  );
  return row?.chatwoot_message_id ?? null;
}

export async function attachChatwootMessageId(
  tenantId: string,
  waMessageId: string,
  chatwootMessageId: number,
): Promise<void> {
  await query(
    `UPDATE message_links SET chatwoot_message_id = $3
       WHERE tenant_id = $1 AND wa_message_id = $2`,
    [tenantId, waMessageId, chatwootMessageId],
  );
}

export async function findWaMessageIdByChatwootId(
  tenantId: string,
  chatwootMessageId: number,
): Promise<string | null> {
  const row = await queryOne<{ wa_message_id: string }>(
    `SELECT wa_message_id FROM message_links
       WHERE tenant_id = $1 AND chatwoot_message_id = $2 LIMIT 1`,
    [tenantId, chatwootMessageId],
  );
  return row?.wa_message_id ?? null;
}
