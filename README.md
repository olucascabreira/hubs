# HUB WuzAPI ↔ Chatwoot

Serviço de integração bidirecional entre **WuzAPI** (WhatsApp via whatsmeow) e **Chatwoot**.
Multi-tenant: N números de WhatsApp ↔ N inboxes do Chatwoot em uma única instância.

```
WhatsApp ──► WuzAPI ──webhook──► HUB ──API──► Chatwoot  (mensagem recebida)
WhatsApp ◄── WuzAPI ◄───API──── HUB ◄webhook─ Chatwoot  (resposta do agente)
```

O lado do Chatwoot usa um **inbox de canal API** (`channel.type = "api"`). O HUB cria esse inbox
sozinho no provisionamento e aponta o `webhook_url` dele para si mesmo.

---

## Como funciona

### Entrada — WhatsApp → Chatwoot

1. WuzAPI entrega o evento em `POST /webhooks/wuzapi/:slug`.
2. Assinatura HMAC é conferida sobre o corpo cru (opcional, por tenant).
3. Eventos que não são `Message` são descartados na porta — `Presence`/`ReadReceipt` chegam em volume alto.
4. O evento entra na fila `wa-to-chatwoot` e a resposta sai em ~ms (o WuzAPI reenvia se demorar).
5. O worker normaliza o payload, resolve contato e conversa, baixa a mídia e cria a mensagem.

### Saída — Chatwoot → WhatsApp

1. O inbox API chama `POST /webhooks/chatwoot/:slug` em `message_created`.
2. São descartadas: notas privadas, mensagens `incoming` e mensagens com `source_id` preenchido
   (essas vieram do WhatsApp — reenviar criaria loop).
3. O worker resolve o JID pelo `contact_inbox.source_id`, baixa os anexos e envia pelo endpoint
   correto do WuzAPI (`/chat/send/text|image|video|audio|document`).

### Identidade e deduplicação

| Conceito | Chave |
|---|---|
| Contato | `identifier` do Chatwoot = `wa:<jid>` |
| Canal do contato | `contact_inbox.source_id` = o JID puro (`5511...@s.whatsapp.net` ou `...@g.us`) |
| Conversa | uma por chat de WhatsApp, reaberta quando resolvida |
| Mensagem entrando | `UNIQUE (tenant_id, wa_message_id)` no Postgres + `jobId` no BullMQ |
| Mensagem saindo | stanza ID **determinístico** = `3EB0 + sha1(tenant:message_id:index)` |

O ID determinístico é o que impede duplicata: reprocessar o mesmo job gera o mesmo ID, e quando o
WhatsApp devolve o eco (`IsFromMe: true`) o registro já existe e o evento é descartado.

### Grupos

O grupo vira **um contato** no Chatwoot (nome = assunto do grupo, sem `phone_number`). Cada mensagem
recebe o prefixo `*Nome do participante*:` e `content_attributes` guarda `wa_sender_jid`,
`wa_sender_name` e `wa_sender_phone`. Desligue com `handle_groups: false` ou tire o prefixo com
`group_sender_prefix: false`.

### Mídia

Entrada: usa o base64 embutido no webhook quando existe; senão chama `/chat/download{image,video,audio,document,sticker}`
com `MediaKey`/`FileEncSHA256`/`DirectPath` e sobe como anexo multipart. **Falha de download não perde a
mensagem** — o texto vai com um aviso no lugar do anexo.

Saída: `file_type` + mimetype decidem o endpoint. `image/webp` e áudios que o WhatsApp não toca
nativamente (ex.: `audio/wav`) saem como documento em vez de falhar.

---

## Subindo

```bash
cp .env.example .env      # ajuste PUBLIC_URL e ADMIN_TOKEN
docker compose up -d --build
curl http://localhost:3000/health
```

`PUBLIC_URL` precisa ser alcançável **pelo WuzAPI e pelo Chatwoot** — é essa URL que fica gravada
nos dois webhooks. Em desenvolvimento use ngrok/cloudflared.

