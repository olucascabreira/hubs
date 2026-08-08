# HUB WuzAPI ↔ Chatwoot

Integração bidirecional entre **WuzAPI** (WhatsApp via whatsmeow) e **Chatwoot**.
Multi-tenant: N números de WhatsApp ↔ N inboxes do Chatwoot numa única instalação.

```
WhatsApp ──► WuzAPI ──webhook──► HUB ──API──► Chatwoot   mensagem recebida
WhatsApp ◄── WuzAPI ◄───API──── HUB ◄webhook─ Chatwoot   resposta do agente
```

No Chatwoot cada número vira um **inbox de canal API**, criado automaticamente pelo HUB, com o
`webhook_url` apontando de volta para ele.

---

## Instalação

Requisitos do ambiente:

- Docker Swarm ou Docker standalone, com Portainer
- Traefik com um resolver TLS configurado
- DNS do domínio do HUB apontando para o Traefik
- WuzAPI e Chatwoot acessíveis (pela internet ou pela rede interna do Docker)

Postgres e Redis vêm na própria stack — nada a provisionar à parte.

### 1. Publicar a imagem (uma vez, por quem mantém o projeto)

```bash
git tag v1.0.0 && git push origin v1.0.0
```

O workflow [`publish.yml`](.github/workflows/publish.yml) roda typecheck e os testes, constrói para
`amd64` e `arm64` e publica em `ghcr.io/olucascabreira/hubs` com as tags `1.0.0`, `1.0` e `latest`.

Sem registry disponível? Veja [deploy/README.md](deploy/README.md) para o caminho a partir do
código-fonte — funciona, mas exige construir num nó e prender o serviço a ele.

### 2. Subir a stack

Portainer → Stacks → Add stack → Web editor. Duas opções, conforme sua infraestrutura:

| Sua situação | Arquivo |
|---|---|
| Já tenho Postgres e Redis | [`deploy/stack-externo.yml`](deploy/stack-externo.yml) |
| Não tenho, quero tudo junto | [`deploy/stack-template.yml`](deploy/stack-template.yml) |

Usando os seus serviços, crie um banco dedicado antes (não reuse o do Chatwoot) e isole o Redis num
número de banco próprio — o passo a passo está em [deploy/README.md](deploy/README.md).

Para a stack autossuficiente, as variáveis obrigatórias são cinco:

```
HUB_IMAGE=ghcr.io/olucascabreira/hubs:1.0.0
HUB_DOMAIN=hub.seudominio.com.br
ADMIN_TOKEN=<openssl rand -hex 32>
POSTGRES_PASSWORD=<openssl rand -hex 16>
TRAEFIK_NETWORK=<docker network ls>
CERT_RESOLVER=<resolver do seu Traefik>
```

O editor do Portainer lê cada linha como `CHAVE=valor` e **não aceita comentários nem linhas em
branco**. As demais variáveis têm default e estão documentadas no template.

Prefira a tag de versão a `:latest`: o Swarm fixa a imagem pelo ID resolvido no deploy, e uma tag
móvel torna difícil saber o que está rodando.

### 3. Conferir

```bash
curl -s https://hub.seudominio.com.br/health
```

```json
{ "status": "ok", "build": "e706963", "database": "ok", "redis": "ok", "queues": { ... } }
```

O campo `build` informa o commit em execução — é como se confirma que um deploy realmente chegou ao
serviço. As migrations rodam sozinhas no boot.

### 4. Criar a instância no WuzAPI

Cada número precisa de um usuário próprio no WuzAPI, com token próprio. Pelo dashboard em
`/dashboard`, ou pela API:

```bash
curl -X POST https://SEU_WUZAPI/admin/users \
  -H "Authorization: $WUZAPI_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Loja Centro","token":"UM_TOKEN_FORTE_E_UNICO"}'
```

Atenção: aqui é o `WUZAPI_ADMIN_TOKEN` (header `Authorization`), diferente do token de instância
(header `token`). Guarde o token definido — é ele que vai no passo seguinte.

Reaproveitar o mesmo token entre instâncias faria as duas apontarem para a mesma sessão do WhatsApp.

