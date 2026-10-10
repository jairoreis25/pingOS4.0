import { describe, expect, it } from "vitest"

import {
  parseJsonArray,
  parsePermissionsOverride,
  toBool,
  toNumber,
  toPublicProductService,
  toPublicRole,
  toPublicTechnician,
  toPublicTicket,
  toPublicUser,
  type ProductServiceRow,
  type RoleRow,
  type TechnicianRow,
  type TicketRow,
  type UserRow,
} from "../server/api/types"

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u1",
    name: "Ana",
    image: null,
    email: "ana@exemplo.com",
    username: null,
    password_hash: null,
    email_verification_time: null,
    is_anonymous: 0,
    role: "user",
    active: 1,
    setor: "TI",
    contato: null,
    permissions: null,
    created_by: null,
    created_at: 1_700_000_000_000,
    updated_at: null,
    ...overrides,
  }
}

function makeTicket(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: "t1",
    number: 12,
    title: "Troca de fonte",
    description: "Não liga",
    solucao: null,
    orcamento: null,
    obs: null,
    status_equipamento: null,
    categoria: null,
    status: "aberto",
    priority: "media",
    creator_id: "u1",
    guest_name: null,
    guest_contact: null,
    image_url: null,
    valor_total: null,
    os: null,
    creator_name: "Ana",
    location: null,
    assignee_id: null,
    assignee_type: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000,
    ...overrides,
  }
}

function makeTechnician(overrides: Partial<TechnicianRow> = {}): TechnicianRow {
  return {
    id: "tec1",
    name: "Bia",
    funcao: null,
    contato: null,
    active: 1,
    created_at: 1_700_000_000_000,
    ...overrides,
  }
}

function makeProduct(overrides: Partial<ProductServiceRow> = {}): ProductServiceRow {
  return {
    id: "p1",
    name: "Formatação",
    item_type: null,
    price: 0,
    active: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  }
}

function makeRole(overrides: Partial<RoleRow> = {}): RoleRow {
  return {
    id: "r1",
    name: "user",
    permissions: null,
    is_system: 1,
    created_at: 1_700_000_000_000,
    ...overrides,
  }
}

describe("parseJsonArray", () => {
  it("converte array (já parseado pelo driver) em lista de strings", () => {
    expect(parseJsonArray(["tickets.view", "metrics.view"])).toEqual([
      "tickets.view",
      "metrics.view",
    ])
    expect(parseJsonArray([1, 2])).toEqual(["1", "2"])
  })

  it("faz o parse de uma string JSON", () => {
    expect(parseJsonArray('["a","b"]')).toEqual(["a", "b"])
  })

  it("devolve lista vazia para JSON que não é array", () => {
    expect(parseJsonArray('{"a":1}')).toEqual([])
    expect(parseJsonArray("null")).toEqual([])
    expect(parseJsonArray('"texto"')).toEqual([])
  })

  it("devolve lista vazia para valor inválido ou ausente", () => {
    expect(parseJsonArray(null)).toEqual([])
    expect(parseJsonArray(undefined)).toEqual([])
    expect(parseJsonArray("")).toEqual([])
    expect(parseJsonArray("   ")).toEqual([])
    expect(parseJsonArray("nao é json")).toEqual([])
    expect(parseJsonArray(42)).toEqual([])
  })
})

describe("parsePermissionsOverride", () => {
  it("devolve null quando o usuário herda do papel", () => {
    expect(parsePermissionsOverride(null)).toBeNull()
    expect(parsePermissionsOverride(undefined)).toBeNull()
    expect(parsePermissionsOverride("")).toBeNull()
    expect(parsePermissionsOverride("   ")).toBeNull()
  })

  it("devolve a lista explícita quando existe (inclusive vazia)", () => {
    expect(parsePermissionsOverride(["tickets.view"])).toEqual(["tickets.view"])
    expect(parsePermissionsOverride('["reports.view"]')).toEqual(["reports.view"])
    expect(parsePermissionsOverride([])).toEqual([])
    expect(parsePermissionsOverride("[]")).toEqual([])
  })

  it("devolve null para JSON inválido ou que não é array", () => {
    expect(parsePermissionsOverride("nao é json")).toBeNull()
    expect(parsePermissionsOverride('{"a":1}')).toBeNull()
    expect(parsePermissionsOverride('"texto"')).toBeNull()
  })
})

describe("toBool", () => {
  it("reconhece as formas de verdadeiro do MySQL", () => {
    expect(toBool(1)).toBe(true)
    expect(toBool(true)).toBe(true)
    expect(toBool("1")).toBe(true)
  })

  it("trata o resto como falso", () => {
    expect(toBool(0)).toBe(false)
    expect(toBool(false)).toBe(false)
    expect(toBool("0")).toBe(false)
    expect(toBool("true")).toBe(false)
    expect(toBool(2)).toBe(false)
    expect(toBool("")).toBe(false)
  })

  it("usa o fallback quando o valor é nulo ou ausente", () => {
    expect(toBool(null)).toBe(false)
    expect(toBool(undefined)).toBe(false)
    expect(toBool(null, true)).toBe(true)
    expect(toBool(undefined, true)).toBe(true)
  })
})

describe("toNumber", () => {
  it("converte número e string numérica", () => {
    expect(toNumber(12.5)).toBe(12.5)
    expect(toNumber("12.5")).toBe(12.5)
    expect(toNumber("0")).toBe(0)
  })

  it("usa o fallback para valor inválido, nulo ou ausente", () => {
    expect(toNumber(null)).toBe(0)
    expect(toNumber(undefined)).toBe(0)
    expect(toNumber("abc")).toBe(0)
    expect(toNumber(Number.NaN)).toBe(0)
    expect(toNumber("abc", 99)).toBe(99)
    expect(toNumber(null, 99)).toBe(99)
  })
})

