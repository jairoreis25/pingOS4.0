/**
 * PingOS — API Node/Express + MySQL (backend paralelo ao Convex).
 *
 * Roda ao lado do backend Convex: o app atual continua funcionando enquanto o
 * frontend é migrado módulo a módulo para estas rotas.
 *
 * Subir:
 *   bun run mysql:api          (ou: bun server/api/index.ts)
 *
 * Variáveis: veja `mysql-api.env.example` (o arquivo `mysql-api.env` na raiz é
 * carregado automaticamente, sem sobrescrever o ambiente).
 */

import cors from "cors"
import express from "express"
import { attachUser, authRouter, purgeExpiredSessions } from "./auth"
import { loadEnvFile } from "./env"
import { errorMiddleware } from "./errors"
import { startInactivityScheduler } from "./inactivity"
import { backupsRouter } from "./routes/backups"
import { botConfigRouter } from "./routes/bot-config"
import { botPersonalidadesRouter } from "./routes/bot-personalidades"
import { metricsRouter } from "./routes/metrics"
import { inactivityRouter, notificationsRouter } from "./routes/notifications"
import { ocrChamadoRouter } from "./routes/ocr-chamado"
import { permissionsRouter } from "./routes/permissions"
import { productsRouter } from "./routes/products"
import { reportsRouter } from "./routes/reports"
import { rolesRouter } from "./routes/roles"
import { techniciansRouter } from "./routes/technicians"
import { ticketsRouter } from "./routes/tickets"
import { uploadDir, uploadsRouter } from "./routes/uploads"
import { usersRouter } from "./routes/users"
import {
  guestTicketLimiter,
  loginLimiter,
  ocrLimiter,
  setupLimiter,
  uploadLimiter,
} from "./rate-limit"
import { backupDir } from "./backup"
import { requestLogger } from "./logger"
import { closePool, dbConfigInfo, pingDatabase } from "../mysql/pool"

// Carrega mysql-api.env antes da primeira consulta ao banco (o pool é criado de
// forma preguiçosa, então esta chamada — que roda após os imports — chega antes).
const envInfo = loadEnvFile()

const app = express()
app.set("trust proxy", 1)
app.disable("x-powered-by")

// ── Logs ────────────────────────────────────────────────────────────────────
// Uma linha JSON por requisição (id, método, rota, status e latência) e o id
// devolvido no header para correlacionar com o suporte. O nível vem de
// LOG_LEVEL (padrão info).
app.use(requestLogger)
app.use((req, res, next) => {
  res.setHeader("X-Request-Id", String(req.id ?? ""))
  next()
})

// ── CORS ────────────────────────────────────────────────────────────────────
// CORS_ORIGIN aceita uma lista separada por vírgula. Sem a variável, reflete a
// origem da requisição — cômodo no desenvolvimento (Vite em outra porta) e
// atrás de um proxy que serve app e API na mesma origem.
const allowedOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  }),
)

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? "2mb" }))

// Resolve a sessão (Authorization: Bearer <token>) e anexa req.auth.

// ── Rotas ───────────────────────────────────────────────────────────────────

app.use(attachUser)

app.get("/api/health", async (_req, res) => {
  const database = await pingDatabase()
  res.status(database ? 200 : 503).json({
    status: database ? "ok" : "degraded",
    database,
    target: dbConfigInfo(),
    envFile: envInfo.file,
  })
})

// ── Rate limiting (server/api/rate-limit.ts) ────────────────────────────────
// Precisa vir ANTES dos routers: login (brute force), setup do 1º admin,
// abertura pública de chamado, upload e a leitura de O.S. por foto (IA paga).
app.use("/api/auth/login", loginLimiter)
app.use("/api/auth/setup", setupLimiter)
app.use("/api/tickets/guest", guestTicketLimiter)
app.use("/api/chamados/ocr", ocrLimiter)
// Só o POST conta: a leitura das imagens (GET) não deve gastar o limite.
app.use("/api/uploads", (req, res, next) =>
  req.method === "POST" ? uploadLimiter(req, res, next) : next(),
)

app.use("/api/auth", authRouter)
app.use("/api/tickets", ticketsRouter)
// Leitura de O.S. por foto (o "Nova OS por Foto" do dashboard): extrai os
// campos da foto e abre o chamado já preenchido.
app.use("/api/chamados", ocrChamadoRouter)

app.use("/api/users", usersRouter)
app.use("/api/roles", rolesRouter)
app.use("/api/permissions", permissionsRouter)
app.use("/api/technicians", techniciansRouter)
app.use("/api/products", productsRouter)
app.use("/api/metrics", metricsRouter)
app.use("/api/reports", reportsRouter)
app.use("/api/uploads", uploadsRouter)
// Configuração de notificações, regras de inatividade e sino in-app.
app.use("/api", notificationsRouter)
app.use("/api/inactivity", inactivityRouter)
app.use("/api/backups", backupsRouter)
// Configuração do bot "Ping IA" (Configurações → Bot Ping IA, só admin).
app.use("/api/admin", botConfigRouter)
// Personalidades do bot (4 slots; o slot 1 é o Padrão fixo).
app.use("/api/admin", botPersonalidadesRouter)

// Imagens dos chamados: agora servidas por GET /api/uploads/:filename, que
// exige sessão (antes era `express.static` público). O upload vive no mesmo
// router (`POST /api/uploads`), montado acima.

app.use((_req, res) => {
  res.status(404).json({ message: "Rota não encontrada." })
})

app.use(errorMiddleware)

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = Number.parseInt(process.env.API_PORT ?? "4000", 10)

const server = app.listen(PORT, () => {
  const target = dbConfigInfo()
  console.log(`\n🚀 PingOS API (MySQL) em http://localhost:${PORT}`)
  console.log(
    `   Banco:      mysql://${target.user}@${target.host}:${target.port}/${target.database}`,
  )
  console.log(`   Env file:   ${envInfo.file ?? "(nenhum — usando o ambiente)"}`)
  console.log(`   Imagens em: ${uploadDir()}`)
  console.log("   Rotas: /api/auth · /api/tickets · /api/users · /api/roles")
  console.log("          /api/technicians · /api/products · /api/metrics · /api/uploads")
  console.log("          /api/backups · /api/notification-settings · /api/inactivity/run")
  console.log("          /api/chamados/ocr (leitura de O.S. por foto)")
  console.log("          /api/admin/bot-config (bot Ping IA)")
  console.log("          /api/admin/bot-personalidades (personalidades do bot)")
  console.log("          /api/in-app-notifications · /api/health")
  console.log(`   Backups em: ${backupDir()}\n`)

  pingDatabase()
    .then(async (ok) => {
      if (!ok) {
        console.error(
          "⚠️  O MySQL não respondeu. Confira MYSQL_HOST/PORT/USER/PASSWORD/DATABASE em mysql-api.env\n" +
            "    e se o banco foi criado: mysql -u root -p < server/mysql/schema.sql\n",
        )
        return
      }
      await purgeExpiredSessions()
      console.log("✅ Conectado ao MySQL e sessões expiradas removidas.")
      // Verifica os chamados parados de tempos em tempos (o mesmo que o botão
      // "verificar agora" em Configurações → Regras de inatividade dispara).
      startInactivityScheduler()
      console.log("")
    })
    .catch((error) => console.error("[mysql-api] falha no boot:", error))
})

const shutdown = () => {
  server.close(() => {
    void closePool().finally(() => process.exit(0))
  })
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
