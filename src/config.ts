import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  PUBLIC_URL: z.string().url(),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN precisa ter ao menos 16 caracteres'),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool,

  REDIS_URL: z.string().min(1),
  // Prefixo das chaves no Redis. Isola o HUB quando a instancia e
  // compartilhada com outras aplicacoes que tambem usam BullMQ.
  REDIS_PREFIX: z.string().min(1).default('hub'),

  INBOUND_CONCURRENCY: z.coerce.number().int().positive().default(8),
  OUTBOUND_CONCURRENCY: z.coerce.number().int().positive().default(8),
  JOB_ATTEMPTS: z.coerce.number().int().positive().default(5),
  JOB_BACKOFF_MS: z.coerce.number().int().positive().default(3000),

  MAX_MEDIA_BYTES: z.coerce.number().int().positive().default(40 * 1024 * 1024),

  WUZAPI_SIGNATURE_HEADER: z.string().default('X-Webhook-Signature'),

  // Diagnostico: grava o corpo cru dos webhooks em disco. Contem conteudo de
  // conversas, entao deve ficar ligado apenas durante a homologacao.
  CAPTURE_RAW_WEBHOOKS: bool,
  CAPTURE_DIR: z.string().default('./captures'),
  CAPTURE_MAX_FILES: z.coerce.number().int().positive().default(200),

  DEFAULT_WUZAPI_BASE_URL: z.string().url().optional(),
  DEFAULT_CHATWOOT_BASE_URL: z.string().url().optional(),
  DEFAULT_WUZAPI_EVENTS: z.string().default('Message,ReadReceipt'),

  CONTACT_IDENTIFIER_PREFIX: z.string().default('wa:'),

  // Sufixo no nome do contato de grupo, para distingui-lo de uma pessoa na
  // lista de conversas. Deixe vazio para nao acrescentar nada.
  GROUP_NAME_SUFFIX: z.string().default(' (Grupo)'),

  // Reconciliacao periodica: reconecta sessao caida e regrava webhook
  // divergente. O WuzAPI nao restabelece sessoes sozinho apos reiniciar.
  WATCHDOG_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  WATCHDOG_INTERVAL_MS: z.coerce.number().int().min(60_000).default(5 * 60_000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Configuracao invalida (.env):\n${issues}`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  publicUrl: parsed.data.PUBLIC_URL.replace(/\/+$/, ''),
  defaultWuzapiEvents: parsed.data.DEFAULT_WUZAPI_EVENTS.split(',')
    .map((e) => e.trim())
    .filter(Boolean),
};

