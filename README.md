# HUB WuzAPI â†” Chatwoot

IntegraÃ§Ã£o bidirecional entre **WuzAPI** (WhatsApp via whatsmeow) e **Chatwoot**.
Multi-tenant: N nÃºmeros de WhatsApp â†” N inboxes do Chatwoot numa Ãºnica instalaÃ§Ã£o.

```
WhatsApp â”€â”€â–º WuzAPI â”€â”€webhookâ”€â”€â–º HUB â”€â”€APIâ”€â”€â–º Chatwoot   mensagem recebida
WhatsApp â—„â”€â”€ WuzAPI â—„â”€â”€â”€APIâ”€â”€â”€â”€ HUB â—„webhookâ”€ Chatwoot   resposta do agente
```

No Chatwoot cada nÃºmero vira um **inbox de canal API**, criado automaticamente pelo HUB, com o
`webhook_url` apontando de volta para ele.

---

## InstalaÃ§Ã£o

Requisitos do ambiente:

- Docker Swarm ou Docker standalone, com Portainer
- Traefik com um resolver TLS configurado
- DNS do domÃ­nio do HUB apontando para o Traefik
- WuzAPI e Chatwoot acessÃ­veis (pela internet ou pela rede interna do Docker)

Postgres e Redis vÃªm na prÃ³pria stack â€” nada a provisionar Ã  parte.

### 1. Publicar a imagem (uma vez, por quem mantÃ©m o projeto)

```bash
git tag v1.0.0 && git push origin v1.0.0
```

O workflow [`publish.yml`](.github/workflows/publish.yml) roda typecheck e os testes, constrÃ³i para
`amd64` e `arm64` e publica em `ghcr.io/olucascabreira/hub` com as tags `1.0.0`, `1.0` e `latest`.

Sem registry disponÃ­vel? Veja [deploy/README.md](deploy/README.md) para o caminho a partir do
cÃ³digo-fonte â€” funciona, mas exige construir num nÃ³ e prender o serviÃ§o a ele.

### 2. Subir a stack

Portainer â†’ Stacks â†’ Add stack â†’ Web editor. Duas opÃ§Ãµes, conforme sua infraestrutura:

| Sua situaÃ§Ã£o | Arquivo |
|---|---|
| JÃ¡ tenho Postgres e Redis | [`deploy/stack-externo.yml`](deploy/stack-externo.yml) |
| NÃ£o tenho, quero tudo junto | [`deploy/stack-template.yml`](deploy/stack-template.yml) |

Usando os seus serviÃ§os, crie um banco dedicado antes (nÃ£o reuse o do Chatwoot) e isole o Redis num
nÃºmero de banco prÃ³prio â€” o passo a passo estÃ¡ em [deploy/README.md](deploy/README.md).

Para a stack autossuficiente, as variÃ¡veis obrigatÃ³rias sÃ£o cinco:

```
HUB_IMAGE=ghcr.io/olucascabreira/hub:1.0.0
HUB_DOMAIN=hub.seudominio.com.br
ADMIN_TOKEN=<openssl rand -hex 32>
POSTGRES_PASSWORD=<openssl rand -hex 16>
TRAEFIK_NETWORK=<docker network ls>
CERT_RESOLVER=<resolver do seu Traefik>
```

O editor do Portainer lÃª cada linha como `CHAVE=valor` e **nÃ£o aceita comentÃ¡rios nem linhas em
branco**. As demais variÃ¡veis tÃªm default e estÃ£o documentadas no template.

Prefira a tag de versÃ£o a `:latest`: o Swarm fixa a imagem pelo ID resolvido no deploy, e uma tag
mÃ³vel torna difÃ­cil saber o que estÃ¡ rodando.

### 3. Conferir

```bash
curl -s https://hub.seudominio.com.br/health
```

```json
{ "status": "ok", "build": "e706963", "database": "ok", "redis": "ok", "queues": { ... } }
```

O campo `build` informa o commit em execuÃ§Ã£o â€” Ã© como se confirma que um deploy realmente chegou ao
serviÃ§o. As migrations rodam sozinhas no boot.

### 4. Criar a instÃ¢ncia no WuzAPI

Cada nÃºmero precisa de um usuÃ¡rio prÃ³prio no WuzAPI, com token prÃ³prio. Pelo dashboard em
`/dashboard`, ou pela API:

```bash
curl -X POST https://SEU_WUZAPI/admin/users \
  -H "Authorization: $WUZAPI_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Loja Centro","token":"UM_TOKEN_FORTE_E_UNICO"}'
```

AtenÃ§Ã£o: aqui Ã© o `WUZAPI_ADMIN_TOKEN` (header `Authorization`), diferente do token de instÃ¢ncia
(header `token`). Guarde o token definido â€” Ã© ele que vai no passo seguinte.

