#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Constroi a imagem do HUB num no do Swarm.
#
#   ./build-on-node.sh                      # imagem local
#   ./build-on-node.sh ghcr.io/user/hub:1.0 # constroi, marca e faz push
#
# Marca com `latest` E com o commit atual. A tag por commit importa: o Swarm
# fixa a imagem pelo ID no momento em que o servico e criado, entao
# reconstruir `latest` NAO troca o que o servico executa.
# ---------------------------------------------------------------------------
set -euo pipefail

IMAGE_LOCAL="wuzapi-chatwoot-hub"
IMAGE_REMOTE="${1:-}"
SERVICE="${SERVICE_NAME:-hub_hub}"

cd "$(dirname "$0")/.."

if [ ! -f Dockerfile ]; then
  echo "ERRO: Dockerfile nao encontrado. Rode a partir do repositorio do HUB." >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"
echo "==> Diretorio : $(pwd)"
echo "==> Commit    : ${SHA}"
echo "==> No        : $(hostname)"

echo
echo "==> Construindo ${IMAGE_LOCAL}:${SHA} (e :latest)"
docker build -t "${IMAGE_LOCAL}:${SHA}" -t "${IMAGE_LOCAL}:latest" .

if [ -n "${IMAGE_REMOTE}" ]; then
  echo
  echo "==> Publicando ${IMAGE_REMOTE}"
  docker tag "${IMAGE_LOCAL}:${SHA}" "${IMAGE_REMOTE}"
  docker push "${IMAGE_REMOTE}"
  TARGET="${IMAGE_REMOTE}"
else
  TARGET="${IMAGE_LOCAL}:${SHA}"
fi

echo
echo "==========================================================="
echo "Imagem pronta: ${TARGET}"
echo
if docker service inspect "${SERVICE}" >/dev/null 2>&1; then
  echo "Aplicando no servico ${SERVICE}..."
  # --no-resolve-image: sem registry, o Swarm nao consegue resolver o digest
  # e recusaria a atualizacao.
  docker service update \
    --image "${TARGET}" \
    --no-resolve-image \
    --force \
    "${SERVICE}"
  echo
  echo "Estado das tasks:"
  docker service ps "${SERVICE}" --no-trunc | head -5
else
  echo "Servico ${SERVICE} nao encontrado neste no."
  echo "Depois de subir a stack, aplique a imagem com:"
  echo
  echo "  docker service update --image ${TARGET} --no-resolve-image --force ${SERVICE}"
fi
echo "==========================================================="