### 5. Cadastrar no HUB e parear

Abra `https://hub.seudominio.com.br/ui`, informe o `ADMIN_TOKEN` e clique em **+ Nova instância**.
Ao salvar, o HUB cria o inbox no Chatwoot e grava o webhook no WuzAPI numa operação só.

Depois, **Conectar sessão** e leia o QR que aparece na tela, no WhatsApp em *Aparelhos conectados*.

O `slug` entra na URL do webhook (`/webhooks/wuzapi/<slug>`): escolha algo estável, porque mudá-lo
depois exige reprovisionar.

---

## Painel

`https://SEU_HUB/ui` — página única, sem build e sem dependência externa.

| Seção | O que faz |
|---|---|
| Saúde | build em execução, Postgres, Redis e filas, atualizando a cada 15s |
| Instâncias | seletor, criar, reprovisionar, conectar sessão, excluir |
| Status | sessão pareada e se cada webhook confere com o esperado |
| Pareamento | QR renderizado |
| Comportamento | as flags em checkbox, salvando na hora |
| Grupos | lista com filtro e seleção por checkbox |
| Capturas | últimos webhooks crus, para diagnóstico |

A página em si não exige token — é HTML sem segredo. Todas as chamadas de dados exigem o
`X-Admin-Token`, que fica apenas no `sessionStorage` da aba.

O painel não edita credenciais, de propósito. Para rotacionar tokens, use a API:

```bash
curl -X PATCH https://SEU_HUB/admin/tenants/<slug> \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"chatwoot_api_token":"NOVO_TOKEN"}'
```

---

## Como funciona

### Entrada — WhatsApp → Chatwoot

1. WuzAPI entrega o evento em `POST /webhooks/wuzapi/:slug`.
2. Assinatura HMAC é conferida sobre o corpo cru, se houver segredo configurado.
3. Eventos que não são `Message` são descartados na porta — `Presence` e `ReadReceipt` chegam em volume alto.
4. O evento entra na fila e a resposta sai em milissegundos; o WuzAPI reenvia se demorar.
5. O worker normaliza, resolve contato e conversa, baixa a mídia e cria a mensagem.

### Saída — Chatwoot → WhatsApp

1. O inbox chama `POST /webhooks/chatwoot/:slug` em `message_created`.
2. São descartadas: notas privadas, mensagens `incoming`, e mensagens com `source_id` preenchido —
   essas vieram do WhatsApp, e reenviá-las criaria loop.
3. O worker resolve o destino, baixa os anexos e envia pelo endpoint correto do WuzAPI.

### Identidade e deduplicação

| Conceito | Chave |
|---|---|
| Contato | `identifier` = `wa:<jid>`, com fallback por telefone |
| Canal do contato | `contact_inbox.source_id` = o JID |
| Conversa | uma por chat, reaberta quando resolvida |
| Mensagem entrando | `UNIQUE (tenant_id, wa_message_id)` + `jobId` no BullMQ |
| Mensagem saindo | stanza ID determinístico `3EB0 + sha1(tenant:message_id:index)` |

O ID determinístico é o que impede duplicata: reprocessar o mesmo job gera o mesmo ID, e o eco do
WhatsApp encontra o registro já existente.

Isso não é teórico — o Chatwoot dispara `message_created` **três vezes** para mensagens com anexo.
Sem a deduplicação, todo anexo sairia em triplicata.

### Contatos que já existem

Se o número já é contato no Chatwoot — criado pelo canal oficial ou por outra integração — o HUB
**reaproveita** esse contato em vez de duplicar, e não altera nenhum campo dele. Um contato pode
servir vários inboxes; é a modelagem correta do Chatwoot.

### Grupos

O grupo vira **um contato** com o nome Assunto do grupo (Grupo) e sem telefone — o sufixo
evita confundi-lo com uma pessoa na lista de conversas, e sai de GROUP_NAME_SUFFIX. Cada mensagem recebe o prefixo
`*Nome do participante*:`, e `content_attributes` guarda o autor real.

Com `handle_groups` ligado e `group_allowlist` vazia, **todos** os grupos viram conversa — numa conta
com dezenas de grupos isso enche o Chatwoot. Use o painel para selecionar quais interessam.

