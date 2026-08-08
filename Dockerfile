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
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN addgroup -S hub && adduser -S hub -G hub

# O ponto de montagem do volume nasce pertencendo ao root. Criar o diretorio
# com o dono certo ANTES do VOLUME faz o Docker preservar essa permissao ao
# inicializar o volume — sem isso a escrita falha com EACCES.
RUN mkdir -p /data/captures && chown -R hub:hub /data
VOLUME /data/captures

USER hub

EXPOSE 3000
CMD ["node", "dist/index.js"]
