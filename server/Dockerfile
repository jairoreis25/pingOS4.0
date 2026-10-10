# ── PingOS WhatsApp bridge (Baileys) ─────────────────────────────────────
# Same process as `bun run whatsapp` locally: server/whatsapp-web-server.ts
# on port 3001 (HTTP) + a persistent WhatsApp Web session in a volume.
#
# Build from the project root (context = repo root) so src/ and package.json
# are available:
#   docker build -f server/Dockerfile -t pingos-whatsapp .

FROM oven/bun:1-slim
WORKDIR /app

# Install deps first (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the server code
COPY server/whatsapp-web-server.ts ./server/
COPY src/lib/desc-fields.ts ./src/lib/

# Persistent WhatsApp session (survives container restarts)
ENV PORT=3001 \
    SESSION_DIR=/data/whatsapp-session
VOLUME /data/whatsapp-session

EXPOSE 3001
CMD ["bun", "run", "server/whatsapp-web-server.ts"]
