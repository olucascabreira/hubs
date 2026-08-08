/**
 * Cria e provisiona o tenant via API admin do HUB ja em execucao.
 *
 * Faz DUAS escritas fora do HUB:
 *   1. cria um inbox de canal API no Chatwoot;
 *   2. grava o webhook do HUB no WuzAPI (sobrescreve o que estiver la).
 *
 * Rode antes com --check para so inspecionar o estado, sem escrever nada.
 *
 *   $env:HUB_URL="https://hub.seudominio.com.br"
 *   $env:ADMIN_TOKEN="..."
 *   npx tsx src/scripts/create-tenant.ts --check
 *   npx tsx src/scripts/create-tenant.ts
 */
import './env-defaults';

const HUB_URL = (process.env.HUB_URL ?? '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.HUB_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? '';
const CHECK_ONLY = process.argv.includes('--check');

const TENANT = {
  slug: process.env.TENANT_SLUG ?? 'minha-instancia',
  name: process.env.TENANT_NAME ?? 'WhatsApp (homologacao)',

  wuzapi_base_url: process.env.WUZAPI_BASE_URL ?? 'https://wuzapi.seudominio.com.br',
  wuzapi_token: process.env.WUZAPI_TOKEN ?? '',

  chatwoot_base_url: process.env.CHATWOOT_BASE_URL ?? 'https://chatwoot.seudominio.com.br',
  chatwoot_account_id: Number(process.env.CHATWOOT_ACCOUNT_ID ?? 1),
  chatwoot_api_token: process.env.CHATWOOT_TOKEN ?? '',

  // A conta tem 59 grupos: ligar isso de saida encheria o Chatwoot de
  // conversas de grupo. Habilite so depois que o 1-a-1 estiver validado.
  handle_groups: false,

  mirror_own_messages: true,
  reopen_resolved: true,
  group_sender_prefix: true,

  provision: true,
};

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${HUB_URL}${path}`, {
    ...init,
    headers: {
      'X-Admin-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* resposta nao-JSON */
  }
  return { status: res.status, body };
}

async function main() {
  if (!HUB_URL || !ADMIN_TOKEN) {
    console.error('Defina HUB_URL e ADMIN_TOKEN.');
    process.exit(1);
  }

  console.log(`HUB: ${HUB_URL}`);

  const health = await api('/health');
  console.log(`\n[health] HTTP ${health.status}`);
  console.log(JSON.stringify(health.body, null, 2));
  if (health.status !== 200) {
    console.error('\nHUB nao esta saudavel. Nao vou provisionar.');
    process.exit(1);
  }

  const existing = await api(`/admin/tenants/${TENANT.slug}`);
  if (existing.status === 200) {
    console.log(`\n[tenant] "${TENANT.slug}" ja existe:`);
    console.log(JSON.stringify(existing.body, null, 2));
    const status = await api(`/admin/tenants/${TENANT.slug}/status`);
    console.log('\n[status]');
    console.log(JSON.stringify(status.body, null, 2));
    return;
  }

  if (CHECK_ONLY) {
    console.log('\n--check: o tenant NAO existe e nada foi escrito.');
    console.log('Payload que seria enviado:');
    console.log(JSON.stringify({ ...TENANT, wuzapi_token: '***', chatwoot_api_token: '***' }, null, 2));
    return;
  }

  if (!TENANT.wuzapi_token || !TENANT.chatwoot_api_token) {
    console.error('\nDefina WUZAPI_TOKEN e CHATWOOT_TOKEN.');
    process.exit(1);
  }

  console.log('\n[provisionando] criando inbox no Chatwoot e webhook no WuzAPI...');
  const created = await api('/admin/tenants', { method: 'POST', body: JSON.stringify(TENANT) });
  console.log(`HTTP ${created.status}`);
  console.log(JSON.stringify(created.body, null, 2));

  if (created.status >= 300) process.exit(1);

  const status = await api(`/admin/tenants/${TENANT.slug}/status`);
  console.log('\n[status apos provisionar]');
  console.log(JSON.stringify(status.body, null, 2));
}

main().catch((err) => {
  console.error('\nFALHOU:', err);
  process.exit(1);
});
