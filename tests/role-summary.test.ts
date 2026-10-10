/**
 * Testes do resumo de papéis (extraído de `UsersManagementDialog`).
 *
 * É o texto que o administrador lê para decidir quem pode o quê: se ele mentir,
 * alguém ganha ou perde acesso achando o contrário.
 */

import { describe, expect, it } from "vitest"
import { summarizeRole } from "../src/lib/role-summary"

describe("summarizeRole — capacidades (chips)", () => {
  it("lista as capacidades presentes", () => {
    const { chips } = summarizeRole([
      "tickets.view",
      "tickets.create",
      "tickets.edit",
      "tickets.assign",
      "tickets.move",
      "tickets.delete",
      "metrics.view",
      "settings.manage",
      "users.manage",
    ])

    expect(chips).toEqual([
      "Ver chamados",
      "Criar chamados",
      "Editar chamados",
      "Atribuir responsável",
      "Mover no Kanban",
      "Excluir chamados",
      "Ver métricas",
      "Configurações",
      "Gerenciar usuários",
    ])
  })

  it("permissão vazia não gera chip nem nota", () => {
    expect(summarizeRole([])).toEqual({ chips: [], notes: [] })
  })

  it("reconhece as variações `.all` como capacidade", () => {
    const { chips } = summarizeRole(["tickets.view.all", "tickets.edit.all"])
    expect(chips).toContain("Ver chamados")
    expect(chips).toContain("Editar chamados")
  })

  it("não repete o chip quando há `.all` e permissões por coluna", () => {
    const { chips } = summarizeRole(["tickets.view.all", "tickets.view.aberto"])
    expect(chips.filter((c) => c === "Ver chamados")).toHaveLength(1)
  })
})

describe("summarizeRole — restrições por coluna", () => {
  it("descreve as colunas visíveis quando há restrição de visualização", () => {
    const { notes } = summarizeRole(["tickets.view.aberto", "tickets.view.aguardando"])
    expect(notes).toContain("Visível: Aberto, Aguardando")
  })

  it("descreve as colunas editáveis quando há restrição de edição", () => {
    const { notes } = summarizeRole(["tickets.edit.resolvido"])
    expect(notes).toContain("Edição: Resolvido")
  })

  it("descreve os destinos de movimentação", () => {
    const { notes } = summarizeRole(["tickets.move.em_andamento", "tickets.move.fechado"])
    expect(notes).toContain("Mover para: Em Andamento, Fechado")
  })

  it("com `.all` não anuncia restrição de coluna (não há restrição)", () => {
    const { notes } = summarizeRole(["tickets.view.all", "tickets.view.aberto"])
    expect(notes.some((n) => n.startsWith("Visível:"))).toBe(false)
  })

  it("sem permissão por coluna não anuncia restrição (papéis antigos veem tudo)", () => {
    const { notes } = summarizeRole(["tickets.view"])
    expect(notes).toEqual([])
  })
})

describe("summarizeRole — restrições por atribuição", () => {
  it("descreve edição apenas dos próprios chamados", () => {
    const { notes } = summarizeRole(["tickets.edit.own"])
    expect(notes).toContain("Edição: apenas os próprios chamados")
  })

  it("junta as duas variações de edição por atribuição", () => {
    const { notes } = summarizeRole(["tickets.edit.own", "tickets.edit.unassigned"])
    expect(notes).toContain("Edição: apenas os próprios chamados · também sem responsável")
  })

  it("descreve visualização por atribuição separadamente da edição", () => {
    const { notes } = summarizeRole(["tickets.view.own"])
    expect(notes).toContain("Visualização: apenas os próprios chamados")
  })

  it("acumula restrições de coluna e de atribuição", () => {
    const { notes } = summarizeRole(["tickets.view.aberto", "tickets.view.own"])
    expect(notes).toContain("Visível: Aberto")
    expect(notes).toContain("Visualização: apenas os próprios chamados")
  })
})
