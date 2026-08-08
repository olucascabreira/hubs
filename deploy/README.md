# Deploy

## Qual stack usar

| Sua situação | Arquivo |
|---|---|
| Já tenho Postgres e Redis na infra | [`stack-externo.yml`](stack-externo.yml) |
| Não tenho, quero tudo junto | [`stack-template.yml`](stack-template.yml) |
| Desenvolvimento na minha máquina | [`../docker-compose.yml`](../docker-compose.yml) |

As duas primeiras são para **Docker Swarm + Portainer + Traefik** e usam a imagem publicada num
registry. Para Docker standalone, mova o bloco `deploy.labels` para `labels` em cada serviço e
remova o restante de `deploy`.

---

## Pré-requisitos

- Traefik com um resolver TLS configurado
- DNS do domínio do HUB apontando para o Traefik
- A rede externa do Traefik já existente (`docker network ls`)
- Imagem publicada — veja [Publicar a imagem](#publicar-a-imagem)

---

## Instalação

Portainer → Stacks → Add stack → Web editor → cole a stack escolhida.

Em *Environment variables*, preencha. O editor lê cada linha como `CHAVE=valor` e **não aceita
comentários nem linhas em branco**.

### Com Postgres e Redis próprios (`stack-externo.yml`)

```
HUB_IMAGE=ghcr.io/OWNER/REPO:1.0.0
HUB_DOMAIN=hub.seudominio.com.br
ADMIN_TOKEN=<openssl rand -hex 32>
DATABASE_URL=postgres://hub:senha@postgres:5432/hub
REDIS_URL=redis://redis:6379/3
TRAEFIK_NETWORK=<docker network ls>
CERT_RESOLVER=<resolver do seu Traefik>
```

Antes, crie o banco — **não reuse o do Chatwoot**:

```sql
CREATE DATABASE hub;
CREATE USER hub WITH ENCRYPTED PASSWORD 'trocar';
GRANT ALL PRIVILEGES ON DATABASE hub TO hub;
\c hub
GRANT ALL ON SCHEMA public TO hub;   -- necessário no Postgres 15+
```

Esse último `GRANT` costuma ser esquecido: no Postgres 15+ o schema `public` deixou de ser gravável
por padrão, e sem ele as migrations falham no boot. As tabelas o HUB cria sozinho.

No Redis, isole em duas camadas: um número de banco próprio na URL (`/3`) e o `REDIS_PREFIX`
(default `hub`), que separa as chaves do BullMQ das de outras aplicações.

Use o **nome do serviço** nas URLs (`postgres:5432`), não `localhost`. Se Postgres e Redis estiverem
noutra rede Docker, acrescente-a em `networks` na stack.

### Com tudo junto (`stack-template.yml`)

```
HUB_IMAGE=ghcr.io/OWNER/REPO:1.0.0
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

O campo `build` informa o commit em execução — é assim que se confirma que um deploy chegou ao
serviço. Depois, abra `/ui` para cadastrar a primeira instância.

---

## Publicar a imagem

Uma vez, por quem mantém o projeto:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

O workflow [`publish.yml`](../.github/workflows/publish.yml) roda typecheck e testes, constrói para
`amd64` e `arm64` e publica em `ghcr.io/OWNER/REPO` com as tags `1.0.0`, `1.0` e `latest`.
Imagem privada? Cadastre as credenciais em Portainer → Registries.

Prefira a tag de versão a `:latest`: o Swarm fixa a imagem pelo ID resolvido no deploy, e uma tag
móvel torna difícil saber o que está rodando.

### Sem registry

Dá para construir num nó e usar a imagem local, com duas ressalvas: o serviço fica preso a esse nó
(sem failover) e cada atualização exige repetir o processo.

```bash
# leve o código até um nó do Swarm
scp hub.bundle usuario@servidor:/opt/
cd /opt && git clone hub.bundle hub && cd hub
bash deploy/build-on-node.sh
```

O script constrói, marca com `latest` e com o SHA do commit, e aplica no serviço. Na stack, use
`HUB_IMAGE=wuzapi-chatwoot-hub:latest` e acrescente ao `deploy` do serviço `hub`:

```yaml
      placement:
        constraints:
          - node.hostname == NOME_DO_NO      # docker node ls
```

Sem esse constraint o Swarm pode agendar num nó que não tem a imagem, e o serviço trava em
*"no suitable node"*.

---

## Atualizar

Com registry: troque `HUB_IMAGE` para a nova tag e atualize a stack.

Sem registry, na mesma máquina do build:

```bash
cd /opt/hub && git pull && bash deploy/build-on-node.sh
```

O Swarm fixa a imagem pelo ID no momento do deploy — reconstruir a tag `latest` **não** troca o que
o serviço executa. Por isso o script usa `docker service update --image ... --no-resolve-image
--force`. Confirme sempre pelo campo `build` do `/health`.

---

## Rollback

O provisionamento faz duas escritas fora do HUB:

1. **Inbox no Chatwoot** — apague em Configurações → Caixas de Entrada
2. **Webhook no WuzAPI** — sobrescrito no provisionamento

Excluir a instância pelo painel já remove o webhook do WuzAPI. O inbox é preservado de propósito,
porque guarda o histórico das conversas.

Derrubar a stack não desfaz nenhuma das duas.
