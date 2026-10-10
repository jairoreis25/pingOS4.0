/**
 * Barramento de mudanças por SSE (`GET /api/events`).
 *
 * Antes, cada navegador revalidava a base inteira de chamados a cada 10 s só
 * para descobrir se algo tinha mudado (`src/lib/backend/session.ts`). Aqui o
 * servidor avisa quando há mudança: toda requisição que **escreve** dispara
 * `broadcastChange()`, e as conexões abertas recebem um evento `changed` — o
 * cliente então invalida as queries montadas, exatamente como faz depois de uma
 * mutation própria.
 *
 * Detalhes de implementação:
 * - `EventSource` não envia cabeçalhos, então o cliente consome o stream com
 *   `fetch` + `ReadableStream` para poder mandar o `Authorization` (token nunca
 *   vai na query string, que apareceria nos logs);
 * - heartbeat a cada 25 s para atravessar proxies sem deixar a conexão morrer;
 * - o lock é por processo: com várias réplicas, cada uma avisa os próprios
 *   clientes (o poll de segurança do cliente cobre o resto).
 */

import { EventEmitter } from "node:events"
import type { RequestHandler } from "express"
import { Router } from "express"
import { requireAuth } from "./permissions"

const bus = new EventEmitter()
// Sem limite: cada aba aberta é um listener.
bus.setMaxListeners(0)

/** Avisa todos os clientes conectados que algum dado mudou. */
export function broadcastChange(): void {
  bus.emit("changed")
}

/** Quantas conexões SSE estão abertas (usado em testes/diagnóstico). */
export function listenerCount(): number {
  return bus.listenerCount("changed")
}

/**
 * Middleware: avisa os clientes quando uma requisição que **escreve** termina
 * bem. Erro (4xx/5xx) não avisa — não houve mudança para os outros verem.
 */
export function broadcastOnWrite(): RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next()
    res.on("finish", () => {
      if (res.statusCode < 400) broadcastChange()
    })
    next()
  }
}

const HEARTBEAT_MS = 25_000

export const eventsRouter = Router()

eventsRouter.get("/", (req, res) => {
  requireAuth(req)

  res.status(200)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  // O nginx precisa disto para não segurar os eventos no buffer.
  res.setHeader("X-Accel-Buffering", "no")
  res.flushHeaders()

  const send = (chunk: string) => {
    res.write(chunk)
  }

  send(": conectado\n\n")

  const onChanged = () => send("event: changed\ndata: {}\n\n")
  bus.on("changed", onChanged)

  const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS)

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    bus.off("changed", onChanged)
    res.end()
  }

  req.on("close", cleanup)
  res.on("close", cleanup)
})
