import { describe, expect, it } from "vitest"

import {
  ADMIN_ROLE,
  ALL_PERMISSIONS,
  DEFAULT_ROLE,
  DEFAULT_USER_PERMISSIONS,
  PERMISSION_GROUPS,
  TICKET_STATUSES,
  canEditStatus,
  canEditTicket,
  canMoveAny,
  canMoveTo,
  canViewStatus,
  canViewTicket,
  hasEditAssignmentRestriction,
  hasStatusEditRestriction,
  hasStatusViewRestriction,
  hasViewAssignmentRestriction,
  isAdmin,
  namesMatch,
  permissionLabel,
} from "@/lib/permissions"

describe("catálogo de permissões", () => {
  it("expõe todas as permissões dos grupos sem duplicatas", () => {
    const doCatalogo = PERMISSION_GROUPS.flatMap((grupo) => grupo.permissions.map((p) => p.key))
    expect(ALL_PERMISSIONS).toEqual(doCatalogo)
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length)
    expect(ALL_PERMISSIONS).toContain("tickets.view")
    expect(ALL_PERMISSIONS).toContain("users.manage")
  })

  it("devolve o rótulo da permissão conhecida e a própria chave quando desconhecida", () => {
    expect(permissionLabel("tickets.delete")).toBe("Excluir chamado")
    expect(permissionLabel("nao.existe")).toBe("nao.existe")
  })

  it("mantém as permissões padrão do papel de usuário dentro do catálogo", () => {
    for (const permissao of DEFAULT_USER_PERMISSIONS) {
      expect(ALL_PERMISSIONS).toContain(permissao)
    }
    expect(DEFAULT_USER_PERMISSIONS).not.toContain("users.manage")
  })

  it("define os nomes canônicos dos papéis", () => {
    expect(ADMIN_ROLE).toBe("admin")
    expect(DEFAULT_ROLE).toBe("user")
  })
})

describe("isAdmin", () => {
  it("reconhece apenas o papel exato 'admin'", () => {
    expect(isAdmin("admin")).toBe(true)
    expect(isAdmin("Admin")).toBe(false)
    expect(isAdmin("administrador")).toBe(false)
  })

  it("trata papel ausente como não-admin", () => {
    expect(isAdmin(null)).toBe(false)
    expect(isAdmin(undefined)).toBe(false)
    expect(isAdmin("")).toBe(false)
  })
})

describe("canMoveTo / canMoveAny", () => {
  it("libera qualquer coluna quando a permissão ampla de mover está presente", () => {
    expect(canMoveTo(["tickets.move"], "aberto")).toBe(true)
    expect(canMoveTo(["tickets.move"], "fechado")).toBe(true)
    expect(canMoveAny(["tickets.move"])).toBe(true)
  })

  it("libera apenas a coluna com permissão específica", () => {
    const permissoes = ["tickets.move.resolvido"]
    expect(canMoveTo(permissoes, "resolvido")).toBe(true)
    expect(canMoveTo(permissoes, "aberto")).toBe(false)
    expect(canMoveAny(permissoes)).toBe(true)
  })

  it("nega mover sem nenhuma permissão de movimento", () => {
    expect(canMoveTo([], "aberto")).toBe(false)
    expect(canMoveTo(["tickets.edit"], "aberto")).toBe(false)
    expect(canMoveAny([])).toBe(false)
    expect(canMoveAny(["tickets.view.all"])).toBe(false)
  })
})

describe("canViewStatus", () => {
  it("libera tudo quando a permissão 'ver todos os status' está marcada", () => {
    expect(canViewStatus(["tickets.view.all"], "fechado")).toBe(true)
    expect(canViewStatus(["tickets.view.all", "tickets.view.aberto"], "aguardando")).toBe(true)
  })

  it("vê tudo quando nenhuma restrição de coluna está configurada (padrão compatível)", () => {
    expect(hasStatusViewRestriction([])).toBe(false)
    expect(canViewStatus([], "resolvido")).toBe(true)
    expect(canViewStatus(["metrics.view"], "resolvido")).toBe(true)
  })

  it("respeita a restrição por coluna quando ela existe", () => {
    const permissoes = ["tickets.view.aberto", "tickets.view.em_andamento"]
    expect(hasStatusViewRestriction(permissoes)).toBe(true)
    expect(canViewStatus(permissoes, "aberto")).toBe(true)
    expect(canViewStatus(permissoes, "em_andamento")).toBe(true)
    expect(canViewStatus(permissoes, "fechado")).toBe(false)
  })

  it("não confunde permissão de edição com restrição de visualização", () => {
    expect(hasStatusViewRestriction(["tickets.edit.aberto"])).toBe(false)
    expect(canViewStatus(["tickets.edit.aberto"], "fechado")).toBe(true)
  })
})