| `handle_groups` | `group_allowlist` | Efeito |
|---|---|---|
| `false` | — | nenhum grupo |
| `true` | vazia | todos |
| `true` | com itens | somente os listados |

### Mídia

**Entrada:** usa o base64 embutido no webhook quando existe; senão chama `/chat/download*` com
`MediaKey`/`FileEncSHA256`/`DirectPath`, e sobe como anexo multipart. Falha de download não perde a
mensagem — o texto vai com um aviso no lugar do anexo.

**Saída:** `file_type` e mimetype decidem o endpoint.

Áudio tem tratamento próprio, porque nota de voz no WhatsApp exige OGG/Opus e um mp3 marcado como
nota de voz chega quebrado, sem erro no envio:

| Origem | Envio |
|---|---|
| qualquer formato, com ffmpeg | convertido para OGG/Opus → nota de voz |
| já era OGG/Opus | direto, sem reprocessar |
| mp3/m4a/aac, sem ffmpeg | arquivo de áudio com player |
| wav/webm, sem ffmpeg | documento |

O ffmpeg vem na imagem. Se faltar, o HUB degrada em vez de falhar.

---

## Flags por instância

| Flag | Padrão | Efeito |
|---|---|---|
| `handle_groups` | `true` | espelha conversas de grupo |
| `group_allowlist` | `[]` | vazia = todos os grupos permitidos |
| `group_sender_prefix` | `true` | prefixa `*Participante*:` |
| `mirror_own_messages` | `true` | mensagens enviadas pelo celular aparecem como `outgoing` |
| `reopen_resolved` | `true` | reabre a conversa resolvida em vez de criar outra |
| `active` | `true` | `false` faz o HUB ignorar os webhooks sem apagar nada |

Com `mirror_own_messages` ligado, **toda pessoa que você mensagear pelo celular vira conversa** —
inclusive contatos pessoais. Faz sentido em número dedicado a atendimento; em número misto,
considere desligar.

---

## API administrativa

