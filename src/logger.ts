import { pino, type Logger } from 'pino';
import { config } from './config';

/** Campos que nunca devem aparecer no log — tokens e segredos de webhook. */
export const redactPaths = [
  'req.headers.token',
  'req.headers.api_access_token',
  'req.headers["x-admin-token"]',
  '*.wuzapi_token',
  '*.chatwoot_api_token',
  '*.wuzapi_webhook_secret',
  '*.chatwoot_webhook_secret',
];

export const logger: Logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[redacted]' },
});

export type { Logger };