describe("toPublicUser", () => {
  it("nunca expõe o hash da senha", () => {
    const usuario = toPublicUser(makeUser({ password_hash: "hash-secreto" }))

    expect("password_hash" in usuario).toBe(false)
    expect(JSON.stringify(usuario)).not.toContain("hash-secreto")
    expect(usuario.hasPassword).toBe(true)
  })

  it("marca hasPassword=false para usuário sem senha", () => {
    expect(toPublicUser(makeUser({ password_hash: null })).hasPassword).toBe(false)
  })

  it("mapeia os campos obrigatórios e usa o e-mail como usuário quando falta username", () => {
    const usuario = toPublicUser(makeUser())
    expect(usuario._id).toBe("u1")
    expect(usuario.id).toBe("u1")
    expect(usuario._creationTime).toBe(1_700_000_000_000)
    expect(usuario.username).toBe("ana@exemplo.com")
    expect(usuario.role).toBe("user")
    expect(usuario.email).toBe("ana@exemplo.com")
  })

  it("preenche vazios com string vazia e liga o usuário por padrão", () => {
    const usuario = toPublicUser(
      makeUser({
        name: null,
        email: null,
        username: null,
        setor: null,
        contato: null,
        active: null,
      }),
    )
    expect(usuario.name).toBe("")
    expect(usuario.email).toBe("")
    expect(usuario.username).toBe("")
    expect(usuario.setor).toBe("")
    expect(usuario.contato).toBe("")
    expect(usuario.active).toBe(true)
    expect(usuario.createdAt).toBe(1_700_000_000_000)
    expect(usuario.updatedAt).toBeNull()
  })

  it("distingue override de permissão (lista) de herança do papel (null)", () => {
    expect(toPublicUser(makeUser({ permissions: '["tickets.view"]' })).permissions).toEqual([
      "tickets.view",
    ])
    expect(toPublicUser(makeUser({ permissions: null })).permissions).toBeNull()
  })

  it("respeita usuário inativo", () => {
    expect(toPublicUser(makeUser({ active: 0 })).active).toBe(false)
  })
})

describe("toPublicTicket", () => {
  it("mapeia o chamado para o formato camelCase da API", () => {
    const chamado = toPublicTicket(
      makeTicket({
        os: "OS-9",
        status_equipamento: "Entregue",
        categoria: "Rede",
        valor_total: 120,
      }),
    )
    expect(chamado._id).toBe("t1")
    expect(chamado.number).toBe(12)
    expect(chamado.status).toBe("aberto")
    expect(chamado.priority).toBe("media")
    expect(chamado.os).toBe("OS-9")
    expect(chamado.statusEquipamento).toBe("Entregue")
    expect(chamado.categoria).toBe("Rede")
    expect(chamado.valorTotal).toBe(120)
    expect(chamado.createdAt).toBe(1_700_000_000_000)
    expect(chamado.updatedAt).toBe(1_700_000_100_000)
  })

  it("devolve undefined para campos nulos (o front trata como ausente)", () => {
    const chamado = toPublicTicket(makeTicket())
    expect(chamado.valorTotal).toBeUndefined()
    expect(chamado.os).toBeUndefined()
    expect(chamado.assigneeId).toBeUndefined()
    expect(chamado.creatorId).toBe("u1")
  })

  it("converte valor_total vindo como string do MySQL", () => {
    expect(toPublicTicket(makeTicket({ valor_total: "120.50" })).valorTotal).toBe(120.5)
    expect(toPublicTicket(makeTicket({ valor_total: "abc" })).valorTotal).toBe(0)
  })
})

describe("toPublicTechnician", () => {
  it("mapeia o técnico com ativo por padrão", () => {
    const tecnico = toPublicTechnician(makeTechnician())
    expect(tecnico.name).toBe("Bia")
    expect(tecnico.active).toBe(true)
    expect(tecnico.funcao).toBeUndefined()
    expect(tecnico.contato).toBeUndefined()
  })

  it("respeita técnico inativo", () => {
    expect(toPublicTechnician(makeTechnician({ active: 0 })).active).toBe(false)
  })
})

describe("toPublicProductService", () => {
  it("assume 'servico' quando o tipo não está gravado", () => {
    expect(toPublicProductService(makeProduct({ item_type: null })).itemType).toBe("servico")
    expect(toPublicProductService(makeProduct({ item_type: "invalido" })).itemType).toBe("servico")
  })

  it("normaliza o tipo gravado e converte o preço", () => {
    const produto = toPublicProductService(makeProduct({ item_type: "Produto", price: "199.90" }))
    expect(produto.itemType).toBe("produto")
    expect(produto.price).toBe(199.9)
    expect(produto.active).toBe(true)
  })
})

describe("toPublicRole", () => {
  it("converte as permissões do papel e o indicador de papel de sistema", () => {
    const papel = toPublicRole(makeRole({ permissions: '["tickets.view"]', is_system: 0 }))
    expect(papel.permissions).toEqual(["tickets.view"])
    expect(papel.isSystem).toBe(false)
    expect(papel.name).toBe("user")
  })

  it("devolve lista vazia quando o papel não tem permissões gravadas", () => {
    expect(toPublicRole(makeRole()).permissions).toEqual([])
  })
})
