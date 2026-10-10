/**
 * Testes da paginação por keyset da lista de chamados.
 *
 * O helper é puro de propósito: a parte que decide `WHERE`/`ORDER BY`/`LIMIT` e o
 * cursor fica testável sem banco, e o handler só orquestra.
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildTicketPage,
  buildTicketPageQuery,
  encodeTicketCursor,
  parseTicketCursor,
  parseTicketLimit,
} from "../server/api/tickets-page"

describe("parseTicketLimit", () => {
  it("sem valor, vazio ou inválido devolve undefined (lista completa)", () => {
    expect(parseTicketLimit(undefined)).toBeUndefined()
    expect(parseTicketLimit(null)).toBeUndefined()
    expect(parseTicketLimit("")).toBeUndefined()
    expect(parseTicketLimit("abc")).toBeUndefined()
    expect(parseTicketLimit("0")).toBeUndefined()
    expect(parseTicketLimit("-10")).toBeUndefined()
  })

  it("aceita número e string numérica", () => {
    expect(parseTicketLimit("50")).toBe(50)
    expect(parseTicketLimit(200)).toBe(200)
    expect(parseTicketLimit("200.9")).toBe(200)
  })

  it("limita ao teto da página", () => {
    expect(parseTicketLimit(String(MAX_PAGE_SIZE * 10))).toBe(MAX_PAGE_SIZE)
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE)
  })
})

describe("cursor", () => {
  it("vai e volta sem perder precisão no created_at", () => {
    const cursor = { createdAt: 1_791_600_000_123, id: "a1b2c3" }
    const encoded = encodeTicketCursor(cursor)

    expect(encoded).not.toContain(" ")

    expect(parseTicketCursor(encoded)).toEqual(cursor)
  })

  it("recusa cursor ausente, lixo, base64 inválido ou formato errado", () => {
    expect(parseTicketCursor(undefined)).toBeNull()
    expect(parseTicketCursor("")).toBeNull()
    expect(parseTicketCursor(123)).toBeNull()
    expect(parseTicketCursor("nao-e-base64url-valido!!")).toBeNull()

    const errado = (valor: unknown) =>
      Buffer.from(JSON.stringify(valor), "utf8").toString("base64url")
    expect(parseTicketCursor(errado([1, 2, 3]))).toBeNull()
    expect(parseTicketCursor(errado("texto"))).toBeNull()
    expect(parseTicketCursor(errado(["1", "id"]))).toBeNull()
    expect(parseTicketCursor(errado([1, ""]))).toBeNull()
  })
})

describe("buildTicketPage", () => {
  it("sem cursor não filtra e mantém a ordem estável por id", () => {
    const page = buildTicketPage({ limit: 50 })

    expect(page.where).toBe("")
    expect(page.params).toEqual([])
    expect(page.limit).toBe(50)
    expect(page.orderBy).toBe("`created_at` DESC, `id` DESC")
  })

  it("com cursor compara (created_at, id) na mesma ordem da listagem", () => {
    const page = buildTicketPage({ limit: 50, cursor: { createdAt: 100, id: "abc" } })

    expect(page.where).toBe("(`created_at` < ? OR (`created_at` = ? AND `id` < ?))")
    expect(page.params).toEqual([100, 100, "abc"])
  })

  it("o WHERE usa apenas placeholders (nada interpolado)", () => {
    const page = buildTicketPage({ limit: 10, cursor: { createdAt: 5, id: "x" } })

    expect(page.where).not.toContain("x")
    expect(page.where.match(/\?/g)).toHaveLength(3)
  })
})

describe("buildTicketPageQuery", () => {
  it("monta a primeira página com LIMIT parametrizado", () => {
    const { sql, params } = buildTicketPageQuery("`id`, `created_at`", { limit: 25 })

    expect(sql).toBe(
      "SELECT `id`, `created_at` FROM `tickets` ORDER BY `created_at` DESC, `id` DESC LIMIT ?",
    )
    expect(params).toEqual([25])
  })

  it("monta a página seguinte com o cursor antes do LIMIT", () => {
    const { sql, params } = buildTicketPageQuery("`id`", {
      limit: 25,
      cursor: { createdAt: 999, id: "z" },
    })

    expect(sql).toBe(
      "SELECT `id` FROM `tickets` WHERE (`created_at` < ? OR (`created_at` = ? AND `id` < ?)) ORDER BY `created_at` DESC, `id` DESC LIMIT ?",
    )
    expect(params).toEqual([999, 999, "z", 25])
  })
})
