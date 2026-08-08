# Deploy em Portainer + Traefik

O HUB entra como mais um serviço ao lado do WuzAPI e do Chatwoot. Sem túnel: o Traefik já resolve
o hostname público, e a conversa com o WuzAPI acontece pela rede interna do Docker.

```
                  ┌─────────── rede "proxy" (Traefik) ───────────┐
  internet ──► Traefik ──► hub.seudominio.com.br ──► HUB :3000
                  └──────────────────────────────────────────────┘
                  ┌─────────── rede "apps" ─────────────────────┐
                     HUB ──► wuzapi:8080      HUB ──► chatwoot:3000
                  └─────────────────────────────────────────────┘
                  ┌─────────── rede "hub_internal" ─────────────┐
                     HUB ──► hub-postgres:5432 / hub-redis:6379
                  └─────────────────────────────────────────────┘
```

## Antes de subir: descobrir os nomes das redes

Os dois `external: true` da stack precisam bater com o que já existe no host:

```bash
docker network ls

# em qual(is) rede(s) o WuzAPI está:
docker inspect $(docker ps -qf name=wuzapi) --format '{{json .NetworkSettings.Networks}}'
docker inspect $(docker ps -qf name=chatwoot) --format '{{json .NetworkSettings.Networks}}'
```

Se WuzAPI e Chatwoot estiverem em **redes diferentes**, adicione as duas ao serviço `hub` na stack.

## Variáveis no Portainer

Em *Stacks → Add stack → Environment variables*:

| Variável | Exemplo | Nota |
|---|---|---|
| `HUB_DOMAIN` | `hub.impulsemidia.com.br` | precisa de DNS apontando para o Traefik |
| `HUB_PUBLIC_URL` | `https://hub.impulsemidia.com.br` | é essa URL que fica gravada nos dois webhooks |
| `ADMIN_TOKEN` | (32+ bytes aleatórios) | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | (aleatório) | Postgres próprio do HUB |
| `TRAEFIK_NETWORK` | `proxy` | nome real da rede do Traefik |
| `APPS_NETWORK` | `apps` | rede onde WuzAPI/Chatwoot rodam |
| `CERT_RESOLVER` | `letsencrypt` | nome do resolver no seu Traefik |
| `DEFAULT_WUZAPI_BASE_URL` | `http://wuzapi:8080` | **nome do serviço**, não a URL pública |
| `DEFAULT_CHATWOOT_BASE_URL` | `https://chat.impulsemidia.com.br` | |
| `ADMIN_ALLOWED_IPS` | `203.0.113.4/32` | restringe `/admin/*` por IP |
| `CAPTURE_RAW_WEBHOOKS` | `true` só na homologação | grava conteúdo de conversas |

## Verificação

```bash
curl https://hub.seudominio.com.br/health
```

Deve responder `status: ok` com Postgres e Redis em `ok`. Se `/health` responde mas os webhooks não
chegam, o problema é rede/DNS entre os contêineres, não o HUB.

## Se for Docker Swarm

Três diferenças na stack:

1. `build:` não funciona — publique a imagem num registry e troque por `image:`.
2. Labels do Traefik vão para `deploy.labels`, não `labels`.
3. `depends_on.condition` não é suportado — o HUB já tolera Postgres/Redis subindo depois.

## Rollback

O provisionamento faz exatamente duas escritas fora do HUB:

1. **Inbox novo no Chatwoot** — apague em Configurações → Caixas de Entrada.
2. **Webhook do WuzAPI** — `POST /webhook` sobrescreve; para restaurar, grave de volta o valor
   que a sonda (`probe.ts`) mostrou antes.

Derrubar a stack não desfaz nenhuma das duas.