Sem Docker:

```bash
npm install
npm run migrate:dev     # cria as tabelas
npm run dev
```

Migrations rodam sozinhas no boot; `npm run migrate` existe para rodar antes do deploy.

---

## Cadastrando um tenant

Um POST cria o tenant, **cria o inbox API no Chatwoot** e **grava o webhook no WuzAPI**:

```bash
curl -X POST http://localhost:3000/admin/tenants \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "loja-centro",
    "name": "Loja Centro - WhatsApp",
    "wuzapi_base_url": "http://wuzapi:8080",
    "wuzapi_token": "TOKEN_DA_INSTANCIA_WUZAPI",
    "chatwoot_base_url": "https://chat.suaempresa.com.br",
    "chatwoot_account_id": 1,
    "chatwoot_api_token": "SEU_API_ACCESS_TOKEN",
    "handle_groups": true
  }'
```

Depois conecte o WhatsApp e leia o QR:

```bash
curl -X POST http://localhost:3000/admin/tenants/loja-centro/connect -H "X-Admin-Token: $ADMIN_TOKEN"
curl http://localhost:3000/admin/tenants/loja-centro/qr     -H "X-Admin-Token: $ADMIN_TOKEN"
curl http://localhost:3000/admin/tenants/loja-centro/status -H "X-Admin-Token: $ADMIN_TOKEN"
```

`/status` compara os webhooks configurados nos dois sistemas com os que o HUB espera — é o primeiro
lugar para olhar quando as mensagens não chegam.

### Rotas administrativas

