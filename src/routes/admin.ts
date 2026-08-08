import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { ChatwootClient } from '../clients/chatwoot';
import { WuzapiClient } from '../clients/wuzapi';
import {
  createTenant,
  deleteTenant,
  getTenantBySlug,
  listTenants,
  updateTenant,
  type Tenant,
} from '../db/repo';
import { requireAdmin } from './security';
import { captureStats, listCaptures } from '../core/capture';
import { grupoPermitido } from '../core/inbound';
import { isGroupJid, normalizeJid } from '../core/jid';

const slugSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug deve conter apenas minusculas, numeros e hifen');

const createSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1),

  wuzapi_base_url: z.string().url().optional(),
  wuzapi_token: z.string().min(1),
  wuzapi_webhook_secret: z.string().min(8).nullish(),

  chatwoot_base_url: z.string().url().optional(),
  chatwoot_account_id: z.coerce.number().int().positive(),
  chatwoot_api_token: z.string().min(1),
  chatwoot_inbox_id: z.coerce.number().int().positive().nullish(),
  chatwoot_webhook_secret: z.string().min(8).nullish(),

  handle_groups: z.boolean().optional(),
  mirror_own_messages: z.boolean().optional(),
  reopen_resolved: z.boolean().optional(),
  group_sender_prefix: z.boolean().optional(),
  /** Vazia = todos os grupos. Com itens = somente esses JIDs. */
  group_allowlist: z.array(z.string()).optional(),

  /** Cria o inbox no Chatwoot e grava o webhook no WuzAPI logo apos criar. */
  provision: z.boolean().default(true),
});

const patchSchema = createSchema
  .omit({ slug: true, provision: true })
  .partial()
  .extend({ active: z.boolean().optional() });

function publicView(tenant: Tenant) {
  const { wuzapi_token, chatwoot_api_token, wuzapi_webhook_secret, chatwoot_webhook_secret, ...rest } =
    tenant;
  return {
    ...rest,
    has_wuzapi_token: Boolean(wuzapi_token),
    has_chatwoot_api_token: Boolean(chatwoot_api_token),
    has_wuzapi_webhook_secret: Boolean(wuzapi_webhook_secret),
    has_chatwoot_webhook_secret: Boolean(chatwoot_webhook_secret),
    webhooks: webhookUrls(tenant.slug),
  };
}

export function webhookUrls(slug: string) {
  return {
    wuzapi: `${config.publicUrl}/webhooks/wuzapi/${slug}`,
    chatwoot: `${config.publicUrl}/webhooks/chatwoot/${slug}`,
  };
}

/**
 * Conecta as duas pontas: garante o inbox de canal API no Chatwoot apontando
 * para o HUB e registra o webhook do HUB no WuzAPI. Idempotente.
 */
