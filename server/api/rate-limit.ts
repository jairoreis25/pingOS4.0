/**
 * Rate limiting das entradas sensíveis (ver AGENTS.md §5).
 *
 * Antes não havia limite nenhum: login aceitava tentativa e erro sem freio, o
 * formulário público de abertura de chamado aceitava flood e a leitura de O.S.
 * por foto — que é uma chamada paga de IA — podia ser disparada à vontade.
 *
 * O store é em memória, o que basta para uma instância. Com mais de uma réplica
 * da API é preciso um store compartilhado (ver docs/REVISAO-SENIOR.md, Onda 2).
 *
 * `RATE_LIMIT_ENABLED=false` desliga todos os limites (útil em teste local).
 */

import type { RequestHandler } from "express"
import { rateLimit } from "express-rate-limit"

const enabled = (process.env.RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() !== "false"

type LimiterOptions = {
  windowMinutes: number
  limit: number
  message: string
  /** Não conta requisições bem-sucedidas (usado no login). */
  skipSuccessfulRequests?: boolean
}

function createLimiter(options: LimiterOptions): RequestHandler {
  if (!enabled) return (_req, _res, next) => next()

  return rateLimit({
    windowMs: Math.round(options.windowMinutes * 60 * 1000),
    limit: options.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    message: { message: options.message },
  })
}

/** 10 tentativas falhas por IP a cada 15 min (login bem-sucedido não conta). */
export const loginLimiter = createLimiter({
  windowMinutes: 15,
  limit: 10,
  message: "Muitas tentativas de login. Aguarde alguns minutos e tente de novo.",
  skipSuccessfulRequests: true,
})

/** 10 tentativas por IP/hora para criar o primeiro administrador. */
export const setupLimiter = createLimiter({
  windowMinutes: 60,
  limit: 10,
  message: "Muitas tentativas de configuração inicial. Aguarde e tente de novo.",
})

/** 5 chamados por IP/hora no formulário público (sem login). */
export const guestTicketLimiter = createLimiter({
  windowMinutes: 60,
  limit: 5,
  message: "Muitos chamados abertos deste IP. Aguarde antes de abrir outro.",
})

/** 30 uploads por IP a cada 15 min. */
export const uploadLimiter = createLimiter({
  windowMinutes: 15,
  limit: 30,
  message: "Muitos envios de arquivo seguidos. Aguarde um pouco.",
})

/** 20 leituras de O.S. por foto por IP/hora (cada uma é uma chamada paga de IA). */
export const ocrLimiter = createLimiter({
  windowMinutes: 60,
  limit: 20,
  message: "Limite de leitura de O.S. por foto atingido. Tente novamente mais tarde.",
})
