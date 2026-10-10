import { describe, expect, it } from "vitest"

import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_EMPTY,
  TICKET_CATEGORY_UNSET,
  isTicketCategory,
  normalizeTicketCategory,
} from "@/lib/ticket-categories"

describe("TICKET_CATEGORIES", () => {
  it("lista as categorias internas na ordem do dropdown", () => {
    expect(TICKET_CATEGORIES).toEqual([
      "Impressoras",
      "Computadores",
      "Notebooks",
      "Softwares",
      "Rede",
      "Suporte",
      "Outros",
    ])
  })

  it("usa sentinelas distintas para o formulário e para o filtro da API", () => {
    expect(TICKET_CATEGORY_EMPTY).toBe("—")
    expect(TICKET_CATEGORY_UNSET).toBe("sem_categoria")
    expect(TICKET_CATEGORY_UNSET).not.toBe(TICKET_CATEGORY_EMPTY)
  })
})

describe("normalizeTicketCategory", () => {
  it("devolve a grafia oficial ignorando a caixa", () => {
    expect(normalizeTicketCategory("Impressoras")).toBe("Impressoras")
    expect(normalizeTicketCategory("impressoras")).toBe("Impressoras")
    expect(normalizeTicketCategory("REDE")).toBe("Rede")
    expect(normalizeTicketCategory("noteBooks")).toBe("Notebooks")
  })

  it("remove espaços das pontas antes de comparar", () => {
    expect(normalizeTicketCategory("  Suporte  ")).toBe("Suporte")
  })

  it("trata vazio, sentinela vazia e nulos como sem categoria", () => {
    expect(normalizeTicketCategory(undefined)).toBeNull()
    expect(normalizeTicketCategory(null)).toBeNull()
    expect(normalizeTicketCategory("")).toBeNull()
    expect(normalizeTicketCategory("   ")).toBeNull()
    expect(normalizeTicketCategory(TICKET_CATEGORY_EMPTY)).toBeNull()
  })

  it("devolve null para valor fora da lista", () => {
    expect(normalizeTicketCategory("Impressora")).toBeNull()
    expect(normalizeTicketCategory("TI")).toBeNull()
    expect(normalizeTicketCategory(TICKET_CATEGORY_UNSET)).toBeNull()
    expect(normalizeTicketCategory(42)).toBeNull()
    expect(normalizeTicketCategory(true)).toBeNull()
    expect(normalizeTicketCategory({})).toBeNull()
  })
})

describe("isTicketCategory", () => {
  it("aceita apenas valores da lista", () => {
    expect(isTicketCategory("Rede")).toBe(true)
    expect(isTicketCategory("rede")).toBe(true)
    expect(isTicketCategory("  outros ")).toBe(true)
  })

  it("recusa vazio, sentinelas e valores desconhecidos", () => {
    expect(isTicketCategory("")).toBe(false)
    expect(isTicketCategory("   ")).toBe(false)
    expect(isTicketCategory(TICKET_CATEGORY_EMPTY)).toBe(false)
    expect(isTicketCategory(TICKET_CATEGORY_UNSET)).toBe(false)
    expect(isTicketCategory(null)).toBe(false)
    expect(isTicketCategory(undefined)).toBe(false)
    expect(isTicketCategory("Games")).toBe(false)
  })
})