Todas exigem o header `X-Admin-Token`.

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/admin/tenants` | Lista tenants (tokens omitidos) |
| `POST` | `/admin/tenants` | Cria e provisiona |
| `GET` | `/admin/tenants/:slug` | Detalhe |
| `PATCH` | `/admin/tenants/:slug` | Atualiza credenciais/flags |
| `DELETE` | `/admin/tenants/:slug` | Remove (cascata nos vínculos) |
| `POST` | `/admin/tenants/:slug/provision` | Reprovisiona (idempotente) |
| `GET` | `/admin/tenants/:slug/status` | Sessão WhatsApp + webhooks + inbox |
| `POST` | `/admin/tenants/:slug/connect` | Conecta a sessão |
| `GET` | `/admin/tenants/:slug/qr` | QR code para parear |

### Flags por tenant

| Flag | Padrão | Efeito |
|---|---|---|
| `handle_groups` | `true` | Espelha conversas de grupo |
| `group_sender_prefix` | `true` | Prefixa `*Participante*:` em grupos |
| `mirror_own_messages` | `true` | Mensagens enviadas pelo celular aparecem como `outgoing` no Chatwoot |
| `reopen_resolved` | `true` | Reabre a conversa resolvida em vez de criar outra |
| `active` | `true` | `false` faz o HUB responder 202 e ignorar os webhooks |

---

## Segurança

- `/admin/*` protegido por `X-Admin-Token` com comparação em tempo constante.
- HMAC-SHA256 opcional por tenant nos dois webhooks, validado sobre o **corpo cru** (aceita
  `hex` ou `base64`, com ou sem prefixo `sha256=`).
  - WuzAPI: `wuzapi_webhook_secret` + `POST /session/hmac/config` na instância.
  - Chatwoot: `chatwoot_webhook_secret`.
- Tokens nunca são devolvidos pela API nem aparecem nos logs (`redact` do pino).
- Publique **só** `/webhooks/*` na internet; deixe `/admin/*` na rede interna ou atrás de VPN.

## Operação

`GET /health` devolve status de Postgres, Redis e contadores das filas (`waiting`/`active`/`failed`).

Jobs tentam 5 vezes com backoff exponencial. Erros HTTP 4xx (fora de 408/429) não são repetidos —
um 422 do Chatwoot não melhora na segunda tentativa. Jobs que falharam ficam 7 dias no Redis para
inspeção.

Ajuste de carga: `INBOUND_CONCURRENCY`, `OUTBOUND_CONCURRENCY`, `JOB_ATTEMPTS`, `JOB_BACKOFF_MS`.

---

## Estrutura

```
src/
  config.ts            variáveis de ambiente validadas com zod
  server.ts            Fastify, parsers com corpo cru, /health
  index.ts             bootstrap: migrations, servidor, workers, shutdown
  clients/
    http.ts            fetch com timeout, HttpError com flag de retry
    wuzapi.ts          sessão, webhook, envio, download de mídia
    chatwoot.ts        inboxes, contatos, conversas, mensagens, anexos
  core/
    jid.ts             JID ↔ telefone ↔ alvo do WuzAPI
    normalize.ts       payload do WuzAPI → evento estável
    media.ts           mimetype → extensão / endpoint de envio
    resolve.ts         contato e conversa no Chatwoot
    inbound.ts         WhatsApp → Chatwoot
    outbound.ts        Chatwoot → WhatsApp
  db/                  pool, migrations embutidas, repositórios
  queue/               filas e workers BullMQ
  routes/              webhooks, admin, verificação de assinatura
  scripts/smoke.ts     testes das funções puras
```

`npm run smoke` roda 33 verificações sem precisar de Postgres, Redis ou rede:

- `smoke.ts` (17) — funções puras: JID, normalização de payloads do WuzAPI, roteamento de mídia, IDs determinísticos.
- `smoke-http.ts` (16) — camada HTTP via `app.inject()`: HMAC, auth admin, parsers de corpo cru, vazamento de erro.

### O que ainda NÃO foi testado

Nenhum teste toca WuzAPI ou Chatwoot de verdade. Três pontos foram **inferidos**, porque não estão
nos specs, e são os primeiros a validar contra instâncias reais:

1. **Formato do payload do webhook do WuzAPI** — o `spec-wuz.yml` documenta os endpoints do webhook,
   mas não o corpo entregue. `normalize.ts` é defensivo (case-insensitive, aceita `jsonData`), porém
   nunca viu um evento real.
2. **Upload multipart em `POST /messages` do Chatwoot** — o swagger só descreve o corpo JSON;
   `attachments[]` não aparece lá.
3. **Nomes de campos em `/chat/download*` e no query param de `/group/info`** — lidos de forma
   tolerante, mas sem confirmação.

Também sem cobertura: migrations contra Postgres real, `docker compose up`, e o caminho fim a fim.

---

## Troubleshooting

**Mensagem do WhatsApp não aparece no Chatwoot**
`GET /admin/tenants/:slug/status` — o `wuzapi_webhook.webhook` deve bater com `expected_webhooks.wuzapi`.
Se estiver diferente, rode `/provision`. Depois confira `failed` em `/health`.

**Resposta do agente não sai**
O webhook do Chatwoot é do *inbox*, não da conta. Confirme em Configurações → Caixas de Entrada →
Configuração que a URL é `PUBLIC_URL/webhooks/chatwoot/<slug>`. `/provision` reescreve.

**Mensagem duplicada no WhatsApp**
Só acontece se houver outro bridge no mesmo inbox — o ID determinístico impede duplicata vinda do HUB.

**Conversa nova a cada mensagem**
`reopen_resolved` está `false`, ou o `source_id` do contato mudou. `contact_inboxes` do contato deve
ter `source_id` igual ao JID.

**Áudio chega como arquivo**
Esperado para formatos que o WhatsApp não toca (`audio/wav`, `audio/webm`). Converta para
`audio/ogg; codecs=opus` antes de anexar se quiser áudio nativo.

## Escopo atual

Cobre texto, mídia (imagem/vídeo/áudio/documento/sticker), localização, contato e grupos, nos dois
sentidos. **Não** cobre: status de entrega/leitura, reações, edição e exclusão de mensagem, botões e
listas interativas. `normalize.ts` já extrai reações e `quotedWaMessageId`, então esses são os
pontos de partida naturais.
