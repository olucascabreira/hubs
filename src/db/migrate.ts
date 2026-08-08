import { pool, withTransaction } from './pool';
import { migrations } from './migrations';

export async function runMigrations(): Promise<string[]> {
  const applied: string[] = [];

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  for (const migration of migrations) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [
      migration.name,
    ]);
    if (rowCount) continue;

    await withTransaction(async (client) => {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
    });
    applied.push(migration.name);
  }

  return applied;
}

if (require.main === module) {
  runMigrations()
    .then((applied) => {
      // eslint-disable-next-line no-console
      console.log(applied.length ? `Migrations aplicadas: ${applied.join(', ')}` : 'Nada a aplicar.');
      return pool.end();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
