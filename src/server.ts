import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { config } from './config';
import { redactPaths } from './logger';
import { pool } from './db/pool';
import { connection, inboundQueue, outboundQueue } from './queue';
import { webhookRoutes } from './routes/webhooks';
import { adminRoutes } from './routes/admin';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: redactPaths, censor: '[redacted]' },
    },
    bodyLimit: 64 * 1024 * 1024,
    trustProxy: true,
  });

  /**
   * Guarda o corpo cru: a verificacao de HMAC precisa dos bytes exatos que
   * foram assinados, nao do JSON reserializado.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    (req as FastifyRequest & { rawBody?: string }).rawBody = raw;
    if (!raw) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      // Sem statusCode explicito o handler de erro devolveria 500, e um 5xx
      // faz o WuzAPI reenviar para sempre um corpo que nunca vai parsear.
      const parseError = Object.assign(err as Error, { statusCode: 400 });
      done(parseError, undefined);
    }
  });

  // Algumas builds do WuzAPI postam form-encoded com o JSON em `jsonData`.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      (req as FastifyRequest & { rawBody?: string }).rawBody = raw;
      const parsed: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(raw)) parsed[k] = v;
      done(null, parsed);
    },
  );

  app.get('/health', async () => {
    const [db, redis, inboundCounts, outboundCounts] = await Promise.allSettled([
      pool.query('SELECT 1'),
      connection.ping(),
      inboundQueue.getJobCounts('waiting', 'active', 'failed'),
      outboundQueue.getJobCounts('waiting', 'active', 'failed'),
    ]);

    const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
    return {
      status: ok ? 'ok' : 'degraded',
      database: db.status === 'fulfilled' ? 'ok' : 'erro',
      redis: redis.status === 'fulfilled' ? 'ok' : 'erro',
      queues: {
        inbound: inboundCounts.status === 'fulfilled' ? inboundCounts.value : null,
        outbound: outboundCounts.status === 'fulfilled' ? outboundCounts.value : null,
      },
    };
  });

  // Os handlers precisam vir ANTES dos register: `await app.register(...)`
  // dispara o ready() do plugin, e o contexto filho herda o handler de erro
  // que existir naquele instante. Registrar depois deixaria as rotas com o
  // handler padrao do Fastify, que devolve a mensagem interna do erro.
  app.setErrorHandler((error, req, reply) => {
    const err = error as { statusCode?: number; message?: string };
    req.log.error({ err: error }, 'erro nao tratado');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? 'erro interno' : err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: `rota ${req.method} ${req.url} nao existe` });
  });

  await app.register(webhookRoutes);
  await app.register(adminRoutes);

  return app;
}

export async function listen(app: FastifyInstance): Promise<void> {
  await app.listen({ port: config.PORT, host: config.HOST });
}
