import type { NextFunction, Request, Response } from "express"
import { afterEach, describe, expect, it, vi } from "vitest"

type LimiterModule = typeof import("../server/api/rate-limit")
type Limiter = (req: Request, res: Response, next: NextFunction) => unknown

/**
 * O módulo decide na importação se os limites estão ligados, então cada cenário
 * precisa de `vi.resetModules()` + import dinâmico para reler `RATE_LIMIT_ENABLED`.
 */
async function loadLimiters(envValue?: string): Promise<LimiterModule> {
  vi.resetModules()
  if (envValue === undefined) vi.unstubAllEnvs()
  else vi.stubEnv("RATE_LIMIT_ENABLED", envValue)
  return await import("../server/api/rate-limit")
}

function createRequest(): Request {
  // Objeto novo a cada requisição: o express-rate-limit recusa contar duas vezes
  // o mesmo objeto de request (validação ERR_ERL_DOUBLE_COUNT).
  return { ip: "203.0.113.7", headers: {}, app: { get: () => false } } as unknown as Request
}

function createResponse() {
  const headers: Record<string, string> = {}
  const sent: unknown[] = []
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name] = value
    },
    status(code: number) {
      res.statusCode = code
      return res
    },
    send(payload: unknown) {
      sent.push(payload)
      res.writableEnded = true
      return res
    },
    once() {
      return res
    },
  }
  return { res, headers, sent }
}

async function hit(limiter: Limiter) {
  const next = vi.fn() as unknown as NextFunction
  const { res, headers, sent } = createResponse()
  await limiter(createRequest(), res as unknown as Response, next)
  return { headers, sent, next, statusCode: res.statusCode }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("com RATE_LIMIT_ENABLED=false", () => {
  it("transforma os cinco limiters em passthrough (chamam next na hora)", async () => {
    const limiters = await loadLimiters("false")
    const todos: Limiter[] = [
      limiters.loginLimiter,
      limiters.setupLimiter,
      limiters.guestTicketLimiter,
      limiters.uploadLimiter,
      limiters.ocrLimiter,
    ]

    for (const limiter of todos) {
      const next = vi.fn()
      const { res, headers } = createResponse()
      const retorno = limiter(
        createRequest(),
        res as unknown as Response,
        next as unknown as NextFunction,
      )

      expect(next).toHaveBeenCalledTimes(1)
      expect(retorno).toBeUndefined()
      expect(headers).toEqual({})
      expect(res.statusCode).toBe(200)
      expect(res.writableEnded).toBe(false)
    }
  })

  it("aceita a grafia ' FALSE ' (espaços e maiúsculas)", async () => {
    const limiters = await loadLimiters(" FALSE ")
    const tentativa = await hit(limiters.loginLimiter)
    expect(tentativa.next).toHaveBeenCalledTimes(1)
    expect(tentativa.headers).toEqual({})
  })

  it("não bloqueia nem depois de 30 requisições no limiter de convidado", async () => {
    const limiters = await loadLimiters("false")

    for (let i = 0; i < 30; i += 1) {
      const tentativa = await hit(limiters.guestTicketLimiter)
      expect(tentativa.next).toHaveBeenCalledTimes(1)
      expect(tentativa.statusCode).toBe(200)
    }
  })
})

describe("com os limites ligados", () => {
  it("bloqueia a 11ª tentativa de login com 429 e cabeçalhos de limite", async () => {
    const { loginLimiter } = await loadLimiters("true")

    for (let i = 0; i < 10; i += 1) {
      const permitida = await hit(loginLimiter)
      expect(permitida.next).toHaveBeenCalledTimes(1)
      // draft-7: RateLimit-Policy = "<limite>;w=<janela em segundos>"
      expect(permitida.headers["RateLimit-Policy"]).toBe("10;w=900")
    }

    const bloqueada = await hit(loginLimiter)
    expect(bloqueada.next).not.toHaveBeenCalled()
    expect(bloqueada.statusCode).toBe(429)
    expect(bloqueada.headers["RateLimit"]).toContain("limit=10, remaining=0")
    expect(bloqueada.headers["Retry-After"]).toBeDefined()
    expect(bloqueada.sent[0]).toMatchObject({
      message: expect.stringContaining("Muitas tentativas de login"),
    })
  })

  it("bloqueia o 6º chamado do formulário público com a mensagem do limiter", async () => {
    const { guestTicketLimiter } = await loadLimiters("true")

    for (let i = 0; i < 5; i += 1) {
      const permitida = await hit(guestTicketLimiter)
      expect(permitida.next).toHaveBeenCalledTimes(1)
    }

    const bloqueada = await hit(guestTicketLimiter)
    expect(bloqueada.next).not.toHaveBeenCalled()
    expect(bloqueada.statusCode).toBe(429)
    expect(bloqueada.sent[0]).toMatchObject({
      message: expect.stringContaining("Muitos chamados abertos deste IP"),
    })
  })

  it("usa o limite de 30 uploads por janela e o de 20 leituras de O.S.", async () => {
    const { uploadLimiter, ocrLimiter } = await loadLimiters("true")

    const primeiroUpload = await hit(uploadLimiter)
    expect(primeiroUpload.headers["RateLimit-Policy"]).toBe("30;w=900")

    const primeiraLeitura = await hit(ocrLimiter)
    expect(primeiraLeitura.headers["RateLimit-Policy"]).toBe("20;w=3600")
  })

  it("só desliga com o valor exato 'false' (outros valores ligam o limite)", async () => {
    const comZero = await loadLimiters("0")
    for (let i = 0; i < 5; i += 1) {
      const permitida = await hit(comZero.guestTicketLimiter)
      expect(permitida.next).toHaveBeenCalledTimes(1)
    }
    const bloqueada = await hit(comZero.guestTicketLimiter)
    expect(bloqueada.next).not.toHaveBeenCalled()
    expect(bloqueada.statusCode).toBe(429)
  })

  it("fica ligado por padrão quando a variável não existe", async () => {
    const limiters = await loadLimiters()

    for (let i = 0; i < 5; i += 1) {
      const permitida = await hit(limiters.guestTicketLimiter)
      expect(permitida.next).toHaveBeenCalledTimes(1)
    }

    const bloqueada = await hit(limiters.guestTicketLimiter)
    expect(bloqueada.next).not.toHaveBeenCalled()
    expect(bloqueada.statusCode).toBe(429)
  })
})
