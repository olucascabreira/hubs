import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logger } from '../logger';
import { getTenantBySlug } from '../db/repo';
import { enqueueInbound, enqueueOutbound } from '../queue';
import { normalizeWuzapiEvent } from '../core/normalize';
import { extractChatwootMessage } from '../core/outbound';
import { captureRawWebhook } from '../core/capture';
import {
  verifySignature,
  WUZAPI_SIGNATURE_HEADERS,
  CHATWOOT_SIGNATURE_HEADERS,
} from './security';

interface SlugParams {
  slug: string;
}

function rawBodyOf(req: FastifyRequest): string {
  return (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * WhatsApp -> Chatwoot. Responde 200 imediatamente e processa na fila:
   * o WuzAPI reenvia o evento se o webhook demorar ou falhar.
   */
  app.post<{ Params: SlugParams }>('/webhooks/wuzapi/:slug', async (req, reply) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });
    if (!tenant.active) return reply.code(202).send({ status: 'tenant inativo' });

    if (!verifySignature(req, rawBodyOf(req), tenant.wuzapi_webhook_secret, WUZAPI_SIGNATURE_HEADERS)) {
      logger.warn({ tenant: tenant.slug }, 'assinatura invalida no webhook do WuzAPI');
      return reply.code(401).send({ error: 'assinatura invalida' });
    }

    const event = normalizeWuzapiEvent(req.body);

    // Captura antes de qualquer filtro: durante a homologacao interessa ver
    // inclusive os eventos que o HUB descarta.
    await captureRawWebhook(
      'wuzapi',
      tenant.slug,
      rawBodyOf(req),
      `${event?.type ?? 'desconhecido'}${event?.media ? '-' + event.media.kind : ''}`,
    );

    // Filtro barato antes da fila: presence/receipt chegam em altissimo volume.
    if (!event || event.type !== 'Message') {
      return reply.code(202).send({ status: 'ignorado', type: event?.type ?? 'desconhecido' });
    }

    const jobId = event.waMessageId ? `in:${tenant.slug}:${event.waMessageId}` : undefined;
    await enqueueInbound(tenant.slug, req.body, jobId);

    return reply.code(202).send({ status: 'enfileirado' });
  });

  /**
   * Chatwoot -> WhatsApp. Recebe o callback do inbox de canal API
   * (`channel.webhook_url`).
   */
  app.post<{ Params: SlugParams }>('/webhooks/chatwoot/:slug', async (req, reply) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return reply.code(404).send({ error: 'tenant nao encontrado' });
    if (!tenant.active) return reply.code(202).send({ status: 'tenant inativo' });

    if (
      !verifySignature(req, rawBodyOf(req), tenant.chatwoot_webhook_secret, CHATWOOT_SIGNATURE_HEADERS)
    ) {
      logger.warn({ tenant: tenant.slug }, 'assinatura invalida no webhook do Chatwoot');
      return reply.code(401).send({ error: 'assinatura invalida' });
    }

    const message = extractChatwootMessage(req.body);
    const eventName = String(message?.['event'] ?? '');

    await captureRawWebhook('chatwoot', tenant.slug, rawBodyOf(req), eventName || 'sem-evento');

    if (eventName && eventName !== 'message_created') {
      return reply.code(202).send({ status: 'ignorado', event: eventName });
    }

    const messageId = Number(message?.['id']);
    const jobId = Number.isFinite(messageId) ? `out:${tenant.slug}:${messageId}` : undefined;
    await enqueueOutbound(tenant.slug, req.body, jobId);

    return reply.code(202).send({ status: 'enfileirado' });
  });
}