describe("canEditStatus", () => {
  it("libera tudo quando a permissão 'editar todos os status' está marcada", () => {
    expect(canEditStatus(["tickets.edit.all"], "fechado")).toBe(true)
  })

  it("edita tudo quando nenhuma restrição de coluna está configurada (padrão compatível)", () => {
    expect(hasStatusEditRestriction([])).toBe(false)
    expect(canEditStatus([], "fechado")).toBe(true)
  })

  it("respeita a restrição por coluna quando ela existe", () => {
    const permissoes = ["tickets.edit.aguardando"]
    expect(hasStatusEditRestriction(permissoes)).toBe(true)
    expect(canEditStatus(permissoes, "aguardando")).toBe(true)
    expect(canEditStatus(permissoes, "aberto")).toBe(false)
  })

  it("trata restrição por atribuição como edição liberada por status", () => {
    expect(hasStatusEditRestriction(["tickets.edit.own"])).toBe(false)
    expect(canEditStatus(["tickets.edit.own"], "aberto")).toBe(true)
  })
})

describe("restrições por atribuição", () => {
  it("detecta restrição de edição e de visualização por responsável", () => {
    expect(hasEditAssignmentRestriction([])).toBe(false)
    expect(hasEditAssignmentRestriction(["tickets.edit.own"])).toBe(true)
    expect(hasEditAssignmentRestriction(["tickets.edit.unassigned"])).toBe(true)
    expect(hasViewAssignmentRestriction([])).toBe(false)
    expect(hasViewAssignmentRestriction(["tickets.view.own"])).toBe(true)
    expect(hasViewAssignmentRestriction(["tickets.view.unassigned"])).toBe(true)
  })

  it("não considera restrição de coluna como restrição de atribuição", () => {
    expect(hasEditAssignmentRestriction(["tickets.edit.aberto"])).toBe(false)
    expect(hasViewAssignmentRestriction(["tickets.view.aberto"])).toBe(false)
  })
})

describe("namesMatch", () => {
  it("compara nomes ignorando caixa e espaços nas pontas", () => {
    expect(namesMatch("  Ana Silva ", "ana silva")).toBe(true)
    expect(namesMatch("ANA", "ana")).toBe(true)
    expect(namesMatch("Ana", "Ana Maria")).toBe(false)
  })

  it("trata valor vazio ou ausente como não-correspondente", () => {
    expect(namesMatch("", "ana")).toBe(false)
    expect(namesMatch(null, "ana")).toBe(false)
    expect(namesMatch("ana", undefined)).toBe(false)
    expect(namesMatch(null, undefined)).toBe(false)
  })

  it("considera iguais dois nomes só com espaços (ambos normalizam para vazio)", () => {
    // Comportamento atual: a guarda é de string vazia, e " " é truthy — então
    // dois nomes em branco "casam". Sem impacto prático: nome em branco não
    // chega ao Kanban.
    expect(namesMatch("   ", " ")).toBe(true)
  })
})

