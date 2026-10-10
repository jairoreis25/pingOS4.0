# ── PingOS API (Node/Express + MySQL) ────────────────────────────────────
# Backend paralelo ao Convex. Mesmo processo que `bun run mysql:api` roda
# localmente (server/api/index.ts), escutando na porta 4000.
#
# Build a partir da raiz do projeto (o contexto precisa de package.json, de
# server/ e dos módulos compartilhados de src/lib/):
#   docker build -f server/api/Dockerfile -t pingos-api .
#
# As credenciais NÃO ficam na imagem: são lidas do ambiente do container
# (MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE...).

FROM oven/bun:1-slim

WORKDIR /app

# Dependências primeiro (camada em cache)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Código do backend + os módulos compartilhados de `src/lib` que ele importa.
#
# A pasta inteira é copiada de propósito: o backend reusa módulos do frontend
# (`permissions.ts`, `products.ts`) e cada import novo que ficava de fora virava
# um "Cannot find module" no boot — o container da API morria e o nginx devolvia
# 502 na tela de login. Os arquivos são puros (sem React/DOM), então não custa
# nada levar o restante da pasta.
COPY server/ ./server/
COPY src/lib/ ./src/lib/

# Padrões de produção (podem ser sobrescritos pelo ambiente do serviço)
ENV NODE_ENV=production \
    API_PORT=4000 \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups \
    MYSQL_AUTO_MIGRATE=true

# Imagens dos chamados e arquivos de backup (volumes persistentes — senão
# somem a cada deploy). Monte um volume em cada um deles.
VOLUME /data/uploads
VOLUME /data/backups

EXPOSE 4000

# boot.ts aplica o schema (idempotente) e depois sobe o servidor — em Docker
# não existe o passo manual `bun run mysql:seed`.
# Localmente, siga usando `bun run server/api/index.ts` (script `mysql:api`).
CMD ["bun", "run", "server/api/boot.ts"]
