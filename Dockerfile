FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Identifica a imagem em execucao. Sem isto nao ha como saber, de fora, se um
# rebuild realmente chegou ao servico — o Swarm fixa a imagem pelo ID e uma
# tag `latest` reconstruida passa despercebida.
ARG BUILD_SHA=desconhecido
ENV BUILD_SHA=${BUILD_SHA}
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

# ffmpeg converte o audio do Chatwoot para OGG/Opus, unico formato que o
# WhatsApp aceita como nota de voz. Sem ele o HUB ainda funciona: o audio sai
# como arquivo comum, so nao como nota de voz.
RUN apk add --no-cache ffmpeg

RUN addgroup -S hub && adduser -S hub -G hub

# O ponto de montagem do volume nasce pertencendo ao root. Criar o diretorio
# com o dono certo ANTES do VOLUME faz o Docker preservar essa permissao ao
# inicializar o volume — sem isso a escrita falha com EACCES.
RUN mkdir -p /data/captures && chown -R hub:hub /data
VOLUME /data/captures

USER hub

EXPOSE 3000
CMD ["node", "dist/index.js"]
