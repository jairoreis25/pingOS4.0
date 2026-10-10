/**
 * Logs estruturados da API (pino).
 *
 * Antes só existiam `console.log`/`console.error` espalhados: sem nível, sem
 * correlação entre requisições e sem como separar ruído de erro. Aqui ficam o
 * logger, o middleware HTTP (uma linha JSON por requisição, com id, status e
 * latência) e o nível configurável por `LOG_LEVEL`.
 *
 * O `Authorization` e o `Cookie` são redigidos: request log não é lugar para
 * token de sessão.
 */

import { randomUUID } from "node:crypto"
import type { Response } from "express"
import { pino } from "pino"
import { pinoHttp } from "pino-http"

export const logger = pino({
  level: (process.env.LOG_LEVEL ?? "info").trim() || "info",
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
    censor: "[redacted]",
  },
})

/** Uma linha por requisição; `/api/health` fica de fora (é chamado em loop). */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req) => {
    const header = req.headers["x-request-id"]
    const value = Array.isArray(header) ? header[0] : header
    return value || randomUUID()
  },
  autoLogging: {
    ignore: (req) => req.url === "/api/health",
  },
  customLogLevel: (_req, res, error) => {
    if (error || res.statusCode >= 500) return "error"
    if (res.statusCode >= 400) return "warn"
    return "info"
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
})

/** Id da requisição, para correlacionar a resposta HTTP com a linha de log. */
export function requestIdOf(res: Response): string {
  const header = res.getHeader("x-request-id")
  return typeof header === "string" ? header : ""
}
