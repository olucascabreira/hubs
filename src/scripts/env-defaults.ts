/**
 * Preenche variaveis obrigatorias com valores de fake para que os scripts de
 * teste possam importar modulos que dependem de `config` sem um .env real.
 * Precisa ser importado ANTES de qualquer modulo do projeto.
 */
process.env.PUBLIC_URL ??= 'https://hub.example.com';
process.env.ADMIN_TOKEN ??= 'smoke-test-admin-token-0000000000';
process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.LOG_LEVEL ??= 'silent';
