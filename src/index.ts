import { config } from './config';
import { logger } from './logger';
import { runMigrations } from './db/migrate';
import { pool } from './db/pool';
import { buildServer, listen } from './server';
import { connection, startWorkers } from './queue';
import { startWatchdog, stopWatchdog } from './core/watchdog';

async function main(): Promise<void> {
  const applied = await runMigrations();
  if (applied.length) logger.info({ applied }, 'migrations aplicadas');

  const app = await buildServer();
  const workers = startWorkers();
  startWatchdog();

  await listen(app);
  logger.info(
    { port: config.PORT, publicUrl: config.publicUrl },
    'HUB WuzAPI <-> Chatwoot no ar',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando');
    try {
      stopWatchdog();
      await app.close();
      await Promise.all(workers.map((w) => w.close()));
      await connection.quit();
      await pool.end();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'falha no encerramento');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'falha ao iniciar');
  process.exit(1);
});