describe("canViewTicket", () => {
  it("nega quando o status não é visível, mesmo que a atribuição seja do usuário", () => {
    expect(canViewTicket(["tickets.view.aberto"], "fechado", "u1", "u1")).toBe(false)
  })

  it("libera qualquer responsável quando não há restrição de atribuição", () => {
    expect(canViewTicket([], "aberto", "tecnico-9", "u1")).toBe(true)
    expect(canViewTicket([], "aberto", null, "u1")).toBe(true)
  })

  it("com 'apenas atribuídos a mim' libera o próprio chamado e nega o dos outros", () => {
    const permissoes = ["tickets.view.own"]
    expect(canViewTicket(permissoes, "aberto", "u1", "u1")).toBe(true)
    expect(canViewTicket(permissoes, "aberto", "u2", "u1")).toBe(false)
    expect(canViewTicket(permissoes, "aberto", null, "u1")).toBe(false)
  })

  it("casa o responsável por nome quando ele é um técnico (cadastro separado)", () => {
    expect(canViewTicket(["tickets.view.own"], "aberto", "t7", "u1", " Ana ", "ana")).toBe(true)
    expect(canViewTicket(["tickets.view.own"], "aberto", "t7", "u1", "Ana", "Bia")).toBe(false)
  })

  it("com 'sem responsável' libera o chamado não atribuído e nega o atribuído a outro", () => {
    const permissoes = ["tickets.view.unassigned"]
    expect(canViewTicket(permissoes, "aberto", null, "u1")).toBe(true)
    expect(canViewTicket(permissoes, "aberto", "u2", "u1")).toBe(false)
    expect(canViewTicket(permissoes, "aberto", "u1", "u1")).toBe(false)
  })

  it("combina as duas restrições de atribuição", () => {
    const permissoes = ["tickets.view.own", "tickets.view.unassigned"]
    expect(canViewTicket(permissoes, "aberto", "u1", "u1")).toBe(true)
    expect(canViewTicket(permissoes, "aberto", null, "u1")).toBe(true)
    expect(canViewTicket(permissoes, "aberto", "u2", "u1")).toBe(false)
  })

  it("dá poder total ao administrador sobre a restrição de atribuição", () => {
    expect(canViewTicket(["tickets.view.own"], "aberto", "outro", "u1", null, null, true)).toBe(
      true,
    )
    expect(canViewTicket([], "aberto", "outro", "u1", null, null, true)).toBe(true)
  })

  it("mantém a restrição de coluna mesmo para o administrador (comportamento atual)", () => {
    expect(canViewTicket(["tickets.view.aberto"], "fechado", "u1", "u1", null, null, true)).toBe(
      false,
    )
  })
})

describe("canEditTicket", () => {
  it("nega quando o status não é editável", () => {
    expect(canEditTicket(["tickets.edit.aberto"], "fechado", "u1", "u1")).toBe(false)
  })

  it("libera qualquer responsável quando não há restrição de atribuição", () => {
    expect(canEditTicket([], "aberto", "tecnico-9", "u1")).toBe(true)
    expect(canEditTicket([], "aberto", null, "u1")).toBe(true)
  })

  it("com 'apenas atribuídos a mim' libera o próprio chamado e nega o dos outros", () => {
    const permissoes = ["tickets.edit.own"]
    expect(canEditTicket(permissoes, "aberto", "u1", "u1")).toBe(true)
    expect(canEditTicket(permissoes, "aberto", "u2", "u1")).toBe(false)
    expect(canEditTicket(permissoes, "aberto", null, "u1")).toBe(false)
  })

  it("casa o responsável por nome quando ele é um técnico", () => {
    expect(canEditTicket(["tickets.edit.own"], "aberto", "t7", "u1", "Ana", " ANA ")).toBe(true)
  })

  it("com 'sem responsável' libera o chamado não atribuído", () => {
    const permissoes = ["tickets.edit.unassigned"]
    expect(canEditTicket(permissoes, "aberto", null, "u1")).toBe(true)
    expect(canEditTicket(permissoes, "aberto", "u2", "u1")).toBe(false)
  })

  it("dá poder total ao administrador sobre a restrição de atribuição", () => {
    expect(canEditTicket(["tickets.edit.own"], "aberto", "outro", "u1", null, null, true)).toBe(
      true,
    )
  })

  it("exige id de usuário para casar o responsável por id", () => {
    expect(canEditTicket(["tickets.edit.own"], "aberto", "u1", null)).toBe(false)
    expect(canEditTicket(["tickets.edit.own"], "aberto", "u1", undefined)).toBe(false)
  })
})

describe("TICKET_STATUSES", () => {
  it("lista os cinco status do Kanban na ordem do fluxo", () => {
    expect(TICKET_STATUSES).toEqual([
      "aberto",
      "em_andamento",
      "aguardando",
      "resolvido",
      "fechado",
    ])
  })
})