Reaproveitar o mesmo token entre instÃ¢ncias faria as duas apontarem para a mesma sessÃ£o do WhatsApp.

### 5. Cadastrar no HUB e parear

Abra `https://hub.seudominio.com.br/ui`, informe o `ADMIN_TOKEN` e clique em **+ Nova instÃ¢ncia**.
Ao salvar, o HUB cria o inbox no Chatwoot e grava o webhook no WuzAPI numa operaÃ§Ã£o sÃ³.

Depois, **Conectar sessÃ£o** e leia o QR que aparece na tela, no WhatsApp em *Aparelhos conectados*.

O `slug` entra na URL do webhook (`/webhooks/wuzapi/<slug>`): escolha algo estÃ¡vel, porque mudÃ¡-lo
depois exige reprovisionar.

---

## Painel

`https://SEU_HUB/ui` â€” pÃ¡gina Ãºnica, sem build e sem dependÃªncia externa.

| SeÃ§Ã£o | O que faz |
|---|---|
| SaÃºde | build em execuÃ§Ã£o, Postgres, Redis e filas, atualizando a cada 15s |
| InstÃ¢ncias | seletor, criar, reprovisionar, conectar sessÃ£o, excluir |
| Status | sessÃ£o pareada e se cada webhook confere com o esperado |
| Pareamento | QR renderizado |
| Comportamento | as flags em checkbox, salvando na hora |
| Grupos | lista com filtro e seleÃ§Ã£o por checkbox |
| Capturas | Ãºltimos webhooks crus, para diagnÃ³stico |

A pÃ¡gina em si nÃ£o exige token â€” Ã© HTML sem segredo. Todas as chamadas de dados exigem o
`X-Admin-Token`, que fica apenas no `sessionStorage` da aba.

O painel nÃ£o edita credenciais, de propÃ³sito. Para rotacionar tokens, use a API:

```bash
curl -X PATCH https://SEU_HUB/admin/tenants/<slug> \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"chatwoot_api_token":"NOVO_TOKEN"}'
```

---

## Como funciona

### Entrada â€” WhatsApp â†’ Chatwoot

1. WuzAPI entrega o evento em `POST /webhooks/wuzapi/:slug`.
2. Assinatura HMAC Ã© conferida sobre o corpo cru, se houver segredo configurado.
3. Eventos que nÃ£o sÃ£o `Message` sÃ£o descartados na porta â€” `Presence` e `ReadReceipt` chegam em volume alto.
4. O evento entra na fila e a resposta sai em milissegundos; o WuzAPI reenvia se demorar.
5. O worker normaliza, resolve contato e conversa, baixa a mÃ­dia e cria a mensagem.

### SaÃ­da â€” Chatwoot â†’ WhatsApp

1. O inbox chama `POST /webhooks/chatwoot/:slug` em `message_created`.
2. SÃ£o descartadas: notas privadas, mensagens `incoming`, e mensagens com `source_id` preenchido â€”
   essas vieram do WhatsApp, e reenviÃ¡-las criaria loop.
3. O worker resolve o destino, baixa os anexos e envia pelo endpoint correto do WuzAPI.

### Identidade e deduplicaÃ§Ã£o

| Conceito | Chave |
|---|---|
| Contato | `identifier` = `wa:<jid>`, com fallback por telefone |
| Canal do contato | `contact_inbox.source_id` = o JID |
| Conversa | uma por chat, reaberta quando resolvida |
| Mensagem entrando | `UNIQUE (tenant_id, wa_message_id)` + `jobId` no BullMQ |
| Mensagem saindo | stanza ID determinÃ­stico `3EB0 + sha1(tenant:message_id:index)` |

O ID determinÃ­stico Ã© o que impede duplicata: reprocessar o mesmo job gera o mesmo ID, e o eco do
WhatsApp encontra o registro jÃ¡ existente.

Isso nÃ£o Ã© teÃ³rico â€” o Chatwoot dispara `message_created` **trÃªs vezes** para mensagens com anexo.
Sem a deduplicaÃ§Ã£o, todo anexo sairia em triplicata.

### Contatos que jÃ¡ existem

Se o nÃºmero jÃ¡ Ã© contato no Chatwoot â€” criado pelo canal oficial ou por outra integraÃ§Ã£o â€” o HUB
**reaproveita** esse contato em vez de duplicar, e nÃ£o altera nenhum campo dele. Um contato pode
servir vÃ¡rios inboxes; Ã© a modelagem correta do Chatwoot.

### Grupos

O grupo vira **um contato** (nome = assunto do grupo, sem telefone). Cada mensagem recebe o prefixo
`*Nome do participante*:`, e `content_attributes` guarda o autor real.

Com `handle_groups` ligado e `group_allowlist` vazia, **todos** os grupos viram conversa â€” numa conta
com dezenas de grupos isso enche o Chatwoot. Use o painel para selecionar quais interessam.

