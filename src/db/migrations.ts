/**
 * Migrations embutidas como strings para que `tsc` nao precise copiar .sql
 * para dist/. Cada entrada roda uma unica vez e fica registrada em
 * schema_migrations.
 */
export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    name: '001_init',
    sql: /* sql */ `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS tenants (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug                      text NOT NULL UNIQUE,
        name                      text NOT NULL,
        active                    boolean NOT NULL DEFAULT true,

        -- WuzAPI
        wuzapi_base_url           text NOT NULL,
        wuzapi_token              text NOT NULL,
        wuzapi_webhook_secret     text,

        -- Chatwoot
        chatwoot_base_url         text NOT NULL,
        chatwoot_account_id       integer NOT NULL,
        chatwoot_api_token        text NOT NULL,
        chatwoot_inbox_id         integer,
        chatwoot_inbox_identifier text,
        chatwoot_webhook_secret   text,

        -- Comportamento
        handle_groups             boolean NOT NULL DEFAULT true,
        mirror_own_messages       boolean NOT NULL DEFAULT true,
        reopen_resolved           boolean NOT NULL DEFAULT true,
        group_sender_prefix       boolean NOT NULL DEFAULT true,

        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS contact_links (
        id                  bigserial PRIMARY KEY,
        tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        wa_jid              text NOT NULL,
        chatwoot_contact_id integer NOT NULL,
        source_id           text NOT NULL,
        display_name        text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wa_jid)
      );

      CREATE TABLE IF NOT EXISTS conversation_links (
        id                       bigserial PRIMARY KEY,
        tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        wa_jid                   text NOT NULL,
        chatwoot_conversation_id integer NOT NULL,
        chatwoot_contact_id      integer NOT NULL,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wa_jid)
      );

      CREATE INDEX IF NOT EXISTS conversation_links_cw_idx
        ON conversation_links (tenant_id, chatwoot_conversation_id);

      CREATE TABLE IF NOT EXISTS message_links (
        id                  bigserial PRIMARY KEY,
        tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        wa_message_id       text NOT NULL,
        chatwoot_message_id integer,
        direction           text NOT NULL CHECK (direction IN ('in', 'out')),
        created_at          timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wa_message_id)
      );

      CREATE INDEX IF NOT EXISTS message_links_cw_idx
        ON message_links (tenant_id, chatwoot_message_id);
    `,
  },
  {
    name: '002_group_allowlist',
    sql: /* sql */ `
      -- Lista de grupos permitidos. Vazia/NULL com handle_groups=true significa
      -- "todos os grupos"; com itens, so os JIDs listados viram conversa.
      ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS group_allowlist text[] NOT NULL DEFAULT '{}';
    `,
  },
  {
    name: '003_message_sender',
    sql: /* sql */ `
      -- Autor da mensagem. O WhatsApp exige o JID de quem escreveu para
      -- renderizar uma citacao (ContextInfo.Participant).
      ALTER TABLE message_links
        ADD COLUMN IF NOT EXISTS wa_sender_jid text;
    `,
  },
  {
    name: '004_lid_links',
    sql: /* sql */ `
      -- Par LID <-> JID de telefone, aprendido quando o WhatsApp entrega os
      -- dois no mesmo evento (SenderAlt / RecipientAlt). Depois disso o
      -- telefone fica conhecido mesmo em eventos que so trazem o LID.
      CREATE TABLE IF NOT EXISTS lid_links (
        id            bigserial PRIMARY KEY,
        tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        wa_lid        text NOT NULL,
        wa_phone_jid  text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wa_lid)
      );
    `,
  },
];
