import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function headerValue(req: FastifyRequest, name: string): string | null {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === 'string' ? raw : null;
}

/** Normaliza `sha256=abc`, `SHA256=abc` e hex/base64 puros. */
function normalizeSignature(value: string): string {
  return value.replace(/^sha256=/i, '').trim();
}

function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function hmacBase64(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

/**
 * Confere a assinatura HMAC-SHA256 do corpo cru.
 * Retorna true quando nao ha segredo configurado (verificacao opcional).
 */
export function verifySignature(
  req: FastifyRequest,
  rawBody: string,
  secret: string | null,
  headerNames: string[],
): boolean {
  if (!secret) return true;

  const provided = headerNames.map((h) => headerValue(req, h)).find(Boolean);
  if (!provided) return false;

  const candidate = normalizeSignature(provided);
  return safeEqual(candidate, hmacHex(secret, rawBody)) || safeEqual(candidate, hmacBase64(secret, rawBody));
}

export const WUZAPI_SIGNATURE_HEADERS = [
  config.WUZAPI_SIGNATURE_HEADER,
  'X-Hub-Signature-256',
  'X-Signature-256',
  'X-Webhook-Signature',
  'X-Wuzapi-Signature',
];

export const CHATWOOT_SIGNATURE_HEADERS = ['X-Chatwoot-Signature', 'X-Hub-Signature-256'];

export function requireAdmin(req: FastifyRequest): boolean {
  const token = headerValue(req, 'x-admin-token');
  return Boolean(token && safeEqual(token, config.ADMIN_TOKEN));
}
