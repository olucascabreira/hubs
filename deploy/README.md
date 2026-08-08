# Deploy

## Qual stack usar

| Sua situaÃ§Ã£o | Arquivo |
|---|---|
| JÃ¡ tenho Postgres e Redis na infra | [`stack-externo.yml`](stack-externo.yml) |
| NÃ£o tenho, quero tudo junto | [`stack-template.yml`](stack-template.yml) |
| Desenvolvimento na minha mÃ¡quina | [`../docker-compose.yml`](../docker-compose.yml) |

As duas primeiras sÃ£o para **Docker Swarm + Portainer + Traefik** e usam a imagem publicada num
registry. Para Docker standalone, mova o bloco `deploy.labels` para `labels` em cada serviÃ§o e
remova o restante de `deploy`.

---

## PrÃ©-requisitos

- Traefik com um resolver TLS configurado
- DNS do domÃ­nio do HUB apontando para o Traefik
- A rede externa do Traefik jÃ¡ existente (`docker network ls`)
- Imagem publicada â€” veja [Publicar a imagem](#publicar-a-imagem)

---

## InstalaÃ§Ã£o

Portainer â†’ Stacks â†’ Add stack â†’ Web editor â†’ cole a stack escolhida.

Em *Environment variables*, preencha. O editor lÃª cada linha como `CHAVE=valor` e **nÃ£o aceita
comentÃ¡rios nem linhas em branco**.

### Com Postgres e Redis prÃ³prios (`stack-externo.yml`)

```
HUB_IMAGE=ghcr.io/olucascabreira/hub:1.0.0
HUB_DOMAIN=hub.seudominio.com.br
ADMIN_TOKEN=<openssl rand -hex 32>
DATABASE_URL=postgres://hub:senha@postgres:5432/hub
REDIS_URL=redis://redis:6379/3
TRAEFIK_NETWORK=<docker network ls>
CERT_RESOLVER=<resolver do seu Traefik>
```

Antes, crie o banco â€” **nÃ£o reuse o do Chatwoot**:

```sql
CREATE DATABASE hub;
CREATE USER hub WITH ENCRYPTED PASSWORD 'trocar';
GRANT ALL PRIVILEGES ON DATABASE hub TO hub;
\c hub
GRANT ALL ON SCHEMA public TO hub;   -- necessÃ¡rio no Postgres 15+
```

Esse Ãºltimo `GRANT` costuma ser esquecido: no Postgres 15+ o schema `public` deixou de ser gravÃ¡vel
por padrÃ£o, e sem ele as migrations falham no boot. As tabelas o HUB cria sozinho.

No Redis, isole em duas camadas: um nÃºmero de banco prÃ³prio na URL (`/3`) e o `REDIS_PREFIX`
(default `hub`), que separa as chaves do BullMQ das de outras aplicaÃ§Ãµes.

Use o **nome do serviÃ§o** nas URLs (`postgres:5432`), nÃ£o `localhost`. Se Postgres e Redis estiverem
noutra rede Docker, acrescente-a em `networks` na stack.

### Com tudo junto (`stack-template.yml`)

```
HUB_IMAGE=ghcr.io/olucascabreira/hub:1.0.0
HUB_DOMAIN=hub.seudominio.com.br
ADMIN_TOKEN=<openssl rand -hex 32>
POSTGRES_PASSWORD=<openssl rand -hex 16>
TRAEFIK_NETWORK=<docker network ls>
CERT_RESOLVER=<resolver do seu Traefik>
```

---

## Conferir

```bash
curl -s https://hub.seudominio.com.br/health
```

```json
{ "status": "ok", "build": "edf5322", "database": "ok", "redis": "ok", "queues": { ... } }
```

O campo `build` informa o commit em execuÃ§Ã£o â€” Ã© assim que se confirma que um deploy chegou ao
serviÃ§o. Depois, abra `/ui` para cadastrar a primeira instÃ¢ncia.

---

## Publicar a imagem

Uma vez, por quem mantÃ©m o projeto:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

O workflow [`publish.yml`](../.github/workflows/publish.yml) roda typecheck e testes, constrÃ³i para
`amd64` e `arm64` e publica em `ghcr.io/olucascabreira/hub` com as tags `1.0.0`, `1.0` e `latest`.
Imagem privada? Cadastre as credenciais em Portainer â†’ Registries.

Prefira a tag de versÃ£o a `:latest`: o Swarm fixa a imagem pelo ID resolvido no deploy, e uma tag
mÃ³vel torna difÃ­cil saber o que estÃ¡ rodando.

### Sem registry

DÃ¡ para construir num nÃ³ e usar a imagem local, com duas ressalvas: o serviÃ§o fica preso a esse nÃ³
(sem failover) e cada atualizaÃ§Ã£o exige repetir o processo.

```bash
# leve o cÃ³digo atÃ© um nÃ³ do Swarm
scp hub.bundle usuario@servidor:/opt/
cd /opt && git clone hub.bundle hub && cd hub
bash deploy/build-on-node.sh
```

O script constrÃ³i, marca com `latest` e com o SHA do commit, e aplica no serviÃ§o. Na stack, use
`HUB_IMAGE=wuzapi-chatwoot-hub:latest` e acrescente ao `deploy` do serviÃ§o `hub`:

```yaml
      placement:
        constraints:
          - node.hostname == NOME_DO_NO      # docker node ls
```

Sem esse constraint o Swarm pode agendar num nÃ³ que nÃ£o tem a imagem, e o serviÃ§o trava em
*"no suitable node"*.

---

## Atualizar

Com registry: troque `HUB_IMAGE` para a nova tag e atualize a stack.

Sem registry, na mesma mÃ¡quina do build:

```bash
cd /opt/hub && git pull && bash deploy/build-on-node.sh
```

O Swarm fixa a imagem pelo ID no momento do deploy â€” reconstruir a tag `latest` **nÃ£o** troca o que
o serviÃ§o executa. Por isso o script usa `docker service update --image ... --no-resolve-image
--force`. Confirme sempre pelo campo `build` do `/health`.

---

## Rollback

O provisionamento faz duas escritas fora do HUB:

1. **Inbox no Chatwoot** â€” apague em ConfiguraÃ§Ãµes â†’ Caixas de Entrada
2. **Webhook no WuzAPI** â€” sobrescrito no provisionamento

Excluir a instÃ¢ncia pelo painel jÃ¡ remove o webhook do WuzAPI. O inbox Ã© preservado de propÃ³sito,
porque guarda o histÃ³rico das conversas.

Derrubar a stack nÃ£o desfaz nenhuma das duas.
