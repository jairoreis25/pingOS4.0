#!/bin/sh
# ── PingOS — entrypoint do container do frontend ─────────────────────────
# Gera /config.js a partir das variáveis do container, para que a URL da API
# (e da ponte do WhatsApp) possam ser trocadas com um simples restart do
# serviço, sem reconstruir a imagem.
#
# Roda como CMD do nginx (o entrypoint oficial da imagem chama este script via
# `exec "$@"`), então basta reiniciar o container para regenerar o arquivo.

set -e

TEMPLATE=/config.js.template
TARGET=/usr/share/nginx/html/config.js

if [ -f "$TEMPLATE" ]; then
    # Lista explícita de variáveis: evita substituir qualquer outro ${...} que
    # apareça no arquivo.
    envsubst '${VITE_API_URL} ${VITE_WHATSAPP_WEB_URL}' \
        < "$TEMPLATE" > "$TARGET"
    echo "[pingos] config.js gerado — api='${VITE_API_URL:-<vazio>}' (vazio = mesma origem)"
else
    echo "[pingos] aviso: $TEMPLATE não encontrado; usando os valores embutidos no build"
fi

exec "$@"
