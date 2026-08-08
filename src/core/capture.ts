import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Guarda o corpo cru dos webhooks para diagnostico. Os specs nao documentam o
 * payload que o WuzAPI entrega, entao ver o evento real e a unica forma de
 * confirmar o parsing.
 *
 * Guarda em MEMORIA (buffer circular) e, opcionalmente, em disco. A memoria e
 * a fonte confiavel: o volume montado pertence ao root e o processo roda como
 * usuario comum, entao a escrita em disco pode falhar silenciosamente.
 * O buffer e exposto em GET /admin/tenants/:slug/captures.
 */

export interface CapturedWebhook {
  at: string;
  source: 'wuzapi' | 'chatwoot';
  tenantSlug: string;
  hint: string;
  body: unknown;
  rawLength: number;
}

const MAX_IN_MEMORY = 40;
const buffer: CapturedWebhook[] = [];

let dirReady = false;
let diskDisabled = false;
let written = 0;

async function toDisk(rawBody: string, source: string, tenantSlug: string, hint: string) {
  if (diskDisabled) return;
  try {
    const dir = resolve(config.CAPTURE_DIR);
    if (!dirReady) {
      await mkdir(dir, { recursive: true });
      dirReady = true;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeHint = hint.replace(/[^\w-]+/g, '_').slice(0, 40);
    await writeFile(join(dir, `${stamp}__${source}__${tenantSlug}__${safeHint}.json`), rawBody, 'utf8');

    written += 1;
    if (written % 25 === 0) {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - config.CAPTURE_MAX_FILES))) {
        await unlink(join(dir, f)).catch(() => undefined);
      }
    }
  } catch (err) {
    // Tipicamente EACCES: volume do root, processo nao-root. Avisa uma vez e
    // segue so com o buffer em memoria, que e o que o /captures consome.
    diskDisabled = true;
    logger.warn(
      { err, dir: config.CAPTURE_DIR },
      'captura em disco desativada; usando apenas o buffer em memoria',
    );
  }
}

export async function captureRawWebhook(
  source: 'wuzapi' | 'chatwoot',
  tenantSlug: string,
  rawBody: string,
  hint = 'evento',
): Promise<void> {
  if (!config.CAPTURE_RAW_WEBHOOKS) return;

  let body: unknown = rawBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    /* mantem o texto cru */
  }

  buffer.push({
    at: new Date().toISOString(),
    source,
    tenantSlug,
    hint,
    body,
    rawLength: rawBody.length,
  });
  while (buffer.length > MAX_IN_MEMORY) buffer.shift();

  void toDisk(rawBody, source, tenantSlug, hint);
}

export function listCaptures(tenantSlug?: string, limit = 10): CapturedWebhook[] {
  const items = tenantSlug ? buffer.filter((c) => c.tenantSlug === tenantSlug) : buffer;
  return items.slice(-limit).reverse();
}

export function captureStats() {
  return {
    habilitado: config.CAPTURE_RAW_WEBHOOKS,
    em_memoria: buffer.length,
    limite_memoria: MAX_IN_MEMORY,
    disco: diskDisabled ? 'desativado (sem permissao de escrita)' : config.CAPTURE_DIR,
  };
}