| `handle_groups` | `group_allowlist` | Efeito |
|---|---|---|
| `false` | â€” | nenhum grupo |
| `true` | vazia | todos |
| `true` | com itens | somente os listados |

### MÃ­dia

**Entrada:** usa o base64 embutido no webhook quando existe; senÃ£o chama `/chat/download*` com
`MediaKey`/`FileEncSHA256`/`DirectPath`, e sobe como anexo multipart. Falha de download nÃ£o perde a
mensagem â€” o texto vai com um aviso no lugar do anexo.

**SaÃ­da:** `file_type` e mimetype decidem o endpoint.

Ãudio tem tratamento prÃ³prio, porque nota de voz no WhatsApp exige OGG/Opus e um mp3 marcado como
nota de voz chega quebrado, sem erro no envio:

| Origem | Envio |
|---|---|
| qualquer formato, com ffmpeg | convertido para OGG/Opus â†’ nota de voz |
| jÃ¡ era OGG/Opus | direto, sem reprocessar |
| mp3/m4a/aac, sem ffmpeg | arquivo de Ã¡udio com player |
| wav/webm, sem ffmpeg | documento |

O ffmpeg vem na imagem. Se faltar, o HUB degrada em vez de falhar.

---

## Flags por instÃ¢ncia

| Flag | PadrÃ£o | Efeito |
|---|---|---|
| `handle_groups` | `true` | espelha conversas de grupo |
| `group_allowlist` | `[]` | vazia = todos os grupos permitidos |
| `group_sender_prefix` | `true` | prefixa `*Participante*:` |
| `mirror_own_messages` | `true` | mensagens enviadas pelo celular aparecem como `outgoing` |
| `reopen_resolved` | `true` | reabre a conversa resolvida em vez de criar outra |
| `active` | `true` | `false` faz o HUB ignorar os webhooks sem apagar nada |

Com `mirror_own_messages` ligado, **toda pessoa que vocÃª mensagear pelo celular vira conversa** â€”
inclusive contatos pessoais. Faz sentido em nÃºmero dedicado a atendimento; em nÃºmero misto,
considere desligar.

---

## API administrativa

Todas exigem o header `X-Admin-Token`.

| MÃ©todo | Rota | O que faz |
|---|---|---|
| `GET` | `/health` | status, build e filas (sem token) |
| `GET` | `/ui` | painel (sem token) |
| `GET` | `/admin/config` | defaults nÃ£o-secretos |
| `GET` | `/admin/tenants` | lista instÃ¢ncias |
| `POST` | `/admin/tenants` | cria e provisiona |
| `GET` | `/admin/tenants/:slug` | detalhe |
| `PATCH` | `/admin/tenants/:slug` | atualiza credenciais e flags |
| `DELETE` | `/admin/tenants/:slug` | remove; limpa o webhook do WuzAPI |
| `POST` | `/admin/tenants/:slug/provision` | reprovisiona, idempotente |
| `GET` | `/admin/tenants/:slug/status` | sessÃ£o, webhooks e inbox |
| `POST` | `/admin/tenants/:slug/connect` | conecta a sessÃ£o |
| `GET` | `/admin/tenants/:slug/qr` | QR para parear |
| `GET` | `/admin/tenants/:slug/groups` | grupos, com quais estÃ£o liberados |
| `PUT` | `/admin/tenants/:slug/groups/allowlist` | define a lista de permissÃ£o |
| `GET` | `/admin/tenants/:slug/captures` | webhooks crus recebidos |

### Excluir uma instÃ¢ncia

Remove o webhook do WuzAPI e apaga os vÃ­nculos. **NÃ£o** apaga o inbox do Chatwoot â€” ele guarda o
histÃ³rico das conversas, e isso deve ser decisÃ£o consciente. TambÃ©m nÃ£o desconecta a sessÃ£o.

Para uma pausa, prefira desmarcar **InstÃ¢ncia ativa**: nada Ã© apagado.

---

## SeguranÃ§a

- `/admin/*` protegido por `X-Admin-Token`, com comparaÃ§Ã£o em tempo constante.
- HMAC-SHA256 opcional por instÃ¢ncia nos dois webhooks, validado sobre o corpo cru.
- Tokens nunca voltam pela API nem aparecem nos logs.
- `CAPTURE_RAW_WEBHOOKS` grava conteÃºdo de conversas reais. Ligue sÃ³ para diagnosticar.
- `/ui` e `/health` sÃ£o pÃºblicos e nÃ£o contÃªm segredo. Para restringir `/admin` por IP, use
  `ADMIN_ALLOWED_IPS` no Traefik.

---

## OperaÃ§Ã£o

