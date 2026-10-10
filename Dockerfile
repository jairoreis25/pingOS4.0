# ── PingOS frontend ──────────────────────────────────────────────────────
# Multi-stage: bun installs deps and builds the Vite bundle; nginx serves
# the static files with SPA fallback and proxies /whatsapp-api to the
# WhatsApp bridge container.

# ── Stage 1: build ────────────────────────────────────────────────────────
FROM oven/bun:1 AS build
WORKDIR /app

# Install deps first (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build. Build args are read as env vars by Vite — eles ficam
# apenas como FALLBACK: em runtime o nginx serve /config.js gerado a partir das
# variáveis do container (ver config.js.template / docker-entrypoint.sh).
COPY . .
ARG VITE_API_URL
ARG VITE_WHATSAPP_WEB_URL
ENV VITE_API_URL=$VITE_API_URL \
    VITE_WHATSAPP_WEB_URL=$VITE_WHATSAPP_WEB_URL
RUN bun run build

# ── Stage 2: nginx runtime ───────────────────────────────────────────────
FROM nginx:1.27-alpine
# gettext fornece o `envsubst` usado para gerar o config.js de runtime.
RUN apk add --no-cache tini gettext
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Configuração de runtime: o entrypoint aplica envsubst no template e escreve
# /usr/share/nginx/html/config.js a cada start do container. Trocar a URL da
# API ou da ponte = editar a variável de ambiente + reiniciar (sem rebuild).
COPY config.js.template /config.js.template
COPY docker-entrypoint.sh /usr/local/bin/pingos-entrypoint.sh
# O `sed` é defesa em profundidade: um checkout no Windows (core.autocrlf) pode
# entregar o script com CRLF mesmo com .gitattributes, e aí o kernel procura
# "/bin/sh\r" e o container morre com exit 127 (restart loop, site fora do ar).
RUN sed -i 's/\r$//' /usr/local/bin/pingos-entrypoint.sh && chmod +x /usr/local/bin/pingos-entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/pingos-entrypoint.sh", "nginx", "-g", "daemon off;"]
