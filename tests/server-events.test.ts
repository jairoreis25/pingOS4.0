/**
 * Testes do barramento SSE (`GET /api/events`).
 *
 * Sobe um Express de verdade numa porta efêmera e consome o stream com `fetch` —
 * é o mesmo caminho do navegador, sem precisar de banco (o auth é injetado).
 */

import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import express from "express"
import { afterEach, describe, expect, it } from "vitest"
import { errorMiddleware } from "../server/api/errors"
import {
  broadcastChange,
  broadcastOnWrite,
  eventsRouter,
  listenerCount,
} from "../server/api/events"

const fakeAuth = {
  user: { id: "u1", role: "admin", active: 1, name: "Teste", username: "teste" },
  permissions: [] as string[],
}

const abertos: { server: Server; cancel: () => Promise<void> }[] = []

function buildApp(withAuth: boolean): express.Express {
  const app = express()
  app.use((req, _res, next) => {
    if (withAuth) Object.assign(req, { auth: fakeAuth })
    next()
  })
  app.use("/api/events", eventsRouter)
  app.use(broadcastOnWrite())
  // Rotas de laboratório: uma que escreve (2xx avisa) e outra que falha.
  app.post("/api/escreve", (_req, res) => {
    res.status(201).json({ ok: true })
  })
  app.post("/api/falha", (_req, res) => {
    res.status(400).json({ message: "nada mudou" })
  })
  app.use(errorMiddleware)
  return app
}

async function startApp(withAuth: boolean): Promise<{ server: Server; port: number }> {
  const server = buildApp(withAuth).listen(0)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  return { server, port: (server.address() as AddressInfo).port }
}

function comTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`sem resposta em ${ms}ms`)), ms),
    ),
  ])
}

afterEach(async () => {
  for (const item of abertos.splice(0)) {
    await item.cancel().catch(() => undefined)
    item.server.close()
  }
})

describe("GET /api/events", () => {
  it("exige sessão: sem autenticação responde 401", async () => {
    const { server, port } = await startApp(false)
    abertos.push({ server, cancel: async () => undefined })

    const response = await fetch(`http://127.0.0.1:${port}/api/events`)

    expect(response.status).toBe(401)
    await response.text()
  })

  it("abre o stream com content-type de SSE e manda o handshake", async () => {
    const { server, port } = await startApp(true)
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: { authorization: "Bearer teste" },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("x-accel-buffering")).toBe("no")

    const reader = response.body!.getReader()
    abertos.push({ server, cancel: () => reader.cancel() })

    const { value } = await comTimeout(reader.read())
    expect(new TextDecoder().decode(value)).toContain(": conectado")
  })

  it("entrega `event: changed` para quem está conectado quando algo muda", async () => {
    const { server, port } = await startApp(true)
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: { authorization: "Bearer teste" },
    })
    const reader = response.body!.getReader()
    abertos.push({ server, cancel: () => reader.cancel() })
    const decoder = new TextDecoder()

    await comTimeout(reader.read())
    expect(listenerCount()).toBe(1)

    broadcastChange()

    let texto = ""
    for (let i = 0; i < 5 && !texto.includes("event: changed"); i++) {
      const { value, done } = await comTimeout(reader.read())
      if (done) break
      texto += decoder.decode(value)
    }

    expect(texto).toContain("event: changed")
    expect(texto).toContain("data: {}")
  })

  it("avisa apenas quando uma escrita termina com sucesso", async () => {
    const { server, port } = await startApp(true)
    abertos.push({ server, cancel: async () => undefined })

    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: { authorization: "Bearer teste" },
    })
    const reader = response.body!.getReader()
    abertos.push({ server, cancel: () => reader.cancel() })
    const decoder = new TextDecoder()

    await comTimeout(reader.read())

    // Escrita com erro não muda nada para os outros clientes.
    await fetch(`http://127.0.0.1:${port}/api/falha`, { method: "POST" })
    // Escrita bem-sucedida avisa.
    await fetch(`http://127.0.0.1:${port}/api/escreve`, { method: "POST" })

    let texto = ""
    for (let i = 0; i < 5 && !texto.includes("event: changed"); i++) {
      const { value, done } = await comTimeout(reader.read())
      if (done) break
      texto += decoder.decode(value)
    }

    expect(texto).toContain("event: changed")
    expect(texto.match(/event: changed/g)).toHaveLength(1)
  })

  it("libera o listener quando o cliente desconecta", async () => {
    const { server, port } = await startApp(true)
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: { authorization: "Bearer teste" },
    })
    const reader = response.body!.getReader()
    abertos.push({ server, cancel: async () => undefined })

    await comTimeout(reader.read())
    expect(listenerCount()).toBe(1)

    await reader.cancel()

    // `res.on("close")` roda no próximo tick do servidor.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(listenerCount()).toBe(0)
  })
})
