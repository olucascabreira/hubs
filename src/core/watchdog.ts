import { config } from '../config';
import { logger } from '../logger';
import { WuzapiClient } from '../clients/wuzapi';
import { listTenants, type Tenant } from '../db/repo';
import { diagnosticarSessao } from './sessao';

/**
 * Reconciliacao periodica das instancias.
 *
 * O WuzAPI nao restabelece as sessoes sozinho depois de reiniciar: elas ficam
 * `connected: false` e nenhum evento chega, ate alguem clicar em conectar.
 * O mesmo vale para o webhook, que pode divergir se a instancia for mexida
 * por fora. Este laco detecta os dois casos e corrige.
 *
 * So repara o que e reparavel sem intervencao humana: reconectar sessao com
 * credencial guardada e regravar webhook. Sessao que exige leitura de QR e
 * apenas reportada — nao ha o que automatizar ali.
 */

export interface ResultadoVerificacao {
  tenant: string;
  estado: string;
  acoes: string[];
  erro?: string;
}

export interface CicloWatchdog {
  em: string;
  duracaoMs: number;
  verificados: number;
  reparos: number;
  resultados: ResultadoVerificacao[];
}

let ultimoCiclo: CicloWatchdog | null = null;
let timer: NodeJS.Timeout | null = null;

export function ultimoCicloWatchdog(): CicloWatchdog | null {
  return ultimoCiclo;
}

async function verificar(tenant: Tenant): Promise<ResultadoVerificacao> {
  const acoes: string[] = [];
  const wuz = new WuzapiClient(tenant);

  try {
    const sessao = (await wuz.status()) as unknown as Record<string, unknown>;
    const diag = diagnosticarSessao(sessao);

    // 1. Sessao caida com credencial guardada: reconecta sem exigir QR.
    if (diag.estado === 'desconectada') {
      await wuz.connect(config.defaultWuzapiEvents);
      acoes.push('reconexao solicitada');
    }

    // 2. Webhook divergente: regrava apontando de volta para o HUB.
    const urls = `${config.publicUrl}/webhooks/wuzapi/${tenant.slug}`;
    const atual = await wuz.getWebhook();
    if (atual.webhook !== urls) {
      await wuz.setWebhook(urls, config.defaultWuzapiEvents);
      acoes.push('webhook regravado');
    }

    return { tenant: tenant.slug, estado: diag.estado, acoes };
  } catch (err) {
    return {
      tenant: tenant.slug,
      estado: 'erro',
      acoes,
      erro: err instanceof Error ? err.message : String(err),
    };
  }
}

async function rodarCiclo(): Promise<void> {
  const inicio = Date.now();
  try {
    const tenants = (await listTenants()).filter((t) => t.active);
    const resultados: ResultadoVerificacao[] = [];

    // Sequencial de proposito: sao poucas instancias e cada verificacao faz
    // duas chamadas ao WuzAPI. Paralelizar so aumentaria a chance de timeout.
    for (const t of tenants) resultados.push(await verificar(t));

    const reparos = resultados.reduce((n, r) => n + r.acoes.length, 0);
    ultimoCiclo = {
      em: new Date().toISOString(),
      duracaoMs: Date.now() - inicio,
      verificados: resultados.length,
      reparos,
      resultados,
    };

    if (reparos > 0) {
      logger.warn(
        { reparos, detalhe: resultados.filter((r) => r.acoes.length) },
        'watchdog reparou instancias',
      );
    }
  } catch (err) {
    logger.error({ err }, 'ciclo do watchdog falhou');
  }
}

export function startWatchdog(): void {
  if (!config.WATCHDOG_ENABLED) {
    logger.info('watchdog desligado (WATCHDOG_ENABLED=false)');
    return;
  }

  const intervalo = config.WATCHDOG_INTERVAL_MS;
  logger.info({ intervaloMs: intervalo }, 'watchdog de sessoes ativo');

  // Primeira passada com folga, para o servico terminar de subir.
  setTimeout(() => void rodarCiclo(), 30_000).unref();
  timer = setInterval(() => void rodarCiclo(), intervalo);
  timer.unref();
}

export function stopWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
