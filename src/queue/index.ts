import { Queue, Worker, UnrecoverableError, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../logger';
import { HttpError } from '../clients/http';
import { getTenantBySlug } from '../db/repo';
import { handleInboundEvent } from '../core/inbound';
import { handleOutboundEvent } from '../core/outbound';

export const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const INBOUND_QUEUE = 'wa-to-chatwoot';
export const OUTBOUND_QUEUE = 'chatwoot-to-wa';

interface JobData {
  tenantSlug: string;
  payload: unknown;
}

const defaultJobOptions: JobsOptions = {
  attempts: config.JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: config.JOB_BACKOFF_MS },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

// `prefix` isola as chaves quando o Redis e compartilhado com outras
// aplicacoes. Sem ele, duas apps com BullMQ e filas de mesmo nome disputariam
// os mesmos jobs.
const prefix = config.REDIS_PREFIX;

export const inboundQueue = new Queue<JobData>(INBOUND_QUEUE, {
  connection,
  prefix,
  defaultJobOptions,
});
export const outboundQueue = new Queue<JobData>(OUTBOUND_QUEUE, {
  connection,
  prefix,
  defaultJobOptions,
});

/**
 * `jobId` deduplica reentregas do mesmo evento: o BullMQ descarta um job cujo
 * id ja exista, entao um webhook repetido nao vira uma segunda mensagem.
 */
export async function enqueueInbound(tenantSlug: string, payload: unknown, jobId?: string) {
  await inboundQueue.add('inbound', { tenantSlug, payload }, jobId ? { jobId } : undefined);
}

export async function enqueueOutbound(tenantSlug: string, payload: unknown, jobId?: string) {
  await outboundQueue.add('outbound', { tenantSlug, payload }, jobId ? { jobId } : undefined);
}

async function loadTenant(slug: string) {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`Tenant ${slug} nao existe`);
  if (!tenant.active) throw new Error(`Tenant ${slug} esta inativo`);
  return tenant;
}

/**
 * Erro 4xx do outro lado nao melhora com retry.
 *
 * `UnrecoverableError` marca o job como FALHO sem repetir. A versao anterior
 * apenas registrava e retornava, e o job era contabilizado como sucesso — uma
 * mensagem podia desaparecer sem aparecer em `failed` no /health.
 */
function classificarErro(err: unknown): never {
  if (err instanceof HttpError && !err.retryable) {
    throw new UnrecoverableError(err.message);
  }
  throw err;
}

export function startWorkers(): Worker[] {
  const inbound = new Worker<JobData>(
    INBOUND_QUEUE,
    async (job) => {
      const tenant = await loadTenant(job.data.tenantSlug);
      try {
        return await handleInboundEvent(tenant, job.data.payload);
      } catch (err) {
        return classificarErro(err);
      }
    },
    { connection, prefix, concurrency: config.INBOUND_CONCURRENCY },
  );

  const outbound = new Worker<JobData>(
    OUTBOUND_QUEUE,
    async (job) => {
      const tenant = await loadTenant(job.data.tenantSlug);
      try {
        return await handleOutboundEvent(tenant, job.data.payload);
      } catch (err) {
        return classificarErro(err);
      }
    },
    { connection, prefix, concurrency: config.OUTBOUND_CONCURRENCY },
  );

  for (const worker of [inbound, outbound]) {
    worker.on('failed', (job, err) => {
      logger.error(
        { queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
        'job falhou',
      );
    });
  }

  return [inbound, outbound];
}
