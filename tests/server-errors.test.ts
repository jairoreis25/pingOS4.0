import type { NextFunction, Request, Response } from "express"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ApiError,
  asyncHandler,
  badRequest,
  errorMiddleware,
  forbidden,
  notFound,
  unauthorized,
} from "../server/api/errors"
import { logger, requestIdOf } from "../server/api/logger"

function createResponse(requestId?: string) {
  const status = vi.fn<(code: number) => Response>()
  const json = vi.fn<(payload: unknown) => Response>()
  const getHeader = vi.fn<(name: string) => string | undefined>(() => requestId)
  const res = { status, json, getHeader } as unknown as Response
  status.mockImplementation(() => res)
  json.mockImplementation(() => res)
  return { res, status, json, getHeader }
}

function createRequest(): Request {
  return {} as unknown as Request
}

function createNext(): NextFunction {
  return vi.fn() as unknown as NextFunction
}

describe("ApiError", () => {
  it("guarda status e mensagem e continua sendo um Error", () => {
    const erro = new ApiError(418, "sou um bule")
    expect(erro.status).toBe(418)
    expect(erro.message).toBe("sou um bule")
    expect(erro.name).toBe("ApiError")
    expect(erro).toBeInstanceOf(Error)
    expect(erro).toBeInstanceOf(ApiError)
  })
})

describe("fábricas de erro", () => {
  it("cria erro 400 com a mensagem informada", () => {
    const erro = badRequest("Campo obrigatório.")
    expect(erro).toBeInstanceOf(ApiError)
    expect(erro.status).toBe(400)
    expect(erro.message).toBe("Campo obrigatório.")
  })

  it("cria erro 401 com a mensagem padrão e permite sobrescrever", () => {
    expect(unauthorized().status).toBe(401)
    expect(unauthorized().message).toBe("Não autenticado. Faça login para continuar.")
    expect(unauthorized("Sessão expirada.").message).toBe("Sessão expirada.")
  })

  it("cria erro 403 com a mensagem padrão e permite sobrescrever", () => {
    expect(forbidden().status).toBe(403)
    expect(forbidden().message).toBe("Sem permissão para realizar esta ação.")
    expect(forbidden("Apenas administradores podem realizar esta ação.").message).toBe(
      "Apenas administradores podem realizar esta ação.",
    )
  })

  it("cria erro 404 com a mensagem padrão e permite sobrescrever", () => {
    expect(notFound().status).toBe(404)
    expect(notFound().message).toBe("Registro não encontrado.")
    expect(notFound("Chamado não encontrado.").message).toBe("Chamado não encontrado.")
  })
})

describe("asyncHandler", () => {
  it("encaminha a rejeição para o next", async () => {
    const erro = new Error("falhou no banco")
    const next = createNext()
    const handler = asyncHandler(async () => {
      throw erro
    })

    handler(createRequest(), createResponse().res, next)

    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(erro))
  })

  it("encaminha qualquer valor rejeitado, não só Error", async () => {
    const next = createNext()
    const handler = asyncHandler(() => Promise.reject("falha crua"))

    handler(createRequest(), createResponse().res, next)

    await vi.waitFor(() => expect(next).toHaveBeenCalledWith("falha crua"))
  })

  it("não chama o next quando o handler termina com sucesso", async () => {
    const executou = vi.fn()
    const next = createNext()
    const handler = asyncHandler(async () => {
      executou()
    })

    handler(createRequest(), createResponse().res, next)

    await vi.waitFor(() => expect(executou).toHaveBeenCalledTimes(1))
    expect(next).not.toHaveBeenCalled()
  })

  it("deixa exceção síncrona subir para o Express (não converte em next)", () => {
    const next = createNext()
    const handler = asyncHandler(() => {
      throw new Error("erro síncrono")
    })

    expect(() => handler(createRequest(), createResponse().res, next)).toThrow("erro síncrono")
    expect(next).not.toHaveBeenCalled()
  })
})

describe("requestIdOf", () => {
  it("devolve o header x-request-id quando ele é string", () => {
    expect(requestIdOf(createResponse("req-123").res)).toBe("req-123")
  })

  it("devolve string vazia quando o header não é string", () => {
    expect(requestIdOf(createResponse().res)).toBe("")
  })
})

describe("errorMiddleware", () => {
  let logError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logError = vi.spyOn(logger, "error").mockImplementation(() => logger)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("responde o status e a mensagem de um ApiError sem logar", () => {
    const { res, status, json } = createResponse()

    errorMiddleware(forbidden(), createRequest(), res, createNext())

    expect(status).toHaveBeenCalledWith(403)
    expect(json).toHaveBeenCalledWith({ message: "Sem permissão para realizar esta ação." })
    expect(logError).not.toHaveBeenCalled()
  })

  it("converte duplicidade do MySQL em 409 com mensagem amigável", () => {
    const { res, status, json } = createResponse()
    const duplicado = Object.assign(new Error("ER_DUP_ENTRY: Duplicate entry"), {
      code: "ER_DUP_ENTRY",
    })

    errorMiddleware(duplicado, createRequest(), res, createNext())

    expect(status).toHaveBeenCalledWith(409)
    expect(json).toHaveBeenCalledWith({ message: "Já existe um registro com esses dados." })
    expect(logError).not.toHaveBeenCalled()
  })

  it("também reconhece o código de duplicidade em objeto cru", () => {
    const { res, status, json } = createResponse()

    errorMiddleware({ code: "ER_DUP_ENTRY" }, createRequest(), res, createNext())

    expect(status).toHaveBeenCalledWith(409)
    expect(json).toHaveBeenCalledWith({ message: "Já existe um registro com esses dados." })
  })

  it("responde 500 genérico para erro inesperado e loga com o id da requisição", () => {
    const { res, status, json } = createResponse("req-abc")
    const erro = new Error("Table 'pingos.tickets' doesn't exist")

    errorMiddleware(erro, createRequest(), res, createNext())

    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({ message: "Erro interno do servidor." })
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ err: erro, requestId: "req-abc", status: 500 }),
      "erro não tratado na API",
    )
  })

  it("não vaza a mensagem interna do erro para o cliente", () => {
    const { res, json } = createResponse()

    errorMiddleware(
      new Error("senha do banco inválida em 10.0.0.5"),
      createRequest(),
      res,
      createNext(),
    )

    const payload = json.mock.calls[0]?.[0] as { message?: string } | undefined
    expect(payload?.message).toBe("Erro interno do servidor.")
    expect(JSON.stringify(payload)).not.toContain("10.0.0.5")
  })

  it("loga sem id de requisição como string vazia quando o header não existe", () => {
    const { res } = createResponse()

    errorMiddleware(new Error("boom"), createRequest(), res, createNext())

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "" }),
      "erro não tratado na API",
    )
  })

  it("trata valor lançado que não é Error como 500 genérico", () => {
    const { res, status, json } = createResponse()

    errorMiddleware("falha crua", createRequest(), res, createNext())

    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({ message: "Erro interno do servidor." })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it("ignora o next na assinatura (aridade 4 exigida pelo Express)", () => {
    expect(errorMiddleware.length).toBe(4)
  })
})
