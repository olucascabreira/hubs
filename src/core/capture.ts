import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Grava o corpo cru dos webhooks em disco quando CAPTURE_RAW_WEBHOOKS=true.
 *
 * Serve para diagnostico: os specs nao documentam o payload que o WuzAPI
 * entrega, entao ver o evento real e a unica forma de confirmar o parsing.
 * Fica desligado por padrao — o corpo contem conteudo de conversas.
 */

let ready = false;
let captured = 0;

async function ensureDir(dir: string): Promise<void> {
  if (ready) return;
  await mkdir(dir, { recursive: true });
  ready = true;
}

/** Mantem apenas os arquivos mais recentes para nao encher o disco. */
async function prune(dir: string, keep: number): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  if (files.length <= keep) return;
  for (const file of files.slice(0, files.length - keep)) {
    await unlink(join(dir, file)).catch(() => undefined);
  }
}

export async function captureRawWebhook(
  source: 'wuzapi' | 'chatwoot',
  tenantSlug: string,
  rawBody: string,
  hint?: string,
): Promise<void> {
  if (!config.CAPTURE_RAW_WEBHOOKS) return;

  try {
    const dir = resolve(config.CAPTURE_DIR);
    await ensureDir(dir);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeHint = (hint ?? 'evento').replace(/[^\w-]+/g, '_').slice(0, 40);
    const file = join(dir, `${stamp}__${source}__${tenantSlug}__${safeHint}.json`);

    await writeFile(file, rawBody, 'utf8');

    captured += 1;
    if (captured % 25 === 0) await prune(dir, config.CAPTURE_MAX_FILES);

    logger.debug({ file }, 'webhook cru capturado');
  } catch (err) {
    // Diagnostico nunca pode derrubar o fluxo principal.
    logger.warn({ err }, 'falha ao capturar webhook cru');
  }
}
