/**
 * Smoke test da camada HTTP com app.inject() — sem Postgres, Redis ou rede.
 * Cobre roteamento, auth admin, parser de corpo cru e verificacao de HMAC.
 *   npx tsx src/scripts/smoke-http.ts
 */
import './env-defaults';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { buildServer } from '../server';
import { verifySignature } from '../routes/security';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN!;

let passed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/** Simula o header como o Fastify entrega em req.headers (tudo minusculo). */
function fakeRequest(headers: Record<string, string>): FastifyRequest {
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  return { headers: lowered } as unknown as FastifyRequest;
}

async function main() {
  const app = await buildServer();

  console.log('\nVerificacao de assinatura HMAC');
  const body = JSON.stringify({ type: 'Message', event: { Info: { ID: 'A1' } } });
  const secret = 'segredo-compartilhado';
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  const b64 = createHmac('sha256', secret).update(body).digest('base64');

  await check('sem segredo configurado, a verificacao passa', () => {
    assert.equal(verifySignature(fakeRequest({}), body, null, ['X-Webhook-Signature']), true);
  });
  await check('aceita assinatura em hex', () => {
    const req = fakeRequest({ 'X-Webhook-Signature': hex });
    assert.equal(verifySignature(req, body, secret, ['X-Webhook-Signature']), true);
  });
  await check('aceita assinatura em base64', () => {
    const req = fakeRequest({ 'X-Webhook-Signature': b64 });
    assert.equal(verifySignature(req, body, secret, ['X-Webhook-Signature']), true);
  });
  await check('aceita o prefixo sha256=', () => {
    const req = fakeRequest({ 'X-Hub-Signature-256': `sha256=${hex}` });
    assert.equal(verifySignature(req, body, secret, ['X-Hub-Signature-256']), true);
  });
  await check('rejeita assinatura errada', () => {
    const req = fakeRequest({ 'X-Webhook-Signature': 'a'.repeat(64) });
    assert.equal(verifySignature(req, body, secret, ['X-Webhook-Signature']), false);
  });
  await check('rejeita quando o header nao vem', () => {
    assert.equal(verifySignature(fakeRequest({}), body, secret, ['X-Webhook-Signature']), false);
  });
  await check('rejeita corpo adulterado com assinatura valida do original', () => {
    const req = fakeRequest({ 'X-Webhook-Signature': hex });
    const adulterado = body.replace('A1', 'A2');
    assert.equal(verifySignature(req, adulterado, secret, ['X-Webhook-Signature']), false);
  });

  console.log('\nAuth das rotas administrativas');
  await check('sem token responde 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/tenants' });
    assert.equal(res.statusCode, 401);
  });
  await check('token errado responde 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/tenants',
      headers: { 'x-admin-token': 'errado' },
    });
    assert.equal(res.statusCode, 401);
  });
  await check('token de tamanho diferente nao quebra o timingSafeEqual', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/tenants',
      headers: { 'x-admin-token': 'x' },
    });
    assert.equal(res.statusCode, 401);
  });
  await check('payload invalido e barrado antes do banco', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: { slug: 'MAIUSCULO INVALIDO', name: '' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'payload invalido');
  });

  console.log('\nPainel /ui');
  await check('serve HTML sem exigir token', async () => {
    const res = await app.inject({ method: 'GET', url: '/ui' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.match(res.body, /HUB WuzAPI/);
  });
  await check('nao embute o token nem segredos no HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/ui' });
    assert.ok(!res.body.includes(ADMIN_TOKEN), 'o HTML nao pode conter o ADMIN_TOKEN');
    assert.ok(!res.body.includes('api_access_token'), 'nem o token do Chatwoot');
  });
  await check('pede noindex para nao ser indexado', async () => {
    const res = await app.inject({ method: 'GET', url: '/ui' });
    assert.match(String(res.headers['x-robots-tag']), /noindex/);
  });

  console.log('\nRoteamento e parsers');
  await check('rota inexistente responde 404 em JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/nao-existe' });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /nao existe/);
  });
  await check('JSON malformado no webhook responde 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wuzapi/qualquer',
      headers: { 'content-type': 'application/json' },
      payload: '{ isso nao e json',
    });
    assert.equal(res.statusCode, 400);
  });
  // Sem Postgres o handler falha ao buscar o tenant. O que estas verificacoes
  // cobrem e a etapa ANTERIOR: o corpo passou pelo parser sem virar 400.
  await check('corpo vazio passa pelo parser', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wuzapi/qualquer',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    assert.notEqual(res.statusCode, 400, 'corpo vazio nao pode ser tratado como JSON invalido');
  });
  await check('form-encoded com jsonData passa pelo parser', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wuzapi/qualquer',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `jsonData=${encodeURIComponent(body)}&token=abc`,
    });
    assert.notEqual(res.statusCode, 415, 'o content-type precisa ter parser registrado');
    assert.notEqual(res.statusCode, 400);
  });
  await check('erro interno nao vaza detalhes na resposta', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/chatwoot/nao-cadastrado',
      payload: { event: 'message_created', id: 1 },
    });
    // Sem banco isso e 500; o que importa e o corpo nao expor stack nem DSN.
    if (res.statusCode === 500) {
      assert.deepEqual(res.json(), { error: 'erro interno' });
    }
  });

  await app.close();
  console.log(`\n${passed} verificacoes passaram.\n`);

  // O pool do pg e o ioredis seguem tentando reconectar e segurariam o
  // event loop; este script nao tem infra para desligar de forma graciosa.
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFALHOU:', err);
  process.exit(1);
});