`GET /health` devolve Postgres, Redis, contadores das filas e o commit em execuÃ§Ã£o.

Jobs tentam 5 vezes com backoff exponencial. Erros HTTP 4xx (fora de 408/429) nÃ£o sÃ£o repetidos â€”
um 422 do Chatwoot nÃ£o melhora na segunda tentativa. Falhas ficam 7 dias no Redis.

Ajuste de carga: `INBOUND_CONCURRENCY`, `OUTBOUND_CONCURRENCY`, `JOB_ATTEMPTS`, `JOB_BACKOFF_MS`.

### Troubleshooting

**Mensagem nÃ£o chega no Chatwoot** â€” `/admin/tenants/:slug/status`: o webhook do WuzAPI deve bater
com o esperado. Se divergir, use *Reprovisionar*. Depois confira `failed` em `/health`.

**Resposta do agente nÃ£o sai** â€” o webhook do Chatwoot Ã© do *inbox*, nÃ£o da conta. *Reprovisionar*
reescreve.

**Conversa nova a cada mensagem** â€” `reopen_resolved` desligado, ou o `source_id` do contato mudou.

**Comportamento estranho em geral** â€” ligue `CAPTURE_RAW_WEBHOOKS`, reproduza, e leia o payload cru
no painel. Foi assim que todos os defeitos de campo foram encontrados.

---

## Estrutura

```
src/
  config.ts            variÃ¡veis de ambiente validadas com zod
  server.ts            Fastify, parsers com corpo cru, /health
  index.ts             bootstrap: migrations, servidor, workers, shutdown
  clients/
    http.ts            fetch com timeout, HttpError com flag de retry
    wuzapi.ts          sessÃ£o, webhook, envio, download, grupos
    chatwoot.ts        inboxes, contatos, conversas, mensagens, anexos
  core/
    jid.ts             JID â†” telefone â†” alvo do WuzAPI
    normalize.ts       payload do WuzAPI â†’ evento estÃ¡vel
    media.ts           mimetype â†’ extensÃ£o / endpoint de envio
    transcode.ts       conversÃ£o de Ã¡udio para OGG/Opus
    resolve.ts         contato e conversa no Chatwoot
    inbound.ts         WhatsApp â†’ Chatwoot
    outbound.ts        Chatwoot â†’ WhatsApp
    capture.ts         buffer de webhooks crus para diagnÃ³stico
  db/                  pool, migrations embutidas, repositÃ³rios
  queue/               filas e workers BullMQ
  routes/              webhooks, admin, painel, verificaÃ§Ã£o de assinatura
  scripts/             smoke, smoke-http, probe, create-tenant
```

`npm run smoke` roda 45 verificaÃ§Ãµes sem precisar de Postgres, Redis ou rede: 26 de lÃ³gica pura
(JID, normalizaÃ§Ã£o, roteamento e conversÃ£o de mÃ­dia, allowlist, IDs determinÃ­sticos) e 19 de HTTP
(HMAC, auth, parsers, painel).

`src/scripts/probe.ts` sonda WuzAPI e Chatwoot em modo somente-leitura â€” Ãºtil para validar
credenciais e formatos antes de qualquer escrita.

---

## DivergÃªncias entre os specs e a realidade

Encontradas testando contra instÃ¢ncias reais. EstÃ£o tratadas no cÃ³digo, mas valem registro:

**`POST /webhook` do WuzAPI usa `webhookurl`, nÃ£o `webhook`.** O OpenAPI documenta `webhook`; com
essa chave a API responde `HTTP 200, success: true` e grava string vazia. O HUB envia as duas chaves
e **relÃª o webhook apÃ³s gravar**, falhando se nÃ£o bateu.

**EndereÃ§amento por LID.** O WhatsApp passou a identificar remetentes por um ID opaco (`@lid`) em vez
do telefone. O telefone vem em `Info.SenderAlt` (entrada) e `Info.RecipientAlt` (saÃ­da) â€” nÃ£o aparece
em `/user/contacts`. O HUB prefere sempre o JID de telefone e guarda o LID como atributo.

**Upload multipart no Chatwoot.** `attachments[]` em `POST /messages` nÃ£o estÃ¡ no swagger, mas
funciona e Ã© o Ãºnico caminho para anexos.

---

## Escopo

Cobre texto, mÃ­dia (imagem, vÃ­deo, Ã¡udio, documento, sticker), localizaÃ§Ã£o, contato e grupos, nos
dois sentidos, com espelhamento das mensagens enviadas pelo celular.

NÃ£o cobre: status de entrega e leitura, reaÃ§Ãµes, ediÃ§Ã£o e exclusÃ£o de mensagem, botÃµes e listas
interativas. `normalize.ts` jÃ¡ extrai reaÃ§Ãµes e `quotedWaMessageId` â€” sÃ£o os pontos de partida
naturais.
