/**
 * Sonda SOMENTE-LEITURA contra WuzAPI e Chatwoot reais.
 *
 * Nao cria inbox, nao altera webhook, nao envia mensagem. Serve para conferir
 * credenciais e, principalmente, os formatos de resposta que o HUB assume mas
 * que nao estao descritos nos specs.
 *
 * Uso (PowerShell):
 *   $env:WUZAPI_BASE_URL="http://localhost:8080"
 *   $env:WUZAPI_TOKEN="..."
 *   $env:CHATWOOT_BASE_URL="https://chat.suaempresa.com.br"
 *   $env:CHATWOOT_ACCOUNT_ID="1"
 *   $env:CHATWOOT_TOKEN="..."
 *   npx tsx src/scripts/probe.ts
 */
import './env-defaults';

const WUZAPI_BASE_URL = process.env.WUZAPI_BASE_URL?.replace(/\/+$/, '');
const WUZAPI_TOKEN = process.env.WUZAPI_TOKEN;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL?.replace(/\/+$/, '');
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Descreve a forma do JSON sem imprimir os valores (evita vazar PII). */
function shape(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length ? `array[${value.length}] de ${shape(value[0], depth + 1)}` : 'array[0]';
  }
  if (isDict(value)) {
    if (depth >= 2) return '{...}';
    const keys = Object.keys(value);
    const shown = keys.slice(0, 14);
    const body = shown.map((k) => `${k}: ${shape(value[k], depth + 1)}`).join(', ');
    return `{ ${body}${keys.length > shown.length ? `, +${keys.length - shown.length} campos` : ''} }`;
  }
  return typeof value;
}

function mask(value: unknown): string {
  const s = String(value ?? '');
  if (s.length <= 6) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

interface Probe {
  label: string;
  ok: boolean;
  detail: string;
}

const results: Probe[] = [];

async function call(
  label: string,
  url: string,
  init: RequestInit,
  inspect: (data: unknown, status: number) => string,
): Promise<unknown> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const raw = await res.text();
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* resposta nao-JSON */
    }

    const ok = res.ok;
    results.push({
      label,
      ok,
      detail: ok ? inspect(data, res.status) : `HTTP ${res.status} — ${raw.slice(0, 200)}`,
    });
    return ok ? data : null;
  } catch (err) {
    results.push({ label, ok: false, detail: `falhou: ${(err as Error).message}` });
    return null;
  }
}

async function probeWuzapi() {
  if (!WUZAPI_BASE_URL || !WUZAPI_TOKEN) {
    console.log('\n[WuzAPI] pulado — defina WUZAPI_BASE_URL e WUZAPI_TOKEN');
    return;
  }
  console.log(`\n[WuzAPI] ${WUZAPI_BASE_URL}`);
  const headers = { token: WUZAPI_TOKEN, Accept: 'application/json' };

  await call('GET /session/status (auth + envelope)', `${WUZAPI_BASE_URL}/session/status`, { headers }, (d) => {
    const envelope = isDict(d) && 'success' in d && 'data' in d;
    return `envelope {code,data,success}: ${envelope ? 'SIM' : 'NAO — ' + shape(d)}\n      data: ${shape(isDict(d) ? d['data'] : d)}`;
  });

  // O mais importante: mostra o que ja esta configurado, para poder restaurar.
  await call('GET /webhook (config ATUAL — anote antes de provisionar)', `${WUZAPI_BASE_URL}/webhook`, { headers }, (d) => {
    const data = isDict(d) ? d['data'] : d;
    if (!isDict(data)) return `forma inesperada: ${shape(d)}`;
    const url = data['webhook'] ?? data['WebhookURL'] ?? '(vazio)';
    const events = data['subscribe'] ?? data['Events'] ?? [];
    return `webhook atual: ${url || '(vazio)'}\n      eventos: ${JSON.stringify(events)}`;
  });

  await call('GET /group/list (confirma leitura de grupos)', `${WUZAPI_BASE_URL}/group/list`, { headers }, (d) => {
    const data = isDict(d) ? d['data'] : d;
    return `forma: ${shape(data)}`;
  });
}