Todas exigem o header `X-Admin-Token`.

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/health` | status, build e filas (sem token) |
| `GET` | `/ui` | painel (sem token) |
| `GET` | `/admin/config` | defaults não-secretos |
| `GET` | `/admin/tenants` | lista instâncias |
| `POST` | `/admin/tenants` | cria e provisiona |
| `GET` | `/admin/tenants/:slug` | detalhe |
| `PATCH` | `/admin/tenants/:slug` | atualiza credenciais e flags |
| `DELETE` | `/admin/tenants/:slug` | remove; limpa o webhook do WuzAPI |
| `POST` | `/admin/tenants/:slug/provision` | reprovisiona, idempotente |
| `GET` | `/admin/tenants/:slug/status` | sessão, webhooks e inbox |
| `POST` | `/admin/tenants/:slug/connect` | conecta a sessão |
| `GET` | `/admin/tenants/:slug/qr` | QR para parear |
| `GET` | `/admin/tenants/:slug/groups` | grupos, com quais estão liberados |
| `PUT` | `/admin/tenants/:slug/groups/allowlist` | define a lista de permissão |
| `GET` | `/admin/tenants/:slug/captures` | webhooks crus recebidos |

### Excluir uma instância

Remove o webhook do WuzAPI e apaga os vínculos. **Não** apaga o inbox do Chatwoot — ele guarda o
histórico das conversas, e isso deve ser decisão consciente. Também não desconecta a sessão.

Para uma pausa, prefira desmarcar **Instância ativa**: nada é apagado.

---

## Segurança

- `/admin/*` protegido por `X-Admin-Token`, com comparação em tempo constante.
- HMAC-SHA256 opcional por instância nos dois webhooks, validado sobre o corpo cru.
- Tokens nunca voltam pela API nem aparecem nos logs.
- `CAPTURE_RAW_WEBHOOKS` grava conteúdo de conversas reais. Ligue só para diagnosticar.
- `/ui` e `/health` são públicos e não contêm segredo. Para restringir `/admin` por IP, use
  `ADMIN_ALLOWED_IPS` no Traefik.

---

## Operação

`GET /health` devolve Postgres, Redis, contadores das filas e o commit em execução.

Jobs tentam 5 vezes com backoff exponencial. Erros HTTP 4xx (fora de 408/429) não são repetidos —
um 422 do Chatwoot não melhora na segunda tentativa. Falhas ficam 7 dias no Redis.

Ajuste de carga: `INBOUND_CONCURRENCY`, `OUTBOUND_CONCURRENCY`, `JOB_ATTEMPTS`, `JOB_BACKOFF_MS`.

### Troubleshooting

**Mensagem não chega no Chatwoot** — `/admin/tenants/:slug/status`: o webhook do WuzAPI deve bater
com o esperado. Se divergir, use *Reprovisionar*. Depois confira `failed` em `/health`.

**Resposta do agente não sai** — o webhook do Chatwoot é do *inbox*, não da conta. *Reprovisionar*
reescreve.

**Conversa nova a cada mensagem** — `reopen_resolved` desligado, ou o `source_id` do contato mudou.

**Comportamento estranho em geral** — ligue `CAPTURE_RAW_WEBHOOKS`, reproduza, e leia o payload cru
no painel. Foi assim que todos os defeitos de campo foram encontrados.

---

## Estrutura

```
src/
  config.ts            variáveis de ambiente validadas com zod
  server.ts            Fastify, parsers com corpo cru, /health
  index.ts             bootstrap: migrations, servidor, workers, shutdown
  clients/
    http.ts            fetch com timeout, HttpError com flag de retry
    wuzapi.ts          sessão, webhook, envio, download, grupos
    chatwoot.ts        inboxes, contatos, conversas, mensagens, anexos
  core/
    jid.ts             JID ↔ telefone ↔ alvo do WuzAPI
    normalize.ts       payload do WuzAPI → evento estável
    media.ts           mimetype → extensão / endpoint de envio
    transcode.ts       conversão de áudio para OGG/Opus
    resolve.ts         contato e conversa no Chatwoot
    inbound.ts         WhatsApp → Chatwoot
    outbound.ts        Chatwoot → WhatsApp
    capture.ts         buffer de webhooks crus para diagnóstico
  db/                  pool, migrations embutidas, repositórios
  queue/               filas e workers BullMQ
  routes/              webhooks, admin, painel, verificação de assinatura
  scripts/             smoke, smoke-http, probe, create-tenant
```

`npm run smoke` roda 45 verificações sem precisar de Postgres, Redis ou rede: 26 de lógica pura
(JID, normalização, roteamento e conversão de mídia, allowlist, IDs determinísticos) e 19 de HTTP
(HMAC, auth, parsers, painel).

`src/scripts/probe.ts` sonda WuzAPI e Chatwoot em modo somente-leitura — útil para validar
credenciais e formatos antes de qualquer escrita.

---

## Divergências entre os specs e a realidade

Encontradas testando contra instâncias reais. Estão tratadas no código, mas valem registro:

**`POST /webhook` do WuzAPI usa `webhookurl`, não `webhook`.** O OpenAPI documenta `webhook`; com
essa chave a API responde `HTTP 200, success: true` e grava string vazia. O HUB envia as duas chaves
e **relê o webhook após gravar**, falhando se não bateu.

**Endereçamento por LID.** O WhatsApp passou a identificar remetentes por um ID opaco (`@lid`) em vez
do telefone. O telefone vem em `Info.SenderAlt` (entrada) e `Info.RecipientAlt` (saída) — não aparece
em `/user/contacts`. O HUB prefere sempre o JID de telefone e guarda o LID como atributo.

**Upload multipart no Chatwoot.** `attachments[]` em `POST /messages` não está no swagger, mas
funciona e é o único caminho para anexos.

---

## Escopo

Cobre texto, mídia (imagem, vídeo, áudio, documento, sticker), localização, contato e grupos, nos
dois sentidos, com espelhamento das mensagens enviadas pelo celular.

Não cobre: status de entrega e leitura, reações, edição e exclusão de mensagem, botões e listas
interativas. `normalize.ts` já extrai reações e `quotedWaMessageId` — são os pontos de partida
naturais.
