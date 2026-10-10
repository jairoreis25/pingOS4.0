/**
 * Testes da busca do Kanban (extraída do `Dashboard`).
 */

import { describe, expect, it } from "vitest"
import { countByStatus, filterTickets, matchesTicketSearch } from "../src/lib/ticket-search"

const chamado = {
  number: 42,
  title: "Impressora sem papel",
  description: "A bandeja 2 está vazia",
  os: "OS-9911",
  guestContact: "5511999998888",
  guestName: "Maria",
}

describe("matchesTicketSearch", () => {
  it("busca vazia ou só espaço casa com tudo", () => {
    expect(matchesTicketSearch(chamado, "")).toBe(true)
    expect(matchesTicketSearch(chamado, "   ")).toBe(true)
    expect(matchesTicketSearch(chamado, undefined as unknown as string)).toBe(true)
  })

  it("acha por título, descrição, O.S., contato e nome do convidado", () => {
    expect(matchesTicketSearch(chamado, "impressora")).toBe(true)
    expect(matchesTicketSearch(chamado, "bandeja")).toBe(true)
    expect(matchesTicketSearch(chamado, "os-9911")).toBe(true)
    expect(matchesTicketSearch(chamado, "99998888")).toBe(true)
    expect(matchesTicketSearch(chamado, "maria")).toBe(true)
  })

  it("é case-insensitive e ignora espaço em volta do termo", () => {
    expect(matchesTicketSearch(chamado, "  IMPRESSORA ")).toBe(true)
  })

  it("compara o número como texto (buscar 42 acha o #42)", () => {
    expect(matchesTicketSearch(chamado, "42")).toBe(true)
    expect(matchesTicketSearch({ number: 420 }, "42")).toBe(true)
    expect(matchesTicketSearch({ number: null }, "42")).toBe(false)
  })

  it("não casa quando o termo não existe em nenhum campo", () => {
    expect(matchesTicketSearch(chamado, "toner")).toBe(false)
  })

  it("tolera campos nulos/ausentes sem quebrar", () => {
    expect(matchesTicketSearch({}, "qualquer")).toBe(false)
    expect(matchesTicketSearch({ title: null }, "x")).toBe(false)
  })
})

describe("filterTickets", () => {
  const lista = [
    { number: 1, title: "Rede lenta" },
    { number: 2, title: "Impressora travada" },
  ]

  it("lista indefinida vira lista vazia", () => {
    expect(filterTickets(undefined, "rede")).toEqual([])
  })

  it("sem termo devolve a MESMA referência (evita re-render desnecessário)", () => {
    expect(filterTickets(lista, "")).toBe(lista)
    expect(filterTickets(lista, "  ")).toBe(lista)
  })

  it("filtra pelo termo", () => {
    expect(filterTickets(lista, "rede").map((t) => t.number)).toEqual([1])
    expect(filterTickets(lista, "z").map((t) => t.number)).toEqual([])
  })
})

describe("countByStatus", () => {
  it("conta por status e trata lista indefinida", () => {
    expect(
      countByStatus([{ status: "aberto" }, { status: "aberto" }, { status: "fechado" }]),
    ).toEqual({
      aberto: 2,
      fechado: 1,
    })
    expect(countByStatus(undefined)).toEqual({})
  })
})
