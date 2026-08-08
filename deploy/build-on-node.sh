#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Constroi a imagem do HUB num no do Swarm.
#
# Rode ISTO no no onde a stack vai executar (o mesmo que voce vai informar em
# BUILD_NODE_HOSTNAME), ou publique num registry para liberar qualquer no.
#
#   ./build-on-node.sh                      # imagem local
#   ./build-on-node.sh ghcr.io/user/hub:1.0 # constroi, marca e faz push
# ---------------------------------------------------------------------------
set -euo pipefail

IMAGE_LOCAL="wuzapi-chatwoot-hub:latest"
IMAGE_REMOTE="${1:-}"

cd "$(dirname "$0")/.."

echo "==> Diretorio de build: $(pwd)"
if [ ! -f Dockerfile ]; then
  echo "ERRO: Dockerfile nao encontrado. Rode a partir do repositorio do HUB." >&2
  exit 1
fi

echo "==> Construindo ${IMAGE_LOCAL}"
docker build -t "${IMAGE_LOCAL}" .

if [ -n "${IMAGE_REMOTE}" ]; then
  echo "==> Marcando e publicando ${IMAGE_REMOTE}"
  docker tag "${IMAGE_LOCAL}" "${IMAGE_REMOTE}"
  docker push "${IMAGE_REMOTE}"
  echo
  echo "Pronto. Na stack use:"
  echo "  HUB_IMAGE=${IMAGE_REMOTE}"
  echo "  (com registry voce NAO precisa de BUILD_NODE_HOSTNAME)"
else
  echo
  echo "Pronto. Imagem existe SOMENTE neste no: $(hostname)"
  echo "Na stack use:"
  echo "  HUB_IMAGE=${IMAGE_LOCAL}"
  echo "  BUILD_NODE_HOSTNAME=$(hostname)"
  echo
  echo "Sem esse constraint o Swarm pode agendar num no sem a imagem e o"
  echo "servico fica preso em 'no suitable node'."
fi

echo
echo "==> Nos do Swarm:"
docker node ls 2>/dev/null || echo "(rode num manager para listar)"