/** Descobre a conta pelo proprio token quando CHATWOOT_ACCOUNT_ID nao vier. */
async function discoverAccountId(baseUrl: string, token: string): Promise<string | null> {
  const data = await call(
    'GET /api/v1/profile (identifica o token e as contas)',
    `${baseUrl}/api/v1/profile`,
    { headers: { api_access_token: token, Accept: 'application/json' } },
    (d) => {
      if (!isDict(d)) return `forma inesperada: ${shape(d)}`;
      const accounts = d['accounts'];
      const list = Array.isArray(accounts) ? (accounts as Dict[]) : [];
      const lines = list.map(
        (a) => `        conta #${a['id']} "${a['name']}" papel=${a['role']}`,
      );
      return (
        `usuario: ${d['name'] ?? '?'} <${mask(d['email'])}>\n` +
        `      ${list.length} conta(s) acessivel(is)\n${lines.join('\n')}`
      );
    },
  );

  if (!isDict(data)) return null;
  const accounts = data['accounts'];
  const first = Array.isArray(accounts) && isDict(accounts[0]) ? accounts[0] : null;
  return first ? String(first['id']) : null;
}

async function probeChatwoot() {
  if (!CHATWOOT_BASE_URL || !CHATWOOT_TOKEN) {
    console.log('\n[Chatwoot] pulado — defina CHATWOOT_BASE_URL e CHATWOOT_TOKEN');
    return;
  }
  console.log(`\n[Chatwoot] ${CHATWOOT_BASE_URL}`);

  const accountId = CHATWOOT_ACCOUNT_ID ?? (await discoverAccountId(CHATWOOT_BASE_URL, CHATWOOT_TOKEN));
  if (!accountId) {
    console.log('  nao foi possivel descobrir o account_id — as demais sondagens ficam de fora');
    return;
  }
  console.log(`  usando account_id = ${accountId}`);

  const acc = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}`;
  const headers = { api_access_token: CHATWOOT_TOKEN, Accept: 'application/json' };

  await call('GET /inboxes (auth + inboxes existentes)', `${acc}/inboxes`, { headers }, (d) => {
    const list = (isDict(d) ? d['payload'] : d) as Dict[] | undefined;
    if (!Array.isArray(list)) return `forma inesperada: ${shape(d)}`;
    const lines = list.map(
      (i) => `        #${i['id']} "${i['name']}" tipo=${i['channel_type']} webhook=${i['webhook_url'] ?? '-'}`,
    );
    const api = list.filter((i) => String(i['channel_type']).includes('Api'));
    return `${list.length} inbox(es); ${api.length} de canal API\n${lines.join('\n')}`;
  });

  // Valida o formato de filtro que o HUB usa para reencontrar contatos.
  await call(
    'POST /contacts/filter (formato do filtro por identifier)',
    `${acc}/contacts/filter`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: [
          {
            attribute_key: 'identifier',
            filter_operator: 'equal_to',
            values: ['wa:probe-inexistente@s.whatsapp.net'],
            query_operator: null,
          },
        ],
      }),
    },
    (d) => {
      const list = isDict(d) ? d['payload'] : null;
      if (!Array.isArray(list)) return `filtro REJEITADO ou forma inesperada: ${shape(d)}`;
      return `filtro aceito; retornou ${list.length} contato(s) (0 e o esperado)`;
    },
  );

  await call('GET /contacts?page=1 (forma do contato + contact_inboxes)', `${acc}/contacts?page=1`, { headers }, (d) => {
    const list = (isDict(d) ? d['payload'] : d) as Dict[] | undefined;
    if (!Array.isArray(list) || !list.length) return 'nenhum contato na conta (ok)';
    const c = list[0]!;
    const inboxes = c['contact_inboxes'];
    return (
      `campos: ${Object.keys(c).slice(0, 12).join(', ')}\n` +
      `      exemplo: id=${c['id']} identifier=${mask(c['identifier'])} phone=${mask(c['phone_number'])}\n` +
      `      contact_inboxes presente: ${Array.isArray(inboxes) ? `SIM (${inboxes.length})` : 'NAO'}`
    );
  });
}

async function main() {
  console.log('Sonda somente-leitura — nenhuma escrita sera feita nos dois sistemas.');
  await probeWuzapi();
  await probeChatwoot();

  console.log('\n' + '='.repeat(72));
  let failures = 0;
  for (const r of results) {
    if (!r.ok) failures += 1;
    console.log(`\n${r.ok ? '[ok]  ' : '[FALHA]'} ${r.label}\n      ${r.detail}`);
  }
  console.log('\n' + '='.repeat(72));
  console.log(`${results.length - failures}/${results.length} sondagens bem-sucedidas.\n`);
  process.exit(failures ? 1 : 0);
}

main();
