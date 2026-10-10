# ── Ping IA (bot administrativo do Telegram) ─────────────────────────────
# Processo separado da API. Sobe o agente `hermes/bot-ia.ts`, que lê a
# configuração da tabela `bot_config` (Configurações → Bot Ping IA) e relê a
# cada 15s — por isso ligar o switch no dashboard já o coloca no ar, sem
# reiniciar o container.
#
# Build a partir da raiz do projeto (o contexto precisa de package.json, de
# server/, de src/lib/ e de hermes/):
#   docker build -f hermes/Dockerfile -t pingos-bot .
#
# Variáveis necessárias no container: MYSQL_* (para ler a config e executar as
# ferramentas) e ADMIN_ID (o Id numérico do administrador no Telegram).

FROM oven/bun:1-slim

WORKDIR /app

# Dependências primeiro (camada em cache)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Código do bot + o backend/módulos compartilhados que ele importa
# (pool do MySQL, carregador de env, notificações).
COPY server/ ./server/
COPY src/lib/ ./src/lib/
COPY hermes/ ./hermes/

ENV NODE_ENV=production

# O agente fica no ar com long polling (não abre porta) e trata SIGTERM —
# o container encerra limpo em deploys/restarts.
CMD ["bun", "run", "hermes/bot-ia.ts"]
