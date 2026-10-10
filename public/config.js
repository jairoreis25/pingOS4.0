// ── PingOS — configuração de runtime (fallback de desenvolvimento) ───────
// Em produção este arquivo é SUBSTITUÍDO na inicialização do container pelo
// docker-entrypoint.sh (config.js.template + variáveis do ambiente).
//
// Vazio de propósito: em dev/preview os valores vêm de `import.meta.env.*`
// (o `.env.local` do Vite). Preencher aqui teria prioridade sobre eles.
window.__PINGOS_CONFIG__ = {}