export async function provisionTenant(tenant: Tenant) {
  const urls = webhookUrls(tenant.slug);
  const cw = new ChatwootClient(tenant);
  const wuz = new WuzapiClient(tenant);
  const steps: Record<string, unknown> = {};

  let inboxId = tenant.chatwoot_inbox_id;
  let inboxIdentifier = tenant.chatwoot_inbox_identifier;

  const existing = inboxId ? await cw.getInbox(inboxId) : null;

  if (!existing) {
    const inbox = await cw.createApiInbox(tenant.name, urls.chatwoot);
    inboxId = inbox.id;
    inboxIdentifier = inbox.inbox_identifier ?? null;
    steps.chatwoot_inbox = { action: 'criado', id: inboxId, channel_type: inbox.channel_type };
  } else {
    if (existing.webhook_url !== urls.chatwoot) {
      const updated = await cw.updateInboxWebhook(existing.id, urls.chatwoot);
      inboxIdentifier = updated.inbox_identifier ?? inboxIdentifier;
      steps.chatwoot_inbox = { action: 'webhook_atualizado', id: existing.id };
    } else {
      steps.chatwoot_inbox = { action: 'ja_configurado', id: existing.id };
    }
    inboxIdentifier = inboxIdentifier ?? existing.inbox_identifier ?? null;
  }

  await wuz.setWebhook(urls.wuzapi, config.defaultWuzapiEvents);
  steps.wuzapi_webhook = { action: 'configurado', url: urls.wuzapi, events: config.defaultWuzapiEvents };

  const saved = await updateTenant(tenant.slug, {
    chatwoot_inbox_id: inboxId,
    chatwoot_inbox_identifier: inboxIdentifier,
  });

  logger.info({ tenant: tenant.slug, steps }, 'tenant provisionado');
  return { tenant: publicView(saved ?? tenant), steps, webhooks: urls };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!requireAdmin(req)) {
      return reply.code(401).send({ error: 'X-Admin-Token ausente ou invalido' });
    }
  });

  /** Defaults nao-secretos, para o painel pre-preencher o cadastro. */
  app.get('/admin/config', async () => ({
    public_url: config.publicUrl,
    default_wuzapi_base_url: config.DEFAULT_WUZAPI_BASE_URL ?? '',
    default_chatwoot_base_url: config.DEFAULT_CHATWOOT_BASE_URL ?? '',
    default_wuzapi_events: config.defaultWuzapiEvents,
  }));

  app.get('/admin/tenants', async () => {
    const tenants = await listTenants();
    return { data: tenants.map(publicView) };
  });

  app.post('/admin/tenants', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'payload invalido', issues: parsed.error.issues });
    }

    const { provision, ...input } = parsed.data;

    const wuzapiBaseUrl = input.wuzapi_base_url ?? config.DEFAULT_WUZAPI_BASE_URL;
    const chatwootBaseUrl = input.chatwoot_base_url ?? config.DEFAULT_CHATWOOT_BASE_URL;

    if (!wuzapiBaseUrl || !chatwootBaseUrl) {
      return reply.code(400).send({
        error: 'informe wuzapi_base_url e chatwoot_base_url ou defina os DEFAULT_* no .env',
      });
    }

    if (await getTenantBySlug(input.slug)) {
      return reply.code(409).send({ error: `tenant ${input.slug} ja existe` });
    }

    const tenant = await createTenant({
      ...input,
      wuzapi_base_url: wuzapiBaseUrl,
      chatwoot_base_url: chatwootBaseUrl,
    });

    if (!provision) {
      return reply.code(201).send({ data: publicView(tenant), webhooks: webhookUrls(tenant.slug) });
    }

    try {
      return reply.code(201).send(await provisionTenant(tenant));
    } catch (err) {
      // O tenant fica salvo: basta corrigir credenciais e chamar /provision.
      logger.error({ err, tenant: tenant.slug }, 'falha ao provisionar');
      return reply.code(201).send({
        data: publicView(tenant),
        webhooks: webhookUrls(tenant.slug),
        provision_error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get<{ Params: { slug: string } }>('/admin/tenants/:slug', async (req, reply) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });
    return { data: publicView(tenant) };
  });

  app.patch<{ Params: { slug: string } }>('/admin/tenants/:slug', async (req, reply) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'payload invalido', issues: parsed.error.issues });
    }
    const tenant = await updateTenant(req.params.slug, parsed.data);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });
    return { data: publicView(tenant) };
  });

  /**
   * Remove a instancia do HUB.
   *
   * Antes de apagar, tira o webhook do WuzAPI — senao ele seguiria entregando
   * eventos numa URL que passou a responder 404. O inbox do Chatwoot NAO e
   * apagado de proposito: ele guarda o historico das conversas, e essa exclusao
   * tem que ser uma decisao consciente feita la.
   */
  app.delete<{ Params: { slug: string } }>('/admin/tenants/:slug', async (req, reply) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });

    const limpeza: Record<string, string> = {};

    try {
      await new WuzapiClient(tenant).deleteWebhook();
      limpeza.wuzapi_webhook = 'removido';
    } catch (err) {
      // Instancia ja fora do ar ou token invalido: nao impede a exclusao.
      limpeza.wuzapi_webhook = `falhou (${err instanceof Error ? err.message : String(err)})`;
    }

    await deleteTenant(tenant.slug);

    return {
      removido: tenant.slug,
      limpeza,
      pendente: tenant.chatwoot_inbox_id
        ? `O inbox #${tenant.chatwoot_inbox_id} do Chatwoot foi mantido, com o historico das ` +
          `conversas. Apague-o manualmente se nao for mais usar.`
        : null,
    };
  });

  app.post<{ Params: { slug: string } }>('/admin/tenants/:slug/provision', async (req, reply) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });
    return provisionTenant(tenant);
  });

  /* --------------------- operacao da sessao WhatsApp --------------------- */

  app.get<{ Params: { slug: string } }>('/admin/tenants/:slug/status', async (req, reply) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });

    const wuz = new WuzapiClient(tenant);
    const cw = new ChatwootClient(tenant);

    const [session, webhook, inbox] = await Promise.allSettled([
      wuz.status(),
      wuz.getWebhook(),
      tenant.chatwoot_inbox_id ? cw.getInbox(tenant.chatwoot_inbox_id) : Promise.resolve(null),
    ]);

    const value = <T>(r: PromiseSettledResult<T>) =>
      r.status === 'fulfilled' ? r.value : { error: String(r.reason?.message ?? r.reason) };

    return {
      tenant: tenant.slug,
      expected_webhooks: webhookUrls(tenant.slug),
      wuzapi_session: value(session),
      wuzapi_webhook: value(webhook),
      chatwoot_inbox: value(inbox),
    };
  });

  app.post<{ Params: { slug: string } }>('/admin/tenants/:slug/connect', async (req, reply) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });
    return new WuzapiClient(tenant).connect(config.defaultWuzapiEvents);
  });

  /**
   * Lista os grupos do WhatsApp marcando quais estao liberados. E a partir
   * daqui que se monta a lista de permissao — os JIDs de grupo nao sao
   * descobriveis de outro jeito.
   */
  app.get<{ Params: { slug: string } }>('/admin/tenants/:slug/groups', async (req, reply) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });

    const grupos = await new WuzapiClient(tenant).listGroups();
    const lista = tenant.group_allowlist ?? [];

    return {
      handle_groups: tenant.handle_groups,
      modo: lista.length === 0 ? 'todos os grupos' : `somente ${lista.length} grupo(s)`,
      total: grupos.length,
      grupos: grupos
        .map((g) => ({ ...g, permitido: grupoPermitido(tenant, g.jid) }))
        .sort((a, b) => Number(b.permitido) - Number(a.permitido) || a.nome.localeCompare(b.nome)),
    };
  });

  /** Substitui a lista de permissao de grupos. */
  app.put<{ Params: { slug: string } }>('/admin/tenants/:slug/groups/allowlist', async (req, reply) => {
    const parsed = z
      .object({ group_allowlist: z.array(z.string().min(1)) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'envie { "group_allowlist": ["<jid>@g.us", ...] }' });
    }

    const jids = parsed.data.group_allowlist.map((j) => normalizeJid(j)).filter(Boolean);
    const invalidos = jids.filter((j) => !isGroupJid(j));
    if (invalidos.length) {
      return reply.code(400).send({ error: 'JIDs que nao sao de grupo', invalidos });
    }

    const tenant = await updateTenant(req.params.slug, { group_allowlist: jids });
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });

    return {
      data: publicView(tenant),
      modo: jids.length === 0 ? 'todos os grupos' : `somente ${jids.length} grupo(s)`,
    };
  });

  /**
   * Payloads crus recebidos, para conferir o formato real contra o parsing.
   * Contem conteudo de conversas: so responde com CAPTURE_RAW_WEBHOOKS=true.
   */
  app.get<{ Params: { slug: string }; Querystring: { limit?: string } }>(
    '/admin/tenants/:slug/captures',
    async (req, reply) => {
      const tenant = await getTenantBySlug(req.params.slug);
      if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });

      const limit = Math.min(Number(req.query.limit ?? 10) || 10, 40);
      return { stats: captureStats(), capturas: listCaptures(tenant.slug, limit) };
    },
  );

  /**
   * QR para parear o WhatsApp. O WuzAPI recusa gerar QR quando a sessao ja
   * esta ativa, entao respondemos o estado em vez de propagar o erro.
   */
  app.get<{ Params: { slug: string } }>('/admin/tenants/:slug/qr', async (req, reply) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });

    const wuz = new WuzapiClient(tenant);
    const sessao = await wuz.status().catch(() => null);

    if (sessao?.LoggedIn || (sessao as { loggedIn?: boolean } | null)?.loggedIn) {
      return {
        estado: 'conectado',
        mensagem: 'Sessao ja pareada; nao ha QR a exibir.',
        sessao,
      };
    }

    try {
      const qr = await wuz.qr();
      const codigo =
        (qr as { QRCode?: string })?.QRCode ??
        (qr as unknown as { qrcode?: string })?.qrcode ??
        '';
      return { estado: codigo ? 'aguardando_leitura' : 'indisponivel', qrcode: codigo, sessao };
    } catch (err) {
      return {
        estado: 'indisponivel',
        mensagem:
          'O WuzAPI nao gerou QR agora. Se a sessao estiver desconectada, chame /connect antes.',
        detalhe: err instanceof Error ? err.message : String(err),
        sessao,
      };
    }
  });
}
