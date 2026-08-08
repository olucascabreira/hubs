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

## Passo a passo — Swarm multi-nó (use `portainer-stack-swarm.yml`)

O Swarm não constrói imagem, então ela precisa existir antes da stack subir.
Em multi-nó há duas rotas; a diferença é só se o serviço pode migrar de nó.

### 1. Levar o código para um nó

O repositório vira um arquivo único com `git bundle` (já gerado em `hub.bundle`):

```bash
# da sua máquina
scp hub.bundle usuario@servidor:/opt/

# no servidor
cd /opt && git clone hub.bundle hub && cd hub
```

Alternativa: `git clone` de um repositório privado seu, se preferir versionar lá.

### 2. Construir a imagem

**Rota A — sem registry** (mais rápida, serve para homologação):

```bash
cd /opt/hub && chmod +x deploy/build-on-node.sh
./deploy/build-on-node.sh
```

O script imprime o `hostname` do nó. A imagem existe **só nele**, então a stack
precisa de `BUILD_NODE_HOSTNAME=<esse hostname>` — sem isso o Swarm pode agendar
num nó sem a imagem e o serviço trava em *"no suitable node"*.

Custo: o serviço não migra se o nó cair. Aceitável para teste, não para produção.

**Rota B — com registry** (correta para produção):

```bash
./deploy/build-on-node.sh ghcr.io/SEU_USER/wuzapi-chatwoot-hub:1.0.0
```

Cadastre as credenciais em Portainer → Registries, use `HUB_IMAGE` com esse
endereço e **deixe `BUILD_NODE_HOSTNAME` vazio** — qualquer nó serve.

### 3. Subir a stack

Portainer → Stacks → Add stack → Web editor → cole `portainer-stack-swarm.yml`.

Em **Environment variables**, use *Advanced mode* e cole o conteúdo de
[`stack.env`](stack.env). O parser do Portainer lê cada linha como `CHAVE=valor`
— **não aceita comentários (`#`) nem linhas em branco**, por isso esse arquivo
é só pares. A explicação de cada variável está na tabela acima.

Antes de subir, troque `BUILD_NODE_HOSTNAME` pelo hostname do passo 2.
Deixá-lo vazio gera o constraint `node.hostname == ` e o Swarm rejeita a stack.

### 4. Conferir

```bash
curl https://hub.impulsemidia.com.br/health
```

`status: ok` com Postgres e Redis em `ok`. Se travar em *"no suitable node"*,
revise o `BUILD_NODE_HOSTNAME` do passo 2.

## Outras diferenças do Swarm

1. Labels do Traefik vão para `deploy.labels`, não `labels`.
2. `depends_on.condition` não é suportado — o HUB tolera Postgres/Redis subindo depois.

## Rollback

O provisionamento faz exatamente duas escritas fora do HUB:

1. **Inbox novo no Chatwoot** — apague em Configurações → Caixas de Entrada.
2. **Webhook do WuzAPI** — `POST /webhook` sobrescreve; para restaurar, grave de volta o valor
   que a sonda (`probe.ts`) mostrou antes.

Derrubar a stack não desfaz nenhuma das duas.
